create or replace function app_api.normalize_core_type(p_value text, p_allow_blank boolean default false)
returns text
language plpgsql
immutable
as $$
declare
  v_trimmed text := app_api.trim_text(p_value);
  v_normalized text := lower(v_trimmed);
begin
  if v_trimmed = '' then
    if p_allow_blank then
      return '';
    end if;

    perform app_api.raise_http(400, 'CoreType is required.');
  end if;

  if v_normalized = 'white' then
    return 'White';
  end if;

  if v_normalized = 'red' then
    return 'Red';
  end if;

  if v_normalized = 'cardboard' then
    return 'Cardboard';
  end if;

  if v_normalized in ('thick cardboard', 'thick-cardboard', 'thick_cardboard', 'thickcardboard') then
    return 'Thick Cardboard';
  end if;

  if v_normalized in (
    'security 1/4" cardboard',
    'security 1/4 cardboard',
    'security 1-4" cardboard',
    'security 1-4 cardboard'
  ) then
    return 'SECURITY 1/4" Cardboard';
  end if;

  perform app_api.raise_http(
    400,
    'CoreType must be White, Red, Cardboard, Thick Cardboard, or SECURITY 1/4" Cardboard.'
  );
  return '';
end;
$$;

create or replace function app_api.derive_core_weight_lbs(p_core_type text, p_width_in numeric)
returns numeric
language sql
immutable
as $$
  select round(
    (
      case app_api.normalize_core_type(p_core_type, false)
        when 'White' then 2::numeric
        when 'Red' then 1.85::numeric
        when 'Cardboard' then 2.05::numeric
        when 'Thick Cardboard' then 6.15::numeric
        when 'SECURITY 1/4" Cardboard' then 11.6::numeric
      end / 72::numeric
    ) * p_width_in,
    4
  );
$$;
