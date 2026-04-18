-- Recalculate linked film orders after the checked-in box has been saved.

do $migration$
declare
  v_definition text;
  v_old_snippet text := $snippet$
  v_box := app_api.save_box(v_box);
  v_public_after := app_api.public_box_json(v_box);
$snippet$;
  v_new_snippet text := $snippet$
  v_box := app_api.save_box(v_box);
  if v_box.status <> 'CHECKED_OUT' then
    perform app_api.recalculate_film_orders_for_box_links(p_org_id, v_box.box_id, p_actor);
  end if;
  v_public_after := app_api.public_box_json(v_box);
$snippet$;
begin
  select pg_get_functiondef(to_regprocedure('public.api_boxes_set_status(uuid, text, jsonb)'))
  into v_definition;

  if v_definition is null then
    raise exception 'public.api_boxes_set_status(uuid, text, jsonb) was not found.';
  end if;

  if position(v_new_snippet in v_definition) > 0 then
    return;
  end if;

  if position(v_old_snippet in v_definition) = 0 then
    raise exception 'Could not locate the expected save_box snippet inside public.api_boxes_set_status(uuid, text, jsonb).';
  end if;

  execute replace(v_definition, v_old_snippet, v_new_snippet);
end;
$migration$;

do $$
declare
  v_candidate record;
  v_actor text := 'migration: linked receipt post-save recalc';
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
