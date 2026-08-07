-- Bound residual job-summary reads and mutation response reloads before data crosses PostgREST.

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
    jsonb_agg(
      to_jsonb(a) - array['id', 'org_id', 'created_by', 'resolved_by', 'notes']::text[]
      order by a.created_at desc, a.allocation_id desc
    ),
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
    jsonb_agg(
      to_jsonb(f) - array['id', 'org_id', 'created_by', 'resolved_by', 'notes']::text[]
      order by f.created_at desc, f.film_order_id desc
    ),
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
      jsonb_agg(
        to_jsonb(p) - array['org_id', 'created_by', 'updated_by']::text[]
        order by p.job_id asc, p.phase_number asc, p.created_at asc
      ),
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
      to_jsonb(q) - array['org_id', 'notes', 'created_at', 'created_by', 'updated_at', 'updated_by']::text[]
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

create or replace function public.api_acl_job_search_candidate_numbers(
  p_org_id uuid,
  p_query text,
  p_lifecycle_status text default 'ACTIVE',
  p_warehouse text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_query_digits text := regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g');
  v_query_canonical text;
  v_lifecycle_status text := upper(app_api.trim_text(coalesce(p_lifecycle_status, 'ACTIVE')));
  v_warehouse text := upper(app_api.trim_text(p_warehouse));
  v_result jsonb;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'read');
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'read');
  perform app_api.require_effective_feature_access(p_org_id, 'film_orders', 'read');

  if v_query_digits = '' then
    return '[]'::jsonb;
  end if;
  v_query_canonical := coalesce(nullif(ltrim(v_query_digits, '0'), ''), '0');

  with candidate_numbers as (
    select app_api.trim_text(j.job_number) as job_number
    from app.jobs j
    where j.org_id = p_org_id
      and j.lifecycle_status::text = v_lifecycle_status
      and (v_warehouse = '' or upper(app_api.trim_text(j.warehouse)) = v_warehouse)
      and coalesce(
        nullif(ltrim(regexp_replace(coalesce(j.job_number, ''), '[^0-9]', '', 'g'), '0'), ''),
        '0'
      ) like ('%' || v_query_canonical || '%')

    union

    select app_api.trim_text(a.job_number)
    from app.allocations a
    where a.org_id = p_org_id
      and v_lifecycle_status = 'ACTIVE'
      and a.job_id is null
      and app_api.trim_text(a.job_number) <> ''
      and coalesce(
        nullif(ltrim(regexp_replace(coalesce(a.job_number, ''), '[^0-9]', '', 'g'), '0'), ''),
        '0'
      ) like ('%' || v_query_canonical || '%')

    union

    select app_api.trim_text(f.job_number)
    from app.film_orders f
    where f.org_id = p_org_id
      and v_lifecycle_status = 'ACTIVE'
      and f.job_id is null
      and app_api.trim_text(f.job_number) <> ''
      and coalesce(
        nullif(ltrim(regexp_replace(coalesce(f.job_number, ''), '[^0-9]', '', 'g'), '0'), ''),
        '0'
      ) like ('%' || v_query_canonical || '%')
  )
  select coalesce(jsonb_agg(job_number order by job_number desc), '[]'::jsonb)
  into v_result
  from candidate_numbers
  where job_number <> '';

  return v_result;
end;
$$;

