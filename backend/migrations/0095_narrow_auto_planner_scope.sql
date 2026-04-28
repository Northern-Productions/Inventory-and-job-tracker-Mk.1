/**
 * PURPOSE:
 * Narrows AUTO_PLANNED reconciliation for scoped job and box mutations without
 * changing allocation correctness or introducing asynchronous planning.
 *
 * AFFECTS:
 * public.api_acl_jobs_update, public.api_acl_allocations_apply,
 * public.api_acl_boxes_update, public.api_acl_boxes_set_status,
 * public.api_acl_allocations_remove_box, and job detail reload timing.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * Supabase mirror migration, Edge mutationHandlers SQL planner ownership,
 * backend runtimeAutoAllocationPlanner scope tests, and route timing logs for
 * jobs/create, jobs/update, boxes/update, boxes/set-status, and staged pickup.
 *
 * COMMON FAILURE MODES:
 * Replanning every active warehouse job, omitting compatible jobs for an
 * updated box, failing to cancel stale AUTO_PLANNED rows for scoped jobs, or
 * drifting from the mirrored Supabase migration.
 */

create index if not exists idx_jobs_org_upper_job_number_lifecycle
  on app.jobs (org_id, (upper(trim(job_number))), lifecycle_status);

create index if not exists idx_jobs_org_warehouse_lifecycle
  on app.jobs (org_id, warehouse, lifecycle_status);

create index if not exists idx_boxes_org_status_warehouse_film_width
  on app.boxes (org_id, status, warehouse, manufacturer, film_name, width_in);

create index if not exists idx_allocations_org_status_box_job
  on app.allocations (org_id, status, box_id, job_id);

create index if not exists idx_allocations_org_status_job_source
  on app.allocations (org_id, status, job_id, allocation_source);

create index if not exists idx_job_requirements_org_job_film_width
  on app.job_requirements (org_id, job_id, manufacturer, film_name, width_in);

