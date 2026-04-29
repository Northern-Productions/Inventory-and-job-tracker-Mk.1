/**
 * PURPOSE:
 * Makes scoped AUTO_PLANNED reconciliation capacity-safe by treating all
 * out-of-scope box reservations as fixed commitments.
 *
 * AFFECTS:
 * app_api.reconcile_auto_planned_allocations, /jobs/create auto allocation,
 * manual allocation follow-up planning, and box mutation planner scopes.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * Supabase mirror migration, backend schema latest checks, smoke box
 * reconciliation script, and auto-planner migration tests.
 *
 * COMMON FAILURE MODES:
 * Scoped job planning reuses LF already reserved by another job, mutable
 * AUTO_PLANNED rows outside the scope get stolen, checked-out reservations are
 * treated as free capacity, or planner output leaves active reservations above
 * physical LF.
 */

do $$
declare
  v_definition text;
  v_next_definition text;
  v_old_capacity text := $snippet$
  update auto_planner_boxes bx
  set remaining = bx.capacity - coalesce((
    select sum(a.allocated_feet)::integer
    from app.allocations a
    where a.org_id = p_org_id
      and a.box_id = bx.box_id
      and app_api.film_allocation_reserves_capacity(a, bx.status)
      and coalesce(a.allocation_source::text, 'MANUAL') <> 'AUTO_PLANNED'
  ), 0)
  where bx.box_id is not null;

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
  where bx.box_id is not null;

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
        and app_api.film_allocation_reserves_capacity(a, bx.status)
        and (
          coalesce(a.allocation_source::text, 'MANUAL') <> 'AUTO_PLANNED'
          or upper(coalesce(bx.status, '')) = 'CHECKED_OUT'
        )
    ), 0) > bx.capacity;

  update auto_planner_boxes bx
  set skipped = true
  where not bx.skipped
    and coalesce((
      select sum(a.allocated_feet)::integer
      from app.allocations a
      where a.org_id = p_org_id
        and a.box_id = bx.box_id
        and app_api.film_allocation_reserves_capacity(a, bx.status)
        and (
          coalesce(a.allocation_source::text, 'MANUAL') <> 'AUTO_PLANNED'
          or upper(coalesce(bx.status, '')) = 'CHECKED_OUT'
        )
    ), 0) > bx.capacity;$snippet$;
  v_new_capacity text := $snippet$
  create temporary table if not exists auto_planner_fixed_box_commitments (
    box_id text primary key,
    fixed_reserved_feet integer not null default 0
  ) on commit drop;
  truncate auto_planner_fixed_box_commitments;

  insert into auto_planner_fixed_box_commitments (box_id, fixed_reserved_feet)
  select
    bx.box_id,
    coalesce(sum(a.allocated_feet), 0)::integer
  from auto_planner_boxes bx
  join app.boxes b
    on b.org_id = p_org_id
   and b.box_id = bx.box_id
  left join app.allocations a
    on a.org_id = p_org_id
   and a.box_id = bx.box_id
   and app_api.film_allocation_reserves_capacity(a, b.status::text)
  left join auto_planner_jobs scoped_job
    on scoped_job.job_id = a.job_id
    or upper(trim(scoped_job.job_number)) = upper(trim(a.job_number))
  where a.allocation_id is null
    or not (
      scoped_job.job_id is not null
      and coalesce(a.allocation_source::text, 'MANUAL') = 'AUTO_PLANNED'
      and upper(coalesce(b.status::text, '')) = 'IN_STOCK'
    )
  group by bx.box_id
  on conflict (box_id) do update
  set fixed_reserved_feet = excluded.fixed_reserved_feet
  where auto_planner_fixed_box_commitments.box_id = excluded.box_id;

  update auto_planner_boxes bx
  set remaining = bx.capacity - coalesce(f.fixed_reserved_feet, 0)
  from auto_planner_fixed_box_commitments f
  where bx.box_id = f.box_id
    and bx.box_id is not null;

  insert into auto_planner_warnings (message)
  select format('Skipped AUTO planning for box %s because fixed allocations outside this planner scope exceed physical capacity.', bx.box_id)
  from auto_planner_boxes bx
  join auto_planner_fixed_box_commitments f
    on f.box_id = bx.box_id
  where f.fixed_reserved_feet > bx.capacity;

  update auto_planner_boxes bx
  set skipped = true,
      remaining = greatest(remaining, 0)
  from auto_planner_fixed_box_commitments f
  where f.box_id = bx.box_id
    and f.fixed_reserved_feet > bx.capacity;$snippet$;
  v_old_declaration text := $snippet$  v_is_suppressed boolean := false;$snippet$;
  v_new_declaration text := $snippet$  v_is_suppressed boolean := false;
  v_capacity_violation text := '';$snippet$;
  v_old_invariant_anchor text := $snippet$    get diagnostics v_row_count = row_count;
    v_inserted_film := v_inserted_film + v_row_count;
  end loop;

  for v_req in
    select r.*, j.job_number, j.warehouse, j.created_at as job_created_at$snippet$;
  v_new_invariant_anchor text := $snippet$    get diagnostics v_row_count = row_count;
    v_inserted_film := v_inserted_film + v_row_count;
  end loop;

  select string_agg(
    format('%s reserved=%s physical=%s', q.box_id, q.reserved_feet, q.physical_feet),
    ', '
  )
  into v_capacity_violation
  from (
    select
      bx.box_id,
      app_api.reserved_film_allocated_feet_for_box(p_org_id, bx.box_id) as reserved_feet,
      app_api.box_physical_feet_available(b) as physical_feet
    from auto_planner_boxes bx
    join app.boxes b
      on b.org_id = p_org_id
     and b.box_id = bx.box_id
    where not bx.skipped
      and upper(coalesce(b.status::text, '')) in ('IN_STOCK', 'TRANSFER')
  ) q
  where q.physical_feet is not null
    and q.reserved_feet > q.physical_feet;

  if app_api.trim_text(v_capacity_violation) <> '' then
    perform app_api.raise_http(
      500,
      format('AUTO planner capacity invariant failed: %s', v_capacity_violation)
    );
  end if;

  for v_req in
    select r.*, j.job_number, j.warehouse, j.created_at as job_created_at$snippet$;
