/**
 * PURPOSE:
 * Adds allocation ownership metadata for the stored reservation planner foundation.
 *
 * AFFECTS:
 * Film allocations, caulk job allocations, Supabase read contracts, and future
 * planner reconciliation rules that must distinguish manual reservations from
 * planner-managed reservations.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * backend/migrations/0084_allocation_source_metadata.sql,
 * backend/src/app/repositories/mappers.mjs, frontend allocation domain types,
 * and Supabase Edge inventory repository mappers.
 *
 * COMMON FAILURE MODES:
 * Backend/Supabase migration drift, legacy rows without MANUAL source metadata,
 * or public allocation payloads missing allocationSource for cached clients.
 */

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n
      on n.oid = t.typnamespace
    where n.nspname = 'app'
      and t.typname = 'allocation_source'
  ) then
    create type app.allocation_source as enum (
      'MANUAL',
      'AUTO_PLANNED',
      'FILM_ORDER_RECEIPT',
      'DIRECT_TO_JOB_SITE'
    );
  end if;
end;
$$;

alter table app.allocations
  add column if not exists allocation_source app.allocation_source;

alter table app.allocations
  alter column allocation_source set default 'MANUAL'::app.allocation_source;

update app.allocations
set allocation_source = 'MANUAL'::app.allocation_source
where allocation_source is null;

alter table app.allocations
  alter column allocation_source set not null;

alter table app.caulk_job_allocations
  add column if not exists allocation_source app.allocation_source;

alter table app.caulk_job_allocations
  alter column allocation_source set default 'MANUAL'::app.allocation_source;

update app.caulk_job_allocations
set allocation_source = 'MANUAL'::app.allocation_source
where allocation_source is null;

alter table app.caulk_job_allocations
  alter column allocation_source set not null;

create index if not exists idx_allocations_org_status_source
  on app.allocations (org_id, status, allocation_source);

create index if not exists idx_caulk_job_allocations_org_status_source
  on app.caulk_job_allocations (org_id, status, allocation_source);

comment on type app.allocation_source is
  'Identifies who owns an allocation reservation. Future planner logic may only mutate AUTO_PLANNED reservations.';

comment on column app.allocations.allocation_source is
  'Reservation ownership source. MANUAL-style sources are hard reservations and must not be auto-reduced by planner reconciliation.';

comment on column app.caulk_job_allocations.allocation_source is
  'Reservation ownership source. MANUAL-style sources are hard reservations and must not be auto-reduced by planner reconciliation.';

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
    'allocationSource', coalesce(p_entry.allocation_source::text, 'MANUAL'),
    'status', coalesce(p_entry.status::text, 'ACTIVE'),
    'createdAt', coalesce(to_char(p_entry.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''),
    'createdBy', coalesce(p_entry.created_by, ''),
    'resolvedAt', coalesce(to_char(p_entry.resolved_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''),
    'resolvedBy', coalesce(p_entry.resolved_by, ''),
    'filmOrderId', coalesce(p_entry.film_order_id, ''),
    'notes', coalesce(p_entry.notes, '')
  );
$$;

drop function if exists public.api_acl_list_caulk_job_allocations_by_job(uuid, text);

create or replace function public.api_acl_list_caulk_job_allocations_by_job(
  p_org_id uuid,
  p_job_number text
)
returns table (
  caulk_allocation_id text,
  requirement_id uuid,
  product_id uuid,
  manufacturer_id uuid,
  manufacturer text,
  product_name text,
  product_code text,
  tubes_per_case integer,
  warehouse text,
  allocated_tubes integer,
  reserved_tubes_remaining integer,
  checked_out_tubes_total integer,
  returned_unused_tubes_total integer,
  used_tubes_total integer,
  overage_tubes_total integer,
  outstanding_checkout_tubes integer,
  open_checkout_count integer,
  status text,
  allocation_source text,
  created_at timestamptz,
  created_by text,
  updated_at timestamptz,
  updated_by text,
  resolved_at timestamptz,
  resolved_by text,
  notes text,
  pending_transfer_id text,
  pending_transfer_source_warehouse text,
  pending_transfer_destination_warehouse text,
  pending_transfer_tubes integer,
  pending_transfer_started_at timestamptz,
  pending_transfer_started_by text,
  pending_transfer_notes text
)
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_org_member(p_org_id);

  return query
  with open_counts as (
    select
      c.caulk_allocation_id,
      count(*)::integer as open_checkout_count
    from app.caulk_job_checkouts c
    where c.org_id = p_org_id
      and c.status = 'OPEN'
    group by c.caulk_allocation_id
  ),
  pending_transfers as (
    select distinct on (t.caulk_allocation_id)
      t.caulk_allocation_id,
      t.transfer_id,
      t.source_warehouse,
      t.destination_warehouse,
      t.pending_tubes,
      t.created_at,
      t.created_by,
      t.notes
    from app.caulk_transfers t
    where t.org_id = p_org_id
      and t.status = 'PENDING'
    order by t.caulk_allocation_id, t.created_at desc, t.id desc
  )
  select
    a.caulk_allocation_id,
    a.requirement_id,
    a.product_id,
    p.manufacturer_id,
    m.name,
    p.name,
    p.code,
    p.tubes_per_case,
    a.warehouse,
    a.allocated_tubes,
    a.reserved_tubes_remaining,
    a.checked_out_tubes_total,
    a.returned_unused_tubes_total,
    a.used_tubes_total,
    a.overage_tubes_total,
    greatest(a.checked_out_tubes_total - a.returned_unused_tubes_total - a.used_tubes_total, 0)::integer,
    coalesce(o.open_checkout_count, 0),
    a.status::text,
    coalesce(a.allocation_source::text, 'MANUAL'),
    a.created_at,
    a.created_by,
    a.updated_at,
    a.updated_by,
    a.resolved_at,
    a.resolved_by,
    a.notes,
    pt.transfer_id,
    pt.source_warehouse,
    pt.destination_warehouse,
    pt.pending_tubes,
    pt.created_at,
    pt.created_by,
    pt.notes
  from app.caulk_job_allocations a
  join app.caulk_products p
    on p.id = a.product_id
   and p.org_id = a.org_id
  join app.caulk_manufacturers m
    on m.id = p.manufacturer_id
   and m.org_id = p.org_id
  left join open_counts o
    on o.caulk_allocation_id = a.id
  left join pending_transfers pt
    on pt.caulk_allocation_id = a.id
  where a.org_id = p_org_id
    and upper(a.job_number) = upper(app_api.require_job_number_digits(p_job_number, 'Job ID number'))
  order by a.created_at desc, a.caulk_allocation_id desc;
end;
$$;

select app_api.grant_execute_if_exists('public.api_acl_list_caulk_job_allocations_by_job(uuid, text)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_caulk_job_allocations_by_job(uuid, text)', 'service_role');
