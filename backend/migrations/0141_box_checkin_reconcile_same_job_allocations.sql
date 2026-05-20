/**
 * PURPOSE:
 * Let physical-LF check-in reconciliation own same-job active allocations
 * instead of releasing them before the reconciliation priority pass.
 *
 * AFFECTS:
 * public.api_boxes_set_status check-in behavior.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * runtime boxes/statusTransitions.mjs, migration 0140, Edge /boxes/set-status
 * parity, and schema/latest checks.
 *
 * COMMON FAILURE MODES:
 * Reintroducing a pre-reconciliation same-job planning release causes positive
 * returned LF shortages to cancel the checkout job allocation instead of
 * reducing it to the returned physical LF.
 */

do $$
declare
  v_def text;
  v_base text;
  v_next text;
begin
  select pg_get_functiondef('public.api_boxes_set_status(uuid, text, jsonb)'::regprocedure)
  into v_def;

  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  v_next := replace(
    v_next,
    replace($old$
    if v_same_job_active_allocation_count > 0 and v_checkout_job <> '' then
      v_same_job_release := app_api.cancel_active_allocations_for_box_job(
        p_org_id,
        v_box.box_id,
        v_checkout_job,
        p_actor,
        'Released during film box check-in.',
        v_checkout_job_id
      );
      if coalesce((v_same_job_release->>'cancelledCount')::integer, 0) > 0 then
        v_warnings := app_api.push_warning(
          v_warnings,
          format(
            'Released %s active planning allocation%s totaling %s LF for job %s during check-in.',
            (v_same_job_release->>'cancelledCount')::integer,
            case when (v_same_job_release->>'cancelledCount')::integer = 1 then '' else 's' end,
            coalesce((v_same_job_release->>'cancelledFeet')::integer, 0),
            v_checkout_job
          )
        );
      end if;
    end if;

    v_reconciliation_result := app_api.reconcile_box_checkin_allocations(
$old$, E'\r\n', E'\n'),
    replace($new$
    v_reconciliation_result := app_api.reconcile_box_checkin_allocations(
$new$, E'\r\n', E'\n')
  );

  if v_next = v_base then
    raise exception 'api_boxes_set_status same-job check-in release patch did not match expected snippet';
  end if;

  execute v_next;
end $$;

do $$
declare
  v_def text;
begin
  select pg_get_functiondef('public.api_boxes_set_status(uuid, text, jsonb)'::regprocedure)
  into v_def;

  if position('Released %s active planning allocation%s totaling %s LF for job %s during check-in.' in v_def) > 0 then
    raise exception 'public.api_boxes_set_status still releases same-job active allocations before check-in reconciliation';
  end if;

  if position('v_reconciliation_result := app_api.reconcile_box_checkin_allocations' in v_def) = 0 then
    raise exception 'public.api_boxes_set_status missing check-in reconciliation call';
  end if;
end $$;
