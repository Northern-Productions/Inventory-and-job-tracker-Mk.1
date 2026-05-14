create or replace function public.api_acl_allocations_caulk_checkout(
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
  v_checkout_id text := app_api.create_log_id();
  v_actor text := app_api.trim_text(p_actor);
  v_caulk_allocation_id text := app_api.require_text(p_payload->>'caulkAllocationId', 'CaulkAllocationId');
  v_checkout_tubes integer := floor(nullif(app_api.trim_text(p_payload->>'checkoutTubes'), '')::numeric);
  v_pending_transfer_id text := '';
  v_open_checkout_count integer := 0;
  v_shortage integer := 0;
  v_consume_reserved integer;
  v_overage integer;
  v_notes text := app_api.trim_text(p_payload->>'notes');
  v_planner_result jsonb := '{}'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'write');

  if v_checkout_tubes is null or v_checkout_tubes <= 0 then
    perform app_api.raise_http(400, 'checkoutTubes must be greater than zero.');
  end if;

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

  if app_api.normalize_job_lifecycle_status(v_job.lifecycle_status::text) <> 'ACTIVE'::app.job_lifecycle_status then
    perform app_api.raise_http(400, format('Job %s is closed and cannot receive caulk allocations.', v_job.job_number));
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
    perform app_api.raise_http(
      400,
      format('Receive or cancel transfer %s before checking out this allocation.', v_pending_transfer_id)
    );
  end if;

  v_shortage := greatest(
    v_allocation.allocated_tubes
      - v_allocation.checked_out_tubes_total
      - v_allocation.reserved_tubes_remaining,
    0
  );
  if v_shortage > 0 then
    perform app_api.raise_http(
      400,
      format(
        '%s still needs %s tube%s transferred in before this allocation can be checked out.',
        v_allocation.warehouse,
        v_shortage,
        case when v_shortage = 1 then '' else 's' end
      )
    );
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
        'Caulk allocation %s already has %s open checkout%s and cannot be checked out again until that cycle is closed.',
        v_caulk_allocation_id,
        v_open_checkout_count,
        case when v_open_checkout_count = 1 then '' else 's' end
      )
    );
  end if;

  v_consume_reserved := least(v_checkout_tubes, v_allocation.reserved_tubes_remaining);
  v_overage := greatest(v_checkout_tubes - v_consume_reserved, 0);

  if v_overage > 0 then
    perform app_api.caulk_apply_stock_delta(
      p_org_id,
      v_actor,
      v_allocation.product_id,
      v_allocation.warehouse,
      'JOB_CHECKOUT_OVERAGE',
      -v_overage,
      format('Over-checkout on caulk allocation %s.', v_allocation.caulk_allocation_id),
      '',
      v_allocation.caulk_allocation_id,
      v_notes
    );
  end if;

  insert into app.caulk_job_checkouts (
    id,
    org_id,
    caulk_checkout_id,
    caulk_allocation_id,
    job_number,
    product_id,
    warehouse,
    checkout_tubes,
    overage_tubes,
    status,
    checked_out_at,
    checked_out_by,
    notes
  )
  values (
    gen_random_uuid(),
    p_org_id,
    v_checkout_id,
    v_allocation.id,
    v_job.job_number,
    v_allocation.product_id,
    v_allocation.warehouse,
    v_checkout_tubes,
    v_overage,
    'OPEN',
    now(),
    v_actor,
    v_notes
  );

  update app.caulk_job_allocations
  set
    reserved_tubes_remaining = greatest(v_allocation.reserved_tubes_remaining - v_consume_reserved, 0),
    checked_out_tubes_total = v_allocation.checked_out_tubes_total + v_checkout_tubes,
    overage_tubes_total = v_allocation.overage_tubes_total + v_overage,
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
    'caulkCheckoutId', v_checkout_id,
    'productId', v_allocation.product_id::text,
    'warehouse', v_allocation.warehouse,
    'warnings', v_warnings
  );
end;
$$;

