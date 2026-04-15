-- Missing-initial-weight film return check-in parity:
-- - allow check-ins to calibrate from return weight + current LF when initial weight history is incomplete
-- - release the checked-out job's planning allocation rows during return
-- - log roll-history usage against physical feet before/after the return instead of reservation-adjusted feet

create or replace function app_api.box_can_derive_checkin_feet_from_weight(p_box app.boxes)
returns boolean
language sql
immutable
as $$
  select
    p_box.core_weight_lbs is not null
    and p_box.lf_weight_lbs_per_ft is not null
    and p_box.lf_weight_lbs_per_ft > 0;
$$;

create or replace function app_api.box_can_derive_stored_physical_feet_from_weight(p_box app.boxes)
returns boolean
language sql
immutable
as $$
  select
    app_api.box_can_derive_checkin_feet_from_weight(p_box)
    and p_box.last_roll_weight_lbs is not null;
$$;

create or replace function app_api.derive_box_physical_feet_before_checkin(
  p_box app.boxes,
  p_active_allocated_feet integer
)
returns integer
language sql
immutable
as $$
  select
    case
      when app_api.box_can_derive_stored_physical_feet_from_weight(p_box) then
        app_api.derive_feet_available_from_roll_weight(
          p_box.last_roll_weight_lbs,
          p_box.core_weight_lbs,
          p_box.lf_weight_lbs_per_ft,
          p_box.initial_feet
        )
      else
        app_api.clamp_feet_to_initial_range(
          coalesce(p_box.feet_available, 0) + coalesce(p_active_allocated_feet, 0),
          p_box.initial_feet
        )
    end;
$$;

