/**
 * PURPOSE:
 * Makes canonical allocation apply target exact job IDs while preserving the
 * legacy jobNumber-only allocation apply path.
 *
 * AFFECTS:
 * public.api_allocations_apply, public.api_acl_allocations_apply, local/Edge
 * canonical allocation apply payloads, and planner reconciliation scope.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * frontend JobAllocateDialog apply payloads, Supabase Edge mutationHandlers
 * /allocations/apply, backend runtimeAllocationApply, and allocation apply
 * cache invalidation.
 *
 * COMMON FAILURE MODES:
 * Re-resolving canonical jobId payloads by jobNumber, broadening legacy apply
 * semantics, omitting boxIds from planner scope, or patching same-number legacy
 * caches after canonical allocation apply.
 */

create or replace function app_api.create_allocation(
  p_org_id uuid,
  p_box app.boxes,
  p_job_context jsonb,
  p_allocated_feet integer,
  p_actor text,
  p_film_order_id text default '',
  p_allocation_kind text default 'REQUIREMENT',
  p_requirement_id uuid default null
)
returns app.allocations
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_allocation app.allocations;
  v_kind text := upper(app_api.trim_text(p_allocation_kind));
  v_job_id_text text := app_api.trim_text(p_job_context->>'jobId');
  v_job_id uuid;
begin
  if v_kind = '' then
    v_kind := 'REQUIREMENT';
  end if;

  if v_kind not in ('REQUIREMENT', 'EXTRA') then
    perform app_api.raise_http(400, 'Allocation kind must be REQUIREMENT or EXTRA.');
  end if;

  if v_job_id_text <> '' then
    begin
      v_job_id := v_job_id_text::uuid;
    exception
      when others then
        perform app_api.raise_http(400, 'jobId must be a valid UUID.');
    end;
  else
    v_job_id := app_api.get_or_resolve_job_id(p_org_id, p_job_context->>'jobNumber');
  end if;

  v_allocation.id := gen_random_uuid();
  v_allocation.org_id := p_org_id;
  v_allocation.allocation_id := app_api.create_log_id();
  v_allocation.box_id := p_box.box_id;
  v_allocation.job_id := v_job_id;
  v_allocation.job_number := p_job_context->>'jobNumber';
  v_allocation.warehouse := p_box.warehouse;
  v_allocation.job_date := nullif(app_api.trim_text(p_job_context->>'jobDate'), '')::date;
  v_allocation.allocated_feet := p_allocated_feet;
  v_allocation.covered_feet := p_allocated_feet;
  v_allocation.requirement_id := p_requirement_id;
  v_allocation.status := 'ACTIVE';
  v_allocation.created_at := now();
  v_allocation.created_by := app_api.trim_text(p_actor);
  v_allocation.resolved_at := null;
  v_allocation.resolved_by := '';
  v_allocation.notes := '';
  v_allocation.crew_leader := coalesce(p_job_context->>'crewLeader', '');
  v_allocation.film_order_id := app_api.trim_text(p_film_order_id);
  v_allocation.allocation_kind := v_kind::app.allocation_kind;

  return app_api.save_allocation(v_allocation);
end;
$$;

create or replace function app_api.create_allocation_with_coverage(
  p_org_id uuid,
  p_box app.boxes,
  p_job_context jsonb,
  p_allocated_feet integer,
  p_covered_feet integer,
  p_actor text,
  p_film_order_id text default '',
  p_allocation_kind text default 'REQUIREMENT',
  p_requirement_id uuid default null
)
returns app.allocations
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_allocation app.allocations;
  v_kind text := upper(app_api.trim_text(p_allocation_kind));
  v_job_id_text text := app_api.trim_text(p_job_context->>'jobId');
  v_job_id uuid;
