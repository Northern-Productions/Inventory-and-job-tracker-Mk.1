-- Extend canonical manufacturer aliases so Fasara is normalized to 3M Fasara.

create or replace function app_api.canonical_manufacturer_label(p_value text)
returns text
language sql
immutable
as $$
  select
    case lower(app_api.normalize_collapsed_catalog_label(p_value))
      when '3m' then '3M Solar'
      when 'fasara' then '3M Fasara'
      when '3m fasara' then '3M Fasara'
      when 'avery' then 'Avery Dennison'
      when 'solar guard' then 'Solar Gard'
      else app_api.normalize_collapsed_catalog_label(p_value)
    end;
$$;