create or replace function app_api.auto_planner_scope_job_numbers(
  p_org_id uuid,
  p_scope jsonb
)
returns table(job_number text)
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  create temporary table if not exists auto_planner_scope_jobs (
    job_number_key text primary key
  ) on commit drop;
  truncate auto_planner_scope_jobs;

  create temporary table if not exists auto_planner_scope_boxes (
    box_id text primary key,
    warehouse text not null,
    status text not null,
    manufacturer text not null,
    film_name text not null,
    width_in numeric not null
  ) on commit drop;
  truncate auto_planner_scope_boxes;

  create temporary table if not exists auto_planner_scope_caulk_pairs (
    product_id uuid not null,
    warehouse text not null,
    primary key (product_id, warehouse)
  ) on commit drop;
  truncate auto_planner_scope_caulk_pairs;

  insert into auto_planner_scope_jobs (job_number_key)
  select distinct upper(trim(value))
  from jsonb_array_elements_text(
    case
      when jsonb_typeof(coalesce(p_scope->'jobNumbers', '[]'::jsonb)) = 'array'
      then coalesce(p_scope->'jobNumbers', '[]'::jsonb)
      else '[]'::jsonb
    end
  ) s(value)
  where trim(value) <> ''
  on conflict do nothing;

  insert into auto_planner_scope_boxes (box_id, warehouse, status, manufacturer, film_name, width_in)
  select distinct
    b.box_id,
    upper(coalesce(b.warehouse::text, '')),
    upper(coalesce(b.status::text, '')),
    b.manufacturer,
    b.film_name,
    b.width_in
  from app.boxes b
  join jsonb_array_elements_text(
    case
      when jsonb_typeof(coalesce(p_scope->'boxIds', '[]'::jsonb)) = 'array'
      then coalesce(p_scope->'boxIds', '[]'::jsonb)
      else '[]'::jsonb
    end
  ) s(value)
    on upper(trim(b.box_id)) = upper(trim(s.value))
  where b.org_id = p_org_id
    and trim(s.value) <> ''
  on conflict do nothing;

  insert into auto_planner_scope_caulk_pairs (product_id, warehouse)
  select distinct
    (app_api.trim_text(value->>'productId'))::uuid,
    upper(app_api.trim_text(value->>'warehouse'))
  from jsonb_array_elements(
    case
      when jsonb_typeof(coalesce(p_scope->'caulkProductWarehousePairs', '[]'::jsonb)) = 'array'
      then coalesce(p_scope->'caulkProductWarehousePairs', '[]'::jsonb)
      else '[]'::jsonb
    end
  ) value
  where app_api.trim_text(value->>'productId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and app_api.trim_text(value->>'warehouse') <> ''
  on conflict do nothing;

  if not exists (select 1 from auto_planner_scope_jobs)
    and not exists (select 1 from auto_planner_scope_boxes)
    and not exists (select 1 from auto_planner_scope_caulk_pairs)
  then
    return query
    select j.job_number
    from app.jobs j
    where j.org_id = p_org_id
      and j.lifecycle_status = 'ACTIVE';
    return;
  end if;

  return query
  select distinct scoped.job_number
  from (
    select j.job_number
    from app.jobs j
    join auto_planner_scope_jobs s
      on upper(trim(j.job_number)) = s.job_number_key
    where j.org_id = p_org_id
      and j.lifecycle_status = 'ACTIVE'

    union

    select j.job_number
    from auto_planner_scope_boxes sb
    join app.allocations a
      on a.org_id = p_org_id
     and upper(trim(a.box_id)) = upper(trim(sb.box_id))
     and a.status = 'ACTIVE'
    join app.jobs j
      on j.org_id = a.org_id
     and j.lifecycle_status = 'ACTIVE'
     and (
       j.id = a.job_id
       or upper(trim(j.job_number)) = upper(trim(a.job_number))
     )

    union

    select j.job_number
    from auto_planner_scope_boxes sb
    join app.jobs j
      on j.org_id = p_org_id
     and j.lifecycle_status = 'ACTIVE'
     and upper(coalesce(j.warehouse::text, '')) = sb.warehouse
    join app.job_requirements r
      on r.org_id = p_org_id
     and r.job_id = j.id
    where sb.status = 'IN_STOCK'
      and sb.width_in >= r.width_in
      and app_api.requirement_film_is_compatible(
        p_org_id,
        sb.manufacturer,
        sb.film_name,
        r.manufacturer,
        r.film_name
      )

    union

    select j.job_number
    from auto_planner_scope_caulk_pairs sc
    join app.jobs j
      on j.org_id = p_org_id
     and j.lifecycle_status = 'ACTIVE'
     and upper(coalesce(j.warehouse::text, '')) = sc.warehouse
    join app.job_caulk_requirements r
      on r.org_id = p_org_id
     and r.job_id = j.id
     and r.product_id = sc.product_id
  ) scoped;
end;
$$;

do $$
declare
  v_definition text;
  v_next_definition text;
  v_old_box_scope text := $snippet$
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
  for update;$snippet$;
  v_new_box_scope text := $snippet$
  create temporary table if not exists auto_planner_explicit_job_scope (
    job_number_key text primary key
  ) on commit drop;
  truncate auto_planner_explicit_job_scope;

  create temporary table if not exists auto_planner_explicit_box_scope (
    box_id_key text primary key
  ) on commit drop;
  truncate auto_planner_explicit_box_scope;

  create temporary table if not exists auto_planner_explicit_caulk_scope (
    product_id uuid not null,
    warehouse text not null,
    primary key (product_id, warehouse)
  ) on commit drop;
  truncate auto_planner_explicit_caulk_scope;

  insert into auto_planner_explicit_job_scope (job_number_key)
  select distinct upper(trim(value))
  from jsonb_array_elements_text(
    case
      when jsonb_typeof(coalesce(p_scope->'jobNumbers', '[]'::jsonb)) = 'array'
      then coalesce(p_scope->'jobNumbers', '[]'::jsonb)
      else '[]'::jsonb
    end
  ) s(value)
  where trim(value) <> ''
  on conflict do nothing;

  insert into auto_planner_explicit_box_scope (box_id_key)
  select distinct upper(trim(value))
  from jsonb_array_elements_text(
    case
      when jsonb_typeof(coalesce(p_scope->'boxIds', '[]'::jsonb)) = 'array'
      then coalesce(p_scope->'boxIds', '[]'::jsonb)
      else '[]'::jsonb
    end
  ) s(value)
  where trim(value) <> ''
  on conflict do nothing;

  insert into auto_planner_explicit_caulk_scope (product_id, warehouse)
  select distinct
    (app_api.trim_text(value->>'productId'))::uuid,
    upper(app_api.trim_text(value->>'warehouse'))
  from jsonb_array_elements(
    case
      when jsonb_typeof(coalesce(p_scope->'caulkProductWarehousePairs', '[]'::jsonb)) = 'array'
      then coalesce(p_scope->'caulkProductWarehousePairs', '[]'::jsonb)
      else '[]'::jsonb
    end
  ) value
  where app_api.trim_text(value->>'productId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and app_api.trim_text(value->>'warehouse') <> ''
  on conflict do nothing;

  insert into auto_planner_jobs (job_id, job_number, warehouse, install_date, crew_leader, created_at)
  select j.id, j.job_number, upper(j.warehouse::text), j.due_date, coalesce(j.crew_leader, ''), j.created_at
  from app.jobs j
  join app_api.auto_planner_scope_job_numbers(p_org_id, coalesce(p_scope, '{}'::jsonb)) s
    on upper(trim(s.job_number)) = upper(trim(j.job_number))
  where j.org_id = p_org_id
    and j.lifecycle_status = 'ACTIVE'
  for update;

  insert into auto_planner_boxes (box_id, status, capacity, remaining, skipped)
  select distinct
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
      (
        not exists (select 1 from auto_planner_explicit_job_scope)
        and not exists (select 1 from auto_planner_explicit_box_scope)
        and not exists (select 1 from auto_planner_explicit_caulk_scope)
        and upper(coalesce(b.warehouse::text, '')) in (select warehouse from auto_planner_jobs)
      )
      or exists (
        select 1
        from auto_planner_explicit_box_scope eb
        where eb.box_id_key = upper(trim(b.box_id))
      )
      or exists (
        select 1
        from app.allocations a
        join auto_planner_jobs j
          on j.job_id = a.job_id
          or upper(trim(j.job_number)) = upper(trim(a.job_number))
        where a.org_id = p_org_id
          and a.box_id = b.box_id
          and a.status = 'ACTIVE'
      )
      or exists (
        select 1
        from auto_planner_jobs j
        join app.job_requirements r
          on r.org_id = p_org_id
         and r.job_id = j.job_id
        where upper(coalesce(b.status::text, '')) = 'IN_STOCK'
          and upper(coalesce(b.warehouse::text, '')) = j.warehouse
          and b.width_in >= r.width_in
          and app_api.requirement_film_is_compatible(
            p_org_id,
            b.manufacturer,
            b.film_name,
            r.manufacturer,
            r.film_name
          )
      )
    )
  on conflict (box_id) do nothing;

  perform 1
  from app.boxes b
  join auto_planner_boxes bx
    on bx.box_id = b.box_id
  where b.org_id = p_org_id
  for update;$snippet$;
begin
  select pg_get_functiondef('app_api.reconcile_auto_planned_allocations(uuid, text, jsonb)'::regprocedure)
  into v_definition;

  if v_definition is null then
    raise exception 'app_api.reconcile_auto_planned_allocations(uuid, text, jsonb) was not found';
  end if;

  v_next_definition := v_definition;

  if position(v_new_box_scope in v_next_definition) = 0 then
    if position(v_old_box_scope in v_next_definition) = 0 then
      raise exception 'Expected broad planner box scope snippet was not found';
    end if;

    v_next_definition := replace(v_next_definition, v_old_box_scope, v_new_box_scope);
  end if;

  if position(v_new_box_scope in v_next_definition) = 0
    or position(v_old_box_scope in v_next_definition) > 0
  then
    raise exception 'app_api.reconcile_auto_planned_allocations narrow scope patch verification failed';
  end if;

  if v_next_definition <> v_definition then
    execute v_next_definition;
  end if;
end;
$$;
