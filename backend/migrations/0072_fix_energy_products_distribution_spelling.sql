-- Keep backend and Supabase migration streams aligned for dealer spelling corrections.

create or replace function app_api.seed_default_box_dealers(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  if p_org_id is null then
    return;
  end if;

  insert into app.box_dealers (
    org_id,
    name,
    lookup_key
  )
  select
    p_org_id,
    defaults.name,
    app_api.normalize_catalog_lookup_key(defaults.name)
  from (
    values
      ('Eastman Performance Films'::text),
      ('Energy Products Distribution'::text),
      ('Accent'::text),
      ('Decorative Films'::text),
      ('Kingston Coatings'::text)
  ) as defaults(name)
  on conflict (org_id, lookup_key) do update set
    name = excluded.name,
    updated_at = timezone('utc', now());
end;
$$;

with corrected_rows as (
  insert into app.box_dealers (
    org_id,
    name,
    lookup_key
  )
  select
    d.org_id,
    'Energy Products Distribution'::text,
    app_api.normalize_catalog_lookup_key('Energy Products Distribution'::text)
  from app.box_dealers d
  where d.lookup_key = app_api.normalize_catalog_lookup_key('Energy products Distrubution'::text)
  on conflict (org_id, lookup_key) do update set
    name = excluded.name,
    updated_at = timezone('utc', now())
  returning org_id
)
delete from app.box_dealers d
where d.lookup_key = app_api.normalize_catalog_lookup_key('Energy products Distrubution'::text);

update app.boxes
set dealer = 'Energy Products Distribution'
where dealer = 'Energy products Distrubution';

