create or replace function app_api.resolve_caulk_stock_owner_company_id(
  p_org_id uuid,
  p_product_id uuid,
  p_warehouse text,
  p_owner_company_id uuid default null,
  p_stock_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_warehouse text := app_api.caulk_require_warehouse(p_org_id, p_warehouse);
  v_owner_company_id uuid;
  v_count integer := 0;
begin
  if p_stock_id is not null then
    select s.owner_company_id
    into v_owner_company_id
    from app.caulk_stock s
    where s.org_id = p_org_id
      and s.id = p_stock_id
      and s.product_id = p_product_id
      and s.warehouse = v_warehouse
    limit 1;

    if v_owner_company_id is null then
      perform app_api.raise_http(400, 'Caulk stock row was not found for this product and warehouse.');
    end if;
    return v_owner_company_id;
  end if;

  if p_owner_company_id is not null then
    perform app_api.require_owner_company(p_org_id, p_owner_company_id, false);
    return p_owner_company_id;
  end if;

  select count(*)::integer
  into v_count
  from app.caulk_stock s
  where s.org_id = p_org_id
    and s.product_id = p_product_id
    and s.warehouse = v_warehouse;

  if v_count = 1 then
    select s.owner_company_id
    into v_owner_company_id
    from app.caulk_stock s
    where s.org_id = p_org_id
      and s.product_id = p_product_id
      and s.warehouse = v_warehouse
    limit 1;

    return v_owner_company_id;
  end if;

  if v_count = 0 then
    return app_api.default_owner_company_id_for_warehouse(p_org_id, v_warehouse);
  end if;

  perform app_api.raise_http(400, 'Multiple owner rows exist for this caulk product and warehouse. Select an exact owner row.');
end;
$$;
