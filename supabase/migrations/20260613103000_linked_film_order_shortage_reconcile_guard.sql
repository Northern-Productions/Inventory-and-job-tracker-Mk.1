/*
 * PURPOSE:
 * Prevent generic shortage reconciliation from rewriting linked film orders
 * after a physical box LF correction exposes a remaining shortage.
 *
 * AFFECTS:
 * Box LF correction, linked film-order recalculation, and job requirement
 * shortage reconciliation.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * docs/material-flow-rules.md, 0160 linked film-order physical LF recalc,
 * runtime box update/receive handlers, and schema/latest guards.
 */

create or replace function app_api.reconcile_existing_film_order_need_for_requirement(
  p_org_id uuid,
  p_actor text,
  p_requirement_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_requirement app.job_requirements;
  v_job_number text := '';
  v_primary_order app.film_orders;
  v_allocated_covered_feet integer := 0;
  v_missing_feet integer := 0;
  v_on_the_way_feet integer := 0;
  v_needed_order_feet integer := 0;
begin
  if p_requirement_id is null then
    return jsonb_build_object('updated', false, 'reason', 'NO_REQUIREMENT');
  end if;

  select *
  into v_requirement
  from app.job_requirements r
  where r.org_id = p_org_id
    and r.id = p_requirement_id;

  if not found then
    return jsonb_build_object('updated', false, 'reason', 'REQUIREMENT_NOT_FOUND');
  end if;

  select coalesce(j.job_number, '')
  into v_job_number
  from app.jobs j
  where j.org_id = p_org_id
    and j.id = v_requirement.job_id;

  -- FILM_ON_THE_WAY coverage uses the approved ordered LF once present;
  -- requested LF is a legacy fallback for older rows without ordered LF.
  select coalesce(sum(
    case
      when coalesce(a.covered_feet, 0) > 0 then a.covered_feet
      else a.allocated_feet
    end
  ), 0)::integer
  into v_allocated_covered_feet
  from app.allocations a
  join app.boxes b
    on b.org_id = a.org_id
   and b.box_id = a.box_id
  where a.org_id = p_org_id
    and a.requirement_id = v_requirement.id
    and a.status = 'ACTIVE'
    and coalesce(a.allocation_kind::text, 'REQUIREMENT') = 'REQUIREMENT'
    and upper(trim(coalesce(a.job_number, ''))) = upper(trim(coalesce(v_job_number, '')))
    and coalesce(b.status::text, '') not in ('ZEROED', 'RETIRED')
    and app_api.requirement_film_is_compatible(
      p_org_id,
      b.manufacturer,
      b.film_name,
      v_requirement.manufacturer,
      v_requirement.film_name
    )
    and coalesce(b.width_in, 0) >= coalesce(v_requirement.width_in, 0);

  v_missing_feet := greatest(
    coalesce(v_requirement.required_feet, 0) - least(v_allocated_covered_feet, coalesce(v_requirement.required_feet, 0)),
    0
  );

  select coalesce(sum(
    case
      when coalesce(fo.ordered_feet, 0) > 0 then coalesce(fo.ordered_feet, 0)
      else coalesce(fo.requested_feet, 0)
    end
  ), 0)::integer
  into v_on_the_way_feet
  from app.film_orders fo
  where fo.org_id = p_org_id
    and upper(trim(coalesce(fo.job_number, ''))) = upper(trim(coalesce(v_job_number, '')))
    and coalesce(fo.status::text, '') = 'FILM_ON_THE_WAY'
    and app_api.film_order_matches_requirement(
      p_org_id,
      fo.requirement_id,
      fo.manufacturer,
      fo.film_name,
      fo.width_in,
      v_requirement.id,
      v_requirement.manufacturer,
      v_requirement.film_name,
      v_requirement.width_in
    );

  v_needed_order_feet := greatest(v_missing_feet - v_on_the_way_feet, 0);

  select *
  into v_primary_order
  from app.film_orders fo
  where fo.org_id = p_org_id
    and upper(trim(coalesce(fo.job_number, ''))) = upper(trim(coalesce(v_job_number, '')))
    and coalesce(fo.status::text, '') = 'FILM_ORDER'
    and not exists (
      select 1
      from app.film_order_box_links l
      where l.org_id = fo.org_id
        and l.film_order_id = fo.film_order_id
    )
    and app_api.film_order_matches_requirement(
      p_org_id,
      fo.requirement_id,
      fo.manufacturer,
      fo.film_name,
      fo.width_in,
      v_requirement.id,
      v_requirement.manufacturer,
      v_requirement.film_name,
      v_requirement.width_in
    )
  order by fo.created_at asc, fo.film_order_id asc
  limit 1
  for update;

  if not found then
    return jsonb_build_object(
      'updated', false,
      'reason', 'NO_MATCHING_FILM_ORDER',
      'requirementId', v_requirement.id,
      'jobNumber', coalesce(v_job_number, ''),
      'missingFeet', v_missing_feet,
      'onTheWayFeet', v_on_the_way_feet,
      'neededOrderFeet', v_needed_order_feet
    );
  end if;

  v_primary_order.requirement_id := coalesce(v_primary_order.requirement_id, v_requirement.id);
  v_primary_order.requested_feet := v_needed_order_feet;
  v_primary_order.covered_feet := 0;
  v_primary_order.ordered_feet := 0;
  v_primary_order.remaining_to_order_feet := v_needed_order_feet;
  v_primary_order.resolved_at := null;
  v_primary_order.resolved_by := '';
  v_primary_order.notes := trim(
    coalesce(v_primary_order.notes, '') ||
    case when coalesce(v_primary_order.notes, '') = '' then '' else ' ' end ||
    format('Reconciled after box check-in; needed LF is now %s.', v_needed_order_feet)
  );

  if v_needed_order_feet = 0 then
    v_primary_order.status := 'FULFILLED';
    v_primary_order.resolved_at := timezone('utc', now());
    v_primary_order.resolved_by := app_api.trim_text(p_actor);
  else
    v_primary_order.status := 'FILM_ORDER';
  end if;

  v_primary_order := app_api.save_film_order(v_primary_order);

  return jsonb_build_object(
    'updated', true,
    'filmOrderId', coalesce(v_primary_order.film_order_id, ''),
    'requirementId', v_requirement.id,
    'jobNumber', coalesce(v_job_number, ''),
    'missingFeet', v_missing_feet,
    'onTheWayFeet', v_on_the_way_feet,
    'neededOrderFeet', v_needed_order_feet
  );
end;
$$;

do $$
declare
  v_def text;
begin
  select pg_get_functiondef('app_api.reconcile_existing_film_order_need_for_requirement(uuid, text, uuid)'::regprocedure)
  into v_def;

  if position('from app.film_order_box_links l' in v_def) = 0
     or position('l.film_order_id = fo.film_order_id' in v_def) = 0 then
    raise exception 'linked film-order shortage reconcile guard failed';
  end if;
end;
$$;

select app_api.grant_execute_if_exists('app_api.reconcile_existing_film_order_need_for_requirement(uuid, text, uuid)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.reconcile_existing_film_order_need_for_requirement(uuid, text, uuid)', 'service_role');
