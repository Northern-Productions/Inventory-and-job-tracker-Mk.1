create or replace function public.api_film_orders_delete(
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
  v_film_order_id text := app_api.require_text(p_payload->>'filmOrderId', 'FilmOrderID');
  v_reason text := coalesce(nullif(app_api.trim_text(p_payload->>'reason'), ''), 'Film order deleted.');
  v_order app.film_orders;
  v_entry app.allocations;
  v_box app.boxes;
  v_released_by_box jsonb := '{}'::jsonb;
  v_released_count integer := 0;
  v_affected_box_count integer := 0;
  v_link_count integer := 0;
  v_downstream_allocation_count integer := 0;
begin
  perform app_api.require_org_member(p_org_id);

  select *
  into v_order
  from app.film_orders f
  where f.org_id = p_org_id
    and f.film_order_id = v_film_order_id
  for update;

  if not found then
    perform app_api.raise_http(404, 'Film Order not found.');
  end if;

  if coalesce(v_order.status::text, '') <> 'FILM_ORDER' then
    perform app_api.raise_http(400, 'Only open pending film orders can be cancelled.');
  end if;

  if nullif(app_api.trim_text(v_order.source_box_id), '') is not null then
    perform app_api.raise_http(400, 'Automated shortage film orders cannot be cancelled from this action.');
  end if;

  if coalesce(v_order.covered_feet, 0) > 0 or coalesce(v_order.ordered_feet, 0) > 0 then
    perform app_api.raise_http(400, 'Film orders with fulfillment activity cannot be cancelled.');
  end if;

  select count(*)::integer
  into v_link_count
  from app.film_order_box_links l
  where l.org_id = p_org_id
    and l.film_order_id = v_film_order_id;

  if v_link_count > 0 then
    perform app_api.raise_http(400, 'Film orders with linked ordered boxes cannot be cancelled.');
  end if;

  select count(*)::integer
  into v_downstream_allocation_count
  from app.allocations a
  where a.org_id = p_org_id
    and a.film_order_id = v_film_order_id
    and a.status <> 'CANCELLED';

  if v_downstream_allocation_count > 0 then
    perform app_api.raise_http(400, 'Film orders with fulfillment allocations cannot be cancelled.');
  end if;

  for v_entry in
    select *
    from app.allocations a
    where a.org_id = p_org_id
      and a.film_order_id = v_film_order_id
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

  perform app_api.delete_film_order_links_by_film_order_id(p_org_id, v_film_order_id);
  perform app_api.delete_film_order(p_org_id, v_film_order_id);

  return jsonb_build_object(
    'filmOrder', jsonb_build_object(
      'filmOrderId', v_order.film_order_id,
      'jobNumber', v_order.job_number,
      'warehouse', v_order.warehouse::text,
      'manufacturer', v_order.manufacturer,
      'filmName', v_order.film_name,
      'widthIn', v_order.width_in,
      'requestedFeet', v_order.requested_feet,
      'coveredFeet', v_order.covered_feet,
      'orderedFeet', v_order.ordered_feet,
      'remainingToOrderFeet', v_order.remaining_to_order_feet,
      'jobDate', coalesce(to_char(v_order.job_date, 'YYYY-MM-DD'), ''),
      'crewLeader', coalesce(v_order.crew_leader, ''),
      'status', v_order.status::text,
      'sourceBoxId', coalesce(v_order.source_box_id, ''),
      'createdAt', coalesce(to_char(v_order.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''),
      'createdBy', coalesce(v_order.created_by, ''),
      'resolvedAt', coalesce(to_char(v_order.resolved_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''),
      'resolvedBy', coalesce(v_order.resolved_by, ''),
      'notes', coalesce(v_order.notes, ''),
      'linkedBoxes', '[]'::jsonb
    ),
    'warnings', jsonb_build_array(
      format(
        'Deleted film order %s. Released %s active allocation%s across %s box%s.',
        v_film_order_id,
        v_released_count,
        case when v_released_count = 1 then '' else 's' end,
        v_affected_box_count,
        case when v_affected_box_count = 1 then '' else 'es' end
      )
    )
  );
end;
$$;
