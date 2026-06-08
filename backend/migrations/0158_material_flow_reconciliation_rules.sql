/*
 * PURPOSE:
 * Reassert the approved material-flow rules as SQL/RPC invariants:
 * physical box LF is authoritative, placeholder reservations consume capacity,
 * linked film-order coverage is recalculated from corrected box reality, and
 * width coverage uses floor(box width / requirement width).
 *
 * AFFECTS:
 * Box edits, ordered-box receipt, film-order status recalculation, allocation
 * availability, job readiness projections, and Edge/local parity.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * docs/material-flow-rules.md, shared allocationCoverageContract.mjs,
 * shared filmAllocationReservations.mjs, runtimeAllocationPlanning.mjs,
 * runtimeAllocationCoverage.mjs, Supabase api-handler.ts, and schema/latest.
 */

create temp table if not exists material_flow_box_physical_snapshot on commit drop as
select
  b.org_id,
  b.box_id,
  case
    when upper(coalesce(b.status::text, '')) = 'ORDERED' then greatest(coalesce(b.initial_feet, 0), 0)::integer
    else greatest(coalesce(app_api.box_physical_feet_available(b), b.feet_available, 0), 0)::integer
  end as physical_feet
from app.boxes b
where upper(coalesce(b.status::text, '')) in ('IN_STOCK', 'TRANSFER', 'ORDERED');

create index if not exists material_flow_box_physical_snapshot_key_idx
  on material_flow_box_physical_snapshot (org_id, box_id);

create or replace function app_api.allocation_coverage_multiplier(
  p_source_width_in numeric,
  p_requirement_width_in numeric
)
returns integer
language sql
immutable
as $$
  select case
    when coalesce(p_source_width_in, 0) <= 0 then 0
    when coalesce(p_requirement_width_in, 0) <= 0 then 0
    when coalesce(p_source_width_in, 0) < coalesce(p_requirement_width_in, 0) then 0
    else greatest(
      1,
      floor(coalesce(p_source_width_in, 0) / nullif(coalesce(p_requirement_width_in, 0), 0))::integer
    )
  end;
$$;

create or replace function app_api.compute_physical_feet_for_coverage(
  p_requested_covered_feet integer,
  p_source_width_in numeric,
  p_requirement_width_in numeric
)
returns integer
language sql
immutable
as $$
  select case
    when greatest(coalesce(p_requested_covered_feet, 0), 0) <= 0 then 0
    when app_api.allocation_coverage_multiplier(p_source_width_in, p_requirement_width_in) <= 0 then 0
    else ceil(
      greatest(coalesce(p_requested_covered_feet, 0), 0)::numeric
      / app_api.allocation_coverage_multiplier(p_source_width_in, p_requirement_width_in)::numeric
    )::integer
  end;
$$;

create or replace function app_api.compute_covered_feet_from_allocation(
  p_allocated_feet integer,
  p_source_width_in numeric,
  p_requirement_width_in numeric,
  p_requested_covered_feet integer default null
)
returns integer
language sql
immutable
as $$
  select case
    when greatest(coalesce(p_allocated_feet, 0), 0) <= 0 then 0
    when app_api.allocation_coverage_multiplier(p_source_width_in, p_requirement_width_in) <= 0 then 0
    when p_requested_covered_feet is null then
      greatest(coalesce(p_allocated_feet, 0), 0)
      * app_api.allocation_coverage_multiplier(p_source_width_in, p_requirement_width_in)
    else least(
      greatest(coalesce(p_requested_covered_feet, 0), 0),
      greatest(coalesce(p_allocated_feet, 0), 0)
      * app_api.allocation_coverage_multiplier(p_source_width_in, p_requirement_width_in)
    )
  end;
$$;

create or replace function app_api.plan_allocation_coverage(
  p_requested_covered_feet integer,
  p_available_feet integer,
  p_source_width_in numeric,
  p_requirement_width_in numeric
)
returns table (
  allocated_feet integer,
  covered_feet integer,
  remaining_covered_feet integer
)
language sql
immutable
as $$
  with normalized as (
    select
      greatest(coalesce(p_requested_covered_feet, 0), 0) as requested_covered_feet,
      greatest(coalesce(p_available_feet, 0), 0) as available_feet
  ),
  planned as (
    select
      least(
        normalized.available_feet,
        app_api.compute_physical_feet_for_coverage(
          normalized.requested_covered_feet,
          p_source_width_in,
          p_requirement_width_in
        )
      ) as allocated_feet,
      normalized.requested_covered_feet
    from normalized
  )
  select
    planned.allocated_feet,
    app_api.compute_covered_feet_from_allocation(
      planned.allocated_feet,
      p_source_width_in,
      p_requirement_width_in,
      planned.requested_covered_feet
    ) as covered_feet,
    greatest(
      planned.requested_covered_feet
      - app_api.compute_covered_feet_from_allocation(
        planned.allocated_feet,
        p_source_width_in,
        p_requirement_width_in,
        planned.requested_covered_feet
      ),
      0
    ) as remaining_covered_feet
  from planned;
