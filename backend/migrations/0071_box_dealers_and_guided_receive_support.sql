-- Keep backend and Supabase migration streams aligned for box dealer registry support.

create table if not exists app.box_dealers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations(id) on delete cascade,
  name text not null,
  lookup_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, lookup_key)
);

do $$
begin
  alter table app.box_dealers
    add constraint box_dealers_name_not_blank
    check (btrim(name) <> '');
exception
  when duplicate_object then
    null;
end;
$$;

do $$
begin
  alter table app.box_dealers
    add constraint box_dealers_lookup_key_not_blank
    check (btrim(lookup_key) <> '' and lookup_key = lower(lookup_key));
exception
  when duplicate_object then
    null;
end;
$$;

create index if not exists box_dealers_org_name_idx
  on app.box_dealers (org_id, lower(name));

alter table app.boxes
  add column if not exists dealer text not null default '';

alter table app.boxes
  alter column dealer set default '';

update app.boxes
set dealer = ''
where dealer is null;

alter table app.boxes
  alter column dealer set not null;

create or replace function app_api.seed_default_box_dealers(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  if p_org_id is null then
    return;
  end if;

  insert into app.box_dealers (
    org_id,
    name,
    lookup_key
  )
  select
    p_org_id,
    defaults.name,
    app_api.normalize_catalog_lookup_key(defaults.name)
  from (
    values
      ('Eastman Performance Films'::text),
      ('Energy Products Distribution'::text),
      ('Accent'::text),
      ('Decorative Films'::text),
      ('Kingston Coatings'::text)
  ) as defaults(name)
  on conflict (org_id, lookup_key) do nothing;
end;
$$;

create or replace function app_api.upsert_box_dealer(
  p_org_id uuid,
  p_name text
)
returns app.box_dealers
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_name text := app_api.trim_text(p_name);
  v_row app.box_dealers;
begin
  if p_org_id is null or v_name = '' then
    return null;
  end if;

  insert into app.box_dealers (
    org_id,
    name,
    lookup_key
  )
  values (
    p_org_id,
    v_name,
    app_api.normalize_catalog_lookup_key(v_name)
  )
  on conflict (org_id, lookup_key) do update set
    name = excluded.name,
    updated_at = now()
  returning *
  into v_row;

  return v_row;
end;
$$;

do $$
declare
  v_org_id uuid;
begin
  for v_org_id in
    select o.id
    from app.organizations o
  loop
    perform app_api.seed_default_box_dealers(v_org_id);
  end loop;
end;
$$;

create or replace function public.api_acl_list_box_dealers(p_org_id uuid)
returns table (
  dealer_id uuid,
  name text,
  lookup_key text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'read');
  perform app_api.seed_default_box_dealers(p_org_id);

  return query
  select
    d.id as dealer_id,
    d.name,
    d.lookup_key,
    d.updated_at
  from app.box_dealers d
  where d.org_id = p_org_id
  order by lower(d.name), d.updated_at desc, d.id asc;
end;
$$;

create or replace function public.api_acl_box_dealers_upsert(
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
  v_row app.box_dealers;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');
  perform app_api.seed_default_box_dealers(p_org_id);

  v_row := app_api.upsert_box_dealer(
    p_org_id,
    app_api.require_text(p_payload->>'name', 'Name')
  );

  return jsonb_build_object(
    'dealerId', v_row.id,
    'name', v_row.name,
    'lookupKey', v_row.lookup_key,
    'updatedAt', v_row.updated_at
  );
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
  v_box.has_ever_been_checked_out := coalesce((p_state->>'hasEverBeenCheckedOut')::boolean, false);
  v_box.last_checkout_job := coalesce(p_state->>'lastCheckoutJob', '');
  v_box.last_checkout_date := nullif(app_api.trim_text(p_state->>'lastCheckoutDate'), '')::date;
  v_box.zeroed_date := nullif(app_api.trim_text(p_state->>'zeroedDate'), '')::date;
  v_box.zeroed_reason := coalesce(p_state->>'zeroedReason', '');
  v_box.zeroed_by := coalesce(p_state->>'zeroedBy', '');

  return v_box;
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

select app_api.grant_execute_if_exists('public.api_acl_list_box_dealers(uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_box_dealers_upsert(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_box_dealers(uuid)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_box_dealers_upsert(uuid, text, jsonb)', 'service_role');
