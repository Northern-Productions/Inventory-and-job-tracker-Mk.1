/*
 * PURPOSE:
 * Bounds atomic allocation-apply state capture to one canonical allocation
 * plan so PostgREST does not scan every box in the organization.
 *
 * AFFECTS:
 * public.api_allocations_apply only. The ACL wrapper, transfer lifecycle,
 * pending-transfer guards, and migration 0191 remain unchanged.
 */

-- Compatibility normalization for environments that retained this historical
-- direct grant. The public worker remains private; authenticated callers use
-- public.api_acl_allocations_apply.
revoke execute on function public.api_allocations_apply(uuid, text, jsonb)
  from service_role;

do $$
declare
  v_apply_owner text;
  v_apply_security_definer boolean;
  v_apply_config text[];
  v_apply_count integer := 0;
begin
  select count(*)::integer
  into v_apply_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'api_allocations_apply';

  select pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
  into v_apply_owner, v_apply_security_definer, v_apply_config
  from pg_proc p
  where p.oid = 'public.api_allocations_apply(uuid, text, jsonb)'::regprocedure;

  if v_apply_count <> 1
    or v_apply_owner <> 'postgres'
    or not v_apply_security_definer
    or not ('search_path=public, app, app_api' = any(coalesce(v_apply_config, array[]::text[])))
  then
    raise exception '0192 allocation apply precondition contract failed';
  end if;

  if exists (
    select 1
    from aclexplode(coalesce(
      (select p.proacl from pg_proc p where p.oid = 'public.api_allocations_apply(uuid, text, jsonb)'::regprocedure),
      acldefault('f', (select p.proowner from pg_proc p where p.oid = 'public.api_allocations_apply(uuid, text, jsonb)'::regprocedure))
    )) acl
    left join pg_roles r on r.oid = acl.grantee
    where acl.privilege_type = 'EXECUTE'
      and (acl.grantee = 0 or r.rolname in ('anon', 'authenticated', 'service_role'))
  ) then
    raise exception '0192 allocation apply precondition execute grants failed';
  end if;
end;
$$;

