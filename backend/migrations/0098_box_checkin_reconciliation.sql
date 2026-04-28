/*
 * PURPOSE:
 * Adds reality-driven box check-in allocation reconciliation while preserving
 * allocations by reservation order.
 *
 * AFFECTS:
 * Box check-in, active film allocations, requirement coverage, film order
 * shortage amounts, and derived job readiness/ordered statuses.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * public.api_boxes_set_status, backend runtimeBoxCheckin/statusTransitions,
 * allocation coverage helpers, film order serializers, and frontend status math.
 *
 * COMMON FAILURE MODES:
 * Blocking valid overuse, reducing earlier reservations, stale film-order LF,
 * negative available LF, or counting FILM_ON_THE_WAY as editable shortage.
 */

alter table app.film_orders
  add column if not exists requirement_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    where c.conrelid = 'app.film_orders'::regclass
      and c.conname = 'film_orders_requirement_id_fkey'
  ) then
    alter table app.film_orders
      add constraint film_orders_requirement_id_fkey
      foreign key (requirement_id)
      references app.job_requirements(id)
      on delete set null;
  end if;
end;
$$;

create index if not exists idx_film_orders_org_requirement_id
  on app.film_orders (org_id, requirement_id)
  where requirement_id is not null;

create or replace function app_api.public_film_order_json(
  p_org_id uuid,
  p_order app.film_orders
)
returns jsonb
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select jsonb_build_object(
    'filmOrderId', coalesce(p_order.film_order_id, ''),
    'requirementId', coalesce(p_order.requirement_id::text, ''),
    'jobNumber', coalesce(p_order.job_number, ''),
    'warehouse', coalesce(p_order.warehouse::text, ''),
    'manufacturer', coalesce(p_order.manufacturer, ''),
    'filmName', coalesce(p_order.film_name, ''),
    'widthIn', p_order.width_in,
    'requestedFeet', p_order.requested_feet,
    'coveredFeet', p_order.covered_feet,
    'orderedFeet', p_order.ordered_feet,
    'remainingToOrderFeet', p_order.remaining_to_order_feet,
    'jobDate', coalesce(to_char(p_order.job_date, 'YYYY-MM-DD'), ''),
    'crewLeader', coalesce(p_order.crew_leader, ''),
    'status', coalesce(p_order.status::text, 'FILM_ORDER'),
    'sourceBoxId', coalesce(p_order.source_box_id, ''),
    'createdAt', coalesce(to_char(p_order.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''),
    'createdBy', coalesce(p_order.created_by, ''),
    'resolvedAt', coalesce(to_char(p_order.resolved_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''),
    'resolvedBy', coalesce(p_order.resolved_by, ''),
    'notes', coalesce(p_order.notes, ''),
    'linkedBoxes', app_api.public_film_order_linked_boxes_json(p_org_id, p_order.film_order_id)
  );
$$;

create or replace function app_api.save_film_order(p_order app.film_orders)
returns app.film_orders
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_row app.film_orders;
begin
  insert into app.film_orders (
    id,
    org_id,
    film_order_id,
    requirement_id,
    job_id,
    job_number,
    warehouse,
    manufacturer,
    film_name,
    width_in,
    requested_feet,
    covered_feet,
    ordered_feet,
    remaining_to_order_feet,
    job_date,
    crew_leader,
    status,
    source_box_id,
    resolved_at,
    resolved_by,
    notes,
    created_at,
    created_by
  )
  values (
    coalesce(p_order.id, gen_random_uuid()),
    p_order.org_id,
    p_order.film_order_id,
    p_order.requirement_id,
    p_order.job_id,
    p_order.job_number,
    p_order.warehouse,
    p_order.manufacturer,
    p_order.film_name,
    p_order.width_in,
    p_order.requested_feet,
    p_order.covered_feet,
    p_order.ordered_feet,
    p_order.remaining_to_order_feet,
    p_order.job_date,
    coalesce(p_order.crew_leader, ''),
    p_order.status,
    coalesce(p_order.source_box_id, ''),
    p_order.resolved_at,
    coalesce(p_order.resolved_by, ''),
    coalesce(p_order.notes, ''),
    coalesce(p_order.created_at, now()),
    coalesce(p_order.created_by, '')
  )
  on conflict (org_id, film_order_id) do update set
    requirement_id = excluded.requirement_id,
    job_id = excluded.job_id,
    job_number = excluded.job_number,
    warehouse = excluded.warehouse,
    manufacturer = excluded.manufacturer,
    film_name = excluded.film_name,
    width_in = excluded.width_in,
    requested_feet = excluded.requested_feet,
    covered_feet = excluded.covered_feet,
    ordered_feet = excluded.ordered_feet,
    remaining_to_order_feet = excluded.remaining_to_order_feet,
    job_date = excluded.job_date,
    crew_leader = excluded.crew_leader,
    status = excluded.status,
    source_box_id = excluded.source_box_id,
    resolved_at = excluded.resolved_at,
    resolved_by = excluded.resolved_by,
    notes = excluded.notes,
    created_at = excluded.created_at,
    created_by = excluded.created_by
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function app_api.film_order_matches_requirement(
  p_org_id uuid,
  p_order_requirement_id uuid,
  p_order_manufacturer text,
  p_order_film_name text,
  p_order_width_in numeric,
  p_requirement_id uuid,
  p_requirement_manufacturer text,
  p_requirement_film_name text,
  p_requirement_width_in numeric
)
returns boolean
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select
    case
      when p_order_requirement_id is not null or p_requirement_id is not null then
        p_order_requirement_id is not null
        and p_requirement_id is not null
        and p_order_requirement_id = p_requirement_id
        and app_api.normalize_job_requirement_lookup_key(
          p_order_manufacturer,
          app_api.resolve_canonical_film_name(p_org_id, p_order_manufacturer, p_order_film_name),
          p_order_width_in
        ) = app_api.normalize_job_requirement_lookup_key(
          p_requirement_manufacturer,
          app_api.resolve_canonical_film_name(p_org_id, p_requirement_manufacturer, p_requirement_film_name),
          p_requirement_width_in
        )
      else
        app_api.normalize_job_requirement_lookup_key(
          p_order_manufacturer,
          app_api.resolve_canonical_film_name(p_org_id, p_order_manufacturer, p_order_film_name),
          p_order_width_in
        ) = app_api.normalize_job_requirement_lookup_key(
          p_requirement_manufacturer,
          app_api.resolve_canonical_film_name(p_org_id, p_requirement_manufacturer, p_requirement_film_name),
          p_requirement_width_in
        )
    end;
$$;

create or replace function app_api.reconcile_existing_film_order_need_for_requirement(
  p_org_id uuid,
  p_actor text,
  p_requirement_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_requirement app.job_requirements;
  v_primary_order app.film_orders;
  v_allocated_covered_feet integer := 0;
  v_missing_feet integer := 0;
  v_on_the_way_feet integer := 0;
  v_needed_order_feet integer := 0;
begin
  if p_requirement_id is null then
    return jsonb_build_object('updated', false, 'reason', 'NO_REQUIREMENT');
  end if;

  select *
  into v_requirement
  from app.job_requirements r
  where r.org_id = p_org_id
    and r.id = p_requirement_id;

  if not found then
    return jsonb_build_object('updated', false, 'reason', 'REQUIREMENT_NOT_FOUND');
  end if;

  -- FILM_ON_THE_WAY coverage uses the approved ordered LF once present;
  -- requested LF is a legacy fallback for older rows without ordered LF.
  select coalesce(sum(
    case
      when coalesce(a.covered_feet, 0) > 0 then a.covered_feet
      else a.allocated_feet
    end
  ), 0)::integer
  into v_allocated_covered_feet
  from app.allocations a
  join app.boxes b
    on b.org_id = a.org_id
   and b.box_id = a.box_id
  where a.org_id = p_org_id
    and a.requirement_id = v_requirement.id
    and a.status = 'ACTIVE'
    and coalesce(a.allocation_kind::text, 'REQUIREMENT') = 'REQUIREMENT'
    and upper(trim(coalesce(a.job_number, ''))) = upper(trim(coalesce(v_requirement.job_number, '')))
    and coalesce(b.status::text, '') not in ('ZEROED', 'RETIRED')
    and app_api.requirement_film_is_compatible(
      p_org_id,
      b.manufacturer,
      b.film_name,
      v_requirement.manufacturer,
      v_requirement.film_name
    )
    and coalesce(b.width_in, 0) >= coalesce(v_requirement.width_in, 0);

  v_missing_feet := greatest(
    coalesce(v_requirement.required_feet, 0) - least(v_allocated_covered_feet, coalesce(v_requirement.required_feet, 0)),
    0
  );

  select coalesce(sum(
    case
      when coalesce(fo.ordered_feet, 0) > 0 then coalesce(fo.ordered_feet, 0)
      else coalesce(fo.requested_feet, 0)
    end
  ), 0)::integer
  into v_on_the_way_feet
  from app.film_orders fo
  where fo.org_id = p_org_id
    and upper(trim(coalesce(fo.job_number, ''))) = upper(trim(coalesce(v_requirement.job_number, '')))
    and coalesce(fo.status::text, '') = 'FILM_ON_THE_WAY'
    and app_api.film_order_matches_requirement(
      p_org_id,
      fo.requirement_id,
      fo.manufacturer,
      fo.film_name,
      fo.width_in,
      v_requirement.id,
      v_requirement.manufacturer,
      v_requirement.film_name,
      v_requirement.width_in
    );

  v_needed_order_feet := greatest(v_missing_feet - v_on_the_way_feet, 0);

  select *
  into v_primary_order
  from app.film_orders fo
  where fo.org_id = p_org_id
    and upper(trim(coalesce(fo.job_number, ''))) = upper(trim(coalesce(v_requirement.job_number, '')))
    and coalesce(fo.status::text, '') = 'FILM_ORDER'
    and app_api.film_order_matches_requirement(
      p_org_id,
      fo.requirement_id,
      fo.manufacturer,
      fo.film_name,
      fo.width_in,
      v_requirement.id,
      v_requirement.manufacturer,
      v_requirement.film_name,
      v_requirement.width_in
    )
  order by fo.created_at asc, fo.film_order_id asc
  limit 1
  for update;

  if not found then
    return jsonb_build_object(
      'updated', false,
      'reason', 'NO_MATCHING_FILM_ORDER',
      'requirementId', v_requirement.id,
      'jobNumber', coalesce(v_requirement.job_number, ''),
      'missingFeet', v_missing_feet,
      'onTheWayFeet', v_on_the_way_feet,
      'neededOrderFeet', v_needed_order_feet
    );
  end if;

  v_primary_order.requirement_id := coalesce(v_primary_order.requirement_id, v_requirement.id);
  v_primary_order.requested_feet := v_needed_order_feet;
  v_primary_order.covered_feet := 0;
  v_primary_order.ordered_feet := 0;
  v_primary_order.remaining_to_order_feet := v_needed_order_feet;
  v_primary_order.resolved_at := null;
  v_primary_order.resolved_by := '';
  v_primary_order.notes := trim(
    coalesce(v_primary_order.notes, '') ||
    case when coalesce(v_primary_order.notes, '') = '' then '' else ' ' end ||
    format('Reconciled after box check-in; needed LF is now %s.', v_needed_order_feet)
  );

  if v_needed_order_feet = 0 then
    v_primary_order.status := 'FULFILLED';
    v_primary_order.resolved_at := timezone('utc', now());
    v_primary_order.resolved_by := app_api.trim_text(p_actor);
  else
    v_primary_order.status := 'FILM_ORDER';
  end if;

  v_primary_order := app_api.save_film_order(v_primary_order);

  return jsonb_build_object(
    'updated', true,
    'filmOrderId', coalesce(v_primary_order.film_order_id, ''),
    'requirementId', v_requirement.id,
    'jobNumber', coalesce(v_requirement.job_number, ''),
    'missingFeet', v_missing_feet,
    'onTheWayFeet', v_on_the_way_feet,
    'neededOrderFeet', v_needed_order_feet
  );
end;
$$;

create or replace function app_api.reconcile_box_checkin_allocations(
  p_org_id uuid,
  p_actor text,
  p_box_id text,
  p_physical_feet_after integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_box app.boxes;
  v_allocation app.allocations;
  v_requirement app.job_requirements;
  v_remaining_feet integer := 0;
  v_next_allocated_feet integer := 0;
  v_next_covered_feet integer := 0;
  v_cancelled_count integer := 0;
  v_reduced_count integer := 0;
  v_active_reserved_feet integer := 0;
  v_active_stored_feet integer := 0;
  v_feet_available integer := 0;
  v_requirement_ids uuid[] := array[]::uuid[];
  v_film_order_ids text[] := array[]::text[];
  v_affected_job_numbers text[] := array[]::text[];
  v_reduced_allocation_ids text[] := array[]::text[];
  v_cancelled_allocation_ids text[] := array[]::text[];
  v_updated_film_order_ids text[] := array[]::text[];
  v_requirement_id uuid;
  v_film_order_id text;
  v_order_result jsonb;
  v_warnings text[] := array[]::text[];
begin
  if p_physical_feet_after is null or p_physical_feet_after < 0 then
    perform app_api.raise_http(400, 'Physical feet after check-in must be zero or greater.');
  end if;

  select *
  into v_box
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = app_api.trim_text(p_box_id)
  for update;

  if not found then
    perform app_api.raise_http(404, 'Box not found.');
  end if;

  v_remaining_feet := greatest(coalesce(p_physical_feet_after, 0), 0);

  for v_allocation in
    select a.*
    from app.allocations a
    where a.org_id = p_org_id
      and a.box_id = v_box.box_id
      and a.status = 'ACTIVE'
      and app_api.film_allocation_reserves_capacity(a, 'IN_STOCK')
    order by a.created_at asc, a.allocation_id asc
    for update
  loop
    v_requirement := null;
    if v_allocation.requirement_id is not null then
      select *
      into v_requirement
      from app.job_requirements r
      where r.org_id = p_org_id
        and r.id = v_allocation.requirement_id;
    end if;

    if v_remaining_feet >= coalesce(v_allocation.allocated_feet, 0) then
      v_remaining_feet := v_remaining_feet - greatest(coalesce(v_allocation.allocated_feet, 0), 0);
      continue;
    end if;

    v_requirement_ids := array_append(v_requirement_ids, v_allocation.requirement_id);
    v_film_order_ids := array_append(v_film_order_ids, app_api.trim_text(v_allocation.film_order_id));
    if app_api.trim_text(v_allocation.job_number) <> '' then
      v_affected_job_numbers := array_append(v_affected_job_numbers, app_api.trim_text(v_allocation.job_number));
    end if;

    if v_remaining_feet > 0 then
      v_next_allocated_feet := v_remaining_feet;
      v_next_covered_feet := app_api.compute_covered_feet_from_allocation(
        v_next_allocated_feet,
        v_box.width_in,
        coalesce(v_requirement.width_in, v_box.width_in),
        coalesce(nullif(v_allocation.covered_feet, 0), v_allocation.allocated_feet)
      );

      update app.allocations
      set allocated_feet = v_next_allocated_feet,
          covered_feet = v_next_covered_feet,
          notes = trim(
            coalesce(notes, '') ||
            case when coalesce(notes, '') = '' then '' else ' ' end ||
            format('Reduced from %s LF to %s LF during box check-in reconciliation.', v_allocation.allocated_feet, v_next_allocated_feet)
          )
      where org_id = p_org_id
        and allocation_id = v_allocation.allocation_id;

      v_reduced_count := v_reduced_count + 1;
      v_reduced_allocation_ids := array_append(v_reduced_allocation_ids, v_allocation.allocation_id);
      v_warnings := app_api.push_warning(
        v_warnings,
        format(
          'Reduced allocation %s for job %s from %s LF to %s LF because box %s physically returned with less LF.',
          v_allocation.allocation_id,
          coalesce(nullif(v_allocation.job_number, ''), 'UNKNOWN'),
          v_allocation.allocated_feet,
          v_next_allocated_feet,
          v_box.box_id
        )
      );
      v_remaining_feet := 0;
    else
      update app.allocations
      set status = 'CANCELLED',
          resolved_at = timezone('utc', now()),
          resolved_by = app_api.trim_text(p_actor),
          notes = trim(
            coalesce(notes, '') ||
            case when coalesce(notes, '') = '' then '' else ' ' end ||
            format('Cancelled during box check-in reconciliation because box %s has no remaining physical LF for this reservation.', v_box.box_id)
          )
      where org_id = p_org_id
        and allocation_id = v_allocation.allocation_id;

      v_cancelled_count := v_cancelled_count + 1;
      v_cancelled_allocation_ids := array_append(v_cancelled_allocation_ids, v_allocation.allocation_id);
      v_warnings := app_api.push_warning(
        v_warnings,
        format(
          'Cancelled allocation %s for job %s because box %s no longer has enough physical LF.',
          v_allocation.allocation_id,
          coalesce(nullif(v_allocation.job_number, ''), 'UNKNOWN'),
          v_box.box_id
        )
      );
    end if;
  end loop;

  select
    coalesce(sum(a.allocated_feet) filter (where app_api.film_allocation_reserves_capacity(a, 'IN_STOCK')), 0)::integer,
    coalesce(sum(a.allocated_feet) filter (where app_api.film_allocation_consumes_stored_capacity(a, 'IN_STOCK')), 0)::integer
  into v_active_reserved_feet, v_active_stored_feet
  from app.allocations a
  where a.org_id = p_org_id
    and a.box_id = v_box.box_id
    and a.status = 'ACTIVE';

  if v_active_reserved_feet > greatest(coalesce(p_physical_feet_after, 0), 0) then
    perform app_api.raise_http(500, 'Box check-in reconciliation failed to reduce active allocations below physical LF.');
  end if;

  v_feet_available := greatest(coalesce(p_physical_feet_after, 0) - v_active_stored_feet, 0);

  foreach v_film_order_id in array coalesce(v_film_order_ids, array[]::text[]) loop
    v_film_order_id := app_api.trim_text(v_film_order_id);
    if v_film_order_id <> '' and not v_film_order_id = any(v_updated_film_order_ids) then
      perform app_api.recalculate_film_order(p_org_id, v_film_order_id, p_actor);
      v_updated_film_order_ids := array_append(v_updated_film_order_ids, v_film_order_id);
    end if;
  end loop;

  foreach v_requirement_id in array coalesce(v_requirement_ids, array[]::uuid[]) loop
    if v_requirement_id is not null then
      v_order_result := app_api.reconcile_existing_film_order_need_for_requirement(
        p_org_id,
        p_actor,
        v_requirement_id
      );
      if coalesce((v_order_result->>'filmOrderId'), '') <> ''
        and not (v_order_result->>'filmOrderId') = any(v_updated_film_order_ids) then
        v_updated_film_order_ids := array_append(v_updated_film_order_ids, v_order_result->>'filmOrderId');
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'boxId', v_box.box_id,
    'physicalFeetAfter', greatest(coalesce(p_physical_feet_after, 0), 0),
    'activeReservedFeet', v_active_reserved_feet,
    'activeStoredFeet', v_active_stored_feet,
    'feetAvailable', v_feet_available,
    'reducedCount', v_reduced_count,
    'cancelledCount', v_cancelled_count,
    'reducedAllocationIds', to_jsonb(array(select distinct unnest(v_reduced_allocation_ids))),
    'cancelledAllocationIds', to_jsonb(array(select distinct unnest(v_cancelled_allocation_ids))),
    'affectedJobNumbers', to_jsonb(array(select distinct unnest(v_affected_job_numbers))),
    'updatedFilmOrderIds', to_jsonb(array(select distinct unnest(v_updated_film_order_ids))),
    'warnings', to_jsonb(v_warnings)
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
  v_requirement_id_text text := app_api.trim_text(p_payload->>'requirementId');
  v_requirement_id uuid := null;
  v_requirement app.job_requirements;
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

  if v_requirement_id_text <> '' then
    begin
      v_requirement_id := v_requirement_id_text::uuid;
    exception when invalid_text_representation then
      perform app_api.raise_http(400, 'RequirementID must be a valid UUID.');
    end;
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
  v_order.requirement_id := v_requirement_id;

  if v_order.job_id is not null then
    select *
    into v_job
    from app.jobs j
    where j.org_id = p_org_id
      and j.id = v_order.job_id
    limit 1;
  end if;

  if v_requirement_id is not null then
    select *
    into v_requirement
    from app.job_requirements r
    where r.org_id = p_org_id
      and r.id = v_requirement_id;

    if not found then
      perform app_api.raise_http(404, 'Job requirement was not found.');
    end if;

    if upper(trim(coalesce(v_requirement.job_number, ''))) <> upper(trim(v_order.job_number)) then
      perform app_api.raise_http(400, 'RequirementID must belong to the same job as the film order.');
    end if;

    if not app_api.film_order_matches_requirement(
      p_org_id,
      v_requirement_id,
      v_order.manufacturer,
      v_order.film_name,
      v_order.width_in,
      v_requirement.id,
      v_requirement.manufacturer,
      v_requirement.film_name,
      v_requirement.width_in
    ) then
      perform app_api.raise_http(400, 'Film order product and width must match the selected requirement.');
    end if;
  end if;

  if exists (
    select 1
    from app.film_orders fo
    where fo.org_id = p_org_id
      and upper(trim(fo.job_number)) = upper(trim(v_order.job_number))
      and coalesce(fo.status::text, '') in ('FILM_ORDER', 'FILM_ON_THE_WAY')
      and app_api.film_order_matches_requirement(
        p_org_id,
        fo.requirement_id,
        fo.manufacturer,
        fo.film_name,
        fo.width_in,
        v_order.requirement_id,
        v_order.manufacturer,
        v_order.film_name,
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

do $$
declare
  v_def text;
  v_base text;
  v_next text;
begin
  select pg_get_functiondef('public.api_boxes_set_status(uuid, text, jsonb)'::regprocedure)
  into v_def;
  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  v_next := replace(
    v_next,
    '  v_receipt_result jsonb := jsonb_build_object(''warnings'', ''[]''::jsonb);
  v_requires_first_return_calibration boolean := false;',
    '  v_receipt_result jsonb := jsonb_build_object(''warnings'', ''[]''::jsonb);
  v_reconciliation_result jsonb := jsonb_build_object(''warnings'', ''[]''::jsonb);
  v_requires_first_return_calibration boolean := false;'
  );

  v_next := replace(
    v_next,
    replace($old$
    if v_other_active_allocated_feet > v_physical_feet_after then
      perform app_api.raise_http(
        400,
        format(
          'Received physical LF cannot be lower than the box''s active allocated feet (%s).',
          v_other_active_allocated_feet
        )
      );
    end if;

    v_box.core_type := v_resolved_core_type;
    v_box.core_weight_lbs := v_resolved_core_weight;
    v_box.lf_weight_lbs_per_ft := v_resolved_lf_weight;
    v_box.feet_available := greatest(v_physical_feet_after - v_other_active_allocated_feet, 0);

    if v_same_job_active_allocation_count > 0 and v_checkout_job <> '' then
      v_same_job_release := app_api.cancel_active_allocations_for_box_job(
        p_org_id,
        v_box.box_id,
        v_checkout_job,
        p_actor,
        'Released during film box check-in.'
      );
      if coalesce((v_same_job_release->>'cancelledCount')::integer, 0) > 0 then
        v_warnings := app_api.push_warning(
          v_warnings,
          format(
            'Released %s active planning allocation%s totaling %s LF for job %s during check-in.',
            (v_same_job_release->>'cancelledCount')::integer,
            case when (v_same_job_release->>'cancelledCount')::integer = 1 then '' else 's' end,
            coalesce((v_same_job_release->>'cancelledFeet')::integer, 0),
            v_checkout_job
          )
        );
      end if;
    end if;
$old$, E'\r\n', E'\n'),
    replace($new$
    if v_same_job_active_allocation_count > 0 and v_checkout_job <> '' then
      v_same_job_release := app_api.cancel_active_allocations_for_box_job(
        p_org_id,
        v_box.box_id,
        v_checkout_job,
        p_actor,
        'Released during film box check-in.'
      );
      if coalesce((v_same_job_release->>'cancelledCount')::integer, 0) > 0 then
        v_warnings := app_api.push_warning(
          v_warnings,
          format(
            'Released %s active planning allocation%s totaling %s LF for job %s during check-in.',
            (v_same_job_release->>'cancelledCount')::integer,
            case when (v_same_job_release->>'cancelledCount')::integer = 1 then '' else 's' end,
            coalesce((v_same_job_release->>'cancelledFeet')::integer, 0),
            v_checkout_job
          )
        );
      end if;
    end if;

    v_reconciliation_result := app_api.reconcile_box_checkin_allocations(
      p_org_id,
      p_actor,
      v_box.box_id,
      v_physical_feet_after
    );
    if jsonb_typeof(coalesce(v_reconciliation_result->'warnings', '[]'::jsonb)) = 'array' then
      v_warnings := v_warnings || array(
        select jsonb_array_elements_text(coalesce(v_reconciliation_result->'warnings', '[]'::jsonb))
      );
    end if;

    v_box.core_type := v_resolved_core_type;
    v_box.core_weight_lbs := v_resolved_core_weight;
    v_box.lf_weight_lbs_per_ft := v_resolved_lf_weight;
    v_box.feet_available := coalesce(
      (v_reconciliation_result->>'feetAvailable')::integer,
      greatest(v_physical_feet_after, 0)
    );
$new$, E'\r\n', E'\n')
  );

  if v_next = v_base then
    if v_base like '%app_api.reconcile_box_checkin_allocations(%' then
      return;
    end if;

    raise exception 'api_boxes_set_status check-in reconciliation patch did not match expected snippets';
  end if;

  execute v_next;
end;
$$;
