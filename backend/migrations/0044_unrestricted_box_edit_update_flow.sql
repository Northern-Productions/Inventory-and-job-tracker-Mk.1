-- Allow /boxes/update to save partial receiving metrics without loosening /boxes/add.

create or replace function app_api.clamp_feet_to_initial_range(
  p_feet integer,
  p_initial_feet integer
)
returns integer
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select least(greatest(coalesce(p_feet, 0), 0), greatest(coalesce(p_initial_feet, 0), 0));
$$;

create or replace function app_api.try_derive_lf_weight_lbs_per_ft(
  p_initial_weight_lbs numeric,
  p_core_weight_lbs numeric,
  p_width_in numeric,
  p_initial_feet integer
)
returns numeric
language plpgsql
stable
security definer
set search_path = public, app, app_api
as $$
begin
  if
    p_initial_weight_lbs is null
    or p_core_weight_lbs is null
    or p_width_in is null
    or p_width_in <= 0
    or p_initial_feet is null
    or p_initial_feet <= 0
  then
    return null;
  end if;

  begin
    return app_api.derive_lf_weight_lbs_per_ft(
      app_api.derive_sqft_weight_lbs_per_sqft(
        p_initial_weight_lbs,
        p_core_weight_lbs,
        p_width_in,
        p_initial_feet
      ),
      p_width_in
    );
  exception
    when others then
      return null;
  end;
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
  v_current_feet_on_roll_input integer;
  v_existing_core_type text;
  v_resolved_initial_weight numeric;
  v_resolved_last_roll_weight numeric;
  v_resolved_last_weighed_date date;
  v_resolved_core_type text;
  v_resolved_core_weight numeric;
  v_resolved_lf_weight numeric;
  v_effective_sq_ft_weight numeric;
  v_effective_core_type text := '';
  v_seed_initial_weight numeric;
  v_active_allocated_feet integer := 0;
  v_is_first_receipt boolean := false;
  v_should_recalculate_received_feet boolean := false;
  v_should_repair_stale_feet boolean := false;
  v_resolved_warehouse text;
  v_physical_feet_available integer := 0;
  v_has_full_receiving_metrics boolean := false;
  v_use_partial_receiving_metrics boolean := false;
  v_has_price_per_lf boolean := coalesce(p_payload, '{}'::jsonb) ? 'pricePerLf';
  v_has_submitted_initial_weight boolean := coalesce(p_payload, '{}'::jsonb) ? 'initialWeightLbs';
  v_has_submitted_last_roll_weight boolean := coalesce(p_payload, '{}'::jsonb) ? 'lastRollWeightLbs';
  v_has_submitted_last_weighed_date boolean := coalesce(p_payload, '{}'::jsonb) ? 'lastWeighedDate';
  v_has_submitted_core_type boolean := coalesce(p_payload, '{}'::jsonb) ? 'coreType';
  v_has_submitted_current_feet_on_roll boolean := coalesce(p_payload, '{}'::jsonb) ? 'currentFeetOnRoll';
  v_reactivate_from_zeroed boolean := coalesce((p_payload->>'reactivateFromZeroed')::boolean, false);
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
  v_film_key := upper(
    coalesce(
      nullif(app_api.trim_text(p_payload->>'filmKey'), ''),
      upper(v_manufacturer) || '|' || upper(v_film_name)
    )
  );
  v_initial_weight_input := nullif(app_api.trim_text(p_payload->>'initialWeightLbs'), '')::numeric;
  v_last_roll_weight_input := nullif(app_api.trim_text(p_payload->>'lastRollWeightLbs'), '')::numeric;
  v_last_weighed_date_input := nullif(app_api.trim_text(p_payload->>'lastWeighedDate'), '')::date;
  v_core_type_input := app_api.normalize_core_type(p_payload->>'coreType', true);
  v_existing_core_type := coalesce(app_api.normalize_core_type(v_existing.core_type, true), '');
  v_resolved_warehouse := app_api.resolve_warehouse_from_box_id(p_org_id, v_box_id);

  if v_has_submitted_current_feet_on_roll and app_api.trim_text(p_payload->>'currentFeetOnRoll') <> '' then
    v_current_feet_on_roll_input := floor((app_api.trim_text(p_payload->>'currentFeetOnRoll'))::numeric);
    if v_current_feet_on_roll_input < 0 then
      v_current_feet_on_roll_input := 0;
      v_warnings := app_api.push_warning(v_warnings, 'CurrentFeetOnRoll was clamped to 0.');
    end if;
  else
    v_current_feet_on_roll_input := null;
  end if;

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

    select coalesce(sum(a.allocated_feet), 0)::integer
    into v_active_allocated_feet
    from app.allocations a
    where a.org_id = p_org_id
      and a.box_id = v_box_id
      and a.status = 'ACTIVE';

    v_should_recalculate_received_feet :=
      p_existing_box_id is null
      or v_existing.received_date is null
      or v_existing.film_key is distinct from v_film_key
      or v_existing.width_in is distinct from v_width_in
      or v_existing.initial_feet is distinct from v_initial_feet
      or v_core_type_input is distinct from v_existing_core_type
      or v_initial_weight_input is distinct from v_existing.initial_weight_lbs;

    if v_should_recalculate_received_feet then
      select *
      into v_film_data
      from app.film_catalog f
      where f.org_id = p_org_id
        and f.film_key = v_film_key
      for update;

      if p_existing_box_id is not null and v_has_submitted_core_type and v_core_type_input = '' then
        v_effective_core_type := '';
      else
        v_effective_core_type := coalesce(
          nullif(v_core_type_input, ''),
          app_api.normalize_core_type(v_film_data.default_core_type, true),
          v_existing_core_type,
          ''
        );
      end if;

      if v_film_data.sq_ft_weight_lbs_per_sq_ft is not null then
        if v_effective_core_type = '' then
          if p_existing_box_id is null then
            perform app_api.raise_http(400, 'CoreType is required before this film can be received.');
          end if;
        else
          v_effective_sq_ft_weight := v_film_data.sq_ft_weight_lbs_per_sq_ft;
          v_resolved_core_type := v_effective_core_type;
          v_resolved_core_weight := app_api.derive_core_weight_lbs(v_effective_core_type, v_width_in);

          if v_initial_weight_input is not null then
            v_effective_sq_ft_weight := app_api.derive_sqft_weight_lbs_per_sqft(
              v_initial_weight_input,
              v_resolved_core_weight,
              v_width_in,
              v_initial_feet
            );
            v_resolved_initial_weight := round(v_initial_weight_input, 2);
            v_resolved_lf_weight := app_api.derive_lf_weight_lbs_per_ft(v_effective_sq_ft_weight, v_width_in);
          elsif p_existing_box_id is null or not v_has_submitted_initial_weight then
            v_resolved_lf_weight := app_api.derive_lf_weight_lbs_per_ft(v_effective_sq_ft_weight, v_width_in);
            v_resolved_initial_weight := app_api.derive_initial_weight_lbs(
              v_resolved_lf_weight,
              v_initial_feet,
              v_resolved_core_weight
            );
            if p_existing_box_id is null then
              v_warnings := app_api.push_warning(v_warnings, 'Initial and last roll weights were auto-filled from FILM DATA.');
            end if;
          end if;

          if v_resolved_last_roll_weight is null then
            if p_existing_box_id is not null and not v_has_submitted_last_roll_weight and v_existing.last_roll_weight_lbs is not null then
              v_resolved_last_roll_weight := v_existing.last_roll_weight_lbs;
            elsif p_existing_box_id is null and v_resolved_initial_weight is not null then
              v_resolved_last_roll_weight := v_resolved_initial_weight;
            end if;
          end if;

          if v_resolved_last_weighed_date is null then
            if p_existing_box_id is not null and not v_has_submitted_last_weighed_date and v_existing.last_weighed_date is not null then
              v_resolved_last_weighed_date := v_existing.last_weighed_date;
            elsif p_existing_box_id is null and v_resolved_last_roll_weight is not null then
              v_resolved_last_weighed_date := v_received_date;
            end if;
          end if;

          v_has_full_receiving_metrics :=
            v_resolved_initial_weight is not null
            and v_resolved_last_roll_weight is not null
            and v_resolved_core_weight is not null
            and v_resolved_lf_weight is not null
            and v_resolved_lf_weight > 0;

          if v_has_full_receiving_metrics and (coalesce(v_film_data.default_core_type, '') = '' or coalesce(v_film_data.default_core_type, '') <> v_effective_core_type) then
            perform app_api.save_film_catalog(
              p_org_id,
              v_film_key,
              coalesce(v_film_data.manufacturer, v_manufacturer),
              coalesce(v_film_data.film_name, v_film_name),
              v_effective_sq_ft_weight,
              v_effective_core_type,
              coalesce(v_film_data.source_width_in, v_width_in),
              coalesce(v_film_data.source_initial_feet, v_initial_feet),
              coalesce(v_film_data.source_initial_weight_lbs, v_resolved_initial_weight),
              coalesce(v_film_data.source_box_id, v_box_id),
              coalesce(v_film_data.notes, '')
            );
            v_warnings := app_api.push_warning(v_warnings, 'FILM DATA was updated with the selected core type.');
          end if;
        end if;
      else
        if p_existing_box_id is not null and v_has_submitted_initial_weight and v_initial_weight_input is null then
          v_seed_initial_weight := null;
        else
          v_seed_initial_weight := coalesce(v_initial_weight_input, v_existing.initial_weight_lbs);
        end if;

        if v_effective_core_type = '' then
          if p_existing_box_id is null then
            perform app_api.raise_http(400, 'CoreType is required the first time a received film is saved.');
          end if;
        elsif v_seed_initial_weight is null then
          if p_existing_box_id is null then
            perform app_api.raise_http(400, 'InitialWeightLbs is required the first time a received film is saved.');
          end if;
        else
          v_resolved_core_type := v_effective_core_type;
          v_resolved_core_weight := app_api.derive_core_weight_lbs(v_effective_core_type, v_width_in);
          v_effective_sq_ft_weight := app_api.derive_sqft_weight_lbs_per_sqft(
            v_seed_initial_weight,
            v_resolved_core_weight,
            v_width_in,
            v_initial_feet
          );
          v_resolved_lf_weight := app_api.derive_lf_weight_lbs_per_ft(v_effective_sq_ft_weight, v_width_in);
          v_resolved_initial_weight := round(v_seed_initial_weight, 2);

          if v_resolved_last_roll_weight is null then
            if p_existing_box_id is not null and not v_has_submitted_last_roll_weight and v_existing.last_roll_weight_lbs is not null then
              v_resolved_last_roll_weight := v_existing.last_roll_weight_lbs;
            elsif p_existing_box_id is null then
              v_resolved_last_roll_weight := v_resolved_initial_weight;
            end if;
          end if;

          if v_resolved_last_weighed_date is null then
            if p_existing_box_id is not null and not v_has_submitted_last_weighed_date and v_existing.last_weighed_date is not null then
              v_resolved_last_weighed_date := v_existing.last_weighed_date;
            elsif p_existing_box_id is null and v_resolved_last_roll_weight is not null then
              v_resolved_last_weighed_date := v_received_date;
            end if;
          end if;

          v_has_full_receiving_metrics :=
            v_resolved_initial_weight is not null
            and v_resolved_last_roll_weight is not null
            and v_resolved_core_weight is not null
            and v_resolved_lf_weight is not null
            and v_resolved_lf_weight > 0;

          if v_has_full_receiving_metrics then
            perform app_api.save_film_catalog(
              p_org_id,
              v_film_key,
              v_manufacturer,
              v_film_name,
              v_effective_sq_ft_weight,
              v_effective_core_type,
              v_width_in,
              v_initial_feet,
              v_resolved_initial_weight,
              v_box_id,
              coalesce(v_film_data.notes, '')
            );
            v_warnings := app_api.push_warning(v_warnings, format('FILM DATA was created from the first received weight for %s.', v_film_key));
          end if;
        end if;
      end if;
    else
      v_resolved_initial_weight := case
        when v_initial_weight_input is not null then v_initial_weight_input
        when p_existing_box_id is not null and not v_has_submitted_initial_weight then v_existing.initial_weight_lbs
        else null
      end;
      v_resolved_core_type := case
        when v_has_submitted_core_type then v_core_type_input
        else coalesce(nullif(v_core_type_input, ''), v_existing_core_type, '')
      end;
      v_resolved_core_weight := v_existing.core_weight_lbs;
      v_resolved_lf_weight := v_existing.lf_weight_lbs_per_ft;
      v_resolved_last_roll_weight := case
        when v_resolved_last_roll_weight is not null then v_resolved_last_roll_weight
        when p_existing_box_id is not null and not v_has_submitted_last_roll_weight then v_existing.last_roll_weight_lbs
        else null
      end;
      v_resolved_last_weighed_date := case
        when v_resolved_last_weighed_date is not null then v_resolved_last_weighed_date
        when p_existing_box_id is not null and not v_has_submitted_last_weighed_date then v_existing.last_weighed_date
        else null
      end;
    end if;

    if v_resolved_core_type <> '' and v_resolved_core_weight is null then
      v_resolved_core_weight := app_api.derive_core_weight_lbs(v_resolved_core_type, v_width_in);
    end if;

    if v_resolved_lf_weight is null then
      v_resolved_lf_weight := app_api.try_derive_lf_weight_lbs_per_ft(
        v_resolved_initial_weight,
        v_resolved_core_weight,
        v_width_in,
        v_initial_feet
      );
    end if;

    v_has_full_receiving_metrics :=
      v_resolved_initial_weight is not null
      and v_resolved_last_roll_weight is not null
      and v_resolved_core_weight is not null
      and v_resolved_lf_weight is not null
      and v_resolved_lf_weight > 0;

    if not v_has_full_receiving_metrics and p_existing_box_id is not null then
      v_use_partial_receiving_metrics := true;
      v_resolved_initial_weight := case
        when v_initial_weight_input is not null then v_initial_weight_input
        when not v_has_submitted_initial_weight then v_existing.initial_weight_lbs
        else null
      end;
      v_resolved_last_roll_weight := case
        when v_last_roll_weight_input is not null then v_last_roll_weight_input
        when not v_has_submitted_last_roll_weight then v_existing.last_roll_weight_lbs
        else null
      end;
      v_resolved_last_weighed_date := case
        when v_last_weighed_date_input is not null then v_last_weighed_date_input
        when not v_has_submitted_last_weighed_date then v_existing.last_weighed_date
        else null
      end;
      v_resolved_core_type := case
        when v_has_submitted_core_type then v_core_type_input
        else v_existing_core_type
      end;
      if v_resolved_core_type <> '' then
        v_resolved_core_weight := app_api.derive_core_weight_lbs(v_resolved_core_type, v_width_in);
      else
        v_resolved_core_weight := null;
      end if;
      v_resolved_lf_weight := app_api.try_derive_lf_weight_lbs_per_ft(
        v_resolved_initial_weight,
        v_resolved_core_weight,
        v_width_in,
        v_initial_feet
      );
    end if;

    if v_use_partial_receiving_metrics then
      if v_current_feet_on_roll_input is not null then
        v_feet_available := app_api.clamp_feet_to_initial_range(
          v_current_feet_on_roll_input - v_active_allocated_feet,
          v_initial_feet
        );
      else
        v_feet_available := app_api.clamp_feet_to_initial_range(v_feet_available, v_initial_feet);
      end if;
    else
      if v_resolved_last_roll_weight is null then
        perform app_api.raise_http(
          400,
          'LastRollWeightLbs is required for received boxes because FeetAvailable is derived from roll weight.'
        );
      end if;

      if v_resolved_core_weight is null or v_resolved_lf_weight is null or v_resolved_lf_weight <= 0 then
        perform app_api.raise_http(
          400,
          'CoreWeightLbs and LfWeightLbsPerFt must be set for received boxes because FeetAvailable is derived from roll weight.'
        );
      end if;

      v_is_first_receipt := v_existing.received_date is null;
      v_should_recalculate_received_feet := app_api.should_recalculate_received_feet(
        v_existing,
        v_initial_feet,
        v_resolved_last_roll_weight,
        v_resolved_core_weight,
        v_resolved_lf_weight,
        v_reactivate_from_zeroed
      );
      v_physical_feet_available := app_api.derive_feet_available_from_roll_weight(
        v_resolved_last_roll_weight,
        v_resolved_core_weight,
        v_resolved_lf_weight,
        v_initial_feet
      );
      v_should_repair_stale_feet :=
        v_existing.received_date is not null
        and coalesce(v_existing.feet_available, 0) <= 0
        and v_physical_feet_available > 0;

      if v_is_first_receipt then
        v_feet_available := greatest(v_initial_feet - v_active_allocated_feet, 0);
      elsif v_should_recalculate_received_feet or v_should_repair_stale_feet then
        v_feet_available := greatest(v_physical_feet_available - v_active_allocated_feet, 0);
      else
        v_feet_available := least(greatest(coalesce(v_existing.feet_available, v_feet_available), 0), v_initial_feet);
      end if;
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
  v_box.purchase_cost := nullif(app_api.trim_text(p_payload->>'purchaseCost'), '')::numeric;
  if v_box.purchase_cost is not null and v_box.purchase_cost < 0 then
    perform app_api.raise_http(400, 'PurchaseCost must be zero or greater.');
  end if;
  if v_box.purchase_cost is not null and v_initial_feet <= 0 then
    perform app_api.raise_http(400, 'PurchaseCost requires InitialFeet > 0 to derive PricePerLf.');
  end if;

  if v_box.purchase_cost is not null then
    v_box.price_per_lf := round(v_box.purchase_cost / v_initial_feet, 4);
  elsif v_has_price_per_lf then
    v_box.price_per_lf := nullif(app_api.trim_text(p_payload->>'pricePerLf'), '')::numeric;
    if v_box.price_per_lf is not null and v_box.price_per_lf < 0 then
      perform app_api.raise_http(400, 'PricePerLf must be zero or greater.');
    end if;
  else
    v_box.price_per_lf := v_existing.price_per_lf;
  end if;
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

create or replace function public.api_acl_boxes_update(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_lookup_box_id text;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');
  v_lookup_box_id := app_api.resolve_box_id_alias(
    p_org_id,
    app_api.require_text(v_payload->>'boxId', 'BoxID')
  );
  v_payload := jsonb_set(v_payload, '{boxId}', to_jsonb(v_lookup_box_id), true);
  return public.api_boxes_update(p_org_id, p_actor, v_payload);
end;
$$;
