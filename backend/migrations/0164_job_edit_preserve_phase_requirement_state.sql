-- Preserve user-owned phase and requirement state during job edit saves.
-- Omitted workflow/status fields in edit payloads now inherit existing rows
-- instead of replaying creation defaults such as Phase 1 = ACTIVE.

create or replace function app_api.requirement_rows_from_payload_with_ids(p_requirements jsonb)
returns table (
  requirement_id uuid,
  phase_id uuid,
  phase_number integer,
  status text,
  actual_used_feet integer,
  completed_at timestamptz,
  completed_by text,
  manufacturer text,
  film_name text,
  width_in numeric,
  required_feet integer
)
language plpgsql
stable
as $$
declare
  v_value jsonb;
  v_width_in numeric;
  v_required_feet integer;
  v_actual_used_feet integer;
begin
  if p_requirements is not null and jsonb_typeof(p_requirements) = 'array' then
    for v_value in select value from jsonb_array_elements(p_requirements)
    loop
      perform app_api.require_text(v_value->>'manufacturer', 'Requirements[].Manufacturer');
      perform app_api.require_text(v_value->>'filmName', 'Requirements[].FilmName');
      v_width_in := nullif(app_api.trim_text(v_value->>'widthIn'), '')::numeric;
      v_required_feet := floor(nullif(app_api.trim_text(v_value->>'requiredFeet'), '')::numeric);
      v_actual_used_feet := floor(nullif(app_api.trim_text(coalesce(v_value->>'actualUsedFeet', v_value->>'actual_used_feet')), '')::numeric);
      if v_width_in is null or v_width_in <= 0 then
        perform app_api.raise_http(400, 'Requirements[].WidthIn must be greater than zero.');
      end if;
      if v_required_feet is null or v_required_feet <= 0 then
        perform app_api.raise_http(400, 'Requirements[].RequiredFeet must be greater than zero.');
      end if;
      if v_actual_used_feet is not null and v_actual_used_feet < 0 then
        perform app_api.raise_http(400, 'Requirements[].ActualUsedFeet must be zero or greater.');
      end if;
    end loop;
  end if;

  return query
  with source as (
    select value, ordinality
    from jsonb_array_elements(
      case when p_requirements is null or jsonb_typeof(p_requirements) <> 'array' then '[]'::jsonb else p_requirements end
    ) with ordinality
  ),
  normalized as (
    select
      nullif(app_api.trim_text(value->>'requirementId'), '')::uuid as requirement_id,
      nullif(app_api.trim_text(value->>'phaseId'), '')::uuid as phase_id,
      nullif(app_api.trim_text(value->>'phaseNumber'), '')::integer as phase_number,
      case
        when value ? 'status' or value ? 'requirementStatus'
          then app_api.normalize_requirement_status(coalesce(value->>'status', value->>'requirementStatus'))
        else null
      end as status,
      case
        when value ? 'actualUsedFeet' or value ? 'actual_used_feet'
          then greatest(
            coalesce(
              floor(nullif(app_api.trim_text(coalesce(value->>'actualUsedFeet', value->>'actual_used_feet')), '')::numeric)::integer,
              0
            ),
            0
          )
        else null
      end as actual_used_feet,
      nullif(app_api.trim_text(coalesce(value->>'completedAt', value->>'completed_at')), '')::timestamptz as completed_at,
      app_api.trim_text(coalesce(value->>'completedBy', value->>'completed_by')) as completed_by,
      app_api.canonical_manufacturer_label(value->>'manufacturer') as manufacturer,
      app_api.normalize_collapsed_catalog_label(value->>'filmName') as film_name,
      (nullif(app_api.trim_text(value->>'widthIn'), '')::numeric) as width_in,
      floor(nullif(app_api.trim_text(value->>'requiredFeet'), '')::numeric)::integer as required_feet,
      ordinality
    from source
  )
  select
    (array_agg(n.requirement_id order by n.ordinality) filter (where n.requirement_id is not null))[1],
    n.phase_id,
    n.phase_number,
    (array_agg(n.status order by n.ordinality) filter (where n.status is not null))[1],
    (array_agg(n.actual_used_feet order by n.ordinality) filter (where n.actual_used_feet is not null))[1],
    (array_agg(n.completed_at order by n.ordinality) filter (where n.completed_at is not null))[1],
    coalesce((array_agg(nullif(n.completed_by, '') order by n.ordinality) filter (where nullif(n.completed_by, '') is not null))[1], ''),
    n.manufacturer,
    n.film_name,
    n.width_in,
    sum(n.required_feet)::integer
  from normalized n
  group by n.phase_id, n.phase_number, n.manufacturer, n.film_name, n.width_in
  order by coalesce(n.phase_number, 1), lower(n.manufacturer), lower(n.film_name), n.width_in;
