-- Keep checked-out allocation capacity tied to physical remaining LF, not original roll LF.
-- Checked-out boxes may still satisfy new allocation claims, but only with unclaimed material
-- that physically remains on the roll.

create or replace function app_api.assert_film_box_allocation_capacity(
  p_org_id uuid,
  p_box_id text,
  p_allocation_id text default ''
)
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_box app.boxes;
  v_capacity integer := 0;
  v_reserved_feet integer := 0;
  v_status text := '';
begin
  select *
  into v_box
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = app_api.trim_text(p_box_id)
  for update;

  if not found then
    return;
  end if;

  v_status := upper(coalesce(v_box.status::text, ''));

  if v_status in ('ZEROED', 'RETIRED') then
    return;
  end if;

  v_capacity := case
    when v_status = 'ORDERED' then greatest(coalesce(v_box.initial_feet, 0), 0)
    when v_status = 'CHECKED_OUT' then greatest(coalesce(app_api.box_physical_feet_available(v_box), 0), 0)
    else app_api.film_box_planner_physical_capacity(v_box)
  end;
  v_reserved_feet := app_api.active_film_allocated_feet_for_box(p_org_id, v_box.box_id, p_allocation_id);

  if v_reserved_feet > v_capacity then
    perform app_api.raise_http(
      409,
      format(
        'Box %s has %s LF allocated but only %s physical LF available.',
        v_box.box_id,
        v_reserved_feet,
        v_capacity
      )
    );
  end if;
end;
$$;

do $$
declare
  v_def text;
begin
  select pg_get_functiondef('app_api.assert_film_box_allocation_capacity(uuid, text, text)'::regprocedure)
  into v_def;

  if position('when v_status = ''CHECKED_OUT'' then greatest(coalesce(app_api.box_physical_feet_available(v_box), 0), 0)' in v_def) = 0 then
    raise exception 'checked-out allocation capacity must use physical remaining LF';
  end if;

  if position('when v_status = ''ORDERED'' then greatest(coalesce(v_box.initial_feet, 0), 0)' in v_def) = 0 then
    raise exception 'ordered allocation capacity must preserve initial-feet planning capacity';
  end if;

  if position('app_api.active_film_allocated_feet_for_box(p_org_id, v_box.box_id, p_allocation_id)' in v_def) = 0 then
    raise exception 'allocation capacity assertion must exclude the row being saved';
  end if;
end
$$;

select app_api.grant_execute_if_exists('app_api.assert_film_box_allocation_capacity(uuid, text, text)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.assert_film_box_allocation_capacity(uuid, text, text)', 'service_role');
