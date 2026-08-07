-- Scope high-frequency job summary reads before data crosses the PostgREST boundary.

create or replace function public.api_acl_list_jobs_by_ids(
  p_org_id uuid,
  p_job_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_job_ids uuid[];
  v_result jsonb;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'read');

  select coalesce(array_agg(distinct value), array[]::uuid[])
  into v_job_ids
  from unnest(coalesce(p_job_ids, array[]::uuid[])) as ids(value)
  where value is not null;

  select coalesce(
    jsonb_agg(to_jsonb(j) order by j.due_date desc nulls last, j.updated_at desc, j.job_number desc, j.id asc),
    '[]'::jsonb
  )
  into v_result
  from app.jobs j
  where j.org_id = p_org_id
    and j.id = any(v_job_ids);

  return v_result;
end;
$$;

create or replace function public.api_acl_list_jobs_by_numbers(
  p_org_id uuid,
  p_job_numbers text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_job_numbers text[];
  v_result jsonb;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'read');

  select coalesce(array_agg(distinct value), array[]::text[])
  into v_job_numbers
  from (
    select nullif(app_api.trim_text(raw_value), '') as value
    from unnest(coalesce(p_job_numbers, array[]::text[])) as numbers(raw_value)
  ) normalized
  where value is not null;

  select coalesce(
    jsonb_agg(to_jsonb(j) order by j.due_date desc nulls last, j.updated_at desc, j.job_number desc, j.id asc),
    '[]'::jsonb
  )
  into v_result
  from app.jobs j
  where j.org_id = p_org_id
    and j.job_number = any(v_job_numbers);

  return v_result;
end;
$$;

create or replace function public.api_acl_job_summary_snapshot(
  p_org_id uuid,
  p_job_ids uuid[],
  p_include_legacy boolean default true,
  p_legacy_job_numbers text[] default null,
  p_include_phases boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_job_ids uuid[];
  v_legacy_job_numbers text[];
  v_filter_legacy_numbers boolean;
  v_allocations jsonb;
  v_film_orders jsonb;
  v_phases jsonb;
  v_requirements jsonb;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'read');
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'read');
  perform app_api.require_effective_feature_access(p_org_id, 'film_orders', 'read');

  select coalesce(array_agg(distinct value), array[]::uuid[])
  into v_job_ids
  from unnest(coalesce(p_job_ids, array[]::uuid[])) as ids(value)
  where value is not null;

  select coalesce(array_agg(distinct value), array[]::text[])
  into v_legacy_job_numbers
  from (
    select nullif(app_api.trim_text(raw_value), '') as value
    from unnest(coalesce(p_legacy_job_numbers, array[]::text[])) as numbers(raw_value)
  ) normalized
  where value is not null;
  v_filter_legacy_numbers := cardinality(v_legacy_job_numbers) > 0;

  select coalesce(
    jsonb_agg(to_jsonb(a) order by a.created_at desc, a.allocation_id desc),
    '[]'::jsonb
  )
  into v_allocations
  from app.allocations a
  where a.org_id = p_org_id
    and (
      a.job_id = any(v_job_ids)
      or (
        coalesce(p_include_legacy, false)
        and a.job_id is null
        and (not v_filter_legacy_numbers or a.job_number = any(v_legacy_job_numbers))
      )
    );

  select coalesce(
    jsonb_agg(to_jsonb(f) order by f.created_at desc, f.film_order_id desc),
    '[]'::jsonb
  )
  into v_film_orders
  from app.film_orders f
  where f.org_id = p_org_id
    and (
      f.job_id = any(v_job_ids)
      or (
        coalesce(p_include_legacy, false)
        and f.job_id is null
        and (not v_filter_legacy_numbers or f.job_number = any(v_legacy_job_numbers))
      )
    );

  if coalesce(p_include_phases, true) then
    select coalesce(
      jsonb_agg(to_jsonb(p) order by p.job_id asc, p.phase_number asc, p.created_at asc),
      '[]'::jsonb
    )
    into v_phases
    from app.job_phases p
    where p.org_id = p_org_id
      and p.job_id = any(v_job_ids);
  else
    v_phases := '[]'::jsonb;
  end if;

  select coalesce(
    jsonb_agg(
      to_jsonb(q)
      order by q.job_number asc, q.phase_number asc, q.manufacturer asc, q.film_name asc, q.width_in asc
    ),
    '[]'::jsonb
  )
  into v_requirements
  from (
    select
      r.id,
      r.org_id,
      r.job_id,
      r.phase_id,
      r.manufacturer,
      r.film_name,
      r.width_in,
      r.required_feet,
      r.status,
      r.actual_used_feet,
      r.completed_at,
      r.completed_by,
      r.notes,
      r.created_at,
      r.created_by,
      r.updated_at,
      r.updated_by,
      j.job_number,
      p.phase_number,
      p.sections as phase_sections,
      p.install_date as phase_install_date,
      p.install_end_date as phase_install_end_date,
      p.crew_leader as phase_crew_leader,
      exists (
        select 1
        from app.allocation_planner_suppressions s
        where s.org_id = r.org_id
          and s.job_id = r.job_id
          and (s.phase_id is null or s.phase_id = r.phase_id)
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
    join app.jobs j on j.id = r.job_id and j.org_id = r.org_id
    join app.job_phases p on p.id = r.phase_id and p.org_id = r.org_id
    where r.org_id = p_org_id
      and r.job_id = any(v_job_ids)
  ) q;

  return jsonb_build_object(
    'allocations', v_allocations,
    'filmOrders', v_film_orders,
    'phases', v_phases,
    'requirements', v_requirements
  );
end;
$$;

create or replace function public.api_acl_has_film_orders_needing_attention(p_org_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'film_orders', 'read');

  return exists (
    select 1
    from app.film_orders f
    where f.org_id = p_org_id
      and f.status::text = 'FILM_ORDER'
      and f.job_date is not null
      and f.remaining_to_order_feet > 0
  );
end;
$$;

revoke execute on function public.api_acl_list_jobs_by_ids(uuid, uuid[]) from public, anon, service_role;
revoke execute on function public.api_acl_list_jobs_by_numbers(uuid, text[]) from public, anon, service_role;
revoke execute on function public.api_acl_job_summary_snapshot(uuid, uuid[], boolean, text[], boolean) from public, anon, service_role;
revoke execute on function public.api_acl_has_film_orders_needing_attention(uuid) from public, anon, service_role;

grant execute on function public.api_acl_list_jobs_by_ids(uuid, uuid[]) to authenticated;
grant execute on function public.api_acl_list_jobs_by_numbers(uuid, text[]) to authenticated;
grant execute on function public.api_acl_job_summary_snapshot(uuid, uuid[], boolean, text[], boolean) to authenticated;
grant execute on function public.api_acl_has_film_orders_needing_attention(uuid) to authenticated;
