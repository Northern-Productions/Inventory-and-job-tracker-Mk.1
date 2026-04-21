/**
 * PURPOSE:
 * Keep allocation status rules and ordered-box receipt behavior aligned across the local runtime,
 * Edge/RPC wrappers, and SQL mutation layer.
 *
 * BUSINESS RULE:
 * - TRANSFER boxes are allocatable
 * - ORDERED boxes are allocatable
 * - ZEROED boxes are not allocatable
 *
 * AFFECTS:
 * /allocations/add, /allocations/apply, /boxes/receive, shortage-order side effects during
 * allocation saves, and transfer/zeroed eligibility parity between localhost and Edge/RPC.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * backend/src/app/core/helpers.mjs,
 * backend/src/app/services/runtime/runtimeAllocationApply.mjs,
 * backend/src/app/services/runtime/boxes/receiveOrdered.mjs,
 * frontend/src/features/inventory/utils/jobAllocationMatching.ts,
 * backend/scripts/verify-ordered-box-allocation-flow.mjs,
 * and backend/scripts/check-schema-latest.mjs.
 */

create or replace function app_api.compute_allocation_planning_feet(
  p_status text,
  p_initial_feet integer,
  p_feet_available integer,
  p_active_allocated_feet integer
)
returns integer
language sql
immutable
as $$
  select
    case upper(coalesce(app_api.trim_text(p_status), ''))
      when 'IN_STOCK' then greatest(coalesce(p_feet_available, 0), 0)
      when 'TRANSFER' then greatest(coalesce(p_feet_available, 0), 0)
      when 'ORDERED' then greatest(coalesce(p_initial_feet, 0) - coalesce(p_active_allocated_feet, 0), 0)
      else 0
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
  v_source app.boxes;
  v_candidate app.boxes;
  v_job_context jsonb;
  v_requested_feet integer := coalesce(floor(nullif(app_api.trim_text(p_payload->>'requestedFeet'), '')::numeric), 0);
  v_requested_width_in numeric := nullif(app_api.trim_text(p_payload->>'requestedWidthIn'), '')::numeric;
  v_requirement_id_text text := app_api.trim_text(p_payload->>'requirementId');
  v_should_validate_requirement boolean := false;
  v_requirement_id uuid;
  v_requirement app.job_requirements;
  v_source_film_key text;
  v_requirement_is_exterior boolean := false;
  v_remaining integer := 0;
  v_requirement_remaining_feet integer := 0;
  v_source_planning_feet integer := 0;
  v_source_suggested integer := 0;
  v_source_suggested_covered integer := 0;
  v_candidate_planning_feet integer := 0;
  v_candidate_suggested integer := 0;
  v_candidate_suggested_covered integer := 0;
  v_cross_warehouse boolean := coalesce((p_payload->>'crossWarehouse')::boolean, false);
  v_selected_box_ids text[] := coalesce(
    array(select jsonb_array_elements_text(coalesce(p_payload->'selectedSuggestionBoxIds', '[]'::jsonb))),
    array[]::text[]
  );
  v_extra_allocations jsonb := coalesce(p_payload->'extraAllocations', '[]'::jsonb);
  v_extra_entry jsonb;
  v_extra_box_id text;
  v_extra_feet integer;
  v_extra_processed_box_ids text[] := array[]::text[];
  v_allocation app.allocations;
  v_allocation_ids text[] := array[]::text[];
  v_cleanup_order app.film_orders;
  v_cleanup_link_count integer := 0;
  v_cleanup_allocation_count integer := 0;
  v_deleted_shortage_film_order_count integer := 0;
  v_conflict_count integer;
  v_warnings text[] := array[]::text[];
