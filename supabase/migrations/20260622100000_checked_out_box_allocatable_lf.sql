/*
 * PURPOSE:
 * Let checked-out boxes expose unclaimed remaining LF for planning/allocation
 * without treating checkout itself as physical consumption.
 *
 * AFFECTS:
 * Box reads/search, allocation preview/apply guards, auto allocation planning,
 * and Box Details availability display.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * docs/material-flow-rules.md, shared/domain/filmAllocationReservations.mjs,
 * local runtime allocation helpers, Supabase Edge read/mutation handlers,
 * and schema/latest guards.
 */

create or replace function app_api.box_physical_feet_available(p_box app.boxes)
returns integer
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select
    case
      when upper(coalesce(p_box.status::text, '')) not in ('IN_STOCK', 'TRANSFER', 'CHECKED_OUT') then null
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
      when upper(coalesce(p_box.status::text, '')) = 'CHECKED_OUT' then greatest(
        coalesce(p_box.feet_available, 0),
        0
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
      when upper(coalesce(p_box.status::text, '')) in ('IN_STOCK', 'TRANSFER', 'CHECKED_OUT') then greatest(
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

do $$
declare
  v_physical_def text;
  v_allocatable_def text;
begin
  select pg_get_functiondef('app_api.box_physical_feet_available(app.boxes)'::regprocedure)
  into v_physical_def;

  select pg_get_functiondef('app_api.box_allocatable_now_feet(app.boxes)'::regprocedure)
  into v_allocatable_def;

  if position('''CHECKED_OUT''' in v_physical_def) = 0
     or position('p_box.feet_available' in v_physical_def) = 0 then
    raise exception 'checked-out physical feet guard failed';
  end if;

  if position('''CHECKED_OUT''' in v_allocatable_def) = 0
     or position('app_api.reserved_film_allocated_feet_for_box(p_box.org_id, p_box.box_id)' in v_allocatable_def) = 0 then
    raise exception 'checked-out allocatable feet guard failed';
  end if;
end;
$$;

select app_api.grant_execute_if_exists('app_api.box_physical_feet_available(app.boxes)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.box_physical_feet_available(app.boxes)', 'service_role');
select app_api.grant_execute_if_exists('app_api.box_allocatable_now_feet(app.boxes)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.box_allocatable_now_feet(app.boxes)', 'service_role');
select app_api.grant_execute_if_exists('app_api.allocation_planning_feet_for_box(app.boxes)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.allocation_planning_feet_for_box(app.boxes)', 'service_role');
