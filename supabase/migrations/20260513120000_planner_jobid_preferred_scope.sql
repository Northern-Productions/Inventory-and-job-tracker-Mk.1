/**
 * PURPOSE:
 * Adds Phase 3B jobId-preferred planner scope selection without enabling
 * duplicate job numbers or changing runtime callers.
 *
 * AFFECTS:
 * app_api.reconcile_auto_planned_allocations candidate job selection only.
 * Existing jobNumber, box, and caulk affected-scope behavior remains available
 * through the new app_api.auto_planner_scope_jobs helper.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * Supabase mirror migration, backend planner static tests, schema latest guard,
 * and future runtime/RPC slices that start sending jobIds from SQL-owned paths.
 *
 * COMMON FAILURE MODES:
 * Expanding one jobId into same-number jobs, treating invalid jobIds as
 * org-wide scope, loading warehouse-wide boxes for a jobId-only scope, or
 * changing legacy jobNumber-only planner behavior before duplicates are ready.
 */

create or replace function app_api.auto_planner_scope_jobs(
  p_org_id uuid,
  p_scope jsonb
)
returns table(job_id uuid, job_number text)
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_scope jsonb := coalesce(p_scope, '{}'::jsonb);
  v_has_raw_job_ids boolean := false;
  v_has_valid_job_ids boolean := false;
  v_has_any_scope boolean := false;
