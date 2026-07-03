do $$
declare
  v_base text;
  v_next text;
  v_declare_snippet text := '  v_warnings text[] := array[]::text[];';
  v_capture_anchor text := '  v_film_order_id := app_api.trim_text(v_allocation.film_order_id);';
  v_capture_snippet text := '  v_preserved_physical_feet := app_api.box_physical_feet_available(v_box);';
  v_old_recalc text := '  perform app_api.recalculate_physical_box_allocatable_now(p_org_id, v_box.box_id);';
  v_new_recalc text := '  perform app_api.recalculate_physical_box_allocatable_now(p_org_id, v_box.box_id, v_preserved_physical_feet);';
begin
  select pg_get_functiondef('public.api_allocations_remove_box(uuid, text, jsonb)'::regprocedure)
  into v_base;

  v_base := replace(v_base, E'\r\n', E'\n');
  v_next := v_base;

  if position('v_preserved_physical_feet integer := null;' in v_next) = 0 then
    v_next := replace(
      v_next,
      v_declare_snippet,
      v_declare_snippet || E'\n  v_preserved_physical_feet integer := null;'
    );
  end if;

  if position(v_capture_snippet in v_next) = 0 then
    v_next := replace(
      v_next,
      v_capture_anchor,
      v_capture_anchor || E'\n  ' || v_capture_snippet
    );
  end if;

  if position(v_new_recalc in v_next) = 0 then
    v_next := replace(v_next, v_old_recalc, v_new_recalc);
  end if;

  if position('v_preserved_physical_feet integer := null;' in v_next) = 0
     or position(v_capture_snippet in v_next) = 0
     or position(v_new_recalc in v_next) = 0 then
    raise exception 'api_allocations_remove_box physical LF preservation patch did not match expected snippets';
  end if;

  execute v_next;
end $$;

comment on function public.api_allocations_remove_box(uuid, text, jsonb)
  is 'Atomically removes a job allocation while preserving physical LF and recalculating allocatable capacity from remaining claims.';
