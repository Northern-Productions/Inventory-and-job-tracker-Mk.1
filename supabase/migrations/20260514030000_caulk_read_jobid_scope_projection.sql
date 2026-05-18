/*
 * PURPOSE:
 * Adds reliable row-derived job identity to caulk transfer and transaction read
 * projections so the app layer can attach Work Scope by jobId later without
 * falling back to jobNumber-only lookups.
 *
 * AFFECTS:
 * public.api_acl_list_caulk_transfers and
 * public.api_acl_list_caulk_transactions read response shapes only.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * local caulk read mappers, Supabase Edge caulk read handlers, frontend caulk
 * public types, contract parity, and duplicate job-number guard tests.
 *
 * COMMON FAILURE MODES:
 * Parsing transaction reason text, inferring scope from jobNumber, changing
 * transfer/transaction filtering or ordering, touching stock math, or changing
 * mutation RPCs.
 */

drop function if exists public.api_acl_list_caulk_transfers(uuid, text, uuid);

create or replace function public.api_acl_list_caulk_transfers(
  p_org_id uuid,
  p_warehouse text,
  p_product_id uuid default null
)
returns table (
  transfer_id text,
  caulk_allocation_id text,
  job_number text,
  job_id uuid,
  job_warehouse text,
  product_id uuid,
  manufacturer_id uuid,
  manufacturer text,
  product_name text,
  product_code text,
  tubes_per_case integer,
  source_warehouse text,
  destination_warehouse text,
  pending_tubes integer,
  status text,
  created_at timestamptz,
  created_by text,
  received_at timestamptz,
  received_by text,
  cancelled_at timestamptz,
  cancelled_by text,
  updated_at timestamptz,
  updated_by text,
  notes text
)
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_warehouse text := app_api.caulk_require_warehouse(p_org_id, p_warehouse);
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'read');

  return query
  select
    t.transfer_id,
    a.caulk_allocation_id,
    a.job_number,
    coalesce(t.job_id, a.job_id),
    coalesce(job_by_id.warehouse, legacy_job.warehouse),
    p.id,
    p.manufacturer_id,
    m.name,
    p.name,
    p.code,
    p.tubes_per_case,
    t.source_warehouse,
    t.destination_warehouse,
    t.pending_tubes,
    t.status::text,
    t.created_at,
    t.created_by,
    t.received_at,
    t.received_by,
    t.cancelled_at,
    t.cancelled_by,
    t.updated_at,
    t.updated_by,
    t.notes
  from app.caulk_transfers t
  join app.caulk_job_allocations a
    on a.org_id = t.org_id
   and a.id = t.caulk_allocation_id
  left join app.jobs job_by_id
    on job_by_id.org_id = t.org_id
   and job_by_id.id = coalesce(t.job_id, a.job_id)
  left join app.jobs legacy_job
    on legacy_job.org_id = a.org_id
   and coalesce(t.job_id, a.job_id) is null
   and upper(trim(legacy_job.job_number)) = upper(trim(a.job_number))
  join app.caulk_products p
    on p.org_id = t.org_id
   and p.id = t.product_id
  join app.caulk_manufacturers m
    on m.org_id = p.org_id
   and m.id = p.manufacturer_id
  where t.org_id = p_org_id
    and t.status = 'PENDING'
    and t.destination_warehouse = v_warehouse
    and (p_product_id is null or t.product_id = p_product_id)
  order by t.created_at desc, t.id desc;
end;
$$;

select app_api.grant_execute_if_exists('public.api_acl_list_caulk_transfers(uuid, text, uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_caulk_transfers(uuid, text, uuid)', 'service_role');

drop function if exists public.api_acl_list_caulk_transactions(uuid, text, uuid, integer);

create or replace function public.api_acl_list_caulk_transactions(
  p_org_id uuid,
  p_warehouse text default '',
  p_product_id uuid default null,
  p_limit integer default 200
)
returns table (
  transaction_id text,
  product_id uuid,
  warehouse text,
  manufacturer text,
  product_name text,
  product_code text,
  action text,
  delta_tubes integer,
  resulting_tubes_on_hand integer,
  tubes_per_case integer,
  reason text,
  notes text,
  transfer_id text,
  source_box_id text,
  job_id uuid,
  job_number text,
  job_warehouse text,
  created_at timestamptz,
  created_by text
)
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_warehouse text := upper(btrim(coalesce(p_warehouse, '')));
  v_limit integer := greatest(1, least(coalesce(p_limit, 200), 1000));
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'read');

  if v_warehouse <> '' and v_warehouse <> 'ALL' then
    v_warehouse := app_api.caulk_require_warehouse(p_org_id, v_warehouse);
  end if;

  return query
  select
    t.transaction_id,
    t.product_id,
    t.warehouse,
    m.name,
    p.name,
    p.code,
    t.action,
    t.delta_tubes,
    t.resulting_tubes_on_hand,
    t.tubes_per_case,
    case
      when t.action = 'JOB_CHECKIN_UNUSED'
        and btrim(coalesce(source_allocation.job_number, '')) <> ''
        then format('Checked in unused caulk from job %s.', source_allocation.job_number)
      when t.action = 'ADJUST'
        and lower(btrim(coalesce(t.reason, ''))) = 'inventory edit'
        and btrim(coalesce(t.notes, '')) <> ''
        then btrim(t.notes)
      else t.reason
    end,
    t.notes,
    t.transfer_id,
    t.source_box_id,
    resolved_job.id,
    resolved_job.job_number,
    resolved_job.warehouse,
    t.created_at,
    t.created_by
  from app.caulk_transactions t
  join app.caulk_products p
    on p.org_id = t.org_id
   and p.id = t.product_id
  join app.caulk_manufacturers m
    on m.org_id = p.org_id
   and m.id = p.manufacturer_id
  left join app.caulk_job_allocations source_allocation
    on source_allocation.org_id = t.org_id
   and source_allocation.caulk_allocation_id = t.source_box_id
  left join app.caulk_transfers source_transfer
    on source_transfer.org_id = t.org_id
   and source_transfer.transfer_id = t.transfer_id
   and btrim(coalesce(t.transfer_id, '')) <> ''
  left join app.caulk_job_allocations transfer_allocation
    on transfer_allocation.org_id = source_transfer.org_id
   and transfer_allocation.id = source_transfer.caulk_allocation_id
  left join app.jobs resolved_job
    on resolved_job.org_id = t.org_id
   and resolved_job.id = coalesce(source_allocation.job_id, source_transfer.job_id, transfer_allocation.job_id)
  where t.org_id = p_org_id
    and (v_warehouse = '' or v_warehouse = 'ALL' or t.warehouse = v_warehouse)
    and (p_product_id is null or t.product_id = p_product_id)
  order by t.created_at desc
  limit v_limit;
end;
$$;

select app_api.grant_execute_if_exists('public.api_acl_list_caulk_transactions(uuid, text, uuid, integer)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_caulk_transactions(uuid, text, uuid, integer)', 'service_role');
