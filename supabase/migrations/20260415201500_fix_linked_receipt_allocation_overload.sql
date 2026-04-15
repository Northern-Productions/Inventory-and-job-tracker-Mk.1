-- Avoid overloaded create_allocation ambiguity during linked box receipt processing.

create or replace function app_api.process_linked_box_receipt(
  p_org_id uuid,
  p_box app.boxes,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_box app.boxes := p_box;
  v_link app.film_order_box_links;
  v_order app.film_orders;
  v_remaining_need integer;
  v_link_capacity integer;
  v_allocation_feet integer;
  v_job_context jsonb;
  v_warnings text[] := array[]::text[];
begin
  if v_box.received_date is null or v_box.status <> 'IN_STOCK' or v_box.feet_available <= 0 then
    return jsonb_build_object('box', to_jsonb(v_box), 'warnings', to_jsonb(v_warnings));
  end if;

  for v_link in
    select *
    from app.film_order_box_links l
    where l.org_id = p_org_id
      and l.box_id = v_box.box_id
    for update
  loop
    select *
    into v_order
    from app.film_orders f
    where f.org_id = p_org_id
      and f.film_order_id = v_link.film_order_id
    for update;

    if not found or v_order.status in ('CANCELLED', 'FULFILLED') then
      continue;
    end if;

    v_remaining_need := greatest(v_order.requested_feet - v_order.covered_feet, 0);
    v_link_capacity := greatest(v_link.ordered_feet - v_link.auto_allocated_feet, 0);
    v_allocation_feet := least(v_remaining_need, v_link_capacity, v_box.feet_available);

    if v_allocation_feet <= 0 then
      continue;
    end if;

    v_job_context := jsonb_build_object(
      'jobNumber', v_order.job_number,
      'jobDate', coalesce(to_char(v_order.job_date, 'YYYY-MM-DD'), ''),
      'crewLeader', coalesce(v_order.crew_leader, '')
    );
    perform app_api.create_allocation(
      p_org_id,
      v_box,
      v_job_context,
      v_allocation_feet,
      p_actor,
      v_order.film_order_id,
      'REQUIREMENT',
      null
    );

    v_box.feet_available := greatest(v_box.feet_available - v_allocation_feet, 0);
    v_link.auto_allocated_feet := v_link.auto_allocated_feet + v_allocation_feet;
    perform app_api.save_film_order_link(v_link);
    perform app_api.recalculate_film_order(p_org_id, v_order.film_order_id, p_actor);
    v_warnings := app_api.push_warning(
      v_warnings,
      format(
        '%s LF from %s was automatically allocated to job %s for Film Order %s.',
        v_allocation_feet,
        v_box.box_id,
        v_order.job_number,
        v_order.film_order_id
      )
    );
  end loop;

  return jsonb_build_object('box', to_jsonb(v_box), 'warnings', to_jsonb(v_warnings));
end;
$$;