$$;

create or replace function app_api.film_allocation_consumes_stored_capacity(
  p_allocation app.allocations,
  p_box_status text
)
returns boolean
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select
    app_api.film_allocation_reserves_capacity(p_allocation, p_box_status)
    and (p_allocation).status = 'ACTIVE'
    and upper(coalesce(p_box_status, '')) in ('IN_STOCK', 'TRANSFER');
$$;

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
    and app_api.film_allocation_reserves_capacity(a, 'IN_STOCK')
    and (
      app_api.trim_text(p_excluded_job_number) = ''
      or upper(coalesce(a.job_number, '')) <> upper(app_api.trim_text(p_excluded_job_number))
    );
$$;

create or replace function app_api.film_order_matches_requirement(
  p_org_id uuid,
  p_order_requirement_id uuid,
  p_order_manufacturer text,
  p_order_film_name text,
  p_order_width_in numeric,
  p_requirement_id uuid,
  p_requirement_manufacturer text,
  p_requirement_film_name text,
  p_requirement_width_in numeric
)
returns boolean
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select
    case
      when p_order_requirement_id is not null or p_requirement_id is not null then
        p_order_requirement_id is not null
        and p_requirement_id is not null
        and p_order_requirement_id = p_requirement_id
        and coalesce(p_order_width_in, 0) >= coalesce(p_requirement_width_in, 0)
        and coalesce(p_requirement_width_in, 0) > 0
        and app_api.requirement_film_is_compatible(
          p_org_id,
          p_order_manufacturer,
          p_order_film_name,
          p_requirement_manufacturer,
          p_requirement_film_name
        )
      else
        coalesce(p_order_width_in, 0) >= coalesce(p_requirement_width_in, 0)
        and coalesce(p_requirement_width_in, 0) > 0
        and app_api.requirement_film_is_compatible(
          p_org_id,
          p_order_manufacturer,
          p_order_film_name,
          p_requirement_manufacturer,
          p_requirement_film_name
        )
    end;
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
    and coalesce(p_width_in, 0) >= coalesce(r.width_in, 0)
    and coalesce(r.width_in, 0) > 0
    and app_api.requirement_film_is_compatible(
      p_org_id,
      p_manufacturer,
      p_film_name,
      r.manufacturer,
      r.film_name
    )
  order by
    r.width_in desc,
    r.created_at asc,
    r.id asc
  limit 1;
$$;

create or replace function app_api.recalculate_film_order(
  p_org_id uuid,
  p_film_order_id text,
  p_actor text
)
returns app.film_orders
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_existing app.film_orders;
  v_link_count integer := 0;
  v_received_link_count integer := 0;
