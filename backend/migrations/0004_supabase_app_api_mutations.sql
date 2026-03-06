create or replace function app_api.push_warning(p_warnings text[], p_message text)
returns text[]
language sql
immutable
as $$
  select
    case
      when app_api.trim_text(p_message) = '' then coalesce(p_warnings, array[]::text[])
      else array_append(coalesce(p_warnings, array[]::text[]), p_message)
    end;
$$;

create or replace function app_api.require_text(p_value text, p_field_name text)
returns text
language plpgsql
immutable
as $$
declare
  v_trimmed text := app_api.trim_text(p_value);
begin
  if v_trimmed = '' then
    perform app_api.raise_http(400, format('%s is required.', coalesce(p_field_name, 'Value')));
  end if;

  return v_trimmed;
end;
$$;

create or replace function app_api.require_warehouse(p_value text, p_field_name text default 'Warehouse')
returns app.warehouse
language plpgsql
immutable
as $$
declare
  v_trimmed text := upper(app_api.require_text(p_value, p_field_name));
begin
  if v_trimmed not in ('IL', 'MS') then
    perform app_api.raise_http(400, format('%s must be IL or MS.', coalesce(p_field_name, 'Warehouse')));
  end if;

  return v_trimmed::app.warehouse;
end;
$$;

create or replace function app_api.require_job_number_digits(
  p_value text,
  p_field_name text default 'JobNumber'
)
returns text
language plpgsql
immutable
as $$
declare
  v_trimmed text := app_api.require_text(p_value, p_field_name);
begin
  if v_trimmed !~ '^\d+$' then
    perform app_api.raise_http(400, format('%s must contain numbers only.', coalesce(p_field_name, 'JobNumber')));
  end if;

  return v_trimmed;
end;
$$;

create or replace function app_api.normalize_job_sections(p_value text)
returns text
language plpgsql
immutable
as $$
declare
  v_trimmed text := app_api.trim_text(p_value);
  v_token text;
  v_result text[] := array[]::text[];
begin
  if v_trimmed = '' then
    return null;
  end if;

  foreach v_token in array string_to_array(v_trimmed, ',') loop
    v_token := app_api.trim_text(v_token);
    if v_token = '' then
      continue;
    end if;

    if v_token !~ '^\d+$' then
      perform app_api.raise_http(400, 'Sections must contain numbers separated by commas.');
    end if;

    v_result := array_append(v_result, v_token);
  end loop;

  if coalesce(array_length(v_result, 1), 0) = 0 then
    return null;
  end if;

  return array_to_string(v_result, ', ');
end;
$$;

create or replace function app_api.normalize_job_lifecycle_status(p_value text)
returns app.job_lifecycle_status
language sql
immutable
as $$
  select
    case
      when upper(app_api.trim_text(p_value)) = 'CANCELLED' then 'CANCELLED'::app.job_lifecycle_status
      else 'ACTIVE'::app.job_lifecycle_status
    end;
$$;

create or replace function app_api.normalize_collapsed_catalog_label(p_value text)
returns text
language sql
immutable
as $$
  select regexp_replace(app_api.trim_text(p_value), '\s+', ' ', 'g');
$$;

create or replace function app_api.normalize_catalog_lookup_key(p_value text)
returns text
language sql
immutable
as $$
  select lower(app_api.normalize_collapsed_catalog_label(p_value));
$$;

create or replace function app_api.normalize_job_requirement_lookup_key(
  p_manufacturer text,
  p_film_name text,
  p_width_in numeric
)
returns text
language sql
immutable
as $$
  select app_api.normalize_catalog_lookup_key(p_manufacturer)
    || '|' || app_api.normalize_catalog_lookup_key(p_film_name)
    || '|' || round(coalesce(p_width_in, 0)::numeric, 4)::text;
$$;

create or replace function app_api.determine_warehouse_from_box_id(p_box_id text)
returns app.warehouse
language plpgsql
immutable
as $$
declare
  v_box_id text := app_api.require_text(p_box_id, 'BoxID');
begin
  if upper(left(v_box_id, 1)) = 'M' then
    return 'MS'::app.warehouse;
  end if;

  return 'IL'::app.warehouse;
end;
$$;

create or replace function app_api.derive_add_feet_available(
  p_initial_feet integer,
  p_received_date date
)
returns integer
language sql
immutable
as $$
  select
    case
      when p_received_date is not null and p_received_date <= app_api.today_date()
        then greatest(coalesce(p_initial_feet, 0), 0)
      else 0
    end;
$$;

create or replace function app_api.derive_lifecycle_status(p_received_date date)
returns app.box_status
language sql
immutable
as $$
  select
    case
      when p_received_date is not null and p_received_date <= app_api.today_date()
        then 'IN_STOCK'::app.box_status
      else 'ORDERED'::app.box_status
    end;
$$;

create or replace function app_api.has_positive_physical_feet(p_box app.boxes)
returns boolean
language plpgsql
immutable
as $$
begin
  if p_box is null or p_box.received_date is null then
    return false;
  end if;

  if p_box.last_roll_weight_lbs is not null
    and p_box.core_weight_lbs is not null
    and p_box.lf_weight_lbs_per_ft is not null
    and p_box.lf_weight_lbs_per_ft > 0 then
    return app_api.derive_feet_available_from_roll_weight(
      p_box.last_roll_weight_lbs,
      p_box.core_weight_lbs,
      p_box.lf_weight_lbs_per_ft,
      p_box.initial_feet
    ) > 0;
  end if;

  return coalesce(p_box.initial_feet, 0) > 0;
end;
$$;

