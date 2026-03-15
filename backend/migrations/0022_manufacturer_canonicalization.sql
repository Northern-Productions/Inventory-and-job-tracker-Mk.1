-- Canonicalize legacy manufacturer aliases in lookup-key paths.
-- This keeps requirement matching stable even when legacy labels are submitted.

create or replace function app_api.canonical_manufacturer_label(p_value text)
returns text
language sql
immutable
as $$
  select
    case lower(app_api.normalize_collapsed_catalog_label(p_value))
      when '3m' then '3M Solar'
      when 'avery' then 'Avery Dennison'
      when 'solar guard' then 'Solar Gard'
      else app_api.normalize_collapsed_catalog_label(p_value)
    end;
$$;

create or replace function app_api.normalize_catalog_manufacturer_lookup_key(p_value text)
returns text
language sql
immutable
as $$
  select lower(app_api.canonical_manufacturer_label(p_value));
$$;

create or replace function app_api.normalize_job_requirement_lookup_key(
  p_manufacturer text,
  p_film_name text,
  p_width_in numeric
)
returns text
language sql
immutable
as $$
  select app_api.normalize_catalog_manufacturer_lookup_key(p_manufacturer)
    || '|' || app_api.normalize_catalog_lookup_key(p_film_name)
    || '|' || round(coalesce(p_width_in, 0)::numeric, 4)::text;
$$;

create or replace function app_api.requirement_rows_from_payload(p_requirements jsonb)
returns table (
  manufacturer text,
  film_name text,
  width_in numeric,
  required_feet integer
)
language plpgsql
stable
as $$
declare
  v_value jsonb;
  v_width_in numeric;
  v_required_feet integer;
begin
  if p_requirements is not null and jsonb_typeof(p_requirements) = 'array' then
    for v_value in
      select value
      from jsonb_array_elements(p_requirements)
    loop
      perform app_api.require_text(v_value->>'manufacturer', 'Requirements[].Manufacturer');
      perform app_api.require_text(v_value->>'filmName', 'Requirements[].FilmName');
      v_width_in := nullif(app_api.trim_text(v_value->>'widthIn'), '')::numeric;
      v_required_feet := floor(nullif(app_api.trim_text(v_value->>'requiredFeet'), '')::numeric);

      if v_width_in is null or v_width_in <= 0 then
        perform app_api.raise_http(400, 'Requirements[].WidthIn must be greater than zero.');
      end if;

      if v_required_feet is null or v_required_feet <= 0 then
        perform app_api.raise_http(400, 'Requirements[].RequiredFeet must be greater than zero.');
      end if;
    end loop;
  end if;

  return query
  with normalized as (
    select
      app_api.canonical_manufacturer_label(value->>'manufacturer') as manufacturer,
      app_api.normalize_collapsed_catalog_label(value->>'filmName') as film_name,
      (nullif(app_api.trim_text(value->>'widthIn'), '')::numeric) as width_in,
      floor(nullif(app_api.trim_text(value->>'requiredFeet'), '')::numeric)::integer as required_feet
    from jsonb_array_elements(
      case
        when p_requirements is null or jsonb_typeof(p_requirements) <> 'array' then '[]'::jsonb
        else p_requirements
      end
    )
  )
  select
    n.manufacturer,
    n.film_name,
    n.width_in,
    sum(n.required_feet)::integer as required_feet
  from normalized n
  group by n.manufacturer, n.film_name, n.width_in
  order by lower(n.manufacturer), lower(n.film_name), n.width_in;
end;
$$;
