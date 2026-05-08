do $$
declare
  v_def text;
  v_base text;
  v_next text;
begin
  select pg_get_functiondef('public.api_acl_boxes_receive_ordered(uuid, text, jsonb)'::regprocedure)
  into v_def;

  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  if position('v_core_type text := '''';' in v_base) > 0
    and position('v_core_type := app_api.normalize_core_type(v_payload->>''coreType'', true);' in v_base) > 0
    and position('v_box.core_type := v_core_type;' in v_base) > 0
  then
    return;
  end if;

  v_next := replace(
    v_next,
    replace($old$
  v_lot_run text := app_api.trim_text(v_payload->>'lotRun');
  v_locked_allocated_feet integer := 0;
$old$, E'\r\n', E'\n'),
    replace($new$
  v_lot_run text := app_api.trim_text(v_payload->>'lotRun');
  v_core_type text := '';
  v_locked_allocated_feet integer := 0;
$new$, E'\r\n', E'\n')
  );

  v_next := replace(
    v_next,
    replace($old$
  if v_lot_run = '' then
    v_lot_run := coalesce(v_existing.lot_run, '');
  end if;

  v_locked_allocated_feet := app_api.physical_film_commitment_feet_for_box(p_org_id, v_lookup_box_id);
$old$, E'\r\n', E'\n'),
    replace($new$
  if v_lot_run = '' then
    v_lot_run := coalesce(v_existing.lot_run, '');
  end if;

  v_core_type := app_api.normalize_core_type(v_payload->>'coreType', true);

  v_locked_allocated_feet := app_api.physical_film_commitment_feet_for_box(p_org_id, v_lookup_box_id);
$new$, E'\r\n', E'\n')
  );

  v_next := replace(
    v_next,
    replace($old$
  v_box.lot_run := v_lot_run;

  if v_received_weight_lbs is not null then
$old$, E'\r\n', E'\n'),
    replace($new$
  v_box.lot_run := v_lot_run;

  if v_core_type <> '' then
    v_box.core_type := v_core_type;
    v_box.core_weight_lbs := app_api.derive_core_weight_lbs(v_core_type, v_box.width_in);
  end if;

  if v_received_weight_lbs is not null then
$new$, E'\r\n', E'\n')
  );

  if v_next = v_base then
    raise exception 'api_acl_boxes_receive_ordered core type patch did not match expected snippets';
  end if;

  if position('v_core_type text := '''';' in v_next) = 0
    or position('v_core_type := app_api.normalize_core_type(v_payload->>''coreType'', true);' in v_next) = 0
    or position('v_box.core_weight_lbs := app_api.derive_core_weight_lbs(v_core_type, v_box.width_in);' in v_next) = 0
  then
    raise exception 'api_acl_boxes_receive_ordered core type patch produced an incomplete function definition';
  end if;

  execute v_next;
end;
$$;

select app_api.grant_execute_if_exists('public.api_acl_boxes_receive_ordered(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_boxes_receive_ordered(uuid, text, jsonb)', 'service_role');
