/**
 * PURPOSE:
 * Track requirement-level actual used LF and user-controlled Active/Complete
 * state for film requirements.
 *
 * AFFECTS:
 * app.job_requirements, box check-in usage recording, allocation/film-order
 * guards, auto planning, and Edge/local job detail parity.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * backend runtimeAllocationCoverage/runtimeJobSummaries/statusTransitions,
 * Supabase Edge api-handler/mutationHandlers, frontend requirement UI/cache,
 * and schema/latest checks.
 *
 * COMMON FAILURE MODES:
 * Erasing actual usage on reactivation, counting Complete rows as demand,
 * double-counting check-ins, or using jobNumber when jobId is available.
 */

alter table app.job_requirements
  add column if not exists status text not null default 'ACTIVE',
  add column if not exists actual_used_feet integer not null default 0,
  add column if not exists completed_at timestamptz,
  add column if not exists completed_by text not null default '';

update app.job_requirements
set status = 'ACTIVE'
where status is null or upper(trim(status)) not in ('ACTIVE', 'COMPLETE');

update app.job_requirements
set actual_used_feet = 0
where actual_used_feet is null or actual_used_feet < 0;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'job_requirements_status_check'
      and conrelid = 'app.job_requirements'::regclass
  ) then
    alter table app.job_requirements
      add constraint job_requirements_status_check
      check (status in ('ACTIVE', 'COMPLETE'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'job_requirements_actual_used_feet_check'
      and conrelid = 'app.job_requirements'::regclass
  ) then
    alter table app.job_requirements
      add constraint job_requirements_actual_used_feet_check
      check (actual_used_feet >= 0);
  end if;
end $$;

create index if not exists job_requirements_active_planning_idx
  on app.job_requirements (org_id, job_id, status);

create or replace function app_api.normalize_requirement_status(p_status text)
returns text
language sql
immutable
as $$
  select case when upper(btrim(coalesce(p_status, ''))) = 'COMPLETE' then 'COMPLETE' else 'ACTIVE' end;
$$;

create or replace function app_api.record_requirement_actual_usage_for_checkin(
  p_org_id uuid,
  p_actor text,
  p_box_id text,
  p_job_id uuid,
  p_job_number text,
  p_used_feet integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_used_feet integer := greatest(coalesce(p_used_feet, 0), 0);
  v_box_id text := upper(app_api.trim_text(p_box_id));
  v_job_number text := app_api.trim_text(p_job_number);
  v_candidate_count integer := 0;
  v_distinct_job_count integer := 0;
  v_index integer := 0;
  v_remaining_feet integer := 0;
  v_applied_feet integer := 0;
  v_recorded_feet integer := 0;
  v_requirement_ids uuid[] := array[]::uuid[];
  v_row record;
  v_warnings text[] := array[]::text[];
begin
  if v_box_id = '' or v_used_feet <= 0 then
    return jsonb_build_object(
      'recordedFeet', 0,
      'requirementIds', '[]'::jsonb,
      'warnings', to_jsonb(v_warnings)
    );
  end if;

  select count(*)::integer, count(distinct r.job_id)::integer
  into v_candidate_count, v_distinct_job_count
  from app.allocations a
  join app.job_requirements r
    on r.org_id = a.org_id
   and r.id = a.requirement_id
  join app.jobs j
    on j.org_id = r.org_id
   and j.id = r.job_id
  where a.org_id = p_org_id
    and upper(trim(a.box_id)) = v_box_id
    and a.status = 'ACTIVE'
    and coalesce(a.allocation_kind::text, 'REQUIREMENT') = 'REQUIREMENT'
    and a.requirement_id is not null
    and case
      when p_job_id is not null then r.job_id = p_job_id
      else upper(trim(j.job_number)) = upper(v_job_number)
    end;

  if v_candidate_count <= 0 then
    v_warnings := app_api.push_warning(
      v_warnings,
      format(
        'Actual used LF from box %s was preserved in roll history but was not assigned to a requirement because no active requirement allocation matched the check-out job.',
        v_box_id
      )
    );
    return jsonb_build_object(
      'recordedFeet', 0,
      'requirementIds', '[]'::jsonb,
      'warnings', to_jsonb(v_warnings)
    );
  end if;

  if p_job_id is null and v_distinct_job_count > 1 then
    v_warnings := app_api.push_warning(
      v_warnings,
      format(
        'Actual used LF from box %s was preserved in roll history but was not assigned to a requirement because job number %s maps to multiple jobs.',
        v_box_id,
        coalesce(nullif(v_job_number, ''), 'UNKNOWN')
      )
    );
    return jsonb_build_object(
      'recordedFeet', 0,
      'requirementIds', '[]'::jsonb,
      'warnings', to_jsonb(v_warnings)
    );
  end if;

  v_remaining_feet := v_used_feet;
  for v_row in
    select
      a.allocation_id,
      a.requirement_id,
      r.job_id,
      greatest(coalesce(nullif(a.covered_feet, 0), a.allocated_feet, 0), 0)::integer as usage_basis_feet
    from app.allocations a
    join app.job_requirements r
      on r.org_id = a.org_id
     and r.id = a.requirement_id
    join app.jobs j
      on j.org_id = r.org_id
     and j.id = r.job_id
    where a.org_id = p_org_id
      and upper(trim(a.box_id)) = v_box_id
      and a.status = 'ACTIVE'
      and coalesce(a.allocation_kind::text, 'REQUIREMENT') = 'REQUIREMENT'
      and a.requirement_id is not null
      and case
        when p_job_id is not null then r.job_id = p_job_id
        else upper(trim(j.job_number)) = upper(v_job_number)
      end
    order by a.created_at asc, a.allocation_id asc
    for update of a, r
  loop
    exit when v_remaining_feet <= 0;
    v_index := v_index + 1;
    v_applied_feet := case
      when v_index = v_candidate_count then v_remaining_feet
      else least(v_remaining_feet, greatest(coalesce(v_row.usage_basis_feet, 0), 0))
    end;

    if v_applied_feet <= 0 then
      continue;
    end if;

    update app.job_requirements
    set actual_used_feet = greatest(coalesce(actual_used_feet, 0), 0) + v_applied_feet,
        updated_at = timezone('utc', now()),
        updated_by = app_api.trim_text(p_actor)
    where org_id = p_org_id
      and job_id = v_row.job_id
      and id = v_row.requirement_id;

    v_recorded_feet := v_recorded_feet + v_applied_feet;
    if not (v_row.requirement_id = any(v_requirement_ids)) then
      v_requirement_ids := array_append(v_requirement_ids, v_row.requirement_id);
    end if;
    v_remaining_feet := v_remaining_feet - v_applied_feet;
  end loop;

  return jsonb_build_object(
    'recordedFeet', v_recorded_feet,
    'requirementIds', to_jsonb(v_requirement_ids),
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
  v_job_id uuid := null;
  v_requirement_id uuid;
  v_job app.jobs;
  v_requirement app.job_requirements;
  v_match_count integer := 0;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'write');

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
    'requirementId', v_requirement.id,
    'status', v_requirement.status,
    'actualUsedFeet', v_requirement.actual_used_feet,
    'warnings', '[]'::jsonb
  );
end;
$$;

select app_api.grant_execute_if_exists('app_api.normalize_requirement_status(text)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.normalize_requirement_status(text)', 'service_role');
select app_api.grant_execute_if_exists('app_api.record_requirement_actual_usage_for_checkin(uuid, text, text, uuid, text, integer)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.record_requirement_actual_usage_for_checkin(uuid, text, text, uuid, text, integer)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_job_requirement_set_state(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_job_requirement_set_state(uuid, text, jsonb)', 'service_role');

do $$
declare
  v_def text;
  v_next text;
  v_base text;
begin
  select pg_get_functiondef('public.api_boxes_set_status(uuid, text, jsonb)'::regprocedure)
  into v_def;

  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  if position('v_requirement_usage_result jsonb' in v_next) = 0 then
    v_next := replace(
      v_next,
      '  v_reconciliation_result jsonb := jsonb_build_object(''warnings'', ''[]''::jsonb);',
      replace('  v_reconciliation_result jsonb := jsonb_build_object(''warnings'', ''[]''::jsonb);
  v_requirement_usage_result jsonb := jsonb_build_object(''warnings'', ''[]''::jsonb);', E'\r\n', E'\n')
    );
  end if;

  if position('app_api.record_requirement_actual_usage_for_checkin' in v_next) = 0 then
    v_next := replace(
      v_next,
      replace($old$
    v_reconciliation_result := app_api.reconcile_box_checkin_allocations(
$old$, E'\r\n', E'\n'),
      replace($new$
    if coalesce(v_existing.status::text, '') = 'CHECKED_OUT' then
      v_requirement_usage_result := app_api.record_requirement_actual_usage_for_checkin(
        p_org_id,
        p_actor,
        v_box.box_id,
        v_checkout_job_id,
        v_checkout_job,
        greatest(v_physical_feet_before - v_physical_feet_after, 0)
      );
      if jsonb_typeof(coalesce(v_requirement_usage_result->'warnings', '[]'::jsonb)) = 'array' then
        v_warnings := v_warnings || array(
          select jsonb_array_elements_text(coalesce(v_requirement_usage_result->'warnings', '[]'::jsonb))
        );
      end if;
    end if;

    v_reconciliation_result := app_api.reconcile_box_checkin_allocations(
$new$, E'\r\n', E'\n')
    );
  end if;

  if v_next = v_base then
    if position('app_api.record_requirement_actual_usage_for_checkin' in v_next) > 0
       and position('v_requirement_usage_result jsonb' in v_next) > 0 then
      return;
    end if;
    raise exception 'api_boxes_set_status requirement usage patch did not match expected snippets';
  end if;

  if position('app_api.record_requirement_actual_usage_for_checkin' in v_next) = 0
     or position('v_requirement_usage_result jsonb' in v_next) = 0 then
    raise exception 'api_boxes_set_status requirement usage patch verification failed';
  end if;

  execute v_next;
end $$;

do $$
declare
  v_def text;
  v_next text;
  v_base text;
begin
  select pg_get_functiondef('public.api_allocations_apply(uuid, text, jsonb)'::regprocedure)
  into v_def;

  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  if position('Reactivate it before allocating film' in v_next) = 0 then
    v_next := replace(
      v_next,
      replace($old$
    if not found then
      perform app_api.raise_http(
        400,
        format('Requirement %s does not belong to job %s.', v_requirement_id, v_job_context->>'jobNumber')
      );
    end if;

    v_requirement_is_exterior := app_api.requirement_film_is_exterior(
$old$, E'\r\n', E'\n'),
      replace($new$
    if not found then
      perform app_api.raise_http(
        400,
        format('Requirement %s does not belong to job %s.', v_requirement_id, v_job_context->>'jobNumber')
      );
    end if;

    if coalesce(v_requirement.status, 'ACTIVE') = 'COMPLETE' then
      perform app_api.raise_http(400, format('Requirement %s is complete. Reactivate it before allocating film.', v_requirement_id));
    end if;

    v_requirement_is_exterior := app_api.requirement_film_is_exterior(
$new$, E'\r\n', E'\n')
    );
  end if;

  if v_next = v_base then
    if position('Reactivate it before allocating film' in v_next) > 0 then
      return;
    end if;
    raise exception 'api_allocations_apply complete requirement guard patch did not match expected snippets';
  end if;

  execute v_next;
end $$;

do $$
declare
  v_def text;
  v_next text;
  v_base text;
begin
  select pg_get_functiondef('public.api_film_orders_create(uuid, text, jsonb)'::regprocedure)
  into v_def;

  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  if position('Reactivate it before ordering more film' in v_next) = 0 then
    v_next := replace(
      v_next,
      replace($old$
    if not found then
      perform app_api.raise_http(404, 'Job requirement was not found.');
    end if;

    if v_has_job_id then
$old$, E'\r\n', E'\n'),
      replace($new$
    if not found then
      perform app_api.raise_http(404, 'Job requirement was not found.');
    end if;

    if coalesce(v_requirement.status, 'ACTIVE') = 'COMPLETE' then
      perform app_api.raise_http(400, 'Requirement is complete. Reactivate it before ordering more film.');
    end if;

    if v_has_job_id then
$new$, E'\r\n', E'\n')
    );
  end if;

  if v_next = v_base then
    if position('Reactivate it before ordering more film' in v_next) > 0 then
      return;
    end if;
    raise exception 'api_film_orders_create complete requirement guard patch did not match expected snippets';
  end if;

  execute v_next;
end $$;

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

  if position('coalesce(r.status, ''ACTIVE'') = ''ACTIVE''' in v_next) = 0 then
    v_next := replace(
      v_next,
      replace($old$
      from app.job_requirements r
      where r.org_id = p_org_id
        and r.job_id = v_job.job_id
      order by r.updated_at, r.id
$old$, E'\r\n', E'\n'),
      replace($new$
      from app.job_requirements r
      where r.org_id = p_org_id
        and r.job_id = v_job.job_id
        and coalesce(r.status, 'ACTIVE') = 'ACTIVE'
      order by r.updated_at, r.id
$new$, E'\r\n', E'\n')
    );
  end if;

  if v_next = v_base then
    if position('coalesce(r.status, ''ACTIVE'') = ''ACTIVE''' in v_next) > 0 then
      return;
    end if;
    raise exception 'reconcile_auto_planned_allocations active requirement patch did not match expected snippets';
  end if;

  execute v_next;
end $$;

do $$
declare
  v_def text;
begin
  select pg_get_functiondef('public.api_boxes_set_status(uuid, text, jsonb)'::regprocedure)
  into v_def;
  if position('app_api.record_requirement_actual_usage_for_checkin' in v_def) = 0 then
    raise exception 'public.api_boxes_set_status missing requirement actual usage recording';
  end if;

  select pg_get_functiondef('app_api.reconcile_auto_planned_allocations(uuid, text, jsonb)'::regprocedure)
  into v_def;
  if position('coalesce(r.status, ''ACTIVE'') = ''ACTIVE''' in v_def) = 0 then
    raise exception 'app_api.reconcile_auto_planned_allocations still plans Complete requirements';
  end if;
end $$;
