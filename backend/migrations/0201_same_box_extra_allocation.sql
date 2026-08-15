-- Purpose: Represent a primary Extra Job Film selection once while preserving
-- the atomic allocator's raw duplicate-box and capacity protections.

do $$
declare
  v_apply_count integer;
  v_plan_count integer;
  v_apply_def text;
begin
  select count(*)::integer
  into v_apply_count
  from pg_proc p
  where p.oid = to_regprocedure('public.api_allocations_apply(uuid, text, jsonb)');

  select count(*)::integer
  into v_plan_count
  from pg_proc p
  where p.oid = to_regprocedure('app_api.build_allocation_apply_plan_0192(uuid, text, jsonb)');

  if v_apply_count <> 1 or v_plan_count <> 1 then
    raise exception 'Migration 0201 requires the canonical 0192 allocation apply functions.';
  end if;

  select pg_get_functiondef('public.api_allocations_apply(uuid, text, jsonb)'::regprocedure)
  into v_apply_def;

  if (
    select count(*)::integer
    from regexp_matches(v_apply_def, 'app_api\.build_allocation_apply_plan_0192\(', 'g')
  ) <> 1
    or position('app_api.build_allocation_apply_plan_0201' in v_apply_def) > 0
  then
    raise exception 'Migration 0201 allocation apply precondition failed.';
  end if;
end;
$$;

