-- Backfill legacy linked film-order allocations that were received before the
-- receipt-resolution flow started attaching film_order_id to the active allocation rows.

do $$
declare
  v_candidate record;
  v_actor text := 'migration: backfill legacy linked film-order receipts';
begin
  for v_candidate in
    with stale_candidates as (
      select
        fo.org_id,
        fo.film_order_id,
        l.id as link_row_id,
        array_agg(a.id order by a.created_at asc nulls first, a.id asc) as allocation_row_ids,
        coalesce(sum(a.allocated_feet), 0)::integer as matched_allocated_feet
      from app.film_orders fo
      join app.film_order_box_links l
        on l.org_id = fo.org_id
       and l.film_order_id = fo.film_order_id
      join app.boxes b
        on b.org_id = l.org_id
       and b.box_id = l.box_id
      join app.allocations a
        on a.org_id = fo.org_id
       and a.job_number = fo.job_number
       and a.box_id = l.box_id
      where fo.status in ('FILM_ORDER', 'FILM_ON_THE_WAY')
        and b.status = 'IN_STOCK'
        and b.received_date is not null
        and upper(trim(coalesce(a.status::text, ''))) = 'ACTIVE'
        and upper(trim(coalesce(a.allocation_kind::text, ''))) = 'REQUIREMENT'
        and app_api.trim_text(coalesce(a.film_order_id, '')) = ''
        and upper(trim(coalesce(b.manufacturer, ''))) = upper(trim(coalesce(fo.manufacturer, '')))
        and upper(trim(coalesce(b.film_name, ''))) = upper(trim(coalesce(fo.film_name, '')))
        and b.width_in = fo.width_in
        and l.auto_allocated_feet = 0
        and (
          select count(*)
          from app.film_order_box_links l2
          join app.film_orders fo2
            on fo2.org_id = l2.org_id
           and fo2.film_order_id = l2.film_order_id
          where l2.org_id = fo.org_id
            and l2.box_id = l.box_id
            and fo2.job_number = fo.job_number
            and fo2.status in ('FILM_ORDER', 'FILM_ON_THE_WAY')
        ) = 1
      group by
        fo.org_id,
        fo.film_order_id,
        l.id,
        l.ordered_feet,
        fo.requested_feet,
        fo.covered_feet
      having coalesce(sum(a.allocated_feet), 0)::integer > 0
         and coalesce(sum(a.allocated_feet), 0)::integer = l.ordered_feet
         and coalesce(sum(a.allocated_feet), 0)::integer = greatest(fo.requested_feet - fo.covered_feet, 0)
    )
    select *
    from stale_candidates
  loop
    update app.allocations
    set film_order_id = v_candidate.film_order_id
    where org_id = v_candidate.org_id
      and id = any(v_candidate.allocation_row_ids)
      and app_api.trim_text(coalesce(film_order_id, '')) = '';

    update app.film_order_box_links
    set auto_allocated_feet = v_candidate.matched_allocated_feet
    where org_id = v_candidate.org_id
      and id = v_candidate.link_row_id
      and auto_allocated_feet = 0;

    perform app_api.recalculate_film_order(
      v_candidate.org_id,
      v_candidate.film_order_id,
      v_actor
    );
  end loop;
end;
$$;