create or replace function app_api.determine_zeroed_reason(
  p_feet_available integer,
  p_last_roll_weight_lbs numeric
)
returns text
language plpgsql
immutable
as $$
begin
  if coalesce(p_feet_available, 0) = 0 and coalesce(p_last_roll_weight_lbs, 0) = 0 then
    return 'Auto-zeroed because Available Feet and Last Roll Weight reached 0.';
  end if;

  if coalesce(p_feet_available, 0) = 0 then
    return 'Auto-zeroed because Available Feet reached 0.';
  end if;

  return 'Auto-zeroed because Last Roll Weight reached 0.';
end;
$$;

create or replace function app_api.normalize_meaningful_zeroed_note(p_note text)
returns text
language plpgsql
immutable
as $$
declare
  v_trimmed text := app_api.trim_text(p_note);
begin
  if v_trimmed = '' then
    return '';
  end if;

  if v_trimmed ~* '^Checked in at ' or v_trimmed ~* '^Auto-moved to zeroed out inventory$' then
    return '';
  end if;

  return v_trimmed;
end;
$$;

create or replace function app_api.parse_checkout_job_from_note(p_note text)
returns text
language plpgsql
immutable
as $$
declare
  v_trimmed text := app_api.trim_text(p_note);
  v_match text[];
begin
  v_match := regexp_match(v_trimmed, '^Checked out for job\s+(.+)$', 'i');
  if v_match is null or array_length(v_match, 1) = 0 then
    return '';
  end if;

  return app_api.trim_text(v_match[1]);
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

create or replace function app_api.save_job(p_job app.jobs)
returns app.jobs
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_row app.jobs;
begin
  insert into app.jobs (
    id,
    org_id,
    job_number,
    warehouse,
    sections,
    due_date,
    lifecycle_status,
    notes,
    created_at,
    created_by,
    updated_at,
    updated_by
  )
  values (
    coalesce(p_job.id, gen_random_uuid()),
    p_job.org_id,
    p_job.job_number,
    p_job.warehouse,
    p_job.sections,
    p_job.due_date,
    p_job.lifecycle_status,
    coalesce(p_job.notes, ''),
    coalesce(p_job.created_at, now()),
    coalesce(p_job.created_by, ''),
    coalesce(p_job.updated_at, now()),
    coalesce(p_job.updated_by, '')
  )
  on conflict (org_id, job_number) do update set
    warehouse = excluded.warehouse,
    sections = excluded.sections,
    due_date = excluded.due_date,
    lifecycle_status = excluded.lifecycle_status,
    notes = excluded.notes,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function app_api.save_allocation(p_allocation app.allocations)
returns app.allocations
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_row app.allocations;
begin
  insert into app.allocations (
    id,
    org_id,
    allocation_id,
    box_id,
    job_id,
    job_number,
    warehouse,
    job_date,
    allocated_feet,
    status,
    created_at,
    created_by,
    resolved_at,
    resolved_by,
    notes,
    crew_leader,
    film_order_id
  )
  values (
    coalesce(p_allocation.id, gen_random_uuid()),
    p_allocation.org_id,
    p_allocation.allocation_id,
    p_allocation.box_id,
    p_allocation.job_id,
    p_allocation.job_number,
    p_allocation.warehouse,
    p_allocation.job_date,
    p_allocation.allocated_feet,
    p_allocation.status,
    coalesce(p_allocation.created_at, now()),
    coalesce(p_allocation.created_by, ''),
    p_allocation.resolved_at,
    coalesce(p_allocation.resolved_by, ''),
    coalesce(p_allocation.notes, ''),
    coalesce(p_allocation.crew_leader, ''),
    coalesce(p_allocation.film_order_id, '')
  )
  on conflict (org_id, allocation_id) do update set
    box_id = excluded.box_id,
    job_id = excluded.job_id,
    job_number = excluded.job_number,
    warehouse = excluded.warehouse,
    job_date = excluded.job_date,
    allocated_feet = excluded.allocated_feet,
    status = excluded.status,
    created_at = excluded.created_at,
    created_by = excluded.created_by,
    resolved_at = excluded.resolved_at,
    resolved_by = excluded.resolved_by,
    notes = excluded.notes,
    crew_leader = excluded.crew_leader,
    film_order_id = excluded.film_order_id
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function app_api.save_film_order(p_order app.film_orders)
returns app.film_orders
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_row app.film_orders;
begin
  insert into app.film_orders (
    id,
    org_id,
    film_order_id,
    job_id,
    job_number,
    warehouse,
    manufacturer,
    film_name,
    width_in,
    requested_feet,
    covered_feet,
    ordered_feet,
    remaining_to_order_feet,
    job_date,
    crew_leader,
    status,
    source_box_id,
    resolved_at,
    resolved_by,
    notes,
    created_at,
    created_by
  )
  values (
    coalesce(p_order.id, gen_random_uuid()),
    p_order.org_id,
    p_order.film_order_id,
    p_order.job_id,
    p_order.job_number,
    p_order.warehouse,
    p_order.manufacturer,
    p_order.film_name,
    p_order.width_in,
    p_order.requested_feet,
    p_order.covered_feet,
    p_order.ordered_feet,
    p_order.remaining_to_order_feet,
    p_order.job_date,
    coalesce(p_order.crew_leader, ''),
    p_order.status,
    coalesce(p_order.source_box_id, ''),
    p_order.resolved_at,
    coalesce(p_order.resolved_by, ''),
    coalesce(p_order.notes, ''),
    coalesce(p_order.created_at, now()),
    coalesce(p_order.created_by, '')
  )
  on conflict (org_id, film_order_id) do update set
    job_id = excluded.job_id,
    job_number = excluded.job_number,
    warehouse = excluded.warehouse,
    manufacturer = excluded.manufacturer,
    film_name = excluded.film_name,
    width_in = excluded.width_in,
    requested_feet = excluded.requested_feet,
    covered_feet = excluded.covered_feet,
    ordered_feet = excluded.ordered_feet,
    remaining_to_order_feet = excluded.remaining_to_order_feet,
    job_date = excluded.job_date,
    crew_leader = excluded.crew_leader,
    status = excluded.status,
    source_box_id = excluded.source_box_id,
    resolved_at = excluded.resolved_at,
    resolved_by = excluded.resolved_by,
    notes = excluded.notes,
    created_at = excluded.created_at,
    created_by = excluded.created_by
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function app_api.save_film_order_link(p_link app.film_order_box_links)
returns app.film_order_box_links
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_row app.film_order_box_links;
begin
  insert into app.film_order_box_links (
    id,
    org_id,
    link_id,
    film_order_id,
    box_id,
    ordered_feet,
    auto_allocated_feet,
    created_at,
    created_by
  )
  values (
    coalesce(p_link.id, gen_random_uuid()),
    p_link.org_id,
    p_link.link_id,
    p_link.film_order_id,
    p_link.box_id,
    p_link.ordered_feet,
    p_link.auto_allocated_feet,
    coalesce(p_link.created_at, now()),
    coalesce(p_link.created_by, '')
  )
  on conflict (org_id, link_id) do update set
    film_order_id = excluded.film_order_id,
    box_id = excluded.box_id,
    ordered_feet = excluded.ordered_feet,
    auto_allocated_feet = excluded.auto_allocated_feet,
    created_at = excluded.created_at,
    created_by = excluded.created_by
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function app_api.delete_box(p_org_id uuid, p_box_id text)
returns void
language sql
security definer
set search_path = public, app, app_api
as $$
  delete from app.boxes
  where org_id = p_org_id
    and box_id = app_api.trim_text(p_box_id);
