create or replace function public.api_boxes_delete(
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
  v_box app.boxes;
  v_active_allocation_count integer := 0;
  v_link_count integer := 0;
  v_log_id text;
  v_reason text := coalesce(nullif(app_api.trim_text(p_payload->>'reason'), ''), 'Deleted from box details.');
begin
  perform app_api.require_org_member(p_org_id);

  select *
  into v_box
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = app_api.require_text(p_payload->>'boxId', 'BoxID')
  for update;

  if not found then
    perform app_api.raise_http(404, 'Box not found.');
  end if;

  if v_box.status = 'CHECKED_OUT' then
    perform app_api.raise_http(400, 'Checked-out boxes cannot be deleted. Check the box in or zero it out first.');
  end if;

  select count(*)
  into v_active_allocation_count
  from app.allocations a
  where a.org_id = p_org_id
    and a.box_id = v_box.box_id
    and a.status = 'ACTIVE';

  if v_active_allocation_count > 0 then
    perform app_api.raise_http(400, 'Boxes with active allocations cannot be deleted. Resolve the allocations first.');
  end if;

  select count(*)
  into v_link_count
  from app.film_order_box_links l
  where l.org_id = p_org_id
    and l.box_id = v_box.box_id;

  if v_link_count > 0 then
    perform app_api.raise_http(400, 'Boxes linked to film orders cannot be deleted. Resolve the linked film order first.');
  end if;

  perform app_api.delete_box(p_org_id, v_box.box_id);
  v_log_id := app_api.append_audit_entry(
    p_org_id,
    'DELETE_BOX',
    v_box.box_id,
    app_api.public_box_json(v_box),
    null,
    p_actor,
    v_reason
  );

  return jsonb_build_object(
    'boxId', v_box.box_id,
    'logId', v_log_id,
    'warnings', '[]'::jsonb
  );
end;
$$;

grant execute on function public.api_boxes_delete(uuid, text, jsonb) to service_role;