begin
  perform app_api.require_org_member(p_org_id);

  if v_requested_feet < 0 then
    perform app_api.raise_http(400, 'RequestedFeet must be zero or greater.');
  end if;

  if coalesce(jsonb_typeof(v_extra_allocations), '') not in ('', 'array') then
    perform app_api.raise_http(400, 'extraAllocations must be an array.');
  end if;

  select *
  into v_source
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = app_api.require_text(p_payload->>'boxId', 'BoxID')
  for update;

  if not found then
    perform app_api.raise_http(404, 'Box not found.');
  end if;

  if coalesce(v_source.status::text, '') not in ('IN_STOCK', 'ORDERED', 'TRANSFER') then
    perform app_api.raise_http(400, 'Only in-stock, ordered, or transfer boxes can be allocated.');
  end if;

  v_job_context := app_api.resolve_job_context(
    p_org_id,
    p_payload->>'jobNumber',
    p_payload->>'jobDate',
    p_payload->>'crewLeader'
  );

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
      and r.job_id = app_api.get_or_resolve_job_id(p_org_id, v_job_context->>'jobNumber')
      and r.id = v_requirement_id;

    if not found then
      perform app_api.raise_http(
        400,
        format('Requirement %s does not belong to job %s.', v_requirement_id, v_job_context->>'jobNumber')
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
    ) then
      perform app_api.raise_http(
        400,
        format('Box %s does not match requirement %s.', v_source.box_id, v_requirement_id)
      );
    end if;

    if v_source.width_in < v_requirement.width_in then
      perform app_api.raise_http(
        400,
        format('Box %s does not match requirement %s.', v_source.box_id, v_requirement_id)
      );
    end if;

    v_requested_width_in := v_requirement.width_in;
  elsif v_requested_width_in is null or v_requested_width_in <= 0 then
    v_requested_width_in := v_source.width_in;
  end if;

  if v_source.width_in < v_requested_width_in then
    perform app_api.raise_http(400, 'Source box width must meet or exceed the requested width.');
  end if;

  v_remaining := greatest(v_requested_feet, 0);
  v_source_planning_feet := app_api.allocation_planning_feet_for_box(v_source);

  if v_requested_feet > 0 then
    select count(*)
    into v_conflict_count
    from app.allocations a
    where a.org_id = p_org_id
      and a.box_id = v_source.box_id
      and a.status = 'ACTIVE'
      and coalesce(to_char(a.job_date, 'YYYY-MM-DD'), '') = coalesce(v_job_context->>'jobDate', '')
      and upper(a.job_number) <> upper(v_job_context->>'jobNumber')
      and upper(coalesce(a.crew_leader, '')) <> upper(coalesce(v_job_context->>'crewLeader', ''));

    if v_conflict_count = 0 then
      select
        p.allocated_feet,
        p.covered_feet,
        p.remaining_covered_feet
      into
        v_source_suggested,
        v_source_suggested_covered,
        v_remaining
      from app_api.plan_allocation_coverage(
        v_remaining,
        v_source_planning_feet,
        v_source.width_in,
        v_requested_width_in
      ) p;
    end if;
  end if;

  if v_source_suggested > 0 then
    v_allocation := app_api.create_allocation_with_coverage(
      p_org_id,
      v_source,
      v_job_context,
      v_source_suggested,
      v_source_suggested_covered,
      p_actor,
      '',
      'REQUIREMENT',
      v_requirement_id
    );
    if coalesce(v_source.status::text, '') in ('IN_STOCK', 'TRANSFER') then
      v_source.feet_available := greatest(v_source.feet_available - v_source_suggested, 0);
      v_source := app_api.save_box(v_source);
    end if;
    v_allocation_ids := array_append(v_allocation_ids, v_allocation.allocation_id);
  end if;

  for v_candidate in
    select *
    from app.boxes b
    where b.org_id = p_org_id
      and b.box_id <> v_source.box_id
      and coalesce(b.status::text, '') in ('IN_STOCK', 'ORDERED', 'TRANSFER')
      and app_api.compute_allocation_planning_feet(
        coalesce(b.status::text, ''),
        b.initial_feet,
        b.feet_available,
        app_api.active_allocated_feet_for_box(p_org_id, b.box_id)
      ) > 0
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
    order by
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
    for update
  loop
    exit when v_remaining <= 0;

    if coalesce(array_length(v_selected_box_ids, 1), 0) > 0 and array_position(v_selected_box_ids, v_candidate.box_id) is null then
      continue;
    end if;

    select count(*)
    into v_conflict_count
    from app.allocations a
    where a.org_id = p_org_id
      and a.box_id = v_candidate.box_id
      and a.status = 'ACTIVE'
      and coalesce(to_char(a.job_date, 'YYYY-MM-DD'), '') = coalesce(v_job_context->>'jobDate', '')
      and upper(a.job_number) <> upper(v_job_context->>'jobNumber')
      and upper(coalesce(a.crew_leader, '')) <> upper(coalesce(v_job_context->>'crewLeader', ''));

    if v_conflict_count > 0 then
      continue;
    end if;

    v_candidate_planning_feet := app_api.allocation_planning_feet_for_box(v_candidate);

    select
      p.allocated_feet,
      p.covered_feet,
      p.remaining_covered_feet
    into
      v_candidate_suggested,
      v_candidate_suggested_covered,
      v_remaining
    from app_api.plan_allocation_coverage(
      v_remaining,
      v_candidate_planning_feet,
      v_candidate.width_in,
      v_requested_width_in
    ) p;

    if v_candidate_suggested <= 0 or v_candidate_suggested_covered <= 0 then
      continue;
    end if;

    v_allocation := app_api.create_allocation_with_coverage(
      p_org_id,
      v_candidate,
      v_job_context,
      v_candidate_suggested,
      v_candidate_suggested_covered,
      p_actor,
      '',
      'REQUIREMENT',
      v_requirement_id
    );
    if coalesce(v_candidate.status::text, '') in ('IN_STOCK', 'TRANSFER') then
      v_candidate.feet_available := greatest(v_candidate.feet_available - v_allocation.allocated_feet, 0);
      perform app_api.save_box(v_candidate);
    end if;
    v_allocation_ids := array_append(v_allocation_ids, v_allocation.allocation_id);
  end loop;

  if coalesce(jsonb_typeof(v_extra_allocations), '') = 'array' then
    for v_extra_entry in
      select value
      from jsonb_array_elements(v_extra_allocations)
    loop
      if coalesce(jsonb_typeof(v_extra_entry), '') <> 'object' then
        perform app_api.raise_http(400, 'Each extra allocation entry must be an object.');
      end if;

      v_extra_box_id := app_api.require_text(v_extra_entry->>'boxId', 'extraAllocations[].boxId');
      v_extra_feet := floor(nullif(app_api.trim_text(v_extra_entry->>'allocatedFeet'), '')::numeric);

      if v_extra_feet is null or v_extra_feet <= 0 then
        perform app_api.raise_http(400, format('Extra allocation for box %s must be greater than zero.', v_extra_box_id));
      end if;

      if array_position(v_extra_processed_box_ids, v_extra_box_id) is not null then
        perform app_api.raise_http(400, format('Duplicate extra allocation entry for box %s.', v_extra_box_id));
      end if;

      select *
      into v_candidate
      from app.boxes b
      where b.org_id = p_org_id
        and b.box_id = v_extra_box_id
      for update;

      if not found then
        perform app_api.raise_http(404, format('Box not found: %s', v_extra_box_id));
      end if;

      if coalesce(v_candidate.status::text, '') not in ('IN_STOCK', 'ORDERED', 'TRANSFER') then
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
            format(
              'Extra box %s must use a compatible film and meet the requested width for this allocation.',
              v_candidate.box_id
            )
          );
        end if;
      elsif app_api.normalize_requirement_film_key(p_org_id, v_candidate.manufacturer, v_candidate.film_name) <> v_source_film_key
        or v_candidate.width_in < v_requested_width_in then
        perform app_api.raise_http(
          400,
          format(
            'Extra box %s must match film and meet the requested width for this allocation.',
            v_candidate.box_id
          )
        );
      end if;

      v_candidate_planning_feet := app_api.allocation_planning_feet_for_box(v_candidate);
      if v_candidate_planning_feet < v_extra_feet then
        perform app_api.raise_http(400, format('Box %s no longer has enough planning LF.', v_candidate.box_id));
      end if;

      v_allocation := app_api.create_allocation(
        p_org_id,
        v_candidate,
        v_job_context,
        v_extra_feet,
        p_actor,
        '',
        'EXTRA',
        null
      );
      if coalesce(v_candidate.status::text, '') in ('IN_STOCK', 'TRANSFER') then
        v_candidate.feet_available := greatest(v_candidate.feet_available - v_extra_feet, 0);
        perform app_api.save_box(v_candidate);
      end if;
      v_allocation_ids := array_append(v_allocation_ids, v_allocation.allocation_id);
      v_extra_processed_box_ids := array_append(v_extra_processed_box_ids, v_extra_box_id);
    end loop;
  end if;

  if v_requested_feet = 0 and coalesce(array_length(v_extra_processed_box_ids, 1), 0) = 0 then
    perform app_api.raise_http(400, 'RequestedFeet must be greater than zero unless extraAllocations are provided.');
  end if;

  if v_requirement_id is not null and v_requested_feet > 0 then
    select greatest(
      coalesce(v_requirement.required_feet, 0) - least(
        coalesce(v_requirement.required_feet, 0),
        coalesce(sum(
          case
            when coalesce(a.covered_feet, 0) > 0 then a.covered_feet
            else a.allocated_feet
          end
        ), 0)
      ),
      0
    )::integer
    into v_requirement_remaining_feet
    from app.allocations a
    join app.boxes b
      on b.org_id = a.org_id
     and upper(b.box_id) = upper(a.box_id)
    where a.org_id = p_org_id
      and a.requirement_id = v_requirement_id
      and a.status <> 'CANCELLED'
      and coalesce(a.allocation_kind::text, 'REQUIREMENT') <> 'EXTRA'
      and not (
        a.status = 'ACTIVE'
        and coalesce(b.status::text, '') in ('ZEROED', 'RETIRED')
      )
      and app_api.requirement_film_is_compatible(
        p_org_id,
        b.manufacturer,
        b.film_name,
        v_requirement.manufacturer,
        v_requirement.film_name
      )
      and coalesce(b.width_in, 0) >= coalesce(v_requirement.width_in, 0);

    if v_requirement_remaining_feet <= 0 then
      for v_cleanup_order in
        select fo.*
        from app.film_orders fo
        where fo.org_id = p_org_id
          and upper(trim(fo.job_number)) = upper(trim(v_job_context->>'jobNumber'))
          and coalesce(fo.status::text, '') in ('FILM_ORDER', 'FILM_ON_THE_WAY')
          and coalesce(trim(fo.source_box_id), '') <> ''
          and app_api.normalize_job_requirement_lookup_key(
            fo.manufacturer,
            fo.film_name,
            fo.width_in
          ) = app_api.normalize_job_requirement_lookup_key(
            v_requirement.manufacturer,
            v_requirement.film_name,
            v_requirement.width_in
          )
      loop
        select count(*)
        into v_cleanup_link_count
        from app.film_order_box_links l
        where l.org_id = p_org_id
          and l.film_order_id = v_cleanup_order.film_order_id;

        if v_cleanup_link_count > 0 then
          continue;
        end if;

        select count(*)
        into v_cleanup_allocation_count
        from app.allocations a
        where a.org_id = p_org_id
          and a.film_order_id = v_cleanup_order.film_order_id;

        if v_cleanup_allocation_count > 0 then
          continue;
        end if;

        perform app_api.delete_film_order_links_by_film_order_id(p_org_id, v_cleanup_order.film_order_id);
        perform app_api.delete_film_order(p_org_id, v_cleanup_order.film_order_id);
        v_deleted_shortage_film_order_count := v_deleted_shortage_film_order_count + 1;
      end loop;
    end if;

    if v_deleted_shortage_film_order_count > 0 then
      v_warnings := app_api.push_warning(
        v_warnings,
        format(
          'Removed %s stale shortage film order%s for job %s after fulfilling the selected requirement.',
          v_deleted_shortage_film_order_count,
          case when v_deleted_shortage_film_order_count = 1 then '' else 's' end,
          v_job_context->>'jobNumber'
        )
      );
    end if;
  end if;

  return jsonb_build_object(
    'allocationIds', to_jsonb(v_allocation_ids),
    'filmOrderId', ''::text,
    'remainingUncoveredFeet', greatest(v_remaining, 0),
    'warnings', to_jsonb(v_warnings)
  );
