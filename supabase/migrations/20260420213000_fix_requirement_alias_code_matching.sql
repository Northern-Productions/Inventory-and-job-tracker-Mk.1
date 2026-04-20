/**
 * PURPOSE:
 * Keep allocation requirement matching resilient to catalog aliases that append trailing code
 * shorthands like "(PR40 Ext)" after the human-readable film label.
 *
 * AFFECTS:
 * /allocations/preview parity with /allocations/apply, requirement-bound allocation validation,
 * extra allocation compatibility checks, and any SQL workflow that derives requirement film
 * families or exterior status from canonicalized film names.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * shared/domain/jobPlanningFilmMatcher.mjs, backend/scripts/verify-allocation-film-match-parity.mjs,
 * backend/scripts/verify-ordered-box-allocation-flow.mjs, and backend/scripts/check-schema-latest.mjs.
 *
 * COMMON FAILURE MODES:
 * Preview/apply drift, exterior rolls rejected for base requirements, non-exterior rolls accepted
 * for exterior requirements, or alias-heavy 3M Solar labels resolving to mismatched film families.
 */

create or replace function app_api.strip_requirement_match_trailing_code_alias(
  p_value text
)
returns text
language plpgsql
immutable
as $$
declare
  v_current text := app_api.normalize_collapsed_catalog_label(p_value);
  v_match text[];
  v_base text;
  v_alias text;
  v_alias_compact text;
  v_base_digits text;
begin
  while v_current <> '' loop
    v_match := regexp_match(v_current, '^(.*?)(?:\s*\(([^()]*)\))$');
    if v_match is null then
      return v_current;
    end if;

    v_base := app_api.normalize_collapsed_catalog_label(v_match[1]);
    v_alias := app_api.normalize_collapsed_catalog_label(v_match[2]);
    v_alias_compact := app_api.normalize_requirement_match_compact_lookup_key(v_alias);
    v_base_digits := regexp_replace(v_base, '[^0-9]+', '', 'g');
    v_base_digits := regexp_replace(v_base_digits, '^0+', '');

    if v_base = ''
      or v_alias_compact = ''
      or v_alias_compact !~ '[a-z]'
      or v_alias_compact !~ '[0-9]'
      or v_base_digits = ''
      or position(v_base_digits in v_alias_compact) = 0 then
      return v_current;
    end if;

    v_current := v_base;
  end loop;

  return '';
end;
$$;

create or replace function app_api.normalize_requirement_match_surface_film_name(
  p_org_id uuid,
  p_manufacturer text,
  p_film_name text
)
returns text
language plpgsql
stable
as $$
declare
  v_manufacturer text := app_api.normalize_requirement_match_manufacturer_label(p_manufacturer);
  v_manufacturer_key text := app_api.normalize_requirement_match_manufacturer_lookup_key(p_manufacturer);
  v_film_name text;
  v_night_vision_code text := '';
begin
  v_film_name := app_api.normalize_collapsed_catalog_label(
    app_api.resolve_canonical_film_name(p_org_id, v_manufacturer, p_film_name)
  );

  if v_film_name = '' then
    return '';
  end if;

  v_film_name := app_api.normalize_requirement_match_descriptor_tokens(
    app_api.strip_requirement_match_manufacturer_prefixes(v_manufacturer, v_film_name)
  );

  v_film_name := app_api.normalize_requirement_avery_natura_shade_film_name(
    v_manufacturer,
    v_film_name
  );

  if v_manufacturer_key = app_api.normalize_requirement_match_manufacturer_lookup_key('3M Solar') then
    v_night_vision_code := app_api.infer_requirement_night_vision_code(v_film_name);
    if v_night_vision_code <> '' then
      v_film_name := format('Night Vision %s', v_night_vision_code);
    end if;
  end if;

  v_film_name := app_api.strip_requirement_match_trailing_code_alias(v_film_name);

  return v_film_name;
end;
$$;

create or replace function app_api.normalize_requirement_film_family_name(
  p_org_id uuid,
  p_manufacturer text,
  p_film_name text
)
returns text
language plpgsql
stable
as $$
declare
  v_film_name text := app_api.normalize_requirement_match_surface_film_name(
    p_org_id,
    p_manufacturer,
    p_film_name
  );
begin
  if v_film_name = '' then
    return '';
  end if;

  if v_film_name ~* '(^|[[:space:]])Exterior[[:space:]]*$' then
    v_film_name := coalesce(
      nullif(
        app_api.normalize_collapsed_catalog_label(
          regexp_replace(v_film_name, '[[:space:]]+Exterior[[:space:]]*$', '', 'i')
        ),
        ''
      ),
      v_film_name
    );
  end if;

  return v_film_name;
end;
$$;

create or replace function app_api.requirement_film_is_exterior(
  p_org_id uuid,
  p_manufacturer text,
  p_film_name text
)
returns boolean
language sql
stable
as $$
  select app_api.trim_text(
      app_api.normalize_requirement_match_surface_film_name(
        p_org_id,
        p_manufacturer,
        p_film_name
      )
    ) ~* '(^|[[:space:]])Exterior[[:space:]]*$';
$$;
