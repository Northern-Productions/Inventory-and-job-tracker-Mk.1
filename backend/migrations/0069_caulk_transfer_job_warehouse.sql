create or replace function public.api_acl_list_caulk_transfers(
  p_org_id uuid,
  p_warehouse text,
  p_product_id uuid default null
)
returns table (
  transfer_id text,
  caulk_allocation_id text,
  job_number text,
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
    j.warehouse,
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
  left join app.jobs j
    on j.org_id = a.org_id
   and upper(trim(j.job_number)) = upper(trim(a.job_number))
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
