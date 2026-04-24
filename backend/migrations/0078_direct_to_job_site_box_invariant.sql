alter table app.boxes
  add column if not exists direct_to_job_site boolean not null default false;

create or replace function app_api.box_has_weight_baseline(p_box app.boxes)
returns boolean
language sql
stable
as $$
  select p_box.last_roll_weight_lbs is not null;
$$;

create or replace function app_api.assert_legal_box_weight_state(p_box app.boxes)
returns void
language plpgsql
stable
security definer
set search_path = public, app, app_api
as $$
begin
  if upper(coalesce(p_box.status::text, '')) = 'CHECKED_OUT'
     and not app_api.box_has_weight_baseline(p_box)
     and coalesce(p_box.direct_to_job_site, false) is not true then
    perform app_api.raise_http(
      400,
      'A checked-out box without a saved Last Roll Weight is only allowed when it originated from direct-to-job-site fulfillment.'
    );
  end if;
end;
$$;

create or replace function app_api.save_box(p_box app.boxes)
returns app.boxes
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_row app.boxes;
begin
  perform app_api.assert_legal_box_weight_state(p_box);

  if app_api.trim_text(p_box.dealer) <> '' then
    perform app_api.upsert_box_dealer(p_box.org_id, p_box.dealer);
  end if;

  insert into app.boxes (
    id,
    org_id,
    box_id,
    warehouse,
    dealer,
    manufacturer,
    film_name,
    width_in,
    initial_feet,
    feet_available,
    lot_run,
    status,
    order_date,
    received_date,
    initial_weight_lbs,
    last_roll_weight_lbs,
    last_weighed_date,
    film_key,
    core_type,
    core_weight_lbs,
    lf_weight_lbs_per_ft,
    price_per_lf,
    purchase_cost,
    notes,
    direct_to_job_site,
    has_ever_been_checked_out,
    last_checkout_job,
    last_checkout_date,
    zeroed_date,
    zeroed_reason,
    zeroed_by
  )
  values (
    coalesce(p_box.id, gen_random_uuid()),
    p_box.org_id,
    p_box.box_id,
    p_box.warehouse,
    coalesce(p_box.dealer, ''),
    p_box.manufacturer,
    p_box.film_name,
    p_box.width_in,
    p_box.initial_feet,
    p_box.feet_available,
    coalesce(p_box.lot_run, ''),
    p_box.status,
    p_box.order_date,
    p_box.received_date,
    p_box.initial_weight_lbs,
    p_box.last_roll_weight_lbs,
    p_box.last_weighed_date,
    p_box.film_key,
    coalesce(p_box.core_type, ''),
    p_box.core_weight_lbs,
    p_box.lf_weight_lbs_per_ft,
    p_box.price_per_lf,
    p_box.purchase_cost,
    coalesce(p_box.notes, ''),
    coalesce(p_box.direct_to_job_site, false),
    coalesce(p_box.has_ever_been_checked_out, false),
    coalesce(p_box.last_checkout_job, ''),
    p_box.last_checkout_date,
    p_box.zeroed_date,
    coalesce(p_box.zeroed_reason, ''),
    coalesce(p_box.zeroed_by, '')
  )
  on conflict (org_id, box_id) do update set
    warehouse = excluded.warehouse,
    dealer = excluded.dealer,
    manufacturer = excluded.manufacturer,
    film_name = excluded.film_name,
    width_in = excluded.width_in,
    initial_feet = excluded.initial_feet,
    feet_available = excluded.feet_available,
    lot_run = excluded.lot_run,
    status = excluded.status,
    order_date = excluded.order_date,
    received_date = excluded.received_date,
    initial_weight_lbs = excluded.initial_weight_lbs,
    last_roll_weight_lbs = excluded.last_roll_weight_lbs,
    last_weighed_date = excluded.last_weighed_date,
    film_key = excluded.film_key,
    core_type = excluded.core_type,
    core_weight_lbs = excluded.core_weight_lbs,
    lf_weight_lbs_per_ft = excluded.lf_weight_lbs_per_ft,
    price_per_lf = excluded.price_per_lf,
    purchase_cost = excluded.purchase_cost,
    notes = excluded.notes,
    direct_to_job_site = excluded.direct_to_job_site,
    has_ever_been_checked_out = excluded.has_ever_been_checked_out,
    last_checkout_job = excluded.last_checkout_job,
    last_checkout_date = excluded.last_checkout_date,
    zeroed_date = excluded.zeroed_date,
    zeroed_reason = excluded.zeroed_reason,
    zeroed_by = excluded.zeroed_by
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function app_api.public_box_json(p_box app.boxes)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'boxId', coalesce(p_box.box_id, ''),
    'warehouse', coalesce(p_box.warehouse::text, ''),
    'dealer', coalesce(p_box.dealer, ''),
    'manufacturer', coalesce(p_box.manufacturer, ''),
    'filmName', coalesce(p_box.film_name, ''),
    'widthIn', p_box.width_in,
    'initialFeet', p_box.initial_feet,
    'feetAvailable', app_api.box_allocatable_now_feet(p_box),
    'physicalFeetAvailable', app_api.box_physical_feet_available(p_box),
    'allocatableNowFeet', app_api.box_allocatable_now_feet(p_box),
    'allocatedWithInstallDateFeet', app_api.locked_allocated_feet_for_box(p_box.org_id, p_box.box_id),
    'allocatedWithoutInstallDateFeet', app_api.placeholder_allocated_feet_for_box(p_box.org_id, p_box.box_id),
    'allocationPlanningFeet', app_api.box_allocatable_now_feet(p_box),
    'lotRun', coalesce(p_box.lot_run, ''),
    'status', coalesce(p_box.status::text, 'ORDERED'),
    'orderDate', coalesce(to_char(p_box.order_date, 'YYYY-MM-DD'), ''),
    'receivedDate', coalesce(to_char(p_box.received_date, 'YYYY-MM-DD'), ''),
    'initialWeightLbs', p_box.initial_weight_lbs,
    'lastRollWeightLbs', p_box.last_roll_weight_lbs,
    'lastWeighedDate', coalesce(to_char(p_box.last_weighed_date, 'YYYY-MM-DD'), ''),
    'filmKey', upper(coalesce(p_box.film_key, '')),
    'coreType', coalesce(p_box.core_type, ''),
    'coreWeightLbs', p_box.core_weight_lbs,
    'lfWeightLbsPerFt', p_box.lf_weight_lbs_per_ft,
    'purchaseCost', p_box.purchase_cost,
    'pricePerLf', p_box.price_per_lf,
    'notes', coalesce(p_box.notes, ''),
    'directToJobSite', coalesce(p_box.direct_to_job_site, false),
    'hasEverBeenCheckedOut', p_box.has_ever_been_checked_out,
    'lastCheckoutJob', coalesce(p_box.last_checkout_job, ''),
    'lastCheckoutDate', coalesce(to_char(p_box.last_checkout_date, 'YYYY-MM-DD'), ''),
    'zeroedDate', coalesce(to_char(p_box.zeroed_date, 'YYYY-MM-DD'), ''),
    'zeroedReason', coalesce(p_box.zeroed_reason, ''),
    'zeroedBy', coalesce(p_box.zeroed_by, '')
  );
