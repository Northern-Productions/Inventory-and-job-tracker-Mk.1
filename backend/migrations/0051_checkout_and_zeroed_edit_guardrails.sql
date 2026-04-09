-- Reassert checkout and zeroed-edit guardrails after wrapper drift.

create or replace function app_api.resolve_allocations_for_checkout(
  p_org_id uuid,
  p_box_id text,
  p_job_number text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_entry app.allocations;
  v_fulfilled_count integer := 0;
  v_fulfilled_feet integer := 0;
  v_other_jobs text[] := array[]::text[];
  v_checkout_note text := format('Checked out for job %s.', app_api.trim_text(p_job_number));
begin
  for v_entry in
    select *
    from app.allocations a
    where a.org_id = p_org_id
      and a.box_id = app_api.trim_text(p_box_id)
      and a.status = 'ACTIVE'
    for update
  loop
    if upper(v_entry.job_number) = upper(app_api.trim_text(p_job_number)) then
      if v_entry.resolved_at is null then
        v_entry.resolved_at := now();
      end if;

      if coalesce(v_entry.resolved_by, '') = '' then
        v_entry.resolved_by := app_api.trim_text(p_actor);
      end if;

      if coalesce(v_entry.notes, '') <> v_checkout_note then
        v_entry.notes := v_checkout_note;
      end if;

      perform app_api.save_allocation(v_entry);
      v_fulfilled_count := v_fulfilled_count + 1;
      v_fulfilled_feet := v_fulfilled_feet + v_entry.allocated_feet;
    elsif array_position(v_other_jobs, v_entry.job_number) is null then
      v_other_jobs := array_append(v_other_jobs, v_entry.job_number);
    end if;
  end loop;

  return jsonb_build_object(
    'fulfilledCount', v_fulfilled_count,
    'fulfilledFeet', v_fulfilled_feet,
    'otherJobs', to_jsonb(v_other_jobs)
  );
end;
$$;

create or replace function app_api.reactivate_fulfilled_allocations_for_undo(
  p_org_id uuid,
  p_box_id text,
  p_job_number text
)
returns integer
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_entry app.allocations;
  v_count integer := 0;
  v_checkout_note text := format('Checked out for job %s.', app_api.trim_text(p_job_number));
  v_legacy_checkout_note text := format('Fulfilled by checkout for job %s.', app_api.trim_text(p_job_number));
begin
  for v_entry in
    select *
    from app.allocations a
    where a.org_id = p_org_id
      and a.box_id = app_api.trim_text(p_box_id)
      and a.status in ('ACTIVE', 'FULFILLED')
      and upper(a.job_number) = upper(app_api.trim_text(p_job_number))
      and a.notes in (v_checkout_note, v_legacy_checkout_note)
    for update
  loop
    v_entry.status := 'ACTIVE';
    v_entry.resolved_at := null;
    v_entry.resolved_by := '';
    v_entry.notes := '';
    perform app_api.save_allocation(v_entry);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

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

create or replace function public.api_boxes_set_status(
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
  v_box app.boxes;
  v_status text := upper(app_api.require_text(p_payload->>'status', 'Status'));
  v_log_id text;
  v_public_before jsonb;
  v_public_after jsonb;
  v_warnings text[] := array[]::text[];
  v_checkout_job text;
  v_resolution jsonb;
  v_physical_feet integer;
  v_active_allocated_feet integer := 0;
  v_checkout_audit app.audit_log;
  v_checkout_user text := '';
  v_checkout_date text := '';
  v_weight_delta numeric;
begin
  perform app_api.require_org_member(p_org_id);

  if v_status not in ('IN_STOCK', 'CHECKED_OUT') then
    perform app_api.raise_http(400, 'Status must be IN_STOCK or CHECKED_OUT.');
  end if;

  select *
  into v_existing
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = app_api.require_text(p_payload->>'boxId', 'BoxID')
  for update;

  if not found then
    perform app_api.raise_http(404, 'Box not found.');
  end if;

  if v_existing.received_date is null then
    perform app_api.raise_http(400, 'Add a ReceivedDate on or before today before changing status.');
  end if;

  if v_existing.status in ('ZEROED', 'RETIRED') then
    perform app_api.raise_http(400, 'This box cannot change status directly. Use audit undo instead.');
  end if;

  v_box := v_existing;
  v_public_before := app_api.public_box_json(v_existing);

  if v_status = 'CHECKED_OUT' then
    v_checkout_job := app_api.parse_checkout_job_from_note(p_payload->>'auditNote');
    if v_checkout_job = '' then
      perform app_api.raise_http(400, 'A checkout job number is required.');
    end if;

    v_box.status := 'CHECKED_OUT';
    v_box.has_ever_been_checked_out := true;
    v_box.last_checkout_job := v_checkout_job;
    v_box.last_checkout_date := app_api.today_date();
    v_box.zeroed_date := null;
    v_box.zeroed_reason := '';
    v_box.zeroed_by := '';

    v_resolution := app_api.resolve_allocations_for_checkout(p_org_id, v_box.box_id, v_checkout_job, p_actor);
    if coalesce((v_resolution->>'fulfilledCount')::integer, 0) > 0 then
      v_warnings := app_api.push_warning(
        v_warnings,
        format(
          'Kept %s allocation%s totaling %s LF linked to job %s after checkout.',
          (v_resolution->>'fulfilledCount')::integer,
          case when (v_resolution->>'fulfilledCount')::integer = 1 then '' else 's' end,
          (v_resolution->>'fulfilledFeet')::integer,
          v_checkout_job
        )
      );
    end if;

    if jsonb_array_length(coalesce(v_resolution->'otherJobs', '[]'::jsonb)) > 0 then
      v_warnings := app_api.push_warning(
        v_warnings,
        'This box still has active allocations for ' ||
          array_to_string(array(select jsonb_array_elements_text(v_resolution->'otherJobs')), ', ') || '.'
      );
    end if;
  else
    v_box.status := 'IN_STOCK';
    v_box.last_roll_weight_lbs := nullif(app_api.trim_text(p_payload->>'lastRollWeightLbs'), '')::numeric;
    if v_box.last_roll_weight_lbs is null then
      perform app_api.raise_http(400, 'LastRollWeightLbs is required.');
    end if;

    v_box.last_weighed_date := app_api.today_date();

    if v_box.core_weight_lbs is not null and v_box.lf_weight_lbs_per_ft is not null and v_box.lf_weight_lbs_per_ft > 0 then
      v_physical_feet := app_api.derive_feet_available_from_roll_weight(
        v_box.last_roll_weight_lbs,
        v_box.core_weight_lbs,
        v_box.lf_weight_lbs_per_ft,
        v_box.initial_feet
      );
    else
      v_physical_feet := v_box.feet_available;
      v_warnings := app_api.push_warning(
        v_warnings,
        'Available Feet could not be recalculated because this box is missing core or LF weight metadata.'
      );
    end if;

    select coalesce(sum(a.allocated_feet), 0)::integer
    into v_active_allocated_feet
    from app.allocations a
    where a.org_id = p_org_id
      and a.box_id = v_box.box_id
      and a.status = 'ACTIVE';

    v_box.feet_available := greatest(v_physical_feet - v_active_allocated_feet, 0);

    select *
    into v_checkout_audit
    from app.audit_log a
    where a.org_id = p_org_id
      and a.box_id = v_box.box_id
      and a.action = 'SET_STATUS'
      and coalesce(a.after_state->>'status', '') = 'CHECKED_OUT'
    order by a.created_at desc, a.log_id desc
    limit 1;

    v_checkout_user := coalesce(v_checkout_audit.actor, '');
    v_checkout_date := coalesce(substr(v_checkout_audit.created_at::text, 1, 10), '');
    v_checkout_job := coalesce(nullif(v_box.last_checkout_job, ''), app_api.parse_checkout_job_from_note(v_checkout_audit.notes));

    if v_checkout_job = '' then
      v_checkout_job := 'UNKNOWN';
      v_warnings := app_api.push_warning(
        v_warnings,
        'Roll history was logged with UNKNOWN job number because no checkout job was saved.'
      );
    end if;

    v_weight_delta := case
      when v_existing.last_roll_weight_lbs is null then null
      else round(v_existing.last_roll_weight_lbs - v_box.last_roll_weight_lbs, 2)
    end;

    perform app_api.append_roll_history_entry(
      p_org_id,
      row(
        gen_random_uuid(),
        p_org_id,
        app_api.create_log_id(),
        v_box.box_id,
        v_box.warehouse,
        v_box.manufacturer,
        v_box.film_name,
        v_box.width_in,
        v_checkout_job,
        coalesce(nullif(v_checkout_date, '')::timestamptz, now()),
        v_checkout_user,
        v_existing.last_roll_weight_lbs,
        now(),
        app_api.trim_text(p_actor),
        v_box.last_roll_weight_lbs,
        v_weight_delta,
        v_existing.feet_available,
        v_box.feet_available,
        app_api.trim_text(p_payload->>'auditNote')
      )::app.roll_weight_log
    );

    v_box.last_checkout_job := '';
    v_box.last_checkout_date := null;

    if app_api.has_positive_physical_feet(v_existing)
      and (v_box.feet_available = 0 or coalesce(v_box.last_roll_weight_lbs, 0) = 0) then
      v_box.status := 'ZEROED';
      v_box.feet_available := 0;
      v_box.zeroed_date := app_api.today_date();
      v_box.zeroed_reason := app_api.determine_zeroed_reason(v_box.feet_available, v_box.last_roll_weight_lbs);
      v_box.zeroed_by := app_api.trim_text(p_actor);
      perform app_api.cancel_active_allocations_for_box(
        p_org_id,
        v_box.box_id,
        p_actor,
        'Auto-cancelled because the box was moved to zeroed out inventory.'
      );
      v_warnings := app_api.push_warning(
        v_warnings,
        'Box was automatically moved to zeroed out inventory because Available Feet or Last Roll Weight reached 0.'
      );
    end if;
  end if;

  v_box := app_api.save_box(v_box);
  v_public_after := app_api.public_box_json(v_box);
  v_log_id := app_api.append_audit_entry(
    p_org_id,
    case when v_box.status = 'ZEROED' then 'ZERO_OUT_BOX' else 'SET_STATUS' end,
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

create or replace function public.api_acl_boxes_update(
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
  v_existing_status text := '';
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');
  v_lookup_box_id := app_api.resolve_box_id_alias(
    p_org_id,
    app_api.require_text(v_payload->>'boxId', 'BoxID')
  );

  select upper(btrim(b.status::text))
  into v_existing_status
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = v_lookup_box_id;

  if v_existing_status = 'TRANSFER' then
    perform app_api.raise_http(
      400,
      format(
        'Box %s has a pending transfer and can only be received or have the transfer cancelled.',
        v_lookup_box_id
      )
    );
  end if;

  v_payload := jsonb_set(v_payload, '{boxId}', to_jsonb(v_lookup_box_id), true);
  return public.api_boxes_update(p_org_id, p_actor, v_payload);
end;
$$;

create or replace function public.api_acl_boxes_set_status(
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
  v_existing_status text := '';
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');
  v_lookup_box_id := app_api.resolve_box_id_alias(
    p_org_id,
    app_api.require_text(v_payload->>'boxId', 'BoxID')
  );

  select upper(btrim(b.status::text))
  into v_existing_status
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = v_lookup_box_id;

  if v_existing_status = 'TRANSFER' then
    perform app_api.raise_http(
      400,
      format(
        'Box %s has a pending transfer and can only be received or have the transfer cancelled.',
        v_lookup_box_id
      )
    );
  end if;

  v_payload := jsonb_set(v_payload, '{boxId}', to_jsonb(v_lookup_box_id), true);
  return public.api_boxes_set_status(p_org_id, p_actor, v_payload);
end;
$$;
