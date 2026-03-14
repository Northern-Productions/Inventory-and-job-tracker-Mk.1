create or replace function app_api.ensure_default_warehouses_for_org(
  p_org_id uuid,
  p_actor text default 'system'
)
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  if p_org_id is null then
    return;
  end if;

  insert into app.warehouses (
    org_id,
    code,
    name,
    box_id_prefix,
    created_by,
    updated_by
  )
  values
    (p_org_id, 'IL', 'Wauconda Illinois', '', app_api.trim_text(p_actor), app_api.trim_text(p_actor)),
    (p_org_id, 'MS', 'Ridgeland Mississippi', 'M', app_api.trim_text(p_actor), app_api.trim_text(p_actor))
  on conflict (org_id, code) do update set
    name = excluded.name,
    box_id_prefix = excluded.box_id_prefix,
    updated_at = now(),
    updated_by = excluded.updated_by;
end;
$$;

do $$
declare
  v_org app.organizations;
begin
  for v_org in
    select *
    from app.organizations
  loop
    perform app_api.ensure_default_warehouses_for_org(v_org.id, 'migration-0018');
  end loop;
end;
$$;
