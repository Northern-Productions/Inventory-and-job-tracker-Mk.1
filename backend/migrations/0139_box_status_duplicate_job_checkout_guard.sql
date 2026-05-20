/**
 * PURPOSE:
 * Guard box checkout/check-in status transitions for duplicate job numbers by
 * requiring canonical jobId identity whenever a job number maps to multiple
 * jobs, and by releasing same-job check-in allocations by jobId when available.
 *
 * AFFECTS:
 * public.api_boxes_set_status, app_api.cancel_active_allocations_for_box_job,
 * box detail checkout, film box check-in, and duplicate job-number readiness.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * frontend box detail checkout options, backend statusTransitions.mjs,
 * runtimeBoxCheckin.mjs, Supabase Edge /boxes/set-status facade, and
 * schema/latest checks.
 *
 * COMMON FAILURE MODES:
 * A legacy jobNumber-only checkout silently selects a same-number duplicate
 * job, or check-in releases active allocations for a different Work Scope that
 * shares the checked-out job number.
 */

create or replace function app_api.cancel_active_allocations_for_box_job(
  p_org_id uuid,
  p_box_id text,
  p_job_number text,
  p_actor text,
  p_reason text,
  p_job_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_entry app.allocations;
  v_reason text := coalesce(
    nullif(app_api.trim_text(p_reason), ''),
    format('Returned to stock during check-in for job %s.', app_api.trim_text(p_job_number))
  );
  v_cancelled_count integer := 0;
  v_cancelled_feet integer := 0;
  v_affected_film_order_ids text[] := array[]::text[];
  v_film_order_id text;
begin
  if p_job_id is null and app_api.trim_text(p_job_number) = '' then
    return jsonb_build_object(
      'cancelledCount', 0,
      'cancelledFeet', 0
    );
  end if;

  for v_entry in
    select *
    from app.allocations a
    where a.org_id = p_org_id
      and a.box_id = app_api.trim_text(p_box_id)
      and a.status = 'ACTIVE'
      and (
        (p_job_id is not null and a.job_id = p_job_id)
        or (
          p_job_id is null
          and upper(coalesce(a.job_number, '')) = upper(app_api.trim_text(p_job_number))
        )
      )
    for update
  loop
    v_entry.status := 'CANCELLED';
    v_entry.resolved_at := now();
    v_entry.resolved_by := app_api.trim_text(p_actor);
    v_entry.notes := v_reason;
    perform app_api.save_allocation(v_entry);

    if coalesce(v_entry.film_order_id, '') <> ''
      and not (v_entry.film_order_id = any(v_affected_film_order_ids)) then
      v_affected_film_order_ids := array_append(v_affected_film_order_ids, v_entry.film_order_id);
    end if;

    v_cancelled_count := v_cancelled_count + 1;
    v_cancelled_feet := v_cancelled_feet + coalesce(v_entry.allocated_feet, 0);
  end loop;

  foreach v_film_order_id in array v_affected_film_order_ids
  loop
    perform app_api.recalculate_film_order(p_org_id, v_film_order_id, p_actor);
  end loop;

  return jsonb_build_object(
    'cancelledCount', v_cancelled_count,
    'cancelledFeet', v_cancelled_feet
  );
end;
$$;

comment on function app_api.cancel_active_allocations_for_box_job(
  uuid,
  text,
  text,
  text,
  text,
  uuid
) is 'Film check-in same-job allocation release scoped by jobId when available, with legacy jobNumber fallback.';

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

  if position('v_legacy_checkout_job_match_count integer := 0;' in v_base) = 0 then
    v_next := replace(
      v_next,
      '  v_receipt_result jsonb := jsonb_build_object(''warnings'', ''[]''::jsonb);',
      replace('  v_receipt_result jsonb := jsonb_build_object(''warnings'', ''[]''::jsonb);
  v_legacy_checkout_job_match_count integer := 0;', E'\r\n', E'\n')
    );
  end if;

  if position('Job number %s matches multiple jobs. Choose a Work Scope to continue.' in v_next) = 0 then
    v_next := replace(
      v_next,
      replace('    if v_checkout_job = '''' then
      perform app_api.raise_http(400, ''A checkout job number is required.'');
    end if;

    v_box.status := ''CHECKED_OUT'';', E'\r\n', E'\n'),
      replace('    if v_checkout_job = '''' then
      perform app_api.raise_http(400, ''A checkout job number is required.'');
    end if;

    if v_checkout_job_id is null then
      select count(*)::integer
      into v_legacy_checkout_job_match_count
      from app.jobs j
      where j.org_id = p_org_id
        and upper(trim(j.job_number)) = upper(trim(v_checkout_job));

      if v_legacy_checkout_job_match_count > 1 then
        perform app_api.raise_http(
          409,
          format(''Job number %s matches multiple jobs. Choose a Work Scope to continue.'', v_checkout_job)
        );
      end if;
    end if;

    v_box.status := ''CHECKED_OUT'';', E'\r\n', E'\n')
    );
  end if;

  v_next := replace(
    v_next,
    replace('        and a.status = ''ACTIVE''
        and upper(coalesce(a.job_number, '''')) = upper(v_checkout_job);',
      E'\r\n',
      E'\n'
    ),
    replace('        and a.status = ''ACTIVE''
        and (
          (v_checkout_job_id is not null and a.job_id = v_checkout_job_id)
          or (
            v_checkout_job_id is null
            and upper(coalesce(a.job_number, '''')) = upper(v_checkout_job)
          )
        );', E'\r\n', E'\n')
  );

  v_next := replace(
    v_next,
    replace('        and a.status = ''ACTIVE''
        and upper(coalesce(a.job_number, '''')) <> upper(v_checkout_job);',
      E'\r\n',
      E'\n'
    ),
    replace('        and a.status = ''ACTIVE''
        and not (
          (v_checkout_job_id is not null and a.job_id = v_checkout_job_id)
          or (
            v_checkout_job_id is null
            and upper(coalesce(a.job_number, '''')) = upper(v_checkout_job)
          )
        );', E'\r\n', E'\n')
  );

  v_next := replace(
    v_next,
    replace('      v_same_job_release := app_api.cancel_active_allocations_for_box_job(
        p_org_id,
        v_box.box_id,
        v_checkout_job,
        p_actor,
        ''Released during film box check-in.''
      );', E'\r\n', E'\n'),
    replace('      v_same_job_release := app_api.cancel_active_allocations_for_box_job(
        p_org_id,
        v_box.box_id,
        v_checkout_job,
        p_actor,
        ''Released during film box check-in.'',
        v_checkout_job_id
      );', E'\r\n', E'\n')
  );

  if v_next = v_base
     and position('v_legacy_checkout_job_match_count integer := 0;' in v_next) > 0
     and position('Job number %s matches multiple jobs. Choose a Work Scope to continue.' in v_next) > 0
     and position('v_checkout_job_id is not null and a.job_id = v_checkout_job_id' in v_next) > 0
     and position('v_checkout_job_id is null' in v_next) > 0
     and position(replace('''Released during film box check-in.'',
        v_checkout_job_id', E'\r\n', E'\n') in v_next) > 0 then
    return;
  end if;

  if v_next = v_base
     or position('v_legacy_checkout_job_match_count integer := 0;' in v_next) = 0
     or position('Job number %s matches multiple jobs. Choose a Work Scope to continue.' in v_next) = 0
     or position('v_checkout_job_id is not null and a.job_id = v_checkout_job_id' in v_next) = 0
     or position('v_checkout_job_id is null' in v_next) = 0
     or position(replace('''Released during film box check-in.'',
        v_checkout_job_id', E'\r\n', E'\n') in v_next) = 0 then
    raise exception 'public.api_boxes_set_status duplicate checkout guard patch did not match expected snippets';
  end if;

  execute v_next;
end;
$$;
