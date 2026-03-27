alter table app.jobs
  add column if not exists is_staged_for_pickup boolean not null default false;

create index if not exists idx_jobs_org_due_date_lifecycle
  on app.jobs (org_id, due_date desc, lifecycle_status, job_number);

create or replace function public.api_jobs_calendar(
  p_org_id uuid,
  p_month text,
  p_lifecycle_status text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_result jsonb;
  v_month text := app_api.trim_text(p_month);
  v_lifecycle text := upper(app_api.trim_text(p_lifecycle_status));
  v_start date;
  v_end date;
begin
  perform app_api.require_org_member(p_org_id);

  if v_month !~ '^\d{4}-\d{2}$' then
    perform app_api.raise_http(400, 'month must use yyyy-mm.');
  end if;

  if v_lifecycle = '' then
    v_lifecycle := 'ACTIVE';
  end if;

  if v_lifecycle not in ('ACTIVE', 'COMPLETED') then
    perform app_api.raise_http(400, 'lifecycleStatus must be ACTIVE or COMPLETED.');
  end if;

  v_start := (v_month || '-01')::date;
  v_end := (v_start + interval '1 month')::date;

  select coalesce(
    jsonb_agg(to_jsonb(j) order by j.due_date asc nulls last, j.job_number asc),
    '[]'::jsonb
  )
  into v_result
  from app.jobs j
  where j.org_id = p_org_id
    and j.due_date >= v_start
    and j.due_date < v_end
    and j.lifecycle_status::text = v_lifecycle;

  return v_result;
end;
$$;

create or replace function public.api_acl_list_jobs_calendar(
  p_org_id uuid,
  p_month text,
  p_lifecycle_status text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'read');
  return public.api_jobs_calendar(p_org_id, p_month, p_lifecycle_status);
end;
$$;

create or replace function public.api_jobs_set_staged_pickup(
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
  v_actor text := app_api.trim_text(p_actor);
  v_job_number text := app_api.require_job_number_digits(
    coalesce(p_payload->>'jobNumber', p_payload->>'job_number'),
    'JobNumber'
  );
  v_flag_text text := lower(app_api.trim_text(
    coalesce(
      p_payload->>'isStagedForPickup',
      p_payload->>'is_staged_for_pickup',
      p_payload->>'staged'
    )
  ));
  v_is_staged boolean;
  v_legacy_warehouse text := '';
  v_legacy_due_date date;
  v_legacy_crew_leader text := '';
  v_legacy_created_at timestamptz;
  v_legacy_updated_at timestamptz;
begin
  perform app_api.require_org_member(p_org_id);

  if v_flag_text in ('true', 't', '1', 'yes', 'on') then
    v_is_staged := true;
  elsif v_flag_text in ('false', 'f', '0', 'no', 'off') then
    v_is_staged := false;
  else
    perform app_api.raise_http(400, 'isStagedForPickup must be true or false.');
  end if;

  select *
  into v_job
  from app.jobs j
  where j.org_id = p_org_id
    and upper(trim(j.job_number)) = upper(trim(v_job_number))
  for update;

  if not found then
    select
      coalesce(min(src.warehouse), ''),
      min(src.job_date),
      coalesce(min(src.crew_leader), ''),
      min(src.created_at),
      max(src.updated_at)
    into
      v_legacy_warehouse,
      v_legacy_due_date,
      v_legacy_crew_leader,
      v_legacy_created_at,
      v_legacy_updated_at
    from (
      select
        a.warehouse,
        a.job_date,
        nullif(a.crew_leader, '') as crew_leader,
        a.created_at,
        coalesce(a.resolved_at, a.created_at) as updated_at
      from app.allocations a
      where a.org_id = p_org_id
        and upper(trim(a.job_number)) = upper(trim(v_job_number))

      union all

      select
        f.warehouse,
        f.job_date,
        nullif(f.crew_leader, '') as crew_leader,
        f.created_at,
        coalesce(f.resolved_at, f.created_at) as updated_at
      from app.film_orders f
      where f.org_id = p_org_id
        and upper(trim(f.job_number)) = upper(trim(v_job_number))
    ) src;

    if v_legacy_created_at is null then
      perform app_api.raise_http(404, format('Job %s was not found.', v_job_number));
    end if;

    v_job.id := gen_random_uuid();
    v_job.org_id := p_org_id;
    v_job.job_number := v_job_number;
    v_job.warehouse := v_legacy_warehouse;
    v_job.sections := null;
    v_job.due_date := v_legacy_due_date;
    v_job.crew_leader := v_legacy_crew_leader;
    v_job.lifecycle_status := 'ACTIVE';
    v_job.is_staged_for_pickup := false;
    v_job.notes := '';
    v_job.created_at := coalesce(v_legacy_created_at, now());
    v_job.created_by := v_actor;
    v_job.updated_at := coalesce(v_legacy_updated_at, now());
    v_job.updated_by := v_actor;
    v_job := app_api.save_job(v_job);
  end if;

  if v_job.lifecycle_status::text <> 'ACTIVE' then
    perform app_api.raise_http(
      400,
      format('Job %s is closed and staged pickup cannot be changed.', v_job_number)
    );
  end if;

  update app.jobs
  set
    is_staged_for_pickup = v_is_staged,
    updated_at = now(),
    updated_by = v_actor
  where id = v_job.id
    and org_id = p_org_id
  returning * into v_job;

  return jsonb_build_object(
    'jobNumber', v_job.job_number,
    'isStagedForPickup', v_job.is_staged_for_pickup,
    'updatedAt', to_char(v_job.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'warnings', '[]'::jsonb
  );
end;
$$;

create or replace function public.api_acl_jobs_set_staged_pickup(
  p_org_id uuid,
  p_actor text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'write');
  return public.api_jobs_set_staged_pickup(p_org_id, p_actor, p_payload);
end;
$$;

select app_api.revoke_execute_if_exists('public.api_jobs_calendar(uuid, text, text)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_jobs_set_staged_pickup(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_jobs_calendar(uuid, text, text)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_jobs_set_staged_pickup(uuid, text, jsonb)', 'authenticated');
