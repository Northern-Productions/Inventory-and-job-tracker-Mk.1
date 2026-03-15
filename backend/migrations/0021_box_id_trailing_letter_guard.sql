-- Normalize trailing-letter BoxIDs (e.g., IL1-3194A -> IL1-3194)
-- and block future writes that reintroduce that format.

create or replace function app_api.normalize_box_id_trailing_letters(
  p_box_id text,
  p_field_name text default 'BoxID'
)
returns text
language plpgsql
immutable
set search_path = public, app, app_api
as $$
declare
  v_box_id text := upper(app_api.require_text(p_box_id, p_field_name));
begin
  if v_box_id ~ '^[A-Z]{2}[1-9][0-9]*-[0-9]+[A-Z]+$' then
    return regexp_replace(v_box_id, '^([A-Z]{2}[1-9][0-9]*-[0-9]+)[A-Z]+$', '\1');
  end if;
  return v_box_id;
end;
$$;

create or replace function app_api.resolve_box_id_alias(
  p_org_id uuid,
  p_box_id text,
  p_reference_time timestamptz default now()
)
returns text
language plpgsql
stable
security definer
set search_path = public, app, app_api
as $$
declare
  v_input text := app_api.normalize_box_id_trailing_letters(p_box_id, 'BoxID');
  v_resolved text;
begin
  if p_org_id is null then
    perform app_api.raise_http(400, 'Organization is required.');
  end if;

  select a.canonical_box_id
  into v_resolved
  from app.box_id_aliases a
  where a.org_id = p_org_id
    and a.old_box_id = v_input
    and a.expires_at >= coalesce(p_reference_time, now())
  order by a.expires_at desc
  limit 1;

  return coalesce(v_resolved, v_input);
end;
$$;

create or replace function public.api_acl_boxes_add(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_box_id text;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');
  v_box_id := app_api.normalize_box_id_trailing_letters(
    app_api.require_text(v_payload->>'boxId', 'BoxID'),
    'BoxID'
  );
  v_payload := jsonb_set(v_payload, '{boxId}', to_jsonb(v_box_id), true);
  return public.api_boxes_add(p_org_id, p_actor, v_payload);
end;
$$;

create or replace function import.canonical_box_id(
  target_org_id uuid,
  warehouse_code text,
  raw_box_id text
)
returns text
language plpgsql
security definer
set search_path = public, app, import, app_api
as $$
declare
  v_box_id text := upper(btrim(coalesce(raw_box_id, '')));
  v_warehouse text := upper(btrim(coalesce(warehouse_code, '')));
  v_prefix text := '';
begin
  if v_box_id = '' then
    raise exception 'BoxID is required';
  end if;

  if v_box_id like 'IL-%' then
    v_box_id := 'IL1-' || substr(v_box_id, 4);
  elsif v_box_id ~ '^M[0-9A-Z]+$' then
    v_box_id := 'MS1-' || substr(v_box_id, 2);
  end if;

  v_box_id := app_api.normalize_box_id_trailing_letters(v_box_id, 'BoxID');

  if v_box_id ~ '^[A-Z]{2}[1-9][0-9]*-.+' then
    return v_box_id;
  end if;

  if v_box_id ~ '^[A-Z0-9]{2,8}-.+' then
    return v_box_id;
  end if;

  if target_org_id is not null and v_warehouse <> '' then
    select coalesce(w.box_id_prefix, '')
    into v_prefix
    from app.warehouses w
    where w.org_id = target_org_id
      and w.code = v_warehouse
    limit 1;
  end if;

  if v_prefix <> '' then
    return app_api.normalize_box_id_trailing_letters(v_prefix || '-' || v_box_id, 'BoxID');
  end if;

  if v_warehouse = 'IL' then
    return app_api.normalize_box_id_trailing_letters('IL1-' || v_box_id, 'BoxID');
  end if;

  if v_warehouse = 'MS' then
    return app_api.normalize_box_id_trailing_letters('MS1-' || v_box_id, 'BoxID');
  end if;

  return v_box_id;
end;
$$;

alter table app.boxes
  drop constraint if exists boxes_no_trailing_letter_suffix;
alter table app.boxes
  add constraint boxes_no_trailing_letter_suffix check (
    box_id !~ '^[A-Z]{2}[1-9][0-9]*-[0-9]+[A-Z]+$'
  ) not valid;
