-- Preserve the descriptive Security/Madico Safetyshield Optivision labels as
-- their own catalog entries and stop collapsing them through stale aliases.

with target_film_names(film_name) as (
  values
    ('Madico Safetyshield 800 Optivision 15'),
    ('Madico Safetyshield 800 Optivision 25')
),
target_pairs as (
  select distinct a.org_id, t.film_name
  from app.film_name_aliases a
  join target_film_names t
    on a.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(t.film_name)
  where a.manufacturer_lookup_key = app_api.normalize_catalog_lookup_key('Security')

  union

  select distinct c.org_id, t.film_name
  from app.film_catalog c
  join target_film_names t
    on app_api.normalize_catalog_lookup_key(c.film_name) = app_api.normalize_catalog_lookup_key(t.film_name)
  where app_api.normalize_catalog_lookup_key(c.manufacturer) = app_api.normalize_catalog_lookup_key('Security')
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
  target_pairs.org_id,
  upper('Security') || '|' || upper(target_pairs.film_name),
  'Security',
  target_pairs.film_name,
  null,
  null,
  null,
  null,
  'Added by migration to preserve the descriptive Security/Madico Safetyshield 800 Optivision label as a distinct suggestion.',
  now()
from target_pairs
on conflict (org_id, film_key) do update
set
  manufacturer = excluded.manufacturer,
  film_name = excluded.film_name,
  updated_at = now();

with target_film_names(film_name) as (
  values
    ('Madico Safetyshield 800 Optivision 15'),
    ('Madico Safetyshield 800 Optivision 25')
)
delete from app.film_name_aliases a
using target_film_names t
where a.manufacturer_lookup_key = app_api.normalize_catalog_lookup_key('Security')
  and a.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(t.film_name)
  and app_api.normalize_catalog_lookup_key(a.canonical_film_name)
    = app_api.normalize_catalog_lookup_key('Madico Safetyshield 800');
