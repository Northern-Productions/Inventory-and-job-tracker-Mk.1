with target_orgs as (
  select distinct c.org_id
  from app.film_catalog c
  where app_api.normalize_catalog_lookup_key(c.manufacturer) = app_api.normalize_catalog_lookup_key('SOLYX')

  union

  select distinct b.org_id
  from app.boxes b
  where app_api.normalize_catalog_lookup_key(b.manufacturer) = app_api.normalize_catalog_lookup_key('SOLYX')
)
insert into app.film_catalog (
  org_id,
  film_key,
  manufacturer,
  film_name,
  source_width_in,
  source_initial_feet,
  source_initial_weight_lbs,
  source_box_id,
  notes,
  updated_at
)
select
  target_orgs.org_id,
  upper('SOLYX') || '|' || upper('Frosted Stripes SXC-3511'),
  'SOLYX',
  'Frosted Stripes SXC-3511',
  null,
  null,
  null,
  null,
  'Added by migration to preserve the SOLYX Frosted Stripes SXC-3511 catalog suggestion as a distinct film key.',
  now()
from target_orgs
on conflict (org_id, film_key) do update
set
  manufacturer = excluded.manufacturer,
  film_name = excluded.film_name,
  notes = excluded.notes,
  updated_at = now();