begin
  if v_kind = '' then
    v_kind := 'REQUIREMENT';
  end if;

  if v_kind not in ('REQUIREMENT', 'EXTRA') then
    perform app_api.raise_http(400, 'Allocation kind must be REQUIREMENT or EXTRA.');
  end if;

  if v_job_id_text <> '' then
    begin
      v_job_id := v_job_id_text::uuid;
    exception
      when others then
        perform app_api.raise_http(400, 'jobId must be a valid UUID.');
    end;
  else
    v_job_id := app_api.get_or_resolve_job_id(p_org_id, p_job_context->>'jobNumber');
  end if;

  v_allocation.id := gen_random_uuid();
  v_allocation.org_id := p_org_id;
  v_allocation.allocation_id := app_api.create_log_id();
  v_allocation.box_id := p_box.box_id;
  v_allocation.job_id := v_job_id;
  v_allocation.job_number := p_job_context->>'jobNumber';
  v_allocation.warehouse := p_box.warehouse;
  v_allocation.job_date := nullif(app_api.trim_text(p_job_context->>'jobDate'), '')::date;
  v_allocation.allocated_feet := p_allocated_feet;
  v_allocation.covered_feet := greatest(coalesce(p_covered_feet, p_allocated_feet), 0);
  v_allocation.requirement_id := p_requirement_id;
  v_allocation.status := 'ACTIVE';
  v_allocation.created_at := now();
  v_allocation.created_by := app_api.trim_text(p_actor);
  v_allocation.resolved_at := null;
  v_allocation.resolved_by := '';
  v_allocation.notes := '';
  v_allocation.crew_leader := coalesce(p_job_context->>'crewLeader', '');
  v_allocation.film_order_id := app_api.trim_text(p_film_order_id);
  v_allocation.allocation_kind := v_kind::app.allocation_kind;

  return app_api.save_allocation(v_allocation);
end;
$$;

create or replace function app_api.create_or_merge_manual_requirement_allocation_with_coverage(
  p_org_id uuid,
  p_box app.boxes,
  p_job_context jsonb,
  p_allocated_feet integer,
  p_covered_feet integer,
  p_actor text,
  p_film_order_id text default '',
  p_allocation_kind text default 'REQUIREMENT',
  p_requirement_id uuid default null
)
returns app.allocations
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_kind text := upper(app_api.trim_text(p_allocation_kind));
  v_job_id_text text := app_api.trim_text(p_job_context->>'jobId');
  v_has_job_id boolean := v_job_id_text <> '';
  v_job_id uuid;
  v_job_number text := app_api.trim_text(p_job_context->>'jobNumber');
  v_film_order_id text := app_api.trim_text(p_film_order_id);
  v_primary app.allocations;
  v_duplicate app.allocations;
  v_allocated_feet integer := 0;
  v_covered_feet integer := 0;
