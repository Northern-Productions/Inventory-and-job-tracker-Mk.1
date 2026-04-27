/**
 * PURPOSE:
 * Canonicalizes ordered film receipt allocation state so receiving a linked
 * ordered box resolves its existing job/requirement reservation instead of
 * creating a duplicate active allocation row.
 *
 * AFFECTS:
 * /boxes/receive, /boxes/update, /boxes/set-status, job detail allocation
 * rows, film order coverage, and box physical LF edit validation.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * shared/domain/filmAllocationReservations.mjs, backend runtime ordered-box
 * receipt helpers, job detail allocation row tests, and schema latest checks.
 *
 * COMMON FAILURE MODES:
 * Duplicate active allocation rows for one ordered box, placeholder + receipt
 * double-counting, edit guards blocking physical LF correction, or film order
 * coverage not following the received box.
 */

create or replace function app_api.physical_film_commitment_feet_for_box(
  p_org_id uuid,
  p_box_id text,
  p_excluded_job_number text default ''
)
returns integer
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select coalesce(sum(a.allocated_feet), 0)::integer
  from app.allocations a
  where a.org_id = p_org_id
    and a.box_id = app_api.trim_text(p_box_id)
    and a.status = 'ACTIVE'
    and coalesce(a.allocation_kind::text, 'REQUIREMENT') = 'REQUIREMENT'
    and a.requirement_id is not null
    and (
      a.job_id is not null
      or app_api.trim_text(a.job_number) <> ''
    )
    and a.job_date is not null
    and (
      app_api.trim_text(p_excluded_job_number) = ''
      or upper(coalesce(a.job_number, '')) <> upper(app_api.trim_text(p_excluded_job_number))
    );
$$;

create or replace function app_api.find_order_receipt_requirement_id(
  p_org_id uuid,
  p_job_number text,
  p_manufacturer text,
  p_film_name text,
  p_width_in numeric
)
returns uuid
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select r.id
  from app.jobs j
  join app.job_requirements r
    on r.org_id = j.org_id
   and r.job_id = j.id
  where j.org_id = p_org_id
    and upper(trim(j.job_number)) = upper(trim(p_job_number))
    and app_api.normalize_job_requirement_lookup_key(
      r.manufacturer,
      r.film_name,
      r.width_in
    ) = app_api.normalize_job_requirement_lookup_key(
      p_manufacturer,
      p_film_name,
      p_width_in
    )
  order by r.created_at asc, r.id asc
  limit 1;
$$;