end;
$$;

create or replace function app_api.caulk_requirement_rows_from_payload(p_requirements jsonb)
returns table (
  requirement_id uuid,
  phase_id uuid,
  phase_number integer,
  product_id uuid,
  required_tubes integer,
  status text,
  actual_used_tubes integer,
  completed_at timestamptz,
  completed_by text
)
language plpgsql
stable
as $$
declare
  v_value jsonb;
  v_product_id uuid;
  v_required_tubes integer;
  v_actual_used_tubes integer;
begin
  if p_requirements is not null and jsonb_typeof(p_requirements) = 'array' then
    for v_value in select value from jsonb_array_elements(p_requirements)
    loop
      v_product_id := nullif(app_api.trim_text(v_value->>'productId'), '')::uuid;
      v_required_tubes := floor(nullif(app_api.trim_text(v_value->>'requiredTubes'), '')::numeric);
      v_actual_used_tubes := floor(nullif(app_api.trim_text(coalesce(v_value->>'actualUsedTubes', v_value->>'actual_used_tubes')), '')::numeric);
      if v_product_id is null then
        perform app_api.raise_http(400, 'caulkRequirements[].productId is required.');
      end if;
      if v_required_tubes is null or v_required_tubes <= 0 then
        perform app_api.raise_http(400, 'caulkRequirements[].requiredTubes must be greater than zero.');
      end if;
      if v_actual_used_tubes is not null and v_actual_used_tubes < 0 then
        perform app_api.raise_http(400, 'caulkRequirements[].actualUsedTubes must be zero or greater.');
      end if;
    end loop;
  end if;

  return query
  with normalized as (
    select
      nullif(app_api.trim_text(value->>'requirementId'), '')::uuid as requirement_id,
      nullif(app_api.trim_text(value->>'phaseId'), '')::uuid as phase_id,
      nullif(app_api.trim_text(value->>'phaseNumber'), '')::integer as phase_number,
      (nullif(app_api.trim_text(value->>'productId'), '')::uuid) as product_id,
      floor(nullif(app_api.trim_text(value->>'requiredTubes'), '')::numeric)::integer as required_tubes,
      case
        when value ? 'status' or value ? 'requirementStatus'
          then app_api.normalize_requirement_status(coalesce(value->>'status', value->>'requirementStatus'))
        else null
      end as status,
      case
        when value ? 'actualUsedTubes' or value ? 'actual_used_tubes'
          then greatest(
            coalesce(
              floor(nullif(app_api.trim_text(coalesce(value->>'actualUsedTubes', value->>'actual_used_tubes')), '')::numeric)::integer,
              0
            ),
            0
          )
        else null
      end as actual_used_tubes,
      nullif(app_api.trim_text(coalesce(value->>'completedAt', value->>'completed_at')), '')::timestamptz as completed_at,
      app_api.trim_text(coalesce(value->>'completedBy', value->>'completed_by')) as completed_by,
      ordinality
    from jsonb_array_elements(
      case when p_requirements is null or jsonb_typeof(p_requirements) <> 'array' then '[]'::jsonb else p_requirements end
    ) with ordinality
  )
  select
    (array_agg(n.requirement_id order by n.ordinality) filter (where n.requirement_id is not null))[1],
    n.phase_id,
    n.phase_number,
    n.product_id,
    sum(n.required_tubes)::integer,
    (array_agg(n.status order by n.ordinality) filter (where n.status is not null))[1],
    max(n.actual_used_tubes)::integer,
    (array_agg(n.completed_at order by n.ordinality) filter (where n.completed_at is not null))[1],
    coalesce((array_agg(nullif(n.completed_by, '') order by n.ordinality) filter (where nullif(n.completed_by, '') is not null))[1], '')
  from normalized n
  group by n.phase_id, n.phase_number, n.product_id
  order by coalesce(n.phase_number, 1), n.product_id;
