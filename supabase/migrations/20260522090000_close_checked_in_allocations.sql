/*
 * PURPOSE:
 * Close checked-in film and caulk allocation cycles after usage has been
 * recorded, so consumed material no longer appears as active allocation.
 *
 * AFFECTS:
 * Film box check-in same-job allocation release, caulk checkout/check-in
 * allocation resolution, historical deterministic cleanup for already closed
 * check-in cycles, planner coverage, and active allocation displays.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * backend runtime checkout/cancellations.mjs, frontend jobMaterialMutations and
 * allocation job filtering, Supabase Edge RPC parity, and schema/latest checks.
 *
 * COMMON FAILURE MODES:
 * Usage history is recorded but the allocation stays ACTIVE, partial caulk
 * check-in leaves reserved tubes locked, or legacy film allocations with null
 * job_id are skipped even though the checked-out box has a canonical job_id.
 */

create or replace function app_api.cancel_active_allocations_for_box_job(
  p_org_id uuid,
  p_box_id text,
  p_job_number text,
  p_actor text,
  p_reason text,
  p_job_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_entry app.allocations;
  v_reason text := coalesce(
    nullif(app_api.trim_text(p_reason), ''),
    format('Returned to stock during check-in for job %s.', app_api.trim_text(p_job_number))
  );
  v_cancelled_count integer := 0;
  v_cancelled_feet integer := 0;
  v_affected_film_order_ids text[] := array[]::text[];
  v_film_order_id text;
begin
  if p_job_id is null and app_api.trim_text(p_job_number) = '' then
    return jsonb_build_object(
      'cancelledCount', 0,
      'cancelledFeet', 0
    );
  end if;

  for v_entry in
    select *
    from app.allocations a
    where a.org_id = p_org_id
      and a.box_id = app_api.trim_text(p_box_id)
      and a.status = 'ACTIVE'
      and (
        (
          p_job_id is not null
          and (
            a.job_id = p_job_id
            or (
              a.job_id is null
              and upper(coalesce(a.job_number, '')) = upper(app_api.trim_text(p_job_number))
            )
          )
        )
        or (
          p_job_id is null
          and upper(coalesce(a.job_number, '')) = upper(app_api.trim_text(p_job_number))
        )
      )
    for update
  loop
    v_entry.status := 'CANCELLED';
    v_entry.resolved_at := now();
    v_entry.resolved_by := app_api.trim_text(p_actor);
    v_entry.notes := v_reason;
    perform app_api.save_allocation(v_entry);

    if coalesce(v_entry.film_order_id, '') <> ''
      and not (v_entry.film_order_id = any(v_affected_film_order_ids)) then
      v_affected_film_order_ids := array_append(v_affected_film_order_ids, v_entry.film_order_id);
    end if;

    v_cancelled_count := v_cancelled_count + 1;
    v_cancelled_feet := v_cancelled_feet + coalesce(v_entry.allocated_feet, 0);
  end loop;

  foreach v_film_order_id in array v_affected_film_order_ids
  loop
    perform app_api.recalculate_film_order(p_org_id, v_film_order_id, p_actor);
  end loop;

  return jsonb_build_object(
    'cancelledCount', v_cancelled_count,
    'cancelledFeet', v_cancelled_feet
  );
end;
$$;

comment on function app_api.cancel_active_allocations_for_box_job(
  uuid,
  text,
  text,
  text,
  text,
  uuid
) is 'Film check-in same-job allocation release scoped by jobId when available, with a deterministic legacy null-job_id same-number fallback.';

do $$
declare
  v_def text;
  v_next text;
  v_base text;
begin
  select pg_get_functiondef('public.api_boxes_set_status(uuid, text, jsonb)'::regprocedure)
  into v_def;

  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  v_next := replace(
    v_next,
    replace($old$
        and (
          (v_checkout_job_id is not null and a.job_id = v_checkout_job_id)
          or (
            v_checkout_job_id is null
            and upper(coalesce(a.job_number, '')) = upper(v_checkout_job)
          )
        );
$old$, E'\r\n', E'\n'),
    replace($new$
        and (
          (
            v_checkout_job_id is not null
            and (
              a.job_id = v_checkout_job_id
              or (
                a.job_id is null
                and upper(coalesce(a.job_number, '')) = upper(v_checkout_job)
              )
            )
          )
          or (
            v_checkout_job_id is null
            and upper(coalesce(a.job_number, '')) = upper(v_checkout_job)
          )
        );
$new$, E'\r\n', E'\n')
  );

  v_next := replace(
    v_next,
    replace($old$
        and upper(coalesce(a.job_number, '')) = upper(v_checkout_job);
$old$, E'\r\n', E'\n'),
    replace($new$
        and (
          (
            v_checkout_job_id is not null
            and (
              a.job_id = v_checkout_job_id
              or (
                a.job_id is null
                and upper(coalesce(a.job_number, '')) = upper(v_checkout_job)
              )
            )
          )
          or (
            v_checkout_job_id is null
            and upper(coalesce(a.job_number, '')) = upper(v_checkout_job)
          )
        );
$new$, E'\r\n', E'\n')
  );

  v_next := replace(
    v_next,
    replace($old$
        and not (
          (v_checkout_job_id is not null and a.job_id = v_checkout_job_id)
          or (
            v_checkout_job_id is null
            and upper(coalesce(a.job_number, '')) = upper(v_checkout_job)
          )
        );
$old$, E'\r\n', E'\n'),
    replace($new$
        and not (
          (
            v_checkout_job_id is not null
            and (
              a.job_id = v_checkout_job_id
              or (
                a.job_id is null
                and upper(coalesce(a.job_number, '')) = upper(v_checkout_job)
              )
            )
          )
          or (
            v_checkout_job_id is null
            and upper(coalesce(a.job_number, '')) = upper(v_checkout_job)
          )
        );
$new$, E'\r\n', E'\n')
  );

  v_next := replace(
    v_next,
    replace($old$
        and upper(coalesce(a.job_number, '')) <> upper(v_checkout_job);
$old$, E'\r\n', E'\n'),
    replace($new$
        and not (
          (
            v_checkout_job_id is not null
            and (
              a.job_id = v_checkout_job_id
              or (
                a.job_id is null
                and upper(coalesce(a.job_number, '')) = upper(v_checkout_job)
              )
            )
          )
          or (
            v_checkout_job_id is null
            and upper(coalesce(a.job_number, '')) = upper(v_checkout_job)
          )
        );
$new$, E'\r\n', E'\n')
  );

  v_next := replace(
    v_next,
    replace($old$
    if coalesce(v_existing.status::text, '') = 'CHECKED_OUT'
       and v_same_job_active_allocation_count > 0
       and (v_checkout_job_id is not null or v_checkout_job <> '') then
$old$, E'\r\n', E'\n'),
    replace($new$
    if coalesce(v_existing.status::text, '') = 'CHECKED_OUT'
       and (v_checkout_job_id is not null or v_checkout_job <> '') then
$new$, E'\r\n', E'\n')
  );

  if v_next = v_base then
    if position('a.job_id is null' in v_next) > 0
       and position('Consumed during film box check-in after actual LF was recorded.' in v_next) > 0
       and position('and v_same_job_active_allocation_count > 0
       and (v_checkout_job_id is not null or v_checkout_job <> '''') then' in v_next) = 0 then
      return;
    end if;
    raise exception 'api_boxes_set_status checked-in allocation close patch did not match expected snippets';
  end if;

  if position('a.job_id is null' in v_next) = 0
     or position('Consumed during film box check-in after actual LF was recorded.' in v_next) = 0
     or position('and v_same_job_active_allocation_count > 0
       and (v_checkout_job_id is not null or v_checkout_job <> '''') then' in v_next) > 0 then
    raise exception 'api_boxes_set_status checked-in allocation close verification failed';
  end if;

  execute v_next;
end $$;

do $$
declare
  v_def text;
  v_next text;
  v_base text;
begin
  select pg_get_functiondef('public.api_acl_allocations_caulk_checkin(uuid, text, jsonb)'::regprocedure)
  into v_def;

  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  v_next := replace(
    v_next,
    replace($old$
  if v_open_checkout_count = 0 and coalesce(v_allocation.reserved_tubes_remaining, 0) = 0 then
    update app.caulk_job_allocations
    set status = 'CANCELLED',
        resolved_at = coalesce(resolved_at, now()),
        resolved_by = v_actor,
        updated_at = now(),
        updated_by = v_actor,
        notes = trim(
          coalesce(notes, '') ||
          case when coalesce(notes, '') = '' then '' else ' ' end ||
          'Resolved after caulk checkout check-in usage was recorded.'
        )
    where id = v_allocation.id
      and org_id = p_org_id
    returning *
    into v_allocation;
  end if;
$old$, E'\r\n', E'\n'),
    replace($new$
  if v_open_checkout_count = 0 then
    if coalesce(v_allocation.reserved_tubes_remaining, 0) > 0 then
      perform app_api.caulk_apply_stock_delta(
        p_org_id,
        v_actor,
        v_allocation.product_id,
        v_allocation.warehouse,
        'JOB_ALLOCATION_CANCEL_RETURN',
        v_allocation.reserved_tubes_remaining,
        format('Released unused reserved caulk after check-in for job %s.', v_job.job_number),
        '',
        v_allocation.caulk_allocation_id,
        v_notes
      );
    end if;

    update app.caulk_job_allocations
    set status = 'CANCELLED',
        reserved_tubes_remaining = 0,
        resolved_at = coalesce(resolved_at, now()),
        resolved_by = v_actor,
        updated_at = now(),
        updated_by = v_actor,
        notes = trim(
          coalesce(notes, '') ||
          case when coalesce(notes, '') = '' then '' else ' ' end ||
          'Resolved after caulk checkout check-in usage was recorded.'
        )
    where id = v_allocation.id
      and org_id = p_org_id
    returning *
    into v_allocation;
  end if;
$new$, E'\r\n', E'\n')
  );

  if v_next = v_base then
    if position('if v_open_checkout_count = 0 then' in v_next) > 0
       and position('JOB_ALLOCATION_CANCEL_RETURN' in v_next) > 0
       and position('reserved_tubes_remaining = 0' in v_next) > 0
       and position('v_open_checkout_count = 0 and coalesce(v_allocation.reserved_tubes_remaining, 0) = 0' in v_next) = 0 then
      return;
    end if;
    raise exception 'api_acl_allocations_caulk_checkin close patch did not match expected snippets';
  end if;

  if position('app_api.record_caulk_requirement_actual_usage_for_checkin' in v_next) = 0
     or position('if v_open_checkout_count = 0 then' in v_next) = 0
     or position('JOB_ALLOCATION_CANCEL_RETURN' in v_next) = 0
     or position('reserved_tubes_remaining = 0' in v_next) = 0
     or position('v_open_checkout_count = 0 and coalesce(v_allocation.reserved_tubes_remaining, 0) = 0' in v_next) > 0 then
    raise exception 'api_acl_allocations_caulk_checkin close verification failed';
  end if;

  execute v_next;
end $$;

drop table if exists pg_temp.checked_in_film_allocation_close_candidates;

create temporary table checked_in_film_allocation_close_candidates as
with candidate_pairs as (
  select
    a.org_id,
    a.allocation_id,
    a.box_id,
    max(l.checked_in_at) as latest_checked_in_at
  from app.allocations a
  join app.boxes b
    on b.org_id = a.org_id
   and upper(trim(b.box_id)) = upper(trim(a.box_id))
  join app.roll_weight_log l
    on l.org_id = a.org_id
   and upper(trim(l.box_id)) = upper(trim(a.box_id))
   and l.checked_in_at is not null
   and l.checked_in_at >= coalesce(a.created_at, '-infinity'::timestamptz)
   and (
     (a.job_id is not null and l.job_id = a.job_id)
     or (
       a.job_id is null
       and l.job_id is not null
       and upper(trim(coalesce(l.job_number, ''))) = upper(trim(coalesce(a.job_number, '')))
       and exists (
         select 1
         from app.job_requirements r
         where r.org_id = a.org_id
           and r.id = a.requirement_id
           and r.job_id = l.job_id
       )
     )
   )
  where a.status = 'ACTIVE'
    and upper(coalesce(b.status::text, '')) <> 'CHECKED_OUT'
    and coalesce(a.allocation_kind::text, 'REQUIREMENT') = 'REQUIREMENT'
    and a.requirement_id is not null
  group by a.org_id, a.allocation_id, a.box_id
)
select *
from candidate_pairs;

do $$
declare
  v_allocation_count integer := 0;
  v_box record;
begin
  update app.allocations a
  set status = 'CANCELLED',
      resolved_at = coalesce(c.latest_checked_in_at, timezone('utc', now())),
      resolved_by = 'close-checked-in-allocations-0148',
      notes = trim(
        coalesce(a.notes, '') ||
        case when coalesce(a.notes, '') = '' then '' else ' ' end ||
        'Resolved by checked-in allocation cleanup after roll history usage was recorded.'
      )
  from checked_in_film_allocation_close_candidates c
  where a.org_id = c.org_id
    and a.allocation_id = c.allocation_id
    and a.status = 'ACTIVE';
  get diagnostics v_allocation_count = row_count;

  for v_box in
    select distinct org_id, box_id
    from checked_in_film_allocation_close_candidates
  loop
    perform app_api.recalculate_physical_box_allocatable_now(v_box.org_id, v_box.box_id);
  end loop;

  raise notice 'checked-in allocation cleanup resolved % film allocation row(s)', v_allocation_count;
end $$;

drop table if exists pg_temp.checked_in_caulk_allocation_close_candidates;

create temporary table checked_in_caulk_allocation_close_candidates as
with base_allocations as (
  select
    a.org_id,
    a.id,
    a.caulk_allocation_id,
    a.job_id,
    a.job_number,
    a.product_id,
    a.warehouse,
    a.reserved_tubes_remaining,
    max(c.checked_in_at) as latest_checked_in_at,
    count(*) filter (where c.status = 'OPEN')::integer as open_checkout_count
  from app.caulk_job_allocations a
  join app.caulk_job_checkouts c
    on c.org_id = a.org_id
   and c.caulk_allocation_id = a.id
  where a.status = 'ACTIVE'
    and coalesce(a.checked_out_tubes_total, 0) > 0
    and coalesce(a.checked_out_tubes_total, 0) =
      coalesce(a.returned_unused_tubes_total, 0) + coalesce(a.used_tubes_total, 0)
  group by
    a.org_id,
    a.id,
    a.caulk_allocation_id,
    a.job_id,
    a.job_number,
    a.product_id,
    a.warehouse,
    a.reserved_tubes_remaining
)
select *
from base_allocations
where open_checkout_count = 0;

do $$
declare
  v_entry record;
  v_allocation_count integer := 0;
  v_released_reserved_tubes integer := 0;
begin
  for v_entry in
    select *
    from checked_in_caulk_allocation_close_candidates
    where coalesce(reserved_tubes_remaining, 0) > 0
  loop
    perform app_api.caulk_apply_stock_delta(
      v_entry.org_id,
      'close-checked-in-allocations-0148',
      v_entry.product_id,
      v_entry.warehouse,
      'JOB_ALLOCATION_CANCEL_RETURN',
      v_entry.reserved_tubes_remaining,
      format('Released unused reserved caulk after historical check-in for job %s.', v_entry.job_number),
      '',
      v_entry.caulk_allocation_id,
      'Resolved by checked-in allocation cleanup after checkout usage was recorded.'
    );
    v_released_reserved_tubes := v_released_reserved_tubes + v_entry.reserved_tubes_remaining;
  end loop;

  update app.caulk_job_allocations a
  set status = 'CANCELLED',
      reserved_tubes_remaining = 0,
      resolved_at = coalesce(c.latest_checked_in_at, timezone('utc', now())),
      resolved_by = 'close-checked-in-allocations-0148',
      updated_at = timezone('utc', now()),
      updated_by = 'close-checked-in-allocations-0148',
      notes = trim(
        coalesce(a.notes, '') ||
        case when coalesce(a.notes, '') = '' then '' else ' ' end ||
        'Resolved by checked-in allocation cleanup after checkout usage was recorded.'
      )
  from checked_in_caulk_allocation_close_candidates c
  where a.org_id = c.org_id
    and a.id = c.id
    and a.status = 'ACTIVE';
  get diagnostics v_allocation_count = row_count;

  raise notice 'checked-in allocation cleanup resolved % caulk allocation row(s) and released % reserved tube(s)',
    v_allocation_count,
    v_released_reserved_tubes;
end $$;

select app_api.grant_execute_if_exists('app_api.cancel_active_allocations_for_box_job(uuid, text, text, text, text, uuid)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.cancel_active_allocations_for_box_job(uuid, text, text, text, text, uuid)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_checkin(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_checkin(uuid, text, jsonb)', 'service_role');

do $$
declare
  v_def text;
begin
  select pg_get_functiondef('app_api.cancel_active_allocations_for_box_job(uuid, text, text, text, text, uuid)'::regprocedure)
  into v_def;
  if position('a.job_id is null' in v_def) = 0
     or position('upper(coalesce(a.job_number, '''')) = upper(app_api.trim_text(p_job_number))' in v_def) = 0 then
    raise exception 'cancel_active_allocations_for_box_job missing legacy null-job_id close fallback';
  end if;

  select pg_get_functiondef('public.api_boxes_set_status(uuid, text, jsonb)'::regprocedure)
  into v_def;
  if position('app_api.record_requirement_actual_usage_for_checkin' in v_def) = 0
     or position('Consumed during film box check-in after actual LF was recorded.' in v_def) = 0
     or position('and v_same_job_active_allocation_count > 0
       and (v_checkout_job_id is not null or v_checkout_job <> '''') then' in v_def) > 0 then
    raise exception 'api_boxes_set_status can still skip checked-in same-job release';
  end if;

  select pg_get_functiondef('public.api_acl_allocations_caulk_checkin(uuid, text, jsonb)'::regprocedure)
  into v_def;
  if position('app_api.record_caulk_requirement_actual_usage_for_checkin' in v_def) = 0
     or position('if v_open_checkout_count = 0 then' in v_def) = 0
     or position('JOB_ALLOCATION_CANCEL_RETURN' in v_def) = 0
     or position('reserved_tubes_remaining = 0' in v_def) = 0
     or position('v_open_checkout_count = 0 and coalesce(v_allocation.reserved_tubes_remaining, 0) = 0' in v_def) > 0 then
    raise exception 'api_acl_allocations_caulk_checkin can still leave closed checkout allocations active';
  end if;
end $$;
