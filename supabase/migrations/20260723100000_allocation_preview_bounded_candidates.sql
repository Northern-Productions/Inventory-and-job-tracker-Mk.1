/*
 * PURPOSE:
 * Replaces allocation preview's organization-wide box projection with one
 * bounded, planner-backed candidate snapshot.
 *
 * AFFECTS:
 * Allocation preview reads only. Allocation apply, transfer mutations, box
 * custody, physical LF, and the generic list-boxes contract remain unchanged.
 */

do $$
begin
  if to_regprocedure('app_api.allocation_apply_box_states_0192(uuid,text[])') is null
    or to_regprocedure('app_api.build_allocation_apply_plan_0192(uuid,text,jsonb)') is null
  then
    raise exception '0193 requires the canonical 0192 allocation planner';
  end if;
end;
$$;

create or replace function app_api.allocation_preview_candidates_0193(
  p_org_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_context_payload jsonb;
  v_plan jsonb;
  v_source app.boxes;
  v_source_state record;
  v_source_box_id text;
  v_source_json jsonb;
  v_candidates jsonb := '[]'::jsonb;
  v_allocations jsonb := '[]'::jsonb;
  v_pending_transfers jsonb := '{}'::jsonb;
  v_candidate_metadata jsonb := '[]'::jsonb;
  v_candidate_count integer := 0;
  v_coarse_candidate_count integer := 0;
  v_allocation_count integer := 0;
  v_pending_transfer_count integer := 0;
  v_destination_warehouse text := '';
  v_requested_cross_warehouse boolean := false;
  v_cross_warehouse boolean := false;
  v_auto_allocate boolean := false;
  v_requested_feet integer := 0;
  v_requested_width_in numeric;
  v_job_id_text text := '';
  v_job_number text := '';
  v_job_date text := '';
  v_crew_leader text := '';
  v_requirement_id_text text := '';
begin
  begin
    v_requested_cross_warehouse := coalesce((v_payload->>'crossWarehouse')::boolean, false);
    v_auto_allocate := coalesce((v_payload->>'autoAllocate')::boolean, false);
    v_requested_feet := floor(nullif(app_api.trim_text(v_payload->>'requestedFeet'), '')::numeric);
  exception
    when invalid_text_representation or numeric_value_out_of_range then
      perform app_api.raise_http(400, 'Allocation preview contains an invalid boolean or numeric value.');
  end;

  if coalesce(v_requested_feet, 0) <= 0 then
    perform app_api.raise_http(400, 'RequestedFeet must be greater than zero.');
  end if;

  v_source_box_id := app_api.resolve_box_id_alias(
    p_org_id,
    app_api.require_text(v_payload->>'boxId', 'BoxID')
  );
  v_cross_warehouse := case when v_auto_allocate then false else v_requested_cross_warehouse end;

  v_context_payload :=
    (
      v_payload
      - 'installDate'
      - 'selectedSuggestionBoxIds'
      - 'extraAllocations'
      - 'autoAllocate'
      - 'crossWarehouse'
    )
    || jsonb_build_object(
      'boxId', v_source_box_id,
      'jobDate', coalesce(v_payload->>'installDate', v_payload->>'jobDate', ''),
      'selectedSuggestionBoxIds', '[]'::jsonb,
      'extraAllocations', '[]'::jsonb,
      'autoAllocate', false,
      'crossWarehouse', v_cross_warehouse
    );

  /*
   * Reuse 0192 for canonical source, job, phase, requirement, width, and
   * reservation state. Candidate selection below is the only candidate pass.
   */
  v_plan := app_api.build_allocation_apply_plan_0192(
    p_org_id,
    'allocation-preview',
    v_context_payload
  );

  select *
  into v_source
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = v_source_box_id;

  if not found then
    perform app_api.raise_http(404, 'Box not found.');
  end if;

  select *
  into v_source_state
  from app_api.allocation_apply_box_states_0192(p_org_id, array[v_source.box_id]);

  if not found then
    perform app_api.raise_http(409, 'The allocation source changed while preview was loading. Reload and retry.');
  end if;

  v_destination_warehouse := upper(coalesce(
    nullif(app_api.trim_text(v_plan->>'jobWarehouse'), ''),
    nullif(app_api.trim_text(v_plan->>'payloadJobWarehouse'), ''),
    ''
  ));
  v_requested_width_in := nullif(app_api.trim_text(v_plan->>'requestedWidthIn'), '')::numeric;
  v_job_id_text := app_api.trim_text(v_plan->>'jobId');
  v_job_number := app_api.trim_text(v_plan->'jobContext'->>'jobNumber');
  v_job_date := app_api.trim_text(v_plan->'jobContext'->>'jobDate');
  v_crew_leader := app_api.trim_text(v_plan->'jobContext'->>'crewLeader');
  v_requirement_id_text := app_api.trim_text(v_plan->>'requirementId');

  if v_auto_allocate and v_destination_warehouse = '' then
    perform app_api.raise_http(400, 'Assign a warehouse to this job before auto-allocating material.');
  end if;

  if v_auto_allocate and v_source_state.warehouse <> v_destination_warehouse then
    perform app_api.raise_http(
      400,
      format('Auto Allocate only uses material from the job warehouse (%s).', v_destination_warehouse)
    );
  end if;

  if v_cross_warehouse and v_destination_warehouse = '' then
    perform app_api.raise_http(400, 'Assign a warehouse to this job before using transfer-assisted allocation.');
  end if;

  if v_source_state.status = 'TRANSFER' or v_source_state.pending_transfer then
    perform app_api.raise_http(
      409,
      'The selected source has a pending transfer and is not physically available until receipt.'
    );
  end if;

  if v_destination_warehouse = '' or v_source_state.warehouse = v_destination_warehouse then
    if v_source_state.status not in ('IN_STOCK', 'ORDERED', 'CHECKED_OUT') then
      perform app_api.raise_http(400, 'The selected source is not in an allocatable state.');
    end if;
  else
    if not v_cross_warehouse then
      perform app_api.raise_http(409, 'Cross-warehouse allocation requires crossWarehouse approval.');
    end if;
    if v_source_state.status <> 'IN_STOCK' then
      perform app_api.raise_http(409, 'Transfer-assisted allocation can start only from an in-stock box.');
    end if;
    if v_source_state.reservation_count <> 0 then
      perform app_api.raise_http(
        409,
        'Transfer-assisted allocation requires a box with zero prior reservations.'
      );
    end if;
  end if;

  v_source_json := jsonb_build_object(
    'id', v_source.id::text,
    'orgId', v_source.org_id::text,
    'boxId', v_source.box_id,
    'warehouse', v_source_state.warehouse,
    'ownerCompanyId', coalesce(v_source.owner_company_id::text, ''),
    'manufacturer', coalesce(v_source.manufacturer, ''),
    'filmName', coalesce(v_source.film_name, ''),
    'widthIn', v_source.width_in,
    'initialFeet', v_source.initial_feet,
    'feetAvailable', v_source_state.planning_feet,
    'storedFeetAvailable', v_source.feet_available,
    'activeAllocatedFeet', v_source_state.reserved_feet,
    'allocatableNowFeet', v_source_state.planning_feet,
    'allocationPlanningFeet', v_source_state.planning_feet,
    'physicalFeetAvailable', v_source_state.physical_feet,
    'status', v_source_state.status,
    'orderDate', coalesce(to_char(v_source.order_date, 'YYYY-MM-DD'), ''),
    'receivedDate', coalesce(to_char(v_source.received_date, 'YYYY-MM-DD'), ''),
    'createdAt', v_source.created_at,
    'updatedAt', v_source.updated_at
  );

  with coarse_candidates as materialized (
    select b.box_id
    from app.boxes b
    where b.org_id = p_org_id
      and b.box_id <> v_source.box_id
      and coalesce(b.status::text, '') in ('IN_STOCK', 'ORDERED', 'TRANSFER', 'CHECKED_OUT')
      and b.width_in >= v_requested_width_in
      and (v_cross_warehouse or b.warehouse = v_source.warehouse)
      and case
        when v_requirement_id_text <> '' then app_api.requirement_film_is_compatible(
          p_org_id,
          b.manufacturer,
          b.film_name,
          v_plan->'requirementState'->>'manufacturer',
          v_plan->'requirementState'->>'filmName'
        )
        else app_api.normalize_requirement_film_key(
          p_org_id,
          b.manufacturer,
          b.film_name
        ) = app_api.normalize_requirement_film_key(
          p_org_id,
          v_source.manufacturer,
          v_source.film_name
        )
      end
  ),
  candidate_states as materialized (
    select s.*
    from app_api.allocation_apply_box_states_0192(
      p_org_id,
      coalesce(
        (select array_agg(c.box_id order by c.box_id) from coarse_candidates c),
        array[]::text[]
      )
    ) s
  ),
  eligible_candidates as materialized (
    select
      b.*,
      s.physical_feet,
      s.stored_feet,
      s.reserved_feet,
      s.reservation_count,
      s.planning_feet,
      s.pending_transfer
    from candidate_states s
    join app.boxes b
      on b.org_id = p_org_id
     and b.box_id = s.box_id
    where not s.pending_transfer
      and s.status <> 'TRANSFER'
      and s.planning_feet > 0
      and (
        (
          (v_destination_warehouse = '' or s.warehouse = v_destination_warehouse)
          and s.status in ('IN_STOCK', 'ORDERED', 'CHECKED_OUT')
        )
        or (
          v_destination_warehouse <> ''
          and s.warehouse <> v_destination_warehouse
          and v_cross_warehouse
          and s.status = 'IN_STOCK'
          and s.reservation_count = 0
        )
      )
      and not exists (
        select 1
        from app.allocations conflict
        where conflict.org_id = p_org_id
          and conflict.box_id = s.box_id
          and conflict.status = 'ACTIVE'
          and coalesce(to_char(conflict.job_date, 'YYYY-MM-DD'), '') = v_job_date
          and case
            when v_job_id_text <> '' then conflict.job_id is distinct from v_job_id_text::uuid
            else upper(conflict.job_number) <> upper(v_job_number)
          end
          and upper(coalesce(conflict.crew_leader, '')) <> upper(v_crew_leader)
      )
  ),
  ordered_candidates as materialized (
    select e.*
    from eligible_candidates e
    order by
      case e.status::text
        when 'IN_STOCK' then 0
        when 'TRANSFER' then 1
        when 'ORDERED' then 2
        else 3
      end,
      case
        when v_destination_warehouse <> ''
          and upper(e.warehouse::text) = v_destination_warehouse then 0
        else 1
      end,
      case when e.width_in = v_requested_width_in then 0 else 1 end,
      case
        when app_api.allocation_coverage_multiplier(e.width_in, v_requested_width_in) > 1 then 0
        else 1
      end,
      e.width_in - v_requested_width_in,
      case
        when v_requirement_id_text <> ''
          and not app_api.requirement_film_is_exterior(
            p_org_id,
            v_plan->'requirementState'->>'manufacturer',
            v_plan->'requirementState'->>'filmName'
          )
          and app_api.requirement_film_is_exterior(p_org_id, e.manufacturer, e.film_name)
        then 1
        else 0
      end,
      coalesce(e.received_date, e.order_date, '9999-12-31'::date),
      e.box_id
  ),
  relevant_box_ids as materialized (
    select v_source.box_id as box_id
    union
    select e.box_id from ordered_candidates e
  )
  select
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', e.id::text,
          'orgId', e.org_id::text,
          'boxId', e.box_id,
          'warehouse', upper(e.warehouse::text),
          'ownerCompanyId', coalesce(e.owner_company_id::text, ''),
          'manufacturer', coalesce(e.manufacturer, ''),
          'filmName', coalesce(e.film_name, ''),
          'widthIn', e.width_in,
          'initialFeet', e.initial_feet,
          'feetAvailable', e.planning_feet,
          'storedFeetAvailable', e.feet_available,
          'activeAllocatedFeet', e.reserved_feet,
          'allocatableNowFeet', e.planning_feet,
          'allocationPlanningFeet', e.planning_feet,
          'physicalFeetAvailable', e.physical_feet,
          'status', upper(e.status::text),
          'orderDate', coalesce(to_char(e.order_date, 'YYYY-MM-DD'), ''),
          'receivedDate', coalesce(to_char(e.received_date, 'YYYY-MM-DD'), ''),
          'createdAt', e.created_at,
          'updatedAt', e.updated_at
        )
        order by
          case e.status::text
            when 'IN_STOCK' then 0
            when 'TRANSFER' then 1
            when 'ORDERED' then 2
            else 3
          end,
          case
            when v_destination_warehouse <> ''
              and upper(e.warehouse::text) = v_destination_warehouse then 0
            else 1
          end,
          case when e.width_in = v_requested_width_in then 0 else 1 end,
          case
            when app_api.allocation_coverage_multiplier(e.width_in, v_requested_width_in) > 1 then 0
            else 1
          end,
          e.width_in - v_requested_width_in,
          coalesce(e.received_date, e.order_date, '9999-12-31'::date),
          e.box_id
      )
      from ordered_candidates e
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', a.id::text,
          'orgId', a.org_id::text,
          'allocationId', a.allocation_id,
          'boxId', a.box_id,
          'warehouse', upper(a.warehouse::text),
          'jobId', coalesce(a.job_id::text, ''),
          'jobNumber', coalesce(a.job_number, ''),
          'installDate', coalesce(to_char(a.job_date, 'YYYY-MM-DD'), ''),
          'allocatedFeet', coalesce(a.allocated_feet, 0),
          'coveredFeet', coalesce(a.covered_feet, 0),
          'requirementId', coalesce(a.requirement_id::text, ''),
          'allocationKind', coalesce(a.allocation_kind::text, 'REQUIREMENT'),
          'allocationSource', coalesce(a.allocation_source::text, 'MANUAL'),
          'status', a.status::text,
          'createdAt', a.created_at,
          'resolvedAt', a.resolved_at,
          'crewLeader', coalesce(a.crew_leader, ''),
          'filmOrderId', coalesce(a.film_order_id, '')
        )
        order by a.box_id, a.created_at, a.allocation_id, a.id
      )
      from app.allocations a
      where a.org_id = p_org_id
        and a.box_id in (select r.box_id from relevant_box_ids r)
        and a.status in ('ACTIVE', 'FULFILLED')
    ), '[]'::jsonb),
    coalesce((
      select jsonb_object_agg(
        t.box_record_id::text,
        jsonb_build_object(
          'id', t.id::text,
          'orgId', t.org_id::text,
          'transferId', t.transfer_id,
          'boxRecordId', t.box_record_id::text,
          'sourceBoxId', t.source_box_id,
          'destinationBoxId', t.destination_box_id,
          'sourceWarehouse', t.source_warehouse,
          'destinationWarehouse', t.destination_warehouse,
          'transferCreatedAllocationId', coalesce(t.transfer_created_allocation_id, ''),
          'status', t.status,
          'createdAt', t.created_at
        )
        order by t.created_at, t.transfer_id, t.id
      )
      from app.box_transfers t
      join app.boxes transfer_box
        on transfer_box.org_id = t.org_id
       and transfer_box.id = t.box_record_id
      where t.org_id = p_org_id
        and t.status = 'PENDING'
        and transfer_box.box_id in (select r.box_id from relevant_box_ids r)
    ), '{}'::jsonb),
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'boxId', e.box_id,
          'eligible', true,
          'requiresTransfer',
            v_destination_warehouse <> ''
            and upper(e.warehouse::text) <> v_destination_warehouse,
          'reason', ''
        )
        order by
          case e.status::text
            when 'IN_STOCK' then 0
            when 'TRANSFER' then 1
            when 'ORDERED' then 2
            else 3
          end,
          case
            when v_destination_warehouse <> ''
              and upper(e.warehouse::text) = v_destination_warehouse then 0
            else 1
          end,
          e.box_id
      )
      from ordered_candidates e
    ), '[]'::jsonb),
    (select count(*)::integer from coarse_candidates),
    (select count(*)::integer from ordered_candidates),
    (
      select count(*)::integer
      from app.allocations a
      where a.org_id = p_org_id
        and a.box_id in (select r.box_id from relevant_box_ids r)
        and a.status in ('ACTIVE', 'FULFILLED')
    ),
    (
      select count(*)::integer
      from app.box_transfers t
      join app.boxes transfer_box
        on transfer_box.org_id = t.org_id
       and transfer_box.id = t.box_record_id
      where t.org_id = p_org_id
        and t.status = 'PENDING'
        and transfer_box.box_id in (select r.box_id from relevant_box_ids r)
    )
  into
    v_candidates,
    v_allocations,
    v_pending_transfers,
    v_candidate_metadata,
    v_coarse_candidate_count,
    v_candidate_count,
    v_allocation_count,
    v_pending_transfer_count;

  return jsonb_build_object(
    'source', v_source_json,
    'boxes', v_candidates,
    'allocations', v_allocations,
    'pendingTransfersByBoxRecordId', v_pending_transfers,
    'candidateMetadata', v_candidate_metadata,
    'context', jsonb_build_object(
      'jobId', v_job_id_text,
      'jobContext', coalesce(v_plan->'jobContext', '{}'::jsonb),
      'jobWarehouse', v_destination_warehouse,
      'jobState', coalesce(v_plan->'jobState', '{}'::jsonb),
      'requirementId', v_requirement_id_text,
      'requirementState', coalesce(v_plan->'requirementState', '{}'::jsonb),
      'phaseId', app_api.trim_text(v_plan->>'phaseId'),
      'phaseState', coalesce(v_plan->'phaseState', '{}'::jsonb),
      'requestedFeet', v_requested_feet,
      'requestedWidthIn', v_requested_width_in,
      'crossWarehouse', v_cross_warehouse,
      'autoAllocate', v_auto_allocate,
      'warnings', coalesce(v_plan->'warnings', '[]'::jsonb)
    ),
    'scope', jsonb_build_object(
      'coarseCandidateCount', v_coarse_candidate_count,
      'candidateCount', v_candidate_count,
      'allocationCount', v_allocation_count,
      'pendingTransferCount', v_pending_transfer_count
    )
  );
