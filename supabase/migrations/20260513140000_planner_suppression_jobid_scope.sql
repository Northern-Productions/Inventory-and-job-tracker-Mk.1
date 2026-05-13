/**
 * PURPOSE:
 * Makes planner suppression clear reconciliation use exact jobId scope when
 * the canonical jobId route has already validated the job identity.
 *
 * AFFECTS:
 * public.api_acl_clear_allocation_planner_suppression planner scope only.
 * Legacy jobNumber-only suppression clear remains available.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * Supabase mirror migration, backend/Edge suppression identity guards,
 * local runtime RPC payload pass-through, and schema latest guard semantics.
 *
 * COMMON FAILURE MODES:
 * Allowing mismatched jobId/jobNumber payloads, accepting requirements from a
 * different job, omitting caulk affected-scope pairs, or changing allocation
 * apply/preview behavior before duplicate job numbers are enabled.
 */

create or replace function public.api_acl_clear_allocation_planner_suppression(
  p_org_id uuid,
  p_actor text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_job_number text := app_api.require_job_number_digits(v_payload->>'jobNumber', 'Job ID number');
  v_job_id_text text := app_api.trim_text(v_payload->>'jobId');
  v_has_valid_job_id boolean := coalesce(v_job_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false);
  v_job_id uuid;
  v_job app.jobs;
  v_requirement_id uuid := nullif(app_api.trim_text(v_payload->>'requirementId'), '')::uuid;
  v_material_type text := upper(coalesce(nullif(app_api.trim_text(v_payload->>'materialType'), ''), nullif(app_api.trim_text(v_payload->>'material_type'), ''), 'FILM'));
  v_film_requirement app.job_requirements;
  v_caulk_requirement app.job_caulk_requirements;
  v_result jsonb;
  v_scope jsonb;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'write');

  if v_requirement_id is null then
    perform app_api.raise_http(400, 'Requirement ID is required.');
  end if;

  if v_has_valid_job_id then
    v_job_id := v_job_id_text::uuid;

    select *
    into v_job
    from app.jobs j
    where j.org_id = p_org_id
      and j.id = v_job_id
    for update;

    if not found then
      perform app_api.raise_http(404, 'Job was not found.');
    end if;

    if upper(trim(v_job.job_number)) <> upper(trim(v_job_number)) then
      perform app_api.raise_http(
        409,
        'Job identity mismatch: selected job does not match jobNumber.'
      );
    end if;
  end if;

  if v_material_type = 'CAULK' then
    if v_has_valid_job_id then
      select *
      into v_caulk_requirement
      from app.job_caulk_requirements r
      where r.org_id = p_org_id
        and r.job_id = v_job.id
        and r.id = v_requirement_id
      for update;

      if not found then
        perform app_api.raise_http(404, 'Caulk requirement was not found for selected job.');
      end if;

      v_result := app_api.clear_caulk_allocation_planner_suppression_for_requirement(
        p_org_id,
        p_actor,
        v_job.job_number,
        v_requirement_id,
        v_payload->>'reason'
      );
      v_scope := jsonb_build_object(
        'jobIds', jsonb_build_array(v_job.id),
        'jobNumbers', jsonb_build_array(v_job.job_number),
        'caulkProductWarehousePairs',
        jsonb_build_array(
          jsonb_build_object(
            'productId', v_result->>'productId',
            'warehouse', v_result->>'warehouse'
          )
        )
      );
    else
      v_result := app_api.clear_caulk_allocation_planner_suppression_for_requirement(
        p_org_id,
        p_actor,
        v_job_number,
        v_requirement_id,
        v_payload->>'reason'
      );
      v_scope := jsonb_build_object(
        'jobNumbers', jsonb_build_array(v_job_number),
        'caulkProductWarehousePairs',
        jsonb_build_array(
          jsonb_build_object(
            'productId', v_result->>'productId',
            'warehouse', v_result->>'warehouse'
          )
        )
      );
    end if;
  elsif v_material_type = 'FILM' then
    if v_has_valid_job_id then
      select *
      into v_film_requirement
      from app.job_requirements r
      where r.org_id = p_org_id
        and r.job_id = v_job.id
        and r.id = v_requirement_id
      for update;

      if not found then
        perform app_api.raise_http(404, 'Film requirement was not found for selected job.');
      end if;

      v_result := app_api.clear_allocation_planner_suppression_for_requirement(
        p_org_id,
        p_actor,
        v_job.job_number,
        v_requirement_id,
        v_payload->>'reason'
      );
      v_scope := jsonb_build_object(
        'jobIds', jsonb_build_array(v_job.id),
        'jobNumbers', jsonb_build_array(v_job.job_number)
      );
    else
      v_result := app_api.clear_allocation_planner_suppression_for_requirement(
        p_org_id,
        p_actor,
        v_job_number,
        v_requirement_id,
        v_payload->>'reason'
      );
      v_scope := jsonb_build_object('jobNumbers', jsonb_build_array(v_job_number));
    end if;
  else
    perform app_api.raise_http(400, 'materialType must be FILM or CAULK.');
  end if;

  perform app_api.reconcile_auto_planned_allocations(p_org_id, p_actor, v_scope);

  return v_result || jsonb_build_object('materialType', v_material_type);
end;
$$;

comment on function public.api_acl_clear_allocation_planner_suppression(uuid, text, jsonb)
is 'Clears allocation planner suppression and reconciles planner scope by exact jobId when canonical identity is supplied.';