end;
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
  v_existing_workflow_status text;
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

    v_next_id := null;
    v_existing_workflow_status := null;
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

    if v_phase.phase_id is not null then
      select id, workflow_status into v_next_id, v_existing_workflow_status
      from app.job_phases
      where org_id = p_org_id
        and job_id = p_job.id
        and id = v_phase.phase_id
      for update;
      if not found then
        perform app_api.raise_http(400, 'Phase does not belong to this job.');
      end if;
    else
      select id, workflow_status into v_next_id, v_existing_workflow_status
      from app.job_phases
      where org_id = p_org_id
        and job_id = p_job.id
        and phase_number = v_phase.phase_number
      for update;
    end if;

    v_workflow_status := app_api.normalize_job_phase_workflow_status(
      coalesce(nullif(v_workflow_text, ''), v_existing_workflow_status, case when v_phase.phase_number = 1 then 'ACTIVE' else 'PLACEHOLDER' end)
    );

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

  update app.job_phases p
  set is_primary = true,
      updated_at = p_now,
      updated_by = app_api.trim_text(p_actor)
  where p.org_id = p_org_id
    and p.job_id = p_job.id
    and not exists (
      select 1
      from app.job_phases primary_phase
      where primary_phase.org_id = p_org_id
        and primary_phase.job_id = p_job.id
        and primary_phase.is_primary
    )
    and p.phase_number = (
      select min(p2.phase_number)
      from app.job_phases p2
      where p2.org_id = p_org_id
        and p2.job_id = p_job.id
    );

  delete from app.job_phases p
  where p.org_id = p_org_id
    and p.job_id = p_job.id
    and p.phase_number <> all(v_seen);
end;
$$;

do $$
declare
  v_def text;
begin
  select pg_get_functiondef('app_api.replace_job_phases(uuid, app.jobs, jsonb, text, timestamp with time zone)'::regprocedure)
    into v_def;
  if position('v_existing_workflow_status' in v_def) = 0
     or position('nullif(v_workflow_text, '''')' in v_def) = 0 then
    raise exception 'app_api.replace_job_phases can still replay creation workflow defaults during edit';
  end if;

  select pg_get_functiondef('app_api.requirement_rows_from_payload_with_ids(jsonb)'::regprocedure)
    into v_def;
  if position('value ? ''status''' in v_def) = 0
     or position('filter (where n.status is not null)' in v_def) = 0 then
    raise exception 'app_api.requirement_rows_from_payload_with_ids can still default omitted status to ACTIVE';
  end if;

  select pg_get_functiondef('app_api.caulk_requirement_rows_from_payload(jsonb)'::regprocedure)
    into v_def;
  if position('value ? ''status''' in v_def) = 0
     or position('filter (where n.status is not null)' in v_def) = 0 then
    raise exception 'app_api.caulk_requirement_rows_from_payload can still default omitted status to ACTIVE';
  end if;
end $$;

select app_api.grant_execute_if_exists('app_api.requirement_rows_from_payload_with_ids(jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.requirement_rows_from_payload_with_ids(jsonb)', 'service_role');
select app_api.grant_execute_if_exists('app_api.caulk_requirement_rows_from_payload(jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.caulk_requirement_rows_from_payload(jsonb)', 'service_role');
select app_api.grant_execute_if_exists('app_api.replace_job_phases(uuid, app.jobs, jsonb, text, timestamptz)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.replace_job_phases(uuid, app.jobs, jsonb, text, timestamptz)', 'service_role');