create or replace function app_api.allocation_apply_box_states_0192(
  p_org_id uuid,
  p_box_ids text[]
)
returns table (
  box_id text,
  box_record_id uuid,
  status text,
  warehouse text,
  manufacturer text,
  film_name text,
  width_in numeric,
  physical_feet integer,
  stored_feet integer,
  reserved_feet integer,
  reservation_count integer,
  allocation_state jsonb,
  planning_feet integer,
  pending_transfer boolean,
  pending_transfer_state jsonb
)
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  with requested as materialized (
    select distinct app_api.trim_text(entry) as box_id
    from unnest(coalesce(p_box_ids, array[]::text[])) entry
    where app_api.trim_text(entry) <> ''
  ),
  affected_boxes as materialized (
    select b.*
    from requested r
    join app.boxes b
      on b.org_id = p_org_id
     and b.box_id = r.box_id
  ),
  allocation_state as materialized (
    select
      b.box_id,
      coalesce(sum(coalesce(a.allocated_feet, 0)) filter (
        where a.id is not null
          and app_api.film_allocation_consumes_stored_capacity(a, b.status::text)
      ), 0)::integer as stored_feet,
      coalesce(sum(coalesce(a.allocated_feet, 0)) filter (
        where a.id is not null
          and app_api.film_allocation_reserves_capacity(a, b.status::text)
      ), 0)::integer as reserved_feet,
      count(a.id) filter (
        where app_api.film_allocation_reserves_capacity(a, b.status::text)
      )::integer as reservation_count,
      coalesce(
        jsonb_agg(
          jsonb_build_array(
            a.id::text,
            a.allocation_id,
            a.box_id,
            a.job_id::text,
            a.job_number,
            a.warehouse::text,
            coalesce(to_char(a.job_date, 'YYYY-MM-DD'), ''),
            a.allocated_feet,
            a.covered_feet,
            a.status::text,
            a.crew_leader,
            a.film_order_id,
            a.allocation_kind::text,
            a.requirement_id::text,
            a.allocation_source::text,
            a.created_at
          )
          order by a.created_at, a.allocation_id, a.id
        ) filter (where a.id is not null),
        '[]'::jsonb
      ) as allocation_state
    from affected_boxes b
    left join app.allocations a
      on a.org_id = p_org_id
     and a.box_id = b.box_id
    group by b.box_id
  ),
  transfer_state as materialized (
    select
      b.id as box_record_id,
      bool_or(t.id is not null) as pending_transfer,
      coalesce(
        jsonb_agg(
          jsonb_build_array(
            t.id::text,
            t.transfer_id,
            t.box_record_id::text,
            t.source_box_id,
            t.destination_box_id,
            t.source_warehouse,
            t.destination_warehouse,
            t.status,
            t.transfer_created_allocation_id,
            t.created_at
          )
          order by t.created_at, t.transfer_id, t.id
        ) filter (where t.id is not null),
        '[]'::jsonb
      ) as pending_transfer_state
    from affected_boxes b
    left join app.box_transfers t
      on t.org_id = p_org_id
     and t.box_record_id = b.id
     and t.status = 'PENDING'
    group by b.id
  ),
  physical_state as materialized (
    select
      b.*,
      coalesce(a.stored_feet, 0)::integer as stored_feet,
      coalesce(a.reserved_feet, 0)::integer as reserved_feet,
      coalesce(a.reservation_count, 0)::integer as reservation_count,
      coalesce(a.allocation_state, '[]'::jsonb) as allocation_state,
      coalesce(t.pending_transfer, false) as pending_transfer,
      coalesce(t.pending_transfer_state, '[]'::jsonb) as pending_transfer_state,
      case
        when upper(coalesce(b.status::text, '')) not in ('IN_STOCK', 'TRANSFER', 'CHECKED_OUT') then null
        when b.last_roll_weight_lbs is not null
          and b.core_weight_lbs is not null
          and b.lf_weight_lbs_per_ft is not null
          and b.lf_weight_lbs_per_ft > 0
        then app_api.derive_feet_available_from_roll_weight(
          b.last_roll_weight_lbs,
          b.core_weight_lbs,
          b.lf_weight_lbs_per_ft,
          b.initial_feet
        )
        when upper(coalesce(b.status::text, '')) = 'CHECKED_OUT' then greatest(
          coalesce(b.feet_available, 0),
          0
        )
        else greatest(
          coalesce(b.feet_available, 0) + coalesce(a.stored_feet, 0),
          0
        )
      end::integer as physical_feet
    from affected_boxes b
    left join allocation_state a on a.box_id = b.box_id
    left join transfer_state t on t.box_record_id = b.id
  )
  select
    s.box_id,
    s.id as box_record_id,
    upper(coalesce(s.status::text, '')) as status,
    upper(coalesce(s.warehouse, '')) as warehouse,
    s.manufacturer,
    s.film_name,
    s.width_in,
    s.physical_feet,
    s.stored_feet,
    s.reserved_feet,
    s.reservation_count,
    s.allocation_state,
    case
      when upper(coalesce(s.status::text, '')) in ('IN_STOCK', 'TRANSFER', 'CHECKED_OUT') then greatest(
        coalesce(s.physical_feet, 0) - s.reserved_feet,
        0
      )
      when upper(coalesce(s.status::text, '')) = 'ORDERED' then greatest(
        coalesce(s.initial_feet, 0) - s.reserved_feet,
        0
      )
      else 0
    end::integer as planning_feet,
    s.pending_transfer,
    s.pending_transfer_state
  from physical_state s
  order by s.box_id;
$$;

