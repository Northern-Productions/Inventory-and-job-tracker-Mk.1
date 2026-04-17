-- Mirror of supabase/migrations/20260416170000_film_allocation_lock_priority.sql
-- Keep backend and Supabase migration streams aligned for film allocation lock priority.

create or replace function app_api.total_active_allocated_feet_for_box(
  p_org_id uuid,
  p_box_id text
)
returns integer
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select coalesce(sum(a.allocated_feet), 0)::integer
  from app.allocations a
  where a.org_id = p_org_id
    and a.box_id = app_api.trim_text(p_box_id)
    and a.status = 'ACTIVE';
$$;

create or replace function app_api.locked_allocated_feet_for_box(
  p_org_id uuid,
  p_box_id text
)
returns integer
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select coalesce(sum(a.allocated_feet), 0)::integer
  from app.allocations a
  where a.org_id = p_org_id
    and a.box_id = app_api.trim_text(p_box_id)
    and a.status = 'ACTIVE'
    and a.job_date is not null;
$$;

create or replace function app_api.placeholder_allocated_feet_for_box(
  p_org_id uuid,
  p_box_id text
)
returns integer
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select coalesce(sum(a.allocated_feet), 0)::integer
  from app.allocations a
  where a.org_id = p_org_id
    and a.box_id = app_api.trim_text(p_box_id)
    and a.status = 'ACTIVE'
    and a.job_date is null;
$$;

create or replace function app_api.box_physical_feet_available(p_box app.boxes)
returns integer
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select
    case
      when upper(coalesce(p_box.status::text, '')) not in ('IN_STOCK', 'TRANSFER') then null
      when p_box.last_roll_weight_lbs is not null
        and p_box.core_weight_lbs is not null
        and p_box.lf_weight_lbs_per_ft is not null
        and p_box.lf_weight_lbs_per_ft > 0
      then app_api.derive_feet_available_from_roll_weight(
        p_box.last_roll_weight_lbs,
        p_box.core_weight_lbs,
        p_box.lf_weight_lbs_per_ft,
        p_box.initial_feet
      )
      else greatest(
        coalesce(p_box.feet_available, 0) + app_api.locked_allocated_feet_for_box(p_box.org_id, p_box.box_id),
        0
      )
    end::integer;
$$;

create or replace function app_api.box_allocatable_now_feet(p_box app.boxes)
returns integer
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select
    case
      when upper(coalesce(p_box.status::text, '')) in ('IN_STOCK', 'TRANSFER') then greatest(
        coalesce(app_api.box_physical_feet_available(p_box), 0)
          - app_api.locked_allocated_feet_for_box(p_box.org_id, p_box.box_id),
        0
      )
      when upper(coalesce(p_box.status::text, '')) = 'ORDERED' then greatest(
        coalesce(p_box.initial_feet, 0) - app_api.total_active_allocated_feet_for_box(p_box.org_id, p_box.box_id),
        0
      )
      else greatest(coalesce(p_box.feet_available, 0), 0)
    end::integer;
$$;

create or replace function app_api.recalculate_physical_box_allocatable_now(
  p_org_id uuid,
  p_box_id text,
  p_physical_feet_available integer default null
)
returns integer
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_box app.boxes;
  v_physical_feet integer := null;
  v_next_feet_available integer := 0;
begin
  select *
  into v_box
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = app_api.trim_text(p_box_id)
  for update;

  if not found then
    return 0;
  end if;

  if upper(coalesce(v_box.status::text, '')) not in ('IN_STOCK', 'TRANSFER') then
    return greatest(coalesce(v_box.feet_available, 0), 0);
  end if;

  v_physical_feet := coalesce(p_physical_feet_available, app_api.box_physical_feet_available(v_box), 0);
  v_next_feet_available := greatest(
    v_physical_feet - app_api.locked_allocated_feet_for_box(p_org_id, v_box.box_id),
    0
  );

  if coalesce(v_box.feet_available, 0) is distinct from v_next_feet_available then
    v_box.feet_available := v_next_feet_available;
    v_box := app_api.save_box(v_box);
  end if;

  return v_next_feet_available;
