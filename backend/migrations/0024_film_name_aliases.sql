-- Film-name canonical alias storage + ACL read helper.
-- Supports write-time canonicalization without forcing clients to submit only canonical labels.

create table if not exists app.film_name_aliases (
  org_id uuid not null references app.organizations(id) on delete cascade,
  manufacturer_lookup_key text not null,
  old_film_name_lookup_key text not null,
  canonical_film_name text not null,
  created_at timestamptz not null default now(),
  created_by text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text not null default '',
  primary key (org_id, manufacturer_lookup_key, old_film_name_lookup_key)
);

alter table app.film_name_aliases
  drop constraint if exists film_name_aliases_lookup_keys_not_blank;
alter table app.film_name_aliases
  add constraint film_name_aliases_lookup_keys_not_blank check (
    manufacturer_lookup_key = lower(btrim(manufacturer_lookup_key))
    and old_film_name_lookup_key = lower(btrim(old_film_name_lookup_key))
    and btrim(manufacturer_lookup_key) <> ''
    and btrim(old_film_name_lookup_key) <> ''
  );

alter table app.film_name_aliases
  drop constraint if exists film_name_aliases_canonical_not_blank;
alter table app.film_name_aliases
  add constraint film_name_aliases_canonical_not_blank check (
    app_api.normalize_catalog_lookup_key(canonical_film_name) <> ''
    and app_api.normalize_catalog_lookup_key(canonical_film_name) <> old_film_name_lookup_key
  );

create index if not exists idx_film_name_aliases_org_manufacturer
  on app.film_name_aliases (org_id, manufacturer_lookup_key);

create index if not exists idx_film_name_aliases_org_canonical
  on app.film_name_aliases (org_id, manufacturer_lookup_key, lower(canonical_film_name));

create or replace function app_api.resolve_canonical_film_name(
  p_org_id uuid,
  p_manufacturer text,
  p_film_name text
)
returns text
language plpgsql
stable
security definer
set search_path = public, app, app_api
as $$
declare
  v_manufacturer_lookup_key text := app_api.normalize_catalog_manufacturer_lookup_key(p_manufacturer);
  v_film_name_lookup_key text := app_api.normalize_catalog_lookup_key(p_film_name);
  v_canonical text;
begin
  select a.canonical_film_name
  into v_canonical
  from app.film_name_aliases a
  where a.org_id = p_org_id
    and a.manufacturer_lookup_key = v_manufacturer_lookup_key
    and a.old_film_name_lookup_key = v_film_name_lookup_key
  limit 1;

  if v_canonical is not null then
    return app_api.normalize_collapsed_catalog_label(v_canonical);
  end if;

  return app_api.normalize_collapsed_catalog_label(p_film_name);
end;
$$;

create or replace function public.api_acl_list_film_name_aliases(p_org_id uuid)
returns table (
  manufacturer_lookup_key text,
  old_film_name_lookup_key text,
  canonical_film_name text
)
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'read');

  return query
  select
    a.manufacturer_lookup_key,
    a.old_film_name_lookup_key,
    a.canonical_film_name
  from app.film_name_aliases a
  where a.org_id = p_org_id
  order by a.manufacturer_lookup_key, a.old_film_name_lookup_key;
end;
$$;

select app_api.grant_execute_if_exists('public.api_acl_list_film_name_aliases(uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_film_name_aliases(uuid)', 'service_role');
