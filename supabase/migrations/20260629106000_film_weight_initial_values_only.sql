do $$
declare
  v_base text;
  v_next text;
  v_old_weight_source text := '  v_measured_roll_weight_lbs := coalesce(v_box.last_roll_weight_lbs, v_box.initial_weight_lbs);';
  v_new_weight_source text := '  v_measured_roll_weight_lbs := v_box.initial_weight_lbs;';
begin
  select pg_get_functiondef('app_api.record_film_weight_sample_from_box(uuid, text, text)'::regprocedure)
  into v_base;

  if v_base is null then
    raise exception 'app_api.record_film_weight_sample_from_box(uuid, text, text) was not found.';
  end if;

  v_base := replace(v_base, E'\r\n', E'\n');
  v_next := v_base;

  if position(v_new_weight_source in v_next) = 0 then
    v_next := replace(v_next, v_old_weight_source, v_new_weight_source);
  end if;

  if position(v_new_weight_source in v_next) = 0 then
    raise exception 'film weight sample initial-weight patch did not match expected snippets';
  end if;

  if position(v_old_weight_source in v_next) > 0 then
    raise exception 'film weight sample still uses last roll weight before initial weight';
  end if;

  execute v_next;
end $$;

comment on function app_api.record_film_weight_sample_from_box(uuid, text, text)
  is 'Records Weight Chart calibration samples from initial LF and initial roll weight only; last roll weight is reserved for remaining-LF estimates.';
