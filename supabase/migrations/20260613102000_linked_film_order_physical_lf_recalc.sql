/*
 * PURPOSE:
 * Keep linked film-order quantities aligned with corrected physical box LF.
 *
 * AFFECTS:
 * Box LF correction, linked film-order status recalculation, and linked-box
 * auto allocation summaries.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * docs/material-flow-rules.md, runtimeAllocationPlanning.mjs,
 * Supabase Edge api-handler.ts, and schema/latest guards.
 */

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

  with linked_allocation_totals as (
    select
      l.id,
      coalesce(
        sum(a.allocated_feet) filter (
          where a.status in ('ACTIVE', 'FULFILLED')
            and a.film_order_id = l.film_order_id
            and a.box_id = l.box_id
        ),
        0
      )::integer as auto_allocated_feet
    from app.film_order_box_links l
    left join app.allocations a
      on a.org_id = l.org_id
     and a.film_order_id = l.film_order_id
     and a.box_id = l.box_id
    where l.org_id = p_org_id
      and l.film_order_id = app_api.trim_text(p_film_order_id)
    group by l.id
  )
  update app.film_order_box_links l
  set auto_allocated_feet = linked_allocation_totals.auto_allocated_feet
  from linked_allocation_totals
  where l.id = linked_allocation_totals.id
    and l.auto_allocated_feet is distinct from linked_allocation_totals.auto_allocated_feet;

  select
    count(*)::integer,
    coalesce(
      sum(
        app_api.compute_covered_feet_from_allocation(
          case
            when upper(coalesce(b.status::text, '')) = 'ORDERED' then
              greatest(coalesce(b.initial_feet, l.ordered_feet, 0), 0)::integer
            when upper(coalesce(b.status::text, '')) in ('IN_STOCK', 'TRANSFER') then
              greatest(coalesce(app_api.box_physical_feet_available(b), b.feet_available, 0), 0)::integer
            else
              greatest(coalesce(b.initial_feet, l.ordered_feet, 0), 0)::integer
          end,
          coalesce(b.width_in, v_existing.width_in),
          v_existing.width_in
        )
      ) filter (where b.box_id is not null),
      0
    )::integer,
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

do $$
declare
  v_def text;
begin
  select pg_get_functiondef('app_api.recalculate_film_order(uuid, text, text)'::regprocedure)
  into v_def;

  if position('update app.film_order_box_links l' in v_def) = 0
     or position('app_api.box_physical_feet_available(b)' in v_def) = 0
     or position('a.status in (''ACTIVE'', ''FULFILLED'')' in v_def) = 0 then
    raise exception 'linked film-order physical LF recalculation guard failed';
  end if;
end;
$$;

select app_api.grant_execute_if_exists('app_api.recalculate_film_order(uuid, text, text)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.recalculate_film_order(uuid, text, text)', 'service_role');
