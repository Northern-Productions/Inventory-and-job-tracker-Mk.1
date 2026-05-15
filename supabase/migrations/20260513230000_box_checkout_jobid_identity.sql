/**
 * PURPOSE:
 * Add durable jobId identity groundwork for film box checkout/check-in while
 * preserving legacy jobNumber and audit-note behavior.
 *
 * AFFECTS:
 * app.boxes checkout state, app.roll_weight_log history rows, box status RPCs,
 * audit restore serialization, and SQL-owned planner scope for box status.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * backend/runtime box status helpers, Edge /boxes/set-status facade, frontend
 * Box/roll-history types, checkout-all/staged-pickup callers, and schema latest
 * checks.
 *
 * COMMON FAILURE MODES:
 * Inferring jobId from jobNumber, breaking legacy audit-note check-in, forgetting
 * app_api.save_box explicit columns, or running both Edge and SQL planner passes.
 */

alter table app.boxes
  add column if not exists last_checkout_job_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    where c.conname = 'boxes_last_checkout_job_id_fkey'
      and c.conrelid = 'app.boxes'::regclass
  ) then
    alter table app.boxes
      add constraint boxes_last_checkout_job_id_fkey
      foreign key (last_checkout_job_id)
      references app.jobs(id)
      on delete set null;
  end if;
end;
$$;

create index if not exists idx_boxes_org_last_checkout_job_id
  on app.boxes (org_id, last_checkout_job_id)
  where last_checkout_job_id is not null;

alter table app.roll_weight_log
  add column if not exists job_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    where c.conname = 'roll_weight_log_job_id_fkey'
      and c.conrelid = 'app.roll_weight_log'::regclass
  ) then
    alter table app.roll_weight_log
      add constraint roll_weight_log_job_id_fkey
      foreign key (job_id)
      references app.jobs(id)
      on delete set null;
  end if;
end;
$$;

create index if not exists idx_roll_weight_log_org_job_id
  on app.roll_weight_log (org_id, job_id)
  where job_id is not null;

do $$
declare
  v_def text;
  v_base text;
  v_next text;
begin
  select pg_get_functiondef('app_api.save_box(app.boxes)'::regprocedure)
  into v_def;

  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  if position('last_checkout_job_id = excluded.last_checkout_job_id' in v_base) > 0 then
    return;
  end if;

  v_next := replace(
    v_next,
    replace($old$
    has_ever_been_checked_out,
    last_checkout_job,
$old$, E'\r\n', E'\n'),
    replace($new$
    has_ever_been_checked_out,
    last_checkout_job_id,
    last_checkout_job,
$new$, E'\r\n', E'\n')
  );

  v_next := replace(
    v_next,
    replace($old$
    coalesce(p_box.has_ever_been_checked_out, false),
    coalesce(p_box.last_checkout_job, ''),
$old$, E'\r\n', E'\n'),
    replace($new$
    coalesce(p_box.has_ever_been_checked_out, false),
    p_box.last_checkout_job_id,
    coalesce(p_box.last_checkout_job, ''),
$new$, E'\r\n', E'\n')
  );

  v_next := replace(
    v_next,
    replace($old$
    has_ever_been_checked_out = excluded.has_ever_been_checked_out,
    last_checkout_job = excluded.last_checkout_job,
$old$, E'\r\n', E'\n'),
    replace($new$
    has_ever_been_checked_out = excluded.has_ever_been_checked_out,
    last_checkout_job_id = excluded.last_checkout_job_id,
    last_checkout_job = excluded.last_checkout_job,
$new$, E'\r\n', E'\n')
  );

  if v_next = v_base
     or position('last_checkout_job_id = excluded.last_checkout_job_id' in v_next) = 0
     or position('p_box.last_checkout_job_id' in v_next) = 0 then
    raise exception 'app_api.save_box last_checkout_job_id patch did not match expected snippets';
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
  select pg_get_functiondef('app_api.public_box_json(app.boxes)'::regprocedure)
  into v_def;

  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  if position('''lastCheckoutJobId'', coalesce(p_box.last_checkout_job_id::text, '''')' in v_base) > 0 then
    return;
  end if;

  v_next := replace(
    v_next,
    replace($old$
    'hasEverBeenCheckedOut', p_box.has_ever_been_checked_out,
    'lastCheckoutJob', coalesce(p_box.last_checkout_job, ''),
$old$, E'\r\n', E'\n'),
    replace($new$
    'hasEverBeenCheckedOut', p_box.has_ever_been_checked_out,
    'lastCheckoutJobId', coalesce(p_box.last_checkout_job_id::text, ''),
    'lastCheckoutJob', coalesce(p_box.last_checkout_job, ''),
$new$, E'\r\n', E'\n')
  );

  if v_next = v_base
     or position('''lastCheckoutJobId'', coalesce(p_box.last_checkout_job_id::text, '''')' in v_next) = 0 then
    raise exception 'app_api.public_box_json lastCheckoutJobId patch did not match expected snippets';
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
  select pg_get_functiondef('app_api.public_box_state_to_box_row(uuid, jsonb, uuid)'::regprocedure)
  into v_def;

  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  if position('v_box.last_checkout_job_id := nullif(app_api.trim_text(p_state->>''lastCheckoutJobId''), '''')::uuid;' in v_base) > 0 then
    return;
  end if;

  v_next := replace(
    v_next,
    replace($old$
  v_box.has_ever_been_checked_out := coalesce((p_state->>'hasEverBeenCheckedOut')::boolean, false);
  v_box.last_checkout_job := coalesce(p_state->>'lastCheckoutJob', '');
$old$, E'\r\n', E'\n'),
    replace($new$
  v_box.has_ever_been_checked_out := coalesce((p_state->>'hasEverBeenCheckedOut')::boolean, false);
  v_box.last_checkout_job_id := nullif(app_api.trim_text(p_state->>'lastCheckoutJobId'), '')::uuid;
  v_box.last_checkout_job := coalesce(p_state->>'lastCheckoutJob', '');
$new$, E'\r\n', E'\n')
  );

  if v_next = v_base
     or position('v_box.last_checkout_job_id := nullif(app_api.trim_text(p_state->>''lastCheckoutJobId''), '''')::uuid;' in v_next) = 0 then
    raise exception 'app_api.public_box_state_to_box_row lastCheckoutJobId patch did not match expected snippets';
  end if;

  execute v_next;
