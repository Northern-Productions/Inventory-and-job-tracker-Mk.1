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

  if v_normalized in ('white', 'white plastic', 'whiteplastic') then
    return 'White plastic';
  end if;

  if v_normalized in ('red', 'red plastic', 'redplastic') then
    return 'Red plastic';
  end if;

  if v_normalized in ('cardboard', 'cardboard 1/8"', 'cardboard 1/8', 'cardboard 1-8"', 'cardboard 1-8') then
    return 'Cardboard 1/8"';
  end if;

  if v_normalized in (
    'thick cardboard',
    'thick-cardboard',
    'thick_cardboard',
    'thickcardboard',
    'cardboard 3/4"',
    'cardboard 3/4',
    'cardboard 3-4"',
    'cardboard 3-4',
    'cardboard 3/8"',
    'cardboard 3/8',
    'cardboard 3-8"',
    'cardboard 3-8'
  ) then
    return 'Cardboard 3/8"';
  end if;

  if v_normalized in (
    'security 1/4" cardboard',
    'security 1/4 cardboard',
    'security 1-4" cardboard',
    'security 1-4 cardboard'
  ) then
    return 'SECURITY 1/4" Cardboard';
  end if;

  if v_normalized in (
    'security white plastic 3/8"',
    'security white plastic 3/8',
    'security white plastic 3-8"',
    'security white plastic 3-8',
    'security whiteplastic 3/8"',
    'security whiteplastic 3/8',
    'security whiteplastic 3-8"',
    'security whiteplastic 3-8',
    'security white 3/8"',
    'security white 3/8',
    'security white 3-8"',
    'security white 3-8'
  ) then
    return 'SECURITY White plastic 3/8"';
  end if;

  perform app_api.raise_http(
    400,
    'CoreType must be White plastic, Red plastic, Cardboard 1/8", Cardboard 3/8", SECURITY 1/4" Cardboard, or SECURITY White plastic 3/8".'
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
        when 'White plastic' then 2::numeric
        when 'Red plastic' then 1.85::numeric
        when 'Cardboard 1/8"' then 2.05::numeric
        when 'Cardboard 3/8"' then 6.15::numeric
        when 'SECURITY 1/4" Cardboard' then 11.6::numeric
        when 'SECURITY White plastic 3/8"' then 14.4::numeric
      end / 72::numeric
    ) * p_width_in,
    4
  );
$$;

update app.boxes
set core_type = case
  when lower(app_api.trim_text(core_type)) in ('white', 'white plastic', 'whiteplastic') then 'White plastic'
  when lower(app_api.trim_text(core_type)) in ('red', 'red plastic', 'redplastic') then 'Red plastic'
  when lower(app_api.trim_text(core_type)) in ('cardboard', 'cardboard 1/8"', 'cardboard 1/8', 'cardboard 1-8"', 'cardboard 1-8') then 'Cardboard 1/8"'
  when lower(app_api.trim_text(core_type)) in (
    'thick cardboard',
    'thick-cardboard',
    'thick_cardboard',
    'thickcardboard',
    'cardboard 3/4"',
    'cardboard 3/4',
    'cardboard 3-4"',
    'cardboard 3-4',
    'cardboard 3/8"',
    'cardboard 3/8',
    'cardboard 3-8"',
    'cardboard 3-8'
  ) then 'Cardboard 3/8"'
  when lower(app_api.trim_text(core_type)) in (
    'security 1/4" cardboard',
    'security 1/4 cardboard',
    'security 1-4" cardboard',
    'security 1-4 cardboard'
  ) then 'SECURITY 1/4" Cardboard'
  when lower(app_api.trim_text(core_type)) in (
    'security white plastic 3/8"',
    'security white plastic 3/8',
    'security white plastic 3-8"',
    'security white plastic 3-8',
    'security whiteplastic 3/8"',
    'security whiteplastic 3/8',
    'security whiteplastic 3-8"',
    'security whiteplastic 3-8',
    'security white 3/8"',
    'security white 3/8',
    'security white 3-8"',
    'security white 3-8'
  ) then 'SECURITY White plastic 3/8"'
  else core_type
