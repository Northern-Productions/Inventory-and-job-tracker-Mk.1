-- Allow confirmed zeroed-box edits to reactivate boxes back into active inventory.

create or replace function public.api_boxes_update(
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
  v_existing app.boxes;
  v_build jsonb;
  v_box app.boxes;
  v_public_before jsonb;
  v_public_after jsonb;
  v_receipt_result jsonb;
  v_log_id text;
  v_warnings text[] := array[]::text[];
  v_reached_zero boolean;
  v_move_to_zeroed boolean := coalesce((p_payload->>'moveToZeroed')::boolean, false);
  v_reactivate_from_zeroed boolean := coalesce((p_payload->>'reactivateFromZeroed')::boolean, false);
  v_auto_zero boolean;
  v_requested_feet_available integer;
  v_confirmed_zero_feet_move boolean := false;
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
  v_warnings := coalesce(array(select jsonb_array_elements_text(v_build->'warnings')), array[]::text[]);
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
    and v_requested_feet_available is not null
    and v_requested_feet_available <= 0;

  if v_confirmed_zero_feet_move then
    v_box.feet_available := 0;
  end if;

  v_reached_zero := v_box.received_date is not null and (v_box.feet_available = 0 or coalesce(v_box.last_roll_weight_lbs, 0) = 0);
  v_auto_zero := v_existing.received_date is not null and app_api.has_positive_physical_feet(v_existing) and v_reached_zero;

  if v_move_to_zeroed and not (v_auto_zero or v_confirmed_zero_feet_move) then
    perform app_api.raise_http(
      400,
      'Received boxes move to zeroed out inventory only after they have had Available Feet above 0 and then reach 0 Available Feet or 0 Last Roll Weight.'
    );
  end if;

  if v_auto_zero or v_confirmed_zero_feet_move then
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
    if v_confirmed_zero_feet_move and not v_auto_zero then
      v_warnings := app_api.push_warning(
        v_warnings,
        'Box was moved to zeroed out inventory after confirming an Available Feet value of 0 on a received box with recorded physical feet.'
      );
    end if;
    v_audit_action := 'ZERO_OUT_BOX';
  else
    v_receipt_result := app_api.process_linked_box_receipt(p_org_id, v_box, p_actor);
    v_box := jsonb_populate_record(null::app.boxes, v_receipt_result->'box');
    v_warnings := array_cat(
      v_warnings,
      coalesce(array(select jsonb_array_elements_text(v_receipt_result->'warnings')), array[]::text[])
    );
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
end;
$$;
