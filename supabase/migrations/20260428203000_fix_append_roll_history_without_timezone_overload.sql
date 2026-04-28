/**
 * PURPOSE:
 * Reasserts both append_roll_history overloads with explicit-column inserts so
 * check-in cannot hit a stale timestamp overload that casts a composite row.
 *
 * AFFECTS:
 * Film box check-in, returned roll weight logging, direct-to-job-site returns,
 * and public.api_boxes_set_status / public.api_acl_boxes_set_status.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * app.roll_weight_log columns, public.api_boxes_set_status overload
 * resolution, Supabase Edge /boxes/set-status RPC facade, and schema latest
 * checks for both timestamp overloads.
 *
 * COMMON FAILURE MODES:
 * One overload is safe while another still uses a composite row cast,
 * timezone('utc', now()) selects the timestamp-without-time-zone overload, or
 * created_at is omitted from roll history writes.
 */
create or replace function app_api.append_roll_history(
  p_org_id uuid,
  p_box_id text,
  p_warehouse text,
  p_manufacturer text,
  p_film_name text,
  p_width_in numeric,
  p_job_number text,
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

comment on function app_api.append_roll_history(
  uuid,
  text,
  text,
  text,
  text,
  numeric,
  text,
  text,
  text,
  numeric,
  timestamp with time zone,
  text,
  numeric,
  numeric,
  integer,
  integer,
  text
) is 'Compatibility wrapper that writes roll history with explicit columns for film box check-in.';

comment on function app_api.append_roll_history(
  uuid,
  text,
  text,
  text,
  text,
  numeric,
  text,
  text,
  text,
  numeric,
  timestamp without time zone,
  text,
  numeric,
  numeric,
  integer,
  integer,
  text
) is 'Compatibility wrapper that writes roll history with explicit columns for film box check-in.';
