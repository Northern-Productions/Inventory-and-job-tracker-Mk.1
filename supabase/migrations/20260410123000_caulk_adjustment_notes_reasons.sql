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
        and btrim(coalesce(a.job_number, '')) <> ''
        then format('Checked in unused caulk from job %s.', a.job_number)
      when t.action = 'ADJUST'
        and lower(btrim(coalesce(t.reason, ''))) = 'inventory edit'
        and btrim(coalesce(t.notes, '')) <> ''
        then btrim(t.notes)
      else t.reason
    end,
    t.notes,
    t.transfer_id,
    t.source_box_id,
    t.created_at,
    t.created_by
  from app.caulk_transactions t
  join app.caulk_products p
    on p.org_id = t.org_id
   and p.id = t.product_id
  join app.caulk_manufacturers m
    on m.org_id = p.org_id
   and m.id = p.manufacturer_id
  left join app.caulk_job_allocations a
    on a.org_id = t.org_id
   and a.caulk_allocation_id = t.source_box_id
  where t.org_id = p_org_id
    and (v_warehouse = '' or v_warehouse = 'ALL' or t.warehouse = v_warehouse)
    and (p_product_id is null or t.product_id = p_product_id)
  order by t.created_at desc
  limit v_limit;
end;
$$;

create or replace function public.api_acl_caulk_mutate_stock(
  p_org_id uuid,
  p_actor text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_action text := upper(app_api.trim_text(p_payload->>'action'));
  v_product_id uuid := nullif(app_api.trim_text(p_payload->>'productId'), '')::uuid;
  v_warehouse text := p_payload->>'warehouse';
  v_cases integer := coalesce(nullif(app_api.trim_text(p_payload->>'cases'), '')::integer, 0);
  v_tubes integer := coalesce(nullif(app_api.trim_text(p_payload->>'tubes'), '')::integer, 0);
  v_delta_override integer := nullif(app_api.trim_text(p_payload->>'deltaTubes'), '')::integer;
  v_reason text := app_api.trim_text(coalesce(p_payload->>'reason', v_action));
  v_notes text := app_api.trim_text(coalesce(p_payload->>'notes', ''));
  v_tubes_per_case integer;
  v_delta integer;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');

  if v_product_id is null then
    perform app_api.raise_http(400, 'ProductId is required.');
  end if;

  if v_action not in ('RECEIVE', 'USE', 'ADJUST') then
    perform app_api.raise_http(400, 'Action must be RECEIVE, USE, or ADJUST.');
  end if;

  if v_action = 'ADJUST' and v_notes <> '' and lower(v_reason) = 'inventory edit' then
    v_reason := v_notes;
  end if;

  select p.tubes_per_case
  into v_tubes_per_case
  from app.caulk_products p
  where p.org_id = p_org_id
    and p.id = v_product_id
  limit 1;

  if not found then
    perform app_api.raise_http(400, 'Product was not found.');
  end if;

  if v_delta_override is null then
    v_delta := (v_cases * v_tubes_per_case) + v_tubes;
  else
    v_delta := v_delta_override;
  end if;

  if v_action = 'RECEIVE' then
    if v_delta <= 0 then
      perform app_api.raise_http(400, 'Receive requires a positive quantity.');
    end if;
    return app_api.caulk_apply_stock_delta(
      p_org_id,
      p_actor,
      v_product_id,
      v_warehouse,
      'RECEIVE',
      v_delta,
      v_reason,
      '',
      '',
      v_notes
    );
  end if;

  if v_action = 'USE' then
    if v_delta <= 0 then
      perform app_api.raise_http(400, 'Use requires a positive quantity.');
    end if;
    return app_api.caulk_apply_stock_delta(
      p_org_id,
      p_actor,
      v_product_id,
      v_warehouse,
      'USE',
      -v_delta,
      v_reason,
      '',
      '',
      v_notes
    );
  end if;

  if v_delta = 0 then
    perform app_api.raise_http(400, 'Adjust requires a non-zero delta.');
  end if;

  return app_api.caulk_apply_stock_delta(
    p_org_id,
    p_actor,
    v_product_id,
    v_warehouse,
    'ADJUST',
    v_delta,
    v_reason,
    '',
    '',
    v_notes
  );
end;
$$;

select app_api.grant_execute_if_exists('public.api_acl_list_caulk_transactions(uuid, text, uuid, integer)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_caulk_mutate_stock(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_caulk_transactions(uuid, text, uuid, integer)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_caulk_mutate_stock(uuid, text, jsonb)', 'service_role');
