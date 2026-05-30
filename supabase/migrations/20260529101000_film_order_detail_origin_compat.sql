/*
 * Patch film order detail RPC origin projection for schemas where app.film_orders
 * stores source_box_id but does not have a persisted origin column.
 */

create or replace function public.api_acl_film_orders_get(
  p_org_id uuid,
  p_film_order_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_order app.film_orders;
  v_job app.jobs;
  v_requirement app.job_requirements;
  v_phase app.job_phases;
  v_requirement_found boolean := false;
  v_requirement_matches boolean := false;
  v_has_removed_requirement_event boolean := false;
  v_need_source text := 'LEGACY_SNAPSHOT';
  v_needed_feet integer := 0;
  v_fulfilled_feet integer := 0;
  v_remaining_feet integer := 0;
  v_overage_feet integer := 0;
  v_display_status text := 'FILM_ORDER';
  v_linked_boxes jsonb := '[]'::jsonb;
  v_history jsonb := '[]'::jsonb;
  v_received_date date;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'film_orders', 'read');

  select *
  into v_order
  from app.film_orders fo
  where fo.org_id = p_org_id
    and fo.film_order_id = app_api.require_text(p_film_order_id, 'filmOrderId');

  if not found then
    return null;
  end if;

  if v_order.job_id is not null then
    select *
    into v_job
    from app.jobs j
    where j.org_id = p_org_id
      and j.id = v_order.job_id;
  end if;

  if v_order.requirement_id is null then
    select exists (
      select 1
      from app.film_order_events e
      where e.org_id = p_org_id
        and e.film_order_id = v_order.film_order_id
        and e.event_type in ('REQUIREMENT_REMOVED', 'REQUIREMENT_NO_LONGER_MATCHES')
    )
    into v_has_removed_requirement_event;
  end if;

  if v_order.requirement_id is not null then
    select *
    into v_requirement
    from app.job_requirements r
    where r.org_id = p_org_id
      and r.id = v_order.requirement_id;
    v_requirement_found := found;

    if v_requirement_found then
      select *
      into v_phase
      from app.job_phases p
      where p.org_id = p_org_id
        and p.id = v_requirement.phase_id;

      v_requirement_matches := app_api.film_order_matches_requirement(
        p_org_id,
        v_requirement.id,
        v_requirement.manufacturer,
        v_requirement.film_name,
        v_requirement.width_in,
        v_order.requirement_id,
        v_order.manufacturer,
        v_order.film_name,
        v_order.width_in
      );
    end if;
  end if;

  if v_has_removed_requirement_event then
    v_need_source := 'NO_LONGER_NEEDED';
    v_needed_feet := 0;
  elsif v_order.requirement_id is not null and (not v_requirement_found or not v_requirement_matches) then
    v_need_source := 'NO_LONGER_NEEDED';
    v_needed_feet := 0;
  elsif v_requirement_found and v_requirement_matches then
    v_need_source := 'CURRENT_REQUIREMENT';
    v_needed_feet := greatest(coalesce(v_requirement.required_feet, 0), 0);
  else
    v_need_source := 'LEGACY_SNAPSHOT';
    v_needed_feet := greatest(coalesce(v_order.requested_feet, 0), 0);
  end if;

  select
    coalesce(sum(greatest(coalesce(b.initial_feet, 0), 0)), 0)::integer,
    max(b.received_date),
    coalesce(
      jsonb_agg(
        jsonb_strip_nulls(jsonb_build_object(
          'linkId', l.link_id,
          'boxId', l.box_id,
          'orderedFeet', l.ordered_feet,
          'autoAllocatedFeet', l.auto_allocated_feet,
          'initialFeet', coalesce(b.initial_feet, 0),
          'feetAvailable', coalesce(b.feet_available, 0),
          'status', b.status::text,
          'dealer', b.dealer,
          'orderDate', b.order_date,
          'receivedDate', b.received_date,
          'isReceived', (b.box_id is not null and upper(coalesce(b.status::text, '')) <> 'ORDERED'),
          'isDirectToJobSite', coalesce(b.direct_to_job_site, false)
        ))
        order by l.created_at, l.link_id
      ) filter (where b.box_id is not null),
      '[]'::jsonb
    )
  into v_fulfilled_feet, v_received_date, v_linked_boxes
  from app.film_order_box_links l
  left join app.boxes b
    on b.org_id = l.org_id
   and b.box_id = l.box_id
  where l.org_id = p_org_id
    and l.film_order_id = v_order.film_order_id;

  v_remaining_feet := greatest(v_needed_feet - v_fulfilled_feet, 0);
  v_overage_feet := greatest(v_fulfilled_feet - v_needed_feet, 0);

  v_display_status := case
    when upper(coalesce(v_order.status::text, '')) = 'CANCELLED' then 'CANCELLED'
    when v_need_source = 'NO_LONGER_NEEDED' then 'NO_LONGER_NEEDED'
    when v_fulfilled_feet <= 0 and v_needed_feet > 0 then 'FILM_ORDER'
    when v_fulfilled_feet > 0 and v_fulfilled_feet < v_needed_feet then 'INCOMPLETE'
    when v_fulfilled_feet >= v_needed_feet then 'FULFILLED_COVERED'
    else 'FILM_ORDER'
  end;

  select coalesce(
    jsonb_agg(
      jsonb_strip_nulls(jsonb_build_object(
        'eventId', e.event_id,
        'eventType', e.event_type,
        'filmOrderId', e.film_order_id,
        'relatedBoxId', nullif(e.related_box_id, ''),
        'relatedRequirementId', e.related_requirement_id,
        'actor', e.actor,
        'note', e.note,
        'before', e.before_state,
        'after', e.after_state,
        'createdAt', e.created_at
      ))
      order by e.created_at desc, e.event_id desc
    ),
    '[]'::jsonb
  )
  into v_history
  from app.film_order_events e
  where e.org_id = p_org_id
    and e.film_order_id = v_order.film_order_id;

  return jsonb_strip_nulls(jsonb_build_object(
    'filmOrderId', v_order.film_order_id,
    'jobId', v_order.job_id,
    'requirementId', v_order.requirement_id,
    'jobNumber', v_order.job_number,
    'warehouse', v_order.warehouse,
    'workScope', coalesce(v_phase.sections, v_job.sections, ''),
    'sections', coalesce(v_phase.sections, v_job.sections, ''),
    'manufacturer', v_order.manufacturer,
    'filmName', v_order.film_name,
    'widthIn', v_order.width_in,
    'requestedFeet', v_order.requested_feet,
    'coveredFeet', v_order.covered_feet,
    'orderedFeet', v_order.ordered_feet,
    'remainingToOrderFeet', v_order.remaining_to_order_feet,
    'installDate', v_order.job_date,
    'crewLeader', v_order.crew_leader,
    'status', v_order.status::text,
    'storedStatus', v_order.status::text,
    'displayStatus', v_display_status,
    'needSource', v_need_source,
    'neededFeet', v_needed_feet,
    'fulfilledFeet', v_fulfilled_feet,
    'remainingFeet', v_remaining_feet,
    'overageFeet', v_overage_feet,
    'sourceBoxId', v_order.source_box_id,
    'origin', case
      when app_api.trim_text(v_order.source_box_id) = '' then 'MANUAL'
      else 'AUTO_SHORTAGE'
    end,
    'createdAt', v_order.created_at,
    'createdBy', v_order.created_by,
    'resolvedAt', v_order.resolved_at,
    'resolvedBy', v_order.resolved_by,
    'orderedDate', v_order.created_at::date,
    'receivedDate', v_received_date,
    'notes', v_order.notes,
    'job', case when v_order.job_id is null then null else jsonb_strip_nulls(jsonb_build_object(
      'jobId', v_order.job_id,
      'jobNumber', v_order.job_number,
      'warehouse', coalesce(v_job.warehouse, v_order.warehouse),
      'workScope', v_job.sections,
      'sections', v_job.sections
    )) end,
    'phase', case when v_phase.id is null then null else jsonb_strip_nulls(jsonb_build_object(
      'phaseId', v_phase.id,
      'phaseNumber', v_phase.phase_number,
      'workScope', v_phase.sections,
      'sections', v_phase.sections,
      'installDate', v_phase.install_date,
      'crewLeader', v_phase.crew_leader
    )) end,
    'requirement', case when v_requirement_found then jsonb_strip_nulls(jsonb_build_object(
      'requirementId', v_requirement.id,
      'phaseId', v_requirement.phase_id,
      'manufacturer', v_requirement.manufacturer,
      'filmName', v_requirement.film_name,
      'widthIn', v_requirement.width_in,
      'requiredFeet', v_requirement.required_feet,
      'status', v_requirement.status,
      'matchesFilmOrder', v_requirement_matches
    )) else null end,
    'linkedBoxes', v_linked_boxes,
    'history', v_history
  ));
end;
$$;