create or replace function public.api_acl_job_calendar_candidate_numbers(
  p_org_id uuid,
  p_range_start date,
  p_range_end date,
  p_lifecycle_status text default 'ACTIVE',
  p_warehouse text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_lifecycle_status text := upper(app_api.trim_text(coalesce(p_lifecycle_status, 'ACTIVE')));
  v_warehouse text := upper(app_api.trim_text(p_warehouse));
  v_result jsonb;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'read');
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'read');
  perform app_api.require_effective_feature_access(p_org_id, 'film_orders', 'read');

  with legacy_numbers as (
    select app_api.trim_text(a.job_number) as job_number
    from app.allocations a
    where a.org_id = p_org_id and a.job_id is null and app_api.trim_text(a.job_number) <> ''
    union
    select app_api.trim_text(f.job_number)
    from app.film_orders f
    where f.org_id = p_org_id and f.job_id is null and app_api.trim_text(f.job_number) <> ''
  ),
  legacy_dates as (
    select
      n.job_number,
      coalesce(
        (
          select a.job_date
          from app.allocations a
          where a.org_id = p_org_id
            and a.job_id is null
            and app_api.trim_text(a.job_number) = n.job_number
            and a.job_date is not null
          order by a.created_at desc, a.allocation_id desc
          limit 1
        ),
        (
          select f.job_date
          from app.film_orders f
          where f.org_id = p_org_id
            and f.job_id is null
            and app_api.trim_text(f.job_number) = n.job_number
            and f.job_date is not null
          order by f.created_at desc, f.film_order_id desc
          limit 1
        )
      ) as install_date
    from legacy_numbers n
  ),
  candidate_numbers as (
    select app_api.trim_text(j.job_number) as job_number
    from app.jobs j
    where j.org_id = p_org_id
      and j.lifecycle_status::text = v_lifecycle_status
      and (v_warehouse = '' or upper(app_api.trim_text(j.warehouse)) = v_warehouse)
      and (
        (
          exists (select 1 from app.job_phases p where p.org_id = j.org_id and p.job_id = j.id)
          and exists (
            select 1
            from app.job_phases p
            where p.org_id = j.org_id
              and p.job_id = j.id
              and p.install_date <= p_range_end
              and case
                when p.install_end_date is not null and p.install_end_date >= p.install_date then p.install_end_date
                else p.install_date
              end >= p_range_start
          )
        )
        or (
          not exists (select 1 from app.job_phases p where p.org_id = j.org_id and p.job_id = j.id)
          and (
            j.due_date between p_range_start and p_range_end
            or exists (
              select 1
              from app.allocations a
              where a.org_id = j.org_id
                and (a.job_id = j.id or (a.job_id is null and app_api.trim_text(a.job_number) = app_api.trim_text(j.job_number)))
                and a.job_date between p_range_start and p_range_end
            )
            or exists (
              select 1
              from app.film_orders f
              where f.org_id = j.org_id
                and (f.job_id = j.id or (f.job_id is null and app_api.trim_text(f.job_number) = app_api.trim_text(j.job_number)))
                and f.job_date between p_range_start and p_range_end
            )
          )
        )
      )

    union

    select l.job_number
    from legacy_dates l
    where v_lifecycle_status = 'ACTIVE'
      and l.install_date between p_range_start and p_range_end
  )
  select coalesce(jsonb_agg(job_number order by job_number desc), '[]'::jsonb)
  into v_result
  from candidate_numbers
  where job_number <> '';

  return v_result;
end;
$$;

create or replace function public.api_acl_job_attention_candidate_numbers(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_result jsonb;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'read');
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'read');
  perform app_api.require_effective_feature_access(p_org_id, 'film_orders', 'read');

  with legacy_numbers as (
    select app_api.trim_text(a.job_number) as job_number
    from app.allocations a
    where a.org_id = p_org_id and a.job_id is null and app_api.trim_text(a.job_number) <> ''
    union
    select app_api.trim_text(f.job_number)
    from app.film_orders f
    where f.org_id = p_org_id and f.job_id is null and app_api.trim_text(f.job_number) <> ''
  ),
  dated_legacy_numbers as (
    select n.job_number
    from legacy_numbers n
    where exists (
      select 1
      from app.allocations a
      where a.org_id = p_org_id
        and a.job_id is null
        and app_api.trim_text(a.job_number) = n.job_number
        and a.job_date is not null
    )
      or exists (
        select 1
        from app.film_orders f
        where f.org_id = p_org_id
          and f.job_id is null
          and app_api.trim_text(f.job_number) = n.job_number
          and f.job_date is not null
      )
  ),
  candidate_numbers as (
    select app_api.trim_text(j.job_number) as job_number
    from app.jobs j
    where j.org_id = p_org_id
      and j.lifecycle_status::text = 'ACTIVE'
      and (
        j.due_date is not null
        or exists (
          select 1
          from app.job_phases p
          where p.org_id = j.org_id
            and p.job_id = j.id
            and p.install_date is not null
        )
        or exists (
          select 1
          from app.allocations a
          where a.org_id = j.org_id
            and (a.job_id = j.id or (a.job_id is null and app_api.trim_text(a.job_number) = app_api.trim_text(j.job_number)))
            and a.job_date is not null
        )
        or exists (
          select 1
          from app.film_orders f
          where f.org_id = j.org_id
            and (f.job_id = j.id or (f.job_id is null and app_api.trim_text(f.job_number) = app_api.trim_text(j.job_number)))
            and f.job_date is not null
        )
      )
    union
    select job_number from dated_legacy_numbers
  )
  select coalesce(jsonb_agg(job_number order by job_number desc), '[]'::jsonb)
  into v_result
  from candidate_numbers
  where job_number <> '';

  return v_result;
