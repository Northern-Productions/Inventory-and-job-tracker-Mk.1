/**
 * PURPOSE:
 * Extends durable AUTO_PLANNED removal suppression from film to caulk so a
 * user-removed auto caulk row is not recreated by the planner.
 *
 * AFFECTS:
 * POST /allocations/caulk/remove, caulk requirement reads, planner resume,
 * app_api.reconcile_auto_planned_allocations, and SQL/Edge planner ownership.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * Supabase mirror migration, Edge/backend SQL planner handled routes,
 * frontend caulk paused/resume UI, and DEV caulk suppression audit output.
 *
 * COMMON FAILURE MODES:
 * Planner recreating a removed AUTO_PLANNED caulk allocation, suppressing
 * manual caulk rows, stale suppressions surviving requirement edits, or
 * duplicate Edge planner execution after the SQL RPC reconciles atomically.
 */

create or replace function app_api.caulk_requirement_planner_signature(
  p_product_id uuid,
  p_warehouse text,
  p_required_tubes integer
)
returns text
language sql
immutable
as $$
  select concat_ws(
    '|',
    coalesce(p_product_id::text, ''),
    upper(app_api.trim_text(p_warehouse)),
    greatest(coalesce(p_required_tubes, 0), 0)::text
  );
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
  on conflict (org_id, job_id, material_type, requirement_signature)
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
    'sourceInventoryId', v_source_inventory_id,
    'requirementSignature', v_signature
  );
end;
$$;

