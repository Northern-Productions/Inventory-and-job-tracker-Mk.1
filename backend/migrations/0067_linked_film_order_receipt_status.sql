-- Fulfill linked film orders based on whether all linked ordered boxes have been received.

create or replace function app_api.recalculate_film_order(
  p_org_id uuid,
  p_film_order_id text,
  p_actor text
)
returns app.film_orders
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_existing app.film_orders;
  v_link_count integer := 0;
  v_received_link_count integer := 0;
begin
  select *
  into v_existing
  from app.film_orders f
  where f.org_id = p_org_id
    and f.film_order_id = app_api.trim_text(p_film_order_id)
  for update;

  if not found then
    return null;
  end if;

  v_existing.covered_feet := app_api.sum_film_order_covered_feet(p_org_id, p_film_order_id);

  select
    count(*)::integer,
    coalesce(sum(l.ordered_feet) filter (where b.box_id is not null), 0)::integer,
    count(*) filter (
      where b.box_id is not null
        and upper(coalesce(b.status::text, '')) <> 'ORDERED'
    )::integer
  into
    v_link_count,
    v_existing.ordered_feet,
    v_received_link_count
  from app.film_order_box_links l
  left join app.boxes b
    on b.org_id = l.org_id
   and b.box_id = l.box_id
  where l.org_id = p_org_id
    and l.film_order_id = app_api.trim_text(p_film_order_id);

  v_existing.remaining_to_order_feet := greatest(v_existing.requested_feet - v_existing.ordered_feet, 0);

  if v_existing.status <> 'CANCELLED' then
    if v_link_count > 0 then
      if v_existing.ordered_feet < v_existing.requested_feet then
        v_existing.status := 'FILM_ORDER';
        v_existing.resolved_at := null;
        v_existing.resolved_by := '';
      elsif v_received_link_count = v_link_count then
        v_existing.status := 'FULFILLED';
        if v_existing.resolved_at is null then
          v_existing.resolved_at := now();
          v_existing.resolved_by := app_api.trim_text(p_actor);
        end if;
      else
        v_existing.status := 'FILM_ON_THE_WAY';
        v_existing.resolved_at := null;
        v_existing.resolved_by := '';
      end if;
    elsif v_existing.covered_feet >= v_existing.requested_feet then
      v_existing.status := 'FULFILLED';
      if v_existing.resolved_at is null then
        v_existing.resolved_at := now();
        v_existing.resolved_by := app_api.trim_text(p_actor);
      end if;
    elsif v_existing.ordered_feet >= v_existing.requested_feet then
      v_existing.status := 'FILM_ON_THE_WAY';
      v_existing.resolved_at := null;
      v_existing.resolved_by := '';
    else
      v_existing.status := 'FILM_ORDER';
      v_existing.resolved_at := null;
      v_existing.resolved_by := '';
    end if;
  end if;

  return app_api.save_film_order(v_existing);
end;
$$;

create or replace function app_api.process_linked_box_receipt(
  p_org_id uuid,
  p_box app.boxes,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_box app.boxes := p_box;
  v_link app.film_order_box_links;
  v_order app.film_orders;
  v_remaining_need integer;
  v_link_capacity integer;
  v_allocation_feet integer;
  v_job_context jsonb;
  v_warnings text[] := array[]::text[];
  v_recalculate_film_order_ids text[] := array[]::text[];
  v_recalculate_film_order_id text;
begin
  if v_box.received_date is null or v_box.status <> 'IN_STOCK' then
    return jsonb_build_object('box', to_jsonb(v_box), 'warnings', to_jsonb(v_warnings));
  end if;

  for v_link in
    select *
    from app.film_order_box_links l
    where l.org_id = p_org_id
      and l.box_id = v_box.box_id
    for update
  loop
    select *
    into v_order
    from app.film_orders f
    where f.org_id = p_org_id
      and f.film_order_id = v_link.film_order_id
    for update;

    if not found or v_order.status in ('CANCELLED', 'FULFILLED') then
      continue;
    end if;

    if array_position(v_recalculate_film_order_ids, v_order.film_order_id) is null then
      v_recalculate_film_order_ids := v_recalculate_film_order_ids || v_order.film_order_id;
    end if;

    v_remaining_need := greatest(v_order.requested_feet - v_order.covered_feet, 0);
    v_link_capacity := greatest(v_link.ordered_feet - v_link.auto_allocated_feet, 0);
    v_allocation_feet := least(v_remaining_need, v_link_capacity, v_box.feet_available);

    if v_allocation_feet <= 0 then
      continue;
    end if;

    v_job_context := jsonb_build_object(
      'jobNumber', v_order.job_number,
      'jobDate', coalesce(to_char(v_order.job_date, 'YYYY-MM-DD'), ''),
      'crewLeader', coalesce(v_order.crew_leader, '')
    );
    perform app_api.create_allocation(
      p_org_id,
      v_box,
      v_job_context,
      v_allocation_feet,
      p_actor,
      v_order.film_order_id,
      'REQUIREMENT',
      null
    );

    v_box.feet_available := greatest(v_box.feet_available - v_allocation_feet, 0);
    v_link.auto_allocated_feet := v_link.auto_allocated_feet + v_allocation_feet;
    perform app_api.save_film_order_link(v_link);
    v_warnings := app_api.push_warning(
      v_warnings,
      format(
        '%s LF from %s was automatically allocated to job %s for Film Order %s.',
        v_allocation_feet,
        v_box.box_id,
        v_order.job_number,
        v_order.film_order_id
      )
    );
  end loop;

  foreach v_recalculate_film_order_id in array v_recalculate_film_order_ids
  loop
    perform app_api.recalculate_film_order(p_org_id, v_recalculate_film_order_id, p_actor);
  end loop;

  return jsonb_build_object('box', to_jsonb(v_box), 'warnings', to_jsonb(v_warnings));
end;
$$;

do $$
declare
  v_candidate record;
  v_actor text := 'migration: linked film order receipt status';
begin
  for v_candidate in
    select distinct fo.org_id, fo.film_order_id
    from app.film_orders fo
    join app.film_order_box_links l
      on l.org_id = fo.org_id
     and l.film_order_id = fo.film_order_id
    where fo.status <> 'CANCELLED'
  loop
    perform app_api.recalculate_film_order(
      v_candidate.org_id,
      v_candidate.film_order_id,
      v_actor
    );
  end loop;
end;
$$;
