
create table if not exists app.warehouses (
  org_id uuid not null references app.organizations(id) on delete cascade,
  code text not null,
  name text not null,
  box_id_prefix text not null default '',
  created_at timestamptz not null default now(),
  created_by text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text not null default '',
  primary key (org_id, code)
);

alter table app.warehouses
  drop constraint if exists warehouses_code_format;
alter table app.warehouses
  add constraint warehouses_code_format check (
    code = upper(btrim(code))
    and code ~ '^[A-Z0-9]{2,8}$'
  );

alter table app.warehouses
  drop constraint if exists warehouses_name_format;
alter table app.warehouses
  add constraint warehouses_name_format check (
    btrim(name) <> ''
    and length(name) <= 80
  );

alter table app.warehouses
  drop constraint if exists warehouses_box_id_prefix_format;
alter table app.warehouses
  add constraint warehouses_box_id_prefix_format check (
    box_id_prefix = upper(btrim(box_id_prefix))
    and (box_id_prefix = '' or box_id_prefix ~ '^[A-Z0-9]{1,4}$')
  );

create unique index if not exists idx_warehouses_org_name_ci
  on app.warehouses (org_id, lower(name));

create unique index if not exists idx_warehouses_org_box_prefix_nonblank
  on app.warehouses (org_id, box_id_prefix)
  where box_id_prefix <> '';

create or replace function app_api.ensure_default_warehouses_for_org(
  p_org_id uuid,
  p_actor text default 'system'
)
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  if p_org_id is null then
    return;
  end if;

  insert into app.warehouses (
    org_id,
    code,
    name,
    box_id_prefix,
    created_by,
    updated_by
  )
  values
    (p_org_id, 'IL', 'Wauconda Illinois', '', app_api.trim_text(p_actor), app_api.trim_text(p_actor)),
    (p_org_id, 'MS', 'Ridgeland Mississippi', 'M', app_api.trim_text(p_actor), app_api.trim_text(p_actor))
  on conflict (org_id, code) do update set
    name = excluded.name,
    box_id_prefix = excluded.box_id_prefix,
    updated_at = now(),
    updated_by = excluded.updated_by;
end;
$$;

create or replace function app_api.seed_default_warehouses_for_new_org()
returns trigger
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.ensure_default_warehouses_for_org(new.id, 'org-bootstrap');
  return new;
end;
$$;

drop trigger if exists trg_seed_default_warehouses on app.organizations;
create trigger trg_seed_default_warehouses
after insert on app.organizations
for each row
execute function app_api.seed_default_warehouses_for_new_org();

do $$
declare
  v_org app.organizations;
begin
  for v_org in
    select *
    from app.organizations
  loop
    perform app_api.ensure_default_warehouses_for_org(v_org.id, 'migration-0017');
  end loop;
end;
$$;

alter table app.boxes
  alter column warehouse type text using warehouse::text;
alter table app.jobs
  alter column warehouse type text using warehouse::text;
alter table app.film_orders
  alter column warehouse type text using warehouse::text;
alter table app.allocations
  alter column warehouse type text using warehouse::text;
alter table app.roll_weight_log
  alter column warehouse type text using warehouse::text;

alter table app.boxes
  drop constraint if exists fk_boxes_warehouses;
alter table app.boxes
  add constraint fk_boxes_warehouses
  foreign key (org_id, warehouse)
  references app.warehouses(org_id, code);

alter table app.jobs
  drop constraint if exists fk_jobs_warehouses;
alter table app.jobs
  add constraint fk_jobs_warehouses
  foreign key (org_id, warehouse)
  references app.warehouses(org_id, code);

alter table app.film_orders
  drop constraint if exists fk_film_orders_warehouses;
alter table app.film_orders
  add constraint fk_film_orders_warehouses
  foreign key (org_id, warehouse)
  references app.warehouses(org_id, code);

alter table app.allocations
  drop constraint if exists fk_allocations_warehouses;