$$;

create or replace function app_api.public_box_state_to_box_row(
  p_org_id uuid,
  p_state jsonb,
  p_existing_id uuid default null
)
returns app.boxes
language plpgsql
stable
security definer
set search_path = public, app, app_api
as $$
declare
  v_box app.boxes;
begin
  if p_state is null then
    return null;
  end if;

  v_box.id := p_existing_id;
  v_box.org_id := p_org_id;
  v_box.box_id := p_state->>'boxId';
  v_box.warehouse := app_api.require_org_warehouse(p_org_id, p_state->>'warehouse', 'Warehouse');
  v_box.dealer := coalesce(p_state->>'dealer', '');
  v_box.manufacturer := coalesce(p_state->>'manufacturer', '');
  v_box.film_name := coalesce(p_state->>'filmName', '');
  v_box.width_in := nullif(app_api.trim_text(p_state->>'widthIn'), '')::numeric;
  v_box.initial_feet := coalesce((p_state->>'initialFeet')::integer, 0);
  v_box.feet_available := coalesce((p_state->>'feetAvailable')::integer, 0);
  v_box.lot_run := coalesce(p_state->>'lotRun', '');
  v_box.status := (p_state->>'status')::app.box_status;
  v_box.order_date := nullif(app_api.trim_text(p_state->>'orderDate'), '')::date;
  v_box.received_date := nullif(app_api.trim_text(p_state->>'receivedDate'), '')::date;
  v_box.initial_weight_lbs := nullif(app_api.trim_text(p_state->>'initialWeightLbs'), '')::numeric;
  v_box.last_roll_weight_lbs := nullif(app_api.trim_text(p_state->>'lastRollWeightLbs'), '')::numeric;
  v_box.last_weighed_date := nullif(app_api.trim_text(p_state->>'lastWeighedDate'), '')::date;
  v_box.film_key := coalesce(p_state->>'filmKey', '');
  v_box.core_type := coalesce(p_state->>'coreType', '');
  v_box.core_weight_lbs := nullif(app_api.trim_text(p_state->>'coreWeightLbs'), '')::numeric;
  v_box.lf_weight_lbs_per_ft := nullif(app_api.trim_text(p_state->>'lfWeightLbsPerFt'), '')::numeric;
  v_box.price_per_lf := nullif(app_api.trim_text(p_state->>'pricePerLf'), '')::numeric;
  v_box.purchase_cost := nullif(app_api.trim_text(p_state->>'purchaseCost'), '')::numeric;
  v_box.notes := coalesce(p_state->>'notes', '');
  v_box.direct_to_job_site := coalesce((p_state->>'directToJobSite')::boolean, false);
  v_box.has_ever_been_checked_out := coalesce((p_state->>'hasEverBeenCheckedOut')::boolean, false);
  v_box.last_checkout_job := coalesce(p_state->>'lastCheckoutJob', '');
  v_box.last_checkout_date := nullif(app_api.trim_text(p_state->>'lastCheckoutDate'), '')::date;
  v_box.zeroed_date := nullif(app_api.trim_text(p_state->>'zeroedDate'), '')::date;
  v_box.zeroed_reason := coalesce(p_state->>'zeroedReason', '');
  v_box.zeroed_by := coalesce(p_state->>'zeroedBy', '');

  return v_box;
