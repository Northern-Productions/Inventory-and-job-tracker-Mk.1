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
  v_box.warehouse := app_api.determine_warehouse_from_box_id(v_box_id);
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
