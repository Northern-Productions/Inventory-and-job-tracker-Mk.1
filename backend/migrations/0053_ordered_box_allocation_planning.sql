-- Ordered box allocation planning:
-- - expose derived planning capacity on box reads
-- - allow ORDERED boxes to participate in allocation planning without mutating on-hand feet
-- - block receipt/check-in saves when physical feet would drop below active allocations
-- - keep ordered boxes from regaining fake on-hand feet when job cancellations release allocations

create or replace function app_api.active_allocated_feet_for_box(
  p_org_id uuid,
  p_box_id text
)
returns integer
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select coalesce(sum(a.allocated_feet), 0)::integer
  from app.allocations a
  where a.org_id = p_org_id
    and a.box_id = app_api.trim_text(p_box_id)
    and a.status = 'ACTIVE';
$$;

create or replace function app_api.compute_allocation_planning_feet(
  p_status text,
  p_initial_feet integer,
  p_feet_available integer,
  p_active_allocated_feet integer
)
returns integer
language sql
immutable
as $$
  select
    case upper(coalesce(app_api.trim_text(p_status), ''))
      when 'IN_STOCK' then greatest(coalesce(p_feet_available, 0), 0)
      when 'ORDERED' then greatest(coalesce(p_initial_feet, 0) - coalesce(p_active_allocated_feet, 0), 0)
      else 0
    end;
$$;

create or replace function app_api.allocation_planning_feet_for_box(p_box app.boxes)
returns integer
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select app_api.compute_allocation_planning_feet(
    coalesce(p_box.status::text, ''),
    p_box.initial_feet,
    p_box.feet_available,
    app_api.active_allocated_feet_for_box(p_box.org_id, p_box.box_id)
  );
$$;

create or replace function app_api.next_feet_available_after_allocation_release(
  p_status text,
  p_feet_available integer,
  p_released_feet integer,
  p_initial_feet integer default null
)
returns integer
language sql
immutable
as $$
  select
    case upper(coalesce(app_api.trim_text(p_status), ''))
      when 'ZEROED' then greatest(coalesce(p_feet_available, 0), 0)
      when 'RETIRED' then greatest(coalesce(p_feet_available, 0), 0)
      when 'ORDERED' then greatest(coalesce(p_feet_available, 0), 0)
      else least(
        coalesce(p_initial_feet, greatest(coalesce(p_feet_available, 0) + coalesce(p_released_feet, 0), 0)),
        greatest(coalesce(p_feet_available, 0) + coalesce(p_released_feet, 0), 0)
      )
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
    'manufacturer', coalesce(p_box.manufacturer, ''),
    'filmName', coalesce(p_box.film_name, ''),
    'widthIn', p_box.width_in,
    'initialFeet', p_box.initial_feet,
    'feetAvailable', p_box.feet_available,
    'allocationPlanningFeet', app_api.allocation_planning_feet_for_box(p_box),
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

create or replace function app_api.public_box_read_json(p_box app.boxes)
returns jsonb
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select
    app_api.public_box_json(p_box)
    || jsonb_build_object(
      'activeAllocatedFeet',
      app_api.active_allocated_feet_for_box(p_box.org_id, p_box.box_id)
    );
$$;