end;
$$;

create or replace function public.api_acl_allocations_apply(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_result jsonb;
  v_allocation_id text;
  v_box_id text;
  v_warnings text[] := array[]::text[];
begin
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'write');
  v_result := public.api_allocations_apply(p_org_id, p_actor, p_payload);
  v_warnings := coalesce(array(select jsonb_array_elements_text(coalesce(v_result->'warnings', '[]'::jsonb))), array[]::text[]);

  for v_allocation_id in
    select jsonb_array_elements_text(coalesce(v_result->'allocationIds', '[]'::jsonb))
  loop
    select a.box_id
    into v_box_id
    from app.allocations a
    where a.org_id = p_org_id
      and a.allocation_id = v_allocation_id
    limit 1;

    if coalesce(trim(v_box_id), '') <> '' then
      perform app_api.recalculate_physical_box_allocatable_now(p_org_id, v_box_id);
    end if;
  end loop;

  v_result := jsonb_set(v_result, '{warnings}', to_jsonb(v_warnings), true);
  return v_result;
end;
$$;

create or replace function public.api_acl_boxes_update(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_lookup_box_id text;
  v_existing_status text := '';
  v_result jsonb;
  v_box app.boxes;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');
  v_lookup_box_id := app_api.resolve_box_id_alias(
    p_org_id,
    app_api.require_text(v_payload->>'boxId', 'BoxID')
  );

  select upper(btrim(b.status::text))
  into v_existing_status
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = v_lookup_box_id;

  if v_existing_status = 'TRANSFER' then
    perform app_api.raise_http(
      400,
      format(
        'Box %s has a pending transfer and can only be received or have the transfer cancelled.',
        v_lookup_box_id
      )
    );
  end if;

  v_payload := jsonb_set(v_payload, '{boxId}', to_jsonb(v_lookup_box_id), true);
  v_result := public.api_boxes_update(p_org_id, p_actor, v_payload);

  select *
  into v_box
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = v_lookup_box_id
  limit 1;

  if found and upper(coalesce(v_box.status::text, '')) in ('IN_STOCK', 'TRANSFER') then
    perform app_api.recalculate_physical_box_allocatable_now(p_org_id, v_lookup_box_id);
    perform app_api.reconcile_auto_shortage_film_orders_for_box(
      p_org_id,
      p_actor,
      v_lookup_box_id,
      true
    );
  end if;

  return v_result;
end;
$$;

create or replace function public.api_acl_boxes_set_status(
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
  v_lookup_box_id text;
  v_existing_status text := '';
  v_result jsonb;
  v_box app.boxes;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');
  v_lookup_box_id := app_api.resolve_box_id_alias(
    p_org_id,
    app_api.require_text(v_payload->>'boxId', 'BoxID')
  );

  select upper(btrim(b.status::text))
  into v_existing_status
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = v_lookup_box_id;

  if v_existing_status = 'TRANSFER' then
    perform app_api.raise_http(
      400,
      format(
        'Box %s has a pending transfer and can only be received or have the transfer cancelled.',
        v_lookup_box_id
      )
    );
  end if;

  v_payload := jsonb_set(v_payload, '{boxId}', to_jsonb(v_lookup_box_id), true);
  v_result := public.api_boxes_set_status(p_org_id, p_actor, v_payload);

  select *
  into v_box
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = v_lookup_box_id
  limit 1;

  if found and upper(coalesce(v_box.status::text, '')) in ('IN_STOCK', 'TRANSFER') then
    perform app_api.recalculate_physical_box_allocatable_now(p_org_id, v_lookup_box_id);
    perform app_api.reconcile_auto_shortage_film_orders_for_box(
      p_org_id,
      p_actor,
      v_lookup_box_id,
      true
    );
  end if;

  return v_result;
end;
$$;

create or replace function public.api_acl_boxes_receive_ordered(
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
  v_lookup_box_id text;
  v_existing app.boxes;
  v_box app.boxes;
  v_received_weight_text text := app_api.trim_text(v_payload->>'receivedWeightLbs');
  v_received_weight_lbs numeric := null;
  v_lot_run text := app_api.trim_text(v_payload->>'lotRun');
  v_locked_allocated_feet integer := 0;
  v_receipt_result jsonb := '{}'::jsonb;
  v_reconcile_result jsonb := '{}'::jsonb;
  v_warnings text[] := array[]::text[];
  v_log_id text := '';
  v_audit_note text;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');
  v_lookup_box_id := app_api.resolve_box_id_alias(
    p_org_id,
    app_api.require_text(v_payload->>'boxId', 'BoxID')
  );

  select *
  into v_existing
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = v_lookup_box_id
  limit 1;

  if not found then
    perform app_api.raise_http(404, 'Box not found.');
  end if;

  if upper(coalesce(v_existing.status::text, '')) = 'TRANSFER' then
    perform app_api.raise_http(
      400,
      format(
        'Box %s has a pending transfer and can only be received or have the transfer cancelled.',
        v_lookup_box_id
      )
    );
  end if;

  if upper(coalesce(v_existing.status::text, '')) = 'ZEROED' then
    perform app_api.raise_http(400, 'Zeroed boxes cannot be received as ordered inventory.');
  end if;

  if upper(coalesce(v_existing.status::text, '')) = 'RETIRED' then
    perform app_api.raise_http(400, 'Retired boxes cannot be received as ordered inventory.');
  end if;

  if upper(coalesce(v_existing.status::text, '')) <> 'ORDERED' then
    perform app_api.raise_http(
      400,
      format(
        'Only boxes currently in ORDERED status can be received. %s is %s.',
        v_lookup_box_id,
        coalesce(v_existing.status::text, 'UNKNOWN')
      )
    );
  end if;

  if v_existing.received_date is not null then
    perform app_api.raise_http(
      400,
      format('Box %s already has a received date and cannot be received again.', v_lookup_box_id)
    );
  end if;

  if v_received_weight_text <> '' then
    begin
      v_received_weight_lbs := round((v_received_weight_text)::numeric, 2);
    exception
      when invalid_text_representation then
        perform app_api.raise_http(400, 'ReceivedWeightLbs must be a valid non-negative number.');
    end;

    if v_received_weight_lbs < 0 then
      perform app_api.raise_http(400, 'ReceivedWeightLbs must be a valid non-negative number.');
    end if;
  end if;

  if v_lot_run = '' then
    v_lot_run := coalesce(v_existing.lot_run, '');
  end if;

  v_locked_allocated_feet := app_api.locked_allocated_feet_for_box(p_org_id, v_lookup_box_id);
  v_box := v_existing;
  v_box.status := 'IN_STOCK';
  v_box.received_date := current_date;
  v_box.feet_available := greatest(coalesce(v_existing.initial_feet, 0) - coalesce(v_locked_allocated_feet, 0), 0);
  v_box.lot_run := v_lot_run;

  if v_received_weight_lbs is not null then
    v_box.initial_weight_lbs := v_received_weight_lbs;
    v_box.last_roll_weight_lbs := v_received_weight_lbs;
    v_box.last_weighed_date := current_date;
  end if;

  v_receipt_result := app_api.process_linked_box_receipt(p_org_id, v_box, p_actor);
  if coalesce(v_receipt_result, '{}'::jsonb) ? 'box' then
    v_box := jsonb_populate_record(null::app.boxes, v_receipt_result->'box');
  end if;
  if jsonb_typeof(coalesce(v_receipt_result->'warnings', '[]'::jsonb)) = 'array' then
    v_warnings := v_warnings || array(
      select jsonb_array_elements_text(coalesce(v_receipt_result->'warnings', '[]'::jsonb))
    );
  end if;

  v_box := app_api.save_box(v_box);

  v_audit_note := format('Received ordered box %s', v_lookup_box_id);
  if v_received_weight_lbs is not null then
    v_audit_note := format(
      '%s at %s lbs',
      v_audit_note,
      trim(trailing '.' from trim(trailing '0' from v_received_weight_lbs::text))
    );
  end if;
  if v_lot_run <> '' then
    v_audit_note := format('%s with lot run %s', v_audit_note, v_lot_run);
  end if;

  v_log_id := app_api.append_audit_entry(
    p_org_id,
    'SET_STATUS',
    v_box.box_id,
    app_api.public_box_json(v_existing),
    app_api.public_box_json(v_box),
    p_actor,
    v_audit_note
  );

  if upper(coalesce(v_box.status::text, '')) in ('IN_STOCK', 'TRANSFER') then
    perform app_api.recalculate_physical_box_allocatable_now(p_org_id, v_lookup_box_id);
    v_reconcile_result := app_api.reconcile_auto_shortage_film_orders_for_box(
      p_org_id,
      p_actor,
      v_lookup_box_id,
      true
    );

    if coalesce((v_reconcile_result->>'createdCount')::integer, 0) > 0 then
      v_warnings := app_api.push_warning(
        v_warnings,
        format(
          'Created %s shortage film order%s after receiving the ordered box.',
          (v_reconcile_result->>'createdCount')::integer,
          case when coalesce((v_reconcile_result->>'createdCount')::integer, 0) = 1 then '' else 's' end
        )
      );
    end if;

    if coalesce((v_reconcile_result->>'deletedCount')::integer, 0) > 0 then
      v_warnings := app_api.push_warning(
        v_warnings,
        format(
          'Removed %s stale shortage film order%s after receiving the ordered box.',
          (v_reconcile_result->>'deletedCount')::integer,
          case when coalesce((v_reconcile_result->>'deletedCount')::integer, 0) = 1 then '' else 's' end
        )
      );
    end if;
  end if;

  return jsonb_build_object(
    'boxId', v_box.box_id,
    'logId', v_log_id,
    'warnings', to_jsonb(v_warnings)
  );
end;
$$;
