/**
 * PURPOSE:
 * Track caulk requirement actual used tubes and user-controlled Active/Complete
 * state, matching the film requirement actual-usage model.
 *
 * AFFECTS:
 * app.job_caulk_requirements, caulk checkout/check-in reconciliation, auto
 * planning, public caulk requirement reads, and the shared requirement-state RPC.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * backend runtimeAllocationCoverage/runtimeJobSummaries/jobsRepository,
 * Supabase Edge api-handler/inventoryRepositories, frontend caulk requirement
 * UI/cache, and schema/latest checks.
 *
 * COMMON FAILURE MODES:
 * Leaving checked-in caulk allocations ACTIVE, erasing actual usage during job
 * edits, counting Complete caulk requirements as material demand, or guessing a
 * legacy requirement match when multiple phase/product rows exist.
 */

alter table app.job_caulk_requirements
  add column if not exists status text not null default 'ACTIVE',
  add column if not exists actual_used_tubes integer not null default 0,
  add column if not exists completed_at timestamptz,
  add column if not exists completed_by text not null default '';

update app.job_caulk_requirements
set status = 'ACTIVE'
where status is null or upper(trim(status)) not in ('ACTIVE', 'COMPLETE');

update app.job_caulk_requirements
set actual_used_tubes = 0
where actual_used_tubes is null or actual_used_tubes < 0;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'job_caulk_requirements_status_check'
      and conrelid = 'app.job_caulk_requirements'::regclass
  ) then
    alter table app.job_caulk_requirements
      add constraint job_caulk_requirements_status_check
      check (status in ('ACTIVE', 'COMPLETE'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'job_caulk_requirements_actual_used_tubes_check'
      and conrelid = 'app.job_caulk_requirements'::regclass
  ) then
    alter table app.job_caulk_requirements
      add constraint job_caulk_requirements_actual_used_tubes_check
      check (actual_used_tubes >= 0);
  end if;
end $$;

create index if not exists job_caulk_requirements_active_planning_idx
  on app.job_caulk_requirements (org_id, job_id, status);

drop function if exists app_api.caulk_requirement_rows_from_payload(jsonb);

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
      app_api.normalize_requirement_status(coalesce(value->>'status', value->>'requirementStatus')) as status,
      greatest(
        coalesce(
          floor(nullif(app_api.trim_text(coalesce(value->>'actualUsedTubes', value->>'actual_used_tubes')), '')::numeric)::integer,
          0
        ),
        0
      ) as actual_used_tubes,
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
    case when bool_or(n.status = 'COMPLETE') then 'COMPLETE' else 'ACTIVE' end,
    max(n.actual_used_tubes)::integer,
    (array_agg(n.completed_at order by n.ordinality) filter (where n.completed_at is not null))[1],
    coalesce((array_agg(nullif(n.completed_by, '') order by n.ordinality) filter (where nullif(n.completed_by, '') is not null))[1], '')
  from normalized n
  group by n.phase_id, n.phase_number, n.product_id
  order by coalesce(n.phase_number, 1), n.product_id;
end;
$$;

create or replace function app_api.replace_job_caulk_requirements(
  p_org_id uuid,
  p_job app.jobs,
  p_requirements jsonb,
  p_actor text,
  p_now timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_requirement record;
  v_existing app.job_caulk_requirements;
  v_default_phase_id uuid;
  v_phase_id uuid;
  v_next_id uuid;
  v_next_status text;
  v_retained_ids uuid[] := array[]::uuid[];
begin
  select id into v_default_phase_id
  from app.job_phases
  where org_id = p_org_id
    and job_id = p_job.id
    and is_primary
  order by phase_number asc
  limit 1;

  for v_requirement in
    select * from app_api.caulk_requirement_rows_from_payload(p_requirements)
  loop
    v_existing := null;
    v_phase_id := coalesce(v_requirement.phase_id, v_default_phase_id);
    if v_phase_id is null then
      perform app_api.raise_http(400, 'Caulk requirement phase is required.');
    end if;

    if v_requirement.requirement_id is not null then
      select * into v_existing
      from app.job_caulk_requirements r
      where r.org_id = p_org_id
        and r.job_id = p_job.id
        and r.id = v_requirement.requirement_id
        and not (r.id = any(v_retained_ids))
      limit 1;
    end if;

    if v_existing.id is null then
      select * into v_existing
      from app.job_caulk_requirements r
      where r.org_id = p_org_id
        and r.job_id = p_job.id
        and r.phase_id = v_phase_id
        and r.product_id = v_requirement.product_id
        and not (r.id = any(v_retained_ids))
      limit 1;
    end if;

    v_next_id := coalesce(v_existing.id, gen_random_uuid());
    v_next_status := coalesce(v_requirement.status, v_existing.status, 'ACTIVE');
    v_retained_ids := array_append(v_retained_ids, v_next_id);

    insert into app.job_caulk_requirements (
      id,
      org_id,
      job_id,
      phase_id,
      product_id,
      required_tubes,
      status,
      actual_used_tubes,
      completed_at,
      completed_by,
      notes,
      created_at,
      created_by,
      updated_at,
      updated_by
    )
    values (
      v_next_id,
      p_org_id,
      p_job.id,
      v_phase_id,
      v_requirement.product_id,
      v_requirement.required_tubes,
      v_next_status,
      case
        when v_existing.id is null then coalesce(v_requirement.actual_used_tubes, 0)
        else greatest(coalesce(v_existing.actual_used_tubes, 0), coalesce(v_requirement.actual_used_tubes, 0))
      end,
      case when v_next_status = 'COMPLETE'
        then coalesce(v_requirement.completed_at, v_existing.completed_at, p_now)
        else null
      end,
      case when v_next_status = 'COMPLETE'
        then coalesce(nullif(v_requirement.completed_by, ''), v_existing.completed_by, app_api.trim_text(p_actor))
        else ''
      end,
      coalesce(v_existing.notes, ''),
      coalesce(v_existing.created_at, p_now),
      coalesce(v_existing.created_by, app_api.trim_text(p_actor)),
      p_now,
      app_api.trim_text(p_actor)
    )
    on conflict (id) do update set
      phase_id = excluded.phase_id,
      product_id = excluded.product_id,
      required_tubes = excluded.required_tubes,
      status = excluded.status,
      actual_used_tubes = excluded.actual_used_tubes,
      completed_at = excluded.completed_at,
      completed_by = excluded.completed_by,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by;
  end loop;

  delete from app.job_caulk_requirements
  where org_id = p_org_id
    and job_id = p_job.id
    and not (id = any(v_retained_ids));
end;
$$;

create or replace function app_api.record_caulk_requirement_actual_usage_for_checkin(
  p_org_id uuid,
  p_actor text,
  p_caulk_allocation_id text,
  p_used_tubes integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_used_tubes integer := greatest(coalesce(p_used_tubes, 0), 0);
  v_caulk_allocation_id text := app_api.trim_text(p_caulk_allocation_id);
  v_allocation app.caulk_job_allocations;
  v_job_id uuid;
  v_requirement_id uuid;
  v_match_count integer := 0;
  v_distinct_job_count integer := 0;
  v_warnings text[] := array[]::text[];
begin
  if v_caulk_allocation_id = '' or v_used_tubes <= 0 then
    return jsonb_build_object(
      'recordedTubes', 0,
      'requirementIds', '[]'::jsonb,
      'warnings', to_jsonb(v_warnings)
    );
  end if;

  select *
  into v_allocation
  from app.caulk_job_allocations a
  where a.org_id = p_org_id
    and a.caulk_allocation_id = v_caulk_allocation_id
  for update;

  if not found then
    v_warnings := app_api.push_warning(
      v_warnings,
      format('Actual used tubes for caulk allocation %s were preserved in material history but were not assigned to a requirement because the allocation was not found.', v_caulk_allocation_id)
    );
    return jsonb_build_object('recordedTubes', 0, 'requirementIds', '[]'::jsonb, 'warnings', to_jsonb(v_warnings));
  end if;

  v_job_id := v_allocation.job_id;
  if v_job_id is null then
    select count(*)::integer, (array_agg(j.id order by j.created_at, j.id))[1]
    into v_distinct_job_count, v_job_id
    from app.jobs j
    where j.org_id = p_org_id
      and upper(trim(j.job_number)) = upper(trim(v_allocation.job_number));

    if v_distinct_job_count <> 1 then
      v_warnings := app_api.push_warning(
        v_warnings,
        format(
          'Actual used tubes for caulk allocation %s were preserved in material history but were not assigned to a requirement because job number %s maps to %s jobs.',
          v_caulk_allocation_id,
          coalesce(nullif(v_allocation.job_number, ''), 'UNKNOWN'),
          v_distinct_job_count
        )
      );
      return jsonb_build_object('recordedTubes', 0, 'requirementIds', '[]'::jsonb, 'warnings', to_jsonb(v_warnings));
    end if;

    update app.caulk_job_allocations
    set job_id = v_job_id,
        updated_at = timezone('utc', now()),
        updated_by = app_api.trim_text(p_actor)
    where org_id = p_org_id
      and id = v_allocation.id;
  end if;

  if v_allocation.requirement_id is not null then
    select r.id
    into v_requirement_id
    from app.job_caulk_requirements r
    where r.org_id = p_org_id
      and r.job_id = v_job_id
      and r.id = v_allocation.requirement_id
      and r.product_id = v_allocation.product_id
    for update;

    if v_requirement_id is null then
      v_warnings := app_api.push_warning(
        v_warnings,
        format(
          'Actual used tubes for caulk allocation %s were preserved in material history but were not assigned because the stored requirement_id no longer matches this job/product.',
          v_caulk_allocation_id
        )
      );
      return jsonb_build_object('recordedTubes', 0, 'requirementIds', '[]'::jsonb, 'warnings', to_jsonb(v_warnings));
    end if;
  else
    select count(*)::integer, (array_agg(r.id order by r.created_at, r.id))[1]
    into v_match_count, v_requirement_id
    from app.job_caulk_requirements r
    where r.org_id = p_org_id
      and r.job_id = v_job_id
      and r.product_id = v_allocation.product_id;

    if v_match_count <> 1 then
      v_warnings := app_api.push_warning(
        v_warnings,
        format(
          'Actual used tubes for caulk allocation %s were preserved in material history but were not assigned because %s matching caulk requirements were found.',
          v_caulk_allocation_id,
          v_match_count
        )
      );
      return jsonb_build_object('recordedTubes', 0, 'requirementIds', '[]'::jsonb, 'warnings', to_jsonb(v_warnings));
    end if;

    update app.caulk_job_allocations
    set requirement_id = v_requirement_id,
        updated_at = timezone('utc', now()),
        updated_by = app_api.trim_text(p_actor)
    where org_id = p_org_id
      and id = v_allocation.id;
  end if;

  update app.job_caulk_requirements
  set actual_used_tubes = greatest(coalesce(actual_used_tubes, 0), 0) + v_used_tubes,
      updated_at = timezone('utc', now()),
      updated_by = app_api.trim_text(p_actor)
  where org_id = p_org_id
    and job_id = v_job_id
    and id = v_requirement_id;

  return jsonb_build_object(
    'recordedTubes', v_used_tubes,
    'requirementIds', jsonb_build_array(v_requirement_id),
    'warnings', to_jsonb(v_warnings)
  );
end;
$$;

create or replace function public.api_acl_job_requirement_set_state(
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
  v_requirement_id_text text := app_api.require_text(p_payload->>'requirementId', 'RequirementId');
  v_status text := app_api.normalize_requirement_status(p_payload->>'status');
  v_material_type text := upper(coalesce(nullif(app_api.trim_text(p_payload->>'materialType'), ''), nullif(app_api.trim_text(p_payload->>'material_type'), ''), 'FILM'));
  v_job_id uuid := null;
  v_requirement_id uuid;
  v_job app.jobs;
  v_requirement app.job_requirements;
  v_caulk_requirement app.job_caulk_requirements;
  v_match_count integer := 0;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'write');

  if v_material_type not in ('FILM', 'CAULK') then
    perform app_api.raise_http(400, 'materialType must be FILM or CAULK.');
  end if;

  begin
    v_requirement_id := v_requirement_id_text::uuid;
  exception when others then
    perform app_api.raise_http(400, 'RequirementId must be a valid UUID.');
  end;

  if v_job_id_text <> '' then
    begin
      v_job_id := v_job_id_text::uuid;
    exception when others then
      perform app_api.raise_http(400, 'jobId must be a valid UUID.');
    end;

    select *
    into v_job
    from app.jobs j
    where j.org_id = p_org_id
      and j.id = v_job_id
    for update;

    if not found then
      perform app_api.raise_http(404, 'Job was not found.');
    end if;

    if v_job_number <> '' and upper(trim(v_job.job_number)) <> upper(trim(v_job_number)) then
      perform app_api.raise_http(400, 'Job identity mismatch: selected job does not match jobNumber.');
    end if;
  else
    v_job_number := app_api.require_text(v_job_number, 'JobNumber');

    select count(*)::integer
    into v_match_count
    from app.jobs j
    where j.org_id = p_org_id
      and upper(trim(j.job_number)) = upper(trim(v_job_number));

    if v_match_count = 0 then
      perform app_api.raise_http(404, format('Job %s was not found.', v_job_number));
    end if;
    if v_match_count > 1 then
      perform app_api.raise_http(409, format('Job %s has multiple work scopes. Open the exact job before changing requirement state.', v_job_number));
    end if;

    select *
    into v_job
    from app.jobs j
    where j.org_id = p_org_id
      and upper(trim(j.job_number)) = upper(trim(v_job_number))
    for update;
    v_job_id := v_job.id;
  end if;

  if coalesce(v_job.lifecycle_status::text, 'ACTIVE') <> 'ACTIVE' then
    perform app_api.raise_http(400, format('Job %s is closed. Reopen it before changing requirement state.', v_job.job_number));
  end if;

  if v_material_type = 'CAULK' then
    select *
    into v_caulk_requirement
    from app.job_caulk_requirements r
    where r.org_id = p_org_id
      and r.job_id = v_job_id
      and r.id = v_requirement_id
    for update;

    if not found then
      perform app_api.raise_http(404, 'Job caulk requirement was not found.');
    end if;

    update app.job_caulk_requirements
    set status = v_status,
        completed_at = case when v_status = 'COMPLETE' then coalesce(completed_at, timezone('utc', now())) else null end,
        completed_by = case when v_status = 'COMPLETE' then app_api.trim_text(p_actor) else '' end,
        updated_at = timezone('utc', now()),
        updated_by = app_api.trim_text(p_actor)
    where org_id = p_org_id
      and job_id = v_job_id
      and id = v_requirement_id
    returning *
    into v_caulk_requirement;

    perform app_api.reconcile_auto_planned_allocations(
      p_org_id,
      p_actor,
      jsonb_build_object(
        'jobIds', jsonb_build_array(v_job_id::text),
        'jobNumbers', jsonb_build_array(v_job.job_number)
      )
    );

    return jsonb_build_object(
      'jobId', v_job.id,
      'jobNumber', v_job.job_number,
      'materialType', 'CAULK',
      'requirementId', v_caulk_requirement.id,
      'status', v_caulk_requirement.status,
      'actualUsedTubes', v_caulk_requirement.actual_used_tubes,
      'warnings', '[]'::jsonb
    );
  end if;

  select *
  into v_requirement
  from app.job_requirements r
  where r.org_id = p_org_id
    and r.job_id = v_job_id
    and r.id = v_requirement_id
  for update;

  if not found then
    perform app_api.raise_http(404, 'Job requirement was not found.');
  end if;

  update app.job_requirements
  set status = v_status,
      completed_at = case when v_status = 'COMPLETE' then coalesce(completed_at, timezone('utc', now())) else null end,
      completed_by = case when v_status = 'COMPLETE' then app_api.trim_text(p_actor) else '' end,
      updated_at = timezone('utc', now()),
      updated_by = app_api.trim_text(p_actor)
  where org_id = p_org_id
    and job_id = v_job_id
    and id = v_requirement_id
  returning *
  into v_requirement;

  perform app_api.reconcile_auto_planned_allocations(
    p_org_id,
    p_actor,
    jsonb_build_object(
      'jobIds', jsonb_build_array(v_job_id::text),
      'jobNumbers', jsonb_build_array(v_job.job_number)
    )
  );

  return jsonb_build_object(
    'jobId', v_job.id,
    'jobNumber', v_job.job_number,
    'materialType', 'FILM',
    'requirementId', v_requirement.id,
    'status', v_requirement.status,
    'actualUsedFeet', v_requirement.actual_used_feet,
    'warnings', '[]'::jsonb
  );
end;
$$;

drop function if exists public.api_acl_list_job_caulk_requirements_by_job(uuid, text);

create or replace function public.api_acl_list_job_caulk_requirements_by_job(
  p_org_id uuid,
  p_job_number text
)
returns table (
  requirement_id uuid,
  job_id uuid,
  phase_id uuid,
  phase_number integer,
  phase_sections text,
  phase_install_date date,
  phase_crew_leader text,
  job_number text,
  product_id uuid,
  manufacturer_id uuid,
  manufacturer text,
  product_name text,
  product_code text,
  tubes_per_case integer,
  required_tubes integer,
  status text,
  actual_used_tubes integer,
  completed_at timestamptz,
  completed_by text,
  notes text,
  updated_at timestamptz,
  auto_planning_suppressed boolean
)
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'read');
  return query
  select
    r.id as requirement_id,
    r.job_id,
    r.phase_id,
    ph.phase_number,
    ph.sections as phase_sections,
    ph.install_date as phase_install_date,
    ph.crew_leader as phase_crew_leader,
    j.job_number,
    r.product_id,
    p.manufacturer_id,
    m.name as manufacturer,
    p.name as product_name,
    p.code as product_code,
    p.tubes_per_case,
    r.required_tubes,
    r.status,
    r.actual_used_tubes,
    r.completed_at,
    r.completed_by,
    r.notes,
    r.updated_at,
    exists (
      select 1
      from app.allocation_planner_suppressions s
      where s.org_id = r.org_id
        and s.job_id = r.job_id
        and (s.phase_id is null or s.phase_id = r.phase_id)
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
  join app.job_phases ph
    on ph.id = r.phase_id
   and ph.org_id = r.org_id
  join app.caulk_products p
    on p.id = r.product_id
   and p.org_id = r.org_id
  join app.caulk_manufacturers m
    on m.id = p.manufacturer_id
   and m.org_id = p.org_id
  where r.org_id = p_org_id
    and upper(j.job_number) = upper(trim(p_job_number))
  order by ph.phase_number asc, lower(m.name), lower(p.name), lower(p.code);
end;
$$;

create or replace function public.api_acl_allocations_caulk_checkin(
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
  v_checkout app.caulk_job_checkouts;
  v_allocation app.caulk_job_allocations;
  v_job app.jobs;
  v_actor text := app_api.trim_text(p_actor);
  v_caulk_checkout_id text := app_api.require_text(p_payload->>'caulkCheckoutId', 'CaulkCheckoutId');
  v_unused_loose_tubes integer := floor(nullif(app_api.trim_text(p_payload->>'unusedLooseTubes'), '')::numeric);
  v_unused_cases integer := floor(nullif(app_api.trim_text(p_payload->>'unusedCases'), '')::numeric);
  v_unused_tubes_legacy integer := floor(nullif(app_api.trim_text(p_payload->>'unusedTubes'), '')::numeric);
  v_tubes_per_case integer;
  v_total_returned_tubes integer;
  v_used_tubes integer;
  v_open_checkout_count integer := 0;
  v_notes text := app_api.trim_text(p_payload->>'notes');
  v_requirement_usage_result jsonb := jsonb_build_object('warnings', '[]'::jsonb);
  v_planner_result jsonb := '{}'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'write');

  select *
  into v_checkout
  from app.caulk_job_checkouts c
  where c.org_id = p_org_id
    and c.caulk_checkout_id = v_caulk_checkout_id
  for update;

  if not found then
    perform app_api.raise_http(404, format('Caulk checkout %s was not found.', v_caulk_checkout_id));
  end if;

  if v_checkout.status <> 'OPEN' then
    perform app_api.raise_http(400, format('Caulk checkout %s is already closed.', v_caulk_checkout_id));
  end if;

  select *
  into v_allocation
  from app.caulk_job_allocations a
  where a.org_id = p_org_id
    and a.id = v_checkout.caulk_allocation_id
  for update;

  if not found then
    perform app_api.raise_http(404, 'Parent caulk allocation was not found.');
  end if;

  if v_allocation.status <> 'ACTIVE' then
    perform app_api.raise_http(400, 'Parent caulk allocation is no longer active.');
  end if;

  select *
  into v_job
  from app.jobs j
  where j.org_id = p_org_id
    and j.id = v_allocation.job_id
  for update;

  if not found then
    perform app_api.raise_http(404, format('Job for caulk checkout %s was not found.', v_caulk_checkout_id));
  end if;

  select p.tubes_per_case
  into v_tubes_per_case
  from app.caulk_products p
  where p.org_id = p_org_id
    and p.id = v_allocation.product_id;

  if v_tubes_per_case is null or v_tubes_per_case <= 0 then
    perform app_api.raise_http(400, 'This caulk product is missing a valid tubesPerCase value.');
  end if;

  if v_unused_loose_tubes is null and v_unused_cases is null then
    if v_unused_tubes_legacy is null or v_unused_tubes_legacy < 0 then
      perform app_api.raise_http(400, 'unusedTubes must be zero or greater.');
    end if;

    v_total_returned_tubes := v_unused_tubes_legacy;
  else
    v_unused_loose_tubes := coalesce(v_unused_loose_tubes, 0);
    v_unused_cases := coalesce(v_unused_cases, 0);

    if v_unused_loose_tubes < 0 then
      perform app_api.raise_http(400, 'unusedLooseTubes must be zero or greater.');
    end if;

    if v_unused_cases < 0 then
      perform app_api.raise_http(400, 'unusedCases must be zero or greater.');
    end if;

    if v_unused_loose_tubes >= v_tubes_per_case then
      perform app_api.raise_http(
        400,
        format('unusedLooseTubes must be less than tubesPerCase (%s).', v_tubes_per_case)
      );
    end if;

    v_total_returned_tubes := v_unused_loose_tubes + (v_unused_cases * v_tubes_per_case);
  end if;

  if v_total_returned_tubes > v_checkout.checkout_tubes then
    perform app_api.raise_http(400, 'Returned caulk cannot exceed checked-out tubes.');
  end if;

  v_used_tubes := v_checkout.checkout_tubes - v_total_returned_tubes;

  if v_total_returned_tubes > 0 then
    perform app_api.caulk_apply_stock_delta(
      p_org_id,
      v_actor,
      v_allocation.product_id,
      v_allocation.warehouse,
      'JOB_CHECKIN_UNUSED',
      v_total_returned_tubes,
      format('Checked in unused caulk from job %s.', v_job.job_number),
      '',
      v_allocation.caulk_allocation_id,
      v_notes
    );
  end if;

  update app.caulk_job_checkouts
  set
    status = 'CLOSED',
    checked_in_at = now(),
    checked_in_by = v_actor,
    unused_tubes = v_total_returned_tubes,
    used_tubes = v_used_tubes,
    notes = v_notes
  where id = v_checkout.id
    and org_id = p_org_id;

  update app.caulk_job_allocations
  set
    returned_unused_tubes_total = v_allocation.returned_unused_tubes_total + v_total_returned_tubes,
    used_tubes_total = v_allocation.used_tubes_total + v_used_tubes,
    updated_at = now(),
    updated_by = v_actor
  where id = v_allocation.id
    and org_id = p_org_id
  returning *
  into v_allocation;

  v_requirement_usage_result := app_api.record_caulk_requirement_actual_usage_for_checkin(
    p_org_id,
    v_actor,
    v_allocation.caulk_allocation_id,
    v_used_tubes
  );
  v_warnings := v_warnings || coalesce(v_requirement_usage_result->'warnings', '[]'::jsonb);

  select count(*)::integer
  into v_open_checkout_count
  from app.caulk_job_checkouts c
  where c.org_id = p_org_id
    and c.caulk_allocation_id = v_allocation.id
    and c.status = 'OPEN';

  if v_open_checkout_count = 0 and coalesce(v_allocation.reserved_tubes_remaining, 0) = 0 then
    update app.caulk_job_allocations
    set status = 'CANCELLED',
        resolved_at = coalesce(resolved_at, now()),
        resolved_by = v_actor,
        updated_at = now(),
        updated_by = v_actor,
        notes = trim(
          coalesce(notes, '') ||
          case when coalesce(notes, '') = '' then '' else ' ' end ||
          'Resolved after caulk checkout check-in usage was recorded.'
        )
    where id = v_allocation.id
      and org_id = p_org_id
    returning *
    into v_allocation;
  end if;

  v_planner_result := app_api.reconcile_auto_planned_allocations(
    p_org_id,
    v_actor,
    jsonb_build_object(
      'jobIds', jsonb_build_array(v_job.id),
      'jobNumbers', jsonb_build_array(v_job.job_number),
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
    'jobId', v_job.id::text,
    'jobNumber', v_job.job_number,
    'caulkAllocationId', v_allocation.caulk_allocation_id,
    'caulkAllocationStatus', v_allocation.status::text,
    'caulkCheckoutId', v_checkout.caulk_checkout_id,
    'productId', v_allocation.product_id::text,
    'warehouse', v_allocation.warehouse,
    'usedTubes', v_used_tubes,
    'returnedTubes', v_total_returned_tubes,
    'requirementUsage', v_requirement_usage_result,
    'warnings', v_warnings
  );
end;
$$;

do $$
declare
  v_def text;
  v_next text;
  v_base text;
begin
  select pg_get_functiondef('app_api.reconcile_auto_planned_allocations(uuid, text, jsonb)'::regprocedure)
  into v_def;

  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  if position('from app.job_caulk_requirements r
    join auto_planner_jobs j
      on j.job_id = r.job_id
    where coalesce(r.status, ''ACTIVE'') = ''ACTIVE''' in v_next) = 0 then
    v_next := replace(
      v_next,
      replace($old$
    from app.job_caulk_requirements r
    join auto_planner_jobs j
      on j.job_id = r.job_id
    order by
$old$, E'\r\n', E'\n'),
      replace($new$
    from app.job_caulk_requirements r
    join auto_planner_jobs j
      on j.job_id = r.job_id
    where coalesce(r.status, 'ACTIVE') = 'ACTIVE'
    order by
$new$, E'\r\n', E'\n')
    );
  end if;

  if v_next = v_base then
    if position('from app.job_caulk_requirements r
    join auto_planner_jobs j
      on j.job_id = r.job_id
    where coalesce(r.status, ''ACTIVE'') = ''ACTIVE''' in v_next) > 0 then
      return;
    end if;
    raise exception 'reconcile_auto_planned_allocations caulk active requirement patch did not match expected snippets';
  end if;

  execute v_next;
end $$;

drop table if exists pg_temp.caulk_checkin_backfill_candidates;

create temporary table caulk_checkin_backfill_candidates on commit drop as
with base_allocations as (
  select
    a.org_id,
    a.id,
    a.caulk_allocation_id,
    a.job_id,
    a.job_number,
    a.requirement_id,
    a.product_id,
    a.used_tubes_total,
    max(c.checked_in_at) as latest_checked_in_at,
    count(*) filter (where c.status = 'OPEN')::integer as open_checkout_count
  from app.caulk_job_allocations a
  left join app.caulk_job_checkouts c
    on c.org_id = a.org_id
   and c.caulk_allocation_id = a.id
  where a.status = 'ACTIVE'
    and coalesce(a.reserved_tubes_remaining, 0) = 0
    and coalesce(a.used_tubes_total, 0) > 0
    and coalesce(a.checked_out_tubes_total, 0) = coalesce(a.returned_unused_tubes_total, 0) + coalesce(a.used_tubes_total, 0)
  group by a.org_id, a.id, a.caulk_allocation_id, a.job_id, a.job_number, a.requirement_id, a.product_id, a.used_tubes_total
),
direct_matches as (
  select
    b.*,
    r.id as matched_requirement_id,
    r.actual_used_tubes
  from base_allocations b
  join app.job_caulk_requirements r
    on r.org_id = b.org_id
   and r.id = b.requirement_id
   and r.job_id = b.job_id
   and r.product_id = b.product_id
  where b.requirement_id is not null
    and b.open_checkout_count = 0
),
legacy_matches as (
  select
    b.*,
    m.requirement_id as matched_requirement_id,
    r.actual_used_tubes
  from base_allocations b
  join lateral (
    select
      count(*)::integer as requirement_match_count,
      (array_agg(r2.id order by r2.created_at, r2.id))[1] as requirement_id
    from app.job_caulk_requirements r2
    where r2.org_id = b.org_id
      and r2.job_id = b.job_id
      and r2.product_id = b.product_id
  ) m on true
  join app.job_caulk_requirements r
    on r.org_id = b.org_id
   and r.id = m.requirement_id
  where b.requirement_id is null
    and b.job_id is not null
    and b.open_checkout_count = 0
    and m.requirement_match_count = 1
),
all_matches as (
  select * from direct_matches
  union all
  select * from legacy_matches
)
select *
from all_matches;

do $$
declare
  v_requirement_count integer := 0;
  v_allocation_link_count integer := 0;
  v_allocation_resolve_count integer := 0;
begin
  update app.caulk_job_allocations a
  set requirement_id = c.matched_requirement_id,
      updated_at = timezone('utc', now()),
      updated_by = 'caulk-usage-state-0146'
  from caulk_checkin_backfill_candidates c
  where a.org_id = c.org_id
    and a.id = c.id
    and a.requirement_id is null;
  get diagnostics v_allocation_link_count = row_count;

  update app.job_caulk_requirements r
  set actual_used_tubes = c.used_tubes_total,
      updated_at = timezone('utc', now()),
      updated_by = 'caulk-usage-state-0146'
  from caulk_checkin_backfill_candidates c
  where r.org_id = c.org_id
    and r.id = c.matched_requirement_id
    and coalesce(r.actual_used_tubes, 0) = 0
    and c.used_tubes_total > 0;
  get diagnostics v_requirement_count = row_count;

  update app.caulk_job_allocations a
  set status = 'CANCELLED',
      resolved_at = coalesce(c.latest_checked_in_at, timezone('utc', now())),
      resolved_by = 'caulk-usage-state-0146',
      updated_at = timezone('utc', now()),
      updated_by = 'caulk-usage-state-0146',
      notes = trim(
        coalesce(a.notes, '') ||
        case when coalesce(a.notes, '') = '' then '' else ' ' end ||
        'Resolved by caulk usage state migration after closed checkout usage was backfilled.'
      )
  from caulk_checkin_backfill_candidates c
  where a.org_id = c.org_id
    and a.id = c.id
    and a.status = 'ACTIVE';
  get diagnostics v_allocation_resolve_count = row_count;

  raise notice 'caulk usage state linked % allocation row(s), backfilled % caulk requirement row(s), and resolved % caulk allocation row(s)',
    v_allocation_link_count,
    v_requirement_count,
    v_allocation_resolve_count;
end $$;

select app_api.grant_execute_if_exists('app_api.record_caulk_requirement_actual_usage_for_checkin(uuid, text, text, integer)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.record_caulk_requirement_actual_usage_for_checkin(uuid, text, text, integer)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_job_requirement_set_state(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_job_requirement_set_state(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_list_job_caulk_requirements_by_job(uuid, text)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_job_caulk_requirements_by_job(uuid, text)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_checkin(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_checkin(uuid, text, jsonb)', 'service_role');

do $$
declare
  v_def text;
begin
  select pg_get_functiondef('app_api.replace_job_caulk_requirements(uuid, app.jobs, jsonb, text, timestamp with time zone)'::regprocedure)
  into v_def;
  if position('greatest(coalesce(v_existing.actual_used_tubes, 0), coalesce(v_requirement.actual_used_tubes, 0))' in v_def) = 0 then
    raise exception 'app_api.replace_job_caulk_requirements can still erase actual_used_tubes';
  end if;

  select pg_get_functiondef('app_api.record_caulk_requirement_actual_usage_for_checkin(uuid, text, text, integer)'::regprocedure)
  into v_def;
  if position('v_match_count <> 1' in v_def) = 0
     or position('job number %s maps to %s jobs' in v_def) = 0
     or position('actual_used_tubes = greatest(coalesce(actual_used_tubes, 0), 0) + v_used_tubes' in v_def) = 0 then
    raise exception 'record_caulk_requirement_actual_usage_for_checkin missing safe mapping or usage accumulation';
  end if;

  select pg_get_functiondef('public.api_acl_allocations_caulk_checkin(uuid, text, jsonb)'::regprocedure)
  into v_def;
  if position('app_api.record_caulk_requirement_actual_usage_for_checkin' in v_def) = 0
     or position('Resolved after caulk checkout check-in usage was recorded.' in v_def) = 0
     or position('caulkAllocationStatus' in v_def) = 0 then
    raise exception 'api_acl_allocations_caulk_checkin missing usage recording or allocation resolution';
  end if;

  select pg_get_functiondef('app_api.reconcile_auto_planned_allocations(uuid, text, jsonb)'::regprocedure)
  into v_def;
  if position('from app.job_caulk_requirements r' in v_def) = 0
     or position('from app.job_caulk_requirements r
    join auto_planner_jobs j
      on j.job_id = r.job_id
    where coalesce(r.status, ''ACTIVE'') = ''ACTIVE''' in v_def) = 0 then
    raise exception 'app_api.reconcile_auto_planned_allocations still plans Complete caulk requirements';
  end if;
end $$;
