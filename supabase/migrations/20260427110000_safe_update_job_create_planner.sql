/**
 * PURPOSE:
 * Makes the /jobs/create database path compatible with safe-update enforcement
 * by adding explicit WHERE clauses to scoped upsert/update paths.
 *
 * AFFECTS:
 * POST /jobs/create, app_api.save_job duplicate-job upserts, and
 * AUTO_PLANNED allocation reconciliation for film and caulk requirements.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * public.api_acl_jobs_create, public.api_jobs_create, Supabase Edge
 * mutationHandlers /jobs/create, backend schema latest checks, and job
 * allocation planner tests.
 *
 * COMMON FAILURE MODES:
 * Safe-update rejection from unscoped UPDATEs, function drift causing a partial
 * hotfix, duplicate job upserts failing, or planner capacity recalculation
 * diverging between film and caulk allocations.
 */

do $$
declare
  v_save_job_definition text;
  v_next_save_job_definition text;
  v_save_job_unsafe_upsert text := $snippet$
  on conflict (org_id, job_number) do update set
    warehouse = excluded.warehouse,
    sections = excluded.sections,
    due_date = excluded.due_date,
    crew_leader = excluded.crew_leader,
    lifecycle_status = excluded.lifecycle_status,
    is_staged_for_pickup = excluded.is_staged_for_pickup,
    is_labor_only = excluded.is_labor_only,
    notes = excluded.notes,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by
  returning * into v_row;$snippet$;
  v_save_job_safe_upsert text := $snippet$
  on conflict (org_id, job_number) do update set
    warehouse = excluded.warehouse,
    sections = excluded.sections,
    due_date = excluded.due_date,
    crew_leader = excluded.crew_leader,
    lifecycle_status = excluded.lifecycle_status,
    is_staged_for_pickup = excluded.is_staged_for_pickup,
    is_labor_only = excluded.is_labor_only,
    notes = excluded.notes,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by
  where app.jobs.org_id = excluded.org_id
    and app.jobs.job_number = excluded.job_number
  returning * into v_row;$snippet$;

  v_planner_definition text;
  v_next_planner_definition text;
  v_planner_box_capacity_unsafe text := $snippet$
  update auto_planner_boxes bx
  set remaining = bx.capacity - coalesce((
    select sum(a.allocated_feet)::integer
    from app.allocations a
    where a.org_id = p_org_id
      and a.box_id = bx.box_id
      and app_api.film_allocation_reserves_capacity(a, bx.status)
      and coalesce(a.allocation_source::text, 'MANUAL') <> 'AUTO_PLANNED'
  ), 0);$snippet$;
  v_planner_box_capacity_safe text := $snippet$
  update auto_planner_boxes bx
  set remaining = bx.capacity - coalesce((
    select sum(a.allocated_feet)::integer
    from app.allocations a
    where a.org_id = p_org_id
      and a.box_id = bx.box_id
      and app_api.film_allocation_reserves_capacity(a, bx.status)
      and coalesce(a.allocation_source::text, 'MANUAL') <> 'AUTO_PLANNED'
  ), 0)
  where bx.box_id is not null;$snippet$;
  v_planner_checked_out_unsafe text := $snippet$
  update auto_planner_boxes bx
  set remaining = bx.remaining - coalesce((
    select sum(a.allocated_feet)::integer
    from app.allocations a
    join app.boxes b
      on b.org_id = a.org_id
     and b.box_id = a.box_id
    where a.org_id = p_org_id
      and a.box_id = bx.box_id
      and app_api.film_allocation_reserves_capacity(a, b.status::text)
      and coalesce(a.allocation_source::text, 'MANUAL') = 'AUTO_PLANNED'
      and upper(coalesce(b.status::text, '')) = 'CHECKED_OUT'
  ), 0);$snippet$;
  v_planner_checked_out_safe text := $snippet$
  update auto_planner_boxes bx
  set remaining = bx.remaining - coalesce((
    select sum(a.allocated_feet)::integer
    from app.allocations a
    join app.boxes b
      on b.org_id = a.org_id
     and b.box_id = a.box_id
    where a.org_id = p_org_id
      and a.box_id = bx.box_id
      and app_api.film_allocation_reserves_capacity(a, b.status::text)
      and coalesce(a.allocation_source::text, 'MANUAL') = 'AUTO_PLANNED'
      and upper(coalesce(b.status::text, '')) = 'CHECKED_OUT'
  ), 0)
  where bx.box_id is not null;$snippet$;
  v_planner_film_upsert_unsafe text := $snippet$
        on conflict (job_id, requirement_id, box_id) do update set
          allocated_feet = auto_planner_desired_film.allocated_feet + excluded.allocated_feet,
          covered_feet = auto_planner_desired_film.covered_feet + excluded.covered_feet;$snippet$;
  v_planner_film_upsert_safe text := $snippet$
        on conflict (job_id, requirement_id, box_id) do update set
          allocated_feet = auto_planner_desired_film.allocated_feet + excluded.allocated_feet,
          covered_feet = auto_planner_desired_film.covered_feet + excluded.covered_feet
        where auto_planner_desired_film.job_id = excluded.job_id
          and auto_planner_desired_film.requirement_id = excluded.requirement_id
          and auto_planner_desired_film.box_id = excluded.box_id;$snippet$;
  v_planner_caulk_upsert_unsafe text := $snippet$
      on conflict (job_id, requirement_id, product_id, warehouse) do update set
        allocated_tubes = auto_planner_desired_caulk.allocated_tubes + excluded.allocated_tubes;$snippet$;
  v_planner_caulk_upsert_safe text := $snippet$
      on conflict (job_id, requirement_id, product_id, warehouse) do update set
        allocated_tubes = auto_planner_desired_caulk.allocated_tubes + excluded.allocated_tubes
      where auto_planner_desired_caulk.job_id = excluded.job_id
        and auto_planner_desired_caulk.requirement_id = excluded.requirement_id
        and auto_planner_desired_caulk.product_id = excluded.product_id
        and auto_planner_desired_caulk.warehouse = excluded.warehouse;$snippet$;
