/**
 * PURPOSE:
 * Enables final same-jobNumber / different-Work-Scope support by replacing
 * all-lifecycle job-number uniqueness with all-lifecycle job-number +
 * work_scope_key uniqueness.
 *
 * ROLLBACK NOTE:
 * Restoring unique(org_id, job_number) is only safe before same-number
 * different-scope rows have been created. After that, disable duplicate
 * creation in application code rather than destructively cleaning data.
 */

create or replace function app_api.save_job(p_job app.jobs)
returns app.jobs
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_row app.jobs;
begin
  insert into app.jobs (
    id,
    org_id,
    job_number,
    warehouse,
    sections,
    due_date,
    crew_leader,
    lifecycle_status,
    is_staged_for_pickup,
    is_labor_only,
    notes,
    created_at,
    created_by,
    updated_at,
    updated_by
  )
  values (
    coalesce(p_job.id, gen_random_uuid()),
    p_job.org_id,
    p_job.job_number,
    p_job.warehouse,
    p_job.sections,
    p_job.due_date,
    coalesce(p_job.crew_leader, ''),
    p_job.lifecycle_status,
    coalesce(p_job.is_staged_for_pickup, false),
    coalesce(p_job.is_labor_only, false),
    coalesce(p_job.notes, ''),
    coalesce(p_job.created_at, now()),
    coalesce(p_job.created_by, ''),
    coalesce(p_job.updated_at, now()),
    coalesce(p_job.updated_by, '')
  )
  on conflict (id) do update set
    job_number = excluded.job_number,
    warehouse = excluded.warehouse,
    sections = excluded.sections,
    due_date = excluded.due_date,
    crew_leader = excluded.crew_leader,
    lifecycle_status = excluded.lifecycle_status,
    is_staged_for_pickup = excluded.is_staged_for_pickup,
    is_labor_only = excluded.is_labor_only,
    notes = excluded.notes,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by
  returning * into v_row;

  return v_row;
end;
$$;

do $$
declare
  v_job_number_constraint_name text;
  v_triplet_constraint_exists boolean := false;
begin
  if exists (
    select 1
    from app.jobs
    where work_scope_key is null
      or btrim(work_scope_key) = ''
      or work_scope_key is distinct from app_api.normalize_job_work_scope_key(sections)
  ) then
    raise exception 'Cannot enable duplicate job numbers: app.jobs.work_scope_key is missing or inconsistent.';
  end if;

  if exists (
    select 1
    from app.jobs
    group by org_id, job_number, work_scope_key
    having count(*) > 1
  ) then
    raise exception 'Cannot enable duplicate job numbers: duplicate (org_id, job_number, work_scope_key) groups exist.';
  end if;

  select exists (
    select 1
    from pg_constraint c
    where c.conrelid = 'app.jobs'::regclass
      and c.contype = 'u'
      and (
        select array_agg(a.attname order by cols.ordinality)
        from unnest(c.conkey) with ordinality as cols(attnum, ordinality)
        join pg_attribute a
          on a.attrelid = c.conrelid
         and a.attnum = cols.attnum
      ) = array['org_id', 'job_number', 'work_scope_key']
  )
  into v_triplet_constraint_exists;

  select c.conname
  into v_job_number_constraint_name
  from pg_constraint c
  where c.conrelid = 'app.jobs'::regclass
    and c.contype = 'u'
    and (
      select array_agg(a.attname order by cols.ordinality)
      from unnest(c.conkey) with ordinality as cols(attnum, ordinality)
      join pg_attribute a
        on a.attrelid = c.conrelid
       and a.attnum = cols.attnum
    ) = array['org_id', 'job_number']
  limit 1;

  if v_job_number_constraint_name is not null then
    execute format('alter table app.jobs drop constraint %I', v_job_number_constraint_name);
  elsif not v_triplet_constraint_exists then
    raise exception 'Cannot enable duplicate job numbers: unique(org_id, job_number) was not found.';
  end if;

  if not v_triplet_constraint_exists then
    alter table app.jobs
      add constraint jobs_org_job_number_work_scope_key_unique
      unique (org_id, job_number, work_scope_key);
  end if;

  drop index if exists app.idx_jobs_org_job_number_work_scope_key;
end $$;

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
  v_existing_job app.jobs;
  v_job_number text := app_api.require_job_number_digits(p_payload->>'jobNumber', 'Job ID number');
  v_sections text := app_api.normalize_job_work_scope(
    case when p_payload ? 'workScope' then p_payload->>'workScope' else p_payload->>'sections' end
  );
  v_work_scope_key text := app_api.normalize_job_work_scope_key(v_sections);
  v_constraint_name text := '';
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
begin
  perform app_api.require_org_member(p_org_id);

  select *
  into v_existing_job
  from app.jobs j
  where j.org_id = p_org_id
    and j.job_number = v_job_number
    and j.work_scope_key = v_work_scope_key
  for update;

  if found then
    perform app_api.raise_http(409, format('Job %s already exists.', v_job_number));
  end if;

  v_job.id := gen_random_uuid();
  v_job.created_at := v_now;
  v_job.created_by := app_api.trim_text(p_actor);
  v_job.is_staged_for_pickup := false;
  v_job.is_labor_only := false;
  v_job.org_id := p_org_id;
  v_job.job_number := v_job_number;
  v_job.warehouse := app_api.require_org_warehouse(p_org_id, p_payload->>'warehouse', 'Warehouse');
  v_job.sections := v_sections;
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
  end if;

  if v_has_film_requirements or v_has_caulk_requirements then
    v_is_labor_only := false;
  elsif v_is_labor_only then
    v_job.is_staged_for_pickup := true;
  end if;

  v_job.is_labor_only := v_is_labor_only;
  v_job.updated_at := v_now;
  v_job.updated_by := app_api.trim_text(p_actor);

  begin
    v_job := app_api.save_job(v_job);
  exception
    when unique_violation then
      get stacked diagnostics v_constraint_name = CONSTRAINT_NAME;
      if v_constraint_name = 'jobs_org_job_number_work_scope_key_unique' then
        perform app_api.raise_http(409, format('Job %s already exists.', v_job_number));
      end if;
      raise;
  end;

  perform app_api.replace_job_requirements(p_org_id, v_job, p_payload->'requirements', p_actor, v_now);
  perform app_api.replace_job_caulk_requirements(p_org_id, v_job, p_payload->'caulkRequirements', p_actor, v_now);

  return jsonb_build_object(
    'jobId', v_job.id::text,
    'jobNumber', v_job.job_number,
    'warnings', '[]'::jsonb
  );
end;
$$;

create or replace function public.api_acl_jobs_create(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_result jsonb;
  v_job_id text := '';
  v_job_number text := '';
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'write');
  v_result := public.api_jobs_create(p_org_id, p_actor, p_payload);
  v_job_id := app_api.trim_text(v_result->>'jobId');
  v_job_number := app_api.trim_text(v_result->>'jobNumber');

  if v_job_id <> '' then
    perform app_api.reconcile_auto_planned_allocations(
      p_org_id,
      p_actor,
      jsonb_build_object('jobIds', jsonb_build_array(v_job_id))
    );
  elsif v_job_number <> '' then
    perform app_api.reconcile_auto_planned_allocations(
      p_org_id,
      p_actor,
      jsonb_build_object('jobNumbers', jsonb_build_array(v_job_number))
    );
  end if;

  return v_result;
end;
$$;
