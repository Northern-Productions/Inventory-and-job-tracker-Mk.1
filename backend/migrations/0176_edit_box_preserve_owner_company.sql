do $$
declare
  v_base text;
  v_next text;
  v_snippet text := 'v_box.owner_company_id := v_existing.owner_company_id;';
  v_occurrences integer;
begin
  select pg_get_functiondef('public.api_boxes_update(uuid, text, jsonb)'::regprocedure)
  into v_base;

  v_base := replace(v_base, E'\r\n', E'\n');
  v_next := v_base;

  if position(v_snippet in v_next) > 0 then
    return;
  end if;

  v_next := replace(
    v_next,
    E'  v_box.direct_to_job_site := coalesce(v_existing.direct_to_job_site, false);\n  v_warnings := coalesce',
    E'  v_box.direct_to_job_site := coalesce(v_existing.direct_to_job_site, false);\n  v_box.owner_company_id := v_existing.owner_company_id;\n  v_warnings := coalesce'
  );

  v_next := replace(
    v_next,
    E'    v_box.direct_to_job_site := coalesce(v_existing.direct_to_job_site, false);\n    v_warnings := array_cat',
    E'    v_box.direct_to_job_site := coalesce(v_existing.direct_to_job_site, false);\n    v_box.owner_company_id := v_existing.owner_company_id;\n    v_warnings := array_cat'
  );

  v_occurrences := (
    length(v_next) - length(replace(v_next, v_snippet, ''))
  ) / length(v_snippet);

  if v_occurrences < 2 then
    raise exception 'api_boxes_update owner_company_id preservation patch did not match expected snippets';
  end if;

  execute v_next;
end $$;
