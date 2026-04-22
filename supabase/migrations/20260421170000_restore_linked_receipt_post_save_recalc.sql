-- Restore post-save linked film-order recalculation for receipt flows.
--
-- The original 0077 implementation relied on exact text replacement inside
-- existing function bodies. Production now shows that those functions are
-- semantically correct for 0076 but not text-identical to the snippet this
-- migration expected, so the pending migration must replace the functions
-- directly instead of mutating them by pattern.

create or replace function public.api_boxes_add(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_existing app.boxes;
  v_build jsonb;
  v_box app.boxes;
  v_public_box jsonb;
  v_log_id text;
  v_film_order_id text := app_api.trim_text(p_payload->>'filmOrderId');
  v_link app.film_order_box_links;
  v_order app.film_orders;
  v_receipt_result jsonb;
  v_warnings text[] := array[]::text[];
  v_requested_warehouse text := app_api.trim_text(p_payload->>'warehouse');
begin
  perform app_api.require_org_member(p_org_id);

  select *
  into v_existing
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = app_api.require_text(p_payload->>'boxId', 'BoxID')
  for update;

  if found then
    perform app_api.raise_http(400, 'A box with this BoxID already exists.');
  end if;

  if v_requested_warehouse <> '' then
    v_requested_warehouse := app_api.require_org_warehouse(p_org_id, v_requested_warehouse, 'Warehouse');
  end if;

  v_build := app_api.build_box_from_payload(p_org_id, p_payload, null);
  v_box := jsonb_populate_record(null::app.boxes, v_build->'box');
  v_box.dealer := app_api.trim_text(p_payload->>'dealer');
  v_warnings := coalesce(array(select jsonb_array_elements_text(v_build->'warnings')), array[]::text[]);

  if v_requested_warehouse <> '' and v_box.warehouse <> v_requested_warehouse then
    perform app_api.raise_http(
      400,
      format(
        'BoxID %s resolves to warehouse %s, not %s. Update the BoxID prefix or warehouse selection.',
        v_box.box_id,
        v_box.warehouse,
        v_requested_warehouse
      )
    );
  end if;

  v_box := app_api.save_box(v_box);

  if v_film_order_id <> '' then
    select *
    into v_order
    from app.film_orders f
    where f.org_id = p_org_id
      and f.film_order_id = v_film_order_id
    for update;

    if not found then
      perform app_api.raise_http(404, 'Film Order not found.');
    end if;

    if v_order.status = 'CANCELLED' then
      perform app_api.raise_http(400, 'Cancelled Film Orders cannot receive new boxes.');
    end if;

    v_link.id := gen_random_uuid();
    v_link.org_id := p_org_id;
    v_link.link_id := app_api.create_log_id();
    v_link.film_order_id := v_order.film_order_id;
    v_link.box_id := v_box.box_id;
    v_link.ordered_feet := v_box.initial_feet;
    v_link.auto_allocated_feet := 0;
    v_link.created_at := now();
    v_link.created_by := app_api.trim_text(p_actor);
    perform app_api.save_film_order_link(v_link);
    perform app_api.recalculate_film_order(p_org_id, v_order.film_order_id, p_actor);
    v_warnings := app_api.push_warning(
      v_warnings,
      format('Box %s was linked to Film Order %s for job %s.', v_box.box_id, v_order.film_order_id, v_order.job_number)
    );

    if v_box.received_date is not null and v_box.status = 'IN_STOCK' then
      v_receipt_result := app_api.process_linked_box_receipt(p_org_id, v_box, p_actor);
      v_box := jsonb_populate_record(null::app.boxes, v_receipt_result->'box');
      v_box := app_api.save_box(v_box);
      perform app_api.recalculate_film_orders_for_box_links(p_org_id, v_box.box_id, p_actor);
      v_warnings := array_cat(
        v_warnings,
        coalesce(array(select jsonb_array_elements_text(v_receipt_result->'warnings')), array[]::text[])
      );
    end if;
  end if;

  v_public_box := app_api.public_box_json(v_box);
  v_log_id := app_api.append_audit_entry(
    p_org_id,
    'ADD_BOX',
    v_box.box_id,
    null,
    v_public_box,
    p_actor,
    app_api.trim_text(p_payload->>'auditNote')
  );

  return jsonb_build_object(
    'boxId', v_box.box_id,
    'logId', v_log_id,
    'warnings', to_jsonb(v_warnings)
  );
end;
$$;

create or replace function public.api_boxes_update(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_existing app.boxes;
  v_build jsonb;
  v_box app.boxes;
  v_public_before jsonb;
  v_public_after jsonb;
  v_receipt_result jsonb;
  v_log_id text;
  v_warnings text[] := array[]::text[];
  v_move_to_zeroed boolean := coalesce((p_payload->>'moveToZeroed')::boolean, false);
  v_reactivate_from_zeroed boolean := coalesce((p_payload->>'reactivateFromZeroed')::boolean, false);
  v_has_submitted_current_feet_on_roll boolean := coalesce(p_payload, '{}'::jsonb) ? 'currentFeetOnRoll';
  v_current_feet_on_roll_input integer;
  v_requested_feet_available integer;
  v_confirmed_zero_feet_move boolean := false;
  v_confirmed_zero_weight_move boolean := false;
  v_confirmed_incomplete_history_move boolean := false;
  v_has_positive_reactivation_signal boolean := false;
  v_should_reactivate boolean := false;
  v_audit_action text := 'UPDATE_BOX';
begin
  perform app_api.require_org_member(p_org_id);

  select *
  into v_existing
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = app_api.require_text(p_payload->>'boxId', 'BoxID')
  for update;

  if not found then
    perform app_api.raise_http(404, 'Box not found.');
  end if;

  v_build := app_api.build_box_from_payload(p_org_id, p_payload, v_existing.box_id);
  v_box := jsonb_populate_record(null::app.boxes, v_build->'box');
  v_box.dealer := case
    when coalesce(p_payload, '{}'::jsonb) ? 'dealer' then app_api.trim_text(p_payload->>'dealer')
    else coalesce(v_existing.dealer, '')
  end;
  v_warnings := coalesce(array(select jsonb_array_elements_text(v_build->'warnings')), array[]::text[]);

  if v_has_submitted_current_feet_on_roll and app_api.trim_text(p_payload->>'currentFeetOnRoll') <> '' then
    v_current_feet_on_roll_input := floor((app_api.trim_text(p_payload->>'currentFeetOnRoll'))::numeric);
  else
    v_current_feet_on_roll_input := null;
  end if;

  v_requested_feet_available := case
    when app_api.trim_text(p_payload->>'feetAvailable') = '' then null
    else floor((app_api.trim_text(p_payload->>'feetAvailable'))::numeric)
  end;

  if v_existing.status = 'ZEROED' then
    v_has_positive_reactivation_signal :=
      coalesce(v_box.feet_available, 0) > 0
      or coalesce(v_box.last_roll_weight_lbs, 0) > 0;

    if v_has_positive_reactivation_signal and not v_reactivate_from_zeroed then
      perform app_api.raise_http(
        400,
        'Zeroed boxes with new active inventory values must be confirmed before moving back to IN_STOCK.'
      );
    end if;

    v_should_reactivate := v_has_positive_reactivation_signal and v_reactivate_from_zeroed;

    if v_should_reactivate then
      v_box.status := 'IN_STOCK';
      v_box.zeroed_date := null;
      v_box.zeroed_reason := '';
      v_box.zeroed_by := '';
      v_warnings := app_api.push_warning(
        v_warnings,
        format('Box %s was moved back to active IN_STOCK inventory.', v_box.box_id)
      );
      v_audit_action := 'SET_STATUS';
    else
      v_box.status := 'ZEROED';
      v_box.zeroed_date := v_existing.zeroed_date;
      v_box.zeroed_reason := coalesce(v_existing.zeroed_reason, '');
      v_box.zeroed_by := coalesce(v_existing.zeroed_by, '');
    end if;

    v_box := app_api.save_box(v_box);
    v_public_before := app_api.public_box_json(v_existing);
    v_public_after := app_api.public_box_json(v_box);
    v_log_id := app_api.append_audit_entry(
      p_org_id,
      v_audit_action,
      v_box.box_id,
      v_public_before,
      v_public_after,
      p_actor,
      app_api.trim_text(p_payload->>'auditNote')
    );

    return jsonb_build_object(
      'boxId', v_box.box_id,
      'logId', v_log_id,
      'warnings', to_jsonb(v_warnings)
    );
  end if;

  v_confirmed_zero_feet_move :=
    v_move_to_zeroed
    and v_existing.received_date is not null
    and app_api.has_positive_physical_feet(v_existing)
    and (
      (
        v_has_submitted_current_feet_on_roll
        and v_current_feet_on_roll_input is not null
        and v_current_feet_on_roll_input <= 0
      )
      or (
        not v_has_submitted_current_feet_on_roll
        and v_requested_feet_available is not null
        and v_requested_feet_available <= 0
      )
    );

  if v_confirmed_zero_feet_move then
    v_box.feet_available := 0;
  end if;

  v_confirmed_zero_weight_move :=
    v_move_to_zeroed
    and v_existing.received_date is not null
    and app_api.has_positive_physical_feet(v_existing)
    and coalesce(v_box.last_roll_weight_lbs, 0) = 0;

  v_confirmed_incomplete_history_move :=
    v_move_to_zeroed
    and coalesce(v_box.last_roll_weight_lbs, 0) = 0
    and (
      v_existing.received_date is null
      or v_existing.initial_weight_lbs is null
      or v_existing.core_weight_lbs is null
      or v_existing.last_weighed_date is null
      or v_box.received_date is null
      or v_box.initial_weight_lbs is null
      or v_box.core_weight_lbs is null
      or v_box.last_weighed_date is null
    );

  if v_move_to_zeroed and not (
    v_confirmed_incomplete_history_move
    or v_confirmed_zero_feet_move
    or v_confirmed_zero_weight_move
  ) then
    perform app_api.raise_http(
      400,
      'Received boxes move to zeroed out inventory only after they have had Available Feet above 0 and then reach 0 Available Feet or 0 Last Roll Weight.'
    );
  end if;

  if v_confirmed_incomplete_history_move or v_confirmed_zero_feet_move or v_confirmed_zero_weight_move then
    v_box.status := 'ZEROED';
    v_box.feet_available := 0;
    v_box.zeroed_date := app_api.today_date();
    v_box.zeroed_reason := app_api.determine_zeroed_reason(v_box.feet_available, v_box.last_roll_weight_lbs);
    v_box.zeroed_by := app_api.trim_text(p_actor);
    if app_api.trim_text(p_payload->>'auditNote') <> '' then
      v_box.zeroed_reason := v_box.zeroed_reason || ' Additional note: ' || app_api.normalize_meaningful_zeroed_note(p_payload->>'auditNote');
    end if;
    perform app_api.cancel_active_allocations_for_box(
      p_org_id,
      v_box.box_id,
      p_actor,
      'Auto-cancelled because the box was moved to zeroed out inventory.'
    );
    if v_confirmed_incomplete_history_move then
      v_warnings := app_api.push_warning(
        v_warnings,
        'Box was moved to zeroed out inventory after confirming a 0 Last Roll Weight save on a box with incomplete history.'
      );
    elsif v_confirmed_zero_feet_move then
      v_warnings := app_api.push_warning(
        v_warnings,
        'Box was moved to zeroed out inventory after confirming a Current Linear Feet value of 0 on a received box with recorded physical feet.'
      );
    elsif v_confirmed_zero_weight_move then
      v_warnings := app_api.push_warning(
        v_warnings,
        'Box was moved to zeroed out inventory after confirming a Last Roll Weight value of 0 on a received box with recorded physical feet.'
      );
    end if;
    v_audit_action := 'ZERO_OUT_BOX';
  else
    v_receipt_result := app_api.process_linked_box_receipt(p_org_id, v_box, p_actor);
    v_box := jsonb_populate_record(null::app.boxes, v_receipt_result->'box');
    v_box.dealer := case
      when coalesce(p_payload, '{}'::jsonb) ? 'dealer' then app_api.trim_text(p_payload->>'dealer')
      else coalesce(v_existing.dealer, '')
    end;
    v_warnings := array_cat(
      v_warnings,
      coalesce(array(select jsonb_array_elements_text(v_receipt_result->'warnings')), array[]::text[])
    );
  end if;

  v_box := app_api.save_box(v_box);
  if v_box.status <> 'CHECKED_OUT' then
    perform app_api.recalculate_film_orders_for_box_links(p_org_id, v_box.box_id, p_actor);
  end if;
  v_public_before := app_api.public_box_json(v_existing);
  v_public_after := app_api.public_box_json(v_box);
  v_log_id := app_api.append_audit_entry(
    p_org_id,
    v_audit_action,
    v_box.box_id,
    v_public_before,
    v_public_after,
    p_actor,
    app_api.trim_text(p_payload->>'auditNote')
  );

  return jsonb_build_object(
    'boxId', v_box.box_id,
    'logId', v_log_id,
    'warnings', to_jsonb(v_warnings)
  );
end;
$$;

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
  v_existing app.boxes;
  v_box app.boxes;
  v_received_weight_text text := app_api.trim_text(v_payload->>'receivedWeightLbs');
  v_received_weight_lbs numeric := null;
  v_lot_run text := app_api.trim_text(v_payload->>'lotRun');
  v_locked_allocated_feet integer := 0;
  v_receipt_result jsonb := '{}'::jsonb;
  v_reconcile_result jsonb := '{}'::jsonb;
  v_warnings text[] := array[]::text[];
  v_log_id text := '';
  v_audit_note text;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');
  v_lookup_box_id := app_api.resolve_box_id_alias(
    p_org_id,
    app_api.require_text(v_payload->>'boxId', 'BoxID')
  );

  select *
  into v_existing
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = v_lookup_box_id
  limit 1;

  if not found then
    perform app_api.raise_http(404, 'Box not found.');
  end if;

  if upper(coalesce(v_existing.status::text, '')) = 'TRANSFER' then
    perform app_api.raise_http(
      400,
      format(
        'Box %s has a pending transfer and can only be received or have the transfer cancelled.',
        v_lookup_box_id
      )
    );
  end if;

  if upper(coalesce(v_existing.status::text, '')) = 'ZEROED' then
    perform app_api.raise_http(400, 'Zeroed boxes cannot be received as ordered inventory.');
  end if;

  if upper(coalesce(v_existing.status::text, '')) = 'RETIRED' then
    perform app_api.raise_http(400, 'Retired boxes cannot be received as ordered inventory.');
  end if;

  if upper(coalesce(v_existing.status::text, '')) <> 'ORDERED' then
    perform app_api.raise_http(
      400,
      format(
        'Only boxes currently in ORDERED status can be received. %s is %s.',
        v_lookup_box_id,
        coalesce(v_existing.status::text, 'UNKNOWN')
      )
    );
  end if;

  if v_existing.received_date is not null then
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
    v_lot_run := coalesce(v_existing.lot_run, '');
  end if;

  v_locked_allocated_feet := app_api.locked_allocated_feet_for_box(p_org_id, v_lookup_box_id);
  v_box := v_existing;
  v_box.status := 'IN_STOCK';
  v_box.received_date := current_date;
  v_box.feet_available := greatest(coalesce(v_existing.initial_feet, 0) - coalesce(v_locked_allocated_feet, 0), 0);
  v_box.lot_run := v_lot_run;

  if v_received_weight_lbs is not null then
    v_box.initial_weight_lbs := v_received_weight_lbs;
    v_box.last_roll_weight_lbs := v_received_weight_lbs;
    v_box.last_weighed_date := current_date;
  end if;

  v_receipt_result := app_api.process_linked_box_receipt(p_org_id, v_box, p_actor);
  if coalesce(v_receipt_result, '{}'::jsonb) ? 'box' then
    v_box := jsonb_populate_record(null::app.boxes, v_receipt_result->'box');
  end if;
  if jsonb_typeof(coalesce(v_receipt_result->'warnings', '[]'::jsonb)) = 'array' then
    v_warnings := v_warnings || array(
      select jsonb_array_elements_text(coalesce(v_receipt_result->'warnings', '[]'::jsonb))
    );
  end if;

  v_box := app_api.save_box(v_box);
  perform app_api.recalculate_film_orders_for_box_links(p_org_id, v_box.box_id, p_actor);

  v_audit_note := format('Received ordered box %s', v_lookup_box_id);
  if v_received_weight_lbs is not null then
    v_audit_note := format(
      '%s at %s lbs',
      v_audit_note,
      trim(trailing '.' from trim(trailing '0' from v_received_weight_lbs::text))
    );
  end if;
  if v_lot_run <> '' then
    v_audit_note := format('%s with lot run %s', v_audit_note, v_lot_run);
  end if;

  v_log_id := app_api.append_audit_entry(
    p_org_id,
    'SET_STATUS',
    v_box.box_id,
    app_api.public_box_json(v_existing),
    app_api.public_box_json(v_box),
    p_actor,
    v_audit_note
  );

  if upper(coalesce(v_box.status::text, '')) in ('IN_STOCK', 'TRANSFER') then
    perform app_api.recalculate_physical_box_allocatable_now(p_org_id, v_lookup_box_id);
    v_reconcile_result := app_api.reconcile_auto_shortage_film_orders_for_box(
      p_org_id,
      p_actor,
      v_lookup_box_id,
      true
    );

    if coalesce((v_reconcile_result->>'createdCount')::integer, 0) > 0 then
      v_warnings := app_api.push_warning(
        v_warnings,
        format(
          'Created %s shortage film order%s after receiving the ordered box.',
          (v_reconcile_result->>'createdCount')::integer,
          case when coalesce((v_reconcile_result->>'createdCount')::integer, 0) = 1 then '' else 's' end
        )
      );
    end if;

    if coalesce((v_reconcile_result->>'deletedCount')::integer, 0) > 0 then
      v_warnings := app_api.push_warning(
        v_warnings,
        format(
          'Removed %s stale shortage film order%s after receiving the ordered box.',
          (v_reconcile_result->>'deletedCount')::integer,
          case when coalesce((v_reconcile_result->>'deletedCount')::integer, 0) = 1 then '' else 's' end
        )
      );
    end if;
  end if;

  return jsonb_build_object(
    'boxId', v_box.box_id,
    'logId', v_log_id,
    'warnings', to_jsonb(v_warnings)
  );
end;
$$;

do $$
declare
  v_candidate record;
  v_actor text := 'migration: restore linked receipt post-save recalc';
begin
  for v_candidate in
    select distinct fo.org_id, fo.film_order_id
    from app.film_orders fo
    join app.film_order_box_links l
      on l.org_id = fo.org_id
     and l.film_order_id = fo.film_order_id
    where fo.status <> 'CANCELLED'
  loop
    perform app_api.recalculate_film_order(
      v_candidate.org_id,
      v_candidate.film_order_id,
      v_actor
    );
  end loop;
end;
$$;