create or replace function app_api.build_allocation_apply_plan_0201(
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
  v_allocation_kind text := upper(coalesce(
    nullif(app_api.trim_text(v_payload->>'allocationKind'), ''),
    'REQUIREMENT'
  ));
  v_primary_extra_feet integer;
  v_primary_requested_covered_feet integer;
  v_coverage_multiplier integer;
  v_source app.boxes;
  v_requirement app.job_requirements;
  v_requirement_id uuid;
  v_delegated_payload jsonb;
  v_plan jsonb;
  v_operation jsonb;
  v_operations jsonb := '[]'::jsonb;
  v_rewritten_operations jsonb := '[]'::jsonb;
  v_primary_operation_count integer := 0;
begin
  perform app_api.require_org_member(p_org_id);

  if v_allocation_kind = 'REQUIREMENT' then
    return app_api.build_allocation_apply_plan_0192(p_org_id, p_actor, v_payload);
  end if;

  if v_allocation_kind <> 'EXTRA' then
    perform app_api.raise_http(400, 'AllocationKind must be REQUIREMENT or EXTRA.');
  end if;

  begin
    v_primary_extra_feet := floor(
      nullif(app_api.trim_text(v_payload->>'requestedFeet'), '')::numeric
    )::integer;
  exception
    when others then
      perform app_api.raise_http(400, 'RequestedFeet must be a whole number.');
  end;

  if v_primary_extra_feet is null or v_primary_extra_feet <= 0 then
    perform app_api.raise_http(400, 'Primary EXTRA allocation must be greater than zero.');
  end if;

  select *
  into v_source
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = app_api.require_text(v_payload->>'boxId', 'BoxID');

  if not found then
    perform app_api.raise_http(404, 'Box not found.');
  end if;

  begin
    v_requirement_id := app_api.require_text(
      v_payload->>'requirementId',
      'RequirementId'
    )::uuid;
  exception
    when others then
      perform app_api.raise_http(400, 'RequirementId must be a valid UUID.');
  end;

  select *
  into v_requirement
  from app.job_requirements r
  where r.org_id = p_org_id
    and r.id = v_requirement_id;

  if not found then
    perform app_api.raise_http(400, 'RequirementId is required for primary EXTRA allocation.');
  end if;

  v_coverage_multiplier := app_api.allocation_coverage_multiplier(
    v_source.width_in,
    v_requirement.width_in
  );
  if v_coverage_multiplier <= 0 then
    perform app_api.raise_http(400, 'The primary EXTRA box must meet the selected requirement width.');
  end if;

  if v_primary_extra_feet::numeric * v_coverage_multiplier::numeric > 2147483647::numeric then
    perform app_api.raise_http(400, 'Primary EXTRA allocation is too large.');
  end if;
  v_primary_requested_covered_feet := v_primary_extra_feet * v_coverage_multiplier;

  v_delegated_payload := jsonb_set(
    v_payload - 'allocationKind',
    '{requestedFeet}',
    to_jsonb(v_primary_requested_covered_feet),
    true
  );
  v_plan := app_api.build_allocation_apply_plan_0192(
    p_org_id,
    p_actor,
    v_delegated_payload
  );
  v_operations := coalesce(v_plan->'operations', '[]'::jsonb);

  for v_operation in
    select value
    from jsonb_array_elements(v_operations) with ordinality entries(value, ordinality)
    order by ordinality
  loop
    if coalesce(v_operation->>'role', '') = 'SOURCE'
      and v_operation->>'boxId' = v_source.box_id
    then
      v_primary_operation_count := v_primary_operation_count + 1;
      if coalesce(v_operation->>'kind', '') <> 'REQUIREMENT'
        or coalesce((v_operation->>'allocatedFeet')::integer, 0) <> v_primary_extra_feet
      then
        perform app_api.raise_http(
          409,
          'The primary EXTRA box no longer has enough allocatable LF. Reload and retry.'
        );
      end if;
      v_rewritten_operations := v_rewritten_operations || jsonb_build_array(
        v_operation || jsonb_build_object(
          'role', 'PRIMARY_EXTRA',
          'kind', 'EXTRA',
          'allocatedFeet', v_primary_extra_feet,
          'coveredFeet', v_primary_extra_feet,
          'priorBoxIds', '[]'::jsonb
        )
      );
    else
      v_rewritten_operations := v_rewritten_operations || jsonb_build_array(v_operation);
    end if;
  end loop;

  if v_primary_operation_count <> 1
    or greatest(coalesce((v_plan->>'remainingUncoveredFeet')::integer, 0), 0) <> 0
  then
    perform app_api.raise_http(
      409,
      'The primary EXTRA box no longer has enough allocatable LF. Reload and retry.'
    );
  end if;

  return v_plan || jsonb_build_object(
    'operations', v_rewritten_operations,
    'remainingUncoveredFeet', 0
  );
end;
$$;

alter function app_api.build_allocation_apply_plan_0201(uuid, text, jsonb) owner to postgres;
revoke execute on function app_api.build_allocation_apply_plan_0201(uuid, text, jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.api_allocations_apply(
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
  v_plan jsonb;
  v_operations jsonb;
  v_operation jsonb;
  v_plan_box_ids text[] := array[]::text[];
  v_affected_box_ids text[] := array[]::text[];
  v_plan_states jsonb := '{}'::jsonb;
  v_pre_states jsonb := '{}'::jsonb;
  v_locked_states jsonb := '{}'::jsonb;
  v_box_id text;
  v_expected_count integer := 0;
  v_actual_count integer := 0;
  v_job_id uuid;
  v_job app.jobs;
  v_phase_id uuid;
  v_phase app.job_phases;
  v_requirement app.job_requirements;
  v_job_context jsonb;
  v_requirement_id uuid;
  v_box app.boxes;
  v_allocation app.allocations;
  v_allocation_id text;
  v_allocation_ids text[] := array[]::text[];
  v_allocation_job_warehouse text := '';
  v_pre_state jsonb;
  v_pre_warehouse text := '';
  v_cross_warehouse boolean := false;
  v_payload_job_warehouse text := '';
  v_cross_box_counts jsonb := '{}'::jsonb;
  v_cross_box_count integer := 0;
  v_transfer app.box_transfers;
  v_transfer_ids text[] := array[]::text[];
begin
  perform app_api.lock_film_material_flow();

  v_plan := app_api.build_allocation_apply_plan_0201(p_org_id, p_actor, v_payload);
  v_operations := coalesce(v_plan->'operations', '[]'::jsonb);
  v_plan_states := coalesce(v_plan->'boxStates', '{}'::jsonb);
  v_job_context := coalesce(v_plan->'jobContext', '{}'::jsonb);
  v_cross_warehouse := coalesce((v_plan->>'crossWarehouse')::boolean, false);
  v_payload_job_warehouse := upper(coalesce(v_plan->>'payloadJobWarehouse', ''));
  v_job_id := nullif(app_api.trim_text(v_plan->>'jobId'), '')::uuid;
  v_phase_id := nullif(app_api.trim_text(v_plan->>'phaseId'), '')::uuid;
  v_requirement_id := nullif(app_api.trim_text(v_plan->>'requirementId'), '')::uuid;

  select coalesce(array_agg(value order by ordinality), array[]::text[])
  into v_plan_box_ids
  from jsonb_array_elements_text(coalesce(v_plan->'boxIds', '[]'::jsonb)) with ordinality entries(value, ordinality);

  with recursive transfer_edges as materialized (
    select physical.box_id as from_box_id, linked.box_id as to_box_id
    from app.box_transfers t
    join app.boxes physical
      on physical.org_id = t.org_id
     and physical.id = t.box_record_id
    join app.allocations linked
      on linked.org_id = t.org_id
     and linked.allocation_id = t.transfer_created_allocation_id
    where t.org_id = p_org_id
      and t.status = 'PENDING'
      and t.transfer_created_allocation_id is not null
    union all
    select linked.box_id, physical.box_id
    from app.box_transfers t
    join app.boxes physical
      on physical.org_id = t.org_id
     and physical.id = t.box_record_id
    join app.allocations linked
      on linked.org_id = t.org_id
     and linked.allocation_id = t.transfer_created_allocation_id
    where t.org_id = p_org_id
      and t.status = 'PENDING'
      and t.transfer_created_allocation_id is not null
  ),
  affected(box_id) as (
    select unnest(v_plan_box_ids)
    union
    select e.to_box_id
    from affected a
    join transfer_edges e on e.from_box_id = a.box_id
  )
  select coalesce(array_agg(distinct box_id order by box_id), array[]::text[])
  into v_affected_box_ids
  from affected;

  if exists (
    select 1
    from app.box_transfers t
    left join app.boxes physical
      on physical.org_id = t.org_id
     and physical.id = t.box_record_id
    left join app.allocations linked
      on linked.org_id = t.org_id
     and linked.allocation_id = t.transfer_created_allocation_id
    where t.org_id = p_org_id
      and t.status = 'PENDING'
      and t.transfer_created_allocation_id is not null
      and physical.box_id = any(v_plan_box_ids)
      and (physical.id is null or linked.id is null)
  ) then
    perform app_api.raise_http(409, 'A linked pending-transfer identity could not be resolved. Reload and retry.');
  end if;

  select count(*)::integer,
    coalesce(jsonb_object_agg(
      s.box_id,
      jsonb_build_object(
        'boxRecordId', s.box_record_id::text,
        'status', s.status,
        'warehouse', s.warehouse,
        'physicalFeet', s.physical_feet,
        'storedFeet', s.stored_feet,
        'reservedFeet', s.reserved_feet,
        'reservationCount', s.reservation_count,
        'allocationState', s.allocation_state,
        'planningFeet', s.planning_feet,
        'pendingTransfer', s.pending_transfer,
        'pendingTransferState', s.pending_transfer_state,
        'manufacturer', coalesce(s.manufacturer, ''),
        'filmName', coalesce(s.film_name, ''),
        'widthIn', s.width_in
      ) order by s.box_id
    ), '{}'::jsonb)
  into v_actual_count, v_pre_states
  from app_api.allocation_apply_box_states_0192(p_org_id, v_affected_box_ids) s;

  if v_actual_count <> coalesce(array_length(v_affected_box_ids, 1), 0) then
    perform app_api.raise_http(409, 'An affected allocation identity could not be resolved. Reload and retry.');
  end if;

  for v_box_id in
    select key_value
    from jsonb_object_keys(v_plan_states) keys(key_value)
    order by key_value
  loop
    if v_plan_states->v_box_id is distinct from v_pre_states->v_box_id then
      perform app_api.raise_http(409, 'Allocation state changed while building the canonical plan. Reload and retry.');
    end if;
  end loop;

  perform b.id
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = any(v_affected_box_ids)
  order by upper(b.box_id), b.box_id, b.id
  for update;
  get diagnostics v_actual_count = row_count;
  if v_actual_count <> coalesce(array_length(v_affected_box_ids, 1), 0) then
    perform app_api.raise_http(409, 'An affected allocation box could not be locked. Reload and retry.');
  end if;

  perform a.id
  from app.allocations a
  where a.org_id = p_org_id
    and a.box_id = any(v_affected_box_ids)
  order by upper(a.box_id), a.box_id, a.allocation_id, a.id
  for update;

  perform t.id
  from app.box_transfers t
  join app.boxes b
    on b.org_id = t.org_id
   and b.id = t.box_record_id
  where t.org_id = p_org_id
    and (
      b.box_id = any(v_affected_box_ids)
      or exists (
        select 1
        from app.allocations a
        where a.org_id = t.org_id
          and a.allocation_id = t.transfer_created_allocation_id
          and a.box_id = any(v_affected_box_ids)
      )
    )
  order by b.box_id, t.created_at, t.id
  for update of t;

  if v_job_id is not null then
    select * into v_job
    from app.jobs j
    where j.org_id = p_org_id
      and j.id = v_job_id
    for update;
    if not found then
      perform app_api.raise_http(409, 'The allocation job changed before apply. Reload and retry.');
    end if;

    if jsonb_build_object(
      'id', v_job.id::text,
      'jobNumber', v_job.job_number,
      'warehouse', upper(coalesce(v_job.warehouse, '')),
      'lifecycleStatus', coalesce(v_job.lifecycle_status::text, 'ACTIVE'),
      'dueDate', coalesce(to_char(v_job.due_date, 'YYYY-MM-DD'), ''),
      'crewLeader', coalesce(v_job.crew_leader, '')
    ) is distinct from v_plan->'jobState' then
      perform app_api.raise_http(409, 'The allocation job changed before apply. Reload and retry.');
    end if;
  elsif coalesce(v_plan->'jobState', '{}'::jsonb) <> '{}'::jsonb then
    perform app_api.raise_http(409, 'The allocation job identity could not be resolved. Reload and retry.');
  end if;

  if v_phase_id is not null then
    select * into v_phase
    from app.job_phases ph
    where ph.org_id = p_org_id
      and ph.id = v_phase_id
      and ph.job_id = v_job_id
    for update;
    if not found or jsonb_build_object(
      'id', v_phase.id::text,
      'jobId', v_phase.job_id::text,
      'installDate', coalesce(to_char(v_phase.install_date, 'YYYY-MM-DD'), ''),
      'crewLeader', coalesce(v_phase.crew_leader, ''),
      'laborStatus', coalesce(v_phase.labor_status, 'ACTIVE')
    ) is distinct from v_plan->'phaseState' then
      perform app_api.raise_http(409, 'The allocation phase changed before apply. Reload and retry.');
    end if;
  end if;

  if v_requirement_id is not null then
    select * into v_requirement
    from app.job_requirements r
    where r.org_id = p_org_id
      and r.id = v_requirement_id
      and r.job_id = v_job.id
    for update;
    if not found or jsonb_build_object(
      'id', v_requirement.id::text,
      'jobId', v_requirement.job_id::text,
      'manufacturer', coalesce(v_requirement.manufacturer, ''),
      'filmName', coalesce(v_requirement.film_name, ''),
      'widthIn', v_requirement.width_in,
      'status', coalesce(v_requirement.status, 'ACTIVE'),
      'phaseId', v_requirement.phase_id::text
    ) is distinct from v_plan->'requirementState' then
      perform app_api.raise_http(409, 'The allocation requirement changed before apply. Reload and retry.');
    end if;
  end if;

  select count(*)::integer,
    coalesce(jsonb_object_agg(
      s.box_id,
      jsonb_build_object(
        'boxRecordId', s.box_record_id::text,
        'status', s.status,
        'warehouse', s.warehouse,
        'physicalFeet', s.physical_feet,
        'storedFeet', s.stored_feet,
        'reservedFeet', s.reserved_feet,
        'reservationCount', s.reservation_count,
        'allocationState', s.allocation_state,
        'planningFeet', s.planning_feet,
        'pendingTransfer', s.pending_transfer,
        'pendingTransferState', s.pending_transfer_state,
        'manufacturer', coalesce(s.manufacturer, ''),
        'filmName', coalesce(s.film_name, ''),
        'widthIn', s.width_in
      ) order by s.box_id
    ), '{}'::jsonb)
  into v_actual_count, v_locked_states
  from app_api.allocation_apply_box_states_0192(p_org_id, v_affected_box_ids) s;

  if v_actual_count <> coalesce(array_length(v_affected_box_ids, 1), 0) then
    perform app_api.raise_http(409, 'An affected allocation box changed before validation. Reload and retry.');
  end if;

  if v_pre_states is distinct from v_locked_states then
    perform app_api.raise_http(409, 'Allocation state changed before apply. Reload and retry.');
  end if;

  for v_box_id, v_expected_count in
    select
      operation.value->>'boxId',
      sum((operation.value->>'allocatedFeet')::integer)::integer
    from jsonb_array_elements(v_operations) operation(value)
    group by operation.value->>'boxId'
    order by operation.value->>'boxId'
  loop
    if v_locked_states->v_box_id is null
      or coalesce((v_locked_states->v_box_id->>'planningFeet')::integer, 0) < v_expected_count
    then
      perform app_api.raise_http(409, 'Allocation capacity changed before apply. Reload and retry.');
    end if;
  end loop;

  for v_operation in
    select value
    from jsonb_array_elements(v_operations) with ordinality entries(value, ordinality)
    order by ordinality
  loop
    v_box_id := app_api.require_text(v_operation->>'boxId', 'BoxID');
    v_pre_state := v_locked_states->v_box_id;
    if v_pre_state is null then
      perform app_api.raise_http(409, 'Allocation box changed before validation completed.');
    end if;
    if upper(coalesce(v_pre_state->>'status', '')) = 'TRANSFER'
      or coalesce((v_pre_state->>'pendingTransfer')::boolean, false)
    then
      perform app_api.raise_http(409, 'Pending-transfer boxes cannot receive additional allocations.');
    end if;
    v_pre_warehouse := upper(coalesce(v_pre_state->>'warehouse', ''));
    v_allocation_job_warehouse := upper(coalesce(v_job.warehouse, ''));
    if v_allocation_job_warehouse <> '' and v_pre_warehouse <> v_allocation_job_warehouse then
      if not v_cross_warehouse then
        perform app_api.raise_http(409, 'Cross-warehouse allocation requires crossWarehouse approval.');
      end if;
      if v_payload_job_warehouse <> '' and v_payload_job_warehouse <> v_allocation_job_warehouse then
        perform app_api.raise_http(409, 'Allocation destination does not match the current job warehouse.');
      end if;
      if upper(coalesce(v_pre_state->>'status', '')) <> 'IN_STOCK' then
        perform app_api.raise_http(409, 'Transfer-assisted allocation can start only from an in-stock box.');
      end if;
      if coalesce((v_pre_state->>'reservationCount')::integer, 0) <> 0 then
        perform app_api.raise_http(409, 'Transfer-assisted allocation requires a box with zero prior reservations.');
      end if;
      if coalesce(v_operation->>'kind', 'REQUIREMENT') <> 'REQUIREMENT'
        or v_requirement_id is null
      then
        perform app_api.raise_http(409, 'Cross-warehouse extra film must be transferred and received before it can be allocated.');
      end if;
      v_cross_box_count := coalesce((v_cross_box_counts->>v_box_id)::integer, 0) + 1;
      if v_cross_box_count <> 1 then
        perform app_api.raise_http(409, 'A cross-warehouse box can satisfy only one requirement per apply request.');
      end if;
      v_cross_box_counts := jsonb_set(v_cross_box_counts, array[v_box_id], to_jsonb(v_cross_box_count), true);
    end if;
  end loop;

  for v_operation in
    select value
    from jsonb_array_elements(v_operations) with ordinality entries(value, ordinality)
    order by ordinality
  loop
    v_box_id := app_api.require_text(v_operation->>'boxId', 'BoxID');
    select * into v_box
    from app.boxes b
    where b.org_id = p_org_id
      and b.box_id = v_box_id;

    if coalesce(v_operation->>'kind', 'REQUIREMENT') = 'EXTRA' then
      v_allocation := app_api.create_allocation(
        p_org_id,
        v_box,
        v_job_context,
        (v_operation->>'allocatedFeet')::integer,
        p_actor,
        '',
        'EXTRA',
        null
      );
    else
      v_allocation := app_api.create_or_merge_manual_requirement_allocation_with_coverage(
        p_org_id,
        v_box,
        v_job_context,
        (v_operation->>'allocatedFeet')::integer,
        (v_operation->>'coveredFeet')::integer,
        p_actor,
        '',
        'REQUIREMENT',
        v_requirement_id
      );
    end if;

    if coalesce(v_box.status::text, '') in ('IN_STOCK', 'TRANSFER') then
      if coalesce(v_operation->>'role', '') = 'SUGGESTION' then
        v_box.feet_available := greatest(v_box.feet_available - v_allocation.allocated_feet, 0);
      else
        v_box.feet_available := greatest(v_box.feet_available - (v_operation->>'allocatedFeet')::integer, 0);
      end if;
      perform app_api.save_box(v_box);
    end if;

    v_allocation_ids := array_append(v_allocation_ids, v_allocation.allocation_id);
  end loop;

  foreach v_allocation_id in array v_allocation_ids
  loop
    select * into v_allocation
    from app.allocations a
    where a.org_id = p_org_id
      and a.allocation_id = v_allocation_id;
    if not found then
      perform app_api.raise_http(409, 'Allocation result changed before transfer validation completed.');
    end if;

    v_pre_state := v_locked_states->v_allocation.box_id;
    select upper(j.warehouse)
    into v_allocation_job_warehouse
    from app.jobs j
    where j.org_id = p_org_id
      and j.id = v_allocation.job_id;

    v_pre_warehouse := upper(coalesce(v_pre_state->>'warehouse', ''));
    if coalesce(v_allocation_job_warehouse, '') <> ''
      and v_pre_warehouse <> v_allocation_job_warehouse
    then
      v_transfer := app_api.start_box_transfer_locked(
        p_org_id,
        p_actor,
        v_allocation.box_id,
        v_allocation_job_warehouse,
        'Transfer-assisted allocation.',
        v_allocation.allocation_id,
        '',
        nullif(v_pre_state->>'physicalFeet', '')::integer
      );
      v_transfer_ids := array_append(v_transfer_ids, v_transfer.transfer_id);
    end if;
  end loop;

  return jsonb_build_object(
    'allocationIds', to_jsonb(v_allocation_ids),
    'filmOrderId', ''::text,
    'remainingUncoveredFeet', greatest(coalesce((v_plan->>'remainingUncoveredFeet')::integer, 0), 0),
    'warnings', coalesce(v_plan->'warnings', '[]'::jsonb),
    'transferIds', to_jsonb(v_transfer_ids)
  );
end;
$$;

alter function public.api_allocations_apply(uuid, text, jsonb) owner to postgres;
revoke execute on function public.api_allocations_apply(uuid, text, jsonb)
  from public, anon, authenticated, service_role;

do $$
declare
  v_plan_count integer;
  v_plan_owner text;
  v_plan_security_definer boolean;
  v_plan_config text[];
  v_plan_def text;
  v_apply_count integer;
  v_apply_owner text;
  v_apply_security_definer boolean;
  v_apply_config text[];
  v_apply_def text;
begin
  select count(*)::integer
  into v_plan_count
  from pg_proc p
  where p.oid = to_regprocedure('app_api.build_allocation_apply_plan_0201(uuid, text, jsonb)');

  select pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig, pg_get_functiondef(p.oid)
  into v_plan_owner, v_plan_security_definer, v_plan_config, v_plan_def
  from pg_proc p
  where p.oid = 'app_api.build_allocation_apply_plan_0201(uuid, text, jsonb)'::regprocedure;

  if v_plan_count <> 1
    or v_plan_owner <> 'postgres'
    or not coalesce(v_plan_security_definer, false)
    or not coalesce('search_path=public, app, app_api' = any(v_plan_config), false)
    or position('build_allocation_apply_plan_0192' in v_plan_def) = 0
    or position('PRIMARY_EXTRA' in v_plan_def) = 0
    or position('allocationKind' in v_plan_def) = 0
  then
    raise exception 'Migration 0201 primary EXTRA planner invariant failed.';
  end if;

  if exists (
    select 1
    from pg_proc p
    cross join lateral aclexplode(
      coalesce(p.proacl, acldefault('f', p.proowner))
    ) acl
    left join pg_roles granted_role on granted_role.oid = acl.grantee
    where p.oid = 'app_api.build_allocation_apply_plan_0201(uuid, text, jsonb)'::regprocedure
      and acl.privilege_type = 'EXECUTE'
      and (acl.grantee = 0 or granted_role.rolname in ('anon', 'authenticated', 'service_role'))
  ) then
    raise exception 'Migration 0201 primary EXTRA planner ACL invariant failed.';
  end if;

  select count(*)::integer
  into v_apply_count
  from pg_proc p
  where p.oid = to_regprocedure('public.api_allocations_apply(uuid, text, jsonb)');

  select pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig, pg_get_functiondef(p.oid)
  into v_apply_owner, v_apply_security_definer, v_apply_config, v_apply_def
  from pg_proc p
  where p.oid = 'public.api_allocations_apply(uuid, text, jsonb)'::regprocedure;

  if v_apply_count <> 1
    or v_apply_owner <> 'postgres'
    or not coalesce(v_apply_security_definer, false)
    or not coalesce('search_path=public, app, app_api' = any(v_apply_config), false)
    or (
      select count(*)::integer
      from regexp_matches(v_apply_def, 'app_api\.build_allocation_apply_plan_0201\(', 'g')
    ) <> 1
    or position('app_api.build_allocation_apply_plan_0192(p_org_id, p_actor, v_payload)' in v_apply_def) > 0
  then
    raise exception 'Migration 0201 allocation apply invariant failed.';
  end if;

  if exists (
    select 1
    from pg_proc p
    cross join lateral aclexplode(
      coalesce(p.proacl, acldefault('f', p.proowner))
    ) acl
    left join pg_roles granted_role on granted_role.oid = acl.grantee
    where p.oid = 'public.api_allocations_apply(uuid, text, jsonb)'::regprocedure
      and acl.privilege_type = 'EXECUTE'
      and (acl.grantee = 0 or granted_role.rolname in ('anon', 'authenticated', 'service_role'))
  ) then
    raise exception 'Migration 0201 allocation apply ACL invariant failed.';
  end if;
end;
$$;
