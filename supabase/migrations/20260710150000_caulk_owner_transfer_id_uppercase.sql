/*
 * Canonicalize owner-aware caulk transfer IDs before recording pending transfers.
 *
 * app_api.caulk_create_transaction_id() includes a lowercase md5 suffix, while
 * app.caulk_transfers.caulk_transfers_value_format requires uppercase
 * transfer_id values. The local backend already normalizes transfer IDs before
 * insert; keep the SQL/RPC path aligned with that behavior.
 */

create or replace function app_api.caulk_start_pending_transfer_for_owner(
  p_org_id uuid,
  p_actor text,
  p_allocation_row_id uuid,
  p_allocation_public_id text,
  p_job_id uuid,
  p_job_number text,
  p_product_id uuid,
  p_owner_company_id uuid,
  p_from_warehouse text,
  p_to_warehouse text,
  p_pending_tubes integer,
  p_notes text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_actor text := app_api.trim_text(p_actor);
  v_notes text := app_api.trim_text(p_notes);
  v_destination_warehouse text;
  v_requested_source_warehouse text := app_api.trim_text(p_from_warehouse);
  v_source_warehouse text;
  v_source_stock app.caulk_stock;
  v_source_available integer := 0;
  v_transfer_id text := '';
begin
  if coalesce(p_pending_tubes, 0) <= 0 then
    return jsonb_build_object('transferId', '', 'warnings', '[]'::jsonb);
  end if;

  v_destination_warehouse := app_api.caulk_seed_stock_row_for_owner(
    p_org_id,
    p_actor,
    p_product_id,
    p_to_warehouse,
    p_owner_company_id
  );

  if v_requested_source_warehouse = '' then
    perform app_api.raise_http(
      400,
      format(
        '%s still needs %s tube%s transferred in before this allocation can be saved. Select a source warehouse first.',
        v_destination_warehouse,
        p_pending_tubes,
        case when p_pending_tubes = 1 then '' else 's' end
      )
    );
  end if;

  v_source_warehouse := app_api.caulk_seed_stock_row_for_owner(
    p_org_id,
    p_actor,
    p_product_id,
    v_requested_source_warehouse,
    p_owner_company_id
  );

  if v_source_warehouse = v_destination_warehouse then
    perform app_api.raise_http(400, 'Transfer source and destination warehouse must differ.');
  end if;

  select *
  into v_source_stock
  from app.caulk_stock s
  where s.org_id = p_org_id
    and s.product_id = p_product_id
    and s.warehouse = v_source_warehouse
    and s.owner_company_id = p_owner_company_id
  for update;

  v_source_available := coalesce(v_source_stock.tubes_on_hand, 0);
  if v_source_available < p_pending_tubes then
    perform app_api.raise_http(
      400,
      format(
        '%s only has %s tube%s available for the selected owner; %s tube%s needed to cover the shortage at %s.',
        v_source_warehouse,
        v_source_available,
        case when v_source_available = 1 then '' else 's' end,
        p_pending_tubes,
        case when p_pending_tubes = 1 then '' else 's' end,
        v_destination_warehouse
      )
    );
  end if;

  v_transfer_id := upper(app_api.caulk_create_transaction_id());

  perform app_api.caulk_apply_stock_delta_for_owner(
    p_org_id,
    v_actor,
    p_product_id,
    v_source_warehouse,
    p_owner_company_id,
    'TRANSFER_OUT',
    -p_pending_tubes,
    format('Started caulk transfer from %s to %s for job %s.', v_source_warehouse, v_destination_warehouse, p_job_number),
    v_transfer_id,
    p_allocation_public_id,
    v_notes
  );

  insert into app.caulk_transfers (
    org_id,
    transfer_id,
    caulk_allocation_id,
    job_id,
    job_number,
    product_id,
    owner_company_id,
    source_warehouse,
    destination_warehouse,
    pending_tubes,
    status,
    notes,
    created_by,
    updated_by
  )
  values (
    p_org_id,
    v_transfer_id,
    p_allocation_row_id,
    p_job_id,
    p_job_number,
    p_product_id,
    p_owner_company_id,
    v_source_warehouse,
    v_destination_warehouse,
    p_pending_tubes,
    'PENDING',
    v_notes,
    v_actor,
    v_actor
  );

  return jsonb_build_object(
    'transferId', v_transfer_id,
    'warnings', jsonb_build_array(format('Started caulk transfer %s from %s to %s.', v_transfer_id, v_source_warehouse, v_destination_warehouse))
  );
end;
$$;
