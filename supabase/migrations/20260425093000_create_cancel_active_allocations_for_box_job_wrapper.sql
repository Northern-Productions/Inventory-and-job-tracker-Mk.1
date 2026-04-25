/**
 * PURPOSE:
 * Restores the app_api.cancel_active_allocations_for_box_job helper name used
 * by the current film check-in function body.
 *
 * AFFECTS:
 * Film box check-in, same-job allocation release, film order recalculation,
 * and public.api_boxes_set_status runtime behavior.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * app_api.cancel_active_allocations_for_box_job_checkin,
 * public.api_boxes_set_status, checkout/check-in migrations, backend canonical
 * migrations, and schema latest checks.
 *
 * COMMON FAILURE MODES:
 * Check-in fails with a missing helper, argument order releases the wrong
 * allocation set, or backend and Supabase migration tracks drift apart.
 */
create or replace function app_api.cancel_active_allocations_for_box_job(
  p_org_id uuid,
  p_box_id text,
  p_job_number text,
  p_actor text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  return app_api.cancel_active_allocations_for_box_job_checkin(
    p_org_id,
    p_actor,
    p_box_id,
    p_job_number,
    p_reason
  );
end;
$$;

comment on function app_api.cancel_active_allocations_for_box_job(
  uuid,
  text,
  text,
  text,
  text
) is 'Compatibility wrapper that forwards film check-in same-job allocation release to app_api.cancel_active_allocations_for_box_job_checkin.';
