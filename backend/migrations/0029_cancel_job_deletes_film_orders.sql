-- Ensure cancelled jobs do not retain lingering film orders.
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
        'Cancelled job %s. Released %s active allocation%s across %s box%s and deleted %s film order%s.',
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
end;
$$;