begin
  select *
  into v_existing
  from app.film_orders f
  where f.org_id = p_org_id
    and f.film_order_id = app_api.trim_text(p_film_order_id)
  for update;

  if not found then
    return null;
  end if;

  v_existing.covered_feet := app_api.sum_film_order_covered_feet(p_org_id, p_film_order_id);

  select
    count(*)::integer,
    coalesce(
      sum(
        app_api.compute_covered_feet_from_allocation(
          greatest(coalesce(b.initial_feet, l.ordered_feet, 0), 0)::integer,
          coalesce(b.width_in, v_existing.width_in),
          v_existing.width_in
        )
      ) filter (where b.box_id is not null),
      0
    )::integer,
    count(*) filter (
      where b.box_id is not null
        and upper(coalesce(b.status::text, '')) <> 'ORDERED'
    )::integer
  into
    v_link_count,
    v_existing.ordered_feet,
    v_received_link_count
  from app.film_order_box_links l
  left join app.boxes b
    on b.org_id = l.org_id
   and b.box_id = l.box_id
  where l.org_id = p_org_id
    and l.film_order_id = app_api.trim_text(p_film_order_id);

  v_existing.remaining_to_order_feet := greatest(v_existing.requested_feet - v_existing.ordered_feet, 0);

  if v_existing.status <> 'CANCELLED' then
    if v_link_count > 0 then
      if v_existing.ordered_feet < v_existing.requested_feet then
        v_existing.status := 'FILM_ORDER';
        v_existing.resolved_at := null;
        v_existing.resolved_by := '';
      elsif v_received_link_count = v_link_count then
        v_existing.status := 'FULFILLED';
        if v_existing.resolved_at is null then
          v_existing.resolved_at := now();
          v_existing.resolved_by := app_api.trim_text(p_actor);
        end if;
      else
        v_existing.status := 'FILM_ON_THE_WAY';
        v_existing.resolved_at := null;
        v_existing.resolved_by := '';
      end if;
    elsif v_existing.covered_feet >= v_existing.requested_feet then
      v_existing.status := 'FULFILLED';
      if v_existing.resolved_at is null then
        v_existing.resolved_at := now();
        v_existing.resolved_by := app_api.trim_text(p_actor);
      end if;
    elsif v_existing.ordered_feet >= v_existing.requested_feet then
      v_existing.status := 'FILM_ON_THE_WAY';
      v_existing.resolved_at := null;
      v_existing.resolved_by := '';
    else
      v_existing.status := 'FILM_ORDER';
      v_existing.resolved_at := null;
      v_existing.resolved_by := '';
    end if;
  end if;

  return app_api.save_film_order(v_existing);
