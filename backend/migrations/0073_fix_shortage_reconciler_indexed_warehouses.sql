/**
 * PURPOSE:
 * Keep auto shortage film orders aligned with live reserved coverage for a job.
 *
 * AFFECTS:
 * Ordered-box receipt, allocation apply, box edit/status transitions, and job updates
 * that create, update, or delete auto shortage film orders.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * app_api.reconcile_auto_shortage_film_orders_for_box(...),
 * public.api_acl_allocations_apply(...), public.api_acl_jobs_update(...),
 * public.api_acl_boxes_update(...), public.api_acl_boxes_set_status(...),
 * public.api_acl_boxes_receive_ordered(...), and
 * backend/scripts/verify-ordered-box-allocation-flow.mjs.
 *
 * COMMON FAILURE MODES:
 * Legacy enum casts reject indexed warehouses, orphan shortage rows drift from
 * active allocations, or wrapper routes stop re-running shortage reconciliation.
 */
create or replace function app_api.reconcile_auto_shortage_film_orders_for_job(
  p_org_id uuid,
  p_actor text,
  p_job_number text,
  p_allow_placeholder_shortages boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_job app.jobs;
  v_requirement record;
  v_primary_orphan app.film_orders;
  v_new_order app.film_orders;
  v_orphan_film_order_id text;
  v_orphan_film_order_ids text[] := array[]::text[];
  v_source_box_ids text[] := array[]::text[];
  v_source_box_id text := '';
  v_target_warehouse text := '';
  v_committed_requested_feet integer := 0;
  v_target_requested_feet integer := 0;
  v_target_orphan_requested_feet integer := 0;
  v_created_count integer := 0;
  v_updated_count integer := 0;
  v_deleted_count integer := 0;
  v_normalized_job_number text := app_api.trim_text(p_job_number);
  v_actor_name text := app_api.trim_text(p_actor);
begin
  if v_normalized_job_number = '' then
    return jsonb_build_object(
      'createdCount', 0,
      'updatedCount', 0,
      'deletedCount', 0
    );
  end if;

  select *
  into v_job
  from app.jobs j
  where j.org_id = p_org_id
    and upper(trim(j.job_number)) = upper(trim(v_normalized_job_number))
  limit 1;

  if not found then
    return jsonb_build_object(
      'createdCount', 0,
      'updatedCount', 0,
      'deletedCount', 0
    );
  end if;

  for v_requirement in
    with target_box_ids as (
      select distinct a.box_id
      from app.allocations a
      join app.boxes b
        on b.org_id = a.org_id
       and b.box_id = a.box_id
      where a.org_id = p_org_id
        and a.status = 'ACTIVE'
        and a.requirement_id is not null
        and upper(trim(a.job_number)) = upper(trim(v_normalized_job_number))
        and upper(coalesce(b.status::text, '')) in ('IN_STOCK', 'TRANSFER')
    ),
    reservation_allocations as (
      select
        a.allocation_id,
        a.box_id,
        a.job_number,
        a.job_date,
        a.allocated_feet,
        coalesce(a.covered_feet, a.allocated_feet) as stored_covered_feet,
        a.requirement_id,
        b.width_in as box_width_in,
        b.warehouse::text as box_warehouse,
        app_api.box_physical_feet_available(b) as physical_feet_available,
        coalesce(j.created_at, a.created_at) as job_created_at,
        a.created_at as allocation_created_at
      from app.allocations a
      join target_box_ids tb
        on tb.box_id = a.box_id
      join app.boxes b
        on b.org_id = a.org_id
       and b.box_id = a.box_id
      left join app.jobs j
        on j.org_id = a.org_id
       and upper(trim(j.job_number)) = upper(trim(a.job_number))
      where a.org_id = p_org_id
        and a.status = 'ACTIVE'
        and upper(coalesce(b.status::text, '')) in ('IN_STOCK', 'TRANSFER')
    ),
    reservation_snapshots as (
      select
        ra.*,
        greatest(
          least(
            ra.allocated_feet,
            greatest(
              coalesce(ra.physical_feet_available, 0)
              - coalesce(
                  sum(ra.allocated_feet) over (
                    partition by ra.box_id
                    order by
                      case when ra.job_date is null then 1 else 0 end,
                      ra.job_date asc nulls last,
                      ra.job_created_at asc,
                      ra.allocation_created_at asc,
                      ra.allocation_id asc
                    rows between unbounded preceding and 1 preceding
                  ),
                  0
                ),
              0
            )
          ),
          0
        )::integer as backed_physical_feet
      from reservation_allocations ra
    ),
    requirement_coverage as (
      select
        r.id as requirement_id,
        r.manufacturer,
        r.film_name,
        r.width_in,
        r.required_feet,
        coalesce(
          sum(
            case
              when rs.requirement_id = r.id then
                app_api.compute_covered_feet_from_allocation(
                  rs.backed_physical_feet,
                  rs.box_width_in,
                  r.width_in,
                  rs.stored_covered_feet
                )
              else 0
            end
          ),
          0
        )::integer as backed_covered_feet,
        array_remove(array_agg(distinct case when rs.requirement_id = r.id then rs.box_id end), null) as source_box_ids,
        min(case when rs.requirement_id = r.id then rs.box_id end) as source_box_id,
        min(case when rs.requirement_id = r.id then rs.box_warehouse end) as source_warehouse
      from app.job_requirements r
      left join reservation_snapshots rs
        on rs.requirement_id = r.id
       and upper(trim(rs.job_number)) = upper(trim(v_normalized_job_number))
      where r.org_id = p_org_id
        and r.job_id = v_job.id
      group by r.id, r.manufacturer, r.film_name, r.width_in, r.required_feet
    )
    select *
    from requirement_coverage
  loop
    v_source_box_ids := coalesce(v_requirement.source_box_ids, array[]::text[]);
    v_source_box_id := app_api.trim_text(v_requirement.source_box_id);

    if coalesce(array_length(v_source_box_ids, 1), 0) = 0 or v_source_box_id = '' then
      continue;
    end if;

    v_target_warehouse := app_api.require_org_warehouse(
      p_org_id,
      coalesce(
        nullif(app_api.trim_text(v_requirement.source_warehouse), ''),
        nullif(app_api.trim_text(v_job.warehouse::text), '')
      ),
      'Shortage film order warehouse'
    );
    v_target_requested_feet := greatest(
      case
        when v_job.due_date is not null or coalesce(p_allow_placeholder_shortages, false)
          then coalesce(v_requirement.required_feet, 0) - coalesce(v_requirement.backed_covered_feet, 0)
        else 0
      end,
      0
    );

    select coalesce(sum(fo.requested_feet), 0)::integer
    into v_committed_requested_feet
    from app.film_orders fo
    where fo.org_id = p_org_id
      and upper(trim(fo.job_number)) = upper(trim(v_normalized_job_number))
      and fo.status in ('FILM_ORDER', 'FILM_ON_THE_WAY')
      and fo.source_box_id = any(v_source_box_ids)
      and upper(trim(fo.manufacturer)) = upper(trim(coalesce(v_requirement.manufacturer, '')))
      and upper(trim(fo.film_name)) = upper(trim(coalesce(v_requirement.film_name, '')))
      and coalesce(fo.width_in, 0) = coalesce(v_requirement.width_in, 0)
      and (
        exists (
          select 1
          from app.film_order_box_links l
          where l.org_id = fo.org_id
            and l.film_order_id = fo.film_order_id
        )
        or exists (
          select 1
          from app.allocations a
          where a.org_id = fo.org_id
            and a.film_order_id = fo.film_order_id
            and a.status <> 'CANCELLED'
        )
      );

    v_target_orphan_requested_feet := greatest(v_target_requested_feet - v_committed_requested_feet, 0);

    select coalesce(array_agg(fo.film_order_id order by fo.created_at asc, fo.film_order_id asc), array[]::text[])
    into v_orphan_film_order_ids
    from app.film_orders fo
    where fo.org_id = p_org_id
      and upper(trim(fo.job_number)) = upper(trim(v_normalized_job_number))
      and fo.status in ('FILM_ORDER', 'FILM_ON_THE_WAY')
      and fo.source_box_id = any(v_source_box_ids)
      and upper(trim(fo.manufacturer)) = upper(trim(coalesce(v_requirement.manufacturer, '')))
      and upper(trim(fo.film_name)) = upper(trim(coalesce(v_requirement.film_name, '')))
      and coalesce(fo.width_in, 0) = coalesce(v_requirement.width_in, 0)
      and not exists (
        select 1
        from app.film_order_box_links l
        where l.org_id = fo.org_id
          and l.film_order_id = fo.film_order_id
      )
      and not exists (
        select 1
        from app.allocations a
        where a.org_id = fo.org_id
          and a.film_order_id = fo.film_order_id
          and a.status <> 'CANCELLED'
      );

    v_primary_orphan := null;
    select fo.*
    into v_primary_orphan
    from app.film_orders fo
    where fo.org_id = p_org_id
      and upper(trim(fo.job_number)) = upper(trim(v_normalized_job_number))
      and fo.status in ('FILM_ORDER', 'FILM_ON_THE_WAY')
      and fo.source_box_id = any(v_source_box_ids)
      and upper(trim(fo.manufacturer)) = upper(trim(coalesce(v_requirement.manufacturer, '')))
      and upper(trim(fo.film_name)) = upper(trim(coalesce(v_requirement.film_name, '')))
      and coalesce(fo.width_in, 0) = coalesce(v_requirement.width_in, 0)
      and not exists (
        select 1
        from app.film_order_box_links l
        where l.org_id = fo.org_id
          and l.film_order_id = fo.film_order_id
      )
      and not exists (
        select 1
        from app.allocations a
        where a.org_id = fo.org_id
          and a.film_order_id = fo.film_order_id
          and a.status <> 'CANCELLED'
      )
    order by fo.created_at asc, fo.film_order_id asc
    limit 1;

    if v_target_orphan_requested_feet > 0 and app_api.trim_text(coalesce(v_primary_orphan.film_order_id, '')) <> '' then
      if v_primary_orphan.requested_feet is distinct from v_target_orphan_requested_feet
        or coalesce(v_primary_orphan.covered_feet, 0) <> 0
        or coalesce(v_primary_orphan.ordered_feet, 0) <> 0
        or v_primary_orphan.remaining_to_order_feet is distinct from v_target_orphan_requested_feet
        or v_primary_orphan.job_date is distinct from v_job.due_date
        or coalesce(v_primary_orphan.crew_leader, '') is distinct from coalesce(v_job.crew_leader, '')
        or coalesce(v_primary_orphan.status::text, '') is distinct from 'FILM_ORDER'
        or coalesce(v_primary_orphan.source_box_id, '') is distinct from v_source_box_id
        or coalesce(v_primary_orphan.warehouse::text, '') is distinct from v_target_warehouse
      then
        v_primary_orphan.job_id := v_job.id;
        v_primary_orphan.job_number := v_job.job_number;
        v_primary_orphan.warehouse := v_target_warehouse;
        v_primary_orphan.manufacturer := v_requirement.manufacturer;
        v_primary_orphan.film_name := v_requirement.film_name;
        v_primary_orphan.width_in := v_requirement.width_in;
        v_primary_orphan.requested_feet := v_target_orphan_requested_feet;
        v_primary_orphan.covered_feet := 0;
        v_primary_orphan.ordered_feet := 0;
        v_primary_orphan.remaining_to_order_feet := v_target_orphan_requested_feet;
        v_primary_orphan.job_date := v_job.due_date;
        v_primary_orphan.crew_leader := coalesce(v_job.crew_leader, '');
        v_primary_orphan.status := 'FILM_ORDER';
        v_primary_orphan.source_box_id := v_source_box_id;
        v_primary_orphan.resolved_at := null;
        v_primary_orphan.resolved_by := '';
        perform app_api.save_film_order(v_primary_orphan);
        v_updated_count := v_updated_count + 1;
      end if;
    elsif v_target_orphan_requested_feet > 0 then
      v_new_order := null;
      v_new_order.org_id := p_org_id;
      v_new_order.film_order_id := app_api.create_log_id();
      v_new_order.job_id := v_job.id;
      v_new_order.job_number := v_job.job_number;
      v_new_order.warehouse := v_target_warehouse;
      v_new_order.manufacturer := v_requirement.manufacturer;
      v_new_order.film_name := v_requirement.film_name;
      v_new_order.width_in := v_requirement.width_in;
      v_new_order.requested_feet := v_target_orphan_requested_feet;
      v_new_order.covered_feet := 0;
      v_new_order.ordered_feet := 0;
      v_new_order.remaining_to_order_feet := v_target_orphan_requested_feet;
      v_new_order.job_date := v_job.due_date;
      v_new_order.crew_leader := coalesce(v_job.crew_leader, '');
      v_new_order.status := 'FILM_ORDER';
      v_new_order.source_box_id := v_source_box_id;
      v_new_order.resolved_at := null;
      v_new_order.resolved_by := '';
      v_new_order.notes := format(
        'Created from a shortage while reconciling reserved film for job %s.',
        v_job.job_number
      );
      v_new_order.created_at := now();
      v_new_order.created_by := v_actor_name;
      perform app_api.save_film_order(v_new_order);
      v_created_count := v_created_count + 1;
    end if;

    foreach v_orphan_film_order_id in array coalesce(v_orphan_film_order_ids, array[]::text[])
    loop
      if v_target_orphan_requested_feet > 0
        and v_orphan_film_order_id = app_api.trim_text(coalesce(v_primary_orphan.film_order_id, ''))
      then
        continue;
      end if;

      perform app_api.delete_film_order_links_by_film_order_id(p_org_id, v_orphan_film_order_id);
      perform app_api.delete_film_order(p_org_id, v_orphan_film_order_id);
      v_deleted_count := v_deleted_count + 1;
    end loop;
  end loop;

  return jsonb_build_object(
    'createdCount', v_created_count,
    'updatedCount', v_updated_count,
    'deletedCount', v_deleted_count
  );
end;
$$;
