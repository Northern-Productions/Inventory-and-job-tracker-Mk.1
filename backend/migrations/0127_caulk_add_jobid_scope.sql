/*
 * PURPOSE:
 * Makes canonical caulk add allocation target exact job IDs while preserving
 * the legacy jobNumber-only caulk add path.
 *
 * AFFECTS:
 * public.api_acl_allocations_caulk_add, local/Edge canonical caulk add
 * payloads, and planner reconciliation scope.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * backend caulk allocation runtime, Supabase Edge mutationHandlers
 * /allocations/caulk/add, frontend caulk add payload/cache handling, and
 * duplicate job-number guard tests.
 *
 * COMMON FAILURE MODES:
 * Re-resolving canonical jobId payloads by jobNumber, accepting mismatched
 * jobId/jobNumber payloads, skipping requirement ownership validation by
 * selected job_id, or patching same-number legacy caches after canonical add.
 */

create or replace function public.api_acl_allocations_caulk_add(
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
  v_job app.jobs;
  v_product app.caulk_products;
  v_requirement app.job_caulk_requirements;
  v_allocation_id text := app_api.create_log_id();
  v_allocation_row_id uuid := gen_random_uuid();
  v_job_number text := app_api.require_job_number_digits(p_payload->>'jobNumber', 'Job ID number');
  v_job_id_text text := app_api.trim_text(p_payload->>'jobId');
  v_has_job_id boolean := v_job_id_text <> '';
  v_job_id uuid := null;
  v_requirement_id uuid := nullif(app_api.trim_text(p_payload->>'requirementId'), '')::uuid;
  v_product_id uuid := nullif(app_api.trim_text(p_payload->>'productId'), '')::uuid;
  v_warehouse text := app_api.caulk_require_warehouse(p_org_id, p_payload->>'warehouse');
  v_allocated_tubes integer := floor(nullif(app_api.trim_text(p_payload->>'allocatedTubes'), '')::numeric);
  v_actor text := app_api.trim_text(p_actor);
  v_notes text := app_api.trim_text(p_payload->>'notes');
  v_local_reservation jsonb := '{}'::jsonb;
  v_reserved_tubes integer := 0;
  v_shortage_tubes integer := 0;
  v_transfer_result jsonb := jsonb_build_object('warnings', '[]'::jsonb);
  v_planner_result jsonb := '{}'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'write');

  if v_product_id is null then
    perform app_api.raise_http(400, 'productId is required.');
  end if;

  if v_allocated_tubes is null or v_allocated_tubes <= 0 then
    perform app_api.raise_http(400, 'allocatedTubes must be greater than zero.');
  end if;

  if v_has_job_id then
    begin
      v_job_id := v_job_id_text::uuid;
    exception when others then
      perform app_api.raise_http(400, 'jobId must be a valid UUID.');
    end;

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
      perform app_api.raise_http(400, 'Job identity mismatch: selected job does not match jobNumber.');
    end if;

    if app_api.normalize_job_lifecycle_status(v_job.lifecycle_status::text) <> 'ACTIVE'::app.job_lifecycle_status then
      perform app_api.raise_http(400, format('Job %s is closed and cannot receive caulk allocations.', v_job.job_number));
    end if;
  else
    v_job := app_api.require_active_job_for_caulk(p_org_id, v_job_number);
  end if;

  select *
  into v_product
  from app.caulk_products p
  where p.org_id = p_org_id
    and p.id = v_product_id
  limit 1;

  if not found then
    perform app_api.raise_http(400, 'Product was not found.');
  end if;

  if v_requirement_id is not null then
    select *
    into v_requirement
    from app.job_caulk_requirements r
    where r.org_id = p_org_id
      and r.id = v_requirement_id
      and r.job_id = v_job.id
    for update;

    if not found then
      perform app_api.raise_http(400, 'RequirementId was not found for this job.');
    end if;
  end if;

  v_local_reservation := app_api.caulk_reserve_local_tubes(
    p_org_id,
    v_actor,
    v_product.id,
    v_warehouse,
    v_allocated_tubes,
    'JOB_ALLOCATE',
    format('Allocated caulk to job %s.', v_job.job_number),
    v_allocation_id,
    v_notes
  );
  v_reserved_tubes := coalesce((v_local_reservation->>'reservedTubes')::integer, 0);
  v_shortage_tubes := coalesce((v_local_reservation->>'shortageTubes')::integer, 0);

  insert into app.caulk_job_allocations (
    id,
    org_id,
    caulk_allocation_id,
    job_id,
    job_number,
    requirement_id,
    product_id,
    warehouse,
    allocated_tubes,
    reserved_tubes_remaining,
    checked_out_tubes_total,
    returned_unused_tubes_total,
    used_tubes_total,
    overage_tubes_total,
    status,
    created_at,
    created_by,
    updated_at,
    updated_by,
    notes
  )
  values (
    v_allocation_row_id,
    p_org_id,
    v_allocation_id,
    v_job.id,
    v_job.job_number,
    v_requirement_id,
    v_product.id,
    v_warehouse,
    v_allocated_tubes,
    v_reserved_tubes,
    0,
    0,
    0,
    0,
    'ACTIVE',
    now(),
    v_actor,
    now(),
    v_actor,
    v_notes
  );

  v_transfer_result := app_api.caulk_start_pending_transfer(
    p_org_id,
    v_actor,
    v_allocation_row_id,
    v_allocation_id,
    v_job.id,
    v_job.job_number,
    v_product.id,
    p_payload->>'transferFromWarehouse',
    v_warehouse,
    v_shortage_tubes,
    v_notes
  );

  v_warnings := coalesce(v_transfer_result->'warnings', '[]'::jsonb);
  v_planner_result := app_api.reconcile_auto_planned_allocations(
    p_org_id,
    v_actor,
    jsonb_build_object(
      'jobIds', jsonb_build_array(v_job.id),
      'jobNumbers', jsonb_build_array(v_job.job_number),
      'caulkProductWarehousePairs',
      jsonb_build_array(
        jsonb_build_object(
          'productId', v_product.id,
          'warehouse', v_warehouse
        )
      )
    )
  );
  v_warnings := v_warnings || coalesce(v_planner_result->'warnings', '[]'::jsonb);

  return jsonb_build_object(
    'jobId', v_job.id::text,
    'jobNumber', v_job.job_number,
    'caulkAllocationId', v_allocation_id,
    'warnings', v_warnings
  );
end;
$$;

select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_add(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_add(uuid, text, jsonb)', 'service_role');
