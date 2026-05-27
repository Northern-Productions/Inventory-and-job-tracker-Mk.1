/**
 * PURPOSE:
 * Fixes allocation removal failures caused by planner suppression upserts using
 * an ON CONFLICT target that no longer matches the active suppression unique
 * index after multi-phase jobs added phase_id to that index.
 *
 * AFFECTS:
 * app_api.record_auto_planned_allocation_suppression and
 * app_api.record_auto_planned_caulk_allocation_suppression only.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * Supabase mirror migration, schema latest guard, allocation remove tests, and
 * caulk remove tests.
 *
 * COMMON FAILURE MODES:
 * Reverting the conflict target to omit the coalesced phase_id expression will
 * raise "there is no unique or exclusion constraint matching the ON CONFLICT
 * specification" when users remove AUTO_PLANNED allocations.
 */

create or replace function app_api.record_auto_planned_allocation_suppression(
  p_org_id uuid,
  p_actor text,
  p_allocation_id text,
  p_reason text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_actor text := coalesce(app_api.trim_text(p_actor), '');
  v_reason text := coalesce(nullif(app_api.trim_text(p_reason), ''), 'User removed AUTO_PLANNED allocation.');
  v_allocation app.allocations;
  v_job app.jobs;
  v_requirement app.job_requirements;
  v_signature text := '';
  v_source_inventory_id text := '';
begin
  select *
  into v_allocation
  from app.allocations a
  where a.org_id = p_org_id
    and a.allocation_id = app_api.trim_text(p_allocation_id)
  for update;

  if not found
    or coalesce(v_allocation.allocation_source::text, 'MANUAL') <> 'AUTO_PLANNED'
    or coalesce(v_allocation.allocation_kind::text, 'REQUIREMENT') <> 'REQUIREMENT'
    or v_allocation.requirement_id is null
    or v_allocation.job_id is null
  then
    return jsonb_build_object('suppressed', false);
  end if;

  select *
  into v_job
  from app.jobs j
  where j.org_id = p_org_id
    and j.id = v_allocation.job_id
  for update;

  select *
  into v_requirement
  from app.job_requirements r
  where r.org_id = p_org_id
    and r.job_id = v_allocation.job_id
    and r.id = v_allocation.requirement_id
  for update;

  if not found then
    return jsonb_build_object('suppressed', false);
  end if;

  v_signature := app_api.film_requirement_planner_signature(
    v_requirement.manufacturer,
    v_requirement.film_name,
    v_requirement.width_in,
    v_requirement.required_feet
  );
  v_source_inventory_id := app_api.trim_text(v_allocation.box_id);

  insert into app.allocation_planner_suppressions (
    org_id,
    job_id,
    job_number,
    material_type,
    requirement_id,
    requirement_signature,
    source_allocation_id,
    source_inventory_id,
    reason,
    suppressed_at,
    suppressed_by,
    updated_at
  )
  values (
    p_org_id,
    v_allocation.job_id,
    coalesce(v_job.job_number, v_allocation.job_number),
    'FILM',
    v_requirement.id,
    v_signature,
    v_allocation.allocation_id,
    v_source_inventory_id,
    v_reason,
    now(),
    v_actor,
    now()
  )
  on conflict (
    org_id,
    job_id,
    material_type,
    (coalesce(phase_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    requirement_signature
  )
    where cleared_at is null
  do update set
    requirement_id = excluded.requirement_id,
    job_number = excluded.job_number,
    source_allocation_id = excluded.source_allocation_id,
    source_inventory_id = excluded.source_inventory_id,
    reason = excluded.reason,
    suppressed_at = excluded.suppressed_at,
    suppressed_by = excluded.suppressed_by,
    updated_at = excluded.updated_at;

  return jsonb_build_object(
    'suppressed', true,
    'jobNumber', coalesce(v_job.job_number, v_allocation.job_number),
    'requirementId', v_requirement.id,
    'sourceAllocationId', v_allocation.allocation_id,
    'sourceInventoryId', v_source_inventory_id
  );
end;
$$;

create or replace function app_api.record_auto_planned_caulk_allocation_suppression(
  p_org_id uuid,
  p_actor text,
  p_caulk_allocation_id text,
  p_reason text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_actor text := coalesce(app_api.trim_text(p_actor), '');
  v_reason text := coalesce(nullif(app_api.trim_text(p_reason), ''), 'User removed AUTO_PLANNED caulk allocation.');
  v_allocation app.caulk_job_allocations;
  v_job app.jobs;
  v_requirement app.job_caulk_requirements;
  v_warehouse text := '';
  v_signature text := '';
  v_source_inventory_id text := '';
begin
  select *
  into v_allocation
  from app.caulk_job_allocations a
  where a.org_id = p_org_id
    and a.caulk_allocation_id = app_api.trim_text(p_caulk_allocation_id)
  for update;

  if not found
    or coalesce(v_allocation.allocation_source::text, 'MANUAL') <> 'AUTO_PLANNED'
    or v_allocation.requirement_id is null
    or v_allocation.job_id is null
  then
    return jsonb_build_object('suppressed', false);
  end if;

  select *
  into v_job
  from app.jobs j
  where j.org_id = p_org_id
    and j.id = v_allocation.job_id
  for update;

  if not found then
    return jsonb_build_object('suppressed', false);
  end if;

  select *
  into v_requirement
  from app.job_caulk_requirements r
  where r.org_id = p_org_id
    and r.job_id = v_allocation.job_id
    and r.id = v_allocation.requirement_id
    and r.product_id = v_allocation.product_id
  for update;

  if not found then
    return jsonb_build_object('suppressed', false);
  end if;

  v_warehouse := upper(coalesce(nullif(app_api.trim_text(v_job.warehouse), ''), app_api.trim_text(v_allocation.warehouse)));
  v_signature := app_api.caulk_requirement_planner_signature(
    v_requirement.product_id,
    v_warehouse,
    v_requirement.required_tubes
  );
  v_source_inventory_id := concat_ws(':', v_allocation.product_id::text, v_warehouse);

  insert into app.allocation_planner_suppressions (
    org_id,
    job_id,
    job_number,
    material_type,
    requirement_id,
    requirement_signature,
    source_allocation_id,
    source_inventory_id,
    reason,
    suppressed_at,
    suppressed_by,
    updated_at
  )
  values (
    p_org_id,
    v_allocation.job_id,
    coalesce(v_job.job_number, v_allocation.job_number),
    'CAULK',
    v_requirement.id,
    v_signature,
    v_allocation.caulk_allocation_id,
    v_source_inventory_id,
    v_reason,
    now(),
    v_actor,
    now()
  )
  on conflict (
    org_id,
    job_id,
    material_type,
    (coalesce(phase_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    requirement_signature
  )
    where cleared_at is null
  do update set
    requirement_id = excluded.requirement_id,
    job_number = excluded.job_number,
    source_allocation_id = excluded.source_allocation_id,
    source_inventory_id = excluded.source_inventory_id,
    reason = excluded.reason,
    suppressed_at = excluded.suppressed_at,
    suppressed_by = excluded.suppressed_by,
    updated_at = excluded.updated_at;

  return jsonb_build_object(
    'suppressed', true,
    'jobNumber', coalesce(v_job.job_number, v_allocation.job_number),
    'requirementId', v_requirement.id,
    'productId', v_requirement.product_id,
    'warehouse', v_warehouse,
    'sourceAllocationId', v_allocation.caulk_allocation_id,
    'sourceInventoryId', v_source_inventory_id
  );
end;
$$;
