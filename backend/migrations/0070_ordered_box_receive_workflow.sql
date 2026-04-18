create or replace function public.api_acl_boxes_receive_ordered(
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
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_lookup_box_id text;
  v_box app.boxes;
  v_received_weight_text text := app_api.trim_text(v_payload->>'receivedWeightLbs');
  v_received_weight_lbs numeric := null;
  v_lot_run text := app_api.trim_text(v_payload->>'lotRun');
  v_locked_allocated_feet integer := 0;
  v_audit_note text;
  v_result jsonb;
  v_receipt_result jsonb := '{}'::jsonb;
  v_warnings text[] := array[]::text[];
  v_log_id text := '';
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');
  v_lookup_box_id := app_api.resolve_box_id_alias(
    p_org_id,
    app_api.require_text(v_payload->>'boxId', 'BoxID')
  );

  select *
  into v_box
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = v_lookup_box_id
  limit 1;

  if not found then
    perform app_api.raise_http(404, 'Box not found.');
  end if;

  if upper(coalesce(v_box.status::text, '')) = 'TRANSFER' then
    perform app_api.raise_http(
      400,
      format(
        'Box %s has a pending transfer and can only be received or have the transfer cancelled.',
        v_lookup_box_id
      )
    );
  end if;

  if upper(coalesce(v_box.status::text, '')) = 'ZEROED' then
    perform app_api.raise_http(400, 'Zeroed boxes cannot be received as ordered inventory.');
  end if;

  if upper(coalesce(v_box.status::text, '')) = 'RETIRED' then
    perform app_api.raise_http(400, 'Retired boxes cannot be received as ordered inventory.');
  end if;

  if upper(coalesce(v_box.status::text, '')) <> 'ORDERED' then
    perform app_api.raise_http(
      400,
      format('Only boxes currently in ORDERED status can be received. %s is %s.', v_lookup_box_id, coalesce(v_box.status::text, 'UNKNOWN'))
    );
  end if;

  if v_box.received_date is not null then
    perform app_api.raise_http(
      400,
      format('Box %s already has a received date and cannot be received again.', v_lookup_box_id)
    );
  end if;

  if v_received_weight_text <> '' then
    begin
      v_received_weight_lbs := round((v_received_weight_text)::numeric, 2);
    exception
      when invalid_text_representation then
        perform app_api.raise_http(400, 'ReceivedWeightLbs must be a valid non-negative number.');
    end;

    if v_received_weight_lbs < 0 then
      perform app_api.raise_http(400, 'ReceivedWeightLbs must be a valid non-negative number.');
    end if;
  end if;

  if v_lot_run = '' then
    v_lot_run := coalesce(v_box.lot_run, '');
  end if;

  v_locked_allocated_feet := app_api.locked_allocated_feet_for_box(p_org_id, v_lookup_box_id);
  v_audit_note := format('Received ordered box %s', v_lookup_box_id);

  if v_received_weight_lbs is not null then
    v_audit_note := format('%s at %s lbs', v_audit_note, trim(trailing '.' from trim(trailing '0' from v_received_weight_lbs::text)));
  end if;

  if v_lot_run <> '' then
    v_audit_note := format('%s with lot run %s', v_audit_note, v_lot_run);
  end if;

  v_payload := jsonb_build_object(
    'boxId', v_lookup_box_id,
    'manufacturer', v_box.manufacturer,
    'filmName', v_box.film_name,
    'widthIn', v_box.width_in,
    'initialFeet', v_box.initial_feet,
    'feetAvailable', greatest(coalesce(v_box.initial_feet, 0) - coalesce(v_locked_allocated_feet, 0), 0),
    'lotRun', v_lot_run,
    'orderDate', coalesce(to_char(v_box.order_date, 'YYYY-MM-DD'), ''),
    'receivedDate', to_char(current_date, 'YYYY-MM-DD'),
    'initialWeightLbs', case when v_received_weight_lbs is not null then v_received_weight_lbs else v_box.initial_weight_lbs end,
    'lastRollWeightLbs', case when v_received_weight_lbs is not null then v_received_weight_lbs else v_box.last_roll_weight_lbs end,
    'lastWeighedDate', case when v_received_weight_lbs is not null then to_char(current_date, 'YYYY-MM-DD') else coalesce(to_char(v_box.last_weighed_date, 'YYYY-MM-DD'), '') end,
    'filmKey', coalesce(v_box.film_key, ''),
    'coreType', coalesce(v_box.core_type, ''),
    'coreWeightLbs', v_box.core_weight_lbs,
    'lfWeightLbsPerFt', v_box.lf_weight_lbs_per_ft,
    'pricePerLf', v_box.price_per_lf,
    'purchaseCost', v_box.purchase_cost,
    'notes', coalesce(v_box.notes, ''),
    'auditNote', v_audit_note
  );

  v_result := public.api_boxes_update(p_org_id, p_actor, v_payload);
  v_log_id := app_api.trim_text(v_result->>'logId');
  if jsonb_typeof(coalesce(v_result->'warnings', '[]'::jsonb)) = 'array' then
    v_warnings := array(select jsonb_array_elements_text(coalesce(v_result->'warnings', '[]'::jsonb)));
  end if;

  if v_log_id <> '' then
    select *
    into v_box
    from app.boxes b
    where b.org_id = p_org_id
      and b.box_id = v_lookup_box_id
    limit 1;

    if found and upper(coalesce(v_box.status::text, '')) = 'IN_STOCK' then
      v_receipt_result := app_api.process_linked_box_receipt(p_org_id, v_box, p_actor);
      if coalesce(v_receipt_result, '{}'::jsonb) ? 'box' then
        v_box := jsonb_populate_record(null::app.boxes, v_receipt_result->'box');
        v_box := app_api.save_box(v_box);
      end if;
      if jsonb_typeof(coalesce(v_receipt_result->'warnings', '[]'::jsonb)) = 'array' then
        v_warnings := v_warnings || array(
          select jsonb_array_elements_text(coalesce(v_receipt_result->'warnings', '[]'::jsonb))
        );
      end if;
    end if;

    update app.audit_log
    set action = 'SET_STATUS',
        notes = v_audit_note,
        after_state = case
          when found then app_api.public_box_json(v_box)
          else after_state
        end
    where org_id = p_org_id
      and log_id = v_log_id;

    if found and upper(coalesce(v_box.status::text, '')) in ('IN_STOCK', 'TRANSFER') then
      perform app_api.recalculate_physical_box_allocatable_now(p_org_id, v_lookup_box_id);
      perform app_api.reconcile_auto_shortage_film_orders_for_box(
        p_org_id,
        p_actor,
        v_lookup_box_id,
        true
      );
    end if;
  end if;

  if coalesce(array_length(v_warnings, 1), 0) > 0 then
    v_result := jsonb_set(v_result, '{warnings}', to_jsonb(v_warnings), true);
  end if;

  return v_result;
end;
$$;

select app_api.grant_execute_if_exists('public.api_acl_boxes_receive_ordered(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_boxes_receive_ordered(uuid, text, jsonb)', 'service_role');