end;
$$;

create or replace function app_api.append_roll_history_entry(
  p_org_id uuid,
  p_entry app.roll_weight_log
)
returns text
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_log_id text := coalesce(nullif(app_api.trim_text(p_entry.log_id), ''), app_api.create_log_id());
begin
  insert into app.roll_weight_log (
    id,
    org_id,
    log_id,
    box_id,
    warehouse,
    manufacturer,
    film_name,
    width_in,
    job_id,
    job_number,
    checked_out_at,
    checked_out_by,
    checked_out_weight_lbs,
    checked_in_at,
    checked_in_by,
    checked_in_weight_lbs,
    weight_delta_lbs,
    feet_before,
    feet_after,
    notes,
    created_at
  )
  values (
    coalesce(p_entry.id, gen_random_uuid()),
    p_org_id,
    v_log_id,
    p_entry.box_id,
    p_entry.warehouse,
    p_entry.manufacturer,
    p_entry.film_name,
    p_entry.width_in,
    p_entry.job_id,
    coalesce(p_entry.job_number, ''),
    p_entry.checked_out_at,
    coalesce(p_entry.checked_out_by, ''),
    p_entry.checked_out_weight_lbs,
    p_entry.checked_in_at,
    coalesce(p_entry.checked_in_by, ''),
    p_entry.checked_in_weight_lbs,
    p_entry.weight_delta_lbs,
    coalesce(p_entry.feet_before, 0),
    coalesce(p_entry.feet_after, 0),
    coalesce(p_entry.notes, ''),
    coalesce(p_entry.created_at, now())
  );

  return v_log_id;
end;
$$;

