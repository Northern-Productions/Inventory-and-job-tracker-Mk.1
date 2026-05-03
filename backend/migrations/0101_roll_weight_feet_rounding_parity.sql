-- Align backend SQL roll-weight LF derivation with frontend rounding semantics.
-- This replaces the function only; it does not mutate inventory data or table shape.
create or replace function app_api.derive_feet_available_from_roll_weight(
  p_last_roll_weight numeric,
  p_core_weight numeric,
  p_lf_weight numeric,
  p_initial_feet integer
)
returns integer
language plpgsql
immutable
as $$
declare
  v_raw_feet numeric;
  v_floored integer;
begin
  if p_lf_weight is null or p_lf_weight <= 0 then
    perform app_api.raise_http(
      400,
      'LfWeightLbsPerFt must be greater than zero to calculate FeetAvailable.'
    );
  end if;

  v_raw_feet := round(((p_last_roll_weight - p_core_weight) / p_lf_weight)::numeric, 2);
  if v_raw_feet <= 0 then
    return 0;
  end if;

  v_floored := floor(v_raw_feet);
  if v_floored > p_initial_feet then
    return p_initial_feet;
  end if;

  return greatest(v_floored, 0);
end;
$$;
