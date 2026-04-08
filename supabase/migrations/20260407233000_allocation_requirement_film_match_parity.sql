create or replace function app_api.extract_requirement_compact_base_code(
  p_compact_family text
)
returns text
language sql
immutable
as $$
  select coalesce(
    (regexp_match(coalesce(p_compact_family, ''), '^([a-z]{1,4}[0-9]{1,4})'))[1],
    ''
  );
$$;

create or replace function app_api.requirement_film_is_compatible(
  p_org_id uuid,
  p_candidate_manufacturer text,
  p_candidate_film_name text,
  p_requirement_manufacturer text,
  p_requirement_film_name text
)
returns boolean
language sql
stable
as $$
  with candidate as (
    select
      split_part(
        app_api.normalize_requirement_film_family_key(
          p_org_id,
          p_candidate_manufacturer,
          p_candidate_film_name
        ),
        '|',
        1
      ) as manufacturer_key,
      split_part(
        app_api.normalize_requirement_film_family_key(
          p_org_id,
          p_candidate_manufacturer,
          p_candidate_film_name
        ),
        '|',
        2
      ) as compact_family,
      app_api.extract_requirement_compact_base_code(
        split_part(
          app_api.normalize_requirement_film_family_key(
            p_org_id,
            p_candidate_manufacturer,
            p_candidate_film_name
          ),
          '|',
          2
        )
      ) as compact_base_code,
      app_api.requirement_film_is_exterior(
        p_org_id,
        p_candidate_manufacturer,
        p_candidate_film_name
      ) as is_exterior
  ),
  requirement as (
    select
      split_part(
        app_api.normalize_requirement_film_family_key(
          p_org_id,
          p_requirement_manufacturer,
          p_requirement_film_name
        ),
        '|',
        1
      ) as manufacturer_key,
      split_part(
        app_api.normalize_requirement_film_family_key(
          p_org_id,
          p_requirement_manufacturer,
          p_requirement_film_name
        ),
        '|',
        2
      ) as compact_family,
      app_api.extract_requirement_compact_base_code(
        split_part(
          app_api.normalize_requirement_film_family_key(
            p_org_id,
            p_requirement_manufacturer,
            p_requirement_film_name
          ),
          '|',
          2
        )
      ) as compact_base_code,
      app_api.requirement_film_is_exterior(
        p_org_id,
        p_requirement_manufacturer,
        p_requirement_film_name
      ) as is_exterior
  )
  select
    candidate.manufacturer_key = requirement.manufacturer_key
    and (
      candidate.compact_family = requirement.compact_family
      or (
        requirement.compact_base_code <> ''
        and requirement.compact_family = requirement.compact_base_code
        and candidate.compact_base_code = requirement.compact_base_code
        and candidate.compact_family like requirement.compact_family || '%'
        and length(candidate.compact_family) > length(requirement.compact_family)
      )
    )
    and (
      not requirement.is_exterior
      or candidate.is_exterior
    )
  from candidate, requirement;
$$;
