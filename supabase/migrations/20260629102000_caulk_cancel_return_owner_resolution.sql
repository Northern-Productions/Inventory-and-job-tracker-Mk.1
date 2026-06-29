-- Ensure caulk allocation cancel-return stock deltas use the allocation owner row.
-- Stage A only: this preserves the current available-stock caulk model.

create or replace function app_api.caulk_apply_stock_delta(
  p_org_id uuid,
  p_actor text,
  p_product_id uuid,
  p_warehouse text,
  p_action text,
  p_delta_tubes integer,
  p_reason text,
  p_transfer_id text default '',
  p_source_box_id text default '',
  p_notes text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_action text := upper(app_api.trim_text(p_action));
  v_warehouse text := app_api.caulk_require_warehouse(p_org_id, p_warehouse);
  v_owner_company_id uuid;
begin
  v_owner_company_id := coalesce(
    case
      when v_action = 'JOB_ALLOCATION_CANCEL_RETURN' then
        app_api.caulk_owner_from_allocation_public_id(p_org_id, p_source_box_id)
      else null
    end,
    app_api.resolve_caulk_stock_owner_company_id(
      p_org_id,
      p_product_id,
      v_warehouse,
      null,
      null
    )
  );

  return app_api.caulk_apply_stock_delta_for_owner(
    p_org_id,
    p_actor,
    p_product_id,
    v_warehouse,
    v_owner_company_id,
    p_action,
    p_delta_tubes,
    p_reason,
    p_transfer_id,
    p_source_box_id,
    p_notes
  );
end;
$$;

do $$
declare
  v_def text;
begin
  select pg_get_functiondef(
    'app_api.caulk_apply_stock_delta(uuid, text, uuid, text, text, integer, text, text, text, text)'::regprocedure
  )
  into v_def;

  if position('v_action = ''JOB_ALLOCATION_CANCEL_RETURN''' in v_def) = 0
     or position('app_api.caulk_owner_from_allocation_public_id(p_org_id, p_source_box_id)' in v_def) = 0
     or position('app_api.resolve_caulk_stock_owner_company_id' in v_def) = 0
     or position('app_api.caulk_apply_stock_delta_for_owner' in v_def) = 0 then
    raise exception 'caulk_apply_stock_delta does not resolve cancel-return owner rows safely';
  end if;
end;
$$;
