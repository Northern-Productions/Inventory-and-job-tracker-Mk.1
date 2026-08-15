/**
 * PURPOSE:
 * Counts active EXTRA film as a physical box-capacity reservation without
 * allowing it to satisfy requirement coverage.
 *
 * AFFECTS:
 * Box availability, allocation apply/preview guards, transfer protection,
 * checkout/check-in reconciliation, local runtime reads, and Edge parity.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * shared/domain/filmAllocationReservations.mjs, allocation apply migrations,
 * material-flow reconciliation, transfer guards, and box projection tests.
 *
 * COMMON FAILURE MODES:
 * Treating EXTRA as requirement coverage, subtracting weight-derived LF twice,
 * or allowing repeated EXTRA allocations to exceed physical box capacity.
 */

create or replace function app_api.film_allocation_reserves_capacity(
  p_allocation app.allocations,
  p_box_status text
)
returns boolean
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select
    (
      coalesce((p_allocation).allocation_kind::text, 'REQUIREMENT') = 'EXTRA'
      or (
        coalesce((p_allocation).allocation_kind::text, 'REQUIREMENT') = 'REQUIREMENT'
        and (p_allocation).requirement_id is not null
      )
    )
    and (
      (p_allocation).job_id is not null
      or app_api.trim_text((p_allocation).job_number) <> ''
    )
    and coalesce((p_allocation).allocated_feet, 0) > 0
    and (
      (p_allocation).status = 'ACTIVE'
      or (
        (p_allocation).status = 'FULFILLED'
        and upper(coalesce(p_box_status, '')) = 'CHECKED_OUT'
      )
    );
$$;

comment on function app_api.film_allocation_reserves_capacity(app.allocations, text)
is 'Returns whether a requirement-bound or EXTRA film allocation consumes physical box capacity.';

do $$
declare
  v_definition text;
  v_security_definer boolean;
  v_volatility "char";
begin
  select pg_get_functiondef(p.oid), p.prosecdef, p.provolatile
  into v_definition, v_security_definer, v_volatility
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'app_api'
    and p.proname = 'film_allocation_reserves_capacity'
    and pg_get_function_identity_arguments(p.oid) = 'p_allocation app.allocations, p_box_status text';

  if v_definition is null
    or position($needle$coalesce((p_allocation).allocation_kind::text, 'REQUIREMENT') = 'EXTRA'$needle$ in v_definition) = 0
    or position('(p_allocation).requirement_id is not null' in v_definition) = 0
    or position($needle$(p_allocation).status = 'ACTIVE'$needle$ in v_definition) = 0
    or position($needle$upper(coalesce(p_box_status, '')) = 'CHECKED_OUT'$needle$ in v_definition) = 0
    or not coalesce(v_security_definer, false)
    or v_volatility <> 's'
  then
    raise exception 'Migration 0202 EXTRA capacity reservation invariant failed.';
  end if;
end;
$$;
