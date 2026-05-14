/*
 * PURPOSE:
 * Makes caulk remove derive exact job IDs from the locked allocation row while
 * preserving the row-id remove payload and existing remove side effects.
 *
 * AFFECTS:
 * public.api_acl_allocations_caulk_remove, planner reconciliation scope, and
 * additive caulk remove response metadata.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * backend caulk allocation runtime, Supabase Edge mutationHandlers
 * /allocations/caulk/remove, frontend caulk remove cache handling, and
 * duplicate job-number guard tests.
 *
 * COMMON FAILURE MODES:
 * Re-resolving row-derived identity by jobNumber, dropping pending transfer
 * cancellation or reserved stock release, adding a new closed-job restriction,
 * or patching same-number legacy caches after a row-derived remove result.
 */

create or replace function public.api_acl_allocations_caulk_remove(
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
  v_allocation app.caulk_job_allocations;
  v_job app.jobs;
  v_open_checkout_count integer := 0;
  v_actor text := app_api.trim_text(p_actor);
  v_caulk_allocation_id text := app_api.require_text(p_payload->>'caulkAllocationId', 'CaulkAllocationId');
  v_reason text;
  v_released_reserved_tubes integer := 0;
  v_pending_transfer_id text := '';
  v_cancel_result jsonb := '{}'::jsonb;
  v_suppression_result jsonb := jsonb_build_object('suppressed', false);
  v_auto_planning_suppressed boolean := false;
  v_planner_result jsonb := '{}'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'write');

  select *
  into v_allocation
  from app.caulk_job_allocations a
  where a.org_id = p_org_id
    and a.caulk_allocation_id = v_caulk_allocation_id
  for update;

  if not found then
    perform app_api.raise_http(404, format('Caulk allocation %s was not found.', v_caulk_allocation_id));
  end if;

  if v_allocation.status <> 'ACTIVE' then
    perform app_api.raise_http(400, format('Caulk allocation %s is not active.', v_caulk_allocation_id));
  end if;

  select *
  into v_job
  from app.jobs j
  where j.org_id = p_org_id
    and j.id = v_allocation.job_id
  for update;

  if not found then
    perform app_api.raise_http(404, format('Job for caulk allocation %s was not found.', v_caulk_allocation_id));
  end if;

  select count(*)
  into v_open_checkout_count
  from app.caulk_job_checkouts c
  where c.org_id = p_org_id
    and c.caulk_allocation_id = v_allocation.id
    and c.status = 'OPEN';

  if v_open_checkout_count > 0 then
    perform app_api.raise_http(
      400,
      format(
        'Caulk allocation %s has %s open checkout%s. Check in first.',
        v_caulk_allocation_id,
        v_open_checkout_count,
        case when v_open_checkout_count = 1 then '' else 's' end
      )
    );
  end if;

  v_reason := coalesce(
    nullif(app_api.trim_text(p_payload->>'reason'), ''),
    format('Removed from job %s.', v_job.job_number)
  );

  if coalesce(v_allocation.allocation_source::text, 'MANUAL') = 'AUTO_PLANNED' then
    v_suppression_result := app_api.record_auto_planned_caulk_allocation_suppression(
      p_org_id,
      v_actor,
      v_allocation.caulk_allocation_id,
      v_reason
    );
    v_auto_planning_suppressed := coalesce((v_suppression_result->>'suppressed')::boolean, false);
  end if;

  select t.transfer_id
  into v_pending_transfer_id
  from app.caulk_transfers t
  where t.org_id = p_org_id
    and t.caulk_allocation_id = v_allocation.id
    and t.status = 'PENDING'
  order by t.created_at desc, t.id desc
  limit 1
  for update;

  if coalesce(v_pending_transfer_id, '') <> '' then
    v_cancel_result := app_api.caulk_cancel_pending_transfer_internal(
      p_org_id,
      v_actor,
      v_pending_transfer_id,
      format(
        'Cancelled pending transfer %s while removing allocation %s.',
        v_pending_transfer_id,
        v_caulk_allocation_id
      )
    );
    v_warnings := v_warnings || coalesce(v_cancel_result->'warnings', '[]'::jsonb);
  end if;

  if v_allocation.reserved_tubes_remaining > 0 then
    perform app_api.caulk_apply_stock_delta(
      p_org_id,
      v_actor,
      v_allocation.product_id,
      v_allocation.warehouse,
      'JOB_ALLOCATION_CANCEL_RETURN',
      v_allocation.reserved_tubes_remaining,
      v_reason,
      '',
      v_allocation.caulk_allocation_id,
      v_reason
    );
    v_released_reserved_tubes := v_allocation.reserved_tubes_remaining;
  end if;

  update app.caulk_job_allocations
  set
    status = 'CANCELLED',
    reserved_tubes_remaining = 0,
    resolved_at = now(),
    resolved_by = v_actor,
    notes = v_reason,
    updated_at = now(),
    updated_by = v_actor
  where id = v_allocation.id
    and org_id = p_org_id;

  v_planner_result := app_api.reconcile_auto_planned_allocations(
    p_org_id,
    v_actor,
    jsonb_build_object(
      'jobIds', jsonb_build_array(v_job.id),
      'jobNumbers', jsonb_build_array(v_job.job_number),
      'caulkProductWarehousePairs',
      jsonb_build_array(
        jsonb_build_object(
          'productId', v_allocation.product_id,
          'warehouse', v_allocation.warehouse
        )
      )
    )
  );
  v_warnings := v_warnings || coalesce(v_planner_result->'warnings', '[]'::jsonb);

  return jsonb_build_object(
    'jobId', v_job.id::text,
    'jobNumber', v_job.job_number,
    'caulkAllocationId', v_allocation.caulk_allocation_id,
    'releasedReservedTubes', v_released_reserved_tubes,
    'autoPlanningSuppressed', v_auto_planning_suppressed,
    'warnings', v_warnings
  );
end;
$$;

select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_remove(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_remove(uuid, text, jsonb)', 'service_role');