end;
$$;

create or replace function public.api_acl_box_reservation_snapshot(
  p_org_id uuid,
  p_box_ids text[] default null,
  p_allocation_ids text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_requested_box_ids text[];
  v_allocation_ids text[];
  v_box_ids text[];
  v_selected_allocations jsonb;
  v_allocations jsonb;
  v_boxes jsonb;
  v_jobs jsonb;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'read');
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'read');
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'read');

  select coalesce(array_agg(distinct value), array[]::text[])
  into v_requested_box_ids
  from (
    select nullif(upper(app_api.trim_text(raw_value)), '') as value
    from unnest(coalesce(p_box_ids, array[]::text[])) as box_ids(raw_value)
  ) normalized
  where value is not null;

  select coalesce(array_agg(distinct value), array[]::text[])
  into v_allocation_ids
  from (
    select nullif(app_api.trim_text(raw_value), '') as value
    from unnest(coalesce(p_allocation_ids, array[]::text[])) as allocation_ids(raw_value)
  ) normalized
  where value is not null;

  select coalesce(array_agg(distinct box_id), array[]::text[])
  into v_box_ids
  from (
    select unnest(v_requested_box_ids) as box_id
    union
    select upper(app_api.trim_text(a.box_id))
    from app.allocations a
    where a.org_id = p_org_id
      and a.allocation_id = any(v_allocation_ids)
      and app_api.trim_text(a.box_id) <> ''
  ) targets;

  select coalesce(
    jsonb_agg(to_jsonb(a) order by a.created_at desc, a.allocation_id desc),
    '[]'::jsonb
  )
  into v_selected_allocations
  from app.allocations a
  where a.org_id = p_org_id
    and a.allocation_id = any(v_allocation_ids);

  select coalesce(
    jsonb_agg(
      to_jsonb(a) - array['id', 'org_id', 'created_by', 'resolved_by', 'notes']::text[]
      order by a.created_at desc, a.allocation_id desc
    ),
    '[]'::jsonb
  )
  into v_allocations
  from app.allocations a
  where a.org_id = p_org_id
    and upper(app_api.trim_text(a.box_id)) = any(v_box_ids);

  select coalesce(
    jsonb_agg(to_jsonb(b) order by b.box_id asc),
    '[]'::jsonb
  )
  into v_boxes
  from app.boxes b
  where b.org_id = p_org_id
    and upper(app_api.trim_text(b.box_id)) = any(v_box_ids);

  select coalesce(
    jsonb_agg(
      jsonb_build_object('id', j.id, 'job_number', j.job_number, 'created_at', j.created_at)
      order by j.created_at asc, j.id asc
    ),
    '[]'::jsonb
  )
  into v_jobs
  from app.jobs j
  where j.org_id = p_org_id
    and exists (
      select 1
      from app.allocations a
      where a.org_id = p_org_id
        and upper(app_api.trim_text(a.box_id)) = any(v_box_ids)
        and (a.job_id = j.id or app_api.trim_text(a.job_number) = app_api.trim_text(j.job_number))
    );

  return jsonb_build_object(
    'selectedAllocations', v_selected_allocations,
    'allocations', v_allocations,
    'boxes', v_boxes,
    'jobs', v_jobs
  );
end;
$$;

revoke execute on function public.api_acl_job_search_candidate_numbers(uuid, text, text, text) from public, anon, service_role;
revoke execute on function public.api_acl_job_calendar_candidate_numbers(uuid, date, date, text, text) from public, anon, service_role;
revoke execute on function public.api_acl_job_attention_candidate_numbers(uuid) from public, anon, service_role;
revoke execute on function public.api_acl_box_reservation_snapshot(uuid, text[], text[]) from public, anon, service_role;

grant execute on function public.api_acl_job_search_candidate_numbers(uuid, text, text, text) to authenticated;
grant execute on function public.api_acl_job_calendar_candidate_numbers(uuid, date, date, text, text) to authenticated;
grant execute on function public.api_acl_job_attention_candidate_numbers(uuid) to authenticated;
grant execute on function public.api_acl_box_reservation_snapshot(uuid, text[], text[]) to authenticated;