begin
  if v_kind = '' then
    v_kind := 'REQUIREMENT';
  end if;

  if v_has_job_id then
    begin
      v_job_id := v_job_id_text::uuid;
    exception
      when others then
        perform app_api.raise_http(400, 'jobId must be a valid UUID.');
    end;
  else
    v_job_id := app_api.get_or_resolve_job_id(p_org_id, p_job_context->>'jobNumber');
  end if;

  if v_kind <> 'REQUIREMENT'
    or p_requirement_id is null
    or v_film_order_id <> ''
  then
    return app_api.create_allocation_with_coverage(
      p_org_id,
      p_box,
      p_job_context,
      p_allocated_feet,
      p_covered_feet,
      p_actor,
      p_film_order_id,
      p_allocation_kind,
      p_requirement_id
    );
  end if;

  select a.*
  into v_primary
  from app.allocations a
  where a.org_id = p_org_id
    and a.box_id = p_box.box_id
    and a.status = 'ACTIVE'
    and coalesce(a.allocation_kind::text, 'REQUIREMENT') = 'REQUIREMENT'
    and a.requirement_id = p_requirement_id
    and coalesce(a.film_order_id, '') = ''
    and coalesce(a.allocation_source::text, 'MANUAL') in ('MANUAL', 'AUTO_PLANNED')
    and case
      when v_has_job_id then a.job_id = v_job_id
      when v_job_id is not null and a.job_id is not null then a.job_id = v_job_id
      else upper(trim(coalesce(a.job_number, ''))) = upper(v_job_number)
    end
  order by
    case coalesce(a.allocation_source::text, 'MANUAL')
      when 'MANUAL' then 0
      when 'AUTO_PLANNED' then 1
      else 2
    end,
    a.created_at asc,
    a.allocation_id asc
  limit 1
  for update;

  if v_primary.id is null then
    return app_api.create_allocation_with_coverage(
      p_org_id,
      p_box,
      p_job_context,
      p_allocated_feet,
      p_covered_feet,
      p_actor,
      p_film_order_id,
      p_allocation_kind,
      p_requirement_id
    );
  end if;

  v_allocated_feet := coalesce(v_primary.allocated_feet, 0);
  v_covered_feet := coalesce(v_primary.covered_feet, v_primary.allocated_feet, 0);

  for v_duplicate in
    select a.*
    from app.allocations a
    where a.org_id = p_org_id
      and a.id <> v_primary.id
      and a.box_id = p_box.box_id
      and a.status = 'ACTIVE'
      and coalesce(a.allocation_kind::text, 'REQUIREMENT') = 'REQUIREMENT'
      and a.requirement_id = p_requirement_id
      and coalesce(a.film_order_id, '') = ''
      and coalesce(a.allocation_source::text, 'MANUAL') in ('MANUAL', 'AUTO_PLANNED')
      and case
        when v_has_job_id then a.job_id = v_job_id
        when v_job_id is not null and a.job_id is not null then a.job_id = v_job_id
        else upper(trim(coalesce(a.job_number, ''))) = upper(v_job_number)
      end
    order by
      case coalesce(a.allocation_source::text, 'MANUAL')
        when 'MANUAL' then 0
        when 'AUTO_PLANNED' then 1
        else 2
      end,
      a.created_at asc,
      a.allocation_id asc
    for update
  loop
    v_allocated_feet := v_allocated_feet + coalesce(v_duplicate.allocated_feet, 0);
    v_covered_feet := v_covered_feet + coalesce(v_duplicate.covered_feet, v_duplicate.allocated_feet, 0);

    v_duplicate.status := 'CANCELLED';
    v_duplicate.resolved_at := now();
    v_duplicate.resolved_by := app_api.trim_text(p_actor);
    v_duplicate.notes := format('Superseded by manual allocation merge into %s.', v_primary.allocation_id);
    v_duplicate := app_api.save_allocation(v_duplicate);
  end loop;

  v_primary.box_id := p_box.box_id;
  v_primary.job_id := v_job_id;
  v_primary.job_number := v_job_number;
  v_primary.warehouse := p_box.warehouse;
  v_primary.job_date := nullif(app_api.trim_text(p_job_context->>'jobDate'), '')::date;
  v_primary.allocated_feet := v_allocated_feet + greatest(coalesce(p_allocated_feet, 0), 0);
  v_primary.covered_feet := v_covered_feet + greatest(coalesce(p_covered_feet, p_allocated_feet, 0), 0);
  v_primary.requirement_id := p_requirement_id;
  v_primary.status := 'ACTIVE';
  v_primary.resolved_at := null;
  v_primary.resolved_by := '';
  v_primary.crew_leader := coalesce(p_job_context->>'crewLeader', '');
  v_primary.film_order_id := '';
  v_primary.allocation_kind := 'REQUIREMENT'::app.allocation_kind;
  v_primary.allocation_source := 'MANUAL'::app.allocation_source;

  return app_api.save_allocation(v_primary);
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
  v_job app.jobs;
  v_job_context jsonb;
  v_job_id_text text := app_api.trim_text(p_payload->>'jobId');
  v_has_job_id boolean := v_job_id_text <> '';
  v_job_id uuid;
  v_job_number text;
  v_job_date date;
  v_crew_leader text;
  v_requested_feet integer := coalesce(floor(nullif(app_api.trim_text(p_payload->>'requestedFeet'), '')::numeric), 0);
  v_requested_width_in numeric := nullif(app_api.trim_text(p_payload->>'requestedWidthIn'), '')::numeric;
  v_requirement_id_text text := app_api.trim_text(p_payload->>'requirementId');
  v_should_validate_requirement boolean := false;
  v_requirement_id uuid;
  v_requirement app.job_requirements;
  v_source_film_key text;
  v_requirement_is_exterior boolean := false;
  v_remaining integer := 0;
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
      and j.id = v_job_id
    for update;

    if not found then
      perform app_api.raise_http(404, 'Job was not found.');
    end if;

    v_job_number := app_api.require_text(p_payload->>'jobNumber', 'JobNumber');
    if upper(trim(v_job.job_number)) <> upper(trim(v_job_number)) then
      perform app_api.raise_http(400, 'Job identity mismatch: selected job does not match jobNumber.');
    end if;

    if coalesce(v_job.lifecycle_status::text, 'ACTIVE') <> 'ACTIVE' then
      perform app_api.raise_http(400, format('Job %s is closed and cannot receive allocations.', v_job.job_number));
    end if;

    v_job_date := nullif(app_api.trim_text(p_payload->>'jobDate'), '')::date;
    v_crew_leader := app_api.trim_text(p_payload->>'crewLeader');

    if v_job.due_date is not null and v_job_date is not null and v_job.due_date <> v_job_date then
      perform app_api.raise_http(400, 'JobDate must stay the same for an existing Job Number.');
    end if;

    if coalesce(v_job.crew_leader, '') <> ''
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
      p_payload->>'jobNumber',
      p_payload->>'jobDate',
      p_payload->>'crewLeader'
    );
    v_job_number := v_job_context->>'jobNumber';
  end if;

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

    if not v_has_job_id then
      v_job_id := app_api.get_or_resolve_job_id(p_org_id, v_job_context->>'jobNumber');
    end if;

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
      and case
        when v_has_job_id then a.job_id is distinct from v_job.id
        else upper(a.job_number) <> upper(v_job_context->>'jobNumber')
      end
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
    v_allocation := app_api.create_or_merge_manual_requirement_allocation_with_coverage(
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
      and case
        when v_has_job_id then a.job_id is distinct from v_job.id
        else upper(a.job_number) <> upper(v_job_context->>'jobNumber')
      end
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

    v_allocation := app_api.create_or_merge_manual_requirement_allocation_with_coverage(
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
  v_box_ids text[] := array[]::text[];
  v_job_id_text text := app_api.trim_text(p_payload->>'jobId');
  v_has_job_id boolean := v_job_id_text <> '';
  v_job_id uuid;
  v_job app.jobs;
  v_job_number text := app_api.trim_text(p_payload->>'jobNumber');
  v_warnings text[] := array[]::text[];
begin
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'write');

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
      and j.id = v_job_id
    limit 1;

    if not found then
      perform app_api.raise_http(404, 'Job was not found.');
    end if;

    v_job_number := app_api.require_text(p_payload->>'jobNumber', 'JobNumber');
    if upper(trim(v_job.job_number)) <> upper(trim(v_job_number)) then
      perform app_api.raise_http(400, 'Job identity mismatch: selected job does not match jobNumber.');
    end if;

    v_job_number := v_job.job_number;
  end if;

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
      v_box_ids := array_append(v_box_ids, v_box_id);
    end if;
  end loop;

  if v_job_number <> '' or coalesce(array_length(v_box_ids, 1), 0) > 0 then
    if v_has_job_id then
      perform app_api.reconcile_auto_planned_allocations(
        p_org_id,
        p_actor,
        jsonb_build_object(
          'jobIds',
          jsonb_build_array(v_job.id),
          'jobNumbers',
          jsonb_build_array(v_job.job_number),
          'boxIds',
          coalesce(to_jsonb(v_box_ids), '[]'::jsonb)
        )
      );
    else
      perform app_api.reconcile_auto_planned_allocations(
        p_org_id,
        p_actor,
        jsonb_build_object(
          'jobNumbers',
          case when v_job_number = '' then '[]'::jsonb else jsonb_build_array(v_job_number) end,
          'boxIds',
          coalesce(to_jsonb(v_box_ids), '[]'::jsonb)
        )
      );
    end if;
  end if;

  v_result := jsonb_set(v_result, '{warnings}', to_jsonb(v_warnings), true);
  return v_result;
end;
$$;
