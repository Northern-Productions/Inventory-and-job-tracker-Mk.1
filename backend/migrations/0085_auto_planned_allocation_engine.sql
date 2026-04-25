/**
 * PURPOSE:
 * Adds the transactional AUTO_PLANNED reservation planner for film and caulk.
 *
 * AFFECTS:
 * Job material planning, stored allocation coverage, manual allocation capacity
 * guards, Supabase Edge parity, and mutation post-save reconciliation.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * supabase/migrations/20260425113000_auto_planned_allocation_engine.sql,
 * backend runtimeAutoAllocationPlanner, mutation trigger scopes, and readiness
 * coverage tests.
 *
 * COMMON FAILURE MODES:
 * Planner mutating manual rows, checked-out AUTO rows being changed, duplicate
 * AUTO reservations, negative capacity, or hidden film-order side effects.
 */

create or replace function app_api.film_box_planner_physical_capacity(p_box app.boxes)
returns integer
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select greatest(coalesce(app_api.box_physical_feet_available(p_box), 0), 0)::integer;
$$;

create or replace function app_api.active_film_allocated_feet_for_box(
  p_org_id uuid,
  p_box_id text,
  p_excluded_allocation_id text default ''
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
    and (
      app_api.trim_text(p_excluded_allocation_id) = ''
      or a.allocation_id <> app_api.trim_text(p_excluded_allocation_id)
    );
$$;

create or replace function app_api.assert_film_box_allocation_capacity(
  p_org_id uuid,
  p_box_id text,
  p_allocation_id text default ''
)
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_box app.boxes;
  v_capacity integer := 0;
  v_active_feet integer := 0;
begin
  select *
  into v_box
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = app_api.trim_text(p_box_id)
  for update;

  if not found then
    return;
  end if;

  if upper(coalesce(v_box.status::text, '')) in ('ZEROED', 'RETIRED') then
    return;
  end if;

  v_capacity := case
    when upper(coalesce(v_box.status::text, '')) = 'ORDERED' then greatest(coalesce(v_box.initial_feet, 0), 0)
    when upper(coalesce(v_box.status::text, '')) = 'CHECKED_OUT' then greatest(coalesce(v_box.initial_feet, 0), 0)
    else app_api.film_box_planner_physical_capacity(v_box)
  end;
  v_active_feet := app_api.active_film_allocated_feet_for_box(p_org_id, v_box.box_id);

  if v_active_feet > v_capacity then
    perform app_api.raise_http(
      409,
      format(
        'Box %s has %s LF allocated but only %s physical LF available.',
        v_box.box_id,
        v_active_feet,
        v_capacity
      )
    );
  end if;
end;
$$;

create or replace function app_api.save_allocation(p_allocation app.allocations)
returns app.allocations
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_row app.allocations;
begin
  insert into app.allocations (
    id,
    org_id,
    allocation_id,
    box_id,
    job_id,
    job_number,
    warehouse,
    job_date,
    allocated_feet,
    covered_feet,
    requirement_id,
    status,
    created_at,
    created_by,
    resolved_at,
    resolved_by,
    notes,
    crew_leader,
    film_order_id,
    allocation_kind,
    allocation_source
  )
  values (
    coalesce(p_allocation.id, gen_random_uuid()),
    p_allocation.org_id,
    p_allocation.allocation_id,
    p_allocation.box_id,
    p_allocation.job_id,
    p_allocation.job_number,
    p_allocation.warehouse,
    p_allocation.job_date,
    p_allocation.allocated_feet,
    coalesce(p_allocation.covered_feet, p_allocation.allocated_feet),
    p_allocation.requirement_id,
    p_allocation.status,
    coalesce(p_allocation.created_at, now()),
    coalesce(p_allocation.created_by, ''),
    p_allocation.resolved_at,
    coalesce(p_allocation.resolved_by, ''),
    coalesce(p_allocation.notes, ''),
    coalesce(p_allocation.crew_leader, ''),
    coalesce(p_allocation.film_order_id, ''),
    coalesce(p_allocation.allocation_kind, 'REQUIREMENT'::app.allocation_kind),
    coalesce(p_allocation.allocation_source, 'MANUAL'::app.allocation_source)
  )
  on conflict (org_id, allocation_id) do update set
    box_id = excluded.box_id,
    job_id = excluded.job_id,
    job_number = excluded.job_number,
    warehouse = excluded.warehouse,
    job_date = excluded.job_date,
    allocated_feet = excluded.allocated_feet,
    covered_feet = excluded.covered_feet,
    requirement_id = excluded.requirement_id,
    status = excluded.status,
    created_at = excluded.created_at,
    created_by = excluded.created_by,
    resolved_at = excluded.resolved_at,
    resolved_by = excluded.resolved_by,
    notes = excluded.notes,
    crew_leader = excluded.crew_leader,
    film_order_id = excluded.film_order_id,
    allocation_kind = excluded.allocation_kind,
    allocation_source = excluded.allocation_source
  returning * into v_row;

  if v_row.status = 'ACTIVE' then
    perform app_api.assert_film_box_allocation_capacity(v_row.org_id, v_row.box_id, v_row.allocation_id);
  end if;

  return v_row;
end;
$$;

create or replace function app_api.auto_planner_scope_job_numbers(
  p_org_id uuid,
  p_scope jsonb
)
returns table(job_number text)
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_has_scope boolean := false;
begin
  create temporary table if not exists auto_planner_scope_warehouses (
    warehouse text primary key
  ) on commit drop;
  truncate auto_planner_scope_warehouses;

  if jsonb_typeof(coalesce(p_scope->'jobNumbers', '[]'::jsonb)) = 'array' then
    v_has_scope := v_has_scope or jsonb_array_length(coalesce(p_scope->'jobNumbers', '[]'::jsonb)) > 0;
    insert into auto_planner_scope_warehouses (warehouse)
    select distinct upper(j.warehouse::text)
    from app.jobs j
    join jsonb_array_elements_text(coalesce(p_scope->'jobNumbers', '[]'::jsonb)) s(value)
      on upper(trim(j.job_number)) = upper(trim(s.value))
    where j.org_id = p_org_id
      and j.lifecycle_status = 'ACTIVE'
    on conflict do nothing;
  end if;

  if jsonb_typeof(coalesce(p_scope->'boxIds', '[]'::jsonb)) = 'array' then
    v_has_scope := v_has_scope or jsonb_array_length(coalesce(p_scope->'boxIds', '[]'::jsonb)) > 0;
    insert into auto_planner_scope_warehouses (warehouse)
    select distinct upper(b.warehouse::text)
    from app.boxes b
    join jsonb_array_elements_text(coalesce(p_scope->'boxIds', '[]'::jsonb)) s(value)
      on upper(trim(b.box_id)) = upper(trim(s.value))
    where b.org_id = p_org_id
    on conflict do nothing;
  end if;

  if jsonb_typeof(coalesce(p_scope->'caulkProductWarehousePairs', '[]'::jsonb)) = 'array' then
    v_has_scope := v_has_scope or jsonb_array_length(coalesce(p_scope->'caulkProductWarehousePairs', '[]'::jsonb)) > 0;
    insert into auto_planner_scope_warehouses (warehouse)
    select distinct upper(app_api.trim_text(value->>'warehouse'))
    from jsonb_array_elements(coalesce(p_scope->'caulkProductWarehousePairs', '[]'::jsonb))
    where app_api.trim_text(value->>'warehouse') <> ''
    on conflict do nothing;
  end if;

  if not v_has_scope then
    return query
    select j.job_number
    from app.jobs j
    where j.org_id = p_org_id
      and j.lifecycle_status = 'ACTIVE';
    return;
  end if;

  return query
  select distinct j.job_number
  from app.jobs j
  where j.org_id = p_org_id
    and j.lifecycle_status = 'ACTIVE'
    and (
      upper(j.warehouse::text) in (select warehouse from auto_planner_scope_warehouses)
      or exists (
        select 1
        from jsonb_array_elements_text(coalesce(p_scope->'jobNumbers', '[]'::jsonb)) s(value)
        where upper(trim(j.job_number)) = upper(trim(s.value))
      )
      or exists (
        select 1
        from app.allocations a
        join jsonb_array_elements_text(coalesce(p_scope->'boxIds', '[]'::jsonb)) b(value)
          on upper(trim(a.box_id)) = upper(trim(b.value))
        where a.org_id = p_org_id
          and a.status = 'ACTIVE'
          and upper(trim(a.job_number)) = upper(trim(j.job_number))
      )
    );
end;
$$;

create or replace function app_api.reconcile_auto_planned_allocations(
  p_org_id uuid,
  p_actor text,
  p_scope jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_actor text := coalesce(app_api.trim_text(p_actor), 'planner');
  v_now timestamptz := now();
  v_job record;
  v_req record;
  v_alloc record;
  v_box record;
  v_plan record;
  v_needed integer;
  v_existing_coverage integer;
  v_allocated integer;
  v_covered integer;
  v_remaining integer;
  v_cancelled_film integer := 0;
  v_inserted_film integer := 0;
  v_updated_film integer := 0;
  v_cancelled_caulk integer := 0;
  v_inserted_caulk integer := 0;
  v_updated_caulk integer := 0;
  v_warning_count integer := 0;
  v_row_count integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext('auto_planned_allocations'), hashtext(p_org_id::text));

  create temporary table if not exists auto_planner_warnings (
    message text
  ) on commit drop;
  truncate auto_planner_warnings;

  create temporary table if not exists auto_planner_jobs (
    job_id uuid primary key,
    job_number text not null,
    warehouse text not null,
    install_date date,
    crew_leader text not null default '',
    created_at timestamptz not null
  ) on commit drop;
  truncate auto_planner_jobs;

  create temporary table if not exists auto_planner_boxes (
    box_id text primary key,
    status text not null,
    capacity integer not null,
    remaining integer not null,
    skipped boolean not null default false
  ) on commit drop;
  truncate auto_planner_boxes;

  create temporary table if not exists auto_planner_desired_film (
    allocation_id text,
    job_id uuid not null,
    job_number text not null,
    box_id text not null,
    requirement_id uuid not null,
    allocated_feet integer not null,
    covered_feet integer not null,
    primary key (job_id, requirement_id, box_id)
  ) on commit drop;
  truncate auto_planner_desired_film;

  create temporary table if not exists auto_planner_desired_caulk (
    caulk_allocation_id text,
    job_id uuid not null,
    job_number text not null,
    requirement_id uuid not null,
    product_id uuid not null,
    warehouse text not null,
    allocated_tubes integer not null,
    primary key (job_id, requirement_id, product_id, warehouse)
  ) on commit drop;
  truncate auto_planner_desired_caulk;

  insert into auto_planner_jobs (job_id, job_number, warehouse, install_date, crew_leader, created_at)
  select j.id, j.job_number, upper(j.warehouse::text), j.due_date, coalesce(j.crew_leader, ''), j.created_at
  from app.jobs j
  join app_api.auto_planner_scope_job_numbers(p_org_id, coalesce(p_scope, '{}'::jsonb)) s
    on upper(trim(s.job_number)) = upper(trim(j.job_number))
  where j.org_id = p_org_id
    and j.lifecycle_status = 'ACTIVE'
  for update;

  insert into auto_planner_boxes (box_id, status, capacity, remaining, skipped)
  select
    b.box_id,
    upper(coalesce(b.status::text, '')),
    case
      when upper(coalesce(b.status::text, '')) = 'IN_STOCK'
      then app_api.film_box_planner_physical_capacity(b)
      else 0
    end,
    case
      when upper(coalesce(b.status::text, '')) = 'IN_STOCK'
      then app_api.film_box_planner_physical_capacity(b)
      else 0
    end,
    false
  from app.boxes b
  where b.org_id = p_org_id
    and (
      upper(coalesce(b.warehouse::text, '')) in (select warehouse from auto_planner_jobs)
      or exists (
        select 1
        from app.allocations a
        join auto_planner_jobs j
          on upper(trim(j.job_number)) = upper(trim(a.job_number))
        where a.org_id = p_org_id
          and a.box_id = b.box_id
          and a.status = 'ACTIVE'
      )
    )
  for update;

  update auto_planner_boxes bx
  set remaining = bx.capacity - coalesce((
    select sum(a.allocated_feet)::integer
    from app.allocations a
    where a.org_id = p_org_id
      and a.box_id = bx.box_id
      and a.status = 'ACTIVE'
      and coalesce(a.allocation_source::text, 'MANUAL') <> 'AUTO_PLANNED'
  ), 0);

  update auto_planner_boxes bx
  set remaining = bx.remaining - coalesce((
    select sum(a.allocated_feet)::integer
    from app.allocations a
    join app.boxes b
      on b.org_id = a.org_id
     and b.box_id = a.box_id
    where a.org_id = p_org_id
      and a.box_id = bx.box_id
      and a.status = 'ACTIVE'
      and coalesce(a.allocation_source::text, 'MANUAL') = 'AUTO_PLANNED'
      and upper(coalesce(b.status::text, '')) = 'CHECKED_OUT'
  ), 0);

  insert into auto_planner_warnings (message)
  select format('Skipped AUTO planning for box %s because existing hard/frozen allocations exceed physical capacity.', bx.box_id)
  from auto_planner_boxes bx
  where bx.remaining < 0;

  update auto_planner_boxes
  set skipped = true,
      remaining = greatest(remaining, 0)
  where remaining < 0;

  insert into auto_planner_warnings (message)
  select format('Skipped AUTO planning for box %s because existing active allocations exceed physical capacity.', bx.box_id)
  from auto_planner_boxes bx
  where not bx.skipped
    and coalesce((
      select sum(a.allocated_feet)::integer
      from app.allocations a
      where a.org_id = p_org_id
        and a.box_id = bx.box_id
        and a.status = 'ACTIVE'
    ), 0) > bx.capacity;

  update auto_planner_boxes bx
  set skipped = true
  where not bx.skipped
    and coalesce((
      select sum(a.allocated_feet)::integer
      from app.allocations a
      where a.org_id = p_org_id
        and a.box_id = bx.box_id
        and a.status = 'ACTIVE'
    ), 0) > bx.capacity;

  for v_job in
    select *
    from auto_planner_jobs
    order by
      case when install_date is null then 1 else 0 end,
      install_date nulls last,
      created_at,
      job_number,
      job_id
  loop
    for v_req in
      select *
      from app.job_requirements r
      where r.org_id = p_org_id
        and r.job_id = v_job.job_id
      order by r.updated_at, r.id
    loop
      select coalesce(sum(coalesce(a.covered_feet, a.allocated_feet)), 0)::integer
      into v_existing_coverage
      from app.allocations a
      join app.boxes b
        on b.org_id = a.org_id
       and b.box_id = a.box_id
      where a.org_id = p_org_id
        and a.status = 'ACTIVE'
        and a.job_id = v_job.job_id
        and a.requirement_id = v_req.id
        and a.allocation_kind = 'REQUIREMENT'
        and (
          coalesce(a.allocation_source::text, 'MANUAL') <> 'AUTO_PLANNED'
          or upper(coalesce(b.status::text, '')) = 'CHECKED_OUT'
        )
        and app_api.requirement_film_is_compatible(
          p_org_id,
          b.manufacturer,
          b.film_name,
          v_req.manufacturer,
          v_req.film_name
        )
        and b.width_in >= v_req.width_in
        and upper(coalesce(b.status::text, '')) not in ('ZEROED', 'RETIRED');

      v_needed := greatest(coalesce(v_req.required_feet, 0) - coalesce(v_existing_coverage, 0), 0);

      for v_alloc in
        select a.*, b.width_in
        from app.allocations a
        join app.boxes b
          on b.org_id = a.org_id
         and b.box_id = a.box_id
        join auto_planner_boxes bx
          on bx.box_id = a.box_id
        where a.org_id = p_org_id
          and a.status = 'ACTIVE'
          and a.job_id = v_job.job_id
          and a.requirement_id = v_req.id
          and coalesce(a.allocation_source::text, 'MANUAL') = 'AUTO_PLANNED'
          and a.allocation_kind = 'REQUIREMENT'
          and upper(coalesce(b.status::text, '')) = 'IN_STOCK'
          and not bx.skipped
          and app_api.requirement_film_is_compatible(
            p_org_id,
            b.manufacturer,
            b.film_name,
            v_req.manufacturer,
            v_req.film_name
          )
          and b.width_in >= v_req.width_in
        order by a.created_at, a.allocation_id
      loop
        exit when v_needed <= 0;

        select bx.remaining
        into v_remaining
        from auto_planner_boxes bx
        where bx.box_id = v_alloc.box_id
        for update;

        if v_remaining <= 0 then
          continue;
        end if;

        select p.allocated_feet, p.covered_feet
        into v_allocated, v_covered
        from app_api.plan_allocation_coverage(
          v_needed,
          least(v_remaining, v_alloc.allocated_feet),
          v_alloc.width_in,
          v_req.width_in
        ) p;

        if coalesce(v_allocated, 0) <= 0 or coalesce(v_covered, 0) <= 0 then
          continue;
        end if;

        insert into auto_planner_desired_film (
          allocation_id,
          job_id,
          job_number,
          box_id,
          requirement_id,
          allocated_feet,
          covered_feet
        )
        values (
          v_alloc.allocation_id,
          v_job.job_id,
          v_job.job_number,
          v_alloc.box_id,
          v_req.id,
          v_allocated,
          v_covered
        )
        on conflict (job_id, requirement_id, box_id) do update set
          allocated_feet = auto_planner_desired_film.allocated_feet + excluded.allocated_feet,
          covered_feet = auto_planner_desired_film.covered_feet + excluded.covered_feet;

        update auto_planner_boxes
        set remaining = remaining - v_allocated
        where box_id = v_alloc.box_id
          and remaining - v_allocated >= 0;

        v_needed := greatest(v_needed - v_covered, 0);
      end loop;

      for v_box in
        select b.*
        from app.boxes b
        join auto_planner_boxes bx
          on bx.box_id = b.box_id
        where b.org_id = p_org_id
          and upper(coalesce(b.status::text, '')) = 'IN_STOCK'
          and upper(coalesce(b.warehouse::text, '')) = v_job.warehouse
          and bx.remaining > 0
          and not bx.skipped
          and app_api.requirement_film_is_compatible(
            p_org_id,
            b.manufacturer,
            b.film_name,
            v_req.manufacturer,
            v_req.film_name
          )
          and b.width_in >= v_req.width_in
          and not exists (
            select 1
            from auto_planner_desired_film d
            where d.job_id = v_job.job_id
              and d.requirement_id = v_req.id
              and d.box_id = b.box_id
          )
        order by
          case when b.width_in = v_req.width_in then 0 else 1 end,
          b.width_in - v_req.width_in,
          coalesce(b.received_date, '9999-12-31'::date),
          b.box_id
      loop
        exit when v_needed <= 0;

        select bx.remaining
        into v_remaining
        from auto_planner_boxes bx
        where bx.box_id = v_box.box_id
        for update;

        if v_remaining <= 0 then
          continue;
        end if;

        select p.allocated_feet, p.covered_feet
        into v_allocated, v_covered
        from app_api.plan_allocation_coverage(
          v_needed,
          v_remaining,
          v_box.width_in,
          v_req.width_in
        ) p;

        if coalesce(v_allocated, 0) <= 0 or coalesce(v_covered, 0) <= 0 then
          continue;
        end if;

        insert into auto_planner_desired_film (
          allocation_id,
          job_id,
          job_number,
          box_id,
          requirement_id,
          allocated_feet,
          covered_feet
        )
        values (
          null,
          v_job.job_id,
          v_job.job_number,
          v_box.box_id,
          v_req.id,
          v_allocated,
          v_covered
        )
    on conflict (job_id, requirement_id, box_id) do nothing;

        get diagnostics v_row_count = row_count;
        if v_row_count > 0 then
          update auto_planner_boxes
          set remaining = remaining - v_allocated
          where box_id = v_box.box_id
            and remaining - v_allocated >= 0;
          get diagnostics v_row_count = row_count;
          if v_row_count = 0 then
            delete from auto_planner_desired_film
            where job_id = v_job.job_id
              and requirement_id = v_req.id
              and box_id = v_box.box_id;
            insert into auto_planner_warnings (message)
            values (format('Skipped AUTO planning for box %s because planner capacity would become negative.', v_box.box_id));
            continue;
          end if;
          v_needed := greatest(v_needed - v_covered, 0);
        end if;
      end loop;
    end loop;
  end loop;

  for v_alloc in
    select a.*
    from app.allocations a
    join auto_planner_jobs j
      on j.job_id = a.job_id
    left join app.boxes b
      on b.org_id = a.org_id
     and b.box_id = a.box_id
    left join auto_planner_desired_film d
      on d.allocation_id = a.allocation_id
    left join auto_planner_boxes bx
      on bx.box_id = a.box_id
    where a.org_id = p_org_id
      and a.status = 'ACTIVE'
      and coalesce(a.allocation_source::text, 'MANUAL') = 'AUTO_PLANNED'
      and coalesce(upper(b.status::text), '') <> 'CHECKED_OUT'
      and coalesce(bx.skipped, false) = false
      and d.allocation_id is null
  loop
    update app.allocations
    set status = 'CANCELLED',
        resolved_at = v_now,
        resolved_by = v_actor,
        notes = 'AUTO_PLANNED allocation cancelled by planner reconciliation.'
    where org_id = p_org_id
      and allocation_id = v_alloc.allocation_id;
    v_cancelled_film := v_cancelled_film + 1;
  end loop;

  for v_plan in
    select *
    from auto_planner_desired_film
    where allocation_id is not null
  loop
    update app.allocations
    set allocated_feet = v_plan.allocated_feet,
        covered_feet = v_plan.covered_feet,
        job_number = v_plan.job_number,
        notes = case
          when notes = '' then 'AUTO_PLANNED allocation maintained by planner reconciliation.'
          else notes
        end
    where org_id = p_org_id
      and allocation_id = v_plan.allocation_id
      and (
        allocated_feet is distinct from v_plan.allocated_feet
        or covered_feet is distinct from v_plan.covered_feet
        or job_number is distinct from v_plan.job_number
      );
    get diagnostics v_row_count = row_count;
    v_updated_film := v_updated_film + v_row_count;
  end loop;

  for v_plan in
    select *
    from auto_planner_desired_film
    where allocation_id is null
  loop
    insert into app.allocations (
      id,
      org_id,
      allocation_id,
      box_id,
      job_id,
      job_number,
      warehouse,
      job_date,
      allocated_feet,
      covered_feet,
      requirement_id,
      status,
      created_at,
      created_by,
      resolved_at,
      resolved_by,
      notes,
      crew_leader,
      film_order_id,
      allocation_kind,
      allocation_source
    )
    select
      gen_random_uuid(),
      p_org_id,
      app_api.create_log_id(),
      v_plan.box_id,
      v_plan.job_id,
      v_plan.job_number,
      b.warehouse,
      j.install_date,
      v_plan.allocated_feet,
      v_plan.covered_feet,
      v_plan.requirement_id,
      'ACTIVE',
      v_now,
      v_actor,
      null,
      '',
      'AUTO_PLANNED allocation created by planner reconciliation.',
      j.crew_leader,
      '',
      'REQUIREMENT',
      'AUTO_PLANNED'
    from app.boxes b
    join auto_planner_jobs j
      on j.job_id = v_plan.job_id
    where b.org_id = p_org_id
      and b.box_id = v_plan.box_id
      and not exists (
        select 1
        from app.allocations existing
        where existing.org_id = p_org_id
          and existing.status = 'ACTIVE'
          and coalesce(existing.allocation_source::text, 'MANUAL') = 'AUTO_PLANNED'
          and existing.job_id = v_plan.job_id
          and existing.requirement_id = v_plan.requirement_id
          and existing.box_id = v_plan.box_id
      );
    get diagnostics v_row_count = row_count;
    v_inserted_film := v_inserted_film + v_row_count;
  end loop;

  for v_req in
    select r.*, j.job_number, j.warehouse, j.created_at as job_created_at
    from app.job_caulk_requirements r
    join auto_planner_jobs j
      on j.job_id = r.job_id
    order by
      case when j.install_date is null then 1 else 0 end,
      j.install_date nulls last,
      j.created_at,
      j.job_number,
      r.id
  loop
    select coalesce(sum(a.allocated_tubes), 0)::integer
    into v_existing_coverage
    from app.caulk_job_allocations a
    where a.org_id = p_org_id
      and a.status = 'ACTIVE'
      and a.job_id = v_req.job_id
      and a.requirement_id = v_req.id
      and a.product_id = v_req.product_id
      and (
        coalesce(a.allocation_source::text, 'MANUAL') <> 'AUTO_PLANNED'
        or greatest(a.checked_out_tubes_total - a.returned_unused_tubes_total - a.used_tubes_total, 0) > 0
      );

    v_needed := greatest(coalesce(v_req.required_tubes, 0) - coalesce(v_existing_coverage, 0), 0);
    v_remaining := 0;

    select greatest(
      coalesce(s.tubes_on_hand, 0)
        - coalesce((
            select sum(a.allocated_tubes)::integer
            from app.caulk_job_allocations a
            where a.org_id = p_org_id
              and a.status = 'ACTIVE'
              and coalesce(a.allocation_source::text, 'MANUAL') = 'AUTO_PLANNED'
              and a.product_id = v_req.product_id
              and upper(a.warehouse) = upper(v_req.warehouse)
          ), 0),
      0
    )
    into v_remaining
    from app.caulk_stock s
    where s.org_id = p_org_id
      and s.product_id = v_req.product_id
      and upper(s.warehouse) = upper(v_req.warehouse)
    for update;

    v_remaining := coalesce(v_remaining, 0);

    if exists (
      select 1
      from app.caulk_stock s
      where s.org_id = p_org_id
        and s.product_id = v_req.product_id
        and upper(s.warehouse) = upper(v_req.warehouse)
        and coalesce((
          select sum(a.allocated_tubes)::integer
          from app.caulk_job_allocations a
          where a.org_id = p_org_id
            and a.status = 'ACTIVE'
            and coalesce(a.allocation_source::text, 'MANUAL') = 'AUTO_PLANNED'
            and a.product_id = v_req.product_id
            and upper(a.warehouse) = upper(v_req.warehouse)
        ), 0) > greatest(coalesce(s.tubes_on_hand, 0), 0)
    ) then
      insert into auto_planner_warnings (message)
      values (format('Skipped AUTO caulk planning for product %s in %s because existing active allocations exceed physical stock.', v_req.product_id, upper(v_req.warehouse)));
      continue;
    end if;

    for v_alloc in
      select *
      from app.caulk_job_allocations a
      where a.org_id = p_org_id
        and a.status = 'ACTIVE'
        and a.job_id = v_req.job_id
        and a.requirement_id = v_req.id
        and a.product_id = v_req.product_id
        and upper(a.warehouse) = upper(v_req.warehouse)
        and coalesce(a.allocation_source::text, 'MANUAL') = 'AUTO_PLANNED'
        and greatest(a.checked_out_tubes_total - a.returned_unused_tubes_total - a.used_tubes_total, 0) = 0
      order by a.created_at, a.caulk_allocation_id
    loop
      exit when v_needed <= 0;
      v_allocated := least(v_alloc.allocated_tubes, v_needed, greatest(v_remaining + v_alloc.allocated_tubes, 0));
      if v_allocated <= 0 then
        continue;
      end if;

      insert into auto_planner_desired_caulk (
        caulk_allocation_id,
        job_id,
        job_number,
        requirement_id,
        product_id,
        warehouse,
        allocated_tubes
      )
      values (
        v_alloc.caulk_allocation_id,
        v_req.job_id,
        v_req.job_number,
        v_req.id,
        v_req.product_id,
        upper(v_req.warehouse),
        v_allocated
      )
      on conflict (job_id, requirement_id, product_id, warehouse) do update set
        allocated_tubes = auto_planner_desired_caulk.allocated_tubes + excluded.allocated_tubes;

      v_needed := greatest(v_needed - v_allocated, 0);
      v_remaining := greatest(v_remaining - greatest(v_allocated - v_alloc.allocated_tubes, 0), 0);
    end loop;

    if v_needed > 0 and v_remaining > 0 then
      v_allocated := least(v_needed, v_remaining);
      insert into auto_planner_desired_caulk (
        caulk_allocation_id,
        job_id,
        job_number,
        requirement_id,
        product_id,
        warehouse,
        allocated_tubes
      )
      values (
        null,
        v_req.job_id,
        v_req.job_number,
        v_req.id,
        v_req.product_id,
        upper(v_req.warehouse),
        v_allocated
      )
      on conflict (job_id, requirement_id, product_id, warehouse) do nothing;
    end if;
  end loop;

  update app.caulk_job_allocations a
  set status = 'CANCELLED',
      resolved_at = v_now,
      resolved_by = v_actor,
      updated_at = v_now,
      updated_by = v_actor,
      notes = 'AUTO_PLANNED caulk allocation cancelled by planner reconciliation.'
  where a.org_id = p_org_id
    and exists (
      select 1
      from auto_planner_jobs j
      where j.job_id = a.job_id
    )
    and a.status = 'ACTIVE'
    and coalesce(a.allocation_source::text, 'MANUAL') = 'AUTO_PLANNED'
    and greatest(a.checked_out_tubes_total - a.returned_unused_tubes_total - a.used_tubes_total, 0) = 0
    and not exists (
      select 1
      from auto_planner_desired_caulk d
      where d.caulk_allocation_id = a.caulk_allocation_id
    );
  get diagnostics v_cancelled_caulk = row_count;

  update app.caulk_job_allocations a
  set allocated_tubes = d.allocated_tubes,
      reserved_tubes_remaining = d.allocated_tubes,
      updated_at = v_now,
      updated_by = v_actor,
      notes = case
        when a.notes = '' then 'AUTO_PLANNED caulk allocation maintained by planner reconciliation.'
        else a.notes
      end
  from auto_planner_desired_caulk d
  where a.org_id = p_org_id
    and a.caulk_allocation_id = d.caulk_allocation_id
    and d.caulk_allocation_id is not null
    and a.allocated_tubes is distinct from d.allocated_tubes;
  get diagnostics v_updated_caulk = row_count;

  insert into app.caulk_job_allocations (
    id,
    org_id,
    caulk_allocation_id,
    job_id,
    job_number,
    requirement_id,
    product_id,
    warehouse,
    allocated_tubes,
    reserved_tubes_remaining,
    checked_out_tubes_total,
    returned_unused_tubes_total,
    used_tubes_total,
    overage_tubes_total,
    status,
    created_at,
    created_by,
    updated_at,
    updated_by,
    allocation_source,
    notes
  )
  select
    gen_random_uuid(),
    p_org_id,
    app_api.create_log_id(),
    d.job_id,
    d.job_number,
    d.requirement_id,
    d.product_id,
    d.warehouse,
    d.allocated_tubes,
    d.allocated_tubes,
    0,
    0,
    0,
    0,
    'ACTIVE',
    v_now,
    v_actor,
    v_now,
    v_actor,
    'AUTO_PLANNED',
    'AUTO_PLANNED caulk allocation created by planner reconciliation.'
  from auto_planner_desired_caulk d
  where d.caulk_allocation_id is null
    and not exists (
      select 1
      from app.caulk_job_allocations existing
      where existing.org_id = p_org_id
        and existing.status = 'ACTIVE'
        and coalesce(existing.allocation_source::text, 'MANUAL') = 'AUTO_PLANNED'
        and existing.job_id = d.job_id
        and existing.requirement_id = d.requirement_id
        and existing.product_id = d.product_id
        and upper(existing.warehouse) = upper(d.warehouse)
    );
  get diagnostics v_inserted_caulk = row_count;

  for v_box in
    select distinct box_id
    from (
      select box_id from auto_planner_desired_film
      union
      select a.box_id
      from app.allocations a
      join auto_planner_jobs j
        on j.job_id = a.job_id
      where a.org_id = p_org_id
        and coalesce(a.allocation_source::text, 'MANUAL') = 'AUTO_PLANNED'
    ) affected
  loop
    perform app_api.recalculate_physical_box_allocatable_now(p_org_id, v_box.box_id);
  end loop;

  select count(*)::integer into v_warning_count from auto_planner_warnings;

  return jsonb_build_object(
    'filmInserted', v_inserted_film,
    'filmUpdated', v_updated_film,
    'filmCancelled', v_cancelled_film,
    'caulkInserted', v_inserted_caulk,
    'caulkUpdated', v_updated_caulk,
    'caulkCancelled', v_cancelled_caulk,
    'warnings', coalesce((select jsonb_agg(message) from auto_planner_warnings), '[]'::jsonb),
    'warningCount', v_warning_count
  );
end;
$$;

create or replace function public.api_acl_reconcile_auto_planned_allocations(
  p_org_id uuid,
  p_actor text,
  p_scope jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_org_member(p_org_id);
  return app_api.reconcile_auto_planned_allocations(p_org_id, p_actor, coalesce(p_scope, '{}'::jsonb));
end;
$$;

create or replace function public.api_acl_jobs_create(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_result jsonb;
  v_job_number text := '';
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'write');
  v_result := public.api_jobs_create(p_org_id, p_actor, p_payload);
  v_job_number := app_api.trim_text(v_result->>'jobNumber');

  if v_job_number <> '' then
    perform app_api.reconcile_auto_planned_allocations(
      p_org_id,
      p_actor,
      jsonb_build_object('jobNumbers', jsonb_build_array(v_job_number))
    );
  end if;

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
  v_job_number text := app_api.require_job_number_digits(p_payload->>'jobNumber', 'Job ID number');
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'write');

  select *
  into v_existing_job
  from app.jobs j
  where j.org_id = p_org_id
    and upper(trim(j.job_number)) = upper(trim(v_job_number))
  limit 1;

  v_result := public.api_jobs_update(p_org_id, p_actor, p_payload);

  select *
  into v_updated_job
  from app.jobs j
  where j.org_id = p_org_id
    and upper(trim(j.job_number)) = upper(trim(v_job_number))
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
  end if;

  perform app_api.reconcile_auto_planned_allocations(
    p_org_id,
    p_actor,
    jsonb_build_object('jobNumbers', jsonb_build_array(v_job_number))
  );

  return v_result;
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
  v_job_number text := app_api.trim_text(p_payload->>'jobNumber');
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
      v_box_ids := array_append(v_box_ids, v_box_id);
    end if;
  end loop;

  if v_job_number <> '' or coalesce(array_length(v_box_ids, 1), 0) > 0 then
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
  end if;

  perform app_api.reconcile_auto_planned_allocations(
    p_org_id,
    p_actor,
    jsonb_build_object('boxIds', jsonb_build_array(v_lookup_box_id))
  );

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
  end if;

  perform app_api.reconcile_auto_planned_allocations(
    p_org_id,
    p_actor,
    jsonb_build_object('boxIds', jsonb_build_array(v_lookup_box_id))
  );

  return v_result;
end;
$$;

select app_api.grant_execute_if_exists('public.api_acl_reconcile_auto_planned_allocations(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_reconcile_auto_planned_allocations(uuid, text, jsonb)', 'service_role');