$$;

create or replace function app_api.delete_film_order(p_org_id uuid, p_film_order_id text)
returns void
language sql
security definer
set search_path = public, app, app_api
as $$
  delete from app.film_orders
  where org_id = p_org_id
    and film_order_id = app_api.trim_text(p_film_order_id);
$$;

create or replace function app_api.delete_film_order_links_by_film_order_id(
  p_org_id uuid,
  p_film_order_id text
)
returns void
language sql
security definer
set search_path = public, app, app_api
as $$
  delete from app.film_order_box_links
  where org_id = p_org_id
    and film_order_id = app_api.trim_text(p_film_order_id);
$$;

create or replace function app_api.append_audit_entry(
  p_org_id uuid,
  p_action text,
  p_box_id text,
  p_before_state jsonb,
  p_after_state jsonb,
  p_actor text,
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
  insert into app.audit_log (
    org_id,
    log_id,
    action,
    box_id,
    before_state,
    after_state,
    actor,
    notes,
    created_at
  )
  values (
    p_org_id,
    v_log_id,
    app_api.require_text(p_action, 'Action'),
    app_api.require_text(p_box_id, 'BoxID'),
    p_before_state,
    p_after_state,
    app_api.require_text(p_actor, 'Actor'),
    app_api.trim_text(p_notes),
    now()
  );

  return v_log_id;
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
    notes
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
    coalesce(p_entry.notes, '')
  );

  return v_log_id;
end;
$$;

create or replace function app_api.requirement_rows_from_payload(p_requirements jsonb)
returns table (
  manufacturer text,
  film_name text,
  width_in numeric,
  required_feet integer
)
language plpgsql
stable
as $$
declare
  v_value jsonb;
  v_width_in numeric;
  v_required_feet integer;
begin
  if p_requirements is not null and jsonb_typeof(p_requirements) = 'array' then
    for v_value in
      select value
      from jsonb_array_elements(p_requirements)
    loop
      perform app_api.require_text(v_value->>'manufacturer', 'Requirements[].Manufacturer');
      perform app_api.require_text(v_value->>'filmName', 'Requirements[].FilmName');
      v_width_in := nullif(app_api.trim_text(v_value->>'widthIn'), '')::numeric;
      v_required_feet := floor(nullif(app_api.trim_text(v_value->>'requiredFeet'), '')::numeric);

      if v_width_in is null or v_width_in <= 0 then
        perform app_api.raise_http(400, 'Requirements[].WidthIn must be greater than zero.');
      end if;

      if v_required_feet is null or v_required_feet <= 0 then
        perform app_api.raise_http(400, 'Requirements[].RequiredFeet must be greater than zero.');
      end if;
    end loop;
  end if;

  return query
  with normalized as (
    select
      app_api.normalize_collapsed_catalog_label(value->>'manufacturer') as manufacturer,
      app_api.normalize_collapsed_catalog_label(value->>'filmName') as film_name,
      (nullif(app_api.trim_text(value->>'widthIn'), '')::numeric) as width_in,
      floor(nullif(app_api.trim_text(value->>'requiredFeet'), '')::numeric)::integer as required_feet
    from jsonb_array_elements(
      case
        when p_requirements is null or jsonb_typeof(p_requirements) <> 'array' then '[]'::jsonb
        else p_requirements
      end
    )
  )
  select
    n.manufacturer,
    n.film_name,
    n.width_in,
    sum(n.required_feet)::integer as required_feet
  from normalized n
  group by n.manufacturer, n.film_name, n.width_in
  order by lower(n.manufacturer), lower(n.film_name), n.width_in;
end;
$$;