create or replace function app_api.process_linked_box_receipt(
  p_org_id uuid,
  p_box app.boxes,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_box app.boxes := p_box;
  v_link app.film_order_box_links;
  v_order app.film_orders;
  v_requirement_id uuid;
  v_existing_allocation app.allocations;
  v_allocation app.allocations;
  v_remaining_need integer;
  v_link_capacity integer;
  v_reused_feet integer;
  v_allocation_feet integer;
  v_job_context jsonb;
  v_warnings text[] := array[]::text[];
  v_recalculate_film_order_ids text[] := array[]::text[];
  v_recalculate_film_order_id text;
begin
  if v_box.received_date is null or v_box.status <> 'IN_STOCK' then
    return jsonb_build_object('box', to_jsonb(v_box), 'warnings', to_jsonb(v_warnings));
  end if;

  for v_link in
    select *
    from app.film_order_box_links l
    where l.org_id = p_org_id
      and l.box_id = v_box.box_id
    for update
  loop
    select *
    into v_order
    from app.film_orders f
    where f.org_id = p_org_id
      and f.film_order_id = v_link.film_order_id
    for update;

    if not found or v_order.status in ('CANCELLED', 'FULFILLED') then
      continue;
    end if;

    if array_position(v_recalculate_film_order_ids, v_order.film_order_id) is null then
      v_recalculate_film_order_ids := v_recalculate_film_order_ids || v_order.film_order_id;
    end if;

    v_remaining_need := greatest(v_order.requested_feet - v_order.covered_feet, 0);
    v_link_capacity := greatest(v_link.ordered_feet - v_link.auto_allocated_feet, 0);
    v_reused_feet := 0;
    v_requirement_id := null;
    v_existing_allocation := null;

    if v_remaining_need > 0 and v_link_capacity > 0 then
      select a.*
      into v_existing_allocation
      from app.allocations a
      join app.job_requirements r
        on r.org_id = a.org_id
       and r.id = a.requirement_id
      where a.org_id = p_org_id
        and a.box_id = v_box.box_id
        and a.status = 'ACTIVE'
        and coalesce(a.allocation_kind::text, 'REQUIREMENT') = 'REQUIREMENT'
        and app_api.normalize_job_requirement_lookup_key(
          r.manufacturer,
          r.film_name,
          r.width_in
        ) = app_api.normalize_job_requirement_lookup_key(
          v_order.manufacturer,
          v_order.film_name,
          v_order.width_in
        )
        and coalesce(a.film_order_id, '') = ''
        and (
          (a.job_id is not null and a.job_id = app_api.get_or_resolve_job_id(p_org_id, v_order.job_number))
          or upper(trim(coalesce(a.job_number, ''))) = upper(trim(v_order.job_number))
        )
      order by
        case coalesce(a.allocation_source::text, 'MANUAL')
          when 'MANUAL' then 0
          when 'AUTO_PLANNED' then 1
          else 2
        end,
        a.created_at asc,
        a.allocation_id asc
      limit 1
      for update;

      if v_existing_allocation.id is not null then
        v_requirement_id := v_existing_allocation.requirement_id;
        v_reused_feet := least(
          v_remaining_need,
          v_link_capacity,
          coalesce(v_existing_allocation.allocated_feet, 0)
        );

        if v_reused_feet > 0 then
          if v_reused_feet = coalesce(v_existing_allocation.allocated_feet, 0) then
            v_existing_allocation.film_order_id := v_order.film_order_id;
            v_existing_allocation.allocation_source := 'FILM_ORDER_RECEIPT'::app.allocation_source;
            v_existing_allocation.covered_feet := coalesce(
              v_existing_allocation.covered_feet,
              v_existing_allocation.allocated_feet
            );
            v_existing_allocation.notes := case
              when app_api.trim_text(v_existing_allocation.notes) = '' then
                format('Resolved ordered-box placeholder on receipt for Film Order %s.', v_order.film_order_id)
              else v_existing_allocation.notes
            end;
            v_existing_allocation := app_api.save_allocation(v_existing_allocation);
          else
            v_existing_allocation.allocated_feet := greatest(v_existing_allocation.allocated_feet - v_reused_feet, 0);
            v_existing_allocation.covered_feet := greatest(
              coalesce(v_existing_allocation.covered_feet, v_existing_allocation.allocated_feet + v_reused_feet)
                - v_reused_feet,
              0
            );
            v_existing_allocation.notes := case
              when app_api.trim_text(v_existing_allocation.notes) = '' then
                format('Split %s LF to resolve ordered-box receipt for Film Order %s.', v_reused_feet, v_order.film_order_id)
              else v_existing_allocation.notes
            end;
            v_existing_allocation := app_api.save_allocation(v_existing_allocation);

            v_job_context := jsonb_build_object(
              'jobNumber', v_order.job_number,
              'jobDate', coalesce(to_char(v_order.job_date, 'YYYY-MM-DD'), ''),
              'crewLeader', coalesce(v_order.crew_leader, '')
            );
            v_allocation := app_api.create_allocation(
              p_org_id,
              v_box,
              v_job_context,
              v_reused_feet,
              p_actor,
              v_order.film_order_id,
              'REQUIREMENT',
              v_requirement_id
            );
            v_allocation.allocation_source := 'FILM_ORDER_RECEIPT'::app.allocation_source;
            v_allocation.notes := format(
              'Split from ordered-box placeholder %s on receipt for Film Order %s.',
              v_existing_allocation.allocation_id,
              v_order.film_order_id
            );
            v_allocation := app_api.save_allocation(v_allocation);
          end if;

          v_link.auto_allocated_feet := v_link.auto_allocated_feet + v_reused_feet;
          perform app_api.save_film_order_link(v_link);
          v_order.covered_feet := v_order.covered_feet + v_reused_feet;
          v_remaining_need := greatest(v_order.requested_feet - v_order.covered_feet, 0);
          v_link_capacity := greatest(v_link.ordered_feet - v_link.auto_allocated_feet, 0);
          v_warnings := app_api.push_warning(
            v_warnings,
            format(
              '%s LF placeholder from %s was resolved to job %s for Film Order %s.',
              v_reused_feet,
              v_box.box_id,
              v_order.job_number,
              v_order.film_order_id
            )
          );
        end if;
      end if;
    end if;

    if v_requirement_id is null then
      v_requirement_id := app_api.find_order_receipt_requirement_id(
        p_org_id,
        v_order.job_number,
        v_order.manufacturer,
        v_order.film_name,
        v_order.width_in
      );
    end if;

    v_allocation_feet := least(v_remaining_need, v_link_capacity, v_box.feet_available);

    if v_allocation_feet <= 0 then
      continue;
    end if;

    v_job_context := jsonb_build_object(
      'jobNumber', v_order.job_number,
      'jobDate', coalesce(to_char(v_order.job_date, 'YYYY-MM-DD'), ''),
      'crewLeader', coalesce(v_order.crew_leader, '')
    );
    v_allocation := app_api.create_allocation(
      p_org_id,
      v_box,
      v_job_context,
      v_allocation_feet,
      p_actor,
      v_order.film_order_id,
      'REQUIREMENT',
      v_requirement_id
    );
    v_allocation.allocation_source := 'FILM_ORDER_RECEIPT'::app.allocation_source;
    v_allocation := app_api.save_allocation(v_allocation);

    v_box.feet_available := greatest(v_box.feet_available - v_allocation_feet, 0);
    v_link.auto_allocated_feet := v_link.auto_allocated_feet + v_allocation_feet;
    perform app_api.save_film_order_link(v_link);
    v_order.covered_feet := v_order.covered_feet + v_allocation_feet;
    v_warnings := app_api.push_warning(
      v_warnings,
      format(
        '%s LF from %s was automatically allocated to job %s for Film Order %s.',
        v_allocation_feet,
        v_box.box_id,
        v_order.job_number,
        v_order.film_order_id
      )
    );
  end loop;

  foreach v_recalculate_film_order_id in array v_recalculate_film_order_ids
  loop
    perform app_api.recalculate_film_order(p_org_id, v_recalculate_film_order_id, p_actor);
  end loop;

  return jsonb_build_object('box', to_jsonb(v_box), 'warnings', to_jsonb(v_warnings));
end;
$$;

do $$
declare
  v_def text;
  v_base text;
  v_next text;
begin
  select pg_get_functiondef('app_api.build_box_from_payload(uuid, jsonb, text)'::regprocedure)
  into v_def;
  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  v_next := replace(
    v_next,
    replace($old$
    select coalesce(sum(a.allocated_feet), 0)::integer
    into v_active_allocated_feet
    from app.allocations a
    where a.org_id = p_org_id
      and a.box_id = v_box_id
      and a.status = 'ACTIVE';
$old$, E'\r\n', E'\n'),
    replace($new$
    v_active_allocated_feet := app_api.physical_film_commitment_feet_for_box(
      p_org_id,
      v_box_id
    );
$new$, E'\r\n', E'\n')
  );

  if v_next = v_base then
    if v_base like '%app_api.physical_film_commitment_feet_for_box(%' then
      return;
    end if;

    raise exception 'build_box_from_payload physical commitment patch did not match expected snippets';
  end if;

  execute v_next;
end;
$$;

do $$
declare
  v_def text;
  v_base text;
  v_next text;
begin
  select pg_get_functiondef('public.api_boxes_set_status(uuid, text, jsonb)'::regprocedure)
  into v_def;
  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  v_next := replace(
    v_next,
    replace($old$
      select
        coalesce(sum(a.allocated_feet), 0)::integer,
        coalesce(
          array_agg(distinct a.job_number) filter (
            where coalesce(a.job_number, '') <> ''
          ),
          array[]::text[]
        )
      into v_other_active_allocated_feet, v_other_jobs
      from app.allocations a
      where a.org_id = p_org_id
        and a.box_id = v_box.box_id
        and a.status = 'ACTIVE'
        and upper(coalesce(a.job_number, '')) <> upper(v_checkout_job);
$old$, E'\r\n', E'\n'),
    replace($new$
      select
        coalesce(sum(a.allocated_feet), 0)::integer,
        coalesce(
          array_agg(distinct a.job_number) filter (
            where coalesce(a.job_number, '') <> ''
          ),
          array[]::text[]
        )
      into v_other_active_allocated_feet, v_other_jobs
      from app.allocations a
      where a.org_id = p_org_id
        and a.box_id = v_box.box_id
        and a.status = 'ACTIVE'
        and coalesce(a.allocation_kind::text, 'REQUIREMENT') = 'REQUIREMENT'
        and a.requirement_id is not null
        and a.job_date is not null
        and upper(coalesce(a.job_number, '')) <> upper(v_checkout_job);
$new$, E'\r\n', E'\n')
  );

  v_next := replace(
    v_next,
    replace($old$
      select
        coalesce(sum(a.allocated_feet), 0)::integer,
        coalesce(
          array_agg(distinct a.job_number) filter (
            where coalesce(a.job_number, '') <> ''
          ),
          array[]::text[]
        )
      into v_other_active_allocated_feet, v_other_jobs
      from app.allocations a
      where a.org_id = p_org_id
        and a.box_id = v_box.box_id
        and a.status = 'ACTIVE';
$old$, E'\r\n', E'\n'),
    replace($new$
      select
        coalesce(sum(a.allocated_feet), 0)::integer,
        coalesce(
          array_agg(distinct a.job_number) filter (
            where coalesce(a.job_number, '') <> ''
          ),
          array[]::text[]
        )
      into v_other_active_allocated_feet, v_other_jobs
      from app.allocations a
      where a.org_id = p_org_id
        and a.box_id = v_box.box_id
        and a.status = 'ACTIVE'
        and coalesce(a.allocation_kind::text, 'REQUIREMENT') = 'REQUIREMENT'
        and a.requirement_id is not null
        and a.job_date is not null;
$new$, E'\r\n', E'\n')
  );

  if v_next = v_base then
    if v_base like '%and a.requirement_id is not null%and a.job_date is not null%' then
      return;
    end if;

    raise exception 'api_boxes_set_status physical commitment patch did not match expected snippets';
  end if;

  execute v_next;
end;
$$;

do $$
declare
  v_def text;
  v_base text;
  v_next text;
begin
  select pg_get_functiondef('public.api_acl_boxes_receive_ordered(uuid, text, jsonb)'::regprocedure)
  into v_def;
  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  v_next := replace(
    v_next,
    replace($old$
  v_locked_allocated_feet := app_api.locked_allocated_feet_for_box(p_org_id, v_lookup_box_id);
$old$, E'\r\n', E'\n'),
    replace($new$
  v_locked_allocated_feet := app_api.physical_film_commitment_feet_for_box(p_org_id, v_lookup_box_id);
$new$, E'\r\n', E'\n')
  );

  if v_next = v_base then
    if v_base like '%v_locked_allocated_feet := app_api.physical_film_commitment_feet_for_box(p_org_id, v_lookup_box_id);%' then
      return;
    end if;

    raise exception 'api_acl_boxes_receive_ordered physical receipt patch did not match expected snippets';
  end if;

  execute v_next;
end;
$$;

comment on function app_api.physical_film_commitment_feet_for_box(uuid, text, text)
  is 'Returns active scheduled requirement allocations that represent real physical LF commitments for edit/check-in guards.';

comment on function app_api.find_order_receipt_requirement_id(uuid, text, text, text, numeric)
  is 'Finds the job requirement represented by a linked film order so ordered-box receipt can resolve the existing allocation row.';

select app_api.grant_execute_if_exists('app_api.physical_film_commitment_feet_for_box(uuid, text, text)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.physical_film_commitment_feet_for_box(uuid, text, text)', 'service_role');
select app_api.grant_execute_if_exists('app_api.find_order_receipt_requirement_id(uuid, text, text, text, numeric)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.find_order_receipt_requirement_id(uuid, text, text, text, numeric)', 'service_role');
