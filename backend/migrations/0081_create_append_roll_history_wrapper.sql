/**
 * PURPOSE:
 * Restores the app_api.append_roll_history helper expected by the current
 * box check-in function body.
 *
 * AFFECTS:
 * Film box check-in, roll history logging, direct-to-job-site returns, and
 * any migration/runtime path that calls public.api_boxes_set_status.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * app_api.append_roll_history_entry, public.api_boxes_set_status, roll history
 * table shape, Supabase mirrored migrations, and schema latest checks.
 *
 * COMMON FAILURE MODES:
 * Check-in fails at runtime with a missing helper, roll history rows miss
 * checkout context, or backend and Supabase migration tracks drift apart.
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
begin
  return app_api.append_roll_history_entry(
    p_org_id,
    row(
      gen_random_uuid(),
      p_org_id,
      app_api.create_log_id(),
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
      app_api.trim_text(p_notes)
    )::app.roll_weight_log
  );
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
) is 'Compatibility wrapper that writes roll history through app_api.append_roll_history_entry for film box check-in.';
