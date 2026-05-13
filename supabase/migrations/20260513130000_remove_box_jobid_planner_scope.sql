/**
 * PURPOSE:
 * Makes allocation remove-box planner reconciliation use exact jobId scope
 * when the canonical jobId route has already validated the job identity.
 *
 * AFFECTS:
 * public.api_allocations_remove_box planner scope only. Legacy jobNumber-only
 * remove-box behavior remains available for /allocations/:jobNumber.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * Supabase mirror migration, Edge mutationHandlers SQL planner ownership,
 * backend runtimeAutoAllocationPlanner remove-box scope tests, and schema
 * latest guard semantics.
 *
 * COMMON FAILURE MODES:
 * Allowing mismatched jobId/jobNumber payloads, accepting allocations from a
 * different job, omitting the affected boxId from planner scope, or changing
 * allocation apply/preview behavior before duplicate job numbers are enabled.
 */

create or replace function public.api_allocations_remove_box(
  p_org_id uuid,
  p_actor text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_actor text := app_api.require_text(p_actor, 'Actor');
  v_job_number text := app_api.require_job_number_digits(v_payload->>'jobNumber', 'JobNumber');
  v_job_id_text text := app_api.trim_text(v_payload->>'jobId');
  v_has_valid_job_id boolean := v_job_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_job_id uuid;
  v_allocation_id text := app_api.require_text(v_payload->>'allocationId', 'AllocationID');
  v_reason text := app_api.trim_text(v_payload->>'reason');
  v_job app.jobs;
  v_allocation app.allocations;
  v_removed app.allocations;
  v_box app.boxes;
  v_note text := '';
  v_released_feet integer := 0;
  v_now timestamptz := timezone('utc', now());
  v_film_order_id text := '';
  v_warnings text[] := array[]::text[];
begin
  if p_org_id is null then
    perform app_api.raise_http(400, 'Organization is required.');
  end if;

  if v_has_valid_job_id then
    v_job_id := v_job_id_text::uuid;

    select *
    into v_job
    from app.jobs j
    where j.org_id = p_org_id
      and j.id = v_job_id
    for update;

    if not found then
      perform app_api.raise_http(404, 'Job was not found.');
    end if;

    if upper(trim(v_job.job_number)) <> upper(trim(v_job_number)) then
      perform app_api.raise_http(
        409,
        'Job identity mismatch: selected job does not match jobNumber.'
      );
    end if;
  else
    select *
    into v_job
    from app.jobs j
    where j.org_id = p_org_id
      and upper(trim(j.job_number)) = upper(trim(v_job_number))
    for update;

    if not found then
      perform app_api.raise_http(404, format('Job %s was not found.', v_job_number));
    end if;
  end if;

  if coalesce(v_job.lifecycle_status::text, 'ACTIVE') <> 'ACTIVE' then
    perform app_api.raise_http(
      400,
      format('Job %s is closed and allocation rows cannot be removed.', v_job_number)
    );
  end if;

  if v_has_valid_job_id then
    select *
    into v_allocation
    from app.allocations a
    where a.org_id = p_org_id
      and a.allocation_id = v_allocation_id
    for update;

    if not found then
      perform app_api.raise_http(
        404,
        format('Allocation %s was not found for job %s.', v_allocation_id, v_job_number)
      );
    end if;

    if v_allocation.job_id is distinct from v_job.id then
      perform app_api.raise_http(
        409,
        format('Allocation %s belongs to a different job.', v_allocation_id)
      );
    end if;
  else
    select *
    into v_allocation
    from app.allocations a
    where a.org_id = p_org_id
      and a.allocation_id = v_allocation_id
      and (
        a.job_id = v_job.id
        or upper(trim(coalesce(a.job_number, ''))) = upper(trim(v_job.job_number))
      )
    for update;

    if not found then
      perform app_api.raise_http(
        404,
        format('Allocation %s was not found for job %s.', v_allocation_id, v_job_number)
      );
    end if;
  end if;

  if coalesce(v_allocation.status::text, '') = 'CANCELLED' then
    v_warnings := app_api.push_warning(
      v_warnings,
      format('Allocation %s was already cancelled for job %s.', v_allocation_id, v_job_number)
    );

    return jsonb_build_object(
      'jobNumber', v_job.job_number,
      'allocationId', v_allocation.allocation_id,
      'boxId', coalesce(v_allocation.box_id, ''),
      'removedAllocationCount', 0,
      'releasedFeet', 0,
      'warnings', to_jsonb(v_warnings)
    );
  end if;

  select *
  into v_box
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = app_api.require_text(v_allocation.box_id, 'BoxID')
  for update;

  if not found then
    perform app_api.raise_http(404, format('Box %s was not found.', v_allocation.box_id));
  end if;

  if upper(coalesce(v_box.status::text, '')) = 'CHECKED_OUT'
    and upper(trim(coalesce(v_box.last_checkout_job, ''))) = upper(trim(v_job.job_number))
  then
    perform app_api.raise_http(
      400,
      format(
        'Box %s is checked out on job %s and cannot be removed until the box is checked in.',
        v_box.box_id,
        v_job.job_number
      )
    );
  end if;

  v_note := coalesce(
    nullif(v_reason, ''),
    format(
      'Removed allocation %s for box %s from job %s on allocation detail page.',
      v_allocation.allocation_id,
      v_allocation.box_id,
      v_job.job_number
    )
  );
  v_released_feet := case
    when coalesce(v_allocation.status::text, '') in ('ACTIVE', 'FULFILLED')
      then greatest(coalesce(v_allocation.allocated_feet, 0), 0)
    else 0
  end;
  v_film_order_id := app_api.trim_text(v_allocation.film_order_id);

  if coalesce(v_allocation.allocation_source::text, 'MANUAL') = 'AUTO_PLANNED'
    and coalesce(v_allocation.allocation_kind::text, 'REQUIREMENT') <> 'EXTRA'
    and v_allocation.requirement_id is not null
  then
    perform app_api.record_auto_planned_allocation_suppression(
      p_org_id,
      v_actor,
      v_allocation.allocation_id,
      v_note
    );
  end if;

  update app.allocations
  set status = 'CANCELLED',
      resolved_at = v_now,
      resolved_by = v_actor,
      notes = v_note
  where org_id = p_org_id
    and allocation_id = v_allocation.allocation_id
  returning * into v_removed;

  if not found then
    perform app_api.raise_http(
      409,
      format('Allocation %s changed before it could be removed. Retry the request.', v_allocation_id)
    );
  end if;

  perform app_api.recalculate_physical_box_allocatable_now(p_org_id, v_box.box_id);

  if v_film_order_id <> '' then
    perform app_api.recalculate_film_order(p_org_id, v_film_order_id, v_actor);
  end if;

  perform app_api.reconcile_auto_planned_allocations(
    p_org_id,
    v_actor,
    case
      when v_has_valid_job_id then jsonb_build_object(
        'jobIds', jsonb_build_array(v_job.id),
        'jobNumbers', jsonb_build_array(v_job.job_number),
        'boxIds', jsonb_build_array(v_box.box_id)
      )
      else jsonb_build_object(
        'jobNumbers', jsonb_build_array(v_job.job_number),
        'boxIds', jsonb_build_array(v_box.box_id)
      )
    end
  );

  v_warnings := app_api.push_warning(
    v_warnings,
    format(
      'Removed allocation %s for box %s on job %s. Released %s LF back to planning capacity.',
      v_removed.allocation_id,
      v_removed.box_id,
      v_job.job_number,
      v_released_feet
    )
  );

  return jsonb_build_object(
    'jobNumber', v_job.job_number,
    'allocationId', v_removed.allocation_id,
    'boxId', v_removed.box_id,
    'removedAllocationCount', 1,
    'releasedFeet', v_released_feet,
    'warnings', to_jsonb(v_warnings)
  );
end;
$$;

comment on function public.api_allocations_remove_box(uuid, text, jsonb)
  is 'Atomically removes one job film allocation by allocation id and reconciles planner scope by exact jobId when canonical job identity is supplied.';
