-- Reassert covered-feet persistence helpers after live function drift and
-- repair persisted allocation rows that were saved with covered_feet = 0.

create or replace function app_api.save_allocation(p_allocation app.allocations)
returns app.allocations
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_row app.allocations;
begin
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
    allocation_kind
  )
  values (
    coalesce(p_allocation.id, gen_random_uuid()),
    p_allocation.org_id,
    p_allocation.allocation_id,
    p_allocation.box_id,
    p_allocation.job_id,
    p_allocation.job_number,
    p_allocation.warehouse,
    p_allocation.job_date,
    p_allocation.allocated_feet,
    coalesce(p_allocation.covered_feet, p_allocation.allocated_feet),
    p_allocation.requirement_id,
    p_allocation.status,
    coalesce(p_allocation.created_at, now()),
    coalesce(p_allocation.created_by, ''),
    p_allocation.resolved_at,
    coalesce(p_allocation.resolved_by, ''),
    coalesce(p_allocation.notes, ''),
    coalesce(p_allocation.crew_leader, ''),
    coalesce(p_allocation.film_order_id, ''),
    coalesce(p_allocation.allocation_kind, 'REQUIREMENT'::app.allocation_kind)
  )
  on conflict (org_id, allocation_id) do update set
    box_id = excluded.box_id,
    job_id = excluded.job_id,
    job_number = excluded.job_number,
    warehouse = excluded.warehouse,
    job_date = excluded.job_date,
    allocated_feet = excluded.allocated_feet,
    covered_feet = excluded.covered_feet,
    requirement_id = excluded.requirement_id,
    status = excluded.status,
    created_at = excluded.created_at,
    created_by = excluded.created_by,
    resolved_at = excluded.resolved_at,
    resolved_by = excluded.resolved_by,
    notes = excluded.notes,
    crew_leader = excluded.crew_leader,
    film_order_id = excluded.film_order_id,
    allocation_kind = excluded.allocation_kind
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function app_api.public_allocation_json(p_entry app.allocations)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'allocationId', coalesce(p_entry.allocation_id, ''),
    'boxId', coalesce(p_entry.box_id, ''),
    'warehouse', coalesce(p_entry.warehouse::text, ''),
    'jobNumber', coalesce(p_entry.job_number, ''),
    'jobDate', coalesce(to_char(p_entry.job_date, 'YYYY-MM-DD'), ''),
    'crewLeader', coalesce(p_entry.crew_leader, ''),
    'allocatedFeet', p_entry.allocated_feet,
    'coveredFeet', coalesce(p_entry.covered_feet, p_entry.allocated_feet),
    'requirementId', coalesce(p_entry.requirement_id::text, ''),
    'allocationKind', coalesce(p_entry.allocation_kind::text, 'REQUIREMENT'),
    'status', coalesce(p_entry.status::text, 'ACTIVE'),
    'createdAt', coalesce(to_char(p_entry.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''),
    'createdBy', coalesce(p_entry.created_by, ''),
    'resolvedAt', coalesce(to_char(p_entry.resolved_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''),
    'resolvedBy', coalesce(p_entry.resolved_by, ''),
    'filmOrderId', coalesce(p_entry.film_order_id, ''),
    'notes', coalesce(p_entry.notes, '')
  );
$$;

with covered_feet_backfill as (
  select
    a.id,
    case
      when a.requirement_id is not null
        and jr.id is not null
        and b.box_id is not null
        and b.width_in is not null
        and jr.width_in is not null
        and jr.required_feet is not null then
          greatest(
            app_api.compute_covered_feet_from_allocation(
              a.allocated_feet,
              b.width_in,
              jr.width_in,
              jr.required_feet
            ),
            0
          )
      else greatest(a.allocated_feet, 0)
    end as next_covered_feet
  from app.allocations a
  left join app.boxes b
    on b.org_id = a.org_id
   and b.box_id = a.box_id
  left join app.job_requirements jr
    on jr.org_id = a.org_id
   and jr.id = a.requirement_id
  where a.allocated_feet > 0
    and coalesce(a.covered_feet, 0) = 0
)
update app.allocations a
set covered_feet = covered_feet_backfill.next_covered_feet
from covered_feet_backfill
where a.id = covered_feet_backfill.id
  and a.allocated_feet > 0
  and coalesce(a.covered_feet, 0) = 0;