begin
  select pg_get_functiondef('app_api.reconcile_auto_planned_allocations(uuid, text, jsonb)'::regprocedure)
  into v_definition;

  if v_definition is null then
    raise exception 'app_api.reconcile_auto_planned_allocations(uuid, text, jsonb) was not found';
  end if;

  v_next_definition := v_definition;

  if position(v_new_declaration in v_next_definition) = 0 then
    if position(v_old_declaration in v_next_definition) = 0 then
      raise exception 'Expected auto planner declaration snippet was not found';
    end if;

    v_next_definition := replace(v_next_definition, v_old_declaration, v_new_declaration);
  end if;

  if position(v_new_capacity in v_next_definition) = 0 then
    if position(v_old_capacity in v_next_definition) = 0 then
      raise exception 'Expected scoped auto planner capacity snippet was not found';
    end if;

    v_next_definition := replace(v_next_definition, v_old_capacity, v_new_capacity);
  end if;

  if position(v_new_invariant_anchor in v_next_definition) = 0 then
    if position(v_old_invariant_anchor in v_next_definition) = 0 then
      raise exception 'Expected auto planner final film invariant anchor was not found';
    end if;

    v_next_definition := replace(v_next_definition, v_old_invariant_anchor, v_new_invariant_anchor);
  end if;

  if position(v_new_declaration in v_next_definition) = 0
    or position(v_new_capacity in v_next_definition) = 0
    or position(v_new_invariant_anchor in v_next_definition) = 0
    or position(v_old_capacity in v_next_definition) > 0
  then
    raise exception 'app_api.reconcile_auto_planned_allocations global capacity patch verification failed';
  end if;

  if v_next_definition <> v_definition then
    execute v_next_definition;
  end if;
end;
$$;
