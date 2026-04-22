-- Restore post-save linked film-order recalculation for receipt flows that were
-- overwritten by later ordered-box receive and dealer-support migrations.

do $migration$
declare
  v_definition text;
  v_old_snippet text := $snippet$
    if v_box.received_date is not null and v_box.status = 'IN_STOCK' then
      v_receipt_result := app_api.process_linked_box_receipt(p_org_id, v_box, p_actor);
      v_box := jsonb_populate_record(null::app.boxes, v_receipt_result->'box');
      v_box := app_api.save_box(v_box);
      v_warnings := array_cat(
$snippet$;
  v_new_snippet text := $snippet$
    if v_box.received_date is not null and v_box.status = 'IN_STOCK' then
      v_receipt_result := app_api.process_linked_box_receipt(p_org_id, v_box, p_actor);
      v_box := jsonb_populate_record(null::app.boxes, v_receipt_result->'box');
      v_box := app_api.save_box(v_box);
      perform app_api.recalculate_film_orders_for_box_links(p_org_id, v_box.box_id, p_actor);
      v_warnings := array_cat(
$snippet$;
begin
  select pg_get_functiondef(to_regprocedure('public.api_boxes_add(uuid, text, jsonb)'))
  into v_definition;

  if v_definition is null then
    raise exception 'public.api_boxes_add(uuid, text, jsonb) was not found.';
  end if;

  v_definition := replace(v_definition, E'\r\n', E'\n');

  if position(v_new_snippet in v_definition) > 0 then
    return;
  end if;

  if position(v_old_snippet in v_definition) = 0 then
    raise exception 'Could not locate the expected linked-receipt save_box snippet inside public.api_boxes_add(uuid, text, jsonb).';
  end if;

  execute replace(v_definition, v_old_snippet, v_new_snippet);
end;
$migration$;

do $migration$
declare
  v_definition text;
  v_old_snippet text := $snippet$
  v_box := app_api.save_box(v_box);
  v_public_before := app_api.public_box_json(v_existing);
$snippet$;
  v_new_snippet text := $snippet$
  v_box := app_api.save_box(v_box);
  if v_box.status <> 'CHECKED_OUT' then
    perform app_api.recalculate_film_orders_for_box_links(p_org_id, v_box.box_id, p_actor);
  end if;
  v_public_before := app_api.public_box_json(v_existing);
$snippet$;
begin
  select pg_get_functiondef(to_regprocedure('public.api_boxes_update(uuid, text, jsonb)'))
  into v_definition;

  if v_definition is null then
    raise exception 'public.api_boxes_update(uuid, text, jsonb) was not found.';
  end if;

  v_definition := replace(v_definition, E'\r\n', E'\n');

  if position(v_new_snippet in v_definition) > 0 then
    return;
  end if;

  if position(v_old_snippet in v_definition) = 0 then
    raise exception 'Could not locate the expected save_box snippet inside public.api_boxes_update(uuid, text, jsonb).';
  end if;

  execute replace(v_definition, v_old_snippet, v_new_snippet);
end;
$migration$;

do $migration$
declare
  v_definition text;
  v_old_snippet text := $snippet$
  v_box := app_api.save_box(v_box);

  v_audit_note := format('Received ordered box %s', v_lookup_box_id);
$snippet$;
  v_new_snippet text := $snippet$
  v_box := app_api.save_box(v_box);
  perform app_api.recalculate_film_orders_for_box_links(p_org_id, v_box.box_id, p_actor);

  v_audit_note := format('Received ordered box %s', v_lookup_box_id);
$snippet$;
begin
  select pg_get_functiondef(to_regprocedure('public.api_acl_boxes_receive_ordered(uuid, text, jsonb)'))
  into v_definition;

  if v_definition is null then
    raise exception 'public.api_acl_boxes_receive_ordered(uuid, text, jsonb) was not found.';
  end if;

  v_definition := replace(v_definition, E'\r\n', E'\n');

  if position(v_new_snippet in v_definition) > 0 then
    return;
  end if;

  if position(v_old_snippet in v_definition) = 0 then
    raise exception 'Could not locate the expected save_box snippet inside public.api_acl_boxes_receive_ordered(uuid, text, jsonb).';
  end if;

  execute replace(v_definition, v_old_snippet, v_new_snippet);
end;
$migration$;

do $$
declare
  v_candidate record;
  v_actor text := 'migration: restore linked receipt post-save recalc';
begin
  for v_candidate in
    select distinct fo.org_id, fo.film_order_id
    from app.film_orders fo
    join app.film_order_box_links l
      on l.org_id = fo.org_id
     and l.film_order_id = fo.film_order_id
    where fo.status <> 'CANCELLED'
  loop
    perform app_api.recalculate_film_order(
      v_candidate.org_id,
      v_candidate.film_order_id,
      v_actor
    );
  end loop;
end;
$$;
