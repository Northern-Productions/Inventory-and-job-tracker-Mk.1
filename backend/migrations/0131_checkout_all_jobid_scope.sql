/*
 * PURPOSE:
 * Make checkout-all film allocation resolution jobId-preferred on canonical
 * paths while preserving legacy jobNumber-only checkout-all behavior.
 *
 * AFFECTS:
 * app_api.resolve_allocations_for_checkout, public.api_boxes_set_status, and
 * a no-audit checkout-all resolve helper used by Edge for same-job boxes.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * backend checkoutAllJobMaterials, Edge executeCheckoutAllJobMaterials,
 * frontend checkout-all cache behavior, and planner ownership tests.
 *
 * COMMON FAILURE MODES:
 * Resolving same-number allocations for a different job, adding audit entries
 * for resolve-only checkout-all rows, or skipping planner after direct
 * allocation resolution.
 */

create or replace function app_api.resolve_allocations_for_checkout(
  p_org_id uuid,
  p_box_id text,
  p_job_number text,
  p_actor text,
  p_job_id uuid
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
  v_checkout_note text := format('Checked out for job %s.', app_api.trim_text(p_job_number));
  v_is_selected_job boolean := false;
begin
  for v_entry in
    select *
    from app.allocations a
    where a.org_id = p_org_id
      and a.box_id = app_api.trim_text(p_box_id)
      and a.status = 'ACTIVE'
    for update
  loop
    v_is_selected_job := case
      when p_job_id is not null then v_entry.job_id = p_job_id
      else upper(v_entry.job_number) = upper(app_api.trim_text(p_job_number))
    end;

    if v_is_selected_job then
      if v_entry.resolved_at is null then
        v_entry.resolved_at := now();
      end if;

      if coalesce(v_entry.resolved_by, '') = '' then
        v_entry.resolved_by := app_api.trim_text(p_actor);
      end if;

      if coalesce(v_entry.notes, '') <> v_checkout_note then
        v_entry.notes := v_checkout_note;
      end if;

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

  if position('app_api.resolve_allocations_for_checkout(p_org_id, v_box.box_id, v_checkout_job, p_actor, v_checkout_job_id)' in v_base) > 0 then
    return;
  end if;

  v_next := replace(
    v_next,
    'v_resolution := app_api.resolve_allocations_for_checkout(p_org_id, v_box.box_id, v_checkout_job, p_actor);',
    'v_resolution := app_api.resolve_allocations_for_checkout(p_org_id, v_box.box_id, v_checkout_job, p_actor, v_checkout_job_id);'
  );

  if v_next = v_base
     or position('app_api.resolve_allocations_for_checkout(p_org_id, v_box.box_id, v_checkout_job, p_actor, v_checkout_job_id)' in v_next) = 0 then
    raise exception 'public.api_boxes_set_status checkout jobId resolver patch did not match expected snippet';
  end if;

  execute v_next;
end;
$$;

create or replace function public.api_acl_boxes_resolve_checkout_allocations(
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
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_lookup_box_id text;
  v_existing app.boxes;
  v_selected_job app.jobs;
  v_payload_job_id_text text := app_api.trim_text(v_payload->>'jobId');
  v_payload_job_number text := app_api.trim_text(v_payload->>'jobNumber');
  v_job_id uuid := null;
  v_job_number text := '';
  v_result jsonb;
  v_scope jsonb;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');
  v_lookup_box_id := app_api.resolve_box_id_alias(
    p_org_id,
    app_api.require_text(v_payload->>'boxId', 'BoxID')
  );

  select *
  into v_existing
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = v_lookup_box_id
  for update;

  if not found then
    perform app_api.raise_http(404, 'Box not found.');
  end if;

  if upper(coalesce(v_existing.status::text, '')) <> 'CHECKED_OUT' then
    perform app_api.raise_http(400, format('Box %s is not checked out.', v_lookup_box_id));
  end if;

  if v_payload_job_id_text <> '' then
    if v_payload_job_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      perform app_api.raise_http(400, 'jobId must be a valid UUID.');
    end if;

    v_job_id := v_payload_job_id_text::uuid;

    select *
    into v_selected_job
    from app.jobs j
    where j.org_id = p_org_id
      and j.id = v_job_id;

    if not found then
      perform app_api.raise_http(404, format('Job %s was not found.', v_payload_job_id_text));
    end if;

    if v_payload_job_number <> '' and upper(trim(v_payload_job_number)) <> upper(trim(v_selected_job.job_number)) then
      perform app_api.raise_http(400, 'jobId does not match jobNumber.');
    end if;

    v_job_number := v_selected_job.job_number;

    if v_existing.last_checkout_job_id is not null and v_existing.last_checkout_job_id <> v_job_id then
      perform app_api.raise_http(400, 'Box is checked out on a different job.');
    end if;
  else
    v_job_number := app_api.require_text(v_payload->>'jobNumber', 'JobNumber');
  end if;

  if upper(coalesce(v_existing.last_checkout_job, '')) <> upper(trim(v_job_number)) then
    perform app_api.raise_http(400, 'Box is checked out on a different job.');
  end if;

  v_result := app_api.resolve_allocations_for_checkout(
    p_org_id,
    v_lookup_box_id,
    v_job_number,
    p_actor,
    v_job_id
  );

  v_scope := jsonb_build_object(
    'boxIds', jsonb_build_array(v_lookup_box_id),
    'jobNumbers', jsonb_build_array(v_job_number)
  );
  if v_job_id is not null then
    v_scope := v_scope || jsonb_build_object('jobIds', jsonb_build_array(v_job_id::text));
  end if;

  perform app_api.reconcile_auto_planned_allocations(
    p_org_id,
    p_actor,
    v_scope
  );

  if v_job_id is not null then
    v_result := v_result || jsonb_build_object(
      'jobId', v_job_id::text,
      'jobNumber', v_job_number
    );
  end if;

  return v_result;
end;
$$;

select app_api.grant_execute_if_exists('public.api_acl_boxes_resolve_checkout_allocations(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_boxes_resolve_checkout_allocations(uuid, text, jsonb)', 'service_role');