create or replace function app_api.clear_caulk_allocation_planner_suppression_for_requirement(
  p_org_id uuid,
  p_actor text,
  p_job_number text,
  p_requirement_id uuid,
  p_reason text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_actor text := coalesce(app_api.trim_text(p_actor), '');
  v_reason text := coalesce(nullif(app_api.trim_text(p_reason), ''), 'User resumed caulk auto-planning for requirement.');
  v_job app.jobs;
  v_requirement app.job_caulk_requirements;
  v_warehouse text := '';
  v_signature text := '';
  v_cleared_count integer := 0;
begin
  select *
  into v_job
  from app.jobs j
  where j.org_id = p_org_id
    and upper(trim(j.job_number)) = upper(trim(p_job_number))
  for update;

  if not found then
    perform app_api.raise_http(404, format('Job %s was not found.', p_job_number));
  end if;

  select *
  into v_requirement
  from app.job_caulk_requirements r
  where r.org_id = p_org_id
    and r.job_id = v_job.id
    and r.id = p_requirement_id
  for update;

  if not found then
    perform app_api.raise_http(404, 'Caulk requirement was not found.');
  end if;

  v_warehouse := upper(app_api.trim_text(v_job.warehouse));
  v_signature := app_api.caulk_requirement_planner_signature(
    v_requirement.product_id,
    v_warehouse,
    v_requirement.required_tubes
  );

  update app.allocation_planner_suppressions
  set cleared_at = now(),
      cleared_by = v_actor,
      cleared_reason = v_reason,
      updated_at = now()
  where org_id = p_org_id
    and job_id = v_job.id
    and material_type = 'CAULK'
    and requirement_signature = v_signature
    and cleared_at is null;
  get diagnostics v_cleared_count = row_count;

  return jsonb_build_object(
    'jobNumber', v_job.job_number,
    'requirementId', v_requirement.id,
    'productId', v_requirement.product_id,
    'warehouse', v_warehouse,
    'clearedCount', v_cleared_count
  );
end;
$$;

create or replace function app_api.clear_stale_allocation_planner_suppressions_for_job(
  p_org_id uuid,
  p_actor text,
  p_job_id uuid,
  p_reason text default ''
)
returns integer
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_actor text := coalesce(app_api.trim_text(p_actor), '');
  v_reason text := coalesce(nullif(app_api.trim_text(p_reason), ''), 'Requirement changed; auto-planning may resume.');
  v_cleared_count integer := 0;
  v_total_cleared_count integer := 0;
begin
  update app.allocation_planner_suppressions s
  set cleared_at = now(),
      cleared_by = v_actor,
      cleared_reason = v_reason,
      updated_at = now()
  where s.org_id = p_org_id
    and s.job_id = p_job_id
    and s.material_type = 'FILM'
    and s.cleared_at is null
    and not exists (
      select 1
      from app.job_requirements r
      where r.org_id = s.org_id
        and r.job_id = s.job_id
        and app_api.film_requirement_planner_signature(
          r.manufacturer,
          r.film_name,
          r.width_in,
          r.required_feet
        ) = s.requirement_signature
    );
  get diagnostics v_cleared_count = row_count;
  v_total_cleared_count := v_total_cleared_count + v_cleared_count;

  update app.allocation_planner_suppressions s
  set cleared_at = now(),
      cleared_by = v_actor,
      cleared_reason = v_reason,
      updated_at = now()
  from app.jobs j
  where s.org_id = p_org_id
    and s.job_id = p_job_id
    and s.material_type = 'CAULK'
    and s.cleared_at is null
    and j.org_id = s.org_id
    and j.id = s.job_id
    and not exists (
      select 1
      from app.job_caulk_requirements r
      where r.org_id = s.org_id
        and r.job_id = s.job_id
        and app_api.caulk_requirement_planner_signature(
          r.product_id,
          j.warehouse,
          r.required_tubes
        ) = s.requirement_signature
    );
  get diagnostics v_cleared_count = row_count;
  v_total_cleared_count := v_total_cleared_count + v_cleared_count;

  return v_total_cleared_count;
end;
$$;

do $$
declare
  v_definition text;
  v_next_definition text;
  v_old_tables text := $snippet$
  create temporary table if not exists auto_planner_desired_caulk (
    caulk_allocation_id text,
    job_id uuid not null,
    job_number text not null,
    requirement_id uuid not null,
    product_id uuid not null,
    warehouse text not null,
    allocated_tubes integer not null,
    primary key (job_id, requirement_id, product_id, warehouse)
  ) on commit drop;
  truncate auto_planner_desired_caulk;

  create temporary table if not exists auto_planner_explicit_job_scope ($snippet$;
  v_new_tables text := $snippet$
  create temporary table if not exists auto_planner_desired_caulk (
    caulk_allocation_id text,
    job_id uuid not null,
    job_number text not null,
    requirement_id uuid not null,
    product_id uuid not null,
    warehouse text not null,
    allocated_tubes integer not null,
    primary key (job_id, requirement_id, product_id, warehouse)
  ) on commit drop;
  truncate auto_planner_desired_caulk;

  create temporary table if not exists auto_planner_suppressed_caulk (
    job_id uuid not null,
    requirement_id uuid not null,
    requirement_signature text not null,
    primary key (job_id, requirement_id)
  ) on commit drop;
  truncate auto_planner_suppressed_caulk;

  create temporary table if not exists auto_planner_explicit_job_scope ($snippet$;
  v_old_suppression_anchor text := $snippet$
  insert into auto_planner_suppressed_film (job_id, requirement_id, requirement_signature)
  select distinct
    r.job_id,
    r.id,
    s.requirement_signature
  from app.allocation_planner_suppressions s
  join auto_planner_jobs j
    on j.job_id = s.job_id
  join app.job_requirements r
    on r.org_id = s.org_id
   and r.job_id = s.job_id
   and app_api.film_requirement_planner_signature(
     r.manufacturer,
     r.film_name,
     r.width_in,
     r.required_feet
   ) = s.requirement_signature
  where s.org_id = p_org_id
    and s.material_type = 'FILM'
    and s.cleared_at is null
  on conflict do nothing;

  for v_job in$snippet$;
  v_new_suppression_anchor text := $snippet$
  insert into auto_planner_suppressed_film (job_id, requirement_id, requirement_signature)
  select distinct
    r.job_id,
    r.id,
    s.requirement_signature
  from app.allocation_planner_suppressions s
  join auto_planner_jobs j
    on j.job_id = s.job_id
  join app.job_requirements r
    on r.org_id = s.org_id
   and r.job_id = s.job_id
   and app_api.film_requirement_planner_signature(
     r.manufacturer,
     r.film_name,
     r.width_in,
     r.required_feet
   ) = s.requirement_signature
  where s.org_id = p_org_id
    and s.material_type = 'FILM'
    and s.cleared_at is null
  on conflict do nothing;

  update app.allocation_planner_suppressions s
  set requirement_id = r.id,
      job_number = j.job_number,
      updated_at = v_now
  from auto_planner_jobs j
  join app.job_caulk_requirements r
    on r.org_id = p_org_id
   and r.job_id = j.job_id
  where s.org_id = p_org_id
    and s.job_id = j.job_id
    and s.material_type = 'CAULK'
    and s.cleared_at is null
    and app_api.caulk_requirement_planner_signature(
      r.product_id,
      j.warehouse,
      r.required_tubes
    ) = s.requirement_signature
    and (
      s.requirement_id is distinct from r.id
      or s.job_number is distinct from j.job_number
    );

  insert into auto_planner_suppressed_caulk (job_id, requirement_id, requirement_signature)
  select distinct
    r.job_id,
    r.id,
    s.requirement_signature
  from app.allocation_planner_suppressions s
  join auto_planner_jobs j
    on j.job_id = s.job_id
  join app.job_caulk_requirements r
    on r.org_id = s.org_id
   and r.job_id = s.job_id
   and app_api.caulk_requirement_planner_signature(
     r.product_id,
     j.warehouse,
     r.required_tubes
   ) = s.requirement_signature
  where s.org_id = p_org_id
    and s.material_type = 'CAULK'
    and s.cleared_at is null
  on conflict do nothing;

  for v_job in$snippet$;
  v_old_caulk_needed text := $snippet$    v_needed := greatest(coalesce(v_req.required_tubes, 0) - coalesce(v_existing_coverage, 0), 0);
    v_remaining := 0;

    select greatest($snippet$;
  v_new_caulk_needed text := $snippet$    v_needed := greatest(coalesce(v_req.required_tubes, 0) - coalesce(v_existing_coverage, 0), 0);
    select exists (
      select 1
      from auto_planner_suppressed_caulk s
      where s.job_id = v_req.job_id
        and s.requirement_id = v_req.id
    )
    into v_is_suppressed;

    if v_is_suppressed then
      continue;
    end if;

    v_remaining := 0;

    select greatest($snippet$;
begin
  select pg_get_functiondef('app_api.reconcile_auto_planned_allocations(uuid, text, jsonb)'::regprocedure)
  into v_definition;

  if v_definition is null then
    raise exception 'app_api.reconcile_auto_planned_allocations(uuid, text, jsonb) was not found';
  end if;

  v_definition := replace(v_definition, E'\r\n', E'\n');
  v_next_definition := v_definition;
  v_old_tables := replace(v_old_tables, E'\r\n', E'\n');
  v_new_tables := replace(v_new_tables, E'\r\n', E'\n');
  v_old_suppression_anchor := replace(v_old_suppression_anchor, E'\r\n', E'\n');
  v_new_suppression_anchor := replace(v_new_suppression_anchor, E'\r\n', E'\n');
  v_old_caulk_needed := replace(v_old_caulk_needed, E'\r\n', E'\n');
  v_new_caulk_needed := replace(v_new_caulk_needed, E'\r\n', E'\n');

  if position(v_new_tables in v_next_definition) = 0 then
    if position(v_old_tables in v_next_definition) = 0 then
      raise exception 'Expected caulk planner temp table snippet was not found';
    end if;
    v_next_definition := replace(v_next_definition, v_old_tables, v_new_tables);
  end if;

  if position(v_new_suppression_anchor in v_next_definition) = 0 then
    if position(v_old_suppression_anchor in v_next_definition) = 0 then
      raise exception 'Expected film suppression anchor snippet was not found';
    end if;
    v_next_definition := replace(v_next_definition, v_old_suppression_anchor, v_new_suppression_anchor);
  end if;

  if position(v_new_caulk_needed in v_next_definition) = 0 then
    if position(v_old_caulk_needed in v_next_definition) = 0 then
      raise exception 'Expected caulk needed planner snippet was not found';
    end if;
    v_next_definition := replace(v_next_definition, v_old_caulk_needed, v_new_caulk_needed);
  end if;

  if position(v_new_tables in v_next_definition) = 0
    or position(v_new_suppression_anchor in v_next_definition) = 0
    or position(v_new_caulk_needed in v_next_definition) = 0
    or position('create temporary table if not exists auto_planner_suppressed_caulk' in v_next_definition) = 0
    or position('from auto_planner_suppressed_caulk s' in v_next_definition) = 0
  then
    raise exception 'app_api.reconcile_auto_planned_allocations caulk suppression patch verification failed';
  end if;

  if v_next_definition <> v_definition then
    execute v_next_definition;
  end if;
end;
$$;

create or replace function public.api_acl_clear_allocation_planner_suppression(
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
  v_job_number text := app_api.require_job_number_digits(p_payload->>'jobNumber', 'Job ID number');
  v_requirement_id uuid := nullif(app_api.trim_text(p_payload->>'requirementId'), '')::uuid;
  v_material_type text := upper(coalesce(nullif(app_api.trim_text(p_payload->>'materialType'), ''), nullif(app_api.trim_text(p_payload->>'material_type'), ''), 'FILM'));
  v_result jsonb;
  v_scope jsonb;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'write');

  if v_requirement_id is null then
    perform app_api.raise_http(400, 'Requirement ID is required.');
  end if;

  if v_material_type = 'CAULK' then
    v_result := app_api.clear_caulk_allocation_planner_suppression_for_requirement(
      p_org_id,
      p_actor,
      v_job_number,
      v_requirement_id,
      p_payload->>'reason'
    );
    v_scope := jsonb_build_object(
      'jobNumbers', jsonb_build_array(v_job_number),
      'caulkProductWarehousePairs',
      jsonb_build_array(
        jsonb_build_object(
          'productId', v_result->>'productId',
          'warehouse', v_result->>'warehouse'
        )
      )
    );
  elsif v_material_type = 'FILM' then
    v_result := app_api.clear_allocation_planner_suppression_for_requirement(
      p_org_id,
      p_actor,
      v_job_number,
      v_requirement_id,
      p_payload->>'reason'
    );
    v_scope := jsonb_build_object('jobNumbers', jsonb_build_array(v_job_number));
  else
    perform app_api.raise_http(400, 'materialType must be FILM or CAULK.');
  end if;

  perform app_api.reconcile_auto_planned_allocations(p_org_id, p_actor, v_scope);

  return v_result || jsonb_build_object('materialType', v_material_type);
end;
$$;

drop function if exists public.api_acl_list_job_caulk_requirements_by_job(uuid, text);

create or replace function public.api_acl_list_job_caulk_requirements_by_job(
  p_org_id uuid,
  p_job_number text
)
returns table (
  requirement_id uuid,
  job_number text,
  product_id uuid,
  manufacturer_id uuid,
  manufacturer text,
  product_name text,
  product_code text,
  tubes_per_case integer,
  required_tubes integer,
  notes text,
  updated_at timestamptz,
  auto_planning_suppressed boolean
)
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_org_member(p_org_id);

  return query
  select
    r.id,
    j.job_number,
    r.product_id,
    p.manufacturer_id,
    m.name,
    p.name,
    p.code,
    p.tubes_per_case,
    r.required_tubes,
    r.notes,
    r.updated_at,
    exists (
      select 1
      from app.allocation_planner_suppressions s
      where s.org_id = r.org_id
        and s.job_id = r.job_id
        and s.material_type = 'CAULK'
        and s.cleared_at is null
        and s.requirement_signature = app_api.caulk_requirement_planner_signature(
          r.product_id,
          j.warehouse,
          r.required_tubes
        )
    ) as auto_planning_suppressed
  from app.job_caulk_requirements r
  join app.jobs j
    on j.id = r.job_id
   and j.org_id = r.org_id
  join app.caulk_products p
    on p.id = r.product_id
   and p.org_id = r.org_id
  join app.caulk_manufacturers m
    on m.id = p.manufacturer_id
   and m.org_id = p.org_id
  where r.org_id = p_org_id
    and upper(j.job_number) = upper(app_api.require_job_number_digits(p_job_number, 'Job ID number'))
  order by lower(m.name), lower(p.name), lower(p.code);
end;
$$;

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
    format('Removed from job %s.', v_allocation.job_number)
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
      'jobNumbers', jsonb_build_array(v_allocation.job_number),
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
    'jobNumber', v_allocation.job_number,
    'caulkAllocationId', v_allocation.caulk_allocation_id,
    'releasedReservedTubes', v_released_reserved_tubes,
    'autoPlanningSuppressed', v_auto_planning_suppressed,
    'warnings', v_warnings
  );
end;
$$;

select app_api.grant_execute_if_exists('public.api_acl_clear_allocation_planner_suppression(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_clear_allocation_planner_suppression(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_list_job_caulk_requirements_by_job(uuid, text)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_job_caulk_requirements_by_job(uuid, text)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_remove(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_remove(uuid, text, jsonb)', 'service_role');