alter table app.allocations
  add constraint fk_allocations_warehouses
  foreign key (org_id, warehouse)
  references app.warehouses(org_id, code);

alter table app.roll_weight_log
  drop constraint if exists fk_roll_weight_log_warehouses;
alter table app.roll_weight_log
  add constraint fk_roll_weight_log_warehouses
  foreign key (org_id, warehouse)
  references app.warehouses(org_id, code);

create or replace function app_api.normalize_warehouse_code(
  p_value text,
  p_field_name text default 'Warehouse'
)
returns text
language plpgsql
immutable
as $$
declare
  v_code text := upper(app_api.require_text(p_value, p_field_name));
begin
  if v_code = 'ALL' then
    perform app_api.raise_http(400, format('%s code ALL is reserved.', coalesce(p_field_name, 'Warehouse')));
  end if;

  if v_code !~ '^[A-Z0-9]{2,8}$' then
    perform app_api.raise_http(
      400,
      format('%s must be 2-8 uppercase letters or digits.', coalesce(p_field_name, 'Warehouse'))
    );
  end if;

  return v_code;
end;
$$;

create or replace function app_api.normalize_warehouse_name(
  p_value text,
  p_field_name text default 'Warehouse name'
)
returns text
language plpgsql
immutable
as $$
declare
  v_name text := regexp_replace(app_api.require_text(p_value, p_field_name), '\s+', ' ', 'g');
begin
  if length(v_name) > 80 then
    perform app_api.raise_http(400, format('%s must be 80 characters or less.', coalesce(p_field_name, 'Warehouse name')));
  end if;

  return v_name;
end;
$$;

create or replace function app_api.normalize_warehouse_prefix(
  p_value text,
  p_field_name text default 'BoxID prefix'
)
returns text
language plpgsql
immutable
as $$
declare
  v_prefix text := upper(app_api.require_text(p_value, p_field_name));
begin
  if v_prefix !~ '^[A-Z0-9]{1,4}$' then
    perform app_api.raise_http(
      400,
      format('%s must be 1-4 uppercase letters or digits.', coalesce(p_field_name, 'BoxID prefix'))
    );
  end if;

  return v_prefix;
end;
$$;

create or replace function app_api.require_org_warehouse(
  p_org_id uuid,
  p_value text,
  p_field_name text default 'Warehouse'
)
returns text
language plpgsql
stable
security definer
set search_path = public, app, app_api
as $$
declare
  v_code text := app_api.normalize_warehouse_code(p_value, p_field_name);
begin
  if p_org_id is null then
    perform app_api.raise_http(400, 'Organization is required.');
  end if;

  if not exists (
    select 1
    from app.warehouses w
    where w.org_id = p_org_id
      and w.code = v_code
  ) then
    perform app_api.raise_http(400, format('%s is not configured.', coalesce(p_field_name, 'Warehouse')));
  end if;

  return v_code;
end;
$$;

create or replace function app_api.resolve_warehouse_from_box_id(
  p_org_id uuid,
  p_box_id text
)
returns text
language plpgsql
stable
security definer
set search_path = public, app, app_api
as $$
declare
  v_box_id text := upper(app_api.require_text(p_box_id, 'BoxID'));
  v_match text;
  v_default text;
begin
  if p_org_id is null then
    perform app_api.raise_http(400, 'Organization is required.');
  end if;

  select w.code
  into v_match
  from app.warehouses w
  where w.org_id = p_org_id
    and w.box_id_prefix <> ''
    and v_box_id like w.box_id_prefix || '%'
  order by length(w.box_id_prefix) desc, w.code
  limit 1;

  if v_match is not null then
    return v_match;
  end if;

  select w.code
  into v_default
  from app.warehouses w
  where w.org_id = p_org_id
    and w.box_id_prefix = ''
  order by case when w.code = 'IL' then 0 else 1 end, w.code
  limit 1;

  if v_default is not null then
    return v_default;
  end if;

  perform app_api.raise_http(
    400,
    'No default warehouse is configured for BoxID values without a prefix.'
  );
  return '';
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