begin
  select pg_get_functiondef('app_api.save_job(app.jobs)'::regprocedure)
  into v_save_job_definition;

  if v_save_job_definition is null then
    raise exception 'app_api.save_job(app.jobs) was not found';
  end if;

  v_next_save_job_definition := v_save_job_definition;
  if position(v_save_job_safe_upsert in v_next_save_job_definition) = 0 then
    if position(v_save_job_unsafe_upsert in v_next_save_job_definition) = 0 then
      raise exception 'Expected unsafe app_api.save_job upsert snippet was not found';
    end if;

    v_next_save_job_definition := replace(
      v_next_save_job_definition,
      v_save_job_unsafe_upsert,
      v_save_job_safe_upsert
    );
  end if;

  if position(v_save_job_safe_upsert in v_next_save_job_definition) = 0
    or position(v_save_job_unsafe_upsert in v_next_save_job_definition) > 0
  then
    raise exception 'app_api.save_job safe-update patch verification failed';
  end if;

  select pg_get_functiondef('app_api.reconcile_auto_planned_allocations(uuid, text, jsonb)'::regprocedure)
  into v_planner_definition;

  if v_planner_definition is null then
    raise exception 'app_api.reconcile_auto_planned_allocations(uuid, text, jsonb) was not found';
  end if;

  v_next_planner_definition := v_planner_definition;

  if position(v_planner_box_capacity_safe in v_next_planner_definition) = 0 then
    if position(v_planner_box_capacity_unsafe in v_next_planner_definition) = 0 then
      raise exception 'Expected unsafe planner capacity UPDATE snippet was not found';
    end if;

    v_next_planner_definition := replace(
      v_next_planner_definition,
      v_planner_box_capacity_unsafe,
      v_planner_box_capacity_safe
    );
  end if;

  if position(v_planner_checked_out_safe in v_next_planner_definition) = 0 then
    if position(v_planner_checked_out_unsafe in v_next_planner_definition) = 0 then
      raise exception 'Expected unsafe planner checked-out UPDATE snippet was not found';
    end if;

    v_next_planner_definition := replace(
      v_next_planner_definition,
      v_planner_checked_out_unsafe,
      v_planner_checked_out_safe
    );
  end if;

  if position(v_planner_film_upsert_safe in v_next_planner_definition) = 0 then
    if position(v_planner_film_upsert_unsafe in v_next_planner_definition) = 0 then
      raise exception 'Expected unsafe planner film upsert snippet was not found';
    end if;

    v_next_planner_definition := replace(
      v_next_planner_definition,
      v_planner_film_upsert_unsafe,
      v_planner_film_upsert_safe
    );
  end if;

  if position(v_planner_caulk_upsert_safe in v_next_planner_definition) = 0 then
    if position(v_planner_caulk_upsert_unsafe in v_next_planner_definition) = 0 then
      raise exception 'Expected unsafe planner caulk upsert snippet was not found';
    end if;

    v_next_planner_definition := replace(
      v_next_planner_definition,
      v_planner_caulk_upsert_unsafe,
      v_planner_caulk_upsert_safe
    );
  end if;

  if position(v_planner_box_capacity_safe in v_next_planner_definition) = 0
    or position(v_planner_checked_out_safe in v_next_planner_definition) = 0
    or position(v_planner_film_upsert_safe in v_next_planner_definition) = 0
    or position(v_planner_caulk_upsert_safe in v_next_planner_definition) = 0
    or position(v_planner_box_capacity_unsafe in v_next_planner_definition) > 0
    or position(v_planner_checked_out_unsafe in v_next_planner_definition) > 0
    or position(v_planner_film_upsert_unsafe in v_next_planner_definition) > 0
    or position(v_planner_caulk_upsert_unsafe in v_next_planner_definition) > 0
  then
    raise exception 'app_api.reconcile_auto_planned_allocations safe-update patch verification failed';
  end if;

  if v_next_save_job_definition <> v_save_job_definition then
    execute v_next_save_job_definition;
  end if;

  if v_next_planner_definition <> v_planner_definition then
    execute v_next_planner_definition;
  end if;
end;
$$;
