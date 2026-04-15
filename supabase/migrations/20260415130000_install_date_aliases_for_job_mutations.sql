create or replace function public.api_jobs_create(
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

  select *
  into v_job
  from app.jobs j
  where j.org_id = p_org_id
    and j.job_number = app_api.require_job_number_digits(p_payload->>'jobNumber', 'Job ID number')
  for update;

  if not found then
    v_job.id := gen_random_uuid();
    v_job.created_at := v_now;
    v_job.created_by := app_api.trim_text(p_actor);
    v_job.is_staged_for_pickup := false;
    v_job.is_labor_only := false;
  end if;

  v_had_labor_only := coalesce(v_job.is_labor_only, false);

  v_job.org_id := p_org_id;
  v_job.job_number := app_api.require_job_number_digits(p_payload->>'jobNumber', 'Job ID number');
  v_job.warehouse := app_api.require_org_warehouse(p_org_id, p_payload->>'warehouse', 'Warehouse');
  v_job.sections := app_api.normalize_job_sections(p_payload->>'sections');
  v_job.due_date := nullif(
    app_api.trim_text(coalesce(p_payload->>'installDate', p_payload->>'dueDate')),
    ''
  )::date;
  v_job.crew_leader := app_api.trim_text(p_payload->>'crewLeader');
  v_job.lifecycle_status := app_api.normalize_job_lifecycle_status(p_payload->>'lifecycleStatus');
  v_job.notes := app_api.trim_text(p_payload->>'notes');

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

  select *
  into v_job
  from app.jobs j
  where j.org_id = p_org_id
    and j.job_number = app_api.require_job_number_digits(p_payload->>'jobNumber', 'Job ID number')
  for update;

  if not found then
    v_job.id := gen_random_uuid();
    v_job.org_id := p_org_id;
    v_job.job_number := app_api.require_job_number_digits(p_payload->>'jobNumber', 'Job ID number');
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

  v_had_labor_only := coalesce(v_job.is_labor_only, false);

  if p_payload ? 'warehouse' then
    v_job.warehouse := app_api.require_org_warehouse(p_org_id, p_payload->>'warehouse', 'Warehouse');
  end if;
  if p_payload ? 'sections' then
    v_job.sections := app_api.normalize_job_sections(p_payload->>'sections');
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
