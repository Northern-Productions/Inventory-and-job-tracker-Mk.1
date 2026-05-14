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
  v_requirement_id_text text := app_api.trim_text(p_payload->>'requirementId');
  v_requirement_id uuid := null;
  v_requirement app.job_requirements;
  v_requirement_job_number text := '';
  v_order app.film_orders;
  v_job app.jobs;
  v_job_id_text text := app_api.trim_text(p_payload->>'jobId');
  v_has_job_id boolean := v_job_id_text <> '';
  v_job_id uuid := null;
  v_payload_job_number text := app_api.require_text(p_payload->>'jobNumber', 'JobNumber');
begin
  perform app_api.require_org_member(p_org_id);

  if v_width_in is null or v_width_in <= 0 then
    perform app_api.raise_http(400, 'WidthIn must be greater than zero.');
  end if;

  if v_requested_feet is null or v_requested_feet <= 0 then
    perform app_api.raise_http(400, 'RequestedFeet must be greater than zero.');
  end if;

  if v_has_job_id then
    begin
      v_job_id := v_job_id_text::uuid;
    exception when others then
      perform app_api.raise_http(400, 'jobId must be a valid UUID.');
    end;

    select *
    into v_job
    from app.jobs j
    where j.org_id = p_org_id
      and j.id = v_job_id
    for update;

    if not found then
      perform app_api.raise_http(404, 'Job was not found.');
    end if;

    if upper(trim(v_job.job_number)) <> upper(trim(v_payload_job_number)) then
      perform app_api.raise_http(400, 'Job identity mismatch: selected job does not match jobNumber.');
    end if;

    if coalesce(v_job.lifecycle_status::text, 'ACTIVE') <> 'ACTIVE' then
      perform app_api.raise_http(400, format('Job %s is closed and cannot receive film orders.', v_job.job_number));
    end if;

    if v_requirement_id_text = '' then
      perform app_api.raise_http(400, 'RequirementID is required when jobId is supplied.');
    end if;
  end if;

  if v_requirement_id_text <> '' then
    begin
      v_requirement_id := v_requirement_id_text::uuid;
    exception when invalid_text_representation then
      perform app_api.raise_http(400, 'RequirementID must be a valid UUID.');
    end;
  end if;

  v_order.id := gen_random_uuid();
  v_order.org_id := p_org_id;
  v_order.film_order_id := app_api.create_log_id();
  v_order.job_id := case
    when v_has_job_id then v_job.id
    else app_api.get_or_resolve_job_id(p_org_id, v_payload_job_number)
  end;
  v_order.job_number := case
    when v_has_job_id then v_job.job_number
    else v_payload_job_number
  end;
  v_order.warehouse := app_api.require_org_warehouse(p_org_id, p_payload->>'warehouse', 'Warehouse');
  v_order.manufacturer := app_api.require_text(p_payload->>'manufacturer', 'Manufacturer');
  v_order.film_name := app_api.require_text(p_payload->>'filmName', 'FilmName');
  v_order.width_in := v_width_in;
  v_order.requested_feet := v_requested_feet;
  v_order.covered_feet := 0;
  v_order.ordered_feet := 0;
  v_order.remaining_to_order_feet := v_requested_feet;
  v_order.requirement_id := v_requirement_id;

  if not v_has_job_id and v_order.job_id is not null then
    select *
    into v_job
    from app.jobs j
    where j.org_id = p_org_id
      and j.id = v_order.job_id
    limit 1;
  end if;

  if v_requirement_id is not null then
    select *
    into v_requirement
    from app.job_requirements r
    where r.org_id = p_org_id
      and r.id = v_requirement_id;

    if not found then
      perform app_api.raise_http(404, 'Job requirement was not found.');
    end if;

    if v_has_job_id then
      if v_requirement.job_id is distinct from v_order.job_id then
        perform app_api.raise_http(400, 'RequirementID must belong to the selected job.');
      end if;
    else
      select coalesce(j.job_number, '')
      into v_requirement_job_number
      from app.jobs j
      where j.org_id = p_org_id
        and j.id = v_requirement.job_id;

      if upper(trim(coalesce(v_requirement_job_number, ''))) <> upper(trim(v_order.job_number)) then
        perform app_api.raise_http(400, 'RequirementID must belong to the same job as the film order.');
      end if;
    end if;

    if not app_api.film_order_matches_requirement(
      p_org_id,
      v_requirement_id,
      v_order.manufacturer,
      v_order.film_name,
      v_order.width_in,
      v_requirement.id,
      v_requirement.manufacturer,
      v_requirement.film_name,
      v_requirement.width_in
    ) then
      perform app_api.raise_http(400, 'Film order product and width must match the selected requirement.');
    end if;
  end if;

  if exists (
    select 1
    from app.film_orders fo
    where fo.org_id = p_org_id
      and case
        when v_has_job_id then fo.job_id = v_order.job_id
        else upper(trim(fo.job_number)) = upper(trim(v_order.job_number))
      end
      and coalesce(fo.status::text, '') in ('FILM_ORDER', 'FILM_ON_THE_WAY')
      and app_api.film_order_matches_requirement(
        p_org_id,
        fo.requirement_id,
        fo.manufacturer,
        fo.film_name,
        fo.width_in,
        v_order.requirement_id,
        v_order.manufacturer,
        v_order.film_name,
        v_order.width_in
      )
  ) then
    perform app_api.raise_http(
      409,
      format(
        'Film order for %s %s %s already covers job %s. Cancel it before creating another order.',
        v_order.manufacturer,
        v_order.film_name,
        v_order.width_in,
        v_order.job_number
      )
    );
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