create or replace function app_api.append_roll_history(
  p_org_id uuid,
  p_box_id text,
  p_warehouse text,
  p_manufacturer text,
  p_film_name text,
  p_width_in numeric,
  p_job_number text,
  p_job_id uuid,
  p_checked_out_at text,
  p_checked_out_by text,
  p_checked_out_weight_lbs numeric,
  p_checked_in_at timestamp with time zone,
  p_checked_in_by text,
  p_checked_in_weight_lbs numeric,
  p_weight_delta_lbs numeric,
  p_feet_before integer,
  p_feet_after integer,
  p_notes text
)
returns text
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_log_id text := app_api.create_log_id();
begin
  insert into app.roll_weight_log (
    id,
    org_id,
    log_id,
    box_id,
    warehouse,
    manufacturer,
    film_name,
    width_in,
    job_id,
    job_number,
    checked_out_at,
    checked_out_by,
    checked_out_weight_lbs,
    checked_in_at,
    checked_in_by,
    checked_in_weight_lbs,
    weight_delta_lbs,
    feet_before,
    feet_after,
    notes,
    created_at
  )
  values (
    gen_random_uuid(),
    p_org_id,
    v_log_id,
    app_api.require_text(p_box_id, 'BoxID'),
    upper(app_api.require_text(p_warehouse, 'Warehouse')),
    app_api.require_text(p_manufacturer, 'Manufacturer'),
    app_api.require_text(p_film_name, 'FilmName'),
    p_width_in,
    p_job_id,
    coalesce(nullif(app_api.trim_text(p_job_number), ''), 'UNKNOWN'),
    coalesce(nullif(app_api.trim_text(p_checked_out_at), '')::timestamptz, now()),
    app_api.trim_text(p_checked_out_by),
    p_checked_out_weight_lbs,
    coalesce(p_checked_in_at, now()),
    app_api.trim_text(p_checked_in_by),
    p_checked_in_weight_lbs,
    p_weight_delta_lbs,
    coalesce(p_feet_before, 0),
    coalesce(p_feet_after, 0),
    app_api.trim_text(p_notes),
    now()
  );

  return v_log_id;
end;
$$;

create or replace function app_api.append_roll_history(
  p_org_id uuid,
  p_box_id text,
  p_warehouse text,
  p_manufacturer text,
  p_film_name text,
  p_width_in numeric,
  p_job_number text,
  p_job_id uuid,
  p_checked_out_at text,
  p_checked_out_by text,
  p_checked_out_weight_lbs numeric,
  p_checked_in_at timestamp without time zone,
  p_checked_in_by text,
  p_checked_in_weight_lbs numeric,
  p_weight_delta_lbs numeric,
  p_feet_before integer,
  p_feet_after integer,
  p_notes text
)
returns text
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_log_id text := app_api.create_log_id();
begin
  insert into app.roll_weight_log (
    id,
    org_id,
    log_id,
    box_id,
    warehouse,
    manufacturer,
    film_name,
    width_in,
    job_id,
    job_number,
    checked_out_at,
    checked_out_by,
    checked_out_weight_lbs,
    checked_in_at,
    checked_in_by,
    checked_in_weight_lbs,
    weight_delta_lbs,
    feet_before,
    feet_after,
    notes,
    created_at
  )
  values (
    gen_random_uuid(),
    p_org_id,
    v_log_id,
    app_api.require_text(p_box_id, 'BoxID'),
    upper(app_api.require_text(p_warehouse, 'Warehouse')),
    app_api.require_text(p_manufacturer, 'Manufacturer'),
    app_api.require_text(p_film_name, 'FilmName'),
    p_width_in,
    p_job_id,
    coalesce(nullif(app_api.trim_text(p_job_number), ''), 'UNKNOWN'),
    coalesce(nullif(app_api.trim_text(p_checked_out_at), '')::timestamptz, now()),
    app_api.trim_text(p_checked_out_by),
    p_checked_out_weight_lbs,
    coalesce(p_checked_in_at::timestamptz, now()),
    app_api.trim_text(p_checked_in_by),
    p_checked_in_weight_lbs,
    p_weight_delta_lbs,
    coalesce(p_feet_before, 0),
    coalesce(p_feet_after, 0),
    app_api.trim_text(p_notes),
    now()
  );

  return v_log_id;
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
  v_selected_job app.jobs;
  v_status text := upper(app_api.require_text(p_payload->>'status', 'Status'));
  v_log_id text;
  v_public_before jsonb;
  v_public_after jsonb;
  v_warnings text[] := array[]::text[];
  v_payload_job_id_text text := app_api.trim_text(p_payload->>'jobId');
  v_payload_job_number text := app_api.trim_text(p_payload->>'jobNumber');
  v_checkout_job_id uuid := null;
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
  v_receipt_result jsonb := jsonb_build_object('warnings', '[]'::jsonb);
  v_requires_first_return_calibration boolean := false;
  v_direct_to_site_first_return_note text := '';
  v_result jsonb;
