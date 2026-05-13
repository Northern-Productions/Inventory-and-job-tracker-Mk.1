/**
 * PURPOSE:
 * Makes jobs/update SQL behavior target and reconcile by exact jobId when the
 * canonical jobId route has already validated the job identity.
 *
 * AFFECTS:
 * public.api_jobs_update, public.api_acl_jobs_update, and a small helper used
 * only for canonical schedule sync by job_id. Legacy jobNumber-only update
 * behavior remains available.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * Supabase mirror migration, Edge jobs/update identity guard, backend local
 * update identity guard, and schema latest guard semantics.
 *
 * COMMON FAILURE MODES:
 * Allowing mismatched jobId/jobNumber payloads, creating a fallback job when a
 * jobId was supplied, syncing same-number jobs by jobNumber on the canonical
 * path, or enabling duplicate job numbers before the rest of the workflow is
 * ready.
 */

create or replace function app_api.sync_active_job_schedule_allocations_by_job_id(
  p_org_id uuid,
  p_job_id uuid,
  p_install_date date,
  p_crew_leader text
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_allocation app.allocations;
  v_order app.film_orders;
  v_box app.boxes;
  v_box_id text;
  v_physical_feet_by_box jsonb := '{}'::jsonb;
  v_updated_allocation_count integer := 0;
  v_updated_film_order_count integer := 0;
begin
  if p_job_id is null then
    perform app_api.raise_http(400, 'Job ID is required.');
  end if;

  for v_box_id in
    select distinct a.box_id
    from app.allocations a
    where a.org_id = p_org_id
      and a.job_id = p_job_id
      and a.status = 'ACTIVE'
      and coalesce(trim(a.box_id), '') <> ''
  loop
    select *
    into v_box
    from app.boxes b
    where b.org_id = p_org_id
      and b.box_id = v_box_id
    for update;

    if found and upper(coalesce(v_box.status::text, '')) in ('IN_STOCK', 'TRANSFER') then
      v_physical_feet_by_box := jsonb_set(
        v_physical_feet_by_box,
        array[v_box_id],
        to_jsonb(coalesce(app_api.box_physical_feet_available(v_box), 0)),
        true
      );
    end if;
  end loop;

  for v_allocation in
    select *
    from app.allocations a
    where a.org_id = p_org_id
      and a.job_id = p_job_id
      and a.status = 'ACTIVE'
    for update
  loop
    if v_allocation.job_date is distinct from p_install_date
      or coalesce(v_allocation.crew_leader, '') is distinct from coalesce(app_api.trim_text(p_crew_leader), '')
    then
      v_allocation.job_date := p_install_date;
      v_allocation.crew_leader := coalesce(app_api.trim_text(p_crew_leader), '');
      perform app_api.save_allocation(v_allocation);
      v_updated_allocation_count := v_updated_allocation_count + 1;
    end if;
  end loop;

  for v_order in
    select *
    from app.film_orders f
    where f.org_id = p_org_id
      and f.job_id = p_job_id
      and f.status in ('FILM_ORDER', 'FILM_ON_THE_WAY')
    for update
  loop
    if v_order.job_date is distinct from p_install_date
      or coalesce(v_order.crew_leader, '') is distinct from coalesce(app_api.trim_text(p_crew_leader), '')
    then
      v_order.job_date := p_install_date;
      v_order.crew_leader := coalesce(app_api.trim_text(p_crew_leader), '');
      perform app_api.save_film_order(v_order);
      v_updated_film_order_count := v_updated_film_order_count + 1;
    end if;
  end loop;

  for v_box_id in
    select jsonb_object_keys(v_physical_feet_by_box)
  loop
    perform app_api.recalculate_physical_box_allocatable_now(
      p_org_id,
      v_box_id,
      coalesce((v_physical_feet_by_box->>v_box_id)::integer, 0)
    );
  end loop;

  return jsonb_build_object(
    'updatedAllocationCount', v_updated_allocation_count,
    'updatedFilmOrderCount', v_updated_film_order_count
  );
end;
$$;

create or replace function public.api_jobs_update(
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
  v_now timestamptz := now();
  v_job_number text := app_api.require_job_number_digits(p_payload->>'jobNumber', 'Job ID number');
  v_job_id_text text := app_api.trim_text(p_payload->>'jobId');
  v_has_job_id boolean := v_job_id_text <> '';
  v_job_id uuid;
  v_has_film_requirements boolean := exists (
    select 1
    from app_api.requirement_rows_from_payload(p_payload->'requirements')
  );
  v_has_caulk_requirements boolean := exists (
    select 1
    from app_api.caulk_requirement_rows_from_payload(p_payload->'caulkRequirements')
  );
  v_has_labor_only_input boolean := coalesce(p_payload ? 'isLaborOnly', false) or coalesce(p_payload ? 'is_labor_only', false);
  v_labor_only_text text := lower(
    app_api.trim_text(coalesce(p_payload->>'isLaborOnly', p_payload->>'is_labor_only'))
  );
  v_is_labor_only boolean := false;
  v_had_labor_only boolean := false;
begin
  perform app_api.require_org_member(p_org_id);

  if v_has_job_id then
    if not coalesce(v_job_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false) then
      perform app_api.raise_http(400, 'jobId must be a valid UUID.');
    end if;

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
      and j.job_number = v_job_number
    for update;

    if not found then
      v_job.id := gen_random_uuid();
      v_job.org_id := p_org_id;
      v_job.job_number := v_job_number;
      v_job.warehouse := coalesce(
        case
          when app_api.trim_text(p_payload->>'warehouse') <> ''
            then app_api.require_org_warehouse(p_org_id, p_payload->>'warehouse', 'Warehouse')
          else null
        end,
        (
          select w.code
          from app.warehouses w
          where w.org_id = p_org_id
            and w.box_id_prefix = ''
          order by case when w.code = 'IL' then 0 else 1 end, w.code
          limit 1
        ),
        (
          select w.code
          from app.warehouses w
          where w.org_id = p_org_id
          order by w.code
          limit 1
        )
      );
      if v_job.warehouse is null then
        perform app_api.raise_http(400, 'No warehouse is configured for this organization.');
      end if;
      v_job.sections := null;
      v_job.due_date := null;
      v_job.crew_leader := '';
      v_job.lifecycle_status := 'ACTIVE';
      v_job.is_staged_for_pickup := false;
      v_job.is_labor_only := false;
      v_job.notes := '';
      v_job.created_at := v_now;
      v_job.created_by := app_api.trim_text(p_actor);
    end if;
  end if;

  v_had_labor_only := coalesce(v_job.is_labor_only, false);

  if p_payload ? 'warehouse' then
    v_job.warehouse := app_api.require_org_warehouse(p_org_id, p_payload->>'warehouse', 'Warehouse');
  end if;
  if p_payload ? 'workScope' or p_payload ? 'sections' then
    v_job.sections := app_api.normalize_job_work_scope(
      case when p_payload ? 'workScope' then p_payload->>'workScope' else p_payload->>'sections' end
    );
  end if;
  if p_payload ? 'installDate' or p_payload ? 'dueDate' then
    v_job.due_date := nullif(
      app_api.trim_text(coalesce(p_payload->>'installDate', p_payload->>'dueDate')),
      ''
    )::date;
  end if;
  if p_payload ? 'crewLeader' then
    v_job.crew_leader := app_api.trim_text(p_payload->>'crewLeader');
  end if;
  if p_payload ? 'lifecycleStatus' then
    v_job.lifecycle_status := app_api.normalize_job_lifecycle_status(p_payload->>'lifecycleStatus');
  end if;
  if p_payload ? 'notes' then
    v_job.notes := app_api.trim_text(p_payload->>'notes');
  end if;

  if v_has_labor_only_input then
    if v_labor_only_text in ('true', 't', '1', 'yes', 'on') then
      v_is_labor_only := true;
    elsif v_labor_only_text in ('false', 'f', '0', 'no', 'off') then
      v_is_labor_only := false;
    else
      perform app_api.raise_http(400, 'isLaborOnly must be true or false.');
    end if;
  else
    v_is_labor_only := v_had_labor_only;
  end if;

  if v_has_film_requirements or v_has_caulk_requirements then
    v_is_labor_only := false;
    if v_had_labor_only then
      v_job.is_staged_for_pickup := false;
    end if;
  elsif v_is_labor_only then
    v_job.is_staged_for_pickup := true;
  elsif v_has_labor_only_input and not v_is_labor_only and v_had_labor_only then
    v_job.is_staged_for_pickup := false;
  end if;

  v_job.is_labor_only := v_is_labor_only;
  v_job.updated_at := v_now;
  v_job.updated_by := app_api.trim_text(p_actor);
  v_job := app_api.save_job(v_job);
  perform app_api.replace_job_requirements(p_org_id, v_job, p_payload->'requirements', p_actor, v_now);
  perform app_api.replace_job_caulk_requirements(p_org_id, v_job, p_payload->'caulkRequirements', p_actor, v_now);

  return jsonb_build_object(
    'jobNumber', v_job.job_number,
    'warnings', '[]'::jsonb
  );
end;
$$;

create or replace function public.api_acl_jobs_update(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_existing_job app.jobs;
  v_updated_job app.jobs;
  v_result jsonb;
  v_job_number text := app_api.require_job_number_digits(p_payload->>'jobNumber', 'Job ID number');
  v_job_id_text text := app_api.trim_text(p_payload->>'jobId');
  v_has_job_id boolean := v_job_id_text <> '';
  v_job_id uuid;
  v_scope jsonb;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'write');

  if v_has_job_id then
    if not coalesce(v_job_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false) then
      perform app_api.raise_http(400, 'jobId must be a valid UUID.');
    end if;

    v_job_id := v_job_id_text::uuid;

    select *
    into v_existing_job
    from app.jobs j
    where j.org_id = p_org_id
      and j.id = v_job_id
    limit 1;

    if not found then
      perform app_api.raise_http(404, 'Job was not found.');
    end if;

    if upper(trim(v_existing_job.job_number)) <> upper(trim(v_job_number)) then
      perform app_api.raise_http(
        409,
        'Job identity mismatch: selected job does not match jobNumber.'
      );
    end if;

    v_result := public.api_jobs_update(p_org_id, p_actor, p_payload);

    select *
    into v_updated_job
    from app.jobs j
    where j.org_id = p_org_id
      and j.id = v_job_id
    limit 1;

    if not found then
      perform app_api.raise_http(404, 'Job was not found.');
    end if;

    if v_existing_job.due_date is distinct from v_updated_job.due_date
      or coalesce(v_existing_job.crew_leader, '') is distinct from coalesce(v_updated_job.crew_leader, '')
    then
      perform app_api.sync_active_job_schedule_allocations_by_job_id(
        p_org_id,
        v_updated_job.id,
        v_updated_job.due_date,
        v_updated_job.crew_leader
      );
    end if;

    v_scope := jsonb_build_object(
      'jobIds', jsonb_build_array(v_updated_job.id),
      'jobNumbers', jsonb_build_array(v_updated_job.job_number)
    );
  else
    select *
    into v_existing_job
    from app.jobs j
    where j.org_id = p_org_id
      and upper(trim(j.job_number)) = upper(trim(v_job_number))
    limit 1;

    v_result := public.api_jobs_update(p_org_id, p_actor, p_payload);

    select *
    into v_updated_job
    from app.jobs j
    where j.org_id = p_org_id
      and upper(trim(j.job_number)) = upper(trim(v_job_number))
    limit 1;

    if found and (
      v_existing_job.due_date is distinct from v_updated_job.due_date
      or coalesce(v_existing_job.crew_leader, '') is distinct from coalesce(v_updated_job.crew_leader, '')
    ) then
      perform app_api.sync_active_job_schedule_allocations(
        p_org_id,
        v_updated_job.job_number,
        v_updated_job.due_date,
        v_updated_job.crew_leader
      );
    end if;

    v_scope := jsonb_build_object('jobNumbers', jsonb_build_array(v_job_number));
  end if;

  perform app_api.reconcile_auto_planned_allocations(
    p_org_id,
    p_actor,
    v_scope
  );

  return v_result;
end;
$$;

comment on function public.api_jobs_update(uuid, text, jsonb)
is 'Updates jobs by exact jobId when canonical identity is supplied, preserving legacy jobNumber-only behavior.';

comment on function public.api_acl_jobs_update(uuid, text, jsonb)
is 'Updates jobs and reconciles planner scope by exact jobId when canonical identity is supplied.';
