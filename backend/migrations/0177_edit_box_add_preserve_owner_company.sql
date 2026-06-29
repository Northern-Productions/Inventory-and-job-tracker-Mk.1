do $$
declare
  v_base text;
  v_next text;
  v_owner_snippet text := 'v_box.owner_company_id := nullif(app_api.trim_text(p_payload->>''ownerCompanyId''), '''')::uuid;';
  v_require_snippet text := 'perform app_api.require_owner_company(p_org_id, v_box.owner_company_id, true);';
begin
  select pg_get_functiondef('public.api_boxes_add(uuid, text, jsonb)'::regprocedure)
  into v_base;

  v_base := replace(v_base, E'\r\n', E'\n');
  v_next := v_base;

  if position(v_owner_snippet in v_next) = 0 then
    v_next := replace(
      v_next,
      E'  v_box.dealer := app_api.trim_text(p_payload->>''dealer'');\n  v_box.direct_to_job_site := false;\n  v_warnings := coalesce',
      E'  v_box.dealer := app_api.trim_text(p_payload->>''dealer'');\n  v_box.direct_to_job_site := false;\n  v_box.owner_company_id := nullif(app_api.trim_text(p_payload->>''ownerCompanyId''), '''')::uuid;\n  perform app_api.require_owner_company(p_org_id, v_box.owner_company_id, true);\n  v_warnings := coalesce'
    );
  elsif position(v_require_snippet in v_next) = 0 then
    v_next := replace(
      v_next,
      v_owner_snippet,
      v_owner_snippet || E'\n  perform app_api.require_owner_company(p_org_id, v_box.owner_company_id, true);'
    );
  end if;

  if position(v_owner_snippet in v_next) = 0
     or position(v_require_snippet in v_next) = 0 then
    raise exception 'api_boxes_add owner_company_id requirement patch did not match expected snippets';
  end if;

  execute v_next;
end $$;
