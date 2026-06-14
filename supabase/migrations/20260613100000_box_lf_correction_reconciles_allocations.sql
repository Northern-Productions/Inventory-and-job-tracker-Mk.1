/*
 * PURPOSE:
 * Allow real-world box LF corrections below existing allocation claims, then
 * reconcile allocation claims to physical box reality.
 *
 * AFFECTS:
 * Box edit/update, ordered-box receive, linked film-order status recalculation,
 * and material-flow reconciliation.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * docs/material-flow-rules.md, local runtime box update/receive handlers,
 * Supabase Edge mutation routing, and schema/latest guards.
 */

do $$
declare
  v_def text;
  v_base text;
  v_next text;
begin
  select pg_get_functiondef('app_api.build_box_from_payload(uuid, jsonb, text)'::regprocedure)
  into v_def;

  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  v_next := replace(
    v_next,
    replace($old$
        if v_current_feet_on_roll_input < v_active_allocated_feet then
          perform app_api.raise_http(
            400,
            format(
              'CurrentFeetOnRoll cannot be lower than the box''s active allocated feet (%s).',
              v_active_allocated_feet
            )
          );
        end if;
$old$, E'\r\n', E'\n'),
    ''
  );

  v_next := replace(
    v_next,
    replace($old$
      if v_physical_feet_available < v_active_allocated_feet then
        perform app_api.raise_http(
          400,
          format(
            'Received physical LF cannot be lower than the box''s active allocated feet (%s).',
            v_active_allocated_feet
          )
        );
      end if;

$old$, E'\r\n', E'\n'),
    ''
  );

  if v_next = v_base then
    if position('CurrentFeetOnRoll cannot be lower than the box''s active allocated feet' in v_base) = 0
       and position('Received physical LF cannot be lower than the box''s active allocated feet' in v_base) = 0 then
      return;
    end if;

    raise exception 'box LF correction guard removal did not match app_api.build_box_from_payload';
  end if;

  if position('CurrentFeetOnRoll cannot be lower than the box''s active allocated feet' in v_next) > 0
     or position('Received physical LF cannot be lower than the box''s active allocated feet' in v_next) > 0 then
    raise exception 'box LF correction guard removal left stale lower-than-allocation errors';
  end if;

  execute v_next;
end;
$$;

do $$
declare
  v_def text;
  v_base text;
  v_next text;
