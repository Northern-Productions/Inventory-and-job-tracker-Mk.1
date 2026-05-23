-- Add Active / Placeholder workflow state for job phases.

alter table app.job_phases
  add column if not exists workflow_status text not null default 'ACTIVE';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'app.job_phases'::regclass
      and conname = 'job_phases_workflow_status_check'
  ) then
    alter table app.job_phases
      add constraint job_phases_workflow_status_check
      check (workflow_status in ('ACTIVE', 'PLACEHOLDER'));
  end if;
end;
$$;

update app.job_phases
set workflow_status = case when phase_number = 1 then 'ACTIVE' else 'PLACEHOLDER' end
where workflow_status is distinct from case when phase_number = 1 then 'ACTIVE' else 'PLACEHOLDER' end;

create or replace function app_api.normalize_job_phase_workflow_status(p_value text)
returns text
language sql
immutable
as $$
  select case when upper(trim(coalesce(p_value, ''))) = 'PLACEHOLDER' then 'PLACEHOLDER' else 'ACTIVE' end
$$;

create or replace function app_api.replace_job_phases(
  p_org_id uuid,
  p_job app.jobs,
  p_payload jsonb,
  p_actor text,
  p_now timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_phase record;
  v_seen integer[] := array[]::integer[];
  v_next_id uuid;
  v_install_end_text text;
  v_install_end_date date;
  v_workflow_text text;
  v_workflow_status text;
begin
  set constraints job_phases_org_job_phase_number_unique deferred;

  update app.job_phases p
  set is_primary = false,
      updated_at = p_now,
      updated_by = app_api.trim_text(p_actor)
  where p.org_id = p_org_id
    and p.job_id = p_job.id
    and p.is_primary;

  for v_phase in
    select * from app_api.job_phase_rows_from_payload(p_payload)
  loop
    if v_phase.phase_number = any(v_seen) then
      perform app_api.raise_http(400, format('Phase %s already exists on this job.', v_phase.phase_number));
    end if;
    v_seen := array_append(v_seen, v_phase.phase_number);

    v_install_end_text := '';
    v_workflow_text := '';
    if p_payload ? 'phases' and jsonb_typeof(p_payload->'phases') = 'array' then
      select
        app_api.trim_text(coalesce(phase.value->>'installEndDate', phase.value->>'install_end_date', phase.value->>'endDate')),
        app_api.trim_text(coalesce(phase.value->>'workflowStatus', phase.value->>'workflow_status', phase.value->>'phaseWorkflowStatus'))
        into v_install_end_text, v_workflow_text
      from jsonb_array_elements(p_payload->'phases') with ordinality as phase(value, phase_ordinality)
      where phase.phase_ordinality = v_phase.ordinality;
    else
      v_install_end_text := app_api.trim_text(coalesce(p_payload->>'installEndDate', p_payload->>'install_end_date', p_payload->>'endDate'));
      v_workflow_text := app_api.trim_text(coalesce(p_payload->>'workflowStatus', p_payload->>'workflow_status', p_payload->>'phaseWorkflowStatus'));
    end if;

    v_install_end_date := null;
    if coalesce(v_install_end_text, '') <> '' then
      if v_phase.install_date is null then
        perform app_api.raise_http(400, 'Install End Date requires an Install Date.');
      end if;
      if v_install_end_text !~ '^\d{4}-\d{2}-\d{2}$' then
        perform app_api.raise_http(400, 'Install End Date must use yyyy-mm-dd.');
      end if;
      begin
        v_install_end_date := v_install_end_text::date;
      exception when others then
        perform app_api.raise_http(400, 'Install End Date must use yyyy-mm-dd.');
      end;
      if v_install_end_date < v_phase.install_date then
        perform app_api.raise_http(400, 'Install End Date must be the same day as or later than Install Date.');
      end if;
    end if;

    v_workflow_status := app_api.normalize_job_phase_workflow_status(
      coalesce(v_workflow_text, case when v_phase.phase_number = 1 then 'ACTIVE' else 'PLACEHOLDER' end)
    );

    if v_phase.phase_id is not null then
      select id into v_next_id
      from app.job_phases
      where org_id = p_org_id
        and job_id = p_job.id
        and id = v_phase.phase_id
      for update;
      if not found then
        perform app_api.raise_http(400, 'Phase does not belong to this job.');
      end if;
    else
      select id into v_next_id
      from app.job_phases
      where org_id = p_org_id
        and job_id = p_job.id
        and phase_number = v_phase.phase_number
      for update;
    end if;

    insert into app.job_phases (
      id,
      org_id,
      job_id,
      phase_number,
      sections,
      install_date,
      install_end_date,
      crew_leader,
      labor_status,
      workflow_status,
      is_primary,
      created_at,
      created_by,
      updated_at,
      updated_by
    )
    values (
      coalesce(v_next_id, gen_random_uuid()),
      p_org_id,
      p_job.id,
      v_phase.phase_number,
      v_phase.sections,
      v_phase.install_date,
      v_install_end_date,
      v_phase.crew_leader,
      v_phase.labor_status,
      v_workflow_status,
      v_phase.is_primary,
      p_now,
      app_api.trim_text(p_actor),
      p_now,
      app_api.trim_text(p_actor)
    )
    on conflict (id) do update set
      phase_number = excluded.phase_number,
      sections = excluded.sections,
      install_date = excluded.install_date,
      install_end_date = excluded.install_end_date,
      crew_leader = excluded.crew_leader,
      labor_status = excluded.labor_status,
      workflow_status = excluded.workflow_status,
      is_primary = excluded.is_primary,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by;
  end loop;

  update app.job_phases p
  set is_primary = false,
      updated_at = p_now,
      updated_by = app_api.trim_text(p_actor)
  where p.org_id = p_org_id
    and p.job_id = p_job.id
    and p.phase_number <> (
      select min(p2.phase_number)
      from app.job_phases p2
      where p2.org_id = p_org_id
        and p2.job_id = p_job.id
        and p2.is_primary
    )
    and p.is_primary;

  if not exists (
    select 1 from app.job_phases p
    where p.org_id = p_org_id
      and p.job_id = p_job.id
      and p.is_primary
  ) then
    update app.job_phases p
    set is_primary = true,
        updated_at = p_now,
        updated_by = app_api.trim_text(p_actor)
    where p.id = (
      select p2.id from app.job_phases p2
      where p2.org_id = p_org_id
        and p2.job_id = p_job.id
      order by p2.phase_number asc, p2.created_at asc
      limit 1
    );
  end if;
end;
$$;

create or replace function public.api_acl_jobs_clear_staged_for_active_requirement(
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
  v_requirement_id_text text := app_api.require_text(p_payload->>'requirementId', 'RequirementId');
  v_material_type text := upper(app_api.trim_text(coalesce(p_payload->>'materialType', p_payload->>'material_type', 'FILM')));
  v_requirement_id uuid;
  v_job_id uuid := null;
  v_job_number text := '';
  v_cleared boolean := false;
  v_warnings jsonb := '[]'::jsonb;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'write');

  begin
    v_requirement_id := v_requirement_id_text::uuid;
  exception when others then
    perform app_api.raise_http(400, 'RequirementId must be a valid UUID.');
  end;

  if v_material_type = 'CAULK' then
    update app.jobs j
    set is_staged_for_pickup = false,
        updated_at = timezone('utc', now()),
        updated_by = app_api.trim_text(p_actor)
    from app.job_caulk_requirements r
    left join app.job_phases p
      on p.org_id = r.org_id
     and p.job_id = r.job_id
     and p.id = r.phase_id
    where j.org_id = p_org_id
      and j.id = r.job_id
      and j.is_staged_for_pickup = true
      and r.org_id = j.org_id
      and r.id = v_requirement_id
      and coalesce(p.workflow_status, 'ACTIVE') = 'ACTIVE'
    returning j.id, j.job_number into v_job_id, v_job_number;
  else
    update app.jobs j
    set is_staged_for_pickup = false,
        updated_at = timezone('utc', now()),
        updated_by = app_api.trim_text(p_actor)
    from app.job_requirements r
    left join app.job_phases p
      on p.org_id = r.org_id
     and p.job_id = r.job_id
     and p.id = r.phase_id
    where j.org_id = p_org_id
      and j.id = r.job_id
      and j.is_staged_for_pickup = true
      and r.org_id = j.org_id
      and r.id = v_requirement_id
      and coalesce(p.workflow_status, 'ACTIVE') = 'ACTIVE'
    returning j.id, j.job_number into v_job_id, v_job_number;
  end if;

  v_cleared := v_job_id is not null;
  if v_cleared then
    v_warnings := jsonb_build_array('Staged pickup was cleared because active phase material changed.');
  end if;

  return jsonb_build_object(
    'jobId', v_job_id,
    'jobNumber', v_job_number,
    'requirementId', v_requirement_id,
    'cleared', v_cleared,
    'warnings', v_warnings
  );
end;
$$;

create or replace function public.api_acl_job_phase_set_state(
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
  v_job_id_text text := app_api.trim_text(p_payload->>'jobId');
  v_job_number text := app_api.trim_text(p_payload->>'jobNumber');
  v_phase_id_text text := app_api.require_text(p_payload->>'phaseId', 'PhaseId');
  v_has_labor_status boolean := p_payload ? 'status' or p_payload ? 'laborStatus' or p_payload ? 'labor_status';
  v_has_workflow_status boolean := p_payload ? 'workflowStatus' or p_payload ? 'workflow_status' or p_payload ? 'phaseWorkflowStatus';
  v_status text := app_api.normalize_job_phase_labor_status(coalesce(p_payload->>'status', p_payload->>'laborStatus', p_payload->>'labor_status'));
  v_workflow_status text := app_api.normalize_job_phase_workflow_status(coalesce(p_payload->>'workflowStatus', p_payload->>'workflow_status', p_payload->>'phaseWorkflowStatus'));
  v_job_id uuid := null;
  v_phase_id uuid;
  v_job app.jobs;
  v_match_count integer := 0;
  v_warnings jsonb := '[]'::jsonb;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'write');
  if not v_has_labor_status and not v_has_workflow_status then
    perform app_api.raise_http(400, 'Phase state update requires a status or workflowStatus.');
  end if;

  begin
    v_phase_id := v_phase_id_text::uuid;
  exception when others then
    perform app_api.raise_http(400, 'PhaseId must be a valid UUID.');
  end;

  if v_job_id_text <> '' then
    begin
      v_job_id := v_job_id_text::uuid;
    exception when others then
      perform app_api.raise_http(400, 'jobId must be a valid UUID.');
    end;
    select * into v_job from app.jobs j where j.org_id = p_org_id and j.id = v_job_id for update;
    if not found then
      perform app_api.raise_http(404, 'Job was not found.');
    end if;
    if v_job_number <> '' and upper(trim(v_job.job_number)) <> upper(trim(v_job_number)) then
      perform app_api.raise_http(400, 'Job identity mismatch: selected job does not match jobNumber.');
    end if;
  else
    v_job_number := app_api.require_text(v_job_number, 'JobNumber');
    select count(*)::integer into v_match_count
    from app.jobs j
    where j.org_id = p_org_id
      and upper(trim(j.job_number)) = upper(trim(v_job_number));
    if v_match_count = 0 then
      perform app_api.raise_http(404, format('Job %s was not found.', v_job_number));
    end if;
    if v_match_count > 1 then
      perform app_api.raise_http(409, format('Job %s has multiple work scopes. Open the exact job before changing phase state.', v_job_number));
    end if;
    select * into v_job
    from app.jobs j
    where j.org_id = p_org_id
      and upper(trim(j.job_number)) = upper(trim(v_job_number))
    for update;
    v_job_id := v_job.id;
  end if;

  if coalesce(v_job.lifecycle_status::text, 'ACTIVE') <> 'ACTIVE' then
    perform app_api.raise_http(400, format('Job %s is closed. Reopen it before changing phase state.', v_job.job_number));
  end if;

  update app.job_phases
  set labor_status = case when v_has_labor_status then v_status else labor_status end,
      workflow_status = case when v_has_workflow_status then v_workflow_status else workflow_status end,
      updated_at = timezone('utc', now()),
      updated_by = app_api.trim_text(p_actor)
  where org_id = p_org_id
    and job_id = v_job_id
    and id = v_phase_id;

  if not found then
    perform app_api.raise_http(404, 'Job phase was not found.');
  end if;

  if v_has_workflow_status
    and v_workflow_status = 'ACTIVE'
    and v_job.is_staged_for_pickup
    and (
      exists (
        select 1
        from app.job_requirements r
        where r.org_id = p_org_id
          and r.job_id = v_job_id
          and r.phase_id = v_phase_id
          and coalesce(r.status::text, 'ACTIVE') = 'ACTIVE'
          and coalesce(r.required_feet, 0) > coalesce(r.actual_used_feet, 0) + coalesce((
            select sum(greatest(coalesce(nullif(a.covered_feet, 0), a.allocated_feet, 0), 0))::integer
            from app.allocations a
            where a.org_id = p_org_id
              and a.requirement_id = r.id
              and a.status = 'ACTIVE'
          ), 0)
      )
      or exists (
        select 1
        from app.job_caulk_requirements cr
        where cr.org_id = p_org_id
          and cr.job_id = v_job_id
          and cr.phase_id = v_phase_id
          and coalesce(cr.status::text, 'ACTIVE') = 'ACTIVE'
          and coalesce(cr.required_tubes, 0) > coalesce(cr.actual_used_tubes, 0) + coalesce((
            select sum(greatest(ca.allocated_tubes, 0))::integer
            from app.caulk_job_allocations ca
            where ca.org_id = p_org_id
              and ca.requirement_id = cr.id
              and ca.status = 'ACTIVE'
          ), 0)
      )
      or exists (
        select 1
        from app.allocations a
        join app.job_requirements r
          on r.org_id = a.org_id
         and r.id = a.requirement_id
        where a.org_id = p_org_id
          and r.job_id = v_job_id
          and r.phase_id = v_phase_id
          and coalesce(r.status::text, 'ACTIVE') = 'ACTIVE'
          and a.status = 'ACTIVE'
          and a.resolved_at is null
          and coalesce(a.allocated_feet, 0) > 0
      )
      or exists (
        select 1
        from app.caulk_job_allocations ca
        join app.job_caulk_requirements cr
          on cr.org_id = ca.org_id
         and cr.id = ca.requirement_id
        where ca.org_id = p_org_id
          and cr.job_id = v_job_id
          and cr.phase_id = v_phase_id
          and coalesce(cr.status::text, 'ACTIVE') = 'ACTIVE'
          and ca.status = 'ACTIVE'
          and coalesce(ca.reserved_tubes_remaining, 0) > 0
      )
      or exists (
        select 1
        from app.film_orders fo
        join app.job_requirements r
          on r.org_id = fo.org_id
         and r.id = fo.requirement_id
        where fo.org_id = p_org_id
          and r.job_id = v_job_id
          and r.phase_id = v_phase_id
          and coalesce(r.status::text, 'ACTIVE') = 'ACTIVE'
          and fo.status in ('FILM_ORDER', 'FILM_ON_THE_WAY')
      )
    )
  then
    update app.jobs
    set is_staged_for_pickup = false,
        updated_at = timezone('utc', now()),
        updated_by = app_api.trim_text(p_actor)
    where org_id = p_org_id
      and id = v_job_id;
    v_warnings := jsonb_build_array('Staged pickup was cleared because a placeholder phase with current material needs was activated.');
  end if;

  perform app_api.reconcile_auto_planned_allocations(
    p_org_id,
    p_actor,
    jsonb_build_object('jobIds', jsonb_build_array(v_job_id::text), 'jobNumbers', jsonb_build_array(v_job.job_number))
  );

  return jsonb_build_object(
    'jobId', v_job.id,
    'jobNumber', v_job.job_number,
    'phaseId', v_phase_id,
    'status', case when v_has_labor_status then v_status else null end,
    'workflowStatus', case when v_has_workflow_status then v_workflow_status else null end,
    'warnings', v_warnings
  );
end;
$$;

select app_api.grant_execute_if_exists('app_api.normalize_job_phase_workflow_status(text)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.normalize_job_phase_workflow_status(text)', 'service_role');
select app_api.grant_execute_if_exists('app_api.replace_job_phases(uuid, app.jobs, jsonb, text, timestamptz)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.replace_job_phases(uuid, app.jobs, jsonb, text, timestamptz)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_jobs_clear_staged_for_active_requirement(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_jobs_clear_staged_for_active_requirement(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_job_phase_set_state(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_job_phase_set_state(uuid, text, jsonb)', 'service_role');
