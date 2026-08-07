-- Keep Film Orders list status and coverage metrics aligned with the canonical detail projection.

create or replace function public.api_list_film_orders(
  p_org_id uuid,
  p_warehouse text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_result jsonb;
  v_warehouse text := upper(app_api.trim_text(p_warehouse));
begin
  perform app_api.require_org_member(p_org_id);

  if v_warehouse = 'ALL' then
    v_warehouse := '';
  elsif v_warehouse <> '' then
    v_warehouse := app_api.require_org_warehouse(p_org_id, v_warehouse, 'Warehouse');
  end if;

  with scoped_orders as materialized (
    select f.*
    from app.film_orders f
    where f.org_id = p_org_id
      and (
        v_warehouse = ''
        or upper(trim(f.warehouse::text)) = v_warehouse
      )
  ),
  linked_box_coverage as materialized (
    select
      l.film_order_id,
      coalesce(sum(greatest(coalesce(b.initial_feet, 0), 0)), 0)::integer as fulfilled_feet
    from scoped_orders so
    join app.film_order_box_links l
      on l.org_id = so.org_id
     and l.film_order_id = so.film_order_id
    left join app.boxes b
      on b.org_id = l.org_id
     and b.box_id = l.box_id
    group by l.film_order_id
  ),
  latest_manual_fulfill as materialized (
    select distinct on (e.film_order_id)
      e.film_order_id,
      e.created_at,
      e.actor
    from app.film_order_events e
    join scoped_orders so
      on so.org_id = e.org_id
     and so.film_order_id = e.film_order_id
    where e.event_type = 'FILM_ORDER_MANUALLY_FULFILLED'
    order by e.film_order_id, e.created_at desc, e.event_id desc
  ),
  removed_requirement_events as materialized (
    select distinct e.film_order_id
    from app.film_order_events e
    join scoped_orders so
      on so.org_id = e.org_id
     and so.film_order_id = e.film_order_id
    where e.event_type in ('REQUIREMENT_REMOVED', 'REQUIREMENT_NO_LONGER_MATCHES')
  ),
  requirement_state as (
    select
      to_jsonb(so) as order_json,
      so.film_order_id,
      so.created_at,
      so.status::text as stored_status,
      so.requested_feet,
      so.requirement_id,
      r.id as current_requirement_id,
      r.required_feet as current_required_feet,
      case
        when r.id is null then false
        else app_api.film_order_matches_requirement(
          p_org_id,
          r.id,
          r.manufacturer,
          r.film_name,
          r.width_in,
          so.requirement_id,
          so.manufacturer,
          so.film_name,
          so.width_in
        )
      end as requirement_matches,
      (removed.film_order_id is not null) as has_removed_requirement_event,
      manual.created_at as manual_fulfilled_at,
      manual.actor as manual_fulfilled_by,
      greatest(coalesce(coverage.fulfilled_feet, 0), 0)::integer as fulfilled_feet
    from scoped_orders so
    left join app.job_requirements r
      on r.org_id = so.org_id
     and r.id = so.requirement_id
    left join linked_box_coverage coverage
      on coverage.film_order_id = so.film_order_id
    left join latest_manual_fulfill manual
      on manual.film_order_id = so.film_order_id
    left join removed_requirement_events removed
      on removed.film_order_id = so.film_order_id
  ),
  effective_need as (
    select
      state.*,
      case
        when state.requirement_id is null and state.has_removed_requirement_event then 'NO_LONGER_NEEDED'
        when state.requirement_id is not null
          and (state.current_requirement_id is null or not state.requirement_matches) then 'NO_LONGER_NEEDED'
        when state.current_requirement_id is not null and state.requirement_matches then 'CURRENT_REQUIREMENT'
        else 'LEGACY_SNAPSHOT'
      end as need_source,
      case
        when state.requirement_id is null and state.has_removed_requirement_event then 0
        when state.requirement_id is not null
          and (state.current_requirement_id is null or not state.requirement_matches) then 0
        when state.current_requirement_id is not null and state.requirement_matches
          then greatest(coalesce(state.current_required_feet, 0), 0)::integer
        else greatest(coalesce(state.requested_feet, 0), 0)::integer
      end as needed_feet
    from requirement_state state
  ),
  effective_status as (
    select
      effective.*,
      greatest(effective.needed_feet - effective.fulfilled_feet, 0)::integer as remaining_feet,
      greatest(effective.fulfilled_feet - effective.needed_feet, 0)::integer as overage_feet,
      case
        when upper(coalesce(effective.stored_status, '')) = 'CANCELLED' then 'CANCELLED'
        when effective.manual_fulfilled_at is not null
          and upper(coalesce(effective.stored_status, '')) = 'FULFILLED' then 'MANUALLY_FULFILLED'
        when effective.need_source = 'NO_LONGER_NEEDED' then 'NO_LONGER_NEEDED'
        when effective.fulfilled_feet <= 0 and effective.needed_feet > 0 then 'FILM_ORDER'
        when effective.fulfilled_feet > 0 and effective.fulfilled_feet < effective.needed_feet then 'INCOMPLETE'
        when effective.fulfilled_feet >= effective.needed_feet then 'FULFILLED_COVERED'
        else 'FILM_ORDER'
      end as display_status
    from effective_need effective
  )
  select coalesce(
    jsonb_agg(
      effective.order_json || jsonb_strip_nulls(jsonb_build_object(
        'stored_status', effective.stored_status,
        'display_status', effective.display_status,
        'need_source', effective.need_source,
        'needed_feet', effective.needed_feet,
        'fulfilled_feet', effective.fulfilled_feet,
        'remaining_feet', effective.remaining_feet,
        'overage_feet', effective.overage_feet,
        'manual_fulfilled_at', effective.manual_fulfilled_at,
        'manual_fulfilled_by', effective.manual_fulfilled_by
      ))
      order by effective.created_at desc, effective.film_order_id desc
    ),
    '[]'::jsonb
  )
  into v_result
  from effective_status effective;

  return v_result;
end;
$$;

revoke execute on function public.api_list_film_orders(uuid, text) from public, anon, authenticated, service_role;