end;
$$;

create or replace function app_api.parse_ship_direct_to_job_site_flag(p_payload jsonb)
returns boolean
language plpgsql
stable
security definer
set search_path = public, app, app_api
as $$
declare
  v_value text;
begin
  if coalesce(p_payload, '{}'::jsonb) ? 'shipDirectToJobSite' then
    v_value := lower(app_api.trim_text(p_payload->>'shipDirectToJobSite'));

    if v_value in ('true', 't', '1', 'yes', 'on') then
      return true;
    end if;

    if v_value in ('false', 'f', '0', 'no', 'off') then
      return false;
    end if;

    perform app_api.raise_http(400, 'ShipDirectToJobSite must be true or false.');
  end if;

  return false;
end;
$$;

create or replace function app_api.assert_direct_to_job_site_flag_is_server_owned(
  p_payload jsonb,
  p_context_label text
)
returns void
language plpgsql
stable
security definer
set search_path = public, app, app_api
as $$
begin
  if coalesce(p_payload, '{}'::jsonb) ? 'directToJobSite' then
    perform app_api.raise_http(
      400,
      format(
        '%s cannot set DirectToJobSite directly. Use Ship Directly to Job Site on the approved Film Order fulfillment flow instead.',
        app_api.require_text(p_context_label, 'ContextLabel')
      )
    );
  end if;