begin
  perform app_api.require_org_member(p_org_id);
  perform app_api.assert_direct_to_job_site_flag_is_server_owned(p_payload, 'Set Box Status');
  perform app_api.assert_no_ship_direct_to_job_site_flag(p_payload, 'Set Box Status');

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

  v_requires_first_return_calibration := app_api.requires_first_return_calibration(v_existing);

  if v_existing.received_date is null and not (v_requires_first_return_calibration and v_status = 'IN_STOCK') then
    perform app_api.raise_http(400, 'Add a ReceivedDate on or before today before changing status.');
  end if;

  if v_existing.status in ('ZEROED', 'RETIRED') then
    perform app_api.raise_http(400, 'This box cannot change status directly. Use audit undo instead.');
  end if;

  v_box := v_existing;
  v_public_before := app_api.public_box_json(v_existing);

  if v_status = 'CHECKED_OUT' then
    perform app_api.assert_can_checkout_box_from_warehouse(v_existing);

    v_checkout_job := app_api.parse_checkout_job_from_note(p_payload->>'auditNote');

    if v_payload_job_id_text <> '' then
      if v_payload_job_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        perform app_api.raise_http(400, 'jobId must be a valid UUID.');
      end if;

      v_checkout_job_id := v_payload_job_id_text::uuid;

      select *
      into v_selected_job
      from app.jobs j
      where j.org_id = p_org_id
        and j.id = v_checkout_job_id;

      if not found then
        perform app_api.raise_http(404, format('Job %s was not found.', v_payload_job_id_text));
      end if;

      if v_checkout_job = '' and v_payload_job_number <> '' then
        v_checkout_job := v_payload_job_number;
      end if;

      if v_checkout_job <> '' and upper(trim(v_checkout_job)) <> upper(trim(v_selected_job.job_number)) then
        perform app_api.raise_http(400, 'jobId does not match jobNumber.');
      end if;

      v_checkout_job := v_selected_job.job_number;
    end if;

    if v_checkout_job = '' then
      perform app_api.raise_http(400, 'A checkout job number is required.');
    end if;

    v_box.status := 'CHECKED_OUT';
    v_box.has_ever_been_checked_out := true;
    v_box.last_checkout_job_id := v_checkout_job_id;
    v_box.last_checkout_job := v_checkout_job;
    v_box.last_checkout_date := app_api.today_date();
    v_box.zeroed_date := null;
    v_box.zeroed_reason := '';
    v_box.zeroed_by := '';

    if v_existing.last_weighed_date is null then
      v_warnings := app_api.push_warning(
        v_warnings,
        'This box does not have a Last Weighed Date saved yet.'
      );
    end if;

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
    if v_requires_first_return_calibration then
      v_box.received_date := app_api.today_date();
    end if;
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

    if v_existing.last_checkout_job_id is not null then
      select *
      into v_selected_job
      from app.jobs j
      where j.org_id = p_org_id
        and j.id = v_existing.last_checkout_job_id;

      if found then
        v_checkout_job_id := v_selected_job.id;
        v_checkout_job := v_selected_job.job_number;
      end if;
    end if;

    if v_checkout_job = '' then
      v_checkout_job := coalesce(nullif(v_existing.last_checkout_job, ''), app_api.parse_checkout_job_from_note(v_checkout_audit.notes));
    end if;
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

    if v_other_active_allocated_feet > v_physical_feet_after then
      perform app_api.raise_http(
        400,
        format(
          'Received physical LF cannot be lower than the box''s active allocated feet (%s).',
          v_other_active_allocated_feet
        )
      );
    end if;

    v_box.core_type := v_resolved_core_type;
    v_box.core_weight_lbs := v_resolved_core_weight;
    v_box.lf_weight_lbs_per_ft := v_resolved_lf_weight;
    v_box.feet_available := greatest(v_physical_feet_after - v_other_active_allocated_feet, 0);

    if v_same_job_active_allocation_count > 0 and v_checkout_job <> '' then
      v_same_job_release := app_api.cancel_active_allocations_for_box_job(
        p_org_id,
        v_box.box_id,
        v_checkout_job,
        p_actor,
        'Released during film box check-in.'
      );
      if coalesce((v_same_job_release->>'cancelledCount')::integer, 0) > 0 then
        v_warnings := app_api.push_warning(
          v_warnings,
          format(
            'Released %s active planning allocation%s totaling %s LF for job %s during check-in.',
            (v_same_job_release->>'cancelledCount')::integer,
            case when (v_same_job_release->>'cancelledCount')::integer = 1 then '' else 's' end,
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

    if v_box.last_roll_weight_lbs > 0 and v_box.core_weight_lbs is not null and v_box.last_roll_weight_lbs < v_box.core_weight_lbs then
      v_warnings := app_api.push_warning(
        v_warnings,
        'The new Last Roll Weight is below the derived core weight.'
      );
    end if;

    if v_box.feet_available > greatest(v_existing.feet_available, 0) then
      v_warnings := app_api.push_warning(
        v_warnings,
        'The recalculated Available Feet would increase compared with the current box.'
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

    if v_requires_first_return_calibration then
      v_direct_to_site_first_return_note := app_api.build_direct_to_job_site_first_return_note(
        coalesce(nullif(v_checkout_job, ''), 'UNKNOWN'),
        v_box.last_roll_weight_lbs,
        coalesce(v_current_feet_on_roll, v_physical_feet_after),
        p_payload->>'auditNote'
      );
    else
      v_direct_to_site_first_return_note := app_api.trim_text(p_payload->>'auditNote');
    end if;

    perform app_api.append_roll_history(
      p_org_id,
      v_box.box_id,
      v_box.warehouse,
      v_box.manufacturer,
      v_box.film_name,
      v_box.width_in,
      coalesce(nullif(v_checkout_job, ''), 'UNKNOWN'),
      v_checkout_job_id,
      v_checkout_date,
      v_checkout_user,
      v_existing.last_roll_weight_lbs,
      timezone('utc', now()),
      app_api.trim_text(p_actor),
      v_box.last_roll_weight_lbs,
      v_weight_delta,
      v_physical_feet_before,
      v_physical_feet_after,
      v_direct_to_site_first_return_note
    );

    v_box.last_checkout_job_id := null;
    v_box.last_checkout_job := '';
    v_box.last_checkout_date := null;

    v_reached_zero_state :=
      (v_box.received_date is not null or v_requires_first_return_calibration)
      and (v_physical_feet_after = 0 or v_box.last_roll_weight_lbs = 0);
    v_auto_move_to_zeroed :=
      (v_box.received_date is not null or v_requires_first_return_calibration)
      and coalesce(v_existing.initial_feet, 0) > 0
      and (v_physical_feet_after = 0 or v_box.last_roll_weight_lbs = 0);

    if v_auto_move_to_zeroed then
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

    if v_box.status = 'IN_STOCK' then
      v_receipt_result := app_api.process_linked_box_receipt(p_org_id, v_box, p_actor);
      if coalesce(v_receipt_result, '{}'::jsonb) ? 'box' then
        v_box := jsonb_populate_record(null::app.boxes, v_receipt_result->'box');
      end if;
      if jsonb_typeof(coalesce(v_receipt_result->'warnings', '[]'::jsonb)) = 'array' then
        v_warnings := v_warnings || array(
          select jsonb_array_elements_text(coalesce(v_receipt_result->'warnings', '[]'::jsonb))
        );
      end if;
    end if;
  end if;

  v_box := app_api.save_box(v_box);
  if v_box.status <> 'CHECKED_OUT' then
    perform app_api.recalculate_film_orders_for_box_links(p_org_id, v_box.box_id, p_actor);
  end if;
  v_public_after := app_api.public_box_json(v_box);

  v_log_id := app_api.append_audit_entry(
    p_org_id,
    case when v_box.status = 'ZEROED' and v_status = 'IN_STOCK' then 'ZERO_OUT_BOX' else 'SET_STATUS' end,
    v_box.box_id,
    v_public_before,
    v_public_after,
    p_actor,
    case
      when v_requires_first_return_calibration then v_direct_to_site_first_return_note
      else app_api.trim_text(p_payload->>'auditNote')
    end
  );

  v_result := jsonb_build_object(
    'boxId', v_box.box_id,
    'logId', v_log_id,
    'warnings', to_jsonb(v_warnings)
  );

  if v_checkout_job_id is not null then
    v_result := v_result || jsonb_build_object(
      'jobId', v_checkout_job_id::text,
      'jobNumber', v_checkout_job
    );
  end if;

  return v_result;
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
  v_result jsonb;
  v_box app.boxes;
  v_scope jsonb;
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
  v_result := public.api_boxes_set_status(p_org_id, p_actor, v_payload);

  select *
  into v_box
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = v_lookup_box_id
  limit 1;

  if found and upper(coalesce(v_box.status::text, '')) in ('IN_STOCK', 'TRANSFER') then
    perform app_api.recalculate_physical_box_allocatable_now(p_org_id, v_lookup_box_id);
  end if;

  v_scope := jsonb_build_object('boxIds', jsonb_build_array(v_lookup_box_id));
  if app_api.trim_text(v_result->>'jobId') <> '' then
    v_scope := v_scope || jsonb_build_object(
      'jobIds', jsonb_build_array(v_result->>'jobId'),
      'jobNumbers', jsonb_build_array(v_result->>'jobNumber')
    );
  end if;

  perform app_api.reconcile_auto_planned_allocations(
    p_org_id,
    p_actor,
    v_scope
  );

  return v_result;
end;
$$;
