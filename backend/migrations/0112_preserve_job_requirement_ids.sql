/**
 * PURPOSE:
 * Preserve stable job requirement IDs during job edits so existing film
 * allocations remain bound to their requirements after metadata-only saves.
 *
 * AFFECTS:
 * POST /jobs/update, POST /jobs/create duplicate updates, Edge RPC parity, job
 * requirement coverage, Checkout All staging validation, and READY/FILM_ORDER
 * status derivation.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * runtimeJobsMutations/buildRequirementRowsForReplace, Supabase Edge
 * api-handler coverage fallback, frontend optimistic jobRequirementCoverage,
 * and job film-order regression tests.
 */

create or replace function app_api.requirement_rows_from_payload_with_ids(p_requirements jsonb)
returns table (
  requirement_id uuid,
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
  v_requirement_id uuid;
begin
  if p_requirements is not null and jsonb_typeof(p_requirements) = 'array' then
    for v_value in
      select value
      from jsonb_array_elements(p_requirements)
    loop
      perform app_api.require_text(v_value->>'manufacturer', 'Requirements[].Manufacturer');
      perform app_api.require_text(v_value->>'filmName', 'Requirements[].FilmName');
      v_requirement_id := nullif(app_api.trim_text(v_value->>'requirementId'), '')::uuid;
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
  with source as (
    select value, ordinality
    from jsonb_array_elements(
      case
        when p_requirements is null or jsonb_typeof(p_requirements) <> 'array' then '[]'::jsonb
        else p_requirements
      end
    ) with ordinality
  ),
  normalized as (
    select
      nullif(app_api.trim_text(value->>'requirementId'), '')::uuid as requirement_id,
      app_api.canonical_manufacturer_label(value->>'manufacturer') as manufacturer,
      app_api.normalize_collapsed_catalog_label(value->>'filmName') as film_name,
      (nullif(app_api.trim_text(value->>'widthIn'), '')::numeric) as width_in,
      floor(nullif(app_api.trim_text(value->>'requiredFeet'), '')::numeric)::integer as required_feet,
      ordinality
    from source
  )
  select
    (array_agg(n.requirement_id order by n.ordinality) filter (where n.requirement_id is not null))[1] as requirement_id,
    n.manufacturer,
    n.film_name,
    n.width_in,
    sum(n.required_feet)::integer as required_feet
  from normalized n
  group by n.manufacturer, n.film_name, n.width_in
  order by lower(n.manufacturer), lower(n.film_name), n.width_in;
end;
$$;

create or replace function app_api.replace_job_requirements(
  p_org_id uuid,
  p_job app.jobs,
  p_requirements jsonb,
  p_actor text,
  p_now timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_requirement record;
  v_existing app.job_requirements;
  v_next_id uuid;
  v_retained_ids uuid[] := array[]::uuid[];
begin
  for v_requirement in
    select *
    from app_api.requirement_rows_from_payload_with_ids(p_requirements)
  loop
    v_existing := null;

    if v_requirement.requirement_id is not null then
      select *
      into v_existing
      from app.job_requirements r
      where r.org_id = p_org_id
        and r.job_id = p_job.id
        and r.id = v_requirement.requirement_id
        and not (r.id = any(v_retained_ids))
      limit 1;
    end if;

    if v_existing.id is null then
      select *
      into v_existing
      from app.job_requirements r
      where r.org_id = p_org_id
        and r.job_id = p_job.id
        and app_api.normalize_job_requirement_lookup_key(r.manufacturer, r.film_name, r.width_in) =
          app_api.normalize_job_requirement_lookup_key(v_requirement.manufacturer, v_requirement.film_name, v_requirement.width_in)
        and not (r.id = any(v_retained_ids))
      limit 1;
    end if;

    v_next_id := coalesce(v_existing.id, gen_random_uuid());
    v_retained_ids := array_append(v_retained_ids, v_next_id);

    if v_existing.id is not null then
      update app.job_requirements
      set manufacturer = v_requirement.manufacturer,
          film_name = v_requirement.film_name,
          width_in = v_requirement.width_in,
          required_feet = v_requirement.required_feet,
          notes = coalesce(v_existing.notes, ''),
          updated_at = p_now,
          updated_by = app_api.trim_text(p_actor)
      where org_id = p_org_id
        and job_id = p_job.id
        and id = v_existing.id;
    else
      insert into app.job_requirements (
        id,
        org_id,
        job_id,
        manufacturer,
        film_name,
        width_in,
        required_feet,
        notes,
        created_at,
        created_by,
        updated_at,
        updated_by
      )
      values (
        v_next_id,
        p_org_id,
        p_job.id,
        v_requirement.manufacturer,
        v_requirement.film_name,
        v_requirement.width_in,
        v_requirement.required_feet,
        '',
        p_now,
        app_api.trim_text(p_actor),
        p_now,
        app_api.trim_text(p_actor)
      );
    end if;
  end loop;

  delete from app.job_requirements
  where org_id = p_org_id
    and job_id = p_job.id
    and not (id = any(v_retained_ids));
end;
$$;