begin
  create temporary table if not exists auto_planner_scope_job_id_candidates (
    candidate_job_id uuid primary key,
    first_position integer not null
  ) on commit drop;
  truncate auto_planner_scope_job_id_candidates;

  create temporary table if not exists auto_planner_scope_job_number_candidates (
    job_number_key text primary key,
    first_position integer not null
  ) on commit drop;
  truncate auto_planner_scope_job_number_candidates;

  create temporary table if not exists auto_planner_scope_box_candidates (
    box_id text primary key,
    warehouse text not null,
    status text not null,
    manufacturer text not null,
    film_name text not null,
    width_in numeric not null
  ) on commit drop;
  truncate auto_planner_scope_box_candidates;

  create temporary table if not exists auto_planner_scope_caulk_pair_candidates (
    product_id uuid not null,
    warehouse text not null,
    primary key (product_id, warehouse)
  ) on commit drop;
  truncate auto_planner_scope_caulk_pair_candidates;

  create temporary table if not exists auto_planner_scope_job_results (
    result_job_id uuid primary key,
    result_job_number text not null,
    first_position integer not null
  ) on commit drop;
  truncate auto_planner_scope_job_results;

  select exists (
    select 1
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(v_scope->'jobIds') = 'array'
        then v_scope->'jobIds'
        else '[]'::jsonb
      end
    ) raw(value)
    where btrim(value) <> ''
  )
  into v_has_raw_job_ids;

  insert into auto_planner_scope_job_id_candidates (candidate_job_id, first_position)
  select
    btrim(value)::uuid,
    min(ordinality)::integer
  from jsonb_array_elements_text(
    case
      when jsonb_typeof(v_scope->'jobIds') = 'array'
      then v_scope->'jobIds'
      else '[]'::jsonb
    end
  ) with ordinality as requested(value, ordinality)
  where btrim(value) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  group by btrim(value)::uuid
  on conflict do nothing;

  insert into auto_planner_scope_job_number_candidates (job_number_key, first_position)
  select
    upper(btrim(value)),
    min(ordinality)::integer
  from jsonb_array_elements_text(
    case
      when jsonb_typeof(v_scope->'jobNumbers') = 'array'
      then v_scope->'jobNumbers'
      else '[]'::jsonb
    end
  ) with ordinality as requested(value, ordinality)
  where btrim(value) <> ''
  group by upper(btrim(value))
  on conflict do nothing;

  insert into auto_planner_scope_box_candidates (box_id, warehouse, status, manufacturer, film_name, width_in)
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
      when jsonb_typeof(v_scope->'boxIds') = 'array'
      then v_scope->'boxIds'
      else '[]'::jsonb
    end
  ) requested(value)
    on upper(btrim(b.box_id)) = upper(btrim(requested.value))
  where b.org_id = p_org_id
    and btrim(requested.value) <> ''
  on conflict do nothing;

  insert into auto_planner_scope_caulk_pair_candidates (product_id, warehouse)
  select distinct
    (app_api.trim_text(value->>'productId'))::uuid,
    upper(app_api.trim_text(value->>'warehouse'))
  from jsonb_array_elements(
    case
      when jsonb_typeof(v_scope->'caulkProductWarehousePairs') = 'array'
      then v_scope->'caulkProductWarehousePairs'
      else '[]'::jsonb
    end
  ) value
  where app_api.trim_text(value->>'productId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and app_api.trim_text(value->>'warehouse') <> ''
  on conflict do nothing;

  v_has_valid_job_ids := exists (select 1 from auto_planner_scope_job_id_candidates);
  v_has_any_scope := v_has_raw_job_ids
    or exists (select 1 from auto_planner_scope_job_number_candidates)
    or exists (select 1 from auto_planner_scope_box_candidates)
    or exists (select 1 from auto_planner_scope_caulk_pair_candidates);

  if not v_has_any_scope then
    return query
    select j.id, j.job_number
    from app.jobs j
    where j.org_id = p_org_id
      and j.lifecycle_status = 'ACTIVE'
    order by j.created_at, j.job_number, j.id;
    return;
  end if;

  if v_has_valid_job_ids then
    insert into auto_planner_scope_job_results (result_job_id, result_job_number, first_position)
    select
      j.id,
      j.job_number,
      s.first_position
    from auto_planner_scope_job_id_candidates s
    join app.jobs j
      on j.org_id = p_org_id
     and j.lifecycle_status = 'ACTIVE'
     and j.id = s.candidate_job_id
    on conflict do nothing;
  else
    insert into auto_planner_scope_job_results (result_job_id, result_job_number, first_position)
    select
      j.id,
      j.job_number,
      100000 + s.first_position
    from auto_planner_scope_job_number_candidates s
    join app.jobs j
      on j.org_id = p_org_id
     and j.lifecycle_status = 'ACTIVE'
     and upper(btrim(j.job_number)) = s.job_number_key
    on conflict do nothing;
  end if;

  insert into auto_planner_scope_job_results (result_job_id, result_job_number, first_position)
  select distinct
    j.id,
    j.job_number,
    200000
  from auto_planner_scope_box_candidates sb
  join app.allocations a
    on a.org_id = p_org_id
   and upper(btrim(a.box_id)) = upper(btrim(sb.box_id))
   and a.status = 'ACTIVE'
  join app.jobs j
    on j.org_id = a.org_id
   and j.lifecycle_status = 'ACTIVE'
   and (
     (a.job_id is not null and j.id = a.job_id)
     or (
       a.job_id is null
       and upper(btrim(j.job_number)) = upper(btrim(a.job_number))
     )
   )
  on conflict do nothing;

  insert into auto_planner_scope_job_results (result_job_id, result_job_number, first_position)
  select distinct
    j.id,
    j.job_number,
    210000
  from auto_planner_scope_box_candidates sb
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
  on conflict do nothing;

  insert into auto_planner_scope_job_results (result_job_id, result_job_number, first_position)
  select distinct
    j.id,
    j.job_number,
    300000
  from auto_planner_scope_caulk_pair_candidates sc
  join app.jobs j
    on j.org_id = p_org_id
   and j.lifecycle_status = 'ACTIVE'
   and upper(coalesce(j.warehouse::text, '')) = sc.warehouse
  join app.job_caulk_requirements r
    on r.org_id = p_org_id
   and r.job_id = j.id
   and r.product_id = sc.product_id
  on conflict do nothing;

  return query
  select r.result_job_id, r.result_job_number
  from auto_planner_scope_job_results r
  order by r.first_position, r.result_job_number, r.result_job_id;
end;
$$;

comment on function app_api.auto_planner_scope_jobs(uuid, jsonb) is
  'Phase 3B-3a jobId-preferred AUTO planner scope helper. Valid jobIds are exact explicit job candidates; legacy jobNumbers remain fallback when no valid jobIds are supplied. Duplicate job numbers remain disabled.';

do $$
declare
  v_definition text;
  v_next_definition text;
  v_old_jobs_join text := $snippet$
  join app_api.auto_planner_scope_job_numbers(p_org_id, coalesce(p_scope, '{}'::jsonb)) s
    on upper(trim(s.job_number)) = upper(trim(j.job_number))$snippet$;
  v_new_jobs_join text := $snippet$
  join app_api.auto_planner_scope_jobs(p_org_id, coalesce(p_scope, '{}'::jsonb)) s
    on s.job_id = j.id$snippet$;
  v_old_explicit_scope_anchor text := $snippet$
  create temporary table if not exists auto_planner_explicit_job_scope ($snippet$;
  v_new_explicit_scope_anchor text := $snippet$
  create temporary table if not exists auto_planner_explicit_job_id_scope (
    job_id uuid primary key
  ) on commit drop;
  truncate auto_planner_explicit_job_id_scope;

  create temporary table if not exists auto_planner_explicit_job_scope ($snippet$;
  v_old_explicit_insert_anchor text := $snippet$
  insert into auto_planner_explicit_job_scope (job_number_key)$snippet$;
  v_new_explicit_insert_anchor text := $snippet$
  insert into auto_planner_explicit_job_id_scope (job_id)
  select distinct btrim(value)::uuid
  from jsonb_array_elements_text(
    case
      when jsonb_typeof(coalesce(p_scope->'jobIds', '[]'::jsonb)) = 'array'
      then coalesce(p_scope->'jobIds', '[]'::jsonb)
      else '[]'::jsonb
    end
  ) s(value)
  where btrim(value) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  on conflict do nothing;

  insert into auto_planner_explicit_job_scope (job_number_key)$snippet$;
  v_old_org_wide_guard text := $snippet$
        not exists (select 1 from auto_planner_explicit_job_scope)
        and not exists (select 1 from auto_planner_explicit_box_scope)$snippet$;
  v_new_org_wide_guard text := $snippet$
        not exists (select 1 from auto_planner_explicit_job_id_scope)
        and not exists (select 1 from auto_planner_explicit_job_scope)
        and not exists (select 1 from auto_planner_explicit_box_scope)$snippet$;
begin
  select pg_get_functiondef('app_api.reconcile_auto_planned_allocations(uuid, text, jsonb)'::regprocedure)
  into v_definition;

  if v_definition is null then
    raise exception 'app_api.reconcile_auto_planned_allocations(uuid, text, jsonb) was not found';
  end if;

  v_definition := replace(v_definition, E'\r\n', E'\n');
  v_old_jobs_join := replace(v_old_jobs_join, E'\r\n', E'\n');
  v_new_jobs_join := replace(v_new_jobs_join, E'\r\n', E'\n');
  v_old_explicit_scope_anchor := replace(v_old_explicit_scope_anchor, E'\r\n', E'\n');
  v_new_explicit_scope_anchor := replace(v_new_explicit_scope_anchor, E'\r\n', E'\n');
  v_old_explicit_insert_anchor := replace(v_old_explicit_insert_anchor, E'\r\n', E'\n');
  v_new_explicit_insert_anchor := replace(v_new_explicit_insert_anchor, E'\r\n', E'\n');
  v_old_org_wide_guard := replace(v_old_org_wide_guard, E'\r\n', E'\n');
  v_new_org_wide_guard := replace(v_new_org_wide_guard, E'\r\n', E'\n');

  v_next_definition := v_definition;

  if position(v_new_explicit_scope_anchor in v_next_definition) = 0 then
    if position(v_old_explicit_scope_anchor in v_next_definition) = 0 then
      raise exception 'Expected explicit planner scope anchor was not found';
    end if;
    v_next_definition := replace(v_next_definition, v_old_explicit_scope_anchor, v_new_explicit_scope_anchor);
  end if;

  if position(v_new_explicit_insert_anchor in v_next_definition) = 0 then
    if position(v_old_explicit_insert_anchor in v_next_definition) = 0 then
      raise exception 'Expected explicit job scope insert anchor was not found';
    end if;
    v_next_definition := replace(v_next_definition, v_old_explicit_insert_anchor, v_new_explicit_insert_anchor);
  end if;

  if position(v_new_jobs_join in v_next_definition) = 0 then
    if position(v_old_jobs_join in v_next_definition) = 0 then
      raise exception 'Expected planner jobNumber candidate join was not found';
    end if;
    v_next_definition := replace(v_next_definition, v_old_jobs_join, v_new_jobs_join);
  end if;

  if position(v_new_org_wide_guard in v_next_definition) = 0 then
    if position(v_old_org_wide_guard in v_next_definition) = 0 then
      raise exception 'Expected org-wide planner box guard was not found';
    end if;
    v_next_definition := replace(v_next_definition, v_old_org_wide_guard, v_new_org_wide_guard);
  end if;

  if position(v_new_jobs_join in v_next_definition) = 0
    or position(v_old_jobs_join in v_next_definition) > 0
    or position('auto_planner_explicit_job_id_scope' in v_next_definition) = 0
    or position(v_new_org_wide_guard in v_next_definition) = 0
  then
    raise exception 'app_api.reconcile_auto_planned_allocations jobId-preferred scope patch verification failed';
  end if;

  if v_next_definition is distinct from v_definition then
    execute v_next_definition;
  end if;
end;
$$;
