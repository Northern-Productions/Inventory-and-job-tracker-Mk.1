/**
 * PURPOSE:
 * Prevents AUTO_PLANNED reconciliation from using install date priority to
 * reshuffle existing film reservations.
 *
 * AFFECTS:
 * app_api.reconcile_auto_planned_allocations, /jobs/update install-date edits,
 * box-scoped planner passes, and smoke box reconciliation verification.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * Supabase mirror migration, backend schema latest checks, planner migration
 * tests, and DEV smoke box check-in reconciliation output.
 *
 * COMMON FAILURE MODES:
 * Editing a later job's install date steals LF from an older reservation,
 * in-scope AUTO_PLANNED rows get reordered by due_date, or planner output
 * exceeds physical box capacity after preserving older reservations.
 */

do $$
declare
  v_definition text;
  v_next_definition text;
  v_old_job_order text := $snippet$
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
    loop$snippet$;
  v_new_job_order text := $snippet$
  for v_job in
    select j.*
    from auto_planner_jobs j
    order by
      coalesce((
        select min(a.created_at)
        from app.allocations a
        join app.boxes b
          on b.org_id = a.org_id
         and b.box_id = a.box_id
        where a.org_id = p_org_id
          and a.status = 'ACTIVE'
          and a.job_id = j.job_id
          and coalesce(a.allocation_source::text, 'MANUAL') = 'AUTO_PLANNED'
          and coalesce(a.allocation_kind::text, 'REQUIREMENT') = 'REQUIREMENT'
          and app_api.film_allocation_reserves_capacity(a, b.status::text)
      ), 'infinity'::timestamptz),
      coalesce((
        select min(a.allocation_id)
        from app.allocations a
        join app.boxes b
          on b.org_id = a.org_id
         and b.box_id = a.box_id
        where a.org_id = p_org_id
          and a.status = 'ACTIVE'
          and a.job_id = j.job_id
          and coalesce(a.allocation_source::text, 'MANUAL') = 'AUTO_PLANNED'
          and coalesce(a.allocation_kind::text, 'REQUIREMENT') = 'REQUIREMENT'
          and app_api.film_allocation_reserves_capacity(a, b.status::text)
      ), ''),
      j.created_at,
      j.job_number,
      j.job_id
  loop
    for v_req in
      select *
      from app.job_requirements r
      where r.org_id = p_org_id
        and r.job_id = v_job.job_id
      order by
        coalesce((
          select min(a.created_at)
          from app.allocations a
          join app.boxes b
            on b.org_id = a.org_id
           and b.box_id = a.box_id
          where a.org_id = p_org_id
            and a.status = 'ACTIVE'
            and a.job_id = v_job.job_id
            and a.requirement_id = r.id
            and coalesce(a.allocation_source::text, 'MANUAL') = 'AUTO_PLANNED'
            and coalesce(a.allocation_kind::text, 'REQUIREMENT') = 'REQUIREMENT'
            and app_api.film_allocation_reserves_capacity(a, b.status::text)
        ), 'infinity'::timestamptz),
        coalesce((
          select min(a.allocation_id)
          from app.allocations a
          join app.boxes b
            on b.org_id = a.org_id
           and b.box_id = a.box_id
          where a.org_id = p_org_id
            and a.status = 'ACTIVE'
            and a.job_id = v_job.job_id
            and a.requirement_id = r.id
            and coalesce(a.allocation_source::text, 'MANUAL') = 'AUTO_PLANNED'
            and coalesce(a.allocation_kind::text, 'REQUIREMENT') = 'REQUIREMENT'
            and app_api.film_allocation_reserves_capacity(a, b.status::text)
        ), ''),
        r.updated_at,
        r.id
    loop$snippet$;
begin
  select pg_get_functiondef('app_api.reconcile_auto_planned_allocations(uuid, text, jsonb)'::regprocedure)
  into v_definition;

  if v_definition is null then
    raise exception 'app_api.reconcile_auto_planned_allocations(uuid, text, jsonb) was not found';
  end if;

  v_next_definition := v_definition;

  if position(v_new_job_order in v_next_definition) = 0 then
    if position(v_old_job_order in v_next_definition) = 0 then
      raise exception 'Expected install-date auto planner job order snippet was not found';
    end if;

    v_next_definition := replace(v_next_definition, v_old_job_order, v_new_job_order);
  end if;

  if position(v_new_job_order in v_next_definition) = 0
    or position(v_old_job_order in v_next_definition) > 0
  then
    raise exception 'app_api.reconcile_auto_planned_allocations reservation-order patch verification failed';
  end if;

  if v_next_definition <> v_definition then
    execute v_next_definition;
  end if;
end;
$$;
