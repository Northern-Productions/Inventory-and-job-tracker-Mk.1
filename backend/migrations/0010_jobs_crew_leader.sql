alter table app.jobs
  add column if not exists crew_leader text not null default '';

with job_metadata as (
  select
    x.org_id,
    x.job_number,
    min(x.job_date) as job_date,
    min(x.crew_leader) as crew_leader
  from (
    select
      a.org_id,
      a.job_number,
      a.job_date,
      nullif(a.crew_leader, '') as crew_leader
    from app.allocations a
    union all
    select
      f.org_id,
      f.job_number,
      f.job_date,
      nullif(f.crew_leader, '') as crew_leader
    from app.film_orders f
  ) x
  group by x.org_id, x.job_number
)
update app.jobs j
set
  due_date = coalesce(j.due_date, m.job_date),
  crew_leader = coalesce(nullif(j.crew_leader, ''), m.crew_leader, '')
from job_metadata m
where j.org_id = m.org_id
  and j.job_number = m.job_number;

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
    coalesce(p_job.notes, ''),
    coalesce(p_job.created_at, now()),
    coalesce(p_job.created_by, ''),
    coalesce(p_job.updated_at, now()),
    coalesce(p_job.updated_by, '')
  )
  on conflict (org_id, job_number) do update set
    warehouse = excluded.warehouse,
    sections = excluded.sections,
    due_date = excluded.due_date,
    crew_leader = excluded.crew_leader,
    lifecycle_status = excluded.lifecycle_status,
    notes = excluded.notes,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by
  returning * into v_row;

  return v_row;
end;
$$;

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
  end if;

  v_job.org_id := p_org_id;
  v_job.job_number := app_api.require_job_number_digits(p_payload->>'jobNumber', 'Job ID number');
  v_job.warehouse := app_api.require_warehouse(p_payload->>'warehouse', 'Warehouse');
  v_job.sections := app_api.normalize_job_sections(p_payload->>'sections');
  v_job.due_date := nullif(app_api.trim_text(p_payload->>'dueDate'), '')::date;
  v_job.crew_leader := app_api.trim_text(p_payload->>'crewLeader');
  v_job.lifecycle_status := app_api.normalize_job_lifecycle_status(p_payload->>'lifecycleStatus');
  v_job.notes := app_api.trim_text(p_payload->>'notes');
  v_job.updated_at := v_now;
  v_job.updated_by := app_api.trim_text(p_actor);

  v_job := app_api.save_job(v_job);
  perform app_api.replace_job_requirements(p_org_id, v_job, p_payload->'requirements', p_actor, v_now);

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
      nullif(upper(app_api.trim_text(p_payload->>'warehouse')), '')::app.warehouse,
      'IL'::app.warehouse
    );
    v_job.sections := null;
    v_job.due_date := null;
    v_job.crew_leader := '';
    v_job.lifecycle_status := 'ACTIVE';
    v_job.notes := '';
    v_job.created_at := v_now;
    v_job.created_by := app_api.trim_text(p_actor);
  end if;

  if p_payload ? 'warehouse' then
    v_job.warehouse := app_api.require_warehouse(p_payload->>'warehouse', 'Warehouse');
  end if;
  if p_payload ? 'sections' then
    v_job.sections := app_api.normalize_job_sections(p_payload->>'sections');
  end if;
  if p_payload ? 'dueDate' then
    v_job.due_date := nullif(app_api.trim_text(p_payload->>'dueDate'), '')::date;
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

  v_job.updated_at := v_now;
  v_job.updated_by := app_api.trim_text(p_actor);
  v_job := app_api.save_job(v_job);
  perform app_api.replace_job_requirements(p_org_id, v_job, p_payload->'requirements', p_actor, v_now);

  return jsonb_build_object(
    'jobNumber', v_job.job_number,
    'warnings', '[]'::jsonb
  );
end;
$$;
