-- Adds per-box price-per-linear-foot support for film asset valuation.

alter table app.boxes
  add column if not exists price_per_lf numeric(12,4);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'app.boxes'::regclass
      and conname = 'boxes_price_per_lf_non_negative'
  ) then
    alter table app.boxes
      add constraint boxes_price_per_lf_non_negative
      check (price_per_lf is null or price_per_lf >= 0);
  end if;
end
$$;

alter table import.boxes_raw
  add column if not exists "PricePerLf" text;

create or replace function app_api.public_box_json(p_box app.boxes)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'boxId', coalesce(p_box.box_id, ''),
    'warehouse', coalesce(p_box.warehouse::text, ''),
    'manufacturer', coalesce(p_box.manufacturer, ''),
    'filmName', coalesce(p_box.film_name, ''),
    'widthIn', p_box.width_in,
    'initialFeet', p_box.initial_feet,
    'feetAvailable', p_box.feet_available,
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

create or replace function app_api.save_box(p_box app.boxes)
returns app.boxes
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_row app.boxes;
begin
  insert into app.boxes (
    id,
    org_id,
    box_id,
    warehouse,
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

create or replace function app_api.build_box_from_payload(
  p_org_id uuid,
  p_payload jsonb,
  p_existing_box_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_existing app.boxes;
  v_box app.boxes;
  v_film_data app.film_catalog;
  v_warnings text[] := array[]::text[];
  v_box_id text;
  v_manufacturer text;
  v_film_name text;
  v_width_in numeric;
  v_initial_feet integer;
  v_order_date date;
  v_received_date date;
  v_feet_available_input text;
  v_feet_available integer;
  v_film_key text;
  v_initial_weight_input numeric;
  v_last_roll_weight_input numeric;
  v_last_weighed_date_input date;
  v_core_type_input text;
  v_existing_core_type text;
  v_resolved_initial_weight numeric;
  v_resolved_last_roll_weight numeric;
  v_resolved_last_weighed_date date;
  v_resolved_core_type text;
  v_resolved_core_weight numeric;
  v_resolved_lf_weight numeric;
  v_effective_sq_ft_weight numeric;
  v_active_allocated_feet integer := 0;
  v_is_first_receipt boolean := false;
  v_weight_changed boolean := false;
  v_resolved_warehouse text;
begin
  if p_existing_box_id is not null then
    select *
    into v_existing
    from app.boxes b
    where b.org_id = p_org_id
      and b.box_id = app_api.trim_text(p_existing_box_id)
    for update;

    if not found then
      perform app_api.raise_http(404, 'Box not found.');
    end if;
  end if;

  v_box_id := coalesce(v_existing.box_id, app_api.require_text(p_payload->>'boxId', 'BoxID'));
  v_manufacturer := app_api.require_text(p_payload->>'manufacturer', 'Manufacturer');
  v_film_name := app_api.require_text(p_payload->>'filmName', 'FilmName');
  v_width_in := nullif(app_api.trim_text(p_payload->>'widthIn'), '')::numeric;
  v_initial_feet := floor(nullif(app_api.trim_text(p_payload->>'initialFeet'), '')::numeric);
  v_order_date := nullif(app_api.trim_text(p_payload->>'orderDate'), '')::date;
  v_received_date := nullif(app_api.trim_text(p_payload->>'receivedDate'), '')::date;
  v_feet_available_input := app_api.trim_text(p_payload->>'feetAvailable');
  v_film_key := upper(coalesce(nullif(app_api.trim_text(p_payload->>'filmKey'), ''), upper(v_manufacturer) || '|' || upper(v_film_name)));
  v_initial_weight_input := nullif(app_api.trim_text(p_payload->>'initialWeightLbs'), '')::numeric;
  v_last_roll_weight_input := nullif(app_api.trim_text(p_payload->>'lastRollWeightLbs'), '')::numeric;
  v_last_weighed_date_input := nullif(app_api.trim_text(p_payload->>'lastWeighedDate'), '')::date;
  v_core_type_input := app_api.normalize_core_type(p_payload->>'coreType', true);
  v_existing_core_type := coalesce(app_api.normalize_core_type(v_existing.core_type, true), '');
  v_resolved_warehouse := app_api.resolve_warehouse_from_box_id(p_org_id, v_box_id);

  if v_width_in is null or v_width_in <= 0 then
    perform app_api.raise_http(400, 'WidthIn must be greater than zero.');
  end if;

  if v_initial_feet is null or v_initial_feet < 0 then
    perform app_api.raise_http(400, 'InitialFeet must be zero or greater.');
  end if;

  if v_order_date is null then
    perform app_api.raise_http(400, 'OrderDate is required.');
  end if;

  if v_existing.received_date is not null and v_received_date is null then
    perform app_api.raise_http(400, 'ReceivedDate cannot be cleared after a box has been received.');
  end if;

  if v_feet_available_input = '' then
    v_feet_available := coalesce(v_existing.feet_available, app_api.derive_add_feet_available(v_initial_feet, v_received_date));
  else
    v_feet_available := floor(v_feet_available_input::numeric);
    if v_feet_available < 0 then
      v_feet_available := 0;
      v_warnings := app_api.push_warning(v_warnings, 'FeetAvailable was clamped to 0.');
    end if;
  end if;

  v_resolved_initial_weight := v_initial_weight_input;
  v_resolved_last_roll_weight := v_last_roll_weight_input;
  v_resolved_last_weighed_date := v_last_weighed_date_input;
  v_resolved_core_type := coalesce(nullif(v_core_type_input, ''), v_existing_core_type, '');
  v_resolved_core_weight := v_existing.core_weight_lbs;
  v_resolved_lf_weight := v_existing.lf_weight_lbs_per_ft;

  if v_received_date is not null then
    if v_initial_feet <= 0 then
      perform app_api.raise_http(400, 'InitialFeet must be greater than zero for received boxes.');
    end if;

    select *
    into v_film_data
    from app.film_catalog f
    where f.org_id = p_org_id
      and f.film_key = v_film_key
    for update;

    if v_resolved_core_type = '' then
      v_resolved_core_type := app_api.normalize_core_type(v_film_data.default_core_type, true);
    end if;

    if v_film_data.sq_ft_weight_lbs_per_sq_ft is not null then
      if v_resolved_core_type = '' then
        perform app_api.raise_http(400, 'CoreType is required before this film can be received.');
      end if;

      v_effective_sq_ft_weight := v_film_data.sq_ft_weight_lbs_per_sq_ft;
      v_resolved_core_weight := app_api.derive_core_weight_lbs(v_resolved_core_type, v_width_in);

      if v_initial_weight_input is not null then
        v_effective_sq_ft_weight := app_api.derive_sqft_weight_lbs_per_sqft(
          v_initial_weight_input,
          v_resolved_core_weight,
          v_width_in,
          v_initial_feet
        );
        v_resolved_initial_weight := round(v_initial_weight_input, 2);
      else
        v_resolved_initial_weight := app_api.derive_initial_weight_lbs(
          app_api.derive_lf_weight_lbs_per_ft(v_effective_sq_ft_weight, v_width_in),
          v_initial_feet,
          v_resolved_core_weight
        );
        v_warnings := app_api.push_warning(v_warnings, 'Initial and last roll weights were auto-filled from FILM DATA.');
      end if;

      v_resolved_lf_weight := app_api.derive_lf_weight_lbs_per_ft(v_effective_sq_ft_weight, v_width_in);
    else
      if v_resolved_core_type = '' then
        perform app_api.raise_http(400, 'CoreType is required the first time a received film is saved.');
      end if;

      if v_initial_weight_input is null and v_existing.initial_weight_lbs is null then
        perform app_api.raise_http(400, 'InitialWeightLbs is required the first time a received film is saved.');
      end if;

      v_resolved_initial_weight := coalesce(v_initial_weight_input, v_existing.initial_weight_lbs);
      v_resolved_core_weight := app_api.derive_core_weight_lbs(v_resolved_core_type, v_width_in);
      v_effective_sq_ft_weight := app_api.derive_sqft_weight_lbs_per_sqft(
        v_resolved_initial_weight,
        v_resolved_core_weight,
        v_width_in,
        v_initial_feet
      );
      v_resolved_lf_weight := app_api.derive_lf_weight_lbs_per_ft(v_effective_sq_ft_weight, v_width_in);
      perform app_api.save_film_catalog(
        p_org_id,
        v_film_key,
        v_manufacturer,
        v_film_name,
        v_effective_sq_ft_weight,
        v_resolved_core_type,
        v_width_in,
        v_initial_feet,
        v_resolved_initial_weight,
        v_box_id,
        coalesce(v_film_data.notes, '')
      );
      v_warnings := app_api.push_warning(v_warnings, format('FILM DATA was created from the first received weight for %s.', v_film_key));
    end if;

    if v_resolved_last_roll_weight is null then
      v_resolved_last_roll_weight := coalesce(v_existing.last_roll_weight_lbs, v_resolved_initial_weight);
    end if;
    if v_resolved_last_weighed_date is null then
      v_resolved_last_weighed_date := coalesce(v_existing.last_weighed_date, v_received_date);
    end if;

    if v_film_data.id is not null and (coalesce(v_film_data.default_core_type, '') = '' or coalesce(v_film_data.default_core_type, '') <> v_resolved_core_type) then
      perform app_api.save_film_catalog(
        p_org_id,
        v_film_key,
        coalesce(v_film_data.manufacturer, v_manufacturer),
        coalesce(v_film_data.film_name, v_film_name),
        coalesce(v_film_data.sq_ft_weight_lbs_per_sq_ft, v_effective_sq_ft_weight),
        v_resolved_core_type,
        coalesce(v_film_data.source_width_in, v_width_in),
        coalesce(v_film_data.source_initial_feet, v_initial_feet),
        coalesce(v_film_data.source_initial_weight_lbs, v_resolved_initial_weight),
        coalesce(v_film_data.source_box_id, v_box_id),
        coalesce(v_film_data.notes, '')
      );
      v_warnings := app_api.push_warning(v_warnings, 'FILM DATA was updated with the selected core type.');
    end if;

    select coalesce(sum(a.allocated_feet), 0)::integer
    into v_active_allocated_feet
    from app.allocations a
    where a.org_id = p_org_id
      and a.box_id = v_box_id
      and a.status = 'ACTIVE';

    v_is_first_receipt := v_existing.received_date is null;
    v_weight_changed := v_existing.last_roll_weight_lbs is distinct from v_resolved_last_roll_weight;

    if v_is_first_receipt then
      v_feet_available := greatest(v_initial_feet - v_active_allocated_feet, 0);
    elsif v_weight_changed then
      v_feet_available := greatest(
        app_api.derive_feet_available_from_roll_weight(
          v_resolved_last_roll_weight,
          v_resolved_core_weight,
          v_resolved_lf_weight,
          v_initial_feet
        ) - v_active_allocated_feet,
        0
      );
    else
      v_feet_available := least(greatest(coalesce(v_existing.feet_available, v_feet_available), 0), v_initial_feet);
    end if;
  else
    v_resolved_initial_weight := null;
    v_resolved_last_roll_weight := null;
    v_resolved_last_weighed_date := null;
    v_resolved_core_type := '';
    v_resolved_core_weight := null;
    v_resolved_lf_weight := null;
  end if;

  v_box.id := v_existing.id;
  v_box.org_id := p_org_id;
  v_box.box_id := v_box_id;
  v_box.warehouse := v_resolved_warehouse;
  v_box.manufacturer := v_manufacturer;
  v_box.film_name := v_film_name;
  v_box.width_in := v_width_in;
  v_box.initial_feet := v_initial_feet;
  v_box.feet_available := v_feet_available;
  v_box.lot_run := app_api.trim_text(p_payload->>'lotRun');
  v_box.status := case
    when v_existing.status in ('CHECKED_OUT', 'ZEROED', 'RETIRED') then v_existing.status
    else app_api.derive_lifecycle_status(v_received_date)
  end;
  v_box.order_date := v_order_date;
  v_box.received_date := v_received_date;
  v_box.initial_weight_lbs := v_resolved_initial_weight;
  v_box.last_roll_weight_lbs := v_resolved_last_roll_weight;
  v_box.last_weighed_date := v_resolved_last_weighed_date;
  v_box.film_key := v_film_key;
  v_box.core_type := v_resolved_core_type;
  v_box.core_weight_lbs := v_resolved_core_weight;
  v_box.lf_weight_lbs_per_ft := v_resolved_lf_weight;
  v_box.price_per_lf := nullif(app_api.trim_text(p_payload->>'pricePerLf'), '')::numeric;
  if v_box.price_per_lf is not null and v_box.price_per_lf < 0 then
    perform app_api.raise_http(400, 'PricePerLf must be zero or greater.');
  end if;
  v_box.purchase_cost := nullif(app_api.trim_text(p_payload->>'purchaseCost'), '')::numeric;
  v_box.notes := app_api.trim_text(p_payload->>'notes');
  v_box.has_ever_been_checked_out := coalesce(v_existing.has_ever_been_checked_out, false);
  v_box.last_checkout_job := coalesce(v_existing.last_checkout_job, '');
  v_box.last_checkout_date := v_existing.last_checkout_date;
  v_box.zeroed_date := null;
  v_box.zeroed_reason := '';
  v_box.zeroed_by := '';

  return jsonb_build_object(
    'box', to_jsonb(v_box),
    'warnings', to_jsonb(v_warnings)
  );
end;
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

create or replace function import.merge_boxes_from_staging(
  target_org_id uuid,
  normalize_existing boolean default true,
  conflict_mode text default 'keep_existing'
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, import, app_api
as $$
declare
  v_mode text := lower(btrim(coalesce(conflict_mode, 'keep_existing')));
  v_prepared_count integer := 0;
  v_inserted_count integer := 0;
  v_updated_count integer := 0;
  v_skipped_count integer := 0;
  v_existing_conflicts integer := 0;
  v_stage_duplicates integer := 0;
  v_normalize_result jsonb := '{}'::jsonb;
  v_price_per_lf_backfilled_count integer := 0;
begin
  if target_org_id is null then
    raise exception 'target_org_id is required';
  end if;

  if not exists (
    select 1
    from app.organizations o
    where o.id = target_org_id
  ) then
    raise exception 'Organization % does not exist in app.organizations', target_org_id;
  end if;

  if v_mode not in ('keep_existing', 'overwrite_existing') then
    raise exception 'Invalid conflict_mode %. Allowed values: keep_existing, overwrite_existing', conflict_mode;
  end if;

  -- Make sure IL/MS warehouse defaults exist for older orgs.
  perform app_api.ensure_default_warehouses_for_org(target_org_id, 'import-merge');

  if normalize_existing then
    v_normalize_result := import.normalize_existing_box_ids(target_org_id);
  end if;

  create temporary table tmp_import_boxes_prepared on commit drop as
  with src as (
    select
      trim("BoxID") as raw_box_id,
      trim("Manufacturer") as manufacturer,
      trim("FilmName") as film_name,
      trim("WidthIn") as width_in_raw,
      trim("InitialFeet") as initial_feet_raw,
      trim("FeetAvailable") as feet_available_raw,
      trim("LotRun") as lot_run_raw,
      trim("Status") as status_raw,
      trim("OrderDate") as order_date_raw,
      trim("ReceivedDate") as received_date_raw,
      trim("InitialWeightLbs") as initial_weight_lbs_raw,
      trim("LastRollWeightLbs") as last_roll_weight_lbs_raw,
      trim("LastWeighedDate") as last_weighed_date_raw,
      trim("FilmKey") as film_key_raw,
      trim("CoreType") as core_type_raw,
      trim("CoreWeightLbs") as core_weight_lbs_raw,
      trim("LfWeightLbsPerFt") as lf_weight_lbs_per_ft_raw,
      trim("PricePerLf") as price_per_lf_raw,
      trim("PurchaseCost") as purchase_cost_raw,
      trim("Notes") as notes_raw,
      trim("HasEverBeenCheckedOut") as has_ever_raw,
      trim("LastCheckoutJob") as last_checkout_job_raw,
      trim("LastCheckoutDate") as last_checkout_date_raw,
      trim("ZeroedDate") as zeroed_date_raw,
      trim("ZeroedReason") as zeroed_reason_raw,
      trim("ZeroedBy") as zeroed_by_raw
    from import.boxes_raw
    where coalesce(trim("BoxID"), '') <> ''
  ),
  canon as (
    select
      import.canonical_box_id(
        target_org_id,
        case when upper(left(raw_box_id, 1)) = 'M' then 'MS' else 'IL' end,
        raw_box_id
      ) as box_id,
      manufacturer,
      film_name,
      width_in_raw,
      initial_feet_raw,
      feet_available_raw,
      lot_run_raw,
      status_raw,
      order_date_raw,
      received_date_raw,
      initial_weight_lbs_raw,
      last_roll_weight_lbs_raw,
      last_weighed_date_raw,
      film_key_raw,
      core_type_raw,
      core_weight_lbs_raw,
      lf_weight_lbs_per_ft_raw,
      price_per_lf_raw,
      purchase_cost_raw,
      notes_raw,
      has_ever_raw,
      last_checkout_job_raw,
      last_checkout_date_raw,
      zeroed_date_raw,
      zeroed_reason_raw,
      zeroed_by_raw
    from src
  )
  select
    c.box_id,
    app_api.resolve_warehouse_from_box_id(target_org_id, c.box_id) as warehouse,
    c.manufacturer,
    c.film_name,
    nullif(c.width_in_raw, '')::numeric(10, 4) as width_in,
    nullif(c.initial_feet_raw, '')::integer as initial_feet,
    coalesce(nullif(c.feet_available_raw, '')::integer, 0) as feet_available,
    coalesce(c.lot_run_raw, '') as lot_run,
    (
      case
        when upper(coalesce(c.status_raw, '')) in ('ORDERED', 'IN_STOCK', 'CHECKED_OUT', 'ZEROED', 'RETIRED')
          then upper(c.status_raw)
        when nullif(c.received_date_raw, '') is not null and nullif(c.received_date_raw, '')::date <= current_date
          then 'IN_STOCK'
        else 'ORDERED'
      end
    )::app.box_status as status,
    nullif(c.order_date_raw, '')::date as order_date,
    nullif(c.received_date_raw, '')::date as received_date,
    nullif(c.initial_weight_lbs_raw, '')::numeric(12, 2) as initial_weight_lbs,
    nullif(c.last_roll_weight_lbs_raw, '')::numeric(12, 2) as last_roll_weight_lbs,
    nullif(c.last_weighed_date_raw, '')::date as last_weighed_date,
    coalesce(nullif(c.film_key_raw, ''), upper(c.manufacturer) || '|' || upper(c.film_name)) as film_key,
    coalesce(nullif(c.core_type_raw, ''), '') as core_type,
    nullif(c.core_weight_lbs_raw, '')::numeric(12, 4) as core_weight_lbs,
    nullif(c.lf_weight_lbs_per_ft_raw, '')::numeric(12, 6) as lf_weight_lbs_per_ft,
    nullif(c.price_per_lf_raw, '')::numeric(12, 4) as price_per_lf,
    nullif(c.purchase_cost_raw, '')::numeric(12, 2) as purchase_cost,
    coalesce(c.notes_raw, '') as notes,
    import.to_bool(c.has_ever_raw) as has_ever_been_checked_out,
    coalesce(c.last_checkout_job_raw, '') as last_checkout_job,
    nullif(c.last_checkout_date_raw, '')::date as last_checkout_date,
    nullif(c.zeroed_date_raw, '')::date as zeroed_date,
    coalesce(c.zeroed_reason_raw, '') as zeroed_reason,
    coalesce(c.zeroed_by_raw, '') as zeroed_by
  from canon c
  where coalesce(c.box_id, '') <> '';

  select count(*)
  into v_stage_duplicates
  from (
    select t.box_id
    from tmp_import_boxes_prepared t
    group by t.box_id
    having count(*) > 1
  ) d;

  if v_stage_duplicates > 0 then
    raise exception
      'Staging contains % canonical BoxID duplicate(s) after prefix normalization. Resolve duplicates before merge.',
      v_stage_duplicates;
  end if;

  select count(*)
  into v_prepared_count
  from tmp_import_boxes_prepared;

  select count(*)
  into v_existing_conflicts
  from tmp_import_boxes_prepared t
  join app.boxes b
    on b.org_id = target_org_id
   and b.box_id = t.box_id;

  if v_mode = 'keep_existing' then
    insert into app.boxes (
      id,
      org_id,
      box_id,
      warehouse,
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
    select
      gen_random_uuid(),
      target_org_id,
      t.box_id,
      t.warehouse,
      t.manufacturer,
      t.film_name,
      t.width_in,
      t.initial_feet,
      t.feet_available,
      t.lot_run,
      t.status,
      t.order_date,
      t.received_date,
      t.initial_weight_lbs,
      t.last_roll_weight_lbs,
      t.last_weighed_date,
      t.film_key,
      t.core_type,
      t.core_weight_lbs,
      t.lf_weight_lbs_per_ft,
      t.price_per_lf,
      t.purchase_cost,
      t.notes,
      t.has_ever_been_checked_out,
      t.last_checkout_job,
      t.last_checkout_date,
      t.zeroed_date,
      t.zeroed_reason,
      t.zeroed_by
    from tmp_import_boxes_prepared t
    on conflict (org_id, box_id) do nothing;

    get diagnostics v_inserted_count = row_count;
    v_updated_count := 0;
    v_skipped_count := v_prepared_count - v_inserted_count;

    update app.boxes b
    set
      price_per_lf = t.price_per_lf,
      updated_at = now()
    from tmp_import_boxes_prepared t
    where b.org_id = target_org_id
      and b.box_id = t.box_id
      and b.price_per_lf is null
      and t.price_per_lf is not null;
    get diagnostics v_price_per_lf_backfilled_count = row_count;
  else
    insert into app.boxes (
      id,
      org_id,
      box_id,
      warehouse,
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
    select
      gen_random_uuid(),
      target_org_id,
      t.box_id,
      t.warehouse,
      t.manufacturer,
      t.film_name,
      t.width_in,
      t.initial_feet,
      t.feet_available,
      t.lot_run,
      t.status,
      t.order_date,
      t.received_date,
      t.initial_weight_lbs,
      t.last_roll_weight_lbs,
      t.last_weighed_date,
      t.film_key,
      t.core_type,
      t.core_weight_lbs,
      t.lf_weight_lbs_per_ft,
      t.price_per_lf,
      t.purchase_cost,
      t.notes,
      t.has_ever_been_checked_out,
      t.last_checkout_job,
      t.last_checkout_date,
      t.zeroed_date,
      t.zeroed_reason,
      t.zeroed_by
    from tmp_import_boxes_prepared t
    on conflict (org_id, box_id) do update set
      warehouse = excluded.warehouse,
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
      price_per_lf = coalesce(app.boxes.price_per_lf, excluded.price_per_lf),
      purchase_cost = excluded.purchase_cost,
      notes = excluded.notes,
      has_ever_been_checked_out = excluded.has_ever_been_checked_out,
      last_checkout_job = excluded.last_checkout_job,
      last_checkout_date = excluded.last_checkout_date,
      zeroed_date = excluded.zeroed_date,
      zeroed_reason = excluded.zeroed_reason,
      zeroed_by = excluded.zeroed_by,
      updated_at = now();

    -- On overwrite mode, all prepared rows are applied.
    v_inserted_count := v_prepared_count - v_existing_conflicts;
    v_updated_count := v_existing_conflicts;
    v_skipped_count := 0;
  end if;

  return jsonb_build_object(
    'mode', v_mode,
    'prepared_rows', v_prepared_count,
    'existing_conflicts', v_existing_conflicts,
    'inserted_rows', v_inserted_count,
    'updated_rows', v_updated_count,
    'skipped_rows', v_skipped_count,
    'price_per_lf_backfilled_rows', v_price_per_lf_backfilled_count,
    'normalize_existing_applied', normalize_existing,
    'normalize_existing_result', v_normalize_result
  );
end;
$$;

