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
  v_job app.jobs;
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

  if v_order.job_id is not null then
    select *
    into v_job
    from app.jobs j
    where j.org_id = p_org_id
      and j.id = v_order.job_id
    limit 1;
  end if;

  v_order.job_date := v_job.due_date;
  v_order.crew_leader := coalesce(v_job.crew_leader, '');
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

update app.film_orders as fo
set
  job_date = coalesce(fo.job_date, j.due_date),
  crew_leader = case
    when app_api.trim_text(fo.crew_leader) = '' then app_api.trim_text(j.crew_leader)
    else fo.crew_leader
  end
from app.jobs as j
where fo.org_id = j.org_id
  and fo.status in ('FILM_ORDER', 'FILM_ON_THE_WAY')
  and (
    (fo.job_id is not null and fo.job_id = j.id)
    or (fo.job_id is null and upper(app_api.trim_text(fo.job_number)) = upper(app_api.trim_text(j.job_number)))
  )
  and (
    (fo.job_date is null and j.due_date is not null)
    or (app_api.trim_text(fo.crew_leader) = '' and app_api.trim_text(j.crew_leader) <> '')
  );
