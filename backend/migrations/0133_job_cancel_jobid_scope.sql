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
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_job_number text := app_api.require_text(v_payload->>'jobNumber', 'JobNumber');
  v_job_id_text text := app_api.trim_text(v_payload->>'jobId');
  v_job_id uuid;
  v_selected_job app.jobs;
  v_entry app.allocations;
  v_order app.film_orders;
  v_box app.boxes;
  v_released_by_box jsonb := '{}'::jsonb;
  v_released_count integer := 0;
  v_affected_box_count integer := 0;
  v_deleted_film_order_count integer := 0;
  v_response jsonb;
begin
  perform app_api.require_org_member(p_org_id);

  if v_job_id_text <> '' then
    if v_job_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      perform app_api.raise_http(400, 'jobId must be a valid UUID.');
    end if;

    v_job_id := v_job_id_text::uuid;

    select *
    into v_selected_job
    from app.jobs j
    where j.org_id = p_org_id
      and j.id = v_job_id
    for update;

    if not found then
      perform app_api.raise_http(404, format('Job %s was not found.', v_job_id_text));
    end if;

    if upper(v_selected_job.job_number) <> upper(v_job_number) then
      perform app_api.raise_http(
        409,
        format(
          'Job identity mismatch: jobId %s belongs to job %s, not %s.',
          v_job_id_text,
          v_selected_job.job_number,
          v_job_number
        )
      );
    end if;

    v_job_number := v_selected_job.job_number;
  end if;

  for v_entry in
    select *
    from app.allocations a
    where a.org_id = p_org_id
      and (
        (v_job_id is not null and a.job_id = v_selected_job.id)
        or (v_job_id is null and upper(a.job_number) = upper(v_job_number))
      )
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
    v_entry.notes := coalesce(nullif(app_api.trim_text(v_payload->>'reason'), ''), 'Job cancelled.');
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
      and (
        (v_job_id is not null and f.job_id = v_selected_job.id)
        or (v_job_id is null and upper(f.job_number) = upper(v_job_number))
      )
    for update
  loop
    perform app_api.delete_film_order_links_by_film_order_id(p_org_id, v_order.film_order_id);
    perform app_api.delete_film_order(p_org_id, v_order.film_order_id);
    v_deleted_film_order_count := v_deleted_film_order_count + 1;
  end loop;

  if v_job_id is not null then
    update app.jobs
    set lifecycle_status = 'CANCELLED',
        updated_at = now(),
        updated_by = app_api.trim_text(p_actor)
    where org_id = p_org_id
      and id = v_selected_job.id;
  else
    update app.jobs
    set lifecycle_status = 'CANCELLED',
        updated_at = now(),
        updated_by = app_api.trim_text(p_actor)
    where org_id = p_org_id
      and job_number = v_job_number;
  end if;

  v_response := jsonb_build_object(
    'jobNumber', v_job_number,
    'warnings', jsonb_build_array(
      format(
        'Cancelled job %s. Released %s active film allocation%s across %s box%s and deleted %s film order%s.',
        v_job_number,
        v_released_count,
        case when v_released_count = 1 then '' else 's' end,
        v_affected_box_count,
        case when v_affected_box_count = 1 then '' else 'es' end,
        v_deleted_film_order_count,
        case when v_deleted_film_order_count = 1 then '' else 's' end
      )
    )
  );

  if v_job_id is not null then
    v_response := v_response || jsonb_build_object('jobId', v_selected_job.id::text);
  end if;

  return v_response;
end;
$$;

create or replace function public.api_acl_film_orders_cancel(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_job_id_text text := app_api.trim_text(v_payload->>'jobId');
begin
  perform app_api.require_effective_feature_access(p_org_id, 'film_orders', 'write');
  if v_job_id_text <> '' then
    v_payload := jsonb_set(v_payload, '{jobId}', to_jsonb(v_job_id_text), true);
  end if;
  return public.api_film_orders_cancel(p_org_id, p_actor, v_payload);
end;
$$;
