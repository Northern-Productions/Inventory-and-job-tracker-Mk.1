-- Phase 2 security hardening: route Edge staged-pickup service-role mutation through a guarded SQL ACL wrapper.

create or replace function app_api.require_effective_feature_access_for_user(
  p_org_id uuid,
  p_user_id uuid,
  p_feature_area text,
  p_access_mode text
)
returns text
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_role text;
  v_access_status text := '';
  v_feature text := app_api.trim_text(p_feature_area);
  v_mode text := app_api.trim_text(p_access_mode);
  v_allowed boolean := false;
begin
  if p_user_id is null then
    perform app_api.raise_http(401, 'Authenticated session is required.');
  end if;

  if p_org_id is null then
    perform app_api.raise_http(400, 'Organization is required.');
  end if;

  if v_mode not in ('read', 'write') then
    perform app_api.raise_http(400, 'Feature access mode must be read or write.');
  end if;

  select m.role
  into v_role
  from app.organization_members m
  where m.org_id = p_org_id
    and m.user_id = p_user_id;

  if v_role is null then
    perform app_api.raise_http(403, 'You do not have access to this inventory workspace.');
  end if;

  select app_api.trim_text(r.status)
  into v_access_status
  from app.access_requests r
  where r.org_id = p_org_id
    and r.user_id = p_user_id;

  if coalesce(v_access_status, '') <> 'approved' then
    perform app_api.raise_http(403, 'Approved access is required.');
  end if;

  perform app_api.ensure_general_feature_permissions(p_org_id, 'feature-access-check');

  if v_role = 'owner' then
    return v_role;
  end if;

  if v_role = 'member' then
    if v_feature = 'access_management' then
      perform app_api.raise_http(403, 'Feature access denied.');
    end if;

    if v_feature <> all(app_api.member_feature_areas()) then
      perform app_api.raise_http(400, 'Unsupported feature area.');
    end if;

    if v_mode = 'write' then
      perform app_api.raise_http(403, 'Feature access denied.');
    end if;

    select coalesce(g.read_enabled, false)
    into v_allowed
    from app.general_feature_permissions g
    where g.org_id = p_org_id
      and g.feature_area = v_feature;
  elsif v_role = 'admin' then
    if v_feature <> all(app_api.admin_feature_areas()) then
      perform app_api.raise_http(400, 'Unsupported feature area.');
    end if;

    perform app_api.ensure_admin_feature_permissions(
      p_org_id,
      p_user_id,
      true,
      'feature-access-check'
    );

    select
      case
        when v_mode = 'read' then a.read_enabled
        else a.write_enabled
      end
    into v_allowed
    from app.admin_feature_permissions a
    where a.org_id = p_org_id
      and a.admin_user_id = p_user_id
      and a.feature_area = v_feature;
  else
    perform app_api.raise_http(403, 'Feature access denied.');
  end if;

  if not coalesce(v_allowed, false) then
    perform app_api.raise_http(403, 'Feature access denied.');
  end if;

  return v_role;
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
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_job app.jobs;
  v_actor text := app_api.trim_text(p_actor);
  v_job_id_text text := app_api.trim_text(v_payload->>'jobId');
  v_job_id uuid;
  v_supplied_job_number text := app_api.trim_text(coalesce(v_payload->>'jobNumber', v_payload->>'job_number'));
  v_job_number text := '';
  v_flag_text text := lower(app_api.trim_text(
    coalesce(
      v_payload->>'isStagedForPickup',
      v_payload->>'is_staged_for_pickup',
      v_payload->>'staged'
    )
  ));
  v_is_staged boolean;
  v_legacy_warehouse text := '';
  v_legacy_due_date date;
  v_legacy_crew_leader text := '';
  v_legacy_created_at timestamptz;
  v_legacy_updated_at timestamptz;
begin
  if v_flag_text in ('true', 't', '1', 'yes', 'on') then
    v_is_staged := true;
  elsif v_flag_text in ('false', 'f', '0', 'no', 'off') then
    v_is_staged := false;
  else
    perform app_api.raise_http(400, 'isStagedForPickup must be true or false.');
  end if;

  if v_job_id_text <> '' then
    if v_job_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
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
      perform app_api.raise_http(404, format('Job %s was not found.', v_job_id_text));
    end if;

    if v_supplied_job_number <> '' then
      v_job_number := app_api.require_job_number_digits(v_supplied_job_number, 'JobNumber');
      if upper(trim(v_job.job_number)) <> upper(trim(v_job_number)) then
        perform app_api.raise_http(
          409,
          format(
            'Job identity mismatch: jobId %s belongs to job %s, not %s.',
            v_job_id_text,
            coalesce(v_job.job_number, '(unknown)'),
            v_job_number
          )
        );
      end if;
    else
      v_job_number := v_job.job_number;
    end if;
  else
    v_job_number := app_api.require_job_number_digits(v_supplied_job_number, 'JobNumber');

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
    'jobId', v_job.id,
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

create or replace function public.api_acl_jobs_set_staged_pickup_for_user(
  p_org_id uuid,
  p_actor_user_id uuid,
  p_actor text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access_for_user(p_org_id, p_actor_user_id, 'jobs', 'write');
  return public.api_jobs_set_staged_pickup(p_org_id, p_actor, p_payload);
end;
$$;

select app_api.revoke_execute_if_exists('public.api_jobs_set_staged_pickup(uuid, text, jsonb)', 'public');
select app_api.revoke_execute_if_exists('public.api_jobs_set_staged_pickup(uuid, text, jsonb)', 'anon');
select app_api.revoke_execute_if_exists('public.api_jobs_set_staged_pickup(uuid, text, jsonb)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_jobs_set_staged_pickup(uuid, text, jsonb)', 'service_role');

select app_api.revoke_execute_if_exists('public.api_acl_jobs_set_staged_pickup(uuid, text, jsonb)', 'public');
select app_api.revoke_execute_if_exists('public.api_acl_jobs_set_staged_pickup(uuid, text, jsonb)', 'anon');
select app_api.revoke_execute_if_exists('public.api_acl_jobs_set_staged_pickup(uuid, text, jsonb)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_acl_jobs_set_staged_pickup(uuid, text, jsonb)', 'service_role');

select app_api.revoke_execute_if_exists('public.api_acl_jobs_set_staged_pickup_for_user(uuid, uuid, text, jsonb)', 'public');
select app_api.revoke_execute_if_exists('public.api_acl_jobs_set_staged_pickup_for_user(uuid, uuid, text, jsonb)', 'anon');
select app_api.revoke_execute_if_exists('public.api_acl_jobs_set_staged_pickup_for_user(uuid, uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_jobs_set_staged_pickup_for_user(uuid, uuid, text, jsonb)', 'service_role');
