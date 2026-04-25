/**
 * PURPOSE:
 * Stops hidden auto-shortage film-order mutations while preserving allocation,
 * receipt, reservation, and manual order flows.
 *
 * AFFECTS:
 * Supabase RPC allocation apply, post-save shortage reconciliation wrappers,
 * manual film order creation, and hosted Edge mutation behavior.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * backend runtimeAutoShortageFilmOrders.mjs, runtimeAllocationApply.mjs,
 * supabase/functions/_shared/api-handler.ts, FilmRequirementsSection order UI,
 * and allocation/order regression tests.
 *
 * COMMON FAILURE MODES:
 * Reintroducing hidden order creation/deletion, allowing duplicate manual orders,
 * or drifting backend and Supabase RPC behavior.
 */

create or replace function app_api.reconcile_auto_shortage_film_orders_for_job(
  p_org_id uuid,
  p_actor text,
  p_job_number text,
  p_allow_placeholder_shortages boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  return jsonb_build_object(
    'createdCount', 0,
    'updatedCount', 0,
    'deletedCount', 0
  );
end;
$$;

create or replace function app_api.reconcile_auto_shortage_film_orders_for_box(
  p_org_id uuid,
  p_actor text,
  p_box_id text,
  p_allow_placeholder_shortages boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  return jsonb_build_object(
    'createdCount', 0,
    'updatedCount', 0,
    'deletedCount', 0
  );
end;
$$;

create or replace function public.api_film_orders_create(
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
  v_requested_feet integer := floor(nullif(app_api.trim_text(p_payload->>'requestedFeet'), '')::numeric);
  v_width_in numeric := nullif(app_api.trim_text(p_payload->>'widthIn'), '')::numeric;
  v_order app.film_orders;
  v_job app.jobs;
begin
  perform app_api.require_org_member(p_org_id);

  if v_width_in is null or v_width_in <= 0 then
    perform app_api.raise_http(400, 'WidthIn must be greater than zero.');
  end if;

  if v_requested_feet is null or v_requested_feet <= 0 then
    perform app_api.raise_http(400, 'RequestedFeet must be greater than zero.');
  end if;

  v_order.id := gen_random_uuid();
  v_order.org_id := p_org_id;
  v_order.film_order_id := app_api.create_log_id();
  v_order.job_id := app_api.get_or_resolve_job_id(p_org_id, p_payload->>'jobNumber');
  v_order.job_number := app_api.require_text(p_payload->>'jobNumber', 'JobNumber');
  v_order.warehouse := app_api.require_org_warehouse(p_org_id, p_payload->>'warehouse', 'Warehouse');
  v_order.manufacturer := app_api.require_text(p_payload->>'manufacturer', 'Manufacturer');
  v_order.film_name := app_api.require_text(p_payload->>'filmName', 'FilmName');
  v_order.width_in := v_width_in;
  v_order.requested_feet := v_requested_feet;
  v_order.covered_feet := 0;
  v_order.ordered_feet := 0;
  v_order.remaining_to_order_feet := v_requested_feet;

  if v_order.job_id is not null then
    select *
    into v_job
    from app.jobs j
    where j.org_id = p_org_id
      and j.id = v_order.job_id
    limit 1;
  end if;

  if exists (
    select 1
    from app.film_orders fo
    where fo.org_id = p_org_id
      and upper(trim(fo.job_number)) = upper(trim(v_order.job_number))
      and coalesce(fo.status::text, '') in ('FILM_ORDER', 'FILM_ON_THE_WAY')
      and app_api.normalize_job_requirement_lookup_key(
        fo.manufacturer,
        app_api.resolve_canonical_film_name(p_org_id, fo.manufacturer, fo.film_name),
        fo.width_in
      ) = app_api.normalize_job_requirement_lookup_key(
        v_order.manufacturer,
        app_api.resolve_canonical_film_name(p_org_id, v_order.manufacturer, v_order.film_name),
        v_order.width_in
      )
  ) then
    perform app_api.raise_http(
      409,
      format(
        'Film order for %s %s %s already covers job %s. Cancel it before creating another order.',
        v_order.manufacturer,
        v_order.film_name,
        v_order.width_in,
        v_order.job_number
      )
    );
  end if;

  v_order.job_date := v_job.due_date;
  v_order.crew_leader := coalesce(v_job.crew_leader, '');
  v_order.status := 'FILM_ORDER';
  v_order.source_box_id := '';
  v_order.resolved_at := null;
  v_order.resolved_by := '';
  v_order.notes := 'Created manually from Film Orders.';
  v_order.created_at := now();
  v_order.created_by := app_api.trim_text(p_actor);

  v_order := app_api.save_film_order(v_order);

  return jsonb_build_object(
    'filmOrderId', v_order.film_order_id,
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

  -- Manual-approval workflow: allocation apply no longer deletes stale auto-shortage film orders.
  return jsonb_build_object(
    'allocationIds', to_jsonb(v_allocation_ids),
    'filmOrderId', ''::text,
    'remainingUncoveredFeet', greatest(v_remaining, 0),
    'warnings', to_jsonb(v_warnings)
  );
end;
$$;