create or replace function app_api.replace_job_requirements(
  p_org_id uuid,
  p_job app.jobs,
  p_requirements jsonb,
  p_actor text,
  p_now timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_requirement record;
  v_existing app.job_requirements;
begin
  delete from app.job_requirements
  where org_id = p_org_id
    and job_id = p_job.id;

  for v_requirement in
    select *
    from app_api.requirement_rows_from_payload(p_requirements)
  loop
    select *
    into v_existing
    from app.job_requirements r
    where r.org_id = p_org_id
      and r.job_id = p_job.id
      and app_api.normalize_job_requirement_lookup_key(r.manufacturer, r.film_name, r.width_in) =
        app_api.normalize_job_requirement_lookup_key(v_requirement.manufacturer, v_requirement.film_name, v_requirement.width_in)
    limit 1;

    insert into app.job_requirements (
      id,
      org_id,
      job_id,
      manufacturer,
      film_name,
      width_in,
      required_feet,
      notes,
      created_at,
      created_by,
      updated_at,
      updated_by
    )
    values (
      coalesce(v_existing.id, gen_random_uuid()),
      p_org_id,
      p_job.id,
      v_requirement.manufacturer,
      v_requirement.film_name,
      v_requirement.width_in,
      v_requirement.required_feet,
      coalesce(v_existing.notes, ''),
      coalesce(v_existing.created_at, p_now),
      coalesce(v_existing.created_by, app_api.trim_text(p_actor)),
      p_now,
      app_api.trim_text(p_actor)
    );
  end loop;
end;
$$;

create or replace function app_api.get_or_resolve_job_id(p_org_id uuid, p_job_number text)
returns uuid
language sql
security definer
set search_path = public, app, app_api
as $$
  select j.id
  from app.jobs j
  where j.org_id = p_org_id
    and j.job_number = app_api.trim_text(p_job_number)
  limit 1;
$$;

create or replace function app_api.resolve_job_context(
  p_org_id uuid,
  p_job_number text,
  p_job_date text,
  p_crew_leader text
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_job_number text := app_api.require_text(p_job_number, 'JobNumber');
  v_job_date date := nullif(app_api.trim_text(p_job_date), '')::date;
  v_crew_leader text := app_api.trim_text(p_crew_leader);
  v_existing_job_date date;
  v_existing_crew_leader text := '';
begin
  select min(a.job_date), min(nullif(a.crew_leader, ''))
  into v_existing_job_date, v_existing_crew_leader
  from app.allocations a
  where a.org_id = p_org_id
    and upper(a.job_number) = upper(v_job_number);

  if v_existing_job_date is null then
    select min(f.job_date), min(nullif(f.crew_leader, ''))
    into v_existing_job_date, v_existing_crew_leader
    from app.film_orders f
    where f.org_id = p_org_id
      and upper(f.job_number) = upper(v_job_number);
  end if;

  if v_existing_job_date is not null and v_job_date is not null and v_existing_job_date <> v_job_date then
    perform app_api.raise_http(400, 'JobDate must stay the same for an existing Job Number.');
  end if;

  if v_existing_crew_leader <> ''
    and v_crew_leader <> ''
    and upper(v_existing_crew_leader) <> upper(v_crew_leader) then
    perform app_api.raise_http(400, 'CrewLeader must stay the same for an existing Job Number.');
  end if;

  v_job_date := coalesce(v_job_date, v_existing_job_date);
  v_crew_leader := coalesce(nullif(v_crew_leader, ''), v_existing_crew_leader, '');

  if v_job_date is not null and v_crew_leader = '' then
    perform app_api.raise_http(400, 'CrewLeader is required when JobDate is set.');
  end if;

  return jsonb_build_object(
    'jobNumber', v_job_number,
    'jobDate', coalesce(to_char(v_job_date, 'YYYY-MM-DD'), ''),
    'crewLeader', v_crew_leader
  );
end;
$$;

create or replace function app_api.sum_film_order_covered_feet(p_org_id uuid, p_film_order_id text)
returns integer
language sql
security definer
set search_path = public, app, app_api
as $$
  select coalesce(sum(a.allocated_feet), 0)::integer
  from app.allocations a
  where a.org_id = p_org_id
    and a.film_order_id = app_api.trim_text(p_film_order_id)
    and a.status <> 'CANCELLED';
$$;

create or replace function app_api.sum_film_order_ordered_feet(p_org_id uuid, p_film_order_id text)
returns integer
language sql
security definer
set search_path = public, app, app_api
as $$
  select coalesce(sum(l.ordered_feet), 0)::integer
  from app.film_order_box_links l
  where l.org_id = p_org_id
    and l.film_order_id = app_api.trim_text(p_film_order_id);
$$;

create or replace function app_api.recalculate_film_order(
  p_org_id uuid,
  p_film_order_id text,
  p_actor text
)
returns app.film_orders
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_existing app.film_orders;
begin
  select *
  into v_existing
  from app.film_orders f
  where f.org_id = p_org_id
    and f.film_order_id = app_api.trim_text(p_film_order_id)
  for update;

  if not found then
    return null;
  end if;

  v_existing.covered_feet := app_api.sum_film_order_covered_feet(p_org_id, p_film_order_id);
  v_existing.ordered_feet := app_api.sum_film_order_ordered_feet(p_org_id, p_film_order_id);
  v_existing.remaining_to_order_feet := greatest(v_existing.requested_feet - v_existing.ordered_feet, 0);

  if v_existing.status <> 'CANCELLED' then
    if v_existing.covered_feet >= v_existing.requested_feet then
      v_existing.status := 'FULFILLED';
      if v_existing.resolved_at is null then
        v_existing.resolved_at := now();
        v_existing.resolved_by := app_api.trim_text(p_actor);
      end if;
    elsif v_existing.ordered_feet >= v_existing.requested_feet then
      v_existing.status := 'FILM_ON_THE_WAY';
      v_existing.resolved_at := null;
      v_existing.resolved_by := '';
    else
      v_existing.status := 'FILM_ORDER';
      v_existing.resolved_at := null;
      v_existing.resolved_by := '';
    end if;
  end if;

  return app_api.save_film_order(v_existing);
end;
$$;

create or replace function app_api.recalculate_film_orders_for_box_links(
  p_org_id uuid,
  p_box_id text,
  p_actor text
)
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_link record;
  v_seen text[] := array[]::text[];
begin
  for v_link in
    select distinct l.film_order_id
    from app.film_order_box_links l
    where l.org_id = p_org_id
      and l.box_id = app_api.trim_text(p_box_id)
  loop
    if array_position(v_seen, v_link.film_order_id) is not null then
      continue;
    end if;

    perform app_api.recalculate_film_order(p_org_id, v_link.film_order_id, p_actor);
    v_seen := array_append(v_seen, v_link.film_order_id);
  end loop;
end;
$$;

create or replace function app_api.create_allocation(
  p_org_id uuid,
  p_box app.boxes,
  p_job_context jsonb,
  p_allocated_feet integer,
  p_actor text,
  p_film_order_id text default ''
)
returns app.allocations
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_allocation app.allocations;
begin
  v_allocation.id := gen_random_uuid();
  v_allocation.org_id := p_org_id;
  v_allocation.allocation_id := app_api.create_log_id();
  v_allocation.box_id := p_box.box_id;
  v_allocation.job_id := app_api.get_or_resolve_job_id(p_org_id, p_job_context->>'jobNumber');
  v_allocation.job_number := p_job_context->>'jobNumber';
  v_allocation.warehouse := p_box.warehouse;
  v_allocation.job_date := nullif(app_api.trim_text(p_job_context->>'jobDate'), '')::date;
  v_allocation.allocated_feet := p_allocated_feet;
  v_allocation.status := 'ACTIVE';
  v_allocation.created_at := now();
  v_allocation.created_by := app_api.trim_text(p_actor);
  v_allocation.resolved_at := null;
  v_allocation.resolved_by := '';
  v_allocation.notes := '';
  v_allocation.crew_leader := coalesce(p_job_context->>'crewLeader', '');
  v_allocation.film_order_id := app_api.trim_text(p_film_order_id);

  return app_api.save_allocation(v_allocation);
end;
$$;

create or replace function app_api.cancel_active_allocations_for_box(
  p_org_id uuid,
  p_box_id text,
  p_actor text,
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_entry app.allocations;
  v_count integer := 0;
begin
  for v_entry in
    select *
    from app.allocations a
    where a.org_id = p_org_id
      and a.box_id = app_api.trim_text(p_box_id)
      and a.status = 'ACTIVE'
    for update
  loop
    v_entry.status := 'CANCELLED';
    v_entry.resolved_at := now();
    v_entry.resolved_by := app_api.trim_text(p_actor);
    v_entry.notes := app_api.trim_text(p_reason);
    perform app_api.save_allocation(v_entry);

    if coalesce(v_entry.film_order_id, '') <> '' then
      perform app_api.recalculate_film_order(p_org_id, v_entry.film_order_id, p_actor);
    end if;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

create or replace function app_api.cancel_active_film_order_allocations_for_box(
  p_org_id uuid,
  p_box_id text,
  p_actor text,
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_entry app.allocations;
  v_count integer := 0;
begin
  for v_entry in
    select *
    from app.allocations a
    where a.org_id = p_org_id
      and a.box_id = app_api.trim_text(p_box_id)
      and a.status = 'ACTIVE'
      and coalesce(a.film_order_id, '') <> ''
    for update
  loop
    v_entry.status := 'CANCELLED';
    v_entry.resolved_at := now();
    v_entry.resolved_by := app_api.trim_text(p_actor);
    v_entry.notes := coalesce(nullif(app_api.trim_text(p_reason), ''), 'Cancelled because linked box state was undone.');
    perform app_api.save_allocation(v_entry);
    perform app_api.recalculate_film_order(p_org_id, v_entry.film_order_id, p_actor);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

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
      v_entry.status := 'FULFILLED';
      v_entry.resolved_at := now();
      v_entry.resolved_by := app_api.trim_text(p_actor);
      v_entry.notes := format('Fulfilled by checkout for job %s.', app_api.trim_text(p_job_number));
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
begin
  for v_entry in
    select *
    from app.allocations a
    where a.org_id = p_org_id
      and a.box_id = app_api.trim_text(p_box_id)
      and a.status = 'FULFILLED'
      and upper(a.job_number) = upper(app_api.trim_text(p_job_number))
      and a.notes = format('Fulfilled by checkout for job %s.', app_api.trim_text(p_job_number))
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

create or replace function app_api.reactivate_cancelled_allocations_for_zero_undo(
  p_org_id uuid,
  p_box_id text
)
returns integer
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_entry app.allocations;
  v_count integer := 0;
begin
  for v_entry in
    select *
    from app.allocations a
    where a.org_id = p_org_id
      and a.box_id = app_api.trim_text(p_box_id)
      and a.status = 'CANCELLED'
      and a.notes = 'Auto-cancelled because the box was moved to zeroed out inventory.'
    for update
  loop
    v_entry.status := 'ACTIVE';
    v_entry.resolved_at := null;
    v_entry.resolved_by := '';
    v_entry.notes := '';
    perform app_api.save_allocation(v_entry);
    if coalesce(v_entry.film_order_id, '') <> '' then
      perform app_api.recalculate_film_order(p_org_id, v_entry.film_order_id, '');
    end if;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

create or replace function app_api.save_film_catalog(
  p_org_id uuid,
  p_film_key text,
  p_manufacturer text,
  p_film_name text,
  p_sq_ft_weight numeric,
  p_default_core_type text,
  p_source_width_in numeric,
  p_source_initial_feet integer,
  p_source_initial_weight numeric,
  p_source_box_id text,
  p_notes text
)
returns app.film_catalog
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_row app.film_catalog;
begin
  insert into app.film_catalog (
    id,
    org_id,
    film_key,
    manufacturer,
    film_name,
    sq_ft_weight_lbs_per_sq_ft,
    default_core_type,
    source_width_in,
    source_initial_feet,
    source_initial_weight_lbs,
    source_box_id,
    notes,
    updated_at
  )
  values (
    gen_random_uuid(),
    p_org_id,
    p_film_key,
    p_manufacturer,
    p_film_name,
    p_sq_ft_weight,
    p_default_core_type,
    p_source_width_in,
    p_source_initial_feet,
    p_source_initial_weight,
    p_source_box_id,
    coalesce(p_notes, ''),
    now()
  )
  on conflict (org_id, film_key) do update set
    manufacturer = excluded.manufacturer,
    film_name = excluded.film_name,
    sq_ft_weight_lbs_per_sq_ft = excluded.sq_ft_weight_lbs_per_sq_ft,
    default_core_type = excluded.default_core_type,
    source_width_in = excluded.source_width_in,
    source_initial_feet = excluded.source_initial_feet,
    source_initial_weight_lbs = excluded.source_initial_weight_lbs,
    source_box_id = excluded.source_box_id,
    notes = excluded.notes,
    updated_at = excluded.updated_at
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

create or replace function app_api.process_linked_box_receipt(
  p_org_id uuid,
  p_box app.boxes,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_box app.boxes := p_box;
  v_link app.film_order_box_links;
  v_order app.film_orders;
  v_remaining_need integer;
  v_link_capacity integer;
  v_allocation_feet integer;
  v_job_context jsonb;
  v_warnings text[] := array[]::text[];
begin
  if v_box.received_date is null or v_box.status <> 'IN_STOCK' or v_box.feet_available <= 0 then
    return jsonb_build_object('box', to_jsonb(v_box), 'warnings', to_jsonb(v_warnings));
  end if;

  for v_link in
    select *
    from app.film_order_box_links l
    where l.org_id = p_org_id
      and l.box_id = v_box.box_id
    for update
  loop
    select *
    into v_order
    from app.film_orders f
    where f.org_id = p_org_id
      and f.film_order_id = v_link.film_order_id
    for update;

    if not found or v_order.status in ('CANCELLED', 'FULFILLED') then
      continue;
    end if;

    v_remaining_need := greatest(v_order.requested_feet - v_order.covered_feet, 0);
    v_link_capacity := greatest(v_link.ordered_feet - v_link.auto_allocated_feet, 0);
    v_allocation_feet := least(v_remaining_need, v_link_capacity, v_box.feet_available);

    if v_allocation_feet <= 0 then
      continue;
    end if;

    v_job_context := jsonb_build_object(
      'jobNumber', v_order.job_number,
      'jobDate', coalesce(to_char(v_order.job_date, 'YYYY-MM-DD'), ''),
      'crewLeader', coalesce(v_order.crew_leader, '')
    );
    perform app_api.create_allocation(
      p_org_id,
      v_box,
      v_job_context,
      v_allocation_feet,
      p_actor,
      v_order.film_order_id
    );

    v_box.feet_available := greatest(v_box.feet_available - v_allocation_feet, 0);
    v_link.auto_allocated_feet := v_link.auto_allocated_feet + v_allocation_feet;
    perform app_api.save_film_order_link(v_link);
    perform app_api.recalculate_film_order(p_org_id, v_order.film_order_id, p_actor);
    v_warnings := app_api.push_warning(
      v_warnings,
      format(
        '%s LF from %s was automatically allocated to job %s for Film Order %s.',
        v_allocation_feet,
        v_box.box_id,
        v_order.job_number,
        v_order.film_order_id
      )
    );
  end loop;

  return jsonb_build_object('box', to_jsonb(v_box), 'warnings', to_jsonb(v_warnings));
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

  v_build := app_api.build_box_from_payload(p_org_id, p_payload, null);
  v_box := jsonb_populate_record(null::app.boxes, v_build->'box');
  v_warnings := coalesce(array(select jsonb_array_elements_text(v_build->'warnings')), array[]::text[]);
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
  v_reached_zero boolean;
  v_move_to_zeroed boolean := coalesce((p_payload->>'moveToZeroed')::boolean, false);
  v_auto_zero boolean;
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

  if v_existing.status = 'ZEROED' then
    perform app_api.raise_http(400, 'Zeroed boxes cannot be edited directly. Use audit undo instead.');
  end if;

  v_build := app_api.build_box_from_payload(p_org_id, p_payload, v_existing.box_id);
  v_box := jsonb_populate_record(null::app.boxes, v_build->'box');
  v_warnings := coalesce(array(select jsonb_array_elements_text(v_build->'warnings')), array[]::text[]);
  v_reached_zero := v_box.received_date is not null and (v_box.feet_available = 0 or coalesce(v_box.last_roll_weight_lbs, 0) = 0);
  v_auto_zero := v_existing.received_date is not null and app_api.has_positive_physical_feet(v_existing) and v_reached_zero;

  if v_move_to_zeroed and not v_auto_zero then
    perform app_api.raise_http(
      400,
      'Received boxes move to zeroed out inventory only after they have had Available Feet above 0 and then reach 0 Available Feet or 0 Last Roll Weight.'
    );
  end if;

  if v_auto_zero then
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
    case when v_box.status = 'ZEROED' then 'ZERO_OUT_BOX' else 'UPDATE_BOX' end,
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
          'Fulfilled %s allocation%s totaling %s LF for job %s.',
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
  v_job_warehouse app.warehouse;
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
    v_job_warehouse := coalesce(
      nullif(upper(app_api.trim_text(p_payload->>'jobWarehouse')), '')::app.warehouse,
      v_source.warehouse
    );
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
immutable
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
  v_box.warehouse := (p_state->>'warehouse')::app.warehouse;
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

create or replace function public.api_audit_undo(
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
  v_audit app.audit_log;
  v_current app.boxes;
  v_restored app.boxes;
  v_log_id text;
  v_reason text := app_api.trim_text(p_payload->>'reason');
  v_notes text;
  v_warnings text[] := array[]::text[];
  v_checkout_job text;
  v_reactivated_count integer;
  v_cancelled_film_order_allocations integer;
begin
  perform app_api.require_org_member(p_org_id);

  select *
  into v_audit
  from app.audit_log a
  where a.org_id = p_org_id
    and a.log_id = app_api.require_text(p_payload->>'logId', 'LogID')
  for update;

  if not found then
    perform app_api.raise_http(404, 'Audit entry not found.');
  end if;

  select *
  into v_current
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = v_audit.box_id
  for update;

  v_notes := format('Undo %s%s', v_audit.action, case when v_reason <> '' then ': ' || v_reason else '' end);

  if v_audit.before_state is not null then
    v_restored := app_api.public_box_state_to_box_row(p_org_id, v_audit.before_state, v_current.id);
    v_restored := app_api.save_box(v_restored);

    if v_audit.action = 'SET_STATUS' and coalesce(v_audit.after_state->>'status', '') = 'CHECKED_OUT' then
      v_checkout_job := app_api.parse_checkout_job_from_note(v_audit.notes);
      if v_checkout_job <> '' then
        v_reactivated_count := app_api.reactivate_fulfilled_allocations_for_undo(
          p_org_id,
          v_audit.box_id,
          v_checkout_job
        );
        if v_reactivated_count > 0 then
          v_warnings := app_api.push_warning(
            v_warnings,
            format('%s allocation%s reactivated for job %s.', v_reactivated_count, case when v_reactivated_count = 1 then ' was' else 's were' end, v_checkout_job)
          );
        end if;
      end if;
    end if;

    if v_audit.action = 'ZERO_OUT_BOX' then
      v_reactivated_count := app_api.reactivate_cancelled_allocations_for_zero_undo(p_org_id, v_audit.box_id);
      if v_reactivated_count > 0 then
        v_warnings := app_api.push_warning(
          v_warnings,
          format('%s zero-cancelled allocation%s reactivated.', v_reactivated_count, case when v_reactivated_count = 1 then ' was' else 's were' end)
        );
      end if;
    end if;

    if coalesce(v_audit.after_state->>'receivedDate', '') <> '' and coalesce(v_audit.before_state->>'receivedDate', '') = '' then
      v_cancelled_film_order_allocations := app_api.cancel_active_film_order_allocations_for_box(
        p_org_id,
        v_audit.box_id,
        p_actor,
        'Cancelled because undo restored the box to its pre-receipt state.'
      );
      if v_cancelled_film_order_allocations > 0 then
        v_warnings := app_api.push_warning(
          v_warnings,
          format('%s auto-allocation%s cancelled because the linked box was reverted to pre-receipt.', v_cancelled_film_order_allocations, case when v_cancelled_film_order_allocations = 1 then ' was' else 's were' end)
        );
      end if;
    end if;

    perform app_api.recalculate_film_orders_for_box_links(p_org_id, v_audit.box_id, p_actor);
    v_log_id := app_api.append_audit_entry(
      p_org_id,
      'UNDO',
      v_audit.box_id,
      case when v_current.id is null then null else app_api.public_box_json(v_current) end,
      app_api.public_box_json(v_restored),
      p_actor,
      v_notes
    );

    return jsonb_build_object(
      'boxId', v_restored.box_id,
      'logId', v_log_id,
      'boxDeleted', false,
      'warnings', to_jsonb(v_warnings)
    );
  end if;

  if v_current.id is null then
    perform app_api.raise_http(400, 'Cannot undo add because the current box row is missing.');
  end if;

  perform app_api.delete_box(p_org_id, v_current.box_id);
  perform app_api.cancel_active_film_order_allocations_for_box(
    p_org_id,
    v_audit.box_id,
    p_actor,
    'Cancelled because the linked box was removed by undo.'
  );
  perform app_api.recalculate_film_orders_for_box_links(p_org_id, v_audit.box_id, p_actor);

  v_log_id := app_api.append_audit_entry(
    p_org_id,
    'UNDO_ADD_DELETE',
    v_audit.box_id,
    app_api.public_box_json(v_current),
    null,
    p_actor,
    v_notes
  );

  return jsonb_build_object(
    'boxId', v_current.box_id,
    'logId', v_log_id,
    'boxDeleted', true,
    'warnings', to_jsonb(v_warnings)
  );
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
  v_job.warehouse := app_api.require_warehouse(p_payload->>'warehouse', 'Warehouse');
  v_job.sections := app_api.normalize_job_sections(p_payload->>'sections');
  v_job.due_date := nullif(app_api.trim_text(p_payload->>'dueDate'), '')::date;
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
      nullif(upper(app_api.trim_text(p_payload->>'warehouse')), '')::app.warehouse,
      'IL'::app.warehouse
    );
    v_job.sections := null;
    v_job.due_date := null;
    v_job.lifecycle_status := 'ACTIVE';
    v_job.notes := '';
    v_job.created_at := v_now;
    v_job.created_by := app_api.trim_text(p_actor);
  end if;

  if p_payload ? 'warehouse' then
    v_job.warehouse := app_api.require_warehouse(p_payload->>'warehouse', 'Warehouse');
  end if;
  if p_payload ? 'sections' then
    v_job.sections := app_api.normalize_job_sections(p_payload->>'sections');
  end if;
  if p_payload ? 'dueDate' then
    v_job.due_date := nullif(app_api.trim_text(p_payload->>'dueDate'), '')::date;
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
  v_order.warehouse := app_api.require_warehouse(p_payload->>'warehouse', 'Warehouse');
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
begin
  perform app_api.require_org_member(p_org_id);

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
      v_box.feet_available := v_box.feet_available + coalesce((v_released_by_box->>v_box.box_id)::integer, 0);
      perform app_api.save_box(v_box);
    end if;
    v_affected_box_count := v_affected_box_count + 1;
  end loop;

  for v_order in
    select *
    from app.film_orders f
    where f.org_id = p_org_id
      and upper(f.job_number) = upper(v_job_number)
      and f.status <> 'CANCELLED'
    for update
  loop
    v_order.status := 'CANCELLED';
    v_order.resolved_at := now();
    v_order.resolved_by := app_api.trim_text(p_actor);
    v_order.notes := v_reason;
    perform app_api.save_film_order(v_order);
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
        'Cancelled job %s. Released %s active allocation%s across %s box%s.',
        v_job_number,
        v_released_count,
        case when v_released_count = 1 then '' else 's' end,
        v_affected_box_count,
        case when v_affected_box_count = 1 then '' else 'es' end
      )
    )
  );
end;
$$;

create or replace function public.api_film_orders_delete(
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
  v_film_order_id text := app_api.require_text(p_payload->>'filmOrderId', 'FilmOrderID');
  v_reason text := coalesce(nullif(app_api.trim_text(p_payload->>'reason'), ''), 'Film order deleted.');
  v_order app.film_orders;
  v_entry app.allocations;
  v_box app.boxes;
  v_released_by_box jsonb := '{}'::jsonb;
  v_released_count integer := 0;
  v_affected_box_count integer := 0;
begin
  perform app_api.require_org_member(p_org_id);

  select *
  into v_order
  from app.film_orders f
  where f.org_id = p_org_id
    and f.film_order_id = v_film_order_id
  for update;

  if not found then
    perform app_api.raise_http(404, 'Film Order not found.');
  end if;

  for v_entry in
    select *
    from app.allocations a
    where a.org_id = p_org_id
      and a.film_order_id = v_film_order_id
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
      v_box.feet_available := v_box.feet_available + coalesce((v_released_by_box->>v_box.box_id)::integer, 0);
      perform app_api.save_box(v_box);
    end if;
    v_affected_box_count := v_affected_box_count + 1;
  end loop;

  perform app_api.delete_film_order_links_by_film_order_id(p_org_id, v_film_order_id);
  perform app_api.delete_film_order(p_org_id, v_film_order_id);

  return jsonb_build_object(
    'filmOrder', jsonb_build_object(
      'filmOrderId', v_order.film_order_id,
      'jobNumber', v_order.job_number,
      'warehouse', v_order.warehouse::text,
      'manufacturer', v_order.manufacturer,
      'filmName', v_order.film_name,
      'widthIn', v_order.width_in,
      'requestedFeet', v_order.requested_feet,
      'coveredFeet', v_order.covered_feet,
      'orderedFeet', v_order.ordered_feet,
      'remainingToOrderFeet', v_order.remaining_to_order_feet,
      'jobDate', coalesce(to_char(v_order.job_date, 'YYYY-MM-DD'), ''),
      'crewLeader', coalesce(v_order.crew_leader, ''),
      'status', v_order.status::text,
      'sourceBoxId', coalesce(v_order.source_box_id, ''),
      'createdAt', coalesce(to_char(v_order.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''),
      'createdBy', coalesce(v_order.created_by, ''),
      'resolvedAt', coalesce(to_char(v_order.resolved_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''),
      'resolvedBy', coalesce(v_order.resolved_by, ''),
      'notes', coalesce(v_order.notes, ''),
      'linkedBoxes', '[]'::jsonb
    ),
    'warnings', jsonb_build_array(
      format(
        'Deleted film order %s. Released %s active allocation%s across %s box%s.',
        v_film_order_id,
        v_released_count,
        case when v_released_count = 1 then '' else 's' end,
        v_affected_box_count,
        case when v_affected_box_count = 1 then '' else 'es' end
      )
    )
  );
end;
$$;

grant execute on function public.api_jobs_create(uuid, text, jsonb) to authenticated;
grant execute on function public.api_jobs_update(uuid, text, jsonb) to authenticated;
grant execute on function public.api_film_orders_create(uuid, text, jsonb) to authenticated;
grant execute on function public.api_film_orders_cancel(uuid, text, jsonb) to authenticated;
grant execute on function public.api_film_orders_delete(uuid, text, jsonb) to authenticated;
grant execute on function public.api_boxes_add(uuid, text, jsonb) to authenticated;
grant execute on function public.api_boxes_update(uuid, text, jsonb) to authenticated;
grant execute on function public.api_boxes_set_status(uuid, text, jsonb) to authenticated;
grant execute on function public.api_allocations_apply(uuid, text, jsonb) to authenticated;
grant execute on function public.api_audit_undo(uuid, text, jsonb) to authenticated;
