/**
 * PURPOSE:
 * Adds durable planner suppressions for user-removed AUTO_PLANNED rows.
 *
 * AFFECTS:
 * Job material planning, stored allocation coverage, manual allocation removal
 * flows, Supabase Edge parity, and mutation post-save reconciliation.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * supabase/migrations/20260425123000_planner_suppressions.sql, backend
 * runtimeAutoAllocationPlanner, remove allocation flows, and job requirement
 * payload mappers.
 *
 * COMMON FAILURE MODES:
 * Planner re-adding material the user removed, stale suppressions surviving a
 * true requirement edit, hidden film-order side effects, or lost Edge parity.
 */

create table if not exists app.allocation_planner_suppressions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations(id) on delete cascade,
  job_id uuid not null references app.jobs(id) on delete cascade,
  job_number text not null,
  material_type text not null check (material_type in ('FILM', 'CAULK')),
  requirement_id uuid,
  requirement_signature text not null,
  source_allocation_id text not null default '',
  source_inventory_id text not null default '',
  reason text not null default '',
  suppressed_at timestamptz not null default now(),
  suppressed_by text not null default '',
  cleared_at timestamptz,
  cleared_by text not null default '',
  cleared_reason text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_allocation_planner_suppressions_active_unique
  on app.allocation_planner_suppressions (org_id, job_id, material_type, requirement_signature)
  where cleared_at is null;

create index if not exists idx_allocation_planner_suppressions_org_job_active
  on app.allocation_planner_suppressions (org_id, job_id, material_type)
  where cleared_at is null;

create index if not exists idx_allocation_planner_suppressions_source_allocation
  on app.allocation_planner_suppressions (org_id, source_allocation_id)
  where cleared_at is null;

/**
 * PURPOSE:
 * Produces the durable identity used when a user pauses AUTO planning for a
 * film requirement.
 *
 * AFFECTS:
 * Planner suppression persistence, requirement replacement during job edits,
 * job detail autoPlanningSuppressed flags, and resume-auto-plan mutations.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * app_api.reconcile_auto_planned_allocations, public requirement read RPCs,
 * backend jobsRepository requirement queries, and FilmRequirementsSection UI.
 *
 * COMMON FAILURE MODES:
 * Suppressions clearing too early after requirement ID churn, or persisting
 * after the user truly changes manufacturer/film/width/required LF.
 */
create or replace function app_api.film_requirement_planner_signature(
  p_manufacturer text,
  p_film_name text,
  p_width_in numeric,
  p_required_feet integer
)
returns text
language sql
immutable
as $$
  select app_api.normalize_job_requirement_lookup_key(p_manufacturer, p_film_name, p_width_in)
    || '|' || greatest(coalesce(p_required_feet, 0), 0)::text;
$$;