create or replace function public.api_acl_allocations_caulk_checkin(
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
  v_checkout app.caulk_job_checkouts;
  v_allocation app.caulk_job_allocations;
  v_job app.jobs;
  v_actor text := app_api.trim_text(p_actor);
  v_caulk_checkout_id text := app_api.require_text(p_payload->>'caulkCheckoutId', 'CaulkCheckoutId');
  v_unused_loose_tubes integer := floor(nullif(app_api.trim_text(p_payload->>'unusedLooseTubes'), '')::numeric);
  v_unused_cases integer := floor(nullif(app_api.trim_text(p_payload->>'unusedCases'), '')::numeric);
  v_unused_tubes_legacy integer := floor(nullif(app_api.trim_text(p_payload->>'unusedTubes'), '')::numeric);
  v_tubes_per_case integer;
  v_total_returned_tubes integer;
  v_used_tubes integer;
  v_notes text := app_api.trim_text(p_payload->>'notes');
  v_planner_result jsonb := '{}'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'write');

  select *
  into v_checkout
  from app.caulk_job_checkouts c
  where c.org_id = p_org_id
    and c.caulk_checkout_id = v_caulk_checkout_id
  for update;

  if not found then
    perform app_api.raise_http(404, format('Caulk checkout %s was not found.', v_caulk_checkout_id));
  end if;

  if v_checkout.status <> 'OPEN' then
    perform app_api.raise_http(400, format('Caulk checkout %s is already closed.', v_caulk_checkout_id));
  end if;

  select *
  into v_allocation
  from app.caulk_job_allocations a
  where a.org_id = p_org_id
    and a.id = v_checkout.caulk_allocation_id
  for update;

  if not found then
    perform app_api.raise_http(404, 'Parent caulk allocation was not found.');
  end if;

  if v_allocation.status <> 'ACTIVE' then
    perform app_api.raise_http(400, 'Parent caulk allocation is no longer active.');
  end if;

  select *
  into v_job
  from app.jobs j
  where j.org_id = p_org_id
    and j.id = v_allocation.job_id
  for update;

  if not found then
    perform app_api.raise_http(404, format('Job for caulk checkout %s was not found.', v_caulk_checkout_id));
  end if;

  select p.tubes_per_case
  into v_tubes_per_case
  from app.caulk_products p
  where p.org_id = p_org_id
    and p.id = v_allocation.product_id;

  if v_tubes_per_case is null or v_tubes_per_case <= 0 then
    perform app_api.raise_http(400, 'This caulk product is missing a valid tubesPerCase value.');
  end if;

  if v_unused_loose_tubes is null and v_unused_cases is null then
    if v_unused_tubes_legacy is null or v_unused_tubes_legacy < 0 then
      perform app_api.raise_http(400, 'unusedTubes must be zero or greater.');
    end if;

    v_total_returned_tubes := v_unused_tubes_legacy;
  else
    v_unused_loose_tubes := coalesce(v_unused_loose_tubes, 0);
    v_unused_cases := coalesce(v_unused_cases, 0);

    if v_unused_loose_tubes < 0 then
      perform app_api.raise_http(400, 'unusedLooseTubes must be zero or greater.');
    end if;

    if v_unused_cases < 0 then
      perform app_api.raise_http(400, 'unusedCases must be zero or greater.');
    end if;

    if v_unused_loose_tubes >= v_tubes_per_case then
      perform app_api.raise_http(
        400,
        format('unusedLooseTubes must be less than tubesPerCase (%s).', v_tubes_per_case)
      );
    end if;

    v_total_returned_tubes := v_unused_loose_tubes + (v_unused_cases * v_tubes_per_case);
  end if;

  if v_total_returned_tubes > v_checkout.checkout_tubes then
    perform app_api.raise_http(400, 'Returned caulk cannot exceed checked-out tubes.');
  end if;

  v_used_tubes := v_checkout.checkout_tubes - v_total_returned_tubes;

  if v_total_returned_tubes > 0 then
    perform app_api.caulk_apply_stock_delta(
      p_org_id,
      v_actor,
      v_allocation.product_id,
      v_allocation.warehouse,
      'JOB_CHECKIN_UNUSED',
      v_total_returned_tubes,
      format('Checked in unused caulk from job %s.', v_job.job_number),
      '',
      v_allocation.caulk_allocation_id,
      v_notes
    );
  end if;

  update app.caulk_job_checkouts
  set
    status = 'CLOSED',
    checked_in_at = now(),
    checked_in_by = v_actor,
    unused_tubes = v_total_returned_tubes,
    used_tubes = v_used_tubes,
    notes = v_notes
  where id = v_checkout.id
    and org_id = p_org_id;

  update app.caulk_job_allocations
  set
    returned_unused_tubes_total = v_allocation.returned_unused_tubes_total + v_total_returned_tubes,
    used_tubes_total = v_allocation.used_tubes_total + v_used_tubes,
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
    'caulkCheckoutId', v_checkout.caulk_checkout_id,
    'productId', v_allocation.product_id::text,
    'warehouse', v_allocation.warehouse,
    'warnings', v_warnings
  );
end;
$$;

select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_checkout(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_checkin(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_checkout(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_checkin(uuid, text, jsonb)', 'service_role');
