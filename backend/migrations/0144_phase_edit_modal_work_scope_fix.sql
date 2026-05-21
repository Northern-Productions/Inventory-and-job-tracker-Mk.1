-- Fix phase payload parsing for edit-job phase updates.
-- The original multi-phase migration returned an output column named ordinality while also
-- using WITH ORDINALITY without an alias, which made phase update payloads fail in PL/pgSQL.

create or replace function app_api.job_phase_rows_from_payload(p_payload jsonb)
returns table (
  phase_id uuid,
  phase_number integer,
  sections text,
  install_date date,
  crew_leader text,
  labor_status text,
  is_primary boolean,
  requirements jsonb,
  caulk_requirements jsonb,
  ordinality bigint
)
language plpgsql
stable
as $$
declare
  v_has_phases boolean := p_payload ? 'phases' and jsonb_typeof(p_payload->'phases') = 'array' and jsonb_array_length(p_payload->'phases') > 0;
begin
  if v_has_phases then
    return query
    select
      nullif(app_api.trim_text(phase.value->>'phaseId'), '')::uuid as phase_id,
      app_api.require_job_phase_number(
        coalesce(phase.value->>'phaseNumber', phase.phase_ordinality::text),
        format('Phases[%s].PhaseNumber', phase.phase_ordinality)
      ) as phase_number,
      app_api.normalize_job_work_scope(coalesce(phase.value->>'workScope', phase.value->>'sections')) as sections,
      nullif(app_api.trim_text(coalesce(phase.value->>'installDate', phase.value->>'dueDate')), '')::date as install_date,
      app_api.trim_text(phase.value->>'crewLeader') as crew_leader,
      app_api.normalize_job_phase_labor_status(coalesce(phase.value->>'laborStatus', phase.value->>'status')) as labor_status,
      coalesce((phase.value->>'isPrimary')::boolean, phase.phase_ordinality = 1) as is_primary,
      case when jsonb_typeof(phase.value->'requirements') = 'array' then phase.value->'requirements' else '[]'::jsonb end as requirements,
      case when jsonb_typeof(phase.value->'caulkRequirements') = 'array' then phase.value->'caulkRequirements' else '[]'::jsonb end as caulk_requirements,
      phase.phase_ordinality
    from jsonb_array_elements(p_payload->'phases') with ordinality as phase(value, phase_ordinality);
    return;
  end if;

  return query
  select
    null::uuid,
    app_api.require_job_phase_number(coalesce(p_payload->>'phaseNumber', '1'), 'PhaseNumber'),
    app_api.normalize_job_work_scope(
      case when p_payload ? 'workScope' then p_payload->>'workScope' else p_payload->>'sections' end
    ),
    nullif(app_api.trim_text(coalesce(p_payload->>'installDate', p_payload->>'dueDate')), '')::date,
    app_api.trim_text(p_payload->>'crewLeader'),
    'ACTIVE',
    true,
    case when jsonb_typeof(p_payload->'requirements') = 'array' then p_payload->'requirements' else '[]'::jsonb end,
    case when jsonb_typeof(p_payload->'caulkRequirements') = 'array' then p_payload->'caulkRequirements' else '[]'::jsonb end,
    1::bigint;
end;
$$;

select app_api.grant_execute_if_exists('app_api.job_phase_rows_from_payload(jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.job_phase_rows_from_payload(jsonb)', 'service_role');