create or replace function public.api_list_boxes(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_result jsonb;
begin
  perform app_api.require_org_member(p_org_id);

  select coalesce(
    jsonb_agg(app_api.public_box_read_json(b) order by b.box_id asc),
    '[]'::jsonb
  )
  into v_result
  from app.boxes b
  where b.org_id = p_org_id;

  return v_result;
end;
$$;

create or replace function public.api_find_box_by_id(p_org_id uuid, p_box_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_result jsonb;
begin
  perform app_api.require_org_member(p_org_id);

  select app_api.public_box_read_json(b)
  into v_result
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = app_api.trim_text(p_box_id);

  return v_result;
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
        if v_current_feet_on_roll_input < v_active_allocated_feet then
          perform app_api.raise_http(
            400,
            format(
              'CurrentFeetOnRoll cannot be lower than the box''s active allocated feet (%s).',
              v_active_allocated_feet
            )
          );
        end if;
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

      if v_physical_feet_available < v_active_allocated_feet then
        perform app_api.raise_http(
          400,
          format(
            'Received physical LF cannot be lower than the box''s active allocated feet (%s).',
            v_active_allocated_feet
          )
        );
      end if;

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

    if v_active_allocated_feet > v_physical_feet then
      perform app_api.raise_http(
        400,
        format(
          'Received physical LF cannot be lower than the box''s active allocated feet (%s).',
          v_active_allocated_feet
        )
      );
    end if;

    v_box.feet_available := greatest(v_physical_feet - v_active_allocated_feet, 0);

    if v_active_allocated_feet > 0 and v_box.feet_available = 0 then
      v_warnings := app_api.push_warning(
        v_warnings,
        'All remaining LF on this box is reserved by active allocations.'
      );
    end if;

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

create or replace function public.api_allocations_apply(
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
  v_source app.boxes;
  v_candidate app.boxes;
  v_job_context jsonb;
  v_requested_feet integer := coalesce(floor(nullif(app_api.trim_text(p_payload->>'requestedFeet'), '')::numeric), 0);
  v_requested_width_in numeric := nullif(app_api.trim_text(p_payload->>'requestedWidthIn'), '')::numeric;
  v_requirement_id_text text := app_api.trim_text(p_payload->>'requirementId');
  v_requirement_id uuid;
  v_requirement app.job_requirements;
  v_source_film_key text;
  v_requirement_is_exterior boolean := false;
  v_remaining integer := 0;
  v_source_planning_feet integer := 0;
  v_source_suggested integer := 0;
  v_source_suggested_covered integer := 0;
  v_candidate_planning_feet integer := 0;
  v_candidate_suggested integer := 0;
  v_candidate_suggested_covered integer := 0;
  v_cross_warehouse boolean := coalesce((p_payload->>'crossWarehouse')::boolean, false);
  v_selected_box_ids text[] := coalesce(
    array(select jsonb_array_elements_text(coalesce(p_payload->'selectedSuggestionBoxIds', '[]'::jsonb))),
    array[]::text[]
  );
  v_extra_allocations jsonb := coalesce(p_payload->'extraAllocations', '[]'::jsonb);
  v_extra_entry jsonb;
  v_extra_box_id text;
  v_extra_feet integer;
  v_extra_processed_box_ids text[] := array[]::text[];
  v_allocation app.allocations;
  v_allocation_ids text[] := array[]::text[];
  v_film_order app.film_orders;
  v_conflict_count integer;
  v_job_warehouse text;
  v_warnings text[] := array[]::text[];
begin
  perform app_api.require_org_member(p_org_id);

  if v_requested_feet < 0 then
    perform app_api.raise_http(400, 'RequestedFeet must be zero or greater.');
  end if;

  if coalesce(jsonb_typeof(v_extra_allocations), '') not in ('', 'array') then
    perform app_api.raise_http(400, 'extraAllocations must be an array.');
  end if;

  select *
  into v_source
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = app_api.require_text(p_payload->>'boxId', 'BoxID')
  for update;

  if not found then
    perform app_api.raise_http(404, 'Box not found.');
  end if;

  if coalesce(v_source.status::text, '') not in ('IN_STOCK', 'ORDERED') then
    perform app_api.raise_http(400, 'Only in-stock or ordered boxes can be allocated.');
  end if;

  v_job_context := app_api.resolve_job_context(
    p_org_id,
    p_payload->>'jobNumber',
    p_payload->>'jobDate',
    p_payload->>'crewLeader'
  );

  v_source_film_key := app_api.normalize_requirement_film_key(
    p_org_id,
    v_source.manufacturer,
    v_source.film_name
  );

  if v_requested_feet > 0 then
    if v_requirement_id_text = '' then
      perform app_api.raise_http(400, 'RequirementId is required for film allocations.');
    end if;

    begin
      v_requirement_id := v_requirement_id_text::uuid;
    exception
      when others then
        perform app_api.raise_http(400, 'RequirementId must be a valid UUID.');
    end;

    select r.*
    into v_requirement
    from app.job_requirements r
    where r.org_id = p_org_id
      and r.job_id = app_api.get_or_resolve_job_id(p_org_id, v_job_context->>'jobNumber')
      and r.id = v_requirement_id;

    if not found then
      perform app_api.raise_http(
        400,
        format('Requirement %s does not belong to job %s.', v_requirement_id, v_job_context->>'jobNumber')
      );
    end if;

    v_requirement_is_exterior := app_api.requirement_film_is_exterior(
      p_org_id,
      v_requirement.manufacturer,
      v_requirement.film_name
    );

    if not app_api.requirement_film_is_compatible(
      p_org_id,
      v_source.manufacturer,
      v_source.film_name,
      v_requirement.manufacturer,
      v_requirement.film_name
    ) then
      perform app_api.raise_http(
        400,
        format('Box %s does not match requirement %s.', v_source.box_id, v_requirement_id)
      );
    end if;

    if v_source.width_in < v_requirement.width_in then
      perform app_api.raise_http(
        400,
        format('Box %s does not match requirement %s.', v_source.box_id, v_requirement_id)
      );
    end if;

    v_requested_width_in := v_requirement.width_in;
  elsif v_requested_width_in is null or v_requested_width_in <= 0 then
    v_requested_width_in := v_source.width_in;
  end if;

  if v_source.width_in < v_requested_width_in then
    perform app_api.raise_http(400, 'Source box width must meet or exceed the requested width.');
  end if;

  v_remaining := greatest(v_requested_feet, 0);
  v_source_planning_feet := app_api.allocation_planning_feet_for_box(v_source);

  if v_requested_feet > 0 then
    select count(*)
    into v_conflict_count
    from app.allocations a
    where a.org_id = p_org_id
      and a.box_id = v_source.box_id
      and a.status = 'ACTIVE'
      and coalesce(to_char(a.job_date, 'YYYY-MM-DD'), '') = coalesce(v_job_context->>'jobDate', '')
      and upper(a.job_number) <> upper(v_job_context->>'jobNumber')
      and upper(coalesce(a.crew_leader, '')) <> upper(coalesce(v_job_context->>'crewLeader', ''));

    if v_conflict_count = 0 then
      select
        p.allocated_feet,
        p.covered_feet,
        p.remaining_covered_feet
      into
        v_source_suggested,
        v_source_suggested_covered,
        v_remaining
      from app_api.plan_allocation_coverage(
        v_remaining,
        v_source_planning_feet,
        v_source.width_in,
        v_requested_width_in
      ) p;
    end if;
  end if;

  if v_source_suggested > 0 then
    v_allocation := app_api.create_allocation_with_coverage(
      p_org_id,
      v_source,
      v_job_context,
      v_source_suggested,
      v_source_suggested_covered,
      p_actor,
      '',
      'REQUIREMENT',
      v_requirement_id
    );
    if coalesce(v_source.status::text, '') = 'IN_STOCK' then
      v_source.feet_available := greatest(v_source.feet_available - v_source_suggested, 0);
      v_source := app_api.save_box(v_source);
    end if;
    v_allocation_ids := array_append(v_allocation_ids, v_allocation.allocation_id);
  end if;

  for v_candidate in
    select *
    from app.boxes b
    where b.org_id = p_org_id
      and b.box_id <> v_source.box_id
      and coalesce(b.status::text, '') in ('IN_STOCK', 'ORDERED')
      and app_api.compute_allocation_planning_feet(
        coalesce(b.status::text, ''),
        b.feet_available,
        b.initial_feet,
        app_api.active_allocated_feet_for_box(p_org_id, b.box_id)
      ) > 0
      and case
        when v_requirement_id is not null then app_api.requirement_film_is_compatible(
          p_org_id,
          b.manufacturer,
          b.film_name,
          v_requirement.manufacturer,
          v_requirement.film_name
        )
        else app_api.normalize_requirement_film_key(p_org_id, b.manufacturer, b.film_name) = v_source_film_key
      end
      and b.width_in >= v_requested_width_in
      and (v_cross_warehouse or b.warehouse = v_source.warehouse)
    order by
      case
        when coalesce(b.status::text, '') = 'IN_STOCK' then 0
        when coalesce(b.status::text, '') = 'ORDERED' then 1
        else 2
      end,
      case
        when b.width_in = v_requested_width_in then 0
        when app_api.allocation_coverage_multiplier(b.width_in, v_requested_width_in) > 1 then 1
        else 2
      end,
      (b.width_in - v_requested_width_in),
      case
        when v_requirement_id is not null
          and not v_requirement_is_exterior
          and app_api.requirement_film_is_exterior(p_org_id, b.manufacturer, b.film_name)
        then 1
        else 0
      end,
      coalesce(b.received_date, b.order_date, '9999-12-31'::date),
      b.box_id
    for update
  loop
    exit when v_remaining <= 0;

    if coalesce(array_length(v_selected_box_ids, 1), 0) > 0 and array_position(v_selected_box_ids, v_candidate.box_id) is null then
      continue;
    end if;

    select count(*)
    into v_conflict_count
    from app.allocations a
    where a.org_id = p_org_id
      and a.box_id = v_candidate.box_id
      and a.status = 'ACTIVE'
      and coalesce(to_char(a.job_date, 'YYYY-MM-DD'), '') = coalesce(v_job_context->>'jobDate', '')
      and upper(a.job_number) <> upper(v_job_context->>'jobNumber')
      and upper(coalesce(a.crew_leader, '')) <> upper(coalesce(v_job_context->>'crewLeader', ''));

    if v_conflict_count > 0 then
      continue;
    end if;

    v_candidate_planning_feet := app_api.allocation_planning_feet_for_box(v_candidate);

    select
      p.allocated_feet,
      p.covered_feet,
      p.remaining_covered_feet
    into
      v_candidate_suggested,
      v_candidate_suggested_covered,
      v_remaining
    from app_api.plan_allocation_coverage(
      v_remaining,
      v_candidate_planning_feet,
      v_candidate.width_in,
      v_requested_width_in
    ) p;

    if v_candidate_suggested <= 0 or v_candidate_suggested_covered <= 0 then
      continue;
    end if;

    v_allocation := app_api.create_allocation_with_coverage(
      p_org_id,
      v_candidate,
      v_job_context,
      v_candidate_suggested,
      v_candidate_suggested_covered,
      p_actor,
      '',
      'REQUIREMENT',
      v_requirement_id
    );
    if coalesce(v_candidate.status::text, '') = 'IN_STOCK' then
      v_candidate.feet_available := greatest(v_candidate.feet_available - v_allocation.allocated_feet, 0);
      perform app_api.save_box(v_candidate);
    end if;
    v_allocation_ids := array_append(v_allocation_ids, v_allocation.allocation_id);
  end loop;

  if coalesce(jsonb_typeof(v_extra_allocations), '') = 'array' then
    for v_extra_entry in
      select value
      from jsonb_array_elements(v_extra_allocations)
    loop
      if coalesce(jsonb_typeof(v_extra_entry), '') <> 'object' then
        perform app_api.raise_http(400, 'Each extra allocation entry must be an object.');
      end if;

      v_extra_box_id := app_api.require_text(v_extra_entry->>'boxId', 'extraAllocations[].boxId');
      v_extra_feet := floor(nullif(app_api.trim_text(v_extra_entry->>'allocatedFeet'), '')::numeric);

      if v_extra_feet is null or v_extra_feet <= 0 then
        perform app_api.raise_http(400, format('Extra allocation for box %s must be greater than zero.', v_extra_box_id));
      end if;

      if array_position(v_extra_processed_box_ids, v_extra_box_id) is not null then
        perform app_api.raise_http(400, format('Duplicate extra allocation entry for box %s.', v_extra_box_id));
      end if;

      select *
      into v_candidate
      from app.boxes b
      where b.org_id = p_org_id
        and b.box_id = v_extra_box_id
      for update;

      if not found then
        perform app_api.raise_http(404, format('Box not found: %s', v_extra_box_id));
      end if;

      if coalesce(v_candidate.status::text, '') not in ('IN_STOCK', 'ORDERED') then
        perform app_api.raise_http(400, format('Box %s is no longer allocatable.', v_candidate.box_id));
      end if;

      if v_requirement_id is not null then
        if not app_api.requirement_film_is_compatible(
          p_org_id,
          v_candidate.manufacturer,
          v_candidate.film_name,
          v_requirement.manufacturer,
          v_requirement.film_name
        ) or v_candidate.width_in < v_requested_width_in then
          perform app_api.raise_http(
            400,
            format(
              'Extra box %s must use a compatible film and meet the requested width for this allocation.',
              v_candidate.box_id
            )
          );
        end if;
      elsif app_api.normalize_requirement_film_key(p_org_id, v_candidate.manufacturer, v_candidate.film_name) <> v_source_film_key
        or v_candidate.width_in < v_requested_width_in then
        perform app_api.raise_http(
          400,
          format(
            'Extra box %s must match film and meet the requested width for this allocation.',
            v_candidate.box_id
          )
        );
      end if;

      v_candidate_planning_feet := app_api.allocation_planning_feet_for_box(v_candidate);
      if v_candidate_planning_feet < v_extra_feet then
        perform app_api.raise_http(400, format('Box %s no longer has enough planning LF.', v_candidate.box_id));
      end if;

      v_allocation := app_api.create_allocation(
        p_org_id,
        v_candidate,
        v_job_context,
        v_extra_feet,
        p_actor,
        '',
        'EXTRA',
        null
      );
      if coalesce(v_candidate.status::text, '') = 'IN_STOCK' then
        v_candidate.feet_available := greatest(v_candidate.feet_available - v_extra_feet, 0);
        perform app_api.save_box(v_candidate);
      end if;
      v_allocation_ids := array_append(v_allocation_ids, v_allocation.allocation_id);
      v_extra_processed_box_ids := array_append(v_extra_processed_box_ids, v_extra_box_id);
    end loop;
  end if;

  if v_requested_feet = 0 and coalesce(array_length(v_extra_processed_box_ids, 1), 0) = 0 then
    perform app_api.raise_http(400, 'RequestedFeet must be greater than zero unless extraAllocations are provided.');
  end if;

  if v_remaining > 0 then
    if app_api.trim_text(p_payload->>'jobWarehouse') <> '' then
      v_job_warehouse := app_api.require_org_warehouse(p_org_id, p_payload->>'jobWarehouse', 'Job warehouse');
    else
      v_job_warehouse := v_source.warehouse;
    end if;

    v_film_order.id := gen_random_uuid();
    v_film_order.org_id := p_org_id;
    v_film_order.film_order_id := app_api.create_log_id();
    v_film_order.job_id := app_api.get_or_resolve_job_id(p_org_id, v_job_context->>'jobNumber');
    v_film_order.job_number := v_job_context->>'jobNumber';
    v_film_order.warehouse := v_job_warehouse;
    v_film_order.manufacturer := coalesce(v_requirement.manufacturer, v_source.manufacturer);
    v_film_order.film_name := coalesce(v_requirement.film_name, v_source.film_name);
    v_film_order.width_in := v_requested_width_in;
    v_film_order.requested_feet := v_remaining;
    v_film_order.covered_feet := 0;
    v_film_order.ordered_feet := 0;
    v_film_order.remaining_to_order_feet := v_remaining;
    v_film_order.job_date := nullif(v_job_context->>'jobDate', '')::date;
    v_film_order.crew_leader := coalesce(v_job_context->>'crewLeader', '');
    v_film_order.status := 'FILM_ORDER';
    v_film_order.source_box_id := v_source.box_id;
    v_film_order.resolved_at := null;
    v_film_order.resolved_by := '';
    v_film_order.notes := format('Created from a shortage while trying to allocate %s LF.', v_requested_feet);
    v_film_order.created_at := now();
    v_film_order.created_by := app_api.trim_text(p_actor);
    v_film_order := app_api.save_film_order(v_film_order);
    v_warnings := app_api.push_warning(
      v_warnings,
      format('Film Order %s was created for the remaining %s LF.', v_film_order.film_order_id, v_remaining)
    );
  end if;

  return jsonb_build_object(
    'allocationIds', to_jsonb(v_allocation_ids),
    'filmOrderId', coalesce(v_film_order.film_order_id, ''),
    'remainingUncoveredFeet', greatest(v_remaining, 0),
    'warnings', to_jsonb(v_warnings)
  );
end;
$$;

create or replace function public.api_film_orders_cancel(
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
  v_job_number text := app_api.require_text(p_payload->>'jobNumber', 'JobNumber');
  v_reason text := coalesce(nullif(app_api.trim_text(p_payload->>'reason'), ''), 'Job cancelled.');
  v_entry app.allocations;
  v_order app.film_orders;
  v_box app.boxes;
  v_released_by_box jsonb := '{}'::jsonb;
  v_released_count integer := 0;
  v_affected_box_count integer := 0;
  v_deleted_film_order_count integer := 0;
  v_caulk_result jsonb;
  v_caulk_cancelled_count integer := 0;
  v_caulk_released_reserved_tubes integer := 0;
begin
  perform app_api.require_org_member(p_org_id);

  v_caulk_result := app_api.cancel_active_caulk_allocations_for_job(
    p_org_id,
    p_actor,
    v_job_number,
    v_reason,
    true
  );
  v_caulk_cancelled_count := coalesce((v_caulk_result->>'cancelledAllocationCount')::integer, 0);
  v_caulk_released_reserved_tubes := coalesce((v_caulk_result->>'releasedReservedTubes')::integer, 0);

  for v_entry in
    select *
    from app.allocations a
    where a.org_id = p_org_id
      and upper(a.job_number) = upper(v_job_number)
      and a.status = 'ACTIVE'
    for update
  loop
    v_released_by_box := jsonb_set(
      v_released_by_box,
      array[v_entry.box_id],
      to_jsonb(coalesce((v_released_by_box->>v_entry.box_id)::integer, 0) + v_entry.allocated_feet),
      true
    );
    v_entry.status := 'CANCELLED';
    v_entry.resolved_at := now();
    v_entry.resolved_by := app_api.trim_text(p_actor);
    v_entry.notes := v_reason;
    perform app_api.save_allocation(v_entry);
    v_released_count := v_released_count + 1;
  end loop;

  for v_box in
    select *
    from app.boxes b
    where b.org_id = p_org_id
      and v_released_by_box ? b.box_id
    for update
  loop
    if v_box.status not in ('ZEROED', 'RETIRED') then
      v_box.feet_available := app_api.next_feet_available_after_allocation_release(
        coalesce(v_box.status::text, ''),
        v_box.feet_available,
        coalesce((v_released_by_box->>v_box.box_id)::integer, 0),
        v_box.initial_feet
      );
      perform app_api.save_box(v_box);
    end if;
    v_affected_box_count := v_affected_box_count + 1;
  end loop;

  for v_order in
    select *
    from app.film_orders f
    where f.org_id = p_org_id
      and upper(f.job_number) = upper(v_job_number)
    for update
  loop
    perform app_api.delete_film_order_links_by_film_order_id(p_org_id, v_order.film_order_id);
    perform app_api.delete_film_order(p_org_id, v_order.film_order_id);
    v_deleted_film_order_count := v_deleted_film_order_count + 1;
  end loop;

  update app.jobs
  set lifecycle_status = 'CANCELLED',
      updated_at = now(),
      updated_by = app_api.trim_text(p_actor)
  where org_id = p_org_id
    and job_number = v_job_number;

  return jsonb_build_object(
    'jobNumber', v_job_number,
    'warnings', jsonb_build_array(
      format(
        'Cancelled job %s. Released %s active film allocation%s across %s box%s, released %s reserved caulk tube%s across %s caulk allocation%s, and deleted %s film order%s.',
        v_job_number,
        v_released_count,
        case when v_released_count = 1 then '' else 's' end,
        v_affected_box_count,
        case when v_affected_box_count = 1 then '' else 'es' end,
        v_caulk_released_reserved_tubes,
        case when v_caulk_released_reserved_tubes = 1 then '' else 's' end,
        v_caulk_cancelled_count,
        case when v_caulk_cancelled_count = 1 then '' else 's' end,
        v_deleted_film_order_count,
        case when v_deleted_film_order_count = 1 then '' else 's' end
      )
    )
  );
end;
$$;
