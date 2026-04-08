create or replace function app_api.extract_requirement_compact_base_code(
  p_compact_family text
)
returns text
language sql
immutable
as $$
  select coalesce(
    (regexp_match(coalesce(p_compact_family, ''), '^([a-z]{1,4}[0-9]{1,4})'))[1],
    ''
  );
$$;

create or replace function app_api.requirement_film_is_compatible(
  p_org_id uuid,
  p_candidate_manufacturer text,
  p_candidate_film_name text,
  p_requirement_manufacturer text,
  p_requirement_film_name text
)
returns boolean
language sql
stable
as $$
  with candidate as (
    select
      split_part(
        app_api.normalize_requirement_film_family_key(
          p_org_id,
          p_candidate_manufacturer,
          p_candidate_film_name
        ),
        '|',
        1
      ) as manufacturer_key,
      split_part(
        app_api.normalize_requirement_film_family_key(
          p_org_id,
          p_candidate_manufacturer,
          p_candidate_film_name
        ),
        '|',
        2
      ) as compact_family,
      app_api.extract_requirement_compact_base_code(
        split_part(
          app_api.normalize_requirement_film_family_key(
            p_org_id,
            p_candidate_manufacturer,
            p_candidate_film_name
          ),
          '|',
          2
        )
      ) as compact_base_code,
      app_api.requirement_film_is_exterior(
        p_org_id,
        p_candidate_manufacturer,
        p_candidate_film_name
      ) as is_exterior
  ),
  requirement as (
    select
      split_part(
        app_api.normalize_requirement_film_family_key(
          p_org_id,
          p_requirement_manufacturer,
          p_requirement_film_name
        ),
        '|',
        1
      ) as manufacturer_key,
      split_part(
        app_api.normalize_requirement_film_family_key(
          p_org_id,
          p_requirement_manufacturer,
          p_requirement_film_name
        ),
        '|',
        2
      ) as compact_family,
      app_api.extract_requirement_compact_base_code(
        split_part(
          app_api.normalize_requirement_film_family_key(
            p_org_id,
            p_requirement_manufacturer,
            p_requirement_film_name
          ),
          '|',
          2
        )
      ) as compact_base_code,
      app_api.requirement_film_is_exterior(
        p_org_id,
        p_requirement_manufacturer,
        p_requirement_film_name
      ) as is_exterior
  )
  select
    candidate.manufacturer_key = requirement.manufacturer_key
    and (
      candidate.compact_family = requirement.compact_family
      or (
        requirement.compact_base_code <> ''
        and requirement.compact_family = requirement.compact_base_code
        and candidate.compact_base_code = requirement.compact_base_code
        and candidate.compact_family like requirement.compact_family || '%'
        and length(candidate.compact_family) > length(requirement.compact_family)
      )
    )
    and (
      not requirement.is_exterior
      or candidate.is_exterior
    )
  from candidate, requirement;
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
  v_requirement_id uuid;
  v_requirement app.job_requirements;
  v_source_film_key text;
  v_requirement_is_exterior boolean := false;
  v_remaining integer := 0;
  v_source_suggested integer := 0;
  v_source_suggested_covered integer := 0;
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
  v_film_order app.film_orders;
  v_conflict_count integer;
  v_job_warehouse text;
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

  if v_source.status <> 'IN_STOCK' then
    perform app_api.raise_http(400, 'Only in-stock boxes can be allocated.');
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

  if v_requested_feet > 0 then
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
        v_source.feet_available,
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
    v_source.feet_available := greatest(v_source.feet_available - v_source_suggested, 0);
    v_source := app_api.save_box(v_source);
    v_allocation_ids := array_append(v_allocation_ids, v_allocation.allocation_id);
  end if;

  for v_candidate in
    select *
    from app.boxes b
    where b.org_id = p_org_id
      and b.box_id <> v_source.box_id
      and b.status = 'IN_STOCK'
      and b.feet_available > 0
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
      v_candidate.feet_available,
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
    v_candidate.feet_available := greatest(v_candidate.feet_available - v_allocation.allocated_feet, 0);
    perform app_api.save_box(v_candidate);
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

      if v_candidate.status <> 'IN_STOCK' then
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

      if v_candidate.feet_available < v_extra_feet then
        perform app_api.raise_http(400, format('Box %s no longer has enough available LF.', v_candidate.box_id));
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
      v_candidate.feet_available := greatest(v_candidate.feet_available - v_extra_feet, 0);
      perform app_api.save_box(v_candidate);
      v_allocation_ids := array_append(v_allocation_ids, v_allocation.allocation_id);
      v_extra_processed_box_ids := array_append(v_extra_processed_box_ids, v_extra_box_id);
    end loop;
  end if;

  if v_requested_feet = 0 and coalesce(array_length(v_extra_processed_box_ids, 1), 0) = 0 then
    perform app_api.raise_http(400, 'RequestedFeet must be greater than zero unless extraAllocations are provided.');
  end if;

  if v_remaining > 0 then
    if app_api.trim_text(p_payload->>'jobWarehouse') <> '' then
      v_job_warehouse := app_api.require_org_warehouse(p_org_id, p_payload->>'jobWarehouse', 'Job warehouse');
    else
      v_job_warehouse := v_source.warehouse;
    end if;

    v_film_order.id := gen_random_uuid();
    v_film_order.org_id := p_org_id;
    v_film_order.film_order_id := app_api.create_log_id();
    v_film_order.job_id := app_api.get_or_resolve_job_id(p_org_id, v_job_context->>'jobNumber');
    v_film_order.job_number := v_job_context->>'jobNumber';
    v_film_order.warehouse := v_job_warehouse;
    v_film_order.manufacturer := coalesce(v_requirement.manufacturer, v_source.manufacturer);
    v_film_order.film_name := coalesce(v_requirement.film_name, v_source.film_name);
    v_film_order.width_in := v_requested_width_in;
    v_film_order.requested_feet := v_remaining;
    v_film_order.covered_feet := 0;
    v_film_order.ordered_feet := 0;
    v_film_order.remaining_to_order_feet := v_remaining;
    v_film_order.job_date := nullif(v_job_context->>'jobDate', '')::date;
    v_film_order.crew_leader := coalesce(v_job_context->>'crewLeader', '');
    v_film_order.status := 'FILM_ORDER';
    v_film_order.source_box_id := v_source.box_id;
    v_film_order.resolved_at := null;
    v_film_order.resolved_by := '';
    v_film_order.notes := format('Created from a shortage while trying to allocate %s LF.', v_requested_feet);
    v_film_order.created_at := now();
    v_film_order.created_by := app_api.trim_text(p_actor);
    v_film_order := app_api.save_film_order(v_film_order);
    v_warnings := app_api.push_warning(
      v_warnings,
      format('Film Order %s was created for the remaining %s LF.', v_film_order.film_order_id, v_remaining)
    );
  end if;

  return jsonb_build_object(
    'allocationIds', to_jsonb(v_allocation_ids),
    'filmOrderId', coalesce(v_film_order.film_order_id, ''),
    'remainingUncoveredFeet', greatest(v_remaining, 0),
    'warnings', to_jsonb(v_warnings)
  );
end;
$$;