create or replace function public.api_boxes_add(
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
  v_requested_feet integer := floor(nullif(app_api.trim_text(p_payload->>'requestedFeet'), '')::numeric);
  v_remaining integer;
  v_source_suggested integer := 0;
  v_cross_warehouse boolean := coalesce((p_payload->>'crossWarehouse')::boolean, false);
  v_selected_box_ids text[] := coalesce(
    array(select jsonb_array_elements_text(coalesce(p_payload->'selectedSuggestionBoxIds', '[]'::jsonb))),
    array[]::text[]
  );
  v_allocation app.allocations;
  v_allocation_ids text[] := array[]::text[];
  v_film_order app.film_orders;
  v_conflict_count integer;
  v_job_warehouse text;
  v_warnings text[] := array[]::text[];
begin
  perform app_api.require_org_member(p_org_id);

  if v_requested_feet is null or v_requested_feet <= 0 then
    perform app_api.raise_http(400, 'RequestedFeet must be greater than zero.');
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

  if v_source.status <> 'IN_STOCK' then
    perform app_api.raise_http(400, 'Only in-stock boxes can be allocated.');
  end if;

  v_job_context := app_api.resolve_job_context(
    p_org_id,
    p_payload->>'jobNumber',
    p_payload->>'jobDate',
    p_payload->>'crewLeader'
  );

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
    v_source_suggested := least(v_source.feet_available, v_requested_feet);
  end if;

  v_remaining := v_requested_feet - v_source_suggested;

  if v_source_suggested > 0 then
    v_allocation := app_api.create_allocation(
      p_org_id,
      v_source,
      v_job_context,
      v_source_suggested,
      p_actor,
      ''
    );
    v_source.feet_available := greatest(v_source.feet_available - v_source_suggested, 0);
    v_source := app_api.save_box(v_source);
    v_allocation_ids := array_append(v_allocation_ids, v_allocation.allocation_id);
  end if;

  for v_candidate in
    select *
    from app.boxes b
    where b.org_id = p_org_id
      and b.box_id <> v_source.box_id
      and b.status = 'IN_STOCK'
      and b.feet_available > 0
      and b.manufacturer = v_source.manufacturer
      and b.film_name = v_source.film_name
      and b.width_in = v_source.width_in
      and (v_cross_warehouse or b.warehouse = v_source.warehouse)
    order by coalesce(b.received_date, b.order_date, '9999-12-31'::date), b.box_id
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

    v_allocation := app_api.create_allocation(
      p_org_id,
      v_candidate,
      v_job_context,
      least(v_candidate.feet_available, v_remaining),
      p_actor,
      ''
    );
    v_candidate.feet_available := greatest(v_candidate.feet_available - v_allocation.allocated_feet, 0);
    perform app_api.save_box(v_candidate);
    v_allocation_ids := array_append(v_allocation_ids, v_allocation.allocation_id);
    v_remaining := v_remaining - v_allocation.allocated_feet;
  end loop;

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
    v_film_order.manufacturer := v_source.manufacturer;
    v_film_order.film_name := v_source.film_name;
    v_film_order.width_in := v_source.width_in;
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
create or replace function public.api_jobs_create(
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
  v_job app.jobs;
  v_now timestamptz := now();
begin
  perform app_api.require_org_member(p_org_id);

  select *
  into v_job
  from app.jobs j
  where j.org_id = p_org_id
    and j.job_number = app_api.require_job_number_digits(p_payload->>'jobNumber', 'Job ID number')
  for update;

  if not found then
    v_job.id := gen_random_uuid();
    v_job.created_at := v_now;
    v_job.created_by := app_api.trim_text(p_actor);
  end if;

  v_job.org_id := p_org_id;
  v_job.job_number := app_api.require_job_number_digits(p_payload->>'jobNumber', 'Job ID number');
  v_job.warehouse := app_api.require_org_warehouse(p_org_id, p_payload->>'warehouse', 'Warehouse');
  v_job.sections := app_api.normalize_job_sections(p_payload->>'sections');
  v_job.due_date := nullif(app_api.trim_text(p_payload->>'dueDate'), '')::date;
  v_job.crew_leader := app_api.trim_text(p_payload->>'crewLeader');
  v_job.lifecycle_status := app_api.normalize_job_lifecycle_status(p_payload->>'lifecycleStatus');
  v_job.notes := app_api.trim_text(p_payload->>'notes');
  v_job.updated_at := v_now;
  v_job.updated_by := app_api.trim_text(p_actor);

  v_job := app_api.save_job(v_job);
  perform app_api.replace_job_requirements(p_org_id, v_job, p_payload->'requirements', p_actor, v_now);

  return jsonb_build_object(
    'jobNumber', v_job.job_number,
    'warnings', '[]'::jsonb
  );
end;
$$;

create or replace function public.api_jobs_update(
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
  v_job app.jobs;
  v_now timestamptz := now();
begin
  perform app_api.require_org_member(p_org_id);

  select *
  into v_job
  from app.jobs j
  where j.org_id = p_org_id
    and j.job_number = app_api.require_job_number_digits(p_payload->>'jobNumber', 'Job ID number')
  for update;

  if not found then
    v_job.id := gen_random_uuid();
    v_job.org_id := p_org_id;
    v_job.job_number := app_api.require_job_number_digits(p_payload->>'jobNumber', 'Job ID number');
    v_job.warehouse := coalesce(
      case
        when app_api.trim_text(p_payload->>'warehouse') <> ''
          then app_api.require_org_warehouse(p_org_id, p_payload->>'warehouse', 'Warehouse')
        else null
      end,
      (
        select w.code
        from app.warehouses w
        where w.org_id = p_org_id
          and w.box_id_prefix = ''
        order by case when w.code = 'IL' then 0 else 1 end, w.code
        limit 1
      ),
      (
        select w.code
        from app.warehouses w
        where w.org_id = p_org_id
        order by w.code
        limit 1
      )
    );
    if v_job.warehouse is null then
      perform app_api.raise_http(400, 'No warehouse is configured for this organization.');
    end if;
    v_job.sections := null;
    v_job.due_date := null;
    v_job.crew_leader := '';
    v_job.lifecycle_status := 'ACTIVE';
    v_job.notes := '';
    v_job.created_at := v_now;
    v_job.created_by := app_api.trim_text(p_actor);
  end if;

  if p_payload ? 'warehouse' then
    v_job.warehouse := app_api.require_org_warehouse(p_org_id, p_payload->>'warehouse', 'Warehouse');
  end if;
  if p_payload ? 'sections' then
    v_job.sections := app_api.normalize_job_sections(p_payload->>'sections');
  end if;
  if p_payload ? 'dueDate' then
    v_job.due_date := nullif(app_api.trim_text(p_payload->>'dueDate'), '')::date;
  end if;
  if p_payload ? 'crewLeader' then
    v_job.crew_leader := app_api.trim_text(p_payload->>'crewLeader');
  end if;
  if p_payload ? 'lifecycleStatus' then
    v_job.lifecycle_status := app_api.normalize_job_lifecycle_status(p_payload->>'lifecycleStatus');
  end if;
  if p_payload ? 'notes' then
    v_job.notes := app_api.trim_text(p_payload->>'notes');
  end if;

  v_job.updated_at := v_now;
  v_job.updated_by := app_api.trim_text(p_actor);
  v_job := app_api.save_job(v_job);
  perform app_api.replace_job_requirements(p_org_id, v_job, p_payload->'requirements', p_actor, v_now);

  return jsonb_build_object(
    'jobNumber', v_job.job_number,
    'warnings', '[]'::jsonb
  );
end;
$$;

create or replace function public.api_film_orders_create(
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
  v_requested_feet integer := floor(nullif(app_api.trim_text(p_payload->>'requestedFeet'), '')::numeric);
  v_width_in numeric := nullif(app_api.trim_text(p_payload->>'widthIn'), '')::numeric;
  v_order app.film_orders;
begin
  perform app_api.require_org_member(p_org_id);

  if v_width_in is null or v_width_in <= 0 then
    perform app_api.raise_http(400, 'WidthIn must be greater than zero.');
  end if;

  if v_requested_feet is null or v_requested_feet <= 0 then
    perform app_api.raise_http(400, 'RequestedFeet must be greater than zero.');
  end if;

  v_order.id := gen_random_uuid();
  v_order.org_id := p_org_id;
  v_order.film_order_id := app_api.create_log_id();
  v_order.job_id := app_api.get_or_resolve_job_id(p_org_id, p_payload->>'jobNumber');
  v_order.job_number := app_api.require_text(p_payload->>'jobNumber', 'JobNumber');
  v_order.warehouse := app_api.require_org_warehouse(p_org_id, p_payload->>'warehouse', 'Warehouse');
  v_order.manufacturer := app_api.require_text(p_payload->>'manufacturer', 'Manufacturer');
  v_order.film_name := app_api.require_text(p_payload->>'filmName', 'FilmName');
  v_order.width_in := v_width_in;
  v_order.requested_feet := v_requested_feet;
  v_order.covered_feet := 0;
  v_order.ordered_feet := 0;
  v_order.remaining_to_order_feet := v_requested_feet;
  v_order.job_date := null;
  v_order.crew_leader := '';
  v_order.status := 'FILM_ORDER';
  v_order.source_box_id := '';
  v_order.resolved_at := null;
  v_order.resolved_by := '';
  v_order.notes := 'Created manually from Film Orders.';
  v_order.created_at := now();
  v_order.created_by := app_api.trim_text(p_actor);

  v_order := app_api.save_film_order(v_order);

  return jsonb_build_object(
    'filmOrderId', v_order.film_order_id,
    'warnings', '[]'::jsonb
  );
end;
$$;

create or replace function public.api_acl_list_warehouses(p_org_id uuid)
returns table (
  code text,
  name text,
  box_id_prefix text
)
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'read');

  return query
  select
    w.code,
    w.name,
    w.box_id_prefix
  from app.warehouses w
  where w.org_id = p_org_id
  order by
    case
      when w.code = 'IL' then 0
      when w.code = 'MS' then 1
      else 2
    end,
    w.code;
end;
$$;

create or replace function public.api_acl_add_warehouse(
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
  v_code text := app_api.normalize_warehouse_code(p_payload->>'code', 'Warehouse code');
  v_name text := app_api.normalize_warehouse_name(p_payload->>'name', 'Warehouse name');
  v_prefix text := app_api.normalize_warehouse_prefix(p_payload->>'boxIdPrefix', 'BoxID prefix');
begin
  perform app_api.require_org_owner(p_org_id);

  if exists (
    select 1
    from app.warehouses w
    where w.org_id = p_org_id
      and w.code = v_code
  ) then
    perform app_api.raise_http(400, format('Warehouse %s already exists.', v_code));
  end if;

  if exists (
    select 1
    from app.warehouses w
    where w.org_id = p_org_id
      and w.box_id_prefix = v_prefix
  ) then
    perform app_api.raise_http(400, format('BoxID prefix %s is already in use.', v_prefix));
  end if;

  insert into app.warehouses (
    org_id,
    code,
    name,
    box_id_prefix,
    created_by,
    updated_by
  )
  values (
    p_org_id,
    v_code,
    v_name,
    v_prefix,
    app_api.trim_text(p_actor),
    app_api.trim_text(p_actor)
  );

  return jsonb_build_object(
    'code', v_code,
    'name', v_name,
    'boxIdPrefix', v_prefix
  );
end;
$$;

select app_api.grant_execute_if_exists('public.api_acl_list_warehouses(uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_add_warehouse(uuid, text, jsonb)', 'authenticated');
