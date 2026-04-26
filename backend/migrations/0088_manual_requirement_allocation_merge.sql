/**
 * PURPOSE:
 * Keeps manual film allocation apply writes to one active REQUIREMENT row per
 * same job, requirement, and box while converting user-touched AUTO_PLANNED
 * reservations into MANUAL ownership.
 *
 * AFFECTS:
 * public.api_allocations_apply, Supabase Edge allocation apply RPC responses,
 * job detail allocation rows, requirement coverage totals, and planner-owned
 * AUTO_PLANNED reservations.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * backend runtime allocation merge helpers, frontend optimistic allocation
 * cache behavior, planner suppression rules, and allocation source metadata.
 *
 * COMMON FAILURE MODES:
 * Leaving both AUTO_PLANNED and MANUAL rows active, merging EXTRA or film-order
 * rows, reviving cancelled history, or double-counting superseded rows during
 * capacity assertions.
 */

create or replace function app_api.create_or_merge_manual_requirement_allocation_with_coverage(
  p_org_id uuid,
  p_box app.boxes,
  p_job_context jsonb,
  p_allocated_feet integer,
  p_covered_feet integer,
  p_actor text,
  p_film_order_id text default '',
  p_allocation_kind text default 'REQUIREMENT',
  p_requirement_id uuid default null
)
returns app.allocations
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_kind text := upper(app_api.trim_text(p_allocation_kind));
  v_job_id uuid := app_api.get_or_resolve_job_id(p_org_id, p_job_context->>'jobNumber');
  v_job_number text := app_api.trim_text(p_job_context->>'jobNumber');
  v_film_order_id text := app_api.trim_text(p_film_order_id);
  v_primary app.allocations;
  v_duplicate app.allocations;
  v_allocated_feet integer := 0;
  v_covered_feet integer := 0;
begin
  if v_kind = '' then
    v_kind := 'REQUIREMENT';
  end if;

  if v_kind <> 'REQUIREMENT'
    or p_requirement_id is null
    or v_film_order_id <> ''
  then
    return app_api.create_allocation_with_coverage(
      p_org_id,
      p_box,
      p_job_context,
      p_allocated_feet,
      p_covered_feet,
      p_actor,
      p_film_order_id,
      p_allocation_kind,
      p_requirement_id
    );
  end if;

  select a.*
  into v_primary
  from app.allocations a
  where a.org_id = p_org_id
    and a.box_id = p_box.box_id
    and a.status = 'ACTIVE'
    and coalesce(a.allocation_kind::text, 'REQUIREMENT') = 'REQUIREMENT'
    and a.requirement_id = p_requirement_id
    and coalesce(a.film_order_id, '') = ''
    and coalesce(a.allocation_source::text, 'MANUAL') in ('MANUAL', 'AUTO_PLANNED')
    and case
      when v_job_id is not null and a.job_id is not null then a.job_id = v_job_id
      else upper(trim(coalesce(a.job_number, ''))) = upper(v_job_number)
    end
  order by
    case coalesce(a.allocation_source::text, 'MANUAL')
      when 'MANUAL' then 0
      when 'AUTO_PLANNED' then 1
      else 2
    end,
    a.created_at asc,
    a.allocation_id asc
  limit 1
  for update;

  if v_primary.id is null then
    return app_api.create_allocation_with_coverage(
      p_org_id,
      p_box,
      p_job_context,
      p_allocated_feet,
      p_covered_feet,
      p_actor,
      p_film_order_id,
      p_allocation_kind,
      p_requirement_id
    );
  end if;

  v_allocated_feet := coalesce(v_primary.allocated_feet, 0);
  v_covered_feet := coalesce(v_primary.covered_feet, v_primary.allocated_feet, 0);

  for v_duplicate in
    select a.*
    from app.allocations a
    where a.org_id = p_org_id
      and a.id <> v_primary.id
      and a.box_id = p_box.box_id
      and a.status = 'ACTIVE'
      and coalesce(a.allocation_kind::text, 'REQUIREMENT') = 'REQUIREMENT'
      and a.requirement_id = p_requirement_id
      and coalesce(a.film_order_id, '') = ''
      and coalesce(a.allocation_source::text, 'MANUAL') in ('MANUAL', 'AUTO_PLANNED')
      and case
        when v_job_id is not null and a.job_id is not null then a.job_id = v_job_id
        else upper(trim(coalesce(a.job_number, ''))) = upper(v_job_number)
      end
    order by
      case coalesce(a.allocation_source::text, 'MANUAL')
        when 'MANUAL' then 0
        when 'AUTO_PLANNED' then 1
        else 2
      end,
      a.created_at asc,
      a.allocation_id asc
    for update
  loop
    v_allocated_feet := v_allocated_feet + coalesce(v_duplicate.allocated_feet, 0);
    v_covered_feet := v_covered_feet + coalesce(v_duplicate.covered_feet, v_duplicate.allocated_feet, 0);

    v_duplicate.status := 'CANCELLED';
    v_duplicate.resolved_at := now();
    v_duplicate.resolved_by := app_api.trim_text(p_actor);
    v_duplicate.notes := format('Superseded by manual allocation merge into %s.', v_primary.allocation_id);
    v_duplicate := app_api.save_allocation(v_duplicate);
  end loop;

  v_primary.box_id := p_box.box_id;
  v_primary.job_id := coalesce(v_primary.job_id, v_job_id);
  v_primary.job_number := v_job_number;
  v_primary.warehouse := p_box.warehouse;
  v_primary.job_date := nullif(app_api.trim_text(p_job_context->>'jobDate'), '')::date;
  v_primary.allocated_feet := v_allocated_feet + greatest(coalesce(p_allocated_feet, 0), 0);
  v_primary.covered_feet := v_covered_feet + greatest(coalesce(p_covered_feet, p_allocated_feet, 0), 0);
  v_primary.requirement_id := p_requirement_id;
  v_primary.status := 'ACTIVE';
  v_primary.resolved_at := null;
  v_primary.resolved_by := '';
  v_primary.crew_leader := coalesce(p_job_context->>'crewLeader', '');
  v_primary.film_order_id := '';
  v_primary.allocation_kind := 'REQUIREMENT'::app.allocation_kind;
  v_primary.allocation_source := 'MANUAL'::app.allocation_source;

  return app_api.save_allocation(v_primary);
end;
$$;

do $$
declare
  v_def text;
  v_base text;
  v_next text;
begin
  select pg_get_functiondef('public.api_allocations_apply(uuid, text, jsonb)'::regprocedure)
  into v_def;
  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  v_next := replace(
    v_next,
    'v_allocation := app_api.create_allocation_with_coverage(',
    'v_allocation := app_api.create_or_merge_manual_requirement_allocation_with_coverage('
  );

  if v_next = v_base then
    if v_base like '%app_api.create_or_merge_manual_requirement_allocation_with_coverage(%' then
      return;
    end if;

    raise exception 'api_allocations_apply manual allocation merge patch did not match expected snippets';
  end if;

  execute v_next;
end;
$$;