create or replace function app_api.build_allocation_apply_plan_0192(
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
  v_source app.boxes;
  v_candidate app.boxes;
  v_state record;
  v_job app.jobs;
  v_job_context jsonb;
  v_job_id_text text := app_api.trim_text(v_payload->>'jobId');
  v_has_job_id boolean := v_job_id_text <> '';
  v_job_id uuid;
  v_job_number text;
  v_job_match_count integer := 0;
  v_job_date date;
  v_payload_job_date date;
  v_crew_leader text;
  v_payload_crew_leader text := '';
  v_job_warehouse text := '';
  v_payload_job_warehouse text := upper(app_api.trim_text(v_payload->>'jobWarehouse'));
  v_requested_feet integer := coalesce(floor(nullif(app_api.trim_text(v_payload->>'requestedFeet'), '')::numeric), 0);
  v_requested_width_in numeric := nullif(app_api.trim_text(v_payload->>'requestedWidthIn'), '')::numeric;
  v_requirement_id_text text := app_api.trim_text(v_payload->>'requirementId');
  v_should_validate_requirement boolean := false;
  v_requirement_id uuid;
  v_requirement app.job_requirements;
  v_requirement_phase app.job_phases;
  v_requirement_phase_install_date date;
  v_requirement_phase_crew_leader text := '';
  v_requirement_has_phase boolean := false;
  v_requirement_state jsonb := '{}'::jsonb;
  v_phase_state jsonb := '{}'::jsonb;
  v_source_film_key text;
  v_requirement_is_exterior boolean := false;
  v_remaining integer := 0;
  v_source_suggested integer := 0;
  v_source_suggested_covered integer := 0;
  v_candidate_suggested integer := 0;
  v_candidate_suggested_covered integer := 0;
  v_cross_warehouse boolean := coalesce((v_payload->>'crossWarehouse')::boolean, false);
  v_auto_allocate boolean := coalesce((v_payload->>'autoAllocate')::boolean, false);
  v_selected_box_ids text[] := array[]::text[];
  v_extra_allocations jsonb := coalesce(v_payload->'extraAllocations', '[]'::jsonb);
  v_extra_entry jsonb;
  v_extra_box_id text;
  v_extra_feet integer;
  v_candidate_box_ids text[] := array[]::text[];
  v_conflict_box_ids text[] := array[]::text[];
  v_operations jsonb := '[]'::jsonb;
  v_operation_box_ids text[] := array[]::text[];
  v_requested_box_ids text[] := array[]::text[];
  v_plan_box_ids text[] := array[]::text[];
  v_plan_states jsonb := '{}'::jsonb;
  v_expected_count integer := 0;
  v_actual_count integer := 0;
  v_planned_for_box integer := 0;
begin
  perform app_api.require_org_member(p_org_id);

  if v_requested_feet < 0 then
    perform app_api.raise_http(400, 'RequestedFeet must be zero or greater.');
  end if;

  if coalesce(jsonb_typeof(v_extra_allocations), '') not in ('', 'array') then
    perform app_api.raise_http(400, 'extraAllocations must be an array.');
  end if;

  if v_payload ? 'selectedSuggestionBoxIds' then
    if jsonb_typeof(v_payload->'selectedSuggestionBoxIds') <> 'array' then
      perform app_api.raise_http(400, 'selectedSuggestionBoxIds must be an array.');
    end if;
    select coalesce(array_agg(app_api.trim_text(value) order by ordinality), array[]::text[])
    into v_selected_box_ids
    from jsonb_array_elements_text(v_payload->'selectedSuggestionBoxIds') with ordinality entries(value, ordinality)
    where app_api.trim_text(value) <> '';
  end if;

  select *
  into v_source
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = app_api.require_text(v_payload->>'boxId', 'BoxID');

  if not found then
    perform app_api.raise_http(404, 'Box not found.');
  end if;

  if coalesce(v_source.status::text, '') not in ('IN_STOCK', 'ORDERED', 'TRANSFER', 'CHECKED_OUT') then
    perform app_api.raise_http(400, 'Only in-stock, checked-out, ordered, or transfer boxes can be allocated.');
  end if;

  v_requested_box_ids := array_append(v_requested_box_ids, v_source.box_id);
  v_requested_box_ids := v_requested_box_ids || v_selected_box_ids;

  for v_extra_entry in
    select value
    from jsonb_array_elements(v_extra_allocations)
  loop
    if coalesce(jsonb_typeof(v_extra_entry), '') <> 'object' then
      perform app_api.raise_http(400, 'Each extra allocation entry must be an object.');
    end if;
    v_requested_box_ids := array_append(
      v_requested_box_ids,
      app_api.require_text(v_extra_entry->>'boxId', 'extraAllocations[].boxId')
    );
  end loop;

  select count(*)::integer, count(distinct upper(entry))::integer
  into v_expected_count, v_actual_count
  from unnest(v_requested_box_ids) entry;

  if v_expected_count <> v_actual_count then
    perform app_api.raise_http(
      409,
      'The same box cannot be selected more than once in one allocation apply request.'
    );
  end if;

  if v_has_job_id then
    begin
      v_job_id := v_job_id_text::uuid;
    exception
      when others then
        perform app_api.raise_http(400, 'jobId must be a valid UUID.');
    end;

    select *
    into v_job
    from app.jobs j
    where j.org_id = p_org_id
      and j.id = v_job_id;

    if not found then
      perform app_api.raise_http(404, 'Job was not found.');
    end if;

    v_job_number := app_api.require_text(v_payload->>'jobNumber', 'JobNumber');
    if upper(trim(v_job.job_number)) <> upper(trim(v_job_number)) then
      perform app_api.raise_http(400, 'Job identity mismatch: selected job does not match jobNumber.');
    end if;

    if coalesce(v_job.lifecycle_status::text, 'ACTIVE') <> 'ACTIVE' then
      perform app_api.raise_http(400, format('Job %s is closed and cannot receive allocations.', v_job.job_number));
    end if;

    if v_payload_job_warehouse <> '' and v_payload_job_warehouse <> upper(v_job.warehouse) then
      perform app_api.raise_http(409, 'Job warehouse changed before allocation. Reload and retry.');
    end if;
    v_payload_job_warehouse := upper(v_job.warehouse);

    v_payload_job_date := nullif(app_api.trim_text(v_payload->>'jobDate'), '')::date;
    v_payload_crew_leader := app_api.trim_text(v_payload->>'crewLeader');
    v_job_date := v_payload_job_date;
    v_crew_leader := v_payload_crew_leader;

    if v_requirement_id_text = ''
      and v_job.due_date is not null
      and v_job_date is not null
      and v_job.due_date <> v_job_date
    then
      perform app_api.raise_http(400, 'JobDate must stay the same for an existing Job Number.');
    end if;

    if v_requirement_id_text = ''
      and coalesce(v_job.crew_leader, '') <> ''
      and v_crew_leader <> ''
      and upper(coalesce(v_job.crew_leader, '')) <> upper(v_crew_leader)
    then
      perform app_api.raise_http(400, 'CrewLeader must stay the same for an existing Job Number.');
    end if;

    v_job_date := coalesce(v_job_date, v_job.due_date);
    v_crew_leader := coalesce(nullif(v_crew_leader, ''), v_job.crew_leader, '');

    if v_job_date is not null and v_crew_leader = '' then
      perform app_api.raise_http(400, 'CrewLeader is required when JobDate is set.');
    end if;

    v_job_context := jsonb_build_object(
      'jobId', v_job.id::text,
      'jobNumber', v_job.job_number,
      'jobDate', coalesce(to_char(v_job_date, 'YYYY-MM-DD'), ''),
      'crewLeader', v_crew_leader
    );
  else
    v_job_context := app_api.resolve_job_context(
      p_org_id,
      v_payload->>'jobNumber',
      v_payload->>'jobDate',
      v_payload->>'crewLeader'
    );
    v_job_number := v_job_context->>'jobNumber';
    v_job_id := app_api.get_or_resolve_job_id(p_org_id, v_job_number);
    if v_job_id is not null then
      select * into v_job
      from app.jobs j
      where j.org_id = p_org_id
        and j.id = v_job_id;
    end if;

    if v_payload_job_warehouse = '' and v_job_number <> '' then
      select min(j.warehouse), count(*)::integer
      into v_payload_job_warehouse, v_job_match_count
      from app.jobs j
      where j.org_id = p_org_id
        and upper(j.job_number) = upper(v_job_number);

      if v_job_match_count > 1 then
        v_payload_job_warehouse := '';
      end if;
      v_payload_job_warehouse := upper(coalesce(v_payload_job_warehouse, ''));
    end if;
  end if;

  v_job_warehouse := upper(coalesce(v_job.warehouse, ''));

  v_source_film_key := app_api.normalize_requirement_film_key(
    p_org_id,
    v_source.manufacturer,
    v_source.film_name
  );

  v_should_validate_requirement := v_requested_feet > 0 or v_requirement_id_text <> '';
  if v_should_validate_requirement then
    if v_requirement_id_text = '' then
      perform app_api.raise_http(400, 'RequirementId is required for film allocations.');
    end if;
    begin
      v_requirement_id := v_requirement_id_text::uuid;
    exception
      when others then
        perform app_api.raise_http(400, 'RequirementId must be a valid UUID.');
    end;

    select r.*
    into v_requirement
    from app.job_requirements r
    where r.org_id = p_org_id
      and r.job_id = v_job_id
      and r.id = v_requirement_id;

    if not found then
      perform app_api.raise_http(
        400,
        format('Requirement %s does not belong to job %s.', v_requirement_id, v_job_context->>'jobNumber')
      );
    end if;

    if coalesce(v_requirement.status, 'ACTIVE') = 'COMPLETE' then
      perform app_api.raise_http(
        400,
        format('Requirement %s is complete. Reactivate it before allocating film.', v_requirement_id)
      );
    end if;

    select ph.*
    into v_requirement_phase
    from app.job_phases ph
    where ph.org_id = p_org_id
      and ph.job_id = v_job_id
      and ph.id = v_requirement.phase_id;

    v_requirement_has_phase := found;
    if v_requirement_has_phase then
      v_requirement_phase_install_date := v_requirement_phase.install_date;
      v_requirement_phase_crew_leader := coalesce(v_requirement_phase.crew_leader, '');
      v_phase_state := jsonb_build_object(
        'id', v_requirement_phase.id::text,
        'jobId', v_requirement_phase.job_id::text,
        'installDate', coalesce(to_char(v_requirement_phase.install_date, 'YYYY-MM-DD'), ''),
        'crewLeader', coalesce(v_requirement_phase.crew_leader, ''),
        'laborStatus', coalesce(v_requirement_phase.labor_status, 'ACTIVE')
      );
    end if;

    if v_has_job_id and v_requirement_has_phase then
      if v_requirement_phase_install_date is not null
        and v_payload_job_date is not null
        and v_requirement_phase_install_date <> v_payload_job_date
      then
        perform app_api.raise_http(400, 'JobDate must match the selected requirement phase.');
      end if;

      if v_requirement_phase_crew_leader <> ''
        and v_payload_crew_leader <> ''
        and upper(v_requirement_phase_crew_leader) <> upper(v_payload_crew_leader)
      then
        perform app_api.raise_http(400, 'CrewLeader must match the selected requirement phase.');
      end if;

      v_job_date := v_requirement_phase_install_date;
      v_crew_leader := coalesce(nullif(v_requirement_phase_crew_leader, ''), '');

      if v_job_date is not null and v_crew_leader = '' then
        perform app_api.raise_http(400, 'CrewLeader is required when JobDate is set.');
      end if;

      v_job_context := jsonb_build_object(
        'jobId', v_job.id::text,
        'jobNumber', v_job.job_number,
        'jobDate', coalesce(to_char(v_job_date, 'YYYY-MM-DD'), ''),
        'crewLeader', v_crew_leader
      );
    end if;

    v_requirement_is_exterior := app_api.requirement_film_is_exterior(
      p_org_id,
      v_requirement.manufacturer,
      v_requirement.film_name
    );

    if not app_api.requirement_film_is_compatible(
      p_org_id,
      v_source.manufacturer,
      v_source.film_name,
      v_requirement.manufacturer,
      v_requirement.film_name
    ) or v_source.width_in < v_requirement.width_in then
      perform app_api.raise_http(
        400,
        format('Box %s does not match requirement %s.', v_source.box_id, v_requirement_id)
      );
    end if;

    v_requested_width_in := v_requirement.width_in;
    v_requirement_state := jsonb_build_object(
      'id', v_requirement.id::text,
      'jobId', v_requirement.job_id::text,
      'manufacturer', coalesce(v_requirement.manufacturer, ''),
      'filmName', coalesce(v_requirement.film_name, ''),
      'widthIn', v_requirement.width_in,
      'status', coalesce(v_requirement.status, 'ACTIVE'),
      'phaseId', v_requirement.phase_id::text
    );
  elsif v_requested_width_in is null or v_requested_width_in <= 0 then
    v_requested_width_in := v_source.width_in;
  end if;

  if v_source.width_in < v_requested_width_in then
    perform app_api.raise_http(400, 'Source box width must meet or exceed the requested width.');
  end if;

  select * into v_state
  from app_api.allocation_apply_box_states_0192(p_org_id, array[v_source.box_id]);
  if not found then
    perform app_api.raise_http(404, 'Box not found.');
  end if;

  v_remaining := greatest(v_requested_feet, 0);
  if v_requested_feet > 0 and not exists (
    select 1
    from app.allocations a
    where a.org_id = p_org_id
      and a.box_id = v_source.box_id
      and a.status = 'ACTIVE'
      and coalesce(to_char(a.job_date, 'YYYY-MM-DD'), '') = coalesce(v_job_context->>'jobDate', '')
      and case
        when v_has_job_id then a.job_id is distinct from v_job.id
        else upper(a.job_number) <> upper(v_job_context->>'jobNumber')
      end
      and upper(coalesce(a.crew_leader, '')) <> upper(coalesce(v_job_context->>'crewLeader', ''))
  ) then
    select p.allocated_feet, p.covered_feet, p.remaining_covered_feet
    into v_source_suggested, v_source_suggested_covered, v_remaining
    from app_api.plan_allocation_coverage(
      v_remaining,
      v_state.planning_feet,
      v_source.width_in,
      v_requested_width_in
    ) p;
  end if;

  if v_source_suggested > 0 then
    v_operations := v_operations || jsonb_build_array(jsonb_build_object(
      'ordinal', jsonb_array_length(v_operations) + 1,
      'role', 'SOURCE',
      'kind', 'REQUIREMENT',
      'boxId', v_source.box_id,
      'allocatedFeet', v_source_suggested,
      'coveredFeet', v_source_suggested_covered,
      'priorBoxIds', jsonb_build_array(v_source.box_id)
    ));
    v_operation_box_ids := array_append(v_operation_box_ids, v_source.box_id);
  end if;

  select coalesce(array_agg(b.box_id order by
    case
      when coalesce(b.status::text, '') = 'IN_STOCK' then 0
      when coalesce(b.status::text, '') = 'TRANSFER' then 1
      when coalesce(b.status::text, '') = 'ORDERED' then 2
      else 3
    end,
    case
      when b.width_in = v_requested_width_in then 0
      when app_api.allocation_coverage_multiplier(b.width_in, v_requested_width_in) > 1 then 1
      else 2
    end,
    (b.width_in - v_requested_width_in),
    case
      when v_requirement_id is not null
        and not v_requirement_is_exterior
        and app_api.requirement_film_is_exterior(p_org_id, b.manufacturer, b.film_name)
      then 1
      else 0
    end,
    coalesce(b.received_date, b.order_date, '9999-12-31'::date),
    b.box_id
  ), array[]::text[])
  into v_candidate_box_ids
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id <> v_source.box_id
    and coalesce(b.status::text, '') in ('IN_STOCK', 'ORDERED', 'TRANSFER', 'CHECKED_OUT')
    and case
      when v_requirement_id is not null then app_api.requirement_film_is_compatible(
        p_org_id,
        b.manufacturer,
        b.film_name,
        v_requirement.manufacturer,
        v_requirement.film_name
      )
      else app_api.normalize_requirement_film_key(p_org_id, b.manufacturer, b.film_name) = v_source_film_key
    end
    and b.width_in >= v_requested_width_in
    and (v_cross_warehouse or b.warehouse = v_source.warehouse)
    and (
      v_auto_allocate
      or b.box_id = any(v_selected_box_ids)
    );

  select coalesce(array_agg(distinct a.box_id order by a.box_id), array[]::text[])
  into v_conflict_box_ids
  from app.allocations a
  where a.org_id = p_org_id
    and a.box_id = any(v_candidate_box_ids)
    and a.status = 'ACTIVE'
    and coalesce(to_char(a.job_date, 'YYYY-MM-DD'), '') = coalesce(v_job_context->>'jobDate', '')
    and case
      when v_has_job_id then a.job_id is distinct from v_job.id
      else upper(a.job_number) <> upper(v_job_context->>'jobNumber')
    end
    and upper(coalesce(a.crew_leader, '')) <> upper(coalesce(v_job_context->>'crewLeader', ''));

  for v_state in
    select s.*
    from app_api.allocation_apply_box_states_0192(p_org_id, v_candidate_box_ids) s
    order by array_position(v_candidate_box_ids, s.box_id)
  loop
    exit when v_remaining <= 0;
    if array_position(v_conflict_box_ids, v_state.box_id) is not null
      or v_state.planning_feet <= 0
    then
      continue;
    end if;

    select p.allocated_feet, p.covered_feet, p.remaining_covered_feet
    into v_candidate_suggested, v_candidate_suggested_covered, v_remaining
    from app_api.plan_allocation_coverage(
      v_remaining,
      v_state.planning_feet,
      v_state.width_in,
      v_requested_width_in
    ) p;

    if v_candidate_suggested <= 0 or v_candidate_suggested_covered <= 0 then
      continue;
    end if;

    v_operations := v_operations || jsonb_build_array(jsonb_build_object(
      'ordinal', jsonb_array_length(v_operations) + 1,
      'role', 'SUGGESTION',
      'kind', 'REQUIREMENT',
      'boxId', v_state.box_id,
      'allocatedFeet', v_candidate_suggested,
      'coveredFeet', v_candidate_suggested_covered,
      'priorBoxIds', jsonb_build_array(v_state.box_id)
    ));
    v_operation_box_ids := array_append(v_operation_box_ids, v_state.box_id);
  end loop;

  for v_extra_entry in
    select value
    from jsonb_array_elements(v_extra_allocations)
  loop
    v_extra_box_id := app_api.require_text(v_extra_entry->>'boxId', 'extraAllocations[].boxId');
    v_extra_feet := floor(nullif(app_api.trim_text(v_extra_entry->>'allocatedFeet'), '')::numeric);
    if v_extra_feet is null or v_extra_feet <= 0 then
      perform app_api.raise_http(400, format('Extra allocation for box %s must be greater than zero.', v_extra_box_id));
    end if;
    select * into v_candidate
    from app.boxes b
    where b.org_id = p_org_id
      and b.box_id = v_extra_box_id;
    if not found then
      perform app_api.raise_http(404, format('Box not found: %s', v_extra_box_id));
    end if;
    if coalesce(v_candidate.status::text, '') not in ('IN_STOCK', 'ORDERED', 'TRANSFER', 'CHECKED_OUT') then
      perform app_api.raise_http(400, format('Box %s is no longer allocatable.', v_candidate.box_id));
    end if;
    if v_requirement_id is not null then
      if not app_api.requirement_film_is_compatible(
        p_org_id,
        v_candidate.manufacturer,
        v_candidate.film_name,
        v_requirement.manufacturer,
        v_requirement.film_name
      ) or v_candidate.width_in < v_requested_width_in then
        perform app_api.raise_http(
          400,
          format('Extra box %s must use a compatible film and meet the requested width for this allocation.', v_candidate.box_id)
        );
      end if;
    elsif app_api.normalize_requirement_film_key(p_org_id, v_candidate.manufacturer, v_candidate.film_name) <> v_source_film_key
      or v_candidate.width_in < v_requested_width_in then
      perform app_api.raise_http(
        400,
        format('Extra box %s must match film and meet the requested width for this allocation.', v_candidate.box_id)
      );
    end if;

    select * into v_state
    from app_api.allocation_apply_box_states_0192(p_org_id, array[v_extra_box_id]);
    if not found then
      perform app_api.raise_http(404, format('Box not found: %s', v_extra_box_id));
    end if;
    select coalesce(sum((entry.value->>'allocatedFeet')::integer), 0)::integer
    into v_planned_for_box
    from jsonb_array_elements(v_operations) entry(value)
    where entry.value->>'boxId' = v_extra_box_id;

    if v_state.planning_feet < v_planned_for_box + v_extra_feet then
      perform app_api.raise_http(400, format('Box %s no longer has enough planning LF.', v_extra_box_id));
    end if;

    v_operations := v_operations || jsonb_build_array(jsonb_build_object(
      'ordinal', jsonb_array_length(v_operations) + 1,
      'role', 'EXTRA',
      'kind', 'EXTRA',
      'boxId', v_extra_box_id,
      'allocatedFeet', v_extra_feet,
      'coveredFeet', v_extra_feet,
      'priorBoxIds', '[]'::jsonb
    ));
    v_operation_box_ids := array_append(v_operation_box_ids, v_extra_box_id);
  end loop;

  if v_requested_feet = 0 and jsonb_array_length(v_operations) = 0 then
    perform app_api.raise_http(400, 'RequestedFeet must be greater than zero unless extraAllocations are provided.');
  end if;

  select coalesce(array_agg(box_id order by first_ordinal), array[]::text[])
  into v_plan_box_ids
  from (
    select box_id, min(ordinality)::integer as first_ordinal
    from (
      select v_source.box_id as box_id, 0::bigint as ordinality
      union all
      select value->>'boxId', ordinality
      from jsonb_array_elements(v_operations) with ordinality entries(value, ordinality)
      union all
      select prior.value, 1000000 + (operations.ordinality * 1000) + prior.ordinality
      from jsonb_array_elements(v_operations) with ordinality operations(value, ordinality)
      cross join lateral jsonb_array_elements_text(
        coalesce(operations.value->'priorBoxIds', '[]'::jsonb)
      ) with ordinality prior(value, ordinality)
    ) all_ids
    where app_api.trim_text(box_id) <> ''
    group by box_id
  ) deduplicated;

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
  into v_actual_count, v_plan_states
  from app_api.allocation_apply_box_states_0192(p_org_id, v_plan_box_ids) s;

  if v_actual_count <> coalesce(array_length(v_plan_box_ids, 1), 0) then
    perform app_api.raise_http(409, 'An affected allocation box could not be resolved. Reload and retry.');
  end if;

  return jsonb_build_object(
    'jobId', coalesce(v_job.id::text, ''),
    'jobContext', v_job_context,
    'jobState', case
      when v_job.id is null then '{}'::jsonb
      else jsonb_build_object(
        'id', v_job.id::text,
        'jobNumber', v_job.job_number,
        'warehouse', upper(coalesce(v_job.warehouse, '')),
        'lifecycleStatus', coalesce(v_job.lifecycle_status::text, 'ACTIVE'),
        'dueDate', coalesce(to_char(v_job.due_date, 'YYYY-MM-DD'), ''),
        'crewLeader', coalesce(v_job.crew_leader, '')
      )
    end,
    'jobWarehouse', v_job_warehouse,
    'payloadJobWarehouse', v_payload_job_warehouse,
    'requirementId', coalesce(v_requirement_id::text, ''),
    'requirementState', v_requirement_state,
    'phaseId', coalesce(v_requirement.phase_id::text, ''),
    'phaseState', v_phase_state,
    'requestedWidthIn', v_requested_width_in,
    'crossWarehouse', v_cross_warehouse,
    'operations', v_operations,
    'boxIds', to_jsonb(v_plan_box_ids),
    'boxStates', v_plan_states,
    'remainingUncoveredFeet', greatest(v_remaining, 0),
    'warnings', '[]'::jsonb
  );
end;
$$;

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

  v_plan := app_api.build_allocation_apply_plan_0192(p_org_id, p_actor, v_payload);
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

alter function app_api.allocation_apply_box_states_0192(uuid, text[]) owner to postgres;
alter function app_api.build_allocation_apply_plan_0192(uuid, text, jsonb) owner to postgres;
alter function public.api_allocations_apply(uuid, text, jsonb) owner to postgres;

revoke execute on function app_api.allocation_apply_box_states_0192(uuid, text[])
  from public, anon, authenticated, service_role;
revoke execute on function app_api.build_allocation_apply_plan_0192(uuid, text, jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function public.api_allocations_apply(uuid, text, jsonb)
  from public, anon, authenticated, service_role;

do $$
declare
  v_apply_def text;
  v_apply_owner text;
  v_apply_security_definer boolean;
  v_apply_config text[];
  v_apply_count integer;
begin
  select pg_get_functiondef('public.api_allocations_apply(uuid, text, jsonb)'::regprocedure)
  into v_apply_def;

  select count(*)::integer
  into v_apply_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'api_allocations_apply';

  select pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
  into v_apply_owner, v_apply_security_definer, v_apply_config
  from pg_proc p
  where p.oid = 'public.api_allocations_apply(uuid, text, jsonb)'::regprocedure;

  if v_apply_count <> 1
    or v_apply_owner <> 'postgres'
    or not v_apply_security_definer
    or not ('search_path=public, app, app_api' = any(coalesce(v_apply_config, array[]::text[])))
    or position('build_allocation_apply_plan_0192' in v_apply_def) = 0
    or position('allocation_apply_box_states_0192' in v_apply_def) = 0
    or position('from app.boxes b' in v_apply_def) = 0
  then
    raise exception '0192 allocation apply function contract verification failed';
  end if;

  if exists (
    select 1
    from aclexplode(coalesce(
      (select p.proacl from pg_proc p where p.oid = 'public.api_allocations_apply(uuid, text, jsonb)'::regprocedure),
      acldefault('f', (select p.proowner from pg_proc p where p.oid = 'public.api_allocations_apply(uuid, text, jsonb)'::regprocedure))
    )) acl
    left join pg_roles r on r.oid = acl.grantee
    where acl.privilege_type = 'EXECUTE'
      and (acl.grantee = 0 or r.rolname in ('anon', 'authenticated', 'service_role'))
  ) then
    raise exception '0192 broadened direct allocation apply execute grants';
  end if;
end;
$$;
