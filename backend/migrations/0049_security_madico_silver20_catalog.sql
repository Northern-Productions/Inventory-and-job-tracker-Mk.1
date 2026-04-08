-- Preserve the descriptive Security/Madico Safetyshield Silver 20 label as its
-- own catalog entry and stop collapsing it through a legacy alias.

delete from app.film_name_aliases
where manufacturer_lookup_key = app_api.normalize_catalog_lookup_key('Security')
  and old_film_name_lookup_key = app_api.normalize_catalog_lookup_key('Madico Safetyshield 800 Silver 20')
  and app_api.normalize_catalog_lookup_key(canonical_film_name)
    = app_api.normalize_catalog_lookup_key('Madico Safetyshield 800');

with target_orgs as (
  select distinct b.org_id
  from app.boxes b
  where app_api.normalize_catalog_lookup_key(b.manufacturer) = app_api.normalize_catalog_lookup_key('Security')
    and (
      coalesce(b.notes, '') ilike '%Madico Safetyshield 800 Silver 20%'
      or app_api.normalize_catalog_lookup_key(b.film_name)
        = app_api.normalize_catalog_lookup_key('Madico Safetyshield 800')
    )

  union

  select distinct c.org_id
  from app.film_catalog c
  where app_api.normalize_catalog_lookup_key(c.manufacturer) = app_api.normalize_catalog_lookup_key('Security')
    and app_api.normalize_catalog_lookup_key(c.film_name)
      = app_api.normalize_catalog_lookup_key('Madico Safetyshield 800')

  union

  select distinct a.org_id
  from app.film_name_aliases a
  where a.manufacturer_lookup_key = app_api.normalize_catalog_lookup_key('Security')
    and a.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key('Madico Safetyshield 800 Silver 20')
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
  upper('Security') || '|' || upper('Madico Safetyshield 800 Silver 20'),
  'Security',
  'Madico Safetyshield 800 Silver 20',
  null,
  null,
  null,
  null,
  'Added by migration to preserve the descriptive Security/Madico Safetyshield 800 Silver 20 label as a distinct suggestion.',
  now()
from target_orgs
on conflict (org_id, film_key) do update
set
  manufacturer = excluded.manufacturer,
  film_name = excluded.film_name,
  updated_at = now();
