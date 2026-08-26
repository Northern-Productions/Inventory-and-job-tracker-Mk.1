-- Make returned roll weight authoritative for film-box check-in while preserving
-- the existing material-flow lock, allocation reconciliation, and audit paths.

create or replace function app_api.resolve_box_weight_calibration(
  p_org_id uuid,
  p_box app.boxes
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, app, app_api
as $$
declare
  v_core_type text := coalesce(app_api.normalize_core_type(p_box.core_type, true), '');
  v_core_weight numeric := null;
  v_lf_weight numeric := null;
  v_catalog_sq_ft_weight numeric := null;
  v_catalog_core_type text := '';
begin
  if p_box.org_id is distinct from p_org_id then
    raise exception 'BOX_WEIGHT_CALIBRATION_ORG_MISMATCH';
  end if;

  if p_box.core_weight_lbs is not null
     and p_box.core_weight_lbs >= 0
     and p_box.lf_weight_lbs_per_ft is not null
     and p_box.lf_weight_lbs_per_ft > 0 then
    return jsonb_build_object(
      'resolved', true,
      'source', 'SAVED_BOX',
      'coreType', v_core_type,
      'coreWeightLbs', p_box.core_weight_lbs,
      'lfWeightLbsPerFt', p_box.lf_weight_lbs_per_ft
    );
  end if;

  if v_core_type <> '' then
    v_core_weight := app_api.derive_core_weight_lbs(v_core_type, p_box.width_in);
    v_lf_weight := app_api.try_derive_lf_weight_lbs_per_ft(
      p_box.initial_weight_lbs,
      v_core_weight,
      p_box.width_in,
      p_box.initial_feet
    );

    if v_lf_weight is not null and v_lf_weight > 0 then
      return jsonb_build_object(
        'resolved', true,
        'source', 'BOX_INITIAL_BASELINE',
        'coreType', v_core_type,
        'coreWeightLbs', v_core_weight,
        'lfWeightLbsPerFt', v_lf_weight
      );
    end if;
  end if;

  select
    c.sq_ft_weight_lbs_per_sq_ft,
    coalesce(app_api.normalize_core_type(c.default_core_type, true), '')
  into v_catalog_sq_ft_weight, v_catalog_core_type
  from app.film_catalog c
  where c.org_id = p_org_id
    and c.film_key = p_box.film_key
  limit 1;

  v_core_type := coalesce(nullif(v_core_type, ''), nullif(v_catalog_core_type, ''), '');
  if v_catalog_sq_ft_weight is not null
     and v_catalog_sq_ft_weight > 0
     and v_core_type <> '' then
    v_core_weight := app_api.derive_core_weight_lbs(v_core_type, p_box.width_in);
    v_lf_weight := app_api.derive_lf_weight_lbs_per_ft(
      v_catalog_sq_ft_weight,
      p_box.width_in
    );

    if v_lf_weight > 0 then
      return jsonb_build_object(
        'resolved', true,
        'source', 'FILM_CATALOG',
        'coreType', v_core_type,
        'coreWeightLbs', v_core_weight,
        'lfWeightLbsPerFt', v_lf_weight
      );
    end if;
  end if;

  return jsonb_build_object(
    'resolved', false,
    'source', 'UNRESOLVED',
    'coreType', v_core_type,
    'coreWeightLbs', null,
    'lfWeightLbsPerFt', null
  );
end;
$$;

revoke execute on function app_api.resolve_box_weight_calibration(uuid, app.boxes)
from public, anon, authenticated, service_role;

do $patch_weight_authoritative_checkin$
declare
  v_def text;
  v_base text;
  v_next text;
begin
  select pg_get_functiondef('public.api_boxes_set_status(uuid, text, jsonb)'::regprocedure)
  into v_def;

  if v_def is null then
    raise exception 'public.api_boxes_set_status(uuid, text, jsonb) was not found';
  end if;

  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  if position('  v_current_feet_text text := app_api.trim_text(p_payload->>''currentFeetOnRoll'');' in v_next) = 0
     or position('  v_submitted_core_type text := app_api.normalize_core_type(p_payload->>''coreType'', true);' in v_next) = 0 then
    raise exception 'api_boxes_set_status weight-authority declarations did not match';
  end if;

  v_next := replace(
    v_next,
    '  v_current_feet_text text := app_api.trim_text(p_payload->>''currentFeetOnRoll'');',
    '  v_current_feet_text text := '''';'
  );
  v_next := replace(
    v_next,
    '  v_submitted_core_type text := app_api.normalize_core_type(p_payload->>''coreType'', true);',
    '  v_submitted_core_type text := '''';'
  );

  v_next := replace(
    v_next,
    replace($old_parse$
    if v_current_feet_text <> '' and v_current_feet_text !~ '^[0-9]+$' then
      perform app_api.raise_http(400, 'CurrentFeetOnRoll must be a whole number greater than or equal to 0.');
    end if;

    if v_current_feet_text <> '' then
      v_current_feet_on_roll := v_current_feet_text::integer;
    end if;
$old_parse$, E'\r\n', E'\n'),
    replace($new_parse$
    -- Legacy currentFeetOnRoll and coreType payload values are intentionally ignored.
$new_parse$, E'\r\n', E'\n')
  );

  v_next := replace(
    v_next,
    replace($old_calibration$
    if app_api.box_can_derive_checkin_feet_from_weight(v_existing) then
      v_physical_feet_after := app_api.derive_feet_available_from_roll_weight(
        v_last_roll_weight,
        v_existing.core_weight_lbs,
        v_existing.lf_weight_lbs_per_ft,
        v_existing.initial_feet
      );
      v_resolved_core_type := coalesce(app_api.normalize_core_type(v_existing.core_type, true), '');
      v_resolved_core_weight := v_existing.core_weight_lbs;
      v_resolved_lf_weight := v_existing.lf_weight_lbs_per_ft;
    else
      if v_current_feet_on_roll is null then
        perform app_api.raise_http(
          400,
          'CurrentFeetOnRoll is required when this box cannot derive feet from weight alone.'
        );
      end if;

      if v_current_feet_on_roll > coalesce(v_existing.initial_feet, 0) then
        perform app_api.raise_http(
          400,
          format(
            'CurrentFeetOnRoll cannot be greater than this box''s InitialFeet (%s).',
            coalesce(v_existing.initial_feet, 0)
          )
        );
      end if;

      v_physical_feet_after := v_current_feet_on_roll;

      if v_current_feet_on_roll = 0 then
        if v_last_roll_weight > 0 then
          perform app_api.raise_http(
            400,
            'CurrentFeetOnRoll cannot be 0 while LastRollWeightLbs is still above 0.'
          );
        end if;

        v_resolved_core_type := coalesce(v_submitted_core_type, app_api.normalize_core_type(v_existing.core_type, true), '');
        if v_resolved_core_type <> '' and v_existing.core_weight_lbs is null then
          v_resolved_core_weight := app_api.derive_core_weight_lbs(v_resolved_core_type, v_existing.width_in);
        else
          v_resolved_core_weight := v_existing.core_weight_lbs;
        end if;
        v_resolved_lf_weight := v_existing.lf_weight_lbs_per_ft;
      else
        v_resolved_core_type := coalesce(
          v_submitted_core_type,
          app_api.normalize_core_type(v_existing.core_type, true),
          ''
        );

        if v_existing.core_weight_lbs is not null and v_submitted_core_type = '' then
          v_resolved_core_weight := v_existing.core_weight_lbs;
        elsif v_resolved_core_type <> '' then
          v_resolved_core_weight := app_api.derive_core_weight_lbs(v_resolved_core_type, v_existing.width_in);
        else
          v_resolved_core_weight := null;
        end if;

        if v_resolved_core_weight is null then
          perform app_api.raise_http(
            400,
            'CoreType is required before this return can establish future weight-based LF math.'
          );
        end if;

        if v_last_roll_weight <= v_resolved_core_weight then
          perform app_api.raise_http(
            400,
            'LastRollWeightLbs must be greater than the core weight when CurrentFeetOnRoll is above 0.'
          );
        end if;

        v_resolved_lf_weight := round(
          (v_last_roll_weight - v_resolved_core_weight) / greatest(v_current_feet_on_roll, 1),
          6
        );
      end if;
    end if;
$old_calibration$, E'\r\n', E'\n'),
    replace($new_calibration$
    v_resolution := app_api.resolve_box_weight_calibration(p_org_id, v_existing);
    if not coalesce((v_resolution->>'resolved')::boolean, false) then
      perform app_api.raise_http(
        400,
        'This box is missing the roll-weight calibration needed to calculate remaining LF. Update its roll-tracking details before checking it in.'
      );
    end if;

    v_resolved_core_type := coalesce(v_resolution->>'coreType', '');
    v_resolved_core_weight := nullif(v_resolution->>'coreWeightLbs', '')::numeric;
    v_resolved_lf_weight := nullif(v_resolution->>'lfWeightLbsPerFt', '')::numeric;
    v_physical_feet_after := app_api.derive_feet_available_from_roll_weight(
      v_last_roll_weight,
      v_resolved_core_weight,
      v_resolved_lf_weight,
      v_existing.initial_feet
    );
$new_calibration$, E'\r\n', E'\n')
  );

  if v_next = v_base then
    raise exception 'api_boxes_set_status weight-authority patch made no change';
  end if;

  if position('app_api.resolve_box_weight_calibration(p_org_id, v_existing)' in v_next) = 0
     or position('p_payload->>''currentFeetOnRoll''' in v_next) > 0
     or position('CurrentFeetOnRoll is required when this box cannot derive feet from weight alone.' in v_next) > 0
     or position('v_reconciliation_result := app_api.reconcile_box_checkin_allocations' in v_next) = 0 then
    raise exception 'api_boxes_set_status weight-authority verification failed';
  end if;

  execute v_next;
end;
$patch_weight_authoritative_checkin$;

do $patch_receive_ordered_calibration$
declare
  v_def text;
  v_base text;
  v_next text;
begin
  select pg_get_functiondef('public.api_acl_boxes_receive_ordered(uuid, text, jsonb)'::regprocedure)
  into v_def;

  if v_def is null then
    raise exception 'public.api_acl_boxes_receive_ordered(uuid, text, jsonb) was not found';
  end if;

  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  v_next := replace(
    v_next,
    replace($old_receive$
  if v_received_weight_lbs is not null then
    v_box.initial_weight_lbs := v_received_weight_lbs;
    v_box.last_roll_weight_lbs := v_received_weight_lbs;
    v_box.last_weighed_date := current_date;
  end if;

  v_box := app_api.save_box(v_box);
$old_receive$, E'\r\n', E'\n'),
    replace($new_receive$
  if v_received_weight_lbs is not null then
    v_box.initial_weight_lbs := v_received_weight_lbs;
    v_box.last_roll_weight_lbs := v_received_weight_lbs;
    v_box.last_weighed_date := current_date;
  end if;

  v_receipt_result := app_api.resolve_box_weight_calibration(p_org_id, v_box);
  if coalesce((v_receipt_result->>'resolved')::boolean, false) then
    v_box.core_type := coalesce(nullif(v_receipt_result->>'coreType', ''), v_box.core_type);
    v_box.core_weight_lbs := nullif(v_receipt_result->>'coreWeightLbs', '')::numeric;
    v_box.lf_weight_lbs_per_ft := nullif(v_receipt_result->>'lfWeightLbsPerFt', '')::numeric;
  end if;

  v_box := app_api.save_box(v_box);
$new_receive$, E'\r\n', E'\n')
  );

  if v_next = v_base then
    raise exception 'api_acl_boxes_receive_ordered calibration patch did not match';
  end if;

  if position('app_api.resolve_box_weight_calibration(p_org_id, v_box)' in v_next) = 0
     or position('v_box.lf_weight_lbs_per_ft :=' in v_next) = 0
     or position('app_api.process_linked_box_receipt(p_org_id, v_box, p_actor)' in v_next) = 0 then
    raise exception 'api_acl_boxes_receive_ordered calibration verification failed';
  end if;

  execute v_next;
end;
$patch_receive_ordered_calibration$;

do $weight_authoritative_contract_guard$
declare
  v_def text;
begin
  select pg_get_functiondef('public.api_boxes_set_status(uuid, text, jsonb)'::regprocedure)
  into v_def;
  if position('app_api.resolve_box_weight_calibration(p_org_id, v_existing)' in v_def) = 0
     or position('p_payload->>''currentFeetOnRoll''' in v_def) > 0
     or position('v_reconciliation_result := app_api.reconcile_box_checkin_allocations' in v_def) = 0
     or position('app_api.append_roll_history' in v_def) = 0 then
    raise exception 'WEIGHT_AUTHORITATIVE_BOX_CHECKIN_CONTRACT_MISMATCH';
  end if;

  select pg_get_functiondef('public.api_acl_boxes_set_status(uuid, text, jsonb)'::regprocedure)
  into v_def;
  if position('app_api.lock_film_material_flow()' in v_def) = 0
     or position('app_api.api_acl_boxes_set_status_pre_0191' in v_def) = 0 then
    raise exception 'WEIGHT_AUTHORITATIVE_BOX_CHECKIN_ACL_WRAPPER_MISMATCH';
  end if;

  select pg_get_functiondef('public.api_acl_boxes_receive_ordered(uuid, text, jsonb)'::regprocedure)
  into v_def;
  if position('app_api.resolve_box_weight_calibration(p_org_id, v_box)' in v_def) = 0
     or position('app_api.process_linked_box_receipt(p_org_id, v_box, p_actor)' in v_def) = 0 then
    raise exception 'WEIGHT_AUTHORITATIVE_ORDERED_RECEIVE_CONTRACT_MISMATCH';
  end if;

  if has_function_privilege('public', 'app_api.resolve_box_weight_calibration(uuid, app.boxes)', 'EXECUTE')
     or has_function_privilege('anon', 'app_api.resolve_box_weight_calibration(uuid, app.boxes)', 'EXECUTE')
     or has_function_privilege('authenticated', 'app_api.resolve_box_weight_calibration(uuid, app.boxes)', 'EXECUTE')
     or has_function_privilege('service_role', 'app_api.resolve_box_weight_calibration(uuid, app.boxes)', 'EXECUTE') then
    raise exception 'WEIGHT_AUTHORITATIVE_CALIBRATION_HELPER_EXPOSED';
  end if;
end;
$weight_authoritative_contract_guard$;
