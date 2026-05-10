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
  v_job_number text := app_api.require_job_number_digits(p_payload->>'jobNumber', 'Job ID number');
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
    and j.job_number = v_job_number
  for update;

  if found then
    perform app_api.raise_http(409, format('Job %s already exists.', v_job_number));
  end if;

  v_job.id := gen_random_uuid();
  v_job.created_at := v_now;
  v_job.created_by := app_api.trim_text(p_actor);
  v_job.is_staged_for_pickup := false;
  v_job.is_labor_only := false;

  v_had_labor_only := coalesce(v_job.is_labor_only, false);

  v_job.org_id := p_org_id;
  v_job.job_number := v_job_number;
  v_job.warehouse := app_api.require_org_warehouse(p_org_id, p_payload->>'warehouse', 'Warehouse');
  v_job.sections := app_api.normalize_job_work_scope(
    case when p_payload ? 'workScope' then p_payload->>'workScope' else p_payload->>'sections' end
  );
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
