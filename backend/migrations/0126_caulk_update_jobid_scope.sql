create or replace function public.api_acl_allocations_caulk_update(
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
  v_pending_transfer_id text := '';
  v_actor text := app_api.trim_text(p_actor);
  v_caulk_allocation_id text := app_api.require_text(p_payload->>'caulkAllocationId', 'CaulkAllocationId');
  v_has_product_id boolean := p_payload ? 'productId';
  v_has_warehouse boolean := p_payload ? 'warehouse';
  v_has_allocated_tubes boolean := p_payload ? 'allocatedTubes';
  v_has_notes boolean := p_payload ? 'notes';
  v_has_transfer_selection boolean := app_api.trim_text(p_payload->>'transferFromWarehouse') <> '';
  v_has_material_edit boolean := false;
  v_next_product_id uuid;
  v_next_warehouse text;
  v_next_allocated_tubes integer;
  v_next_notes text;
  v_checked_out_tubes integer := 0;
  v_reserved_tubes integer := 0;
  v_allocated_tubes integer := 0;
  v_currently_covered integer := 0;
  v_additional_coverage_needed integer := 0;
  v_release_tubes integer := 0;
  v_next_reserved_tubes integer := 0;
  v_local_reservation jsonb := '{}'::jsonb;
  v_transfer_result jsonb := jsonb_build_object('warnings', '[]'::jsonb);
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

  v_has_material_edit := v_has_product_id or v_has_warehouse or v_has_allocated_tubes or v_has_transfer_selection;
  if coalesce(v_pending_transfer_id, '') <> '' and v_has_material_edit then
    perform app_api.raise_http(
      400,
      format('Receive or cancel transfer %s before editing this allocation.', v_pending_transfer_id)
    );
  end if;

  v_next_product_id := case
    when v_has_product_id and app_api.trim_text(p_payload->>'productId') <> ''
      then nullif(app_api.trim_text(p_payload->>'productId'), '')::uuid
    else v_allocation.product_id
  end;
  v_next_warehouse := case
    when v_has_warehouse
      then app_api.caulk_require_warehouse(p_org_id, p_payload->>'warehouse')
    else v_allocation.warehouse
  end;
  v_next_allocated_tubes := case
    when v_has_allocated_tubes
      then floor(nullif(app_api.trim_text(p_payload->>'allocatedTubes'), '')::numeric)
    else v_allocation.allocated_tubes
  end;
  v_next_notes := case
    when v_has_notes then app_api.trim_text(p_payload->>'notes')
    else v_allocation.notes
  end;

  if v_next_allocated_tubes is null or v_next_allocated_tubes <= 0 then
    perform app_api.raise_http(400, 'allocatedTubes must be greater than zero.');
  end if;

  if v_next_product_id <> v_allocation.product_id then
    perform 1
    from app.caulk_products p
    where p.org_id = p_org_id
      and p.id = v_next_product_id;
    if not found then
      perform app_api.raise_http(400, 'Product was not found.');
    end if;
  end if;

  v_checked_out_tubes := coalesce(v_allocation.checked_out_tubes_total, 0);
  v_reserved_tubes := coalesce(v_allocation.reserved_tubes_remaining, 0);
  v_allocated_tubes := coalesce(v_allocation.allocated_tubes, 0);

  if v_checked_out_tubes > 0 then
    if v_next_product_id <> v_allocation.product_id or v_next_warehouse <> v_allocation.warehouse then
      perform app_api.raise_http(400, 'Product and warehouse cannot be changed after checkout starts.');
    end if;
    if v_next_allocated_tubes < v_allocated_tubes then
      perform app_api.raise_http(400, 'allocatedTubes can only increase after checkout starts.');
    end if;
  end if;

  if v_next_product_id <> v_allocation.product_id or v_next_warehouse <> v_allocation.warehouse then
    if v_checked_out_tubes > 0 then
      perform app_api.raise_http(400, 'Product and warehouse cannot be changed after checkout starts.');
    end if;

    if v_reserved_tubes > 0 then
      perform app_api.caulk_apply_stock_delta(
        p_org_id,
        v_actor,
        v_allocation.product_id,
        v_allocation.warehouse,
        'JOB_ALLOCATE_EDIT_DEC',
        v_reserved_tubes,
        format('Edited caulk allocation %s.', v_allocation.caulk_allocation_id),
        '',
        v_allocation.caulk_allocation_id,
        'Released prior reserved tubes during edit.'
      );
    end if;

    v_local_reservation := app_api.caulk_reserve_local_tubes(
      p_org_id,
      v_actor,
      v_next_product_id,
      v_next_warehouse,
      v_next_allocated_tubes,
      'JOB_ALLOCATE_EDIT_INC',
      format('Edited caulk allocation %s.', v_allocation.caulk_allocation_id),
      v_allocation.caulk_allocation_id,
      v_next_notes
    );

    update app.caulk_job_allocations
    set
      product_id = v_next_product_id,
      warehouse = v_next_warehouse,
      allocated_tubes = v_next_allocated_tubes,
      reserved_tubes_remaining = coalesce((v_local_reservation->>'reservedTubes')::integer, 0),
      notes = v_next_notes,
      updated_at = now(),
      updated_by = v_actor
    where id = v_allocation.id
      and org_id = p_org_id;

    v_transfer_result := app_api.caulk_start_pending_transfer(
      p_org_id,
      v_actor,
      v_allocation.id,
      v_allocation.caulk_allocation_id,
      v_job.id,
      v_job.job_number,
      v_next_product_id,
      p_payload->>'transferFromWarehouse',
      v_next_warehouse,
      coalesce((v_local_reservation->>'shortageTubes')::integer, 0),
      v_next_notes
    );
  else
    v_currently_covered := v_reserved_tubes + v_checked_out_tubes;
    v_next_reserved_tubes := v_reserved_tubes;

    if v_next_allocated_tubes < v_checked_out_tubes then
      perform app_api.raise_http(400, 'allocatedTubes cannot drop below already checked-out amount.');
    end if;

    if v_next_allocated_tubes > v_currently_covered then
      v_additional_coverage_needed := v_next_allocated_tubes - v_currently_covered;

      v_local_reservation := app_api.caulk_reserve_local_tubes(
        p_org_id,
        v_actor,
        v_allocation.product_id,
        v_allocation.warehouse,
        v_additional_coverage_needed,
        'JOB_ALLOCATE_EDIT_INC',
        format('Increased caulk allocation %s.', v_allocation.caulk_allocation_id),
        v_allocation.caulk_allocation_id,
        v_next_notes
      );

      v_next_reserved_tubes := v_next_reserved_tubes + coalesce((v_local_reservation->>'reservedTubes')::integer, 0);
      v_transfer_result := app_api.caulk_start_pending_transfer(
        p_org_id,
        v_actor,
        v_allocation.id,
        v_allocation.caulk_allocation_id,
        v_job.id,
        v_job.job_number,
        v_allocation.product_id,
        p_payload->>'transferFromWarehouse',
        v_allocation.warehouse,
        coalesce((v_local_reservation->>'shortageTubes')::integer, 0),
        v_next_notes
      );
    elsif v_next_allocated_tubes < v_currently_covered then
      v_release_tubes := least(v_reserved_tubes, v_currently_covered - v_next_allocated_tubes);
      if v_release_tubes > 0 then
        perform app_api.caulk_apply_stock_delta(
          p_org_id,
          v_actor,
          v_allocation.product_id,
          v_allocation.warehouse,
          'JOB_ALLOCATE_EDIT_DEC',
          v_release_tubes,
          format('Reduced caulk allocation %s.', v_allocation.caulk_allocation_id),
          '',
          v_allocation.caulk_allocation_id,
          v_next_notes
        );
        v_next_reserved_tubes := greatest(v_reserved_tubes - v_release_tubes, 0);
      end if;
    end if;

    update app.caulk_job_allocations
    set
      allocated_tubes = v_next_allocated_tubes,
      reserved_tubes_remaining = v_next_reserved_tubes,
      notes = v_next_notes,
      updated_at = now(),
      updated_by = v_actor
    where id = v_allocation.id
      and org_id = p_org_id;
  end if;

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
          'productId', v_allocation.product_id,
          'warehouse', v_allocation.warehouse
        ),
        jsonb_build_object(
          'productId', v_next_product_id,
          'warehouse', v_next_warehouse
        )
      )
    )
  );
  v_warnings := v_warnings || coalesce(v_planner_result->'warnings', '[]'::jsonb);

  return jsonb_build_object(
    'jobId', v_job.id::text,
    'jobNumber', v_job.job_number,
    'caulkAllocationId', v_allocation.caulk_allocation_id,
    'warnings', v_warnings
  );
end;
$$;

select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_update(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_update(uuid, text, jsonb)', 'service_role');