end;
$$;

create or replace function app_api.assert_no_ship_direct_to_job_site_flag(
  p_payload jsonb,
  p_context_label text
)
returns void
language plpgsql
stable
security definer
set search_path = public, app, app_api
as $$
begin
  if coalesce(p_payload, '{}'::jsonb) ? 'shipDirectToJobSite' then
    perform app_api.raise_http(
      400,
      format(
        '%s cannot set ShipDirectToJobSite. That flag is only allowed when adding a box through Film Order fulfillment.',
        app_api.require_text(p_context_label, 'ContextLabel')
      )
    );
  end if;
end;
$$;

create or replace function app_api.assert_no_direct_to_job_site_receipt_inputs(p_payload jsonb)
returns void
language plpgsql
stable
security definer
set search_path = public, app, app_api
as $$
begin
  if app_api.trim_text(p_payload->>'receivedDate') <> ''
     or app_api.trim_text(p_payload->>'lastWeighedDate') <> ''
     or app_api.trim_text(p_payload->>'initialWeightLbs') <> ''
     or app_api.trim_text(p_payload->>'lastRollWeightLbs') <> ''
     or app_api.trim_text(p_payload->>'coreType') <> ''
     or app_api.trim_text(p_payload->>'coreWeightLbs') <> ''
     or app_api.trim_text(p_payload->>'lfWeightLbsPerFt') <> '' then
    perform app_api.raise_http(
      400,
      'Ship Directly to Job Site boxes cannot include warehouse receipt dates or initial warehouse weight fields.'
    );
  end if;
end;
$$;

create or replace function app_api.compute_direct_to_job_site_committed_feet(
  p_requested_feet integer,
  p_covered_feet integer,
  p_initial_feet integer
)
returns integer
language sql
immutable
as $$
  select least(
    greatest(coalesce(p_requested_feet, 0) - coalesce(p_covered_feet, 0), 0),
    greatest(coalesce(p_initial_feet, 0), 0)
  );
$$;

create or replace function app_api.compute_direct_to_job_site_available_feet(
  p_initial_feet integer,
  p_committed_feet integer
)
returns integer
language sql
immutable
as $$
  select greatest(coalesce(p_initial_feet, 0) - coalesce(p_committed_feet, 0), 0);
$$;

create or replace function app_api.requires_first_return_calibration(p_box app.boxes)
returns boolean
language sql
stable
as $$
  select
    upper(coalesce(p_box.status::text, '')) = 'CHECKED_OUT'
    and coalesce(p_box.direct_to_job_site, false) is true
    and p_box.received_date is null
    and not app_api.box_has_weight_baseline(p_box);
$$;

create or replace function app_api.build_direct_to_job_site_created_audit_note(
  p_film_order_id text,
  p_job_number text,
  p_user_note text default ''
)
returns text
language plpgsql
stable
security definer
set search_path = public, app, app_api
as $$
declare
  v_note text := format(
    'DIRECT_TO_SITE_CREATED: Created from Film Order %s for job %s; shipped directly to job site; no warehouse receipt; no initial weight recorded.',
    app_api.require_text(p_film_order_id, 'FilmOrderId'),
    app_api.require_text(p_job_number, 'JobNumber')
  );
  v_user_note text := app_api.trim_text(p_user_note);
begin
  if v_user_note <> '' then
    v_note := v_note || ' Additional note: ' || v_user_note;
  end if;

  return v_note;
end;
$$;

create or replace function app_api.build_direct_to_job_site_checked_out_audit_note(
  p_film_order_id text,
  p_job_number text
)
returns text
language sql
stable
as $$
  select format(
    'DIRECT_TO_SITE_CHECKED_OUT: Box committed directly to job %s from Film Order %s.',
    app_api.require_text(p_job_number, 'JobNumber'),
    app_api.require_text(p_film_order_id, 'FilmOrderId')
  );
$$;