create or replace function app_api.record_auto_planned_allocation_suppression(
  p_org_id uuid,
  p_actor text,
  p_allocation_id text,
  p_reason text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_actor text := coalesce(app_api.trim_text(p_actor), '');
  v_reason text := coalesce(nullif(app_api.trim_text(p_reason), ''), 'User removed AUTO_PLANNED allocation.');
  v_allocation app.allocations;
  v_job app.jobs;
  v_requirement app.job_requirements;
  v_signature text := '';
  v_source_inventory_id text := '';
begin
  select *
  into v_allocation
  from app.allocations a
  where a.org_id = p_org_id
    and a.allocation_id = app_api.trim_text(p_allocation_id)
  for update;

  if not found
    or coalesce(v_allocation.allocation_source::text, 'MANUAL') <> 'AUTO_PLANNED'
    or coalesce(v_allocation.allocation_kind::text, 'REQUIREMENT') <> 'REQUIREMENT'
    or v_allocation.requirement_id is null
    or v_allocation.job_id is null
  then
    return jsonb_build_object('suppressed', false);
  end if;

  select *
  into v_job
  from app.jobs j
  where j.org_id = p_org_id
    and j.id = v_allocation.job_id
  for update;

  select *
  into v_requirement
  from app.job_requirements r
  where r.org_id = p_org_id
    and r.job_id = v_allocation.job_id
    and r.id = v_allocation.requirement_id
  for update;

  if not found then
    return jsonb_build_object('suppressed', false);
  end if;

  v_signature := app_api.film_requirement_planner_signature(
    v_requirement.manufacturer,
    v_requirement.film_name,
    v_requirement.width_in,
    v_requirement.required_feet
  );
  v_source_inventory_id := app_api.trim_text(v_allocation.box_id);

  insert into app.allocation_planner_suppressions (
    org_id,
    job_id,
    job_number,
    material_type,
    requirement_id,
    requirement_signature,
    source_allocation_id,
    source_inventory_id,
    reason,
    suppressed_at,
    suppressed_by,
    updated_at
  )
  values (
    p_org_id,
    v_allocation.job_id,
    coalesce(v_job.job_number, v_allocation.job_number),
    'FILM',
    v_requirement.id,
    v_signature,
    v_allocation.allocation_id,
    v_source_inventory_id,
    v_reason,
    now(),
    v_actor,
    now()
  )
  on conflict (org_id, job_id, material_type, requirement_signature)
    where cleared_at is null
  do update set
    requirement_id = excluded.requirement_id,
    job_number = excluded.job_number,
    source_allocation_id = excluded.source_allocation_id,
    source_inventory_id = excluded.source_inventory_id,
    reason = excluded.reason,
    suppressed_at = excluded.suppressed_at,
    suppressed_by = excluded.suppressed_by,
    updated_at = excluded.updated_at;

  return jsonb_build_object(
    'suppressed', true,
    'jobNumber', coalesce(v_job.job_number, v_allocation.job_number),
    'requirementId', v_requirement.id,
    'sourceAllocationId', v_allocation.allocation_id,
    'sourceInventoryId', v_source_inventory_id
  );
end;
$$;

create or replace function app_api.clear_allocation_planner_suppression_for_requirement(
  p_org_id uuid,
  p_actor text,
  p_job_number text,
  p_requirement_id uuid,
  p_reason text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_actor text := coalesce(app_api.trim_text(p_actor), '');
  v_reason text := coalesce(nullif(app_api.trim_text(p_reason), ''), 'User resumed auto-planning for requirement.');
  v_job app.jobs;
  v_requirement app.job_requirements;
  v_signature text := '';
  v_cleared_count integer := 0;
begin
  select *
  into v_job
  from app.jobs j
  where j.org_id = p_org_id
    and upper(trim(j.job_number)) = upper(trim(p_job_number))
  for update;

  if not found then
    perform app_api.raise_http(404, format('Job %s was not found.', p_job_number));
  end if;

  select *
  into v_requirement
  from app.job_requirements r
  where r.org_id = p_org_id
    and r.job_id = v_job.id
    and r.id = p_requirement_id
  for update;

  if not found then
    perform app_api.raise_http(404, 'Film requirement was not found.');
  end if;

  v_signature := app_api.film_requirement_planner_signature(
    v_requirement.manufacturer,
    v_requirement.film_name,
    v_requirement.width_in,
    v_requirement.required_feet
  );

  update app.allocation_planner_suppressions
  set cleared_at = now(),
      cleared_by = v_actor,
      cleared_reason = v_reason,
      updated_at = now()
  where org_id = p_org_id
    and job_id = v_job.id
    and material_type = 'FILM'
    and requirement_signature = v_signature
    and cleared_at is null;
  get diagnostics v_cleared_count = row_count;

  return jsonb_build_object(
    'jobNumber', v_job.job_number,
    'requirementId', v_requirement.id,
    'clearedCount', v_cleared_count
  );
end;
$$;

create or replace function app_api.clear_stale_allocation_planner_suppressions_for_job(
  p_org_id uuid,
  p_actor text,
  p_job_id uuid,
  p_reason text default ''
)
returns integer
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_actor text := coalesce(app_api.trim_text(p_actor), '');
  v_reason text := coalesce(nullif(app_api.trim_text(p_reason), ''), 'Requirement changed; auto-planning may resume.');
  v_cleared_count integer := 0;
begin
  update app.allocation_planner_suppressions s
  set cleared_at = now(),
      cleared_by = v_actor,
      cleared_reason = v_reason,
      updated_at = now()
  where s.org_id = p_org_id
    and s.job_id = p_job_id
    and s.material_type = 'FILM'
    and s.cleared_at is null
    and not exists (
      select 1
      from app.job_requirements r
      where r.org_id = s.org_id
        and r.job_id = s.job_id
        and app_api.film_requirement_planner_signature(
          r.manufacturer,
          r.film_name,
          r.width_in,
          r.required_feet
        ) = s.requirement_signature
    );
  get diagnostics v_cleared_count = row_count;
  return v_cleared_count;
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
  v_is_suppressed boolean := false;
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

  create temporary table if not exists auto_planner_suppressed_film (
    job_id uuid not null,
    requirement_id uuid not null,
    requirement_signature text not null,
    primary key (job_id, requirement_id)
  ) on commit drop;
  truncate auto_planner_suppressed_film;

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

  update app.allocation_planner_suppressions s
  set requirement_id = r.id,
      job_number = j.job_number,
      updated_at = v_now
  from auto_planner_jobs j
  join app.job_requirements r
    on r.org_id = p_org_id
   and r.job_id = j.job_id
  where s.org_id = p_org_id
    and s.job_id = j.job_id
    and s.material_type = 'FILM'
    and s.cleared_at is null
    and app_api.film_requirement_planner_signature(
      r.manufacturer,
      r.film_name,
      r.width_in,
      r.required_feet
    ) = s.requirement_signature
    and (
      s.requirement_id is distinct from r.id
      or s.job_number is distinct from j.job_number
    );

  for v_job in
    select * from auto_planner_jobs
  loop
    perform app_api.clear_stale_allocation_planner_suppressions_for_job(
      p_org_id,
      v_actor,
      v_job.job_id,
      'Requirement changed; auto-planning may resume.'
    );
  end loop;

  insert into auto_planner_suppressed_film (job_id, requirement_id, requirement_signature)
  select distinct
    r.job_id,
    r.id,
    s.requirement_signature
  from app.allocation_planner_suppressions s
  join auto_planner_jobs j
    on j.job_id = s.job_id
  join app.job_requirements r
    on r.org_id = s.org_id
   and r.job_id = s.job_id
   and app_api.film_requirement_planner_signature(
     r.manufacturer,
     r.film_name,
     r.width_in,
     r.required_feet
   ) = s.requirement_signature
  where s.org_id = p_org_id
    and s.material_type = 'FILM'
    and s.cleared_at is null
  on conflict do nothing;

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
      select exists (
        select 1
        from auto_planner_suppressed_film s
        where s.job_id = v_job.job_id
          and s.requirement_id = v_req.id
      )
      into v_is_suppressed;

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

      if v_is_suppressed then
        continue;
      end if;

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

create or replace function public.api_acl_record_auto_planned_allocation_suppression(
  p_org_id uuid,
  p_actor text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'write');
  return app_api.record_auto_planned_allocation_suppression(
    p_org_id,
    p_actor,
    p_payload->>'allocationId',
    p_payload->>'reason'
  );
end;
$$;

create or replace function public.api_acl_clear_allocation_planner_suppression(
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
  v_job_number text := app_api.require_job_number_digits(p_payload->>'jobNumber', 'Job ID number');
  v_requirement_id uuid := nullif(app_api.trim_text(p_payload->>'requirementId'), '')::uuid;
  v_result jsonb;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'write');

  if v_requirement_id is null then
    perform app_api.raise_http(400, 'Requirement ID is required.');
  end if;

  v_result := app_api.clear_allocation_planner_suppression_for_requirement(
    p_org_id,
    p_actor,
    v_job_number,
    v_requirement_id,
    p_payload->>'reason'
  );

  perform app_api.reconcile_auto_planned_allocations(
    p_org_id,
    p_actor,
    jsonb_build_object('jobNumbers', jsonb_build_array(v_job_number))
  );

  return v_result;
end;
$$;

create or replace function public.api_list_job_requirements(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_result jsonb;
begin
  perform app_api.require_org_member(p_org_id);

  select coalesce(
    jsonb_agg(
      to_jsonb(q)
      order by q.job_number asc, q.manufacturer asc, q.film_name asc, q.width_in asc
    ),
    '[]'::jsonb
  )
  into v_result
  from (
    select
      r.*,
      j.job_number,
      exists (
        select 1
        from app.allocation_planner_suppressions s
        where s.org_id = r.org_id
          and s.job_id = r.job_id
          and s.material_type = 'FILM'
          and s.cleared_at is null
          and s.requirement_signature = app_api.film_requirement_planner_signature(
            r.manufacturer,
            r.film_name,
            r.width_in,
            r.required_feet
          )
      ) as auto_planning_suppressed
    from app.job_requirements r
    join app.jobs j on j.id = r.job_id
    where r.org_id = p_org_id
  ) q;

  return v_result;
end;
$$;

create or replace function public.api_list_job_requirements_by_job(
  p_org_id uuid,
  p_job_number text
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_result jsonb;
begin
  perform app_api.require_org_member(p_org_id);

  select coalesce(
    jsonb_agg(
      to_jsonb(q)
      order by q.manufacturer asc, q.film_name asc, q.width_in asc
    ),
    '[]'::jsonb
  )
  into v_result
  from (
    select
      r.*,
      j.job_number,
      exists (
        select 1
        from app.allocation_planner_suppressions s
        where s.org_id = r.org_id
          and s.job_id = r.job_id
          and s.material_type = 'FILM'
          and s.cleared_at is null
          and s.requirement_signature = app_api.film_requirement_planner_signature(
            r.manufacturer,
            r.film_name,
            r.width_in,
            r.required_feet
          )
      ) as auto_planning_suppressed
    from app.job_requirements r
    join app.jobs j on j.id = r.job_id
    where r.org_id = p_org_id
      and j.job_number = app_api.trim_text(p_job_number)
  ) q;

  return v_result;
end;
$$;

select app_api.grant_execute_if_exists('public.api_acl_record_auto_planned_allocation_suppression(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_record_auto_planned_allocation_suppression(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_clear_allocation_planner_suppression(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_clear_allocation_planner_suppression(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_list_job_requirements(uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_list_job_requirements_by_job(uuid, text)', 'authenticated');
