/**
 * PURPOSE:
 * Make checked-in physical LF authoritative when a returned roll has less
 * material than the box's remaining active allocations, then reconcile
 * allocation coverage by job priority instead of rejecting the check-in.
 *
 * AFFECTS:
 * public.api_boxes_set_status, app_api.reconcile_box_checkin_allocations,
 * check-in/zero-out workflows, allocation coverage, film-order shortage
 * recalculation, and Jobs tab readiness/attention projections.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * runtimeBoxCheckin.mjs, statusTransitions.mjs, shared
 * filmAllocationReservations.mjs, Supabase Edge /boxes/set-status facade,
 * and schema/latest checks.
 *
 * COMMON FAILURE MODES:
 * Reintroducing active-allocation lower bounds on physical check-in, reducing
 * scheduled jobs before unscheduled jobs, or using jobNumber as a tie-breaker
 * when jobId is available.
 */

create or replace function app_api.reconcile_box_checkin_allocations(
  p_org_id uuid,
  p_actor text,
  p_box_id text,
  p_physical_feet_after integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_box app.boxes;
  v_allocation app.allocations;
  v_requirement app.job_requirements;
  v_remaining_feet integer := 0;
  v_next_allocated_feet integer := 0;
  v_next_covered_feet integer := 0;
  v_cancelled_count integer := 0;
  v_reduced_count integer := 0;
  v_active_reserved_feet integer := 0;
  v_active_stored_feet integer := 0;
  v_feet_available integer := 0;
  v_requirement_ids uuid[] := array[]::uuid[];
  v_film_order_ids text[] := array[]::text[];
  v_affected_job_numbers text[] := array[]::text[];
  v_reduced_allocation_ids text[] := array[]::text[];
  v_cancelled_allocation_ids text[] := array[]::text[];
  v_updated_film_order_ids text[] := array[]::text[];
  v_requirement_id uuid;
  v_film_order_id text;
  v_order_result jsonb;
  v_warnings text[] := array[]::text[];
begin
  if p_physical_feet_after is null or p_physical_feet_after < 0 then
    perform app_api.raise_http(400, 'Physical feet after check-in must be zero or greater.');
  end if;

  select *
  into v_box
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = app_api.trim_text(p_box_id)
  for update;

  if not found then
    perform app_api.raise_http(404, 'Box not found.');
  end if;

  v_remaining_feet := greatest(coalesce(p_physical_feet_after, 0), 0);

  for v_allocation in
    select a.*
    from app.allocations a
    left join lateral (
      select j.id, j.created_at
      from app.jobs j
      where j.org_id = p_org_id
        and (
          (a.job_id is not null and j.id = a.job_id)
          or (
            a.job_id is null
            and upper(trim(j.job_number)) = upper(trim(a.job_number))
          )
        )
      order by
        case when a.job_id is not null and j.id = a.job_id then 0 else 1 end,
        j.created_at asc,
        j.id asc
      limit 1
    ) j on true
    where a.org_id = p_org_id
      and a.box_id = v_box.box_id
      and a.status = 'ACTIVE'
      and app_api.film_allocation_reserves_capacity(a, 'IN_STOCK')
    order by
      case when a.job_date is not null then 0 else 1 end,
      a.job_date asc nulls last,
      coalesce(j.created_at, a.created_at) asc,
      coalesce(j.id::text, a.job_id::text, '') asc,
      a.created_at asc,
      a.allocation_id asc
    for update of a
  loop
    v_requirement := null;
    if v_allocation.requirement_id is not null then
      select *
      into v_requirement
      from app.job_requirements r
      where r.org_id = p_org_id
        and r.id = v_allocation.requirement_id;
    end if;

    if v_remaining_feet >= coalesce(v_allocation.allocated_feet, 0) then
      v_remaining_feet := v_remaining_feet - greatest(coalesce(v_allocation.allocated_feet, 0), 0);
      continue;
    end if;

    v_requirement_ids := array_append(v_requirement_ids, v_allocation.requirement_id);
    v_film_order_ids := array_append(v_film_order_ids, app_api.trim_text(v_allocation.film_order_id));
    if app_api.trim_text(v_allocation.job_number) <> '' then
      v_affected_job_numbers := array_append(v_affected_job_numbers, app_api.trim_text(v_allocation.job_number));
    end if;

    if v_remaining_feet > 0 then
      v_next_allocated_feet := v_remaining_feet;
      v_next_covered_feet := app_api.compute_covered_feet_from_allocation(
        v_next_allocated_feet,
        v_box.width_in,
        coalesce(v_requirement.width_in, v_box.width_in),
        coalesce(nullif(v_allocation.covered_feet, 0), v_allocation.allocated_feet)
      );

      update app.allocations
      set allocated_feet = v_next_allocated_feet,
          covered_feet = v_next_covered_feet,
          notes = trim(
            coalesce(notes, '') ||
            case when coalesce(notes, '') = '' then '' else ' ' end ||
            format('Reduced from %s LF to %s LF during box check-in reconciliation.', v_allocation.allocated_feet, v_next_allocated_feet)
          )
      where org_id = p_org_id
        and allocation_id = v_allocation.allocation_id;

      v_reduced_count := v_reduced_count + 1;
      v_reduced_allocation_ids := array_append(v_reduced_allocation_ids, v_allocation.allocation_id);
      v_warnings := app_api.push_warning(
        v_warnings,
        format(
          'Reduced allocation %s for job %s from %s LF to %s LF because box %s physically returned with less LF.',
          v_allocation.allocation_id,
          coalesce(nullif(v_allocation.job_number, ''), 'UNKNOWN'),
          v_allocation.allocated_feet,
          v_next_allocated_feet,
          v_box.box_id
        )
      );
      v_remaining_feet := 0;
    else
      update app.allocations
      set status = 'CANCELLED',
          resolved_at = timezone('utc', now()),
          resolved_by = app_api.trim_text(p_actor),
          notes = trim(
            coalesce(notes, '') ||
            case when coalesce(notes, '') = '' then '' else ' ' end ||
            format('Cancelled during box check-in reconciliation because box %s has no remaining physical LF for this reservation.', v_box.box_id)
          )
      where org_id = p_org_id
        and allocation_id = v_allocation.allocation_id;

      v_cancelled_count := v_cancelled_count + 1;
      v_cancelled_allocation_ids := array_append(v_cancelled_allocation_ids, v_allocation.allocation_id);
      v_warnings := app_api.push_warning(
        v_warnings,
        format(
          'Cancelled allocation %s for job %s because box %s no longer has enough physical LF.',
          v_allocation.allocation_id,
          coalesce(nullif(v_allocation.job_number, ''), 'UNKNOWN'),
          v_box.box_id
        )
      );
    end if;
  end loop;

  select
    coalesce(sum(a.allocated_feet) filter (where app_api.film_allocation_reserves_capacity(a, 'IN_STOCK')), 0)::integer,
    coalesce(sum(a.allocated_feet) filter (where app_api.film_allocation_consumes_stored_capacity(a, 'IN_STOCK')), 0)::integer
  into v_active_reserved_feet, v_active_stored_feet
  from app.allocations a
  where a.org_id = p_org_id
    and a.box_id = v_box.box_id
    and a.status = 'ACTIVE';

  if v_active_reserved_feet > greatest(coalesce(p_physical_feet_after, 0), 0) then
    perform app_api.raise_http(500, 'Box check-in reconciliation failed to reduce active allocations below physical LF.');
  end if;

  v_feet_available := greatest(coalesce(p_physical_feet_after, 0) - v_active_stored_feet, 0);

  foreach v_film_order_id in array coalesce(v_film_order_ids, array[]::text[]) loop
    v_film_order_id := app_api.trim_text(v_film_order_id);
    if v_film_order_id <> '' and not v_film_order_id = any(v_updated_film_order_ids) then
      perform app_api.recalculate_film_order(p_org_id, v_film_order_id, p_actor);
      v_updated_film_order_ids := array_append(v_updated_film_order_ids, v_film_order_id);
    end if;
  end loop;

  foreach v_requirement_id in array coalesce(v_requirement_ids, array[]::uuid[]) loop
    if v_requirement_id is not null then
      v_order_result := app_api.reconcile_existing_film_order_need_for_requirement(
        p_org_id,
        p_actor,
        v_requirement_id
      );
      if coalesce((v_order_result->>'filmOrderId'), '') <> ''
        and not (v_order_result->>'filmOrderId') = any(v_updated_film_order_ids) then
        v_updated_film_order_ids := array_append(v_updated_film_order_ids, v_order_result->>'filmOrderId');
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'boxId', v_box.box_id,
    'physicalFeetAfter', greatest(coalesce(p_physical_feet_after, 0), 0),
    'activeReservedFeet', v_active_reserved_feet,
    'activeStoredFeet', v_active_stored_feet,
    'feetAvailable', v_feet_available,
    'reducedCount', v_reduced_count,
    'cancelledCount', v_cancelled_count,
    'reducedAllocationIds', to_jsonb(array(select distinct unnest(v_reduced_allocation_ids))),
    'cancelledAllocationIds', to_jsonb(array(select distinct unnest(v_cancelled_allocation_ids))),
    'affectedJobNumbers', to_jsonb(array(select distinct unnest(v_affected_job_numbers))),
    'updatedFilmOrderIds', to_jsonb(array(select distinct unnest(v_updated_film_order_ids))),
    'warnings', to_jsonb(v_warnings)
  );
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

  if position('v_reconciliation_result jsonb' in v_next) = 0 then
    v_next := replace(
      v_next,
      '  v_receipt_result jsonb := jsonb_build_object(''warnings'', ''[]''::jsonb);',
      replace('  v_receipt_result jsonb := jsonb_build_object(''warnings'', ''[]''::jsonb);
  v_reconciliation_result jsonb := jsonb_build_object(''warnings'', ''[]''::jsonb);', E'\r\n', E'\n')
    );
  end if;

  v_next := replace(
    v_next,
    replace($old$
    if v_other_active_allocated_feet > v_physical_feet_after then
      perform app_api.raise_http(
        400,
        format(
          'Received physical LF cannot be lower than the box''s active allocated feet (%s).',
          v_other_active_allocated_feet
        )
      );
    end if;

    v_box.core_type := v_resolved_core_type;
    v_box.core_weight_lbs := v_resolved_core_weight;
    v_box.lf_weight_lbs_per_ft := v_resolved_lf_weight;
    v_box.feet_available := greatest(v_physical_feet_after - v_other_active_allocated_feet, 0);

    if v_same_job_active_allocation_count > 0 and v_checkout_job <> '' then
      v_same_job_release := app_api.cancel_active_allocations_for_box_job(
        p_org_id,
        v_box.box_id,
        v_checkout_job,
        p_actor,
        'Released during film box check-in.',
        v_checkout_job_id
      );
      if coalesce((v_same_job_release->>'cancelledCount')::integer, 0) > 0 then
        v_warnings := app_api.push_warning(
          v_warnings,
          format(
            'Released %s active planning allocation%s totaling %s LF for job %s during check-in.',
            (v_same_job_release->>'cancelledCount')::integer,
            case when (v_same_job_release->>'cancelledCount')::integer = 1 then '' else 's' end,
            coalesce((v_same_job_release->>'cancelledFeet')::integer, 0),
            v_checkout_job
          )
        );
      end if;
    end if;
$old$, E'\r\n', E'\n'),
    replace($new$
    if v_same_job_active_allocation_count > 0 and v_checkout_job <> '' then
      v_same_job_release := app_api.cancel_active_allocations_for_box_job(
        p_org_id,
        v_box.box_id,
        v_checkout_job,
        p_actor,
        'Released during film box check-in.',
        v_checkout_job_id
      );
      if coalesce((v_same_job_release->>'cancelledCount')::integer, 0) > 0 then
        v_warnings := app_api.push_warning(
          v_warnings,
          format(
            'Released %s active planning allocation%s totaling %s LF for job %s during check-in.',
            (v_same_job_release->>'cancelledCount')::integer,
            case when (v_same_job_release->>'cancelledCount')::integer = 1 then '' else 's' end,
            coalesce((v_same_job_release->>'cancelledFeet')::integer, 0),
            v_checkout_job
          )
        );
      end if;
    end if;

    v_reconciliation_result := app_api.reconcile_box_checkin_allocations(
      p_org_id,
      p_actor,
      v_box.box_id,
      v_physical_feet_after
    );
    if jsonb_typeof(coalesce(v_reconciliation_result->'warnings', '[]'::jsonb)) = 'array' then
      v_warnings := v_warnings || array(
        select jsonb_array_elements_text(coalesce(v_reconciliation_result->'warnings', '[]'::jsonb))
      );
    end if;

    v_box.core_type := v_resolved_core_type;
    v_box.core_weight_lbs := v_resolved_core_weight;
    v_box.lf_weight_lbs_per_ft := v_resolved_lf_weight;
    v_box.feet_available := coalesce(
      (v_reconciliation_result->>'feetAvailable')::integer,
      greatest(v_physical_feet_after, 0)
    );
$new$, E'\r\n', E'\n')
  );

  if v_next = v_base then
    if position('v_reconciliation_result := app_api.reconcile_box_checkin_allocations' in v_base) > 0
       and position('Received physical LF cannot be lower than the box''s active allocated feet' in v_base) = 0 then
      return;
    end if;

    raise exception 'api_boxes_set_status physical LF reconciliation patch did not match expected snippets';
  end if;

  if position('v_reconciliation_result := app_api.reconcile_box_checkin_allocations' in v_next) = 0
     or position('v_reconciliation_result jsonb' in v_next) = 0
     or position('Received physical LF cannot be lower than the box''s active allocated feet' in v_next) > 0 then
    raise exception 'api_boxes_set_status physical LF reconciliation patch left unsafe semantics';
  end if;

  execute v_next;
end;
$$;

do $$
declare
  v_def text;
begin
  select pg_get_functiondef('app_api.reconcile_box_checkin_allocations(uuid, text, text, integer)'::regprocedure)
  into v_def;

  if position('case when a.job_date is not null then 0 else 1 end' in v_def) = 0 then
    raise exception 'reconcile_box_checkin_allocations missing scheduled-first priority';
  end if;

  if position('coalesce(j.created_at, a.created_at) asc' in v_def) = 0 then
    raise exception 'reconcile_box_checkin_allocations missing job-created priority';
  end if;

  if position('coalesce(j.id::text, a.job_id::text, '''') asc' in v_def) = 0 then
    raise exception 'reconcile_box_checkin_allocations missing jobId tie-breaker';
  end if;

  select pg_get_functiondef('public.api_boxes_set_status(uuid, text, jsonb)'::regprocedure)
  into v_def;

  if position('Received physical LF cannot be lower than the box''s active allocated feet' in v_def) > 0 then
    raise exception 'public.api_boxes_set_status still blocks physical LF below active allocations';
  end if;

  if position('v_reconciliation_result := app_api.reconcile_box_checkin_allocations' in v_def) = 0 then
    raise exception 'public.api_boxes_set_status missing check-in reconciliation call';
  end if;
end;
$$;
