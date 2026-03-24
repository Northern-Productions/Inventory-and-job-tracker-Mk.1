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
  v_actor text := app_api.trim_text(p_actor);
  v_caulk_checkout_id text := app_api.require_text(p_payload->>'caulkCheckoutId', 'CaulkCheckoutId');
  v_unused_loose_tubes integer := floor(nullif(app_api.trim_text(p_payload->>'unusedLooseTubes'), '')::numeric);
  v_unused_cases integer := floor(nullif(app_api.trim_text(p_payload->>'unusedCases'), '')::numeric);
  v_unused_tubes_legacy integer := floor(nullif(app_api.trim_text(p_payload->>'unusedTubes'), '')::numeric);
  v_tubes_per_case integer;
  v_total_returned_tubes integer;
  v_used_tubes integer;
  v_notes text := app_api.trim_text(p_payload->>'notes');
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
      format('Checked in unused caulk from allocation %s.', v_allocation.caulk_allocation_id),
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

  return jsonb_build_object(
    'jobNumber', v_allocation.job_number,
    'caulkAllocationId', v_allocation.caulk_allocation_id,
    'caulkCheckoutId', v_checkout.caulk_checkout_id,
    'warnings', '[]'::jsonb
  );
end;
$$;