end;
$$;

create or replace function app_api.sync_active_job_schedule_allocations(
  p_org_id uuid,
  p_job_number text,
  p_install_date date,
  p_crew_leader text
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_allocation app.allocations;
  v_order app.film_orders;
  v_box app.boxes;
  v_box_id text;
  v_physical_feet_by_box jsonb := '{}'::jsonb;
  v_updated_allocation_count integer := 0;
  v_updated_film_order_count integer := 0;
begin
  for v_box_id in
    select distinct a.box_id
    from app.allocations a
    where a.org_id = p_org_id
      and upper(trim(a.job_number)) = upper(trim(app_api.trim_text(p_job_number)))
      and a.status = 'ACTIVE'
      and coalesce(trim(a.box_id), '') <> ''
  loop
    select *
    into v_box
    from app.boxes b
    where b.org_id = p_org_id
      and b.box_id = v_box_id
    for update;

    if found and upper(coalesce(v_box.status::text, '')) in ('IN_STOCK', 'TRANSFER') then
      v_physical_feet_by_box := jsonb_set(
        v_physical_feet_by_box,
        array[v_box_id],
        to_jsonb(coalesce(app_api.box_physical_feet_available(v_box), 0)),
        true
      );
    end if;
  end loop;

  for v_allocation in
    select *
    from app.allocations a
    where a.org_id = p_org_id
      and upper(trim(a.job_number)) = upper(trim(app_api.trim_text(p_job_number)))
      and a.status = 'ACTIVE'
    for update
  loop
    if v_allocation.job_date is distinct from p_install_date
      or coalesce(v_allocation.crew_leader, '') is distinct from coalesce(app_api.trim_text(p_crew_leader), '')
    then
      v_allocation.job_date := p_install_date;
      v_allocation.crew_leader := coalesce(app_api.trim_text(p_crew_leader), '');
      perform app_api.save_allocation(v_allocation);
      v_updated_allocation_count := v_updated_allocation_count + 1;
    end if;
  end loop;

  for v_order in
    select *
    from app.film_orders f
    where f.org_id = p_org_id
      and upper(trim(f.job_number)) = upper(trim(app_api.trim_text(p_job_number)))
      and f.status in ('FILM_ORDER', 'FILM_ON_THE_WAY')
    for update
  loop
    if v_order.job_date is distinct from p_install_date
      or coalesce(v_order.crew_leader, '') is distinct from coalesce(app_api.trim_text(p_crew_leader), '')
    then
      v_order.job_date := p_install_date;
      v_order.crew_leader := coalesce(app_api.trim_text(p_crew_leader), '');
      perform app_api.save_film_order(v_order);
      v_updated_film_order_count := v_updated_film_order_count + 1;
    end if;
  end loop;

  for v_box_id in
    select jsonb_object_keys(v_physical_feet_by_box)
  loop
    perform app_api.recalculate_physical_box_allocatable_now(
      p_org_id,
      v_box_id,
      coalesce((v_physical_feet_by_box->>v_box_id)::integer, 0)
    );
  end loop;

  return jsonb_build_object(
    'updatedAllocationCount', v_updated_allocation_count,
    'updatedFilmOrderCount', v_updated_film_order_count
  );
end;
$$;

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
declare
  v_job app.jobs;
  v_requirement record;
  v_primary_orphan app.film_orders;
  v_new_order app.film_orders;
  v_orphan_film_order_id text;
  v_orphan_film_order_ids text[] := array[]::text[];
  v_source_box_ids text[] := array[]::text[];
  v_source_box_id text := '';
  v_target_warehouse text := '';
  v_committed_requested_feet integer := 0;
  v_target_requested_feet integer := 0;
  v_target_orphan_requested_feet integer := 0;
  v_created_count integer := 0;
  v_updated_count integer := 0;
  v_deleted_count integer := 0;
  v_normalized_job_number text := app_api.trim_text(p_job_number);
  v_actor_name text := app_api.trim_text(p_actor);
begin
  if v_normalized_job_number = '' then
    return jsonb_build_object(
      'createdCount', 0,
      'updatedCount', 0,
      'deletedCount', 0
    );
  end if;

  select *
  into v_job
  from app.jobs j
  where j.org_id = p_org_id
    and upper(trim(j.job_number)) = upper(trim(v_normalized_job_number))
  limit 1;

  if not found then
    return jsonb_build_object(
      'createdCount', 0,
      'updatedCount', 0,
      'deletedCount', 0
    );
  end if;

  for v_requirement in
    with target_box_ids as (
      select distinct a.box_id
      from app.allocations a
      join app.boxes b
        on b.org_id = a.org_id
       and b.box_id = a.box_id
      where a.org_id = p_org_id
        and a.status = 'ACTIVE'
        and a.requirement_id is not null
        and upper(trim(a.job_number)) = upper(trim(v_normalized_job_number))
        and upper(coalesce(b.status::text, '')) in ('IN_STOCK', 'TRANSFER')
    ),
    reservation_allocations as (
      select
        a.allocation_id,
        a.box_id,
        a.job_number,
        a.job_date,
        a.allocated_feet,
        coalesce(a.covered_feet, a.allocated_feet) as stored_covered_feet,
        a.requirement_id,
        b.width_in as box_width_in,
        b.warehouse::text as box_warehouse,
        app_api.box_physical_feet_available(b) as physical_feet_available,
        coalesce(j.created_at, a.created_at) as job_created_at,
        a.created_at as allocation_created_at
      from app.allocations a
      join target_box_ids tb
        on tb.box_id = a.box_id
      join app.boxes b
        on b.org_id = a.org_id
       and b.box_id = a.box_id
      left join app.jobs j
        on j.org_id = a.org_id
       and upper(trim(j.job_number)) = upper(trim(a.job_number))
      where a.org_id = p_org_id
        and a.status = 'ACTIVE'
        and upper(coalesce(b.status::text, '')) in ('IN_STOCK', 'TRANSFER')
    ),
    reservation_snapshots as (
      select
        ra.*,
        greatest(
          least(
            ra.allocated_feet,
            greatest(
              coalesce(ra.physical_feet_available, 0)
              - coalesce(
                  sum(ra.allocated_feet) over (
                    partition by ra.box_id
                    order by
                      case when ra.job_date is null then 1 else 0 end,
                      ra.job_date asc nulls last,
                      ra.job_created_at asc,
                      ra.allocation_created_at asc,
                      ra.allocation_id asc
                    rows between unbounded preceding and 1 preceding
                  ),
                  0
                ),
              0
            )
          ),
          0
        )::integer as backed_physical_feet
      from reservation_allocations ra
    ),
    requirement_coverage as (
      select
        r.id as requirement_id,
        r.manufacturer,
        r.film_name,
        r.width_in,
        r.required_feet,
        coalesce(
          sum(
            case
              when rs.requirement_id = r.id then
                app_api.compute_covered_feet_from_allocation(
                  rs.backed_physical_feet,
                  rs.box_width_in,
                  r.width_in,
                  rs.stored_covered_feet
                )
              else 0
            end
          ),
          0
        )::integer as backed_covered_feet,
        array_remove(array_agg(distinct case when rs.requirement_id = r.id then rs.box_id end), null) as source_box_ids,
        min(case when rs.requirement_id = r.id then rs.box_id end) as source_box_id,
        min(case when rs.requirement_id = r.id then rs.box_warehouse end) as source_warehouse
      from app.job_requirements r
      left join reservation_snapshots rs
        on rs.requirement_id = r.id
       and upper(trim(rs.job_number)) = upper(trim(v_normalized_job_number))
      where r.org_id = p_org_id
        and r.job_id = v_job.id
      group by r.id, r.manufacturer, r.film_name, r.width_in, r.required_feet
    )
    select *
    from requirement_coverage
  loop
    v_source_box_ids := coalesce(v_requirement.source_box_ids, array[]::text[]);
    v_source_box_id := app_api.trim_text(v_requirement.source_box_id);

    if coalesce(array_length(v_source_box_ids, 1), 0) = 0 or v_source_box_id = '' then
      continue;
    end if;

    v_target_warehouse := coalesce(
      nullif(app_api.trim_text(v_requirement.source_warehouse), ''),
      v_job.warehouse::text
    );
    v_target_requested_feet := greatest(
      case
        when v_job.due_date is not null or coalesce(p_allow_placeholder_shortages, false)
          then coalesce(v_requirement.required_feet, 0) - coalesce(v_requirement.backed_covered_feet, 0)
        else 0
      end,
      0
    );

    select coalesce(sum(fo.requested_feet), 0)::integer
    into v_committed_requested_feet
    from app.film_orders fo
    where fo.org_id = p_org_id
      and upper(trim(fo.job_number)) = upper(trim(v_normalized_job_number))
      and fo.status in ('FILM_ORDER', 'FILM_ON_THE_WAY')
      and fo.source_box_id = any(v_source_box_ids)
      and upper(trim(fo.manufacturer)) = upper(trim(coalesce(v_requirement.manufacturer, '')))
      and upper(trim(fo.film_name)) = upper(trim(coalesce(v_requirement.film_name, '')))
      and coalesce(fo.width_in, 0) = coalesce(v_requirement.width_in, 0)
      and (
        exists (
          select 1
          from app.film_order_box_links l
          where l.org_id = fo.org_id
            and l.film_order_id = fo.film_order_id
        )
        or exists (
          select 1
          from app.allocations a
          where a.org_id = fo.org_id
            and a.film_order_id = fo.film_order_id
            and a.status <> 'CANCELLED'
        )
      );

    v_target_orphan_requested_feet := greatest(v_target_requested_feet - v_committed_requested_feet, 0);

    select coalesce(array_agg(fo.film_order_id order by fo.created_at asc, fo.film_order_id asc), array[]::text[])
    into v_orphan_film_order_ids
    from app.film_orders fo
    where fo.org_id = p_org_id
      and upper(trim(fo.job_number)) = upper(trim(v_normalized_job_number))
      and fo.status in ('FILM_ORDER', 'FILM_ON_THE_WAY')
      and fo.source_box_id = any(v_source_box_ids)
      and upper(trim(fo.manufacturer)) = upper(trim(coalesce(v_requirement.manufacturer, '')))
      and upper(trim(fo.film_name)) = upper(trim(coalesce(v_requirement.film_name, '')))
      and coalesce(fo.width_in, 0) = coalesce(v_requirement.width_in, 0)
      and not exists (
        select 1
        from app.film_order_box_links l
        where l.org_id = fo.org_id
          and l.film_order_id = fo.film_order_id
      )
      and not exists (
        select 1
        from app.allocations a
        where a.org_id = fo.org_id
          and a.film_order_id = fo.film_order_id
          and a.status <> 'CANCELLED'
      );

    v_primary_orphan := null;
    select fo.*
    into v_primary_orphan
    from app.film_orders fo
    where fo.org_id = p_org_id
      and upper(trim(fo.job_number)) = upper(trim(v_normalized_job_number))
      and fo.status in ('FILM_ORDER', 'FILM_ON_THE_WAY')
      and fo.source_box_id = any(v_source_box_ids)
      and upper(trim(fo.manufacturer)) = upper(trim(coalesce(v_requirement.manufacturer, '')))
      and upper(trim(fo.film_name)) = upper(trim(coalesce(v_requirement.film_name, '')))
      and coalesce(fo.width_in, 0) = coalesce(v_requirement.width_in, 0)
      and not exists (
        select 1
        from app.film_order_box_links l
        where l.org_id = fo.org_id
          and l.film_order_id = fo.film_order_id
      )
      and not exists (
        select 1
        from app.allocations a
        where a.org_id = fo.org_id
          and a.film_order_id = fo.film_order_id
          and a.status <> 'CANCELLED'
      )
    order by fo.created_at asc, fo.film_order_id asc
    limit 1;

    if v_target_orphan_requested_feet > 0 and app_api.trim_text(coalesce(v_primary_orphan.film_order_id, '')) <> '' then
      if v_primary_orphan.requested_feet is distinct from v_target_orphan_requested_feet
        or coalesce(v_primary_orphan.covered_feet, 0) <> 0
        or coalesce(v_primary_orphan.ordered_feet, 0) <> 0
        or v_primary_orphan.remaining_to_order_feet is distinct from v_target_orphan_requested_feet
        or v_primary_orphan.job_date is distinct from v_job.due_date
        or coalesce(v_primary_orphan.crew_leader, '') is distinct from coalesce(v_job.crew_leader, '')
        or coalesce(v_primary_orphan.status::text, '') is distinct from 'FILM_ORDER'
        or coalesce(v_primary_orphan.source_box_id, '') is distinct from v_source_box_id
        or coalesce(v_primary_orphan.warehouse::text, '') is distinct from v_target_warehouse
      then
        v_primary_orphan.job_id := v_job.id;
        v_primary_orphan.job_number := v_job.job_number;
        v_primary_orphan.warehouse := v_target_warehouse::app.warehouse;
        v_primary_orphan.manufacturer := v_requirement.manufacturer;
        v_primary_orphan.film_name := v_requirement.film_name;
        v_primary_orphan.width_in := v_requirement.width_in;
        v_primary_orphan.requested_feet := v_target_orphan_requested_feet;
        v_primary_orphan.covered_feet := 0;
        v_primary_orphan.ordered_feet := 0;
        v_primary_orphan.remaining_to_order_feet := v_target_orphan_requested_feet;
        v_primary_orphan.job_date := v_job.due_date;
        v_primary_orphan.crew_leader := coalesce(v_job.crew_leader, '');
        v_primary_orphan.status := 'FILM_ORDER';
        v_primary_orphan.source_box_id := v_source_box_id;
        v_primary_orphan.resolved_at := null;
        v_primary_orphan.resolved_by := '';
        perform app_api.save_film_order(v_primary_orphan);
        v_updated_count := v_updated_count + 1;
      end if;
    elsif v_target_orphan_requested_feet > 0 then
      v_new_order := null;
      v_new_order.org_id := p_org_id;
      v_new_order.film_order_id := app_api.create_log_id();
      v_new_order.job_id := v_job.id;
      v_new_order.job_number := v_job.job_number;
      v_new_order.warehouse := v_target_warehouse::app.warehouse;
      v_new_order.manufacturer := v_requirement.manufacturer;
      v_new_order.film_name := v_requirement.film_name;
      v_new_order.width_in := v_requirement.width_in;
      v_new_order.requested_feet := v_target_orphan_requested_feet;
      v_new_order.covered_feet := 0;
      v_new_order.ordered_feet := 0;
      v_new_order.remaining_to_order_feet := v_target_orphan_requested_feet;
      v_new_order.job_date := v_job.due_date;
      v_new_order.crew_leader := coalesce(v_job.crew_leader, '');
      v_new_order.status := 'FILM_ORDER';
      v_new_order.source_box_id := v_source_box_id;
      v_new_order.resolved_at := null;
      v_new_order.resolved_by := '';
      v_new_order.notes := format(
        'Created from a shortage while reconciling reserved film for job %s.',
        v_job.job_number
      );
      v_new_order.created_at := now();
      v_new_order.created_by := v_actor_name;
      perform app_api.save_film_order(v_new_order);
      v_created_count := v_created_count + 1;
    end if;

    foreach v_orphan_film_order_id in array coalesce(v_orphan_film_order_ids, array[]::text[])
    loop
      if v_target_orphan_requested_feet > 0
        and v_orphan_film_order_id = app_api.trim_text(coalesce(v_primary_orphan.film_order_id, ''))
      then
        continue;
      end if;

      perform app_api.delete_film_order_links_by_film_order_id(p_org_id, v_orphan_film_order_id);
      perform app_api.delete_film_order(p_org_id, v_orphan_film_order_id);
      v_deleted_count := v_deleted_count + 1;
    end loop;
  end loop;

  return jsonb_build_object(
    'createdCount', v_created_count,
    'updatedCount', v_updated_count,
    'deletedCount', v_deleted_count
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
declare
  v_job_number text;
  v_result jsonb := jsonb_build_object(
    'createdCount', 0,
    'updatedCount', 0,
    'deletedCount', 0
  );
  v_job_result jsonb;
begin
  for v_job_number in
    select distinct a.job_number
    from app.allocations a
    join app.boxes b
      on b.org_id = a.org_id
     and b.box_id = a.box_id
    where a.org_id = p_org_id
      and a.box_id = app_api.trim_text(p_box_id)
      and a.status = 'ACTIVE'
      and upper(coalesce(b.status::text, '')) in ('IN_STOCK', 'TRANSFER')
  loop
    v_job_result := app_api.reconcile_auto_shortage_film_orders_for_job(
      p_org_id,
      p_actor,
      v_job_number,
      p_allow_placeholder_shortages
    );
    v_result := jsonb_build_object(
      'createdCount', coalesce((v_result->>'createdCount')::integer, 0) + coalesce((v_job_result->>'createdCount')::integer, 0),
      'updatedCount', coalesce((v_result->>'updatedCount')::integer, 0) + coalesce((v_job_result->>'updatedCount')::integer, 0),
      'deletedCount', coalesce((v_result->>'deletedCount')::integer, 0) + coalesce((v_job_result->>'deletedCount')::integer, 0)
    );
  end loop;

  return v_result;
end;
$$;

create or replace function app_api.public_box_json(p_box app.boxes)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'boxId', coalesce(p_box.box_id, ''),
    'warehouse', coalesce(p_box.warehouse::text, ''),
    'manufacturer', coalesce(p_box.manufacturer, ''),
    'filmName', coalesce(p_box.film_name, ''),
    'widthIn', p_box.width_in,
    'initialFeet', p_box.initial_feet,
    'feetAvailable', app_api.box_allocatable_now_feet(p_box),
    'physicalFeetAvailable', app_api.box_physical_feet_available(p_box),
    'allocatableNowFeet', app_api.box_allocatable_now_feet(p_box),
    'allocatedWithInstallDateFeet', app_api.locked_allocated_feet_for_box(p_box.org_id, p_box.box_id),
    'allocatedWithoutInstallDateFeet', app_api.placeholder_allocated_feet_for_box(p_box.org_id, p_box.box_id),
    'allocationPlanningFeet', app_api.box_allocatable_now_feet(p_box),
    'lotRun', coalesce(p_box.lot_run, ''),
    'status', coalesce(p_box.status::text, 'ORDERED'),
    'orderDate', coalesce(to_char(p_box.order_date, 'YYYY-MM-DD'), ''),
    'receivedDate', coalesce(to_char(p_box.received_date, 'YYYY-MM-DD'), ''),
    'initialWeightLbs', p_box.initial_weight_lbs,
    'lastRollWeightLbs', p_box.last_roll_weight_lbs,
    'lastWeighedDate', coalesce(to_char(p_box.last_weighed_date, 'YYYY-MM-DD'), ''),
    'filmKey', upper(coalesce(p_box.film_key, '')),
    'coreType', coalesce(p_box.core_type, ''),
    'coreWeightLbs', p_box.core_weight_lbs,
    'lfWeightLbsPerFt', p_box.lf_weight_lbs_per_ft,
    'purchaseCost', p_box.purchase_cost,
    'pricePerLf', p_box.price_per_lf,
    'notes', coalesce(p_box.notes, ''),
    'hasEverBeenCheckedOut', p_box.has_ever_been_checked_out,
    'lastCheckoutJob', coalesce(p_box.last_checkout_job, ''),
    'lastCheckoutDate', coalesce(to_char(p_box.last_checkout_date, 'YYYY-MM-DD'), ''),
    'zeroedDate', coalesce(to_char(p_box.zeroed_date, 'YYYY-MM-DD'), ''),
    'zeroedReason', coalesce(p_box.zeroed_reason, ''),
    'zeroedBy', coalesce(p_box.zeroed_by, '')
  );
$$;

create or replace function app_api.public_box_read_json(p_box app.boxes)
returns jsonb
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select
    app_api.public_box_json(p_box)
    || jsonb_build_object(
      'activeAllocatedFeet',
      app_api.total_active_allocated_feet_for_box(p_box.org_id, p_box.box_id)
    );
$$;

with physical_box_backfill as (
  select
    b.id,
    greatest(
      case
        when upper(coalesce(b.status::text, '')) not in ('IN_STOCK', 'TRANSFER') then coalesce(b.feet_available, 0)
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
        else greatest(coalesce(b.feet_available, 0) + app_api.total_active_allocated_feet_for_box(b.org_id, b.box_id), 0)
      end
      - app_api.locked_allocated_feet_for_box(b.org_id, b.box_id),
      0
    )::integer as next_feet_available
  from app.boxes b
  where upper(coalesce(b.status::text, '')) in ('IN_STOCK', 'TRANSFER')
)
update app.boxes b
set feet_available = physical_box_backfill.next_feet_available
from physical_box_backfill
where b.id = physical_box_backfill.id
  and coalesce(b.feet_available, 0) is distinct from physical_box_backfill.next_feet_available;

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
  v_job_number text := app_api.trim_text(p_payload->>'jobNumber');
  v_install_date text := app_api.trim_text(coalesce(p_payload->>'installDate', p_payload->>'jobDate'));
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

  if v_install_date = '' and app_api.trim_text(v_result->>'filmOrderId') <> '' then
    perform app_api.delete_film_order_links_by_film_order_id(p_org_id, app_api.trim_text(v_result->>'filmOrderId'));
    perform app_api.delete_film_order(p_org_id, app_api.trim_text(v_result->>'filmOrderId'));
    v_result := jsonb_set(v_result, '{filmOrderId}', to_jsonb(''::text), true);
    v_warnings := array_append(
      v_warnings,
      'No shortage film order was created because this job does not have an install date yet.'
    );
  end if;

  if v_job_number <> '' then
    perform app_api.reconcile_auto_shortage_film_orders_for_job(
      p_org_id,
      p_actor,
      v_job_number,
      false
    );
  end if;

  v_result := jsonb_set(v_result, '{warnings}', to_jsonb(v_warnings), true);
  return v_result;
end;
$$;

create or replace function public.api_acl_jobs_update(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_existing_job app.jobs;
  v_updated_job app.jobs;
  v_result jsonb;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'write');

  select *
  into v_existing_job
  from app.jobs j
  where j.org_id = p_org_id
    and upper(trim(j.job_number)) = upper(trim(app_api.require_job_number_digits(p_payload->>'jobNumber', 'Job ID number')))
  limit 1;

  v_result := public.api_jobs_update(p_org_id, p_actor, p_payload);

  select *
  into v_updated_job
  from app.jobs j
  where j.org_id = p_org_id
    and upper(trim(j.job_number)) = upper(trim(app_api.require_job_number_digits(p_payload->>'jobNumber', 'Job ID number')))
  limit 1;

  if found and (
    v_existing_job.due_date is distinct from v_updated_job.due_date
    or coalesce(v_existing_job.crew_leader, '') is distinct from coalesce(v_updated_job.crew_leader, '')
  ) then
    perform app_api.sync_active_job_schedule_allocations(
      p_org_id,
      v_updated_job.job_number,
      v_updated_job.due_date,
      v_updated_job.crew_leader
    );
    perform app_api.reconcile_auto_shortage_film_orders_for_job(
      p_org_id,
      p_actor,
      v_updated_job.job_number,
      false
    );
  end if;

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
