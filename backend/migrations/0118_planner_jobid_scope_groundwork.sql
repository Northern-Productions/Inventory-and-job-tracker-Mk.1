/**
 * PURPOSE:
 * Adds Phase 3B groundwork for exact jobId-scoped AUTO planner work without
 * switching any runtime caller away from the existing jobNumber planner scope.
 *
 * AFFECTS:
 * Future planner migrations only. Existing jobNumber planner entry points,
 * allocation preview/apply, film order create/cancel, suppression clear, and
 * lifecycle mutations continue to use their current behavior.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * Supabase mirror migration, backend planner static tests, and future planner
 * RPC migrations that introduce jobId-first reconciliation.
 *
 * COMMON FAILURE MODES:
 * Expanding one jobId into every job with the same jobNumber, accepting another
 * org's jobId, or enabling duplicate job numbers before all mutation paths are
 * jobId-safe.
 */

create or replace function app_api.auto_planner_scope_job_ids(
  p_org_id uuid,
  p_scope jsonb
)
returns table(job_id uuid, job_number text)
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  with requested_jobs as (
    select
      btrim(value)::uuid as job_id,
      min(ordinality) as first_position
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(coalesce(p_scope, '{}'::jsonb)->'jobIds') = 'array'
        then coalesce(p_scope, '{}'::jsonb)->'jobIds'
        else '[]'::jsonb
      end
    ) with ordinality as requested(value, ordinality)
    where btrim(value) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    group by btrim(value)::uuid
  )
  select
    j.id as job_id,
    j.job_number
  from requested_jobs r
  join app.jobs j
    on j.org_id = p_org_id
   and j.id = r.job_id
  order by
    r.first_position,
    j.job_number,
    j.id;
$$;

comment on function app_api.auto_planner_scope_job_ids(uuid, jsonb) is
  'Phase 3B-1 groundwork for exact jobId planner scope. Existing jobNumber planner entry points remain legacy compatibility only; future duplicate-number support must not call jobNumber planner entry points when jobNumber is ambiguous. Duplicate job numbers remain disabled in this branch.';