end;
$$;

create or replace function public.api_acl_allocation_preview_candidates(
  p_org_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'read');
  return app_api.allocation_preview_candidates_0193(p_org_id, p_payload);
end;
$$;

alter function app_api.allocation_preview_candidates_0193(uuid, jsonb) owner to postgres;
alter function public.api_acl_allocation_preview_candidates(uuid, jsonb) owner to postgres;

revoke execute on function app_api.allocation_preview_candidates_0193(uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function public.api_acl_allocation_preview_candidates(uuid, jsonb)
  from public, anon, service_role;
grant execute on function public.api_acl_allocation_preview_candidates(uuid, jsonb)
  to authenticated;

do $$
declare
  v_private_count integer;
  v_public_count integer;
  v_private_owner text;
  v_public_owner text;
  v_private_security_definer boolean;
  v_public_security_definer boolean;
  v_private_config text[];
  v_public_config text[];
  v_private_def text;
  v_public_def text;
begin
  select count(*)::integer
  into v_private_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'app_api'
    and p.proname = 'allocation_preview_candidates_0193';

  select count(*)::integer
  into v_public_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'api_acl_allocation_preview_candidates';

  select pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig, pg_get_functiondef(p.oid)
  into v_private_owner, v_private_security_definer, v_private_config, v_private_def
  from pg_proc p
  where p.oid = 'app_api.allocation_preview_candidates_0193(uuid, jsonb)'::regprocedure;

  select pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig, pg_get_functiondef(p.oid)
  into v_public_owner, v_public_security_definer, v_public_config, v_public_def
  from pg_proc p
  where p.oid = 'public.api_acl_allocation_preview_candidates(uuid, jsonb)'::regprocedure;

  if v_private_count <> 1
    or v_public_count <> 1
    or v_private_owner <> 'postgres'
    or v_public_owner <> 'postgres'
    or not v_private_security_definer
    or not v_public_security_definer
    or not ('search_path=public, app, app_api' = any(coalesce(v_private_config, array[]::text[])))
    or not ('search_path=public, app, app_api' = any(coalesce(v_public_config, array[]::text[])))
  then
    raise exception '0193 allocation preview function contract failed';
  end if;

  if position('app_api.build_allocation_apply_plan_0192' in v_private_def) = 0
    or position('app_api.allocation_apply_box_states_0192' in v_private_def) = 0
    or position('app_api.requirement_film_is_compatible' in v_private_def) = 0
    or position('app_api.require_effective_feature_access' in v_public_def) = 0
  then
    raise exception '0193 allocation preview planner/security contract failed';
  end if;

  if exists (
    select 1
    from aclexplode(coalesce(
      (
        select p.proacl
        from pg_proc p
        where p.oid = 'app_api.allocation_preview_candidates_0193(uuid, jsonb)'::regprocedure
      ),
      acldefault(
        'f',
        (
          select p.proowner
          from pg_proc p
          where p.oid = 'app_api.allocation_preview_candidates_0193(uuid, jsonb)'::regprocedure
        )
      )
    )) acl
    left join pg_roles r on r.oid = acl.grantee
    where acl.privilege_type = 'EXECUTE'
      and (acl.grantee = 0 or r.rolname in ('anon', 'authenticated', 'service_role'))
  ) then
    raise exception '0193 private allocation preview execute grants failed';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.api_acl_allocation_preview_candidates(uuid, jsonb)',
    'execute'
  )
    or has_function_privilege(
      'anon',
      'public.api_acl_allocation_preview_candidates(uuid, jsonb)',
      'execute'
    )
    or has_function_privilege(
      'service_role',
      'public.api_acl_allocation_preview_candidates(uuid, jsonb)',
      'execute'
    )
  then
    raise exception '0193 public allocation preview execute grants failed';
  end if;
end;
$$;
