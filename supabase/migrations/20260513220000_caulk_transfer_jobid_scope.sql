/*
 * PURPOSE:
 * Makes caulk transfer receive/cancel derive exact job IDs from the locked
 * transfer allocation row while preserving transferId-only payloads and
 * existing transfer side effects.
 *
 * AFFECTS:
 * public.api_acl_caulk_transfer_receive, public.api_acl_caulk_transfer_cancel,
 * transfer response metadata, and planner reconciliation scope.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * backend caulk allocation runtime, Supabase Edge mutationHandlers
 * /caulk/transfers/receive and /caulk/transfers/cancel, frontend caulk
 * transfer cache handling, and duplicate job-number guard tests.
 *
 * COMMON FAILURE MODES:
 * Inferring identity from jobNumber, moving planner reconciliation into shared
 * internal cancel logic so caulk remove double-runs planner, changing
 * transferId-only payloads, or adding a new closed-job/active-allocation guard
 * to transfer cancel.
 */

create or replace function app_api.caulk_cancel_pending_transfer_internal(
  p_org_id uuid,
  p_actor text,
  p_transfer_id text,
  p_reason text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_transfer app.caulk_transfers;
  v_allocation app.caulk_job_allocations;
  v_job app.jobs;
  v_actor text := app_api.trim_text(p_actor);
  v_pending_tubes integer := 0;
  v_reason text;
begin
  select *
  into v_transfer
  from app.caulk_transfers t
  where t.org_id = p_org_id
    and t.transfer_id = app_api.require_text(p_transfer_id, 'TransferId')
  for update;

  if not found then
    perform app_api.raise_http(404, 'Caulk transfer not found.');
  end if;

  if v_transfer.status <> 'PENDING' then
    perform app_api.raise_http(
      400,
      format('Caulk transfer %s is already %s.', v_transfer.transfer_id, lower(v_transfer.status::text))
    );
  end if;

  select *
  into v_allocation
  from app.caulk_job_allocations a
  where a.org_id = p_org_id
    and a.id = v_transfer.caulk_allocation_id
  for update;

  if not found then
    perform app_api.raise_http(404, 'Parent caulk allocation was not found.');
  end if;

  select *
  into v_job
  from app.jobs j
  where j.org_id = p_org_id
    and j.id = v_allocation.job_id
  for update;

  if not found then
    perform app_api.raise_http(404, format('Job for caulk transfer %s was not found.', v_transfer.transfer_id));
  end if;

  v_pending_tubes := coalesce(v_transfer.pending_tubes, 0);
  v_reason := coalesce(
    nullif(app_api.trim_text(p_reason), ''),
    format(
      'Cancelled caulk transfer from %s to %s for job %s.',
      v_transfer.source_warehouse,
      v_transfer.destination_warehouse,
      v_job.job_number
    )
  );

  if v_pending_tubes > 0 then
    perform app_api.caulk_apply_stock_delta(
      p_org_id,
      v_actor,
      v_transfer.product_id,
      v_transfer.source_warehouse,
      'TRANSFER_IN',
      v_pending_tubes,
      v_reason,
      v_transfer.transfer_id,
      '',
      v_reason
    );
  end if;

  perform app_api.caulk_save_transfer_record(
    p_org_id,
    v_transfer.transfer_id,
    v_transfer.caulk_allocation_id,
    v_job.id,
    v_job.job_number,
    v_transfer.product_id,
    v_transfer.source_warehouse,
    v_transfer.destination_warehouse,
    v_transfer.pending_tubes,
    'CANCELLED',
    v_reason,
    v_transfer.created_at,
    v_transfer.created_by,
    v_transfer.received_at,
    v_transfer.received_by,
    now(),
    v_actor,
    now(),
    v_actor
  );

  return jsonb_build_object(
    'jobId', v_job.id::text,
    'jobNumber', v_job.job_number,
    'caulkAllocationId', v_allocation.caulk_allocation_id,
    'transferId', v_transfer.transfer_id,
    'productId', v_transfer.product_id::text,
    'sourceWarehouse', v_transfer.source_warehouse,
    'destinationWarehouse', v_transfer.destination_warehouse,
    'warnings',
      case
        when v_pending_tubes > 0 then jsonb_build_array(
          format(
            'Cancelled transfer %s and returned %s tube%s to %s.',
            v_transfer.transfer_id,
            v_pending_tubes,
            case when v_pending_tubes = 1 then '' else 's' end,
            v_transfer.source_warehouse
          )
        )
        else '[]'::jsonb
      end
  );
end;
$$;

create or replace function app_api.caulk_receive_pending_transfer_internal(
  p_org_id uuid,
  p_actor text,
  p_transfer_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_transfer app.caulk_transfers;
  v_allocation app.caulk_job_allocations;
  v_job app.jobs;
  v_actor text := app_api.trim_text(p_actor);
  v_pending_tubes integer := 0;
  v_destination_warehouse text := '';
begin
  select *
  into v_transfer
  from app.caulk_transfers t
  where t.org_id = p_org_id
    and t.transfer_id = app_api.require_text(p_transfer_id, 'TransferId')
  for update;

  if not found then
    perform app_api.raise_http(404, 'Caulk transfer not found.');
  end if;

  if v_transfer.status <> 'PENDING' then
    perform app_api.raise_http(
      400,
      format('Caulk transfer %s is already %s.', v_transfer.transfer_id, lower(v_transfer.status::text))
    );
  end if;

  select *
  into v_allocation
  from app.caulk_job_allocations a
  where a.org_id = p_org_id
    and a.id = v_transfer.caulk_allocation_id
  for update;

  if not found then
    perform app_api.raise_http(404, 'Parent caulk allocation was not found.');
  end if;

  select *
  into v_job
  from app.jobs j
  where j.org_id = p_org_id
    and j.id = v_allocation.job_id
  for update;

  if not found then
    perform app_api.raise_http(404, format('Job for caulk transfer %s was not found.', v_transfer.transfer_id));
  end if;

  if v_allocation.status <> 'ACTIVE' then
    perform app_api.raise_http(400, 'Parent caulk allocation is no longer active.');
  end if;

  v_destination_warehouse := app_api.caulk_seed_stock_row(
    p_org_id,
    p_actor,
    v_transfer.product_id,
    v_transfer.destination_warehouse
  );
  v_pending_tubes := coalesce(v_transfer.pending_tubes, 0);

  if v_pending_tubes > 0 then
    perform app_api.caulk_apply_stock_delta(
      p_org_id,
      v_actor,
      v_transfer.product_id,
      v_destination_warehouse,
      'TRANSFER_IN',
      v_pending_tubes,
      format(
        'Received caulk transfer into %s for job %s.',
        v_destination_warehouse,
        v_job.job_number
      ),
      v_transfer.transfer_id,
      v_allocation.caulk_allocation_id,
      v_transfer.notes
    );

    perform app_api.caulk_apply_stock_delta(
      p_org_id,
      v_actor,
      v_transfer.product_id,
      v_destination_warehouse,
      'JOB_ALLOCATE_EDIT_INC',
      -v_pending_tubes,
      format(
        'Received pending caulk transfer for allocation %s.',
        v_allocation.caulk_allocation_id
      ),
      '',
      v_allocation.caulk_allocation_id,
      v_transfer.notes
    );
  end if;

  update app.caulk_job_allocations
  set
    reserved_tubes_remaining = reserved_tubes_remaining + v_pending_tubes,
    updated_at = now(),
    updated_by = v_actor
  where id = v_allocation.id
    and org_id = p_org_id;

  perform app_api.caulk_save_transfer_record(
    p_org_id,
    v_transfer.transfer_id,
    v_transfer.caulk_allocation_id,
    v_job.id,
    v_job.job_number,
    v_transfer.product_id,
    v_transfer.source_warehouse,
    v_transfer.destination_warehouse,
    v_transfer.pending_tubes,
    'RECEIVED',
    v_transfer.notes,
    v_transfer.created_at,
    v_transfer.created_by,
    now(),
    v_actor,
    v_transfer.cancelled_at,
    v_transfer.cancelled_by,
    now(),
    v_actor
  );

  return jsonb_build_object(
    'jobId', v_job.id::text,
    'jobNumber', v_job.job_number,
    'caulkAllocationId', v_allocation.caulk_allocation_id,
    'transferId', v_transfer.transfer_id,
    'productId', v_transfer.product_id::text,
    'sourceWarehouse', v_transfer.source_warehouse,
    'destinationWarehouse', v_destination_warehouse,
    'warnings', jsonb_build_array(
      format(
        'Received %s tube%s into %s and reserved it for allocation %s.',
        v_pending_tubes,
        case when v_pending_tubes = 1 then '' else 's' end,
        v_destination_warehouse,
        v_allocation.caulk_allocation_id
      )
    )
  );
end;
$$;

create or replace function public.api_acl_caulk_transfer_receive(
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
  v_result jsonb;
  v_planner_result jsonb := '{}'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');
  v_result := app_api.caulk_receive_pending_transfer_internal(
    p_org_id,
    p_actor,
    p_payload->>'transferId'
  );

  v_planner_result := app_api.reconcile_auto_planned_allocations(
    p_org_id,
    p_actor,
    jsonb_build_object(
      'jobIds', jsonb_build_array(v_result->>'jobId'),
      'jobNumbers', jsonb_build_array(v_result->>'jobNumber'),
      'caulkProductWarehousePairs',
      jsonb_build_array(
        jsonb_build_object(
          'productId', v_result->>'productId',
          'warehouse', v_result->>'sourceWarehouse'
        ),
        jsonb_build_object(
          'productId', v_result->>'productId',
          'warehouse', v_result->>'destinationWarehouse'
        )
      )
    )
  );
  v_warnings := coalesce(v_result->'warnings', '[]'::jsonb) || coalesce(v_planner_result->'warnings', '[]'::jsonb);
  return jsonb_set(v_result, '{warnings}', v_warnings, true);
end;
$$;

create or replace function public.api_acl_caulk_transfer_cancel(
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
  v_result jsonb;
  v_planner_result jsonb := '{}'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');
  v_result := app_api.caulk_cancel_pending_transfer_internal(
    p_org_id,
    p_actor,
    p_payload->>'transferId',
    p_payload->>'reason'
  );

  v_planner_result := app_api.reconcile_auto_planned_allocations(
    p_org_id,
    p_actor,
    jsonb_build_object(
      'jobIds', jsonb_build_array(v_result->>'jobId'),
      'jobNumbers', jsonb_build_array(v_result->>'jobNumber'),
      'caulkProductWarehousePairs',
      jsonb_build_array(
        jsonb_build_object(
          'productId', v_result->>'productId',
          'warehouse', v_result->>'sourceWarehouse'
        ),
        jsonb_build_object(
          'productId', v_result->>'productId',
          'warehouse', v_result->>'destinationWarehouse'
        )
      )
    )
  );
  v_warnings := coalesce(v_result->'warnings', '[]'::jsonb) || coalesce(v_planner_result->'warnings', '[]'::jsonb);
  return jsonb_set(v_result, '{warnings}', v_warnings, true);
end;
$$;

select app_api.grant_execute_if_exists('public.api_acl_caulk_transfer_receive(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_caulk_transfer_cancel(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_caulk_transfer_receive(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_caulk_transfer_cancel(uuid, text, jsonb)', 'service_role');