begin
  select pg_get_functiondef('public.api_acl_boxes_update(uuid, text, jsonb)'::regprocedure)
  into v_def;

  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  v_next := replace(
    v_next,
    replace($old$
    v_material_physical_feet := case
      when upper(coalesce(v_box.status::text, '')) = 'ORDERED' then greatest(coalesce(v_box.initial_feet, 0), 0)::integer
      else greatest(coalesce(app_api.box_physical_feet_available(v_box), 0), 0)::integer
    end;
$old$, E'\r\n', E'\n'),
    replace($new$
    v_material_physical_feet := case
      when coalesce(p_payload, '{}'::jsonb) ? 'currentFeetOnRoll'
        and app_api.trim_text(p_payload->>'currentFeetOnRoll') <> ''
      then greatest(floor((app_api.trim_text(p_payload->>'currentFeetOnRoll'))::numeric), 0)::integer
      when upper(coalesce(v_box.status::text, '')) = 'ORDERED' then greatest(coalesce(v_box.initial_feet, 0), 0)::integer
      else greatest(coalesce(app_api.box_physical_feet_available(v_box), 0), 0)::integer
    end;
$new$, E'\r\n', E'\n')
  );

  if v_next = v_base then
    if position('p_payload->>''currentFeetOnRoll''' in v_base) > 0
       and position('v_material_reconciliation_result := app_api.reconcile_box_checkin_allocations' in v_base) > 0 then
      return;
    end if;

    raise exception 'api_acl_boxes_update currentFeetOnRoll reconciliation patch did not match expected snippet';
  end if;

  if position('p_payload->>''currentFeetOnRoll''' in v_next) = 0
     or position('v_material_reconciliation_result := app_api.reconcile_box_checkin_allocations' in v_next) = 0 then
    raise exception 'api_acl_boxes_update currentFeetOnRoll reconciliation patch incomplete';
  end if;

  execute v_next;
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
  v_received_feet_text text := app_api.trim_text(coalesce(v_payload->>'currentFeetOnRoll', v_payload->>'receivedFeet'));
  v_received_feet integer := null;
  v_lot_run text := app_api.trim_text(v_payload->>'lotRun');
  v_core_type text := '';
  v_locked_allocated_feet integer := 0;
  v_receipt_result jsonb := '{}'::jsonb;
  v_reconcile_result jsonb := '{}'::jsonb;
  v_material_reconciliation_result jsonb := jsonb_build_object('warnings', '[]'::jsonb);
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

  if v_received_feet_text <> '' then
    begin
      v_received_feet := floor((v_received_feet_text)::numeric)::integer;
    exception
      when invalid_text_representation then
        perform app_api.raise_http(400, 'CurrentFeetOnRoll must be a valid non-negative number.');
    end;

    if v_received_feet < 0 then
      perform app_api.raise_http(400, 'CurrentFeetOnRoll must be a valid non-negative number.');
    end if;
  end if;

  if v_lot_run = '' then
    v_lot_run := coalesce(v_existing.lot_run, '');
  end if;

  v_core_type := app_api.normalize_core_type(v_payload->>'coreType', true);

  v_locked_allocated_feet := app_api.physical_film_commitment_feet_for_box(p_org_id, v_lookup_box_id);
  v_box := v_existing;
  v_box.status := 'IN_STOCK';
  v_box.received_date := current_date;
  v_box.has_label := false;
  if v_received_feet is not null then
    v_box.initial_feet := v_received_feet;
  end if;
  v_box.feet_available := greatest(coalesce(v_box.initial_feet, 0) - coalesce(v_locked_allocated_feet, 0), 0);
  v_box.lot_run := v_lot_run;

  if v_core_type <> '' then
    v_box.core_type := v_core_type;
    v_box.core_weight_lbs := app_api.derive_core_weight_lbs(v_core_type, v_box.width_in);
  end if;

  if v_received_weight_lbs is not null then
    v_box.initial_weight_lbs := v_received_weight_lbs;
    v_box.last_roll_weight_lbs := v_received_weight_lbs;
    v_box.last_weighed_date := current_date;
  end if;

  v_box := app_api.save_box(v_box);

  v_material_reconciliation_result := app_api.reconcile_box_checkin_allocations(
    p_org_id,
    p_actor,
    v_box.box_id,
    greatest(coalesce(v_box.initial_feet, 0), 0)::integer
  );
  if jsonb_typeof(coalesce(v_material_reconciliation_result->'warnings', '[]'::jsonb)) = 'array' then
    v_warnings := v_warnings || array(
      select jsonb_array_elements_text(coalesce(v_material_reconciliation_result->'warnings', '[]'::jsonb))
    );
  end if;
  v_box.feet_available := greatest(coalesce((v_material_reconciliation_result->>'feetAvailable')::integer, v_box.feet_available), 0);
  v_box := app_api.save_box(v_box);

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
  v_material_reconciliation_result := app_api.reconcile_box_checkin_allocations(
    p_org_id,
    p_actor,
    v_box.box_id,
    greatest(coalesce(v_box.initial_feet, 0), 0)::integer
  );
  if jsonb_typeof(coalesce(v_material_reconciliation_result->'warnings', '[]'::jsonb)) = 'array' then
    v_warnings := v_warnings || array(
      select jsonb_array_elements_text(coalesce(v_material_reconciliation_result->'warnings', '[]'::jsonb))
    );
  end if;
  v_box.feet_available := greatest(coalesce((v_material_reconciliation_result->>'feetAvailable')::integer, v_box.feet_available), 0);
  v_box := app_api.save_box(v_box);
  perform app_api.recalculate_film_orders_for_box_links(p_org_id, v_box.box_id, p_actor);

  v_audit_note := format('Received ordered box %s', v_lookup_box_id);
  if v_received_feet is not null then
    v_audit_note := format('%s with %s LF recorded', v_audit_note, v_received_feet);
  end if;
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

  begin
    perform app_api.record_film_weight_sample_from_box(p_org_id, v_lookup_box_id, p_actor);
  exception
    when others then
      v_warnings := v_warnings || array[
        'Film weight profile logging could not be completed; receive succeeded and the sample can be reviewed later.'
      ];
  end;

  return jsonb_build_object(
    'boxId', v_box.box_id,
    'logId', v_log_id,
    'warnings', to_jsonb(v_warnings)
  );
end;
$$;

do $$
declare
  v_def text;
begin
  select pg_get_functiondef('app_api.build_box_from_payload(uuid, jsonb, text)'::regprocedure)
  into v_def;
  if position('CurrentFeetOnRoll cannot be lower than the box''s active allocated feet' in v_def) > 0
     or position('Received physical LF cannot be lower than the box''s active allocated feet' in v_def) > 0 then
    raise exception 'box LF correction stale guard still present in build_box_from_payload';
  end if;

  select pg_get_functiondef('public.api_acl_boxes_update(uuid, text, jsonb)'::regprocedure)
  into v_def;
  if position('p_payload->>''currentFeetOnRoll''' in v_def) = 0
     or position('v_material_reconciliation_result := app_api.reconcile_box_checkin_allocations' in v_def) = 0 then
    raise exception 'box LF correction update reconciliation guard failed';
  end if;

  select pg_get_functiondef('public.api_acl_boxes_receive_ordered(uuid, text, jsonb)'::regprocedure)
  into v_def;
  if position('v_received_feet_text text' in v_def) = 0
     or position('v_box.initial_feet := v_received_feet' in v_def) = 0
     or position('v_material_reconciliation_result := app_api.reconcile_box_checkin_allocations' in v_def) = 0
     or position('app_api.process_linked_box_receipt(p_org_id, v_box, p_actor)' in v_def) = 0 then
    raise exception 'box LF correction receive ordered reconciliation guard failed';
  end if;
end;
$$;

select app_api.grant_execute_if_exists('public.api_acl_boxes_receive_ordered(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_boxes_receive_ordered(uuid, text, jsonb)', 'service_role');
