/**
 * PURPOSE:
 * Makes film allocation availability canonical in SQL: physical LF minus
 * requirement-bound reserved LF, including AUTO_PLANNED and fulfilled
 * checked-out rows.
 *
 * AFFECTS:
 * Box reads/search, allocation apply guards, auto planner capacity, check-in
 * reallocation, and Supabase Edge RPC parity.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * shared/domain/filmAllocationReservations.mjs, backend runtime allocation
 * helpers, Supabase Edge read/mutation handlers, and allocation modal tests.
 *
 * COMMON FAILURE MODES:
 * Offering AUTO_PLANNED LF twice, counting EXTRA/placeholders, skipping boxes
 * instead of trimming AUTO rows after check-in, or hiding fulfilled checked-out
 * allocations before the box returns.
 */

create or replace function app_api.film_allocation_reserves_capacity(
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
    coalesce((p_allocation).allocation_kind::text, 'REQUIREMENT') = 'REQUIREMENT'
    and (p_allocation).requirement_id is not null
    and (
      (p_allocation).job_id is not null
      or app_api.trim_text((p_allocation).job_number) <> ''
    )
    and coalesce((p_allocation).allocated_feet, 0) > 0
    and (
      (p_allocation).status = 'ACTIVE'
      or (
        (p_allocation).status = 'FULFILLED'
        and upper(coalesce(p_box_status, '')) = 'CHECKED_OUT'
      )
    );
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
    and (p_allocation).job_date is not null
    and upper(coalesce(p_box_status, '')) in ('IN_STOCK', 'TRANSFER')
    and coalesce((p_allocation).allocation_source::text, 'MANUAL') <> 'AUTO_PLANNED';
$$;

create or replace function app_api.reserved_film_allocated_feet_for_box(
  p_org_id uuid,
  p_box_id text,
  p_excluded_allocation_id text default ''
)
returns integer
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select coalesce(sum(a.allocated_feet), 0)::integer
  from app.allocations a
  join app.boxes b
    on b.org_id = a.org_id
   and b.box_id = a.box_id
  where a.org_id = p_org_id
    and a.box_id = app_api.trim_text(p_box_id)
    and (
      app_api.trim_text(p_excluded_allocation_id) = ''
      or a.allocation_id <> app_api.trim_text(p_excluded_allocation_id)
    )
    and app_api.film_allocation_reserves_capacity(a, b.status::text);
$$;

create or replace function app_api.stored_film_allocated_feet_for_box(
  p_org_id uuid,
  p_box_id text
)
returns integer
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select coalesce(sum(a.allocated_feet), 0)::integer
  from app.allocations a
  join app.boxes b
    on b.org_id = a.org_id
   and b.box_id = a.box_id
  where a.org_id = p_org_id
    and a.box_id = app_api.trim_text(p_box_id)
    and app_api.film_allocation_consumes_stored_capacity(a, b.status::text);
$$;

create or replace function app_api.total_active_allocated_feet_for_box(
  p_org_id uuid,
  p_box_id text
)
returns integer
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select app_api.reserved_film_allocated_feet_for_box(p_org_id, p_box_id);
$$;

create or replace function app_api.locked_allocated_feet_for_box(
  p_org_id uuid,
  p_box_id text
)
returns integer
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select app_api.reserved_film_allocated_feet_for_box(p_org_id, p_box_id);
$$;

create or replace function app_api.placeholder_allocated_feet_for_box(
  p_org_id uuid,
  p_box_id text
)
returns integer
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select coalesce(sum(a.allocated_feet), 0)::integer
  from app.allocations a
  join app.boxes b
    on b.org_id = a.org_id
   and b.box_id = a.box_id
  where a.org_id = p_org_id
    and a.box_id = app_api.trim_text(p_box_id)
    and a.status = 'ACTIVE'
    and coalesce(a.allocation_kind::text, 'REQUIREMENT') = 'REQUIREMENT'
    and a.requirement_id is not null
    and a.job_date is null
    and not app_api.film_allocation_reserves_capacity(a, b.status::text);
$$;

create or replace function app_api.box_physical_feet_available(p_box app.boxes)
returns integer
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select
    case
      when upper(coalesce(p_box.status::text, '')) not in ('IN_STOCK', 'TRANSFER') then null
      when p_box.last_roll_weight_lbs is not null
        and p_box.core_weight_lbs is not null
        and p_box.lf_weight_lbs_per_ft is not null
        and p_box.lf_weight_lbs_per_ft > 0
      then app_api.derive_feet_available_from_roll_weight(
        p_box.last_roll_weight_lbs,
        p_box.core_weight_lbs,
        p_box.lf_weight_lbs_per_ft,
        p_box.initial_feet
      )
      else greatest(
        coalesce(p_box.feet_available, 0) + app_api.stored_film_allocated_feet_for_box(p_box.org_id, p_box.box_id),
        0
      )
    end::integer;
$$;

create or replace function app_api.box_allocatable_now_feet(p_box app.boxes)
returns integer
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select
    case
      when upper(coalesce(p_box.status::text, '')) in ('IN_STOCK', 'TRANSFER') then greatest(
        coalesce(app_api.box_physical_feet_available(p_box), 0)
          - app_api.reserved_film_allocated_feet_for_box(p_box.org_id, p_box.box_id),
        0
      )
      when upper(coalesce(p_box.status::text, '')) = 'ORDERED' then greatest(
        coalesce(p_box.initial_feet, 0) - app_api.reserved_film_allocated_feet_for_box(p_box.org_id, p_box.box_id),
        0
      )
      else 0
    end::integer;
$$;

create or replace function app_api.allocation_planning_feet_for_box(p_box app.boxes)
returns integer
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select app_api.box_allocatable_now_feet(p_box);
$$;

create or replace function app_api.recalculate_physical_box_allocatable_now(
  p_org_id uuid,
  p_box_id text,
  p_physical_feet_available integer default null
)
returns integer
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_box app.boxes;
  v_physical_feet integer := null;
  v_next_feet_available integer := 0;
begin
  select *
  into v_box
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = app_api.trim_text(p_box_id)
  for update;

  if not found then
    return 0;
  end if;

  if upper(coalesce(v_box.status::text, '')) not in ('IN_STOCK', 'TRANSFER') then
    return greatest(coalesce(v_box.feet_available, 0), 0);
  end if;

  v_physical_feet := coalesce(p_physical_feet_available, app_api.box_physical_feet_available(v_box), 0);
  v_next_feet_available := greatest(
    v_physical_feet - app_api.stored_film_allocated_feet_for_box(p_org_id, v_box.box_id),
    0
  );

  if coalesce(v_box.feet_available, 0) is distinct from v_next_feet_available then
    update app.boxes
    set feet_available = v_next_feet_available,
        updated_at = timezone('utc', now())
    where org_id = p_org_id
      and box_id = v_box.box_id;
  end if;

  return v_next_feet_available;
end;
$$;

create or replace function app_api.film_box_planner_physical_capacity(p_box app.boxes)
returns integer
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select greatest(coalesce(app_api.box_physical_feet_available(p_box), 0), 0)::integer;
$$;

create or replace function app_api.active_film_allocated_feet_for_box(
  p_org_id uuid,
  p_box_id text,
  p_excluded_allocation_id text default ''
)
returns integer
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select app_api.reserved_film_allocated_feet_for_box(
    p_org_id,
    p_box_id,
    p_excluded_allocation_id
  );
$$;

create or replace function app_api.assert_film_box_allocation_capacity(
  p_org_id uuid,
  p_box_id text,
  p_allocation_id text default ''
)
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_box app.boxes;
  v_capacity integer := 0;
  v_reserved_feet integer := 0;
begin
  select *
  into v_box
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = app_api.trim_text(p_box_id)
  for update;

  if not found then
    return;
  end if;

  if upper(coalesce(v_box.status::text, '')) in ('ZEROED', 'RETIRED') then
    return;
  end if;

  v_capacity := case
    when upper(coalesce(v_box.status::text, '')) in ('ORDERED', 'CHECKED_OUT') then greatest(coalesce(v_box.initial_feet, 0), 0)
    else app_api.film_box_planner_physical_capacity(v_box)
  end;
  v_reserved_feet := app_api.active_film_allocated_feet_for_box(p_org_id, v_box.box_id);

  if v_reserved_feet > v_capacity then
    perform app_api.raise_http(
      409,
      format(
        'Box %s has %s LF allocated but only %s physical LF available.',
        v_box.box_id,
        v_reserved_feet,
        v_capacity
      )
    );
  end if;
end;
$$;

do $$
declare
  v_def text;
  v_base text;
  v_next text;
begin
  select pg_get_functiondef('app_api.reconcile_auto_planned_allocations(uuid, text, jsonb)'::regprocedure)
  into v_def;
  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  v_next := replace(
    v_next,
    replace($old$
      and a.status = 'ACTIVE'
      and coalesce(a.allocation_source::text, 'MANUAL') <> 'AUTO_PLANNED'
$old$, E'\r\n', E'\n'),
    replace($new$
      and app_api.film_allocation_reserves_capacity(a, bx.status)
      and coalesce(a.allocation_source::text, 'MANUAL') <> 'AUTO_PLANNED'
$new$, E'\r\n', E'\n')
  );

  v_next := replace(
    v_next,
    replace($old$
      and a.status = 'ACTIVE'
      and coalesce(a.allocation_source::text, 'MANUAL') = 'AUTO_PLANNED'
      and upper(coalesce(b.status::text, '')) = 'CHECKED_OUT'
$old$, E'\r\n', E'\n'),
    replace($new$
      and app_api.film_allocation_reserves_capacity(a, b.status::text)
      and coalesce(a.allocation_source::text, 'MANUAL') = 'AUTO_PLANNED'
      and upper(coalesce(b.status::text, '')) = 'CHECKED_OUT'
$new$, E'\r\n', E'\n')
  );

  v_next := replace(
    v_next,
    replace($old$
        and a.status = 'ACTIVE'
    ), 0) > bx.capacity;
$old$, E'\r\n', E'\n'),
    replace($new$
        and app_api.film_allocation_reserves_capacity(a, bx.status)
        and (
          coalesce(a.allocation_source::text, 'MANUAL') <> 'AUTO_PLANNED'
          or upper(coalesce(bx.status, '')) = 'CHECKED_OUT'
        )
    ), 0) > bx.capacity;
$new$, E'\r\n', E'\n')
  );

  if v_next = v_base then
    if v_base like '%app_api.film_allocation_reserves_capacity(a, bx.status)%'
      and v_base like '%app_api.film_allocation_reserves_capacity(a, b.status::text)%'
    then
      return;
    end if;

    raise exception 'reconcile_auto_planned_allocations patch did not match expected snippets';
  end if;

  execute v_next;
end;
$$;