create or replace function app_api.cancel_active_allocations_for_box_job_checkin(
  p_org_id uuid,
  p_actor text,
  p_box_id text,
  p_job_number text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_entry app.allocations;
  v_reason text := coalesce(
    nullif(app_api.trim_text(p_reason), ''),
    format('Returned to stock during check-in for job %s.', app_api.trim_text(p_job_number))
  );
  v_cancelled_count integer := 0;
  v_cancelled_feet integer := 0;
  v_affected_film_order_ids text[] := array[]::text[];
  v_film_order_id text;
begin
  if app_api.trim_text(p_job_number) = '' then
    return jsonb_build_object(
      'cancelledCount', 0,
      'cancelledFeet', 0
    );
  end if;

  for v_entry in
    select *
    from app.allocations a
    where a.org_id = p_org_id
      and a.box_id = app_api.trim_text(p_box_id)
      and a.status = 'ACTIVE'
      and upper(coalesce(a.job_number, '')) = upper(app_api.trim_text(p_job_number))
    for update
  loop
    v_entry.status := 'CANCELLED';
    v_entry.resolved_at := now();
    v_entry.resolved_by := app_api.trim_text(p_actor);
    v_entry.notes := v_reason;
    perform app_api.save_allocation(v_entry);

    if coalesce(v_entry.film_order_id, '') <> ''
      and not (v_entry.film_order_id = any(v_affected_film_order_ids)) then
      v_affected_film_order_ids := array_append(v_affected_film_order_ids, v_entry.film_order_id);
    end if;

    v_cancelled_count := v_cancelled_count + 1;
    v_cancelled_feet := v_cancelled_feet + coalesce(v_entry.allocated_feet, 0);
  end loop;

  foreach v_film_order_id in array v_affected_film_order_ids
  loop
    perform app_api.recalculate_film_order(p_org_id, v_film_order_id, p_actor);
  end loop;

  return jsonb_build_object(
    'cancelledCount', v_cancelled_count,
    'cancelledFeet', v_cancelled_feet
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
  v_checkout_job text := '';
  v_resolution jsonb;
  v_checkout_audit app.audit_log;
  v_checkout_user text := '';
  v_checkout_date text := '';
  v_weight_delta numeric;
  v_last_roll_weight numeric;
  v_current_feet_text text := app_api.trim_text(p_payload->>'currentFeetOnRoll');
  v_current_feet_on_roll integer := null;
  v_submitted_core_type text := app_api.normalize_core_type(p_payload->>'coreType', true);
  v_resolved_core_type text := '';
  v_resolved_core_weight numeric := null;
  v_resolved_lf_weight numeric := null;
  v_active_allocated_feet_before integer := 0;
  v_same_job_active_allocation_count integer := 0;
  v_same_job_active_allocated_feet integer := 0;
  v_other_active_allocated_feet integer := 0;
  v_other_jobs text[] := array[]::text[];
  v_physical_feet_before integer := 0;
  v_physical_feet_after integer := 0;
  v_auto_move_to_zeroed boolean := false;
  v_reached_zero_state boolean := false;
  v_same_job_release jsonb := jsonb_build_object(
    'cancelledCount', 0,
    'cancelledFeet', 0
  );
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
    v_last_roll_weight := nullif(app_api.trim_text(p_payload->>'lastRollWeightLbs'), '')::numeric;
    if v_last_roll_weight is null then
      perform app_api.raise_http(400, 'LastRollWeightLbs is required.');
    end if;

    if v_last_roll_weight < 0 then
      perform app_api.raise_http(400, 'LastRollWeightLbs must be zero or greater.');
    end if;

    if v_current_feet_text <> '' and v_current_feet_text !~ '^[0-9]+$' then
      perform app_api.raise_http(400, 'CurrentFeetOnRoll must be a whole number greater than or equal to 0.');
    end if;

    if v_current_feet_text <> '' then
      v_current_feet_on_roll := v_current_feet_text::integer;
    end if;

    v_box.status := 'IN_STOCK';
    v_box.last_roll_weight_lbs := v_last_roll_weight;
    v_box.last_weighed_date := app_api.today_date();

    select *
    into v_checkout_audit
    from app.audit_log a
    where a.org_id = p_org_id
      and a.box_id = v_box.box_id
      and a.action = 'SET_STATUS'
      and coalesce(a.after_state->>'status', '') = 'CHECKED_OUT'
    order by a.created_at desc, a.log_id desc
    limit 1;

    v_checkout_job := coalesce(nullif(v_existing.last_checkout_job, ''), app_api.parse_checkout_job_from_note(v_checkout_audit.notes));
    v_checkout_date := coalesce(to_char(v_existing.last_checkout_date, 'YYYY-MM-DD'), '');
    if v_checkout_date = '' then
      v_checkout_date := coalesce(substr(v_checkout_audit.created_at::text, 1, 10), '');
    end if;
    v_checkout_user := coalesce(v_checkout_audit.actor, '');

    if v_checkout_date = '' then
      v_checkout_date := app_api.today_date()::text;
    end if;

    select coalesce(sum(a.allocated_feet), 0)::integer
    into v_active_allocated_feet_before
    from app.allocations a
    where a.org_id = p_org_id
      and a.box_id = v_box.box_id
      and a.status = 'ACTIVE';

    if v_checkout_job <> '' then
      select
        count(*)::integer,
        coalesce(sum(a.allocated_feet), 0)::integer
      into v_same_job_active_allocation_count, v_same_job_active_allocated_feet
      from app.allocations a
      where a.org_id = p_org_id
        and a.box_id = v_box.box_id
        and a.status = 'ACTIVE'
        and upper(coalesce(a.job_number, '')) = upper(v_checkout_job);

      select
        coalesce(sum(a.allocated_feet), 0)::integer,
        coalesce(
          array_agg(distinct a.job_number) filter (
            where coalesce(a.job_number, '') <> ''
          ),
          array[]::text[]
        )
      into v_other_active_allocated_feet, v_other_jobs
      from app.allocations a
      where a.org_id = p_org_id
        and a.box_id = v_box.box_id
        and a.status = 'ACTIVE'
        and upper(coalesce(a.job_number, '')) <> upper(v_checkout_job);
    else
      v_same_job_active_allocation_count := 0;
      v_same_job_active_allocated_feet := 0;

      select
        coalesce(sum(a.allocated_feet), 0)::integer,
        coalesce(
          array_agg(distinct a.job_number) filter (
            where coalesce(a.job_number, '') <> ''
          ),
          array[]::text[]
        )
      into v_other_active_allocated_feet, v_other_jobs
      from app.allocations a
      where a.org_id = p_org_id
        and a.box_id = v_box.box_id
        and a.status = 'ACTIVE';
    end if;

    v_physical_feet_before := app_api.derive_box_physical_feet_before_checkin(
      v_existing,
      v_active_allocated_feet_before
    );

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

      if v_current_feet_on_roll > v_existing.initial_feet then
        perform app_api.raise_http(
          400,
          format(
            'CurrentFeetOnRoll cannot be greater than this box''s InitialFeet (%s).',
            v_existing.initial_feet
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

        v_resolved_core_type := coalesce(
          nullif(v_submitted_core_type, ''),
          app_api.normalize_core_type(v_existing.core_type, true),
          ''
        );
        if v_existing.core_weight_lbs is not null then
          v_resolved_core_weight := v_existing.core_weight_lbs;
        elsif v_resolved_core_type <> '' then
          v_resolved_core_weight := app_api.derive_core_weight_lbs(v_resolved_core_type, v_existing.width_in);
        else
          v_resolved_core_weight := null;
        end if;
        v_resolved_lf_weight := v_existing.lf_weight_lbs_per_ft;
      else
        if v_submitted_core_type <> '' then
          v_resolved_core_type := v_submitted_core_type;
          v_resolved_core_weight := app_api.derive_core_weight_lbs(v_resolved_core_type, v_existing.width_in);
        elsif v_existing.core_weight_lbs is not null then
          v_resolved_core_type := coalesce(app_api.normalize_core_type(v_existing.core_type, true), '');
          v_resolved_core_weight := v_existing.core_weight_lbs;
        elsif coalesce(app_api.normalize_core_type(v_existing.core_type, true), '') <> '' then
          v_resolved_core_type := app_api.normalize_core_type(v_existing.core_type, true);
          v_resolved_core_weight := app_api.derive_core_weight_lbs(v_resolved_core_type, v_existing.width_in);
        else
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
          ((v_last_roll_weight - v_resolved_core_weight) / v_current_feet_on_roll)::numeric,
          6
        );
      end if;
    end if;

    if v_other_active_allocated_feet > v_physical_feet_after then
      perform app_api.raise_http(
        400,
        format(
          'Received physical LF cannot be lower than the box''s active allocated feet (%s).',
          v_other_active_allocated_feet
        )
      );
    end if;

    if v_same_job_active_allocation_count > 0 and v_checkout_job <> '' then
      v_same_job_release := app_api.cancel_active_allocations_for_box_job_checkin(
        p_org_id,
        p_actor,
        v_box.box_id,
        v_checkout_job
      );

      if coalesce((v_same_job_release->>'cancelledCount')::integer, 0) > 0 then
        v_warnings := app_api.push_warning(
          v_warnings,
          format(
            'Released %s active planning allocation%s totaling %s LF for job %s during check-in.',
            coalesce((v_same_job_release->>'cancelledCount')::integer, 0),
            case when coalesce((v_same_job_release->>'cancelledCount')::integer, 0) = 1 then '' else 's' end,
            coalesce((v_same_job_release->>'cancelledFeet')::integer, 0),
            v_checkout_job
          )
        );
      end if;
    end if;

    if coalesce(array_length(v_other_jobs, 1), 0) > 0 then
      v_warnings := app_api.push_warning(
        v_warnings,
        'This box still has active allocations for ' || array_to_string(v_other_jobs, ', ') || '.'
      );
    end if;

    if v_resolved_core_type <> '' then
      v_box.core_type := v_resolved_core_type;
    end if;
    v_box.core_weight_lbs := v_resolved_core_weight;
    v_box.lf_weight_lbs_per_ft := v_resolved_lf_weight;
    v_box.feet_available := greatest(v_physical_feet_after - v_other_active_allocated_feet, 0);

    if v_existing.last_roll_weight_lbs is not null and v_box.last_roll_weight_lbs > v_existing.last_roll_weight_lbs then
      v_warnings := app_api.push_warning(
        v_warnings,
        'The new Last Roll Weight is greater than the box''s previous Last Roll Weight.'
      );
    end if;

    if v_existing.initial_weight_lbs is not null and v_box.last_roll_weight_lbs > v_existing.initial_weight_lbs then
      v_warnings := app_api.push_warning(
        v_warnings,
        'The new Last Roll Weight is greater than the box''s Initial Weight.'
      );
    end if;

    if
      v_box.last_roll_weight_lbs is not null
      and v_box.last_roll_weight_lbs > 0
      and v_box.core_weight_lbs is not null
      and v_box.last_roll_weight_lbs < v_box.core_weight_lbs
    then
      v_warnings := app_api.push_warning(
        v_warnings,
        'The new Last Roll Weight is below the derived core weight.'
      );
    end if;

    if v_physical_feet_after > v_physical_feet_before then
      v_warnings := app_api.push_warning(
        v_warnings,
        'The recalculated Available Feet would increase compared with the current box.'
      );
    end if;

    v_auto_move_to_zeroed :=
      v_box.received_date is not null
      and v_existing.initial_feet > 0
      and (v_physical_feet_after = 0 or coalesce(v_box.last_roll_weight_lbs, 0) = 0);

    if v_auto_move_to_zeroed then
      v_warnings := app_api.push_warning(
        v_warnings,
        'This check-in will auto-move the box into zeroed out inventory.'
      );
    end if;

    if v_other_active_allocated_feet > 0 and v_box.feet_available = 0 then
      v_warnings := app_api.push_warning(
        v_warnings,
        'All remaining LF on this box is reserved by active allocations.'
      );
    end if;

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

    if v_existing.last_roll_weight_lbs is null then
      v_warnings := app_api.push_warning(
        v_warnings,
        'Roll history was logged without an outbound weight because no Last Roll Weight was saved at checkout.'
      );
    end if;

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
        v_physical_feet_before,
        v_physical_feet_after,
        app_api.trim_text(p_payload->>'auditNote')
      )::app.roll_weight_log
    );

    v_box.last_checkout_job := '';
    v_box.last_checkout_date := null;

    v_reached_zero_state :=
      v_box.received_date is not null
      and (v_physical_feet_after = 0 or coalesce(v_box.last_roll_weight_lbs, 0) = 0);

    if v_auto_move_to_zeroed then
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
    elsif v_reached_zero_state and coalesce(v_existing.feet_available, 0) <= 0 then
      v_warnings := app_api.push_warning(
        v_warnings,
        'Box stayed in active inventory because it has not had Available Feet above 0 yet.'
      );
    end if;
  end if;

  v_box := app_api.save_box(v_box);
  v_public_after := app_api.public_box_json(v_box);
  v_log_id := app_api.append_audit_entry(
    p_org_id,
    case when v_box.status = 'ZEROED' and v_status = 'IN_STOCK' then 'ZERO_OUT_BOX' else 'SET_STATUS' end,
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
