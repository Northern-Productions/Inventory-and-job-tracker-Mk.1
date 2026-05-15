/*
 * Phase 3B-3p: complete job jobId-scoped guarded transition.
 *
 * PURPOSE:
 * Let complete-job cancel active caulk allocations by selected job_id on
 * canonical paths while preserving legacy jobNumber-only cancellation.
 *
 * AFFECTS:
 * public.api_acl_jobs_cancel_caulk_allocations and a new app_api helper used
 * only when a canonical jobId is supplied.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * backend completeJob, Edge completeJob, complete-job cache invalidation, and
 * duplicate-number readiness tests.
 */

create or replace function app_api.cancel_active_caulk_allocations_for_job_id(
  p_org_id uuid,
  p_actor text,
  p_job_id uuid,
  p_job_number text,
  p_reason text,
  p_fail_on_open_checkouts boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_job app.jobs;
  v_entry app.caulk_job_allocations;
  v_actor text := app_api.trim_text(p_actor);
  v_payload_job_number text := app_api.trim_text(p_job_number);
  v_job_number text;
  v_reason text;
  v_pending_transfer_id text := '';
  v_open_checkout_count integer := 0;
  v_cancelled_count integer := 0;
  v_released_reserved_tubes integer := 0;
begin
  select *
  into v_job
  from app.jobs j
  where j.org_id = p_org_id
    and j.id = p_job_id
  for update;

  if not found then
    perform app_api.raise_http(404, format('Job %s was not found.', p_job_id));
  end if;

  if v_payload_job_number <> ''
     and upper(v_payload_job_number) <> upper(app_api.trim_text(v_job.job_number)) then
    perform app_api.raise_http(400, 'jobId does not match jobNumber.');
  end if;

  v_job_number := v_job.job_number;
  v_reason := coalesce(nullif(app_api.trim_text(p_reason), ''), format('Cancelled job %s.', v_job_number));

  select count(*)
  into v_open_checkout_count
  from app.caulk_job_checkouts c
  join app.caulk_job_allocations a
    on a.id = c.caulk_allocation_id
   and a.org_id = c.org_id
  where c.org_id = p_org_id
    and a.job_id = v_job.id
    and c.status = 'OPEN'
    and a.status = 'ACTIVE';

  if p_fail_on_open_checkouts and v_open_checkout_count > 0 then
    perform app_api.raise_http(
      400,
      format(
        'Job %s cannot be closed while %s caulk checkout%s remain open.',
        v_job_number,
        v_open_checkout_count,
        case when v_open_checkout_count = 1 then '' else 's' end
      )
    );
  end if;

  for v_entry in
    select *
    from app.caulk_job_allocations a
    where a.org_id = p_org_id
      and a.job_id = v_job.id
      and a.status = 'ACTIVE'
    for update
  loop
    select t.transfer_id
    into v_pending_transfer_id
    from app.caulk_transfers t
    where t.org_id = p_org_id
      and t.caulk_allocation_id = v_entry.id
      and t.status = 'PENDING'
    order by t.created_at desc, t.id desc
    limit 1
    for update;

    if coalesce(v_pending_transfer_id, '') <> '' then
      perform app_api.caulk_cancel_pending_transfer_internal(
        p_org_id,
        v_actor,
        v_pending_transfer_id,
        format(
          'Cancelled pending transfer %s while closing job %s.',
          v_pending_transfer_id,
          v_job_number
        )
      );
    end if;

    if v_entry.reserved_tubes_remaining > 0 then
      perform app_api.caulk_apply_stock_delta(
        p_org_id,
        v_actor,
        v_entry.product_id,
        v_entry.warehouse,
        'JOB_ALLOCATION_CANCEL_RETURN',
        v_entry.reserved_tubes_remaining,
        v_reason,
        '',
        v_entry.caulk_allocation_id,
        v_reason
      );
      v_released_reserved_tubes := v_released_reserved_tubes + v_entry.reserved_tubes_remaining;
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
    where id = v_entry.id
      and org_id = p_org_id;

    v_cancelled_count := v_cancelled_count + 1;
  end loop;

  return jsonb_build_object(
    'jobId', v_job.id::text,
    'jobNumber', v_job_number,
    'openCheckoutCount', v_open_checkout_count,
    'cancelledAllocationCount', v_cancelled_count,
    'releasedReservedTubes', v_released_reserved_tubes
  );
end;
$$;

create or replace function public.api_acl_jobs_cancel_caulk_allocations(
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
  v_job_id_text text := app_api.trim_text(v_payload->>'jobId');
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'write');

  if v_job_id_text <> '' then
    if v_job_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      perform app_api.raise_http(400, 'jobId must be a valid UUID.');
    end if;

    return app_api.cancel_active_caulk_allocations_for_job_id(
      p_org_id,
      p_actor,
      v_job_id_text::uuid,
      v_payload->>'jobNumber',
      coalesce(nullif(app_api.trim_text(v_payload->>'reason'), ''), 'Job completed.'),
      true
    );
  end if;

  return app_api.cancel_active_caulk_allocations_for_job(
    p_org_id,
    p_actor,
    v_payload->>'jobNumber',
    coalesce(nullif(app_api.trim_text(v_payload->>'reason'), ''), 'Job completed.'),
    true
  );
end;
$$;

select app_api.grant_execute_if_exists('app_api.cancel_active_caulk_allocations_for_job_id(uuid, text, uuid, text, text, boolean)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.cancel_active_caulk_allocations_for_job_id(uuid, text, uuid, text, text, boolean)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_jobs_cancel_caulk_allocations(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_jobs_cancel_caulk_allocations(uuid, text, jsonb)', 'service_role');