end
where lower(app_api.trim_text(core_type)) in (
  'white',
  'white plastic',
  'whiteplastic',
  'red',
  'red plastic',
  'redplastic',
  'cardboard',
  'cardboard 1/8"',
  'cardboard 1/8',
  'cardboard 1-8"',
  'cardboard 1-8',
  'thick cardboard',
  'thick-cardboard',
  'thick_cardboard',
  'thickcardboard',
  'cardboard 3/4"',
  'cardboard 3/4',
  'cardboard 3-4"',
  'cardboard 3-4',
  'cardboard 3/8"',
  'cardboard 3/8',
  'cardboard 3-8"',
  'cardboard 3-8',
  'security 1/4" cardboard',
  'security 1/4 cardboard',
  'security 1-4" cardboard',
  'security 1-4 cardboard',
  'security white plastic 3/8"',
  'security white plastic 3/8',
  'security white plastic 3-8"',
  'security white plastic 3-8',
  'security whiteplastic 3/8"',
  'security whiteplastic 3/8',
  'security whiteplastic 3-8"',
  'security whiteplastic 3-8',
  'security white 3/8"',
  'security white 3/8',
  'security white 3-8"',
  'security white 3-8'
);

update app.film_catalog
set default_core_type = case
  when lower(app_api.trim_text(default_core_type)) in ('white', 'white plastic', 'whiteplastic') then 'White plastic'
  when lower(app_api.trim_text(default_core_type)) in ('red', 'red plastic', 'redplastic') then 'Red plastic'
  when lower(app_api.trim_text(default_core_type)) in ('cardboard', 'cardboard 1/8"', 'cardboard 1/8', 'cardboard 1-8"', 'cardboard 1-8') then 'Cardboard 1/8"'
  when lower(app_api.trim_text(default_core_type)) in (
    'thick cardboard',
    'thick-cardboard',
    'thick_cardboard',
    'thickcardboard',
    'cardboard 3/4"',
    'cardboard 3/4',
    'cardboard 3-4"',
    'cardboard 3-4',
    'cardboard 3/8"',
    'cardboard 3/8',
    'cardboard 3-8"',
    'cardboard 3-8'
  ) then 'Cardboard 3/8"'
  when lower(app_api.trim_text(default_core_type)) in (
    'security 1/4" cardboard',
    'security 1/4 cardboard',
    'security 1-4" cardboard',
    'security 1-4 cardboard'
  ) then 'SECURITY 1/4" Cardboard'
  when lower(app_api.trim_text(default_core_type)) in (
    'security white plastic 3/8"',
    'security white plastic 3/8',
    'security white plastic 3-8"',
    'security white plastic 3-8',
    'security whiteplastic 3/8"',
    'security whiteplastic 3/8',
    'security whiteplastic 3-8"',
    'security whiteplastic 3-8',
    'security white 3/8"',
    'security white 3/8',
    'security white 3-8"',
    'security white 3-8'
  ) then 'SECURITY White plastic 3/8"'
  else default_core_type
end
where lower(app_api.trim_text(default_core_type)) in (
  'white',
  'white plastic',
  'whiteplastic',
  'red',
  'red plastic',
  'redplastic',
  'cardboard',
  'cardboard 1/8"',
  'cardboard 1/8',
  'cardboard 1-8"',
  'cardboard 1-8',
  'thick cardboard',
  'thick-cardboard',
  'thick_cardboard',
  'thickcardboard',
  'cardboard 3/4"',
  'cardboard 3/4',
  'cardboard 3-4"',
  'cardboard 3-4',
  'cardboard 3/8"',
  'cardboard 3/8',
  'cardboard 3-8"',
  'cardboard 3-8',
  'security 1/4" cardboard',
  'security 1/4 cardboard',
  'security 1-4" cardboard',
  'security 1-4 cardboard',
  'security white plastic 3/8"',
  'security white plastic 3/8',
  'security white plastic 3-8"',
  'security white plastic 3-8',
  'security whiteplastic 3/8"',
  'security whiteplastic 3/8',
  'security whiteplastic 3-8"',
  'security whiteplastic 3-8',
  'security white 3/8"',
  'security white 3/8',
  'security white 3-8"',
  'security white 3-8'
);