end;
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
  v_reused_covered_feet integer;
  v_allocation_feet integer;
  v_allocation_covered_feet integer;
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
    v_link_capacity := greatest(greatest(coalesce(v_box.initial_feet, v_link.ordered_feet, 0), 0) - coalesce(v_link.auto_allocated_feet, 0), 0);
    v_reused_feet := 0;
    v_reused_covered_feet := 0;
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
        and coalesce(v_box.width_in, v_order.width_in, 0) >= coalesce(r.width_in, 0)
        and coalesce(r.width_in, 0) > 0
        and app_api.requirement_film_is_compatible(
          p_org_id,
          v_order.manufacturer,
          v_order.film_name,
          r.manufacturer,
          r.film_name
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
        select allocated_feet, covered_feet
        into v_reused_feet, v_reused_covered_feet
        from app_api.plan_allocation_coverage(
          v_remaining_need,
          least(v_link_capacity, coalesce(v_existing_allocation.allocated_feet, 0)),
          v_box.width_in,
          v_order.width_in
        );

        if v_reused_feet > 0 then
          if v_reused_feet = coalesce(v_existing_allocation.allocated_feet, 0) then
            v_existing_allocation.film_order_id := v_order.film_order_id;
            v_existing_allocation.allocation_source := 'FILM_ORDER_RECEIPT'::app.allocation_source;
            v_existing_allocation.covered_feet := v_reused_covered_feet;
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
                - v_reused_covered_feet,
              0
            );
            v_existing_allocation.notes := case
              when app_api.trim_text(v_existing_allocation.notes) = '' then
                format('Split %s physical LF to resolve ordered-box receipt for Film Order %s.', v_reused_feet, v_order.film_order_id)
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
            v_allocation.covered_feet := v_reused_covered_feet;
            v_allocation.notes := format(
              'Split from ordered-box placeholder %s on receipt for Film Order %s.',
              v_existing_allocation.allocation_id,
              v_order.film_order_id
            );
            v_allocation := app_api.save_allocation(v_allocation);
          end if;

          v_box.feet_available := greatest(v_box.feet_available - v_reused_feet, 0);
          v_link.auto_allocated_feet := v_link.auto_allocated_feet + v_reused_feet;
          perform app_api.save_film_order_link(v_link);
          v_order.covered_feet := v_order.covered_feet + v_reused_covered_feet;
          v_remaining_need := greatest(v_order.requested_feet - v_order.covered_feet, 0);
          v_link_capacity := greatest(greatest(coalesce(v_box.initial_feet, v_link.ordered_feet, 0), 0) - coalesce(v_link.auto_allocated_feet, 0), 0);
          v_warnings := app_api.push_warning(
            v_warnings,
            format(
              '%s covered LF (%s physical LF) placeholder from %s was resolved to job %s for Film Order %s.',
              v_reused_covered_feet,
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

    select allocated_feet, covered_feet
    into v_allocation_feet, v_allocation_covered_feet
    from app_api.plan_allocation_coverage(
      v_remaining_need,
      least(v_link_capacity, v_box.feet_available),
      v_box.width_in,
      v_order.width_in
    );

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
    v_allocation.covered_feet := v_allocation_covered_feet;
    v_allocation := app_api.save_allocation(v_allocation);

    v_box.feet_available := greatest(v_box.feet_available - v_allocation_feet, 0);
    v_link.auto_allocated_feet := v_link.auto_allocated_feet + v_allocation_feet;
    perform app_api.save_film_order_link(v_link);
    v_order.covered_feet := v_order.covered_feet + v_allocation_covered_feet;
    v_warnings := app_api.push_warning(
      v_warnings,
      format(
        '%s covered LF (%s physical LF) from %s was automatically allocated to job %s for Film Order %s.',
        v_allocation_covered_feet,
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

create temp table if not exists material_flow_stored_commitments on commit drop as
select
  a.org_id,
  a.box_id,
  coalesce(sum(a.allocated_feet), 0)::integer as stored_feet
from app.allocations a
join app.boxes b
  on b.org_id = a.org_id
 and b.box_id = a.box_id
join material_flow_box_physical_snapshot s
  on s.org_id = b.org_id
 and s.box_id = b.box_id
where a.status = 'ACTIVE'
  and app_api.film_allocation_consumes_stored_capacity(a, b.status::text)
group by a.org_id, a.box_id;

create index if not exists material_flow_stored_commitments_key_idx
  on material_flow_stored_commitments (org_id, box_id);

update app.boxes b
set feet_available = greatest(s.physical_feet - coalesce(c.stored_feet, 0), 0)
from material_flow_box_physical_snapshot s
left join material_flow_stored_commitments c
  on c.org_id = s.org_id
 and c.box_id = s.box_id
where b.org_id = s.org_id
  and b.box_id = s.box_id
  and upper(coalesce(b.status::text, '')) in ('IN_STOCK', 'TRANSFER', 'ORDERED')
  and b.feet_available is distinct from greatest(s.physical_feet - coalesce(c.stored_feet, 0), 0);

do $$
declare
  v_def text;
  v_next text;
begin
  select pg_get_functiondef('public.api_acl_boxes_update(uuid, text, jsonb)'::regprocedure)
  into v_def;

  v_next := replace(v_def, E'\r\n', E'\n');

  if position('v_material_reconciliation_result := app_api.reconcile_box_checkin_allocations' in v_next) = 0 then
    if position('v_material_reconciliation_result jsonb' in v_next) = 0 then
      v_next := replace(
        v_next,
        '  v_box app.boxes;',
        replace($decl$
  v_box app.boxes;
  v_material_physical_feet integer := 0;
  v_material_reconciliation_result jsonb := jsonb_build_object('warnings', '[]'::jsonb);
$decl$, E'\r\n', E'\n')
      );
    end if;

    v_next := replace(
      v_next,
      replace($old$
  if found and upper(coalesce(v_box.status::text, '')) in ('IN_STOCK', 'TRANSFER') then
    perform app_api.recalculate_physical_box_allocatable_now(p_org_id, v_lookup_box_id);
  end if;
$old$, E'\r\n', E'\n'),
      replace($new$
  if found and upper(coalesce(v_box.status::text, '')) in ('IN_STOCK', 'TRANSFER', 'ORDERED') then
    v_material_physical_feet := case
      when upper(coalesce(v_box.status::text, '')) = 'ORDERED' then greatest(coalesce(v_box.initial_feet, 0), 0)::integer
      else greatest(coalesce(app_api.box_physical_feet_available(v_box), 0), 0)::integer
    end;
    v_material_reconciliation_result := app_api.reconcile_box_checkin_allocations(
      p_org_id,
      p_actor,
      v_lookup_box_id,
      v_material_physical_feet
    );
    if jsonb_typeof(coalesce(v_material_reconciliation_result->'warnings', '[]'::jsonb)) = 'array' then
      v_result := jsonb_set(
        coalesce(v_result, '{}'::jsonb),
        '{warnings}',
        coalesce(
          case when jsonb_typeof(v_result->'warnings') = 'array' then v_result->'warnings' else '[]'::jsonb end,
          '[]'::jsonb
        ) || coalesce(v_material_reconciliation_result->'warnings', '[]'::jsonb),
        true
      );
    end if;
    update app.boxes
    set feet_available = greatest(coalesce((v_material_reconciliation_result->>'feetAvailable')::integer, v_box.feet_available), 0)
    where org_id = p_org_id
      and box_id = v_lookup_box_id
    returning * into v_box;
    perform app_api.recalculate_film_orders_for_box_links(p_org_id, v_lookup_box_id, p_actor);
    if upper(coalesce(v_box.status::text, '')) in ('IN_STOCK', 'TRANSFER') then
      perform app_api.recalculate_physical_box_allocatable_now(p_org_id, v_lookup_box_id);
    end if;
  end if;
$new$, E'\r\n', E'\n')
    );

    if position('v_material_reconciliation_result := app_api.reconcile_box_checkin_allocations' in v_next) = 0 then
      raise exception 'api_acl_boxes_update material-flow reconciliation patch did not match expected snippet';
    end if;

    execute v_next;
  end if;
end;
$$;

do $$
declare
  v_order record;
begin
  for v_order in
    select distinct fo.org_id, fo.film_order_id
    from app.film_orders fo
    left join app.film_order_box_links l
      on l.org_id = fo.org_id
     and l.film_order_id = fo.film_order_id
    where fo.status <> 'CANCELLED'
      and l.film_order_id is not null
  loop
    perform app_api.recalculate_film_order(
      v_order.org_id,
      v_order.film_order_id,
      'migration: material flow reconciliation rules'
    );
  end loop;
end;
$$;

do $$
declare
  v_def text;
begin
  select pg_get_functiondef('app_api.recalculate_film_order(uuid, text, text)'::regprocedure)
  into v_def;
  if position('app_api.compute_covered_feet_from_allocation(' in v_def) = 0
    or position('coalesce(b.initial_feet, l.ordered_feet, 0)' in v_def) = 0 then
    raise exception 'material-flow recalculate_film_order dynamic linked-box coverage guard failed';
  end if;

  select pg_get_functiondef('app_api.film_allocation_consumes_stored_capacity(app.allocations, text)'::regprocedure)
  into v_def;
  if position('app_api.film_allocation_reserves_capacity(p_allocation, p_box_status)' in v_def) = 0
    or position('upper(coalesce(p_box_status, '''')) in (''IN_STOCK'', ''TRANSFER'')' in v_def) = 0
    or position('AUTO_PLANNED' in v_def) > 0 then
    raise exception 'material-flow stored capacity guard failed';
  end if;

  select pg_get_functiondef('app_api.find_order_receipt_requirement_id(uuid, text, text, text, numeric)'::regprocedure)
  into v_def;
  if position('coalesce(p_width_in, 0) >= coalesce(r.width_in, 0)' in v_def) = 0
    or position('app_api.requirement_film_is_compatible(' in v_def) = 0 then
    raise exception 'material-flow receipt requirement width guard failed';
  end if;

  select pg_get_functiondef('app_api.process_linked_box_receipt(uuid, app.boxes, text)'::regprocedure)
  into v_def;
  if position('app_api.plan_allocation_coverage(' in v_def) = 0
    or position('v_reused_covered_feet' in v_def) = 0
    or position('covered LF' in v_def) = 0 then
    raise exception 'material-flow linked receipt coverage guard failed';
  end if;

  select pg_get_functiondef('public.api_acl_boxes_update(uuid, text, jsonb)'::regprocedure)
  into v_def;
  if position('v_material_reconciliation_result := app_api.reconcile_box_checkin_allocations' in v_def) = 0
    or position('perform app_api.recalculate_film_orders_for_box_links(p_org_id, v_lookup_box_id, p_actor);' in v_def) = 0 then
    raise exception 'material-flow box update reconciliation guard failed';
  end if;
end;
$$;

select app_api.grant_execute_if_exists('app_api.recalculate_film_order(uuid, text, text)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.recalculate_film_order(uuid, text, text)', 'service_role');
select app_api.grant_execute_if_exists('app_api.process_linked_box_receipt(uuid, app.boxes, text)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.process_linked_box_receipt(uuid, app.boxes, text)', 'service_role');
select app_api.grant_execute_if_exists('app_api.find_order_receipt_requirement_id(uuid, text, text, text, numeric)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.find_order_receipt_requirement_id(uuid, text, text, text, numeric)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_boxes_update(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_boxes_update(uuid, text, jsonb)', 'service_role');