create or replace function app_api.build_direct_to_job_site_first_return_note(
  p_job_number text,
  p_last_roll_weight_lbs numeric,
  p_current_feet_on_roll integer,
  p_user_note text default ''
)
returns text
language plpgsql
stable
security definer
set search_path = public, app, app_api
as $$
declare
  v_note text := format(
    'DIRECT_TO_SITE_FIRST_RETURN: First warehouse return from job %s; received at %s lbs with %s LF remaining.',
    app_api.require_text(p_job_number, 'JobNumber'),
    coalesce(p_last_roll_weight_lbs, 0),
    greatest(coalesce(p_current_feet_on_roll, 0), 0)
  );
  v_user_note text := app_api.trim_text(p_user_note);
begin
  if v_user_note <> '' then
    v_note := v_note || ' Additional note: ' || v_user_note;
  end if;

  return v_note;
end;
$$;

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
  v_ship_direct_to_job_site boolean := app_api.parse_ship_direct_to_job_site_flag(p_payload);
  v_committed_feet integer := 0;
  v_allocation_resolution jsonb := jsonb_build_object(
    'fulfilledCount', 0,
    'fulfilledFeet', 0,
    'otherJobs', '[]'::jsonb
  );
  v_public_before_checkout jsonb;
  v_public_after_checkout jsonb;
  v_job app.jobs;
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

  perform app_api.assert_direct_to_job_site_flag_is_server_owned(p_payload, 'Add Box');

  if v_requested_warehouse <> '' then
    v_requested_warehouse := app_api.require_org_warehouse(p_org_id, v_requested_warehouse, 'Warehouse');
  end if;

  if v_ship_direct_to_job_site and v_film_order_id = '' then
    perform app_api.raise_http(
      400,
      'Ship Directly to Job Site is only available when adding a box through Film Order fulfillment.'
    );
  end if;

  if v_ship_direct_to_job_site then
    perform app_api.assert_no_direct_to_job_site_receipt_inputs(p_payload);
  end if;

  v_build := app_api.build_box_from_payload(p_org_id, p_payload, null);
  v_box := jsonb_populate_record(null::app.boxes, v_build->'box');
  v_box.dealer := app_api.trim_text(p_payload->>'dealer');
  v_box.direct_to_job_site := false;
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

  if v_ship_direct_to_job_site then
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

    if app_api.trim_text(v_order.job_number) = '' then
      perform app_api.raise_http(
        400,
        format(
          'Film Order %s must stay linked to a job before Ship Directly to Job Site can be used.',
          v_order.film_order_id
        )
      );
    end if;

    if v_order.job_date is null then
      perform app_api.raise_http(
        400,
        format(
          'Film Order %s must have an Install Date before Ship Directly to Job Site can be used.',
          v_order.film_order_id
        )
      );
    end if;

    select *
    into v_job
    from app.jobs j
    where j.org_id = p_org_id
      and j.job_number = v_order.job_number
    for update;

    if not found then
      perform app_api.raise_http(
        400,
        format(
          'Film Order %s must stay linked to an active job before Ship Directly to Job Site can be used.',
          v_order.film_order_id
        )
      );
    end if;

    if app_api.normalize_job_lifecycle_status(v_job.lifecycle_status::text) <> 'ACTIVE'::app.job_lifecycle_status then
      perform app_api.raise_http(
        400,
        format(
          'Job %s is closed and cannot receive direct-to-job-site film.',
          v_order.job_number
        )
      );
    end if;

    v_box.status := 'ORDERED';
    v_box.received_date := null;
    v_box.initial_weight_lbs := null;
    v_box.last_roll_weight_lbs := null;
    v_box.last_weighed_date := null;
    v_box.core_type := '';
    v_box.core_weight_lbs := null;
    v_box.lf_weight_lbs_per_ft := null;
    v_box.feet_available := 0;
    v_box.direct_to_job_site := true;
  end if;

  v_box := app_api.save_box(v_box);

  if v_ship_direct_to_job_site then
    v_public_box := app_api.public_box_json(v_box);
    v_log_id := app_api.append_audit_entry(
      p_org_id,
      'ADD_BOX',
      v_box.box_id,
      null,
      v_public_box,
      p_actor,
      app_api.build_direct_to_job_site_created_audit_note(
        v_order.film_order_id,
        v_order.job_number,
        p_payload->>'auditNote'
      )
    );
  end if;

  if v_film_order_id <> '' then
    if v_order.id is null then
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

    if v_ship_direct_to_job_site then
      v_committed_feet := app_api.compute_direct_to_job_site_committed_feet(
        v_order.requested_feet,
        v_order.covered_feet,
        v_box.initial_feet
      );

      if v_committed_feet > 0 then
        perform app_api.create_allocation(
          p_org_id,
          v_box,
          jsonb_build_object(
            'jobNumber', v_order.job_number,
            'jobDate', coalesce(to_char(v_order.job_date, 'YYYY-MM-DD'), ''),
            'crewLeader', coalesce(v_order.crew_leader, '')
          ),
          v_committed_feet,
          p_actor,
          v_order.film_order_id,
          'REQUIREMENT',
          null
        );
      end if;

      v_public_before_checkout := app_api.public_box_json(v_box);
      v_box.status := 'CHECKED_OUT';
      v_box.direct_to_job_site := true;
      v_box.feet_available := app_api.compute_direct_to_job_site_available_feet(
        v_box.initial_feet,
        v_committed_feet
      );
      v_box.has_ever_been_checked_out := true;
      v_box.last_checkout_job := v_order.job_number;
      v_box.last_checkout_date := app_api.today_date();
      v_box.zeroed_date := null;
      v_box.zeroed_reason := '';
      v_box.zeroed_by := '';
      v_box := app_api.save_box(v_box);

      v_allocation_resolution := app_api.resolve_allocations_for_checkout(
        p_org_id,
        v_box.box_id,
        v_order.job_number,
        p_actor
      );

      if coalesce((v_allocation_resolution->>'fulfilledCount')::integer, 0) > 0 then
        v_warnings := app_api.push_warning(
          v_warnings,
          format(
            'Kept %s allocation%s totaling %s LF linked to job %s after direct-to-site checkout.',
            (v_allocation_resolution->>'fulfilledCount')::integer,
            case when (v_allocation_resolution->>'fulfilledCount')::integer = 1 then '' else 's' end,
            (v_allocation_resolution->>'fulfilledFeet')::integer,
            v_order.job_number
          )
        );
      end if;

      if jsonb_array_length(coalesce(v_allocation_resolution->'otherJobs', '[]'::jsonb)) > 0 then
        v_warnings := app_api.push_warning(
          v_warnings,
          'This box still has active allocations for ' ||
            array_to_string(array(select jsonb_array_elements_text(v_allocation_resolution->'otherJobs')), ', ') || '.'
        );
      end if;

      perform app_api.recalculate_film_orders_for_box_links(p_org_id, v_box.box_id, p_actor);
      v_public_after_checkout := app_api.public_box_json(v_box);
      perform app_api.append_audit_entry(
        p_org_id,
        'SET_STATUS',
        v_box.box_id,
        v_public_before_checkout,
        v_public_after_checkout,
        p_actor,
        app_api.build_direct_to_job_site_checked_out_audit_note(
          v_order.film_order_id,
          v_order.job_number
        )
      );

      return jsonb_build_object(
        'boxId', v_box.box_id,
        'logId', v_log_id,
        'warnings', to_jsonb(v_warnings)
      );
    end if;

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
  perform app_api.assert_direct_to_job_site_flag_is_server_owned(p_payload, 'Update Box');
  perform app_api.assert_no_ship_direct_to_job_site_flag(p_payload, 'Update Box');

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
  v_box.direct_to_job_site := coalesce(v_existing.direct_to_job_site, false);
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
    v_box.direct_to_job_site := coalesce(v_existing.direct_to_job_site, false);
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
