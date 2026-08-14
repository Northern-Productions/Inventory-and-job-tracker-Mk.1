/**
 * PURPOSE:
 * Separates immutable Film Order receipt history from mutable box inventory LF.
 * Finalized links capture physical LF and source width once; later box usage or
 * ordinary Initial LF edits cannot rewrite purchasing history.
 *
 * AFFECTS:
 * Film Order receipt finalization, canonical order ledgers, stored status
 * recalculation, detail reads, audited receipt correction, and deterministic
 * historical backfill.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * docs/material-flow-rules.md, local and Edge Film Order linked-box helpers,
 * correction route contracts, frontend Film Order Details, and schema/latest.
 */

alter table app.film_order_box_links
  add column if not exists receipt_contribution_feet integer,
  add column if not exists receipt_source_width_in numeric(10,4),
  add column if not exists receipt_finalized_at timestamptz,
  add column if not exists receipt_finalized_by text,
  add column if not exists receipt_capture_source text;

alter table app.film_order_box_links
  drop constraint if exists film_order_box_links_receipt_history_complete;

alter table app.film_order_box_links
  add constraint film_order_box_links_receipt_history_complete check (
    (
      receipt_contribution_feet is null
      and receipt_source_width_in is null
      and receipt_finalized_at is null
      and receipt_finalized_by is null
      and receipt_capture_source is null
    )
    or
    (
      receipt_contribution_feet >= 0
      and receipt_source_width_in > 0
      and receipt_finalized_at is not null
      and btrim(coalesce(receipt_finalized_by, '')) <> ''
      and receipt_capture_source in ('LIVE_RECEIPT', 'AUDIT_BACKFILL')
    )
  );

create index if not exists idx_film_order_links_org_receipt_finalized
  on app.film_order_box_links (org_id, film_order_id, receipt_finalized_at)
  where receipt_finalized_at is not null;

-- Reconstruct only links with one exact receipt transition. When both event
-- and audit evidence exist they must agree; multiple or conflicting evidence
-- is deliberately left unresolved rather than inferred from current box data.
with audit_candidates as materialized (
  select
    l.id as link_row_id,
    greatest((a.after_state->>'initialFeet')::integer, 0) as receipt_feet,
    (a.after_state->>'widthIn')::numeric(10,4) as receipt_width_in,
    a.created_at as receipt_finalized_at,
    coalesce(nullif(btrim(a.actor), ''), 'system') as receipt_finalized_by,
    count(*) over (partition by l.id) as evidence_count
  from app.film_order_box_links l
  join app.audit_log a
    on a.org_id = l.org_id
   and a.box_id = l.box_id
   and a.created_at >= l.created_at
  where l.receipt_contribution_feet is null
    and upper(coalesce(a.action, '')) = 'SET_STATUS'
    and coalesce(a.after_state->>'initialFeet', '') ~ '^[0-9]+$'
    and coalesce(a.after_state->>'widthIn', '') ~ '^[0-9]+([.][0-9]+)?$'
    and (a.after_state->>'widthIn')::numeric > 0
    and nullif(btrim(coalesce(a.after_state->>'receivedDate', '')), '') is not null
    and upper(coalesce(a.after_state->>'status', '')) <> 'ORDERED'
    and (
      nullif(btrim(coalesce(a.before_state->>'receivedDate', '')), '') is null
      or upper(coalesce(a.before_state->>'status', '')) = 'ORDERED'
    )
),
event_candidates as materialized (
  select
    l.id as link_row_id,
    greatest((e.after_state->>'initialFeet')::integer, 0) as receipt_feet,
    count(*) over (partition by l.id) as evidence_count
  from app.film_order_box_links l
  join app.film_order_events e
    on e.org_id = l.org_id
   and e.film_order_id = l.film_order_id
   and e.related_box_id = l.box_id
   and e.created_at >= l.created_at
  where l.receipt_contribution_feet is null
    and e.event_type = 'LINKED_BOX_RECEIVED'
    and coalesce(e.after_state->>'initialFeet', '') ~ '^[0-9]+$'
),
chosen_evidence as materialized (
  select
    a.link_row_id,
    a.receipt_feet,
    a.receipt_width_in,
    a.receipt_finalized_at,
    a.receipt_finalized_by,
    'AUDIT_BACKFILL'::text as receipt_capture_source
  from audit_candidates a
  where a.evidence_count = 1
    and not exists (
      select 1
      from event_candidates e
      where e.link_row_id = a.link_row_id
        and (
          e.evidence_count <> 1
          or e.receipt_feet is distinct from a.receipt_feet
        )
    )
),
updated_links as (
  update app.film_order_box_links l
  set
    receipt_contribution_feet = evidence.receipt_feet,
    receipt_source_width_in = evidence.receipt_width_in,
    receipt_finalized_at = evidence.receipt_finalized_at,
    receipt_finalized_by = evidence.receipt_finalized_by,
    receipt_capture_source = evidence.receipt_capture_source
  from chosen_evidence evidence
  where l.id = evidence.link_row_id
    and l.receipt_contribution_feet is null
  returning l.*
)
insert into app.film_order_events (
  org_id,
  event_id,
  film_order_id,
  event_type,
  related_box_id,
  actor,
  note,
  before_state,
  after_state,
  created_at
)
select
  l.org_id,
  'FILM_ORDER_RECEIPT_BACKFILLED:' || l.link_id,
  l.film_order_id,
  'FILM_ORDER_RECEIPT_BACKFILLED',
  l.box_id,
  'migration:0199',
  'Receipt history reconstructed from one exact historical receipt transition.',
  jsonb_build_object(
    'receiptContributionFeet', null,
    'receiptSourceWidthIn', null,
    'receiptFinalizedAt', null
  ),
  jsonb_build_object(
    'receiptContributionFeet', l.receipt_contribution_feet,
    'receiptSourceWidthIn', l.receipt_source_width_in,
    'receiptFinalizedAt', l.receipt_finalized_at,
    'receiptFinalizedBy', l.receipt_finalized_by,
    'receiptCaptureSource', l.receipt_capture_source
  ),
  now()
from updated_links l
on conflict (org_id, event_id) do nothing;

create or replace function app_api.film_order_link_receipt_status(
  p_link app.film_order_box_links,
  p_box app.boxes
)
returns text
language sql
stable
as $$
  select case
    when p_link.receipt_contribution_feet is not null
      and p_link.receipt_source_width_in is not null
      and p_link.receipt_finalized_at is not null then 'FINALIZED'
    when upper(coalesce(p_box.status::text, '')) = 'ORDERED' then 'PENDING'
    else 'MISSING'
  end
$$;

create or replace function app_api.film_order_link_covered_feet(
  p_link app.film_order_box_links,
  p_box app.boxes,
  p_order_width_in numeric
)
returns integer
language sql
stable
as $$
  select app_api.compute_covered_feet_from_allocation(
    case app_api.film_order_link_receipt_status(p_link, p_box)
      when 'FINALIZED' then greatest(coalesce(p_link.receipt_contribution_feet, 0), 0)::integer
      when 'PENDING' then greatest(coalesce(p_box.initial_feet, p_link.ordered_feet, 0), 0)::integer
      else 0
    end,
    case app_api.film_order_link_receipt_status(p_link, p_box)
      when 'FINALIZED' then p_link.receipt_source_width_in
      else coalesce(p_box.width_in, p_order_width_in)
    end,
    p_order_width_in
  )
$$;

create or replace function app_api.film_order_link_received_feet(
  p_link app.film_order_box_links,
  p_box app.boxes,
  p_order_width_in numeric
)
returns integer
language sql
stable
as $$
  select case
    when app_api.film_order_link_receipt_status(p_link, p_box) = 'FINALIZED' then
      app_api.compute_covered_feet_from_allocation(
        greatest(coalesce(p_link.receipt_contribution_feet, 0), 0)::integer,
        p_link.receipt_source_width_in,
        p_order_width_in
      )
    else 0
  end
$$;

create or replace function app_api.guard_film_order_receipt_history_update()
returns trigger
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_mode text := upper(coalesce(current_setting('app.film_order_receipt_write_mode', true), ''));
  v_regular_fields_unchanged boolean;
begin
  v_regular_fields_unchanged :=
    old.id is not distinct from new.id
    and old.org_id is not distinct from new.org_id
    and old.link_id is not distinct from new.link_id
    and old.film_order_id is not distinct from new.film_order_id
    and old.box_id is not distinct from new.box_id
    and old.ordered_feet is not distinct from new.ordered_feet
    and old.auto_allocated_feet is not distinct from new.auto_allocated_feet
    and old.created_at is not distinct from new.created_at
    and old.created_by is not distinct from new.created_by;

  if v_mode = 'FINALIZE' then
    if old.receipt_contribution_feet is not null
       or old.receipt_source_width_in is not null
       or old.receipt_finalized_at is not null
       or old.receipt_finalized_by is not null
       or old.receipt_capture_source is not null
       or new.receipt_contribution_feet is null
       or new.receipt_source_width_in is null
       or new.receipt_finalized_at is null
       or btrim(coalesce(new.receipt_finalized_by, '')) = ''
       or new.receipt_capture_source <> 'LIVE_RECEIPT'
       or not v_regular_fields_unchanged then
      raise exception 'Film Order receipt finalization did not match the immutable transition contract.';
    end if;
    return new;
  end if;

  if v_mode = 'CORRECT' then
    if old.receipt_contribution_feet is null
       or new.receipt_contribution_feet is null
       or old.receipt_source_width_in is distinct from new.receipt_source_width_in
       or old.receipt_finalized_at is distinct from new.receipt_finalized_at
       or old.receipt_finalized_by is distinct from new.receipt_finalized_by
       or old.receipt_capture_source is distinct from new.receipt_capture_source
       or not v_regular_fields_unchanged then
      raise exception 'Film Order receipt correction may change only the historical receipt LF.';
    end if;
    return new;
  end if;

  raise exception 'Film Order receipt history can change only through finalization or audited correction.';
end;
$$;

drop trigger if exists trg_0199_guard_film_order_receipt_history on app.film_order_box_links;
create trigger trg_0199_guard_film_order_receipt_history
before update of
  receipt_contribution_feet,
  receipt_source_width_in,
  receipt_finalized_at,
  receipt_finalized_by,
  receipt_capture_source
on app.film_order_box_links
for each row execute function app_api.guard_film_order_receipt_history_update();

create or replace function app_api.capture_film_order_receipt_on_link_insert()
returns trigger
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_box app.boxes;
begin
  if new.receipt_contribution_feet is not null
     or new.receipt_source_width_in is not null
     or new.receipt_finalized_at is not null
     or new.receipt_finalized_by is not null
     or new.receipt_capture_source is not null then
    raise exception 'Film Order receipt history cannot be supplied during link creation.';
  end if;

  select *
  into v_box
  from app.boxes b
  where b.org_id = new.org_id
    and b.box_id = new.box_id;

  if found
     and v_box.received_date is not null
     and upper(coalesce(v_box.status::text, '')) <> 'ORDERED' then
    new.receipt_contribution_feet := greatest(coalesce(v_box.initial_feet, 0), 0)::integer;
    new.receipt_source_width_in := v_box.width_in;
    new.receipt_finalized_at := coalesce(v_box.received_date::timestamptz, new.created_at, now());
    new.receipt_finalized_by := app_api.current_film_order_actor(
      coalesce(
        nullif(current_setting('request.jwt.claim.email', true), ''),
        nullif(new.created_by, '')
      )
    );
    new.receipt_capture_source := 'LIVE_RECEIPT';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_0199_capture_film_order_receipt_on_link on app.film_order_box_links;
create trigger trg_0199_capture_film_order_receipt_on_link
before insert on app.film_order_box_links
for each row execute function app_api.capture_film_order_receipt_on_link_insert();

create or replace function app_api.film_order_box_snapshot(p_box app.boxes, p_link app.film_order_box_links)
returns jsonb
language sql
stable
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'boxId', p_box.box_id,
    'filmOrderId', p_link.film_order_id,
    'orderedFeet', p_link.ordered_feet,
    'autoAllocatedFeet', p_link.auto_allocated_feet,
    'initialFeet', p_box.initial_feet,
    'feetAvailable', p_box.feet_available,
    'status', p_box.status::text,
    'orderDate', p_box.order_date,
    'receivedDate', p_box.received_date,
    'receiptContributionFeet', p_link.receipt_contribution_feet,
    'receiptSourceWidthIn', p_link.receipt_source_width_in,
    'receiptFinalizedAt', p_link.receipt_finalized_at,
    'receiptFinalizedBy', p_link.receipt_finalized_by,
    'receiptCaptureSource', p_link.receipt_capture_source
  ))
$$;

create or replace function app_api.finalize_film_order_link_receipt(
  p_org_id uuid,
  p_link_id text,
  p_box_id text,
  p_actor text,
  p_finalized_at timestamptz default null
)
returns app.film_order_box_links
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_link app.film_order_box_links;
  v_before app.film_order_box_links;
  v_box app.boxes;
begin
  select *
  into v_link
  from app.film_order_box_links l
  where l.org_id = p_org_id
    and l.link_id = app_api.require_text(p_link_id, 'linkId')
    and l.box_id = app_api.require_text(p_box_id, 'boxId')
  for update;

  if not found then
    raise exception 'The Film Order receipt link was not found.' using errcode = 'P0002';
  end if;

  if v_link.receipt_contribution_feet is not null then
    return v_link;
  end if;

  select *
  into v_box
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = v_link.box_id;

  if not found then
    raise exception 'The linked box was not found.' using errcode = 'P0002';
  end if;

  if v_box.received_date is null
     or upper(coalesce(v_box.status::text, '')) = 'ORDERED' then
    raise exception 'Film Order receipt history can be finalized only after the linked box is received.';
  end if;

  v_before := v_link;
  begin
    perform set_config('app.film_order_receipt_write_mode', 'FINALIZE', true);
    update app.film_order_box_links l
    set
      receipt_contribution_feet = greatest(coalesce(v_box.initial_feet, 0), 0)::integer,
      receipt_source_width_in = v_box.width_in,
      receipt_finalized_at = coalesce(p_finalized_at, now()),
      receipt_finalized_by = app_api.current_film_order_actor(
        coalesce(
          nullif(current_setting('request.jwt.claim.email', true), ''),
          nullif(p_actor, '')
        )
      ),
      receipt_capture_source = 'LIVE_RECEIPT'
    where l.id = v_link.id
      and l.receipt_contribution_feet is null
    returning * into v_link;
    perform set_config('app.film_order_receipt_write_mode', '', true);
  exception when others then
    perform set_config('app.film_order_receipt_write_mode', '', true);
    raise;
  end;

  if v_link.receipt_contribution_feet is null then
    select * into v_link from app.film_order_box_links l where l.id = v_before.id;
    return v_link;
  end if;

  perform app_api.append_film_order_event(
    v_link.org_id,
    v_link.film_order_id,
    'FILM_ORDER_RECEIPT_FINALIZED',
    v_link.box_id,
    null,
    app_api.film_order_box_snapshot(v_box, v_before),
    app_api.film_order_box_snapshot(v_box, v_link),
    v_link.receipt_finalized_by,
    v_link.receipt_finalized_at,
    'Film Order receipt LF finalized.',
    'FILM_ORDER_RECEIPT_FINALIZED:' || v_link.link_id
  );

  return v_link;
end;
$$;

create or replace function app_api.trg_film_order_events_for_links()
returns trigger
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_box app.boxes;
begin
  if tg_op = 'INSERT' then
    perform app_api.append_film_order_event(
      new.org_id,
      new.film_order_id,
      'BOX_LINKED',
      new.box_id,
      null,
      null,
      to_jsonb(new),
      new.created_by,
      new.created_at,
      'Box linked to film order.',
      'BOX_LINKED:' || new.film_order_id || ':' || new.link_id
    );

    if new.receipt_contribution_feet is not null then
      select * into v_box
      from app.boxes b
      where b.org_id = new.org_id
        and b.box_id = new.box_id;

      perform app_api.append_film_order_event(
        new.org_id,
        new.film_order_id,
        'FILM_ORDER_RECEIPT_FINALIZED',
        new.box_id,
        null,
        null,
        app_api.film_order_box_snapshot(v_box, new),
        new.receipt_finalized_by,
        new.receipt_finalized_at,
        'Film Order receipt LF finalized.',
        'FILM_ORDER_RECEIPT_FINALIZED:' || new.link_id
      );
    end if;
    return new;
  end if;

  perform app_api.append_film_order_event(
    old.org_id,
    old.film_order_id,
    'BOX_LINK_REMOVED',
    old.box_id,
    null,
    to_jsonb(old),
    null,
    old.created_by,
    now(),
    'Box link removed from film order.'
  );
  return old;
end;
$$;

create or replace function app_api.trg_film_order_events_for_linked_boxes()
returns trigger
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_link app.film_order_box_links;
  v_actor text;
begin
  if tg_op = 'UPDATE' then
    v_actor := app_api.current_film_order_actor(
      coalesce(
        nullif(current_setting('request.jwt.claim.email', true), ''),
        nullif(new.updated_by, '')
      )
    );
    for v_link in
      select *
      from app.film_order_box_links l
      where l.org_id = new.org_id
        and l.box_id = new.box_id
    loop
      if old.initial_feet is distinct from new.initial_feet then
        perform app_api.append_film_order_event(
          new.org_id,
          v_link.film_order_id,
          'LINKED_BOX_INITIAL_FEET_CHANGED',
          new.box_id,
          null,
          app_api.film_order_box_snapshot(old, v_link),
          app_api.film_order_box_snapshot(new, v_link),
          v_actor,
          now(),
          'Linked box initial LF changed.'
        );
      end if;

      if (old.received_date is distinct from new.received_date or old.status is distinct from new.status)
         and new.received_date is not null
         and upper(coalesce(new.status::text, '')) <> 'ORDERED'
         and (old.received_date is null or upper(coalesce(old.status::text, '')) = 'ORDERED') then
        v_link := app_api.finalize_film_order_link_receipt(
          new.org_id,
          v_link.link_id,
          new.box_id,
          v_actor,
          now()
        );

        perform app_api.append_film_order_event(
          new.org_id,
          v_link.film_order_id,
          'LINKED_BOX_RECEIVED',
          new.box_id,
          null,
          app_api.film_order_box_snapshot(old, v_link),
          app_api.film_order_box_snapshot(new, v_link),
          v_actor,
          now(),
          'Linked box received.'
        );
      end if;
    end loop;
    return new;
  end if;

  v_actor := app_api.current_film_order_actor(
    coalesce(
      nullif(current_setting('request.jwt.claim.email', true), ''),
      nullif(old.updated_by, '')
    )
  );
  for v_link in
    select *
    from app.film_order_box_links l
    where l.org_id = old.org_id
      and l.box_id = old.box_id
  loop
    perform app_api.append_film_order_event(
      old.org_id,
      v_link.film_order_id,
      'LINKED_BOX_DELETED',
      old.box_id,
      null,
      app_api.film_order_box_snapshot(old, v_link),
      null,
      v_actor,
      now(),
      'Linked box deleted as correction workflow.'
    );
  end loop;

  delete from app.film_order_box_links l
  where l.org_id = old.org_id
    and l.box_id = old.box_id;

  return old;
end;
$$;

create or replace function app_api.film_order_ledger_projection(
  p_org_id uuid,
  p_film_order_ids text[]
)
returns table (
  film_order_id text,
  created_at timestamp with time zone,
  order_json jsonb
)
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  with scoped_orders as materialized (
    select f
    from app.film_orders f
    where f.org_id = p_org_id
      and coalesce(cardinality(p_film_order_ids), 0) > 0
      and f.film_order_id = any(p_film_order_ids)
  ),
  linked_capacity as materialized (
    select
      l.film_order_id,
      count(*) filter (where b.box_id is not null)::integer as linked_box_count,
      count(*) filter (
        where b.box_id is not null
          and app_api.film_order_link_receipt_status(l, b) = 'FINALIZED'
      )::integer as received_box_count,
      count(*) filter (
        where b.box_id is null
           or app_api.film_order_link_receipt_status(l, b) = 'MISSING'
      )::integer as missing_receipt_history_count,
      coalesce(
        sum(app_api.film_order_link_covered_feet(l, b, (so.f).width_in)) filter (where b.box_id is not null),
        0
      )::integer as linked_feet,
      coalesce(
        sum(app_api.film_order_link_received_feet(l, b, (so.f).width_in)) filter (where b.box_id is not null),
        0
      )::integer as received_feet,
      max(l.receipt_finalized_at) as received_date
    from scoped_orders so
    join app.film_order_box_links l
      on l.org_id = p_org_id
     and l.film_order_id = (so.f).film_order_id
    left join app.boxes b
      on b.org_id = l.org_id
     and b.box_id = l.box_id
    group by l.film_order_id, (so.f).width_in
  ),
  allocation_coverage as materialized (
    select
      a.film_order_id,
      coalesce(sum(coalesce(a.covered_feet, a.allocated_feet)), 0)::integer as covered_feet
    from app.allocations a
    join scoped_orders so
      on a.org_id = p_org_id
     and upper(a.film_order_id) = upper((so.f).film_order_id)
    where a.status <> 'CANCELLED'
    group by a.film_order_id
  ),
  latest_manual_fulfill as materialized (
    select distinct on (e.film_order_id)
      e.film_order_id,
      e.created_at as manual_fulfilled_at,
      e.actor as manual_fulfilled_by
    from app.film_order_events e
    join scoped_orders so
      on e.org_id = p_org_id
     and e.film_order_id = (so.f).film_order_id
    where e.event_type = 'FILM_ORDER_MANUALLY_FULFILLED'
    order by e.film_order_id, e.created_at desc, e.event_id desc
  ),
  metrics as (
    select
      so.f as order_row,
      greatest(coalesce((so.f).requested_feet, 0), 0)::integer as requested_feet,
      greatest(coalesce(capacity.linked_feet, 0), 0)::integer as linked_feet,
      greatest(coalesce(capacity.received_feet, 0), 0)::integer as received_feet,
      greatest(coalesce(coverage.covered_feet, 0), 0)::integer as covered_feet,
      greatest(coalesce(capacity.linked_box_count, 0), 0)::integer as linked_box_count,
      greatest(coalesce(capacity.received_box_count, 0), 0)::integer as received_box_count,
      greatest(coalesce(capacity.missing_receipt_history_count, 0), 0)::integer as missing_receipt_history_count,
      capacity.received_date,
      manual.manual_fulfilled_at,
      manual.manual_fulfilled_by
    from scoped_orders so
    left join linked_capacity capacity
      on capacity.film_order_id = (so.f).film_order_id
    left join allocation_coverage coverage
      on upper(coverage.film_order_id) = upper((so.f).film_order_id)
    left join latest_manual_fulfill manual
      on manual.film_order_id = (so.f).film_order_id
  ),
  canonical as (
    select
      metrics.*,
      greatest(metrics.linked_feet - metrics.received_feet, 0)::integer as on_the_way_feet,
      greatest(metrics.requested_feet - metrics.linked_feet, 0)::integer as remaining_to_order_feet,
      greatest(metrics.linked_feet - metrics.requested_feet, 0)::integer as order_overage_feet,
      greatest(metrics.received_feet, metrics.covered_feet)::integer as completed_feet,
      case
        when upper(coalesce((metrics.order_row).status::text, '')) = 'CANCELLED' then 'CANCELLED'
        when metrics.manual_fulfilled_at is not null
          and upper(coalesce((metrics.order_row).status::text, '')) = 'FULFILLED' then 'MANUALLY_FULFILLED'
        when metrics.missing_receipt_history_count > 0
          and upper(coalesce((metrics.order_row).status::text, '')) = 'FULFILLED' then 'FULFILLED_COVERED'
        when metrics.missing_receipt_history_count > 0
          and upper(coalesce((metrics.order_row).status::text, '')) = 'FILM_ON_THE_WAY' then 'FILM_ON_THE_WAY'
        when metrics.missing_receipt_history_count > 0 then 'FILM_ORDER'
        when metrics.linked_box_count > 0 and metrics.linked_feet < metrics.requested_feet then 'FILM_ORDER'
        when metrics.linked_box_count > 0 and metrics.received_box_count = metrics.linked_box_count then 'FULFILLED_COVERED'
        when metrics.linked_box_count > 0 then 'FILM_ON_THE_WAY'
        when metrics.covered_feet >= metrics.requested_feet and metrics.requested_feet > 0 then 'FULFILLED_COVERED'
        when upper(coalesce((metrics.order_row).status::text, '')) = 'FULFILLED' then 'FULFILLED_COVERED'
        when upper(coalesce((metrics.order_row).status::text, '')) = 'FILM_ON_THE_WAY' then 'FILM_ON_THE_WAY'
        else 'FILM_ORDER'
      end as display_status
    from metrics
  )
  select
    (canonical.order_row).film_order_id,
    (canonical.order_row).created_at,
    to_jsonb(canonical.order_row) || jsonb_strip_nulls(jsonb_build_object(
      'ordered_feet', canonical.linked_feet,
      'covered_feet', canonical.covered_feet,
      'remaining_to_order_feet', canonical.remaining_to_order_feet,
      'stored_status', (canonical.order_row).status::text,
      'display_status', canonical.display_status,
      'need_source', 'ORDER_REQUEST',
      'needed_feet', canonical.requested_feet,
      'fulfilled_feet', canonical.completed_feet,
      'remaining_feet', canonical.remaining_to_order_feet,
      'overage_feet', canonical.order_overage_feet,
      'linked_feet', canonical.linked_feet,
      'received_feet', canonical.received_feet,
      'on_the_way_feet', canonical.on_the_way_feet,
      'order_overage_feet', canonical.order_overage_feet,
      'completed_feet', canonical.completed_feet,
      'linked_box_count', canonical.linked_box_count,
      'received_box_count', canonical.received_box_count,
      'received_date', canonical.received_date,
      'receipt_history_complete', canonical.missing_receipt_history_count = 0,
      'receipt_history_missing_count', canonical.missing_receipt_history_count,
      'receipt_ledger_version', 'film-order-receipt-v1',
      'manual_fulfilled_at', canonical.manual_fulfilled_at,
      'manual_fulfilled_by', canonical.manual_fulfilled_by,
      'order_ledger_version', 'film-order-ledger-v2'
    )) as order_json
  from canonical;
$$;

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
  v_missing_receipt_history_count integer := 0;
  v_manually_fulfilled boolean := false;
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

  v_manually_fulfilled := exists (
    select 1
    from app.film_order_events e
    where e.org_id = p_org_id
      and e.film_order_id = v_existing.film_order_id
      and e.event_type = 'FILM_ORDER_MANUALLY_FULFILLED'
  );

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
    coalesce(sum(app_api.film_order_link_covered_feet(l, b, v_existing.width_in)), 0)::integer,
    count(*) filter (
      where b.box_id is not null
        and app_api.film_order_link_receipt_status(l, b) = 'FINALIZED'
    )::integer,
    count(*) filter (
      where b.box_id is null
         or app_api.film_order_link_receipt_status(l, b) = 'MISSING'
    )::integer
  into
    v_link_count,
    v_existing.ordered_feet,
    v_received_link_count,
    v_missing_receipt_history_count
  from app.film_order_box_links l
  left join app.boxes b
    on b.org_id = l.org_id
   and b.box_id = l.box_id
  where l.org_id = p_org_id
    and l.film_order_id = app_api.trim_text(p_film_order_id);

  if v_missing_receipt_history_count > 0 then
    return v_existing;
  end if;

  v_existing.remaining_to_order_feet := greatest(v_existing.requested_feet - v_existing.ordered_feet, 0);

  if v_existing.status <> 'CANCELLED' then
    if v_manually_fulfilled then
      v_existing.status := 'FULFILLED';
      if v_existing.resolved_at is null then
        v_existing.resolved_at := now();
        v_existing.resolved_by := app_api.trim_text(p_actor);
      end if;
    elsif v_link_count > 0 then
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
begin
  if to_regprocedure('app_api.api_acl_film_orders_get_pre_0199(uuid, text)') is null then
    alter function public.api_acl_film_orders_get(uuid, text)
      rename to api_acl_film_orders_get_pre_0199;
    alter function public.api_acl_film_orders_get_pre_0199(uuid, text)
      set schema app_api;
  end if;
end;
$$;

create or replace function public.api_acl_film_orders_get(
  p_org_id uuid,
  p_film_order_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_result jsonb;
  v_order app.film_orders;
  v_linked_boxes jsonb := '[]'::jsonb;
  v_missing_receipt_history_count integer := 0;
begin
  v_result := app_api.api_acl_film_orders_get_pre_0199(p_org_id, p_film_order_id);
  if v_result is null then
    return null;
  end if;

  select *
  into v_order
  from app.film_orders fo
  where fo.org_id = p_org_id
    and fo.film_order_id = app_api.require_text(p_film_order_id, 'filmOrderId');

  select
    coalesce(
      jsonb_agg(
        jsonb_strip_nulls(jsonb_build_object(
          'linkId', l.link_id,
          'boxId', l.box_id,
          'orderedFeet', l.ordered_feet,
          'linkedFeet', app_api.film_order_link_covered_feet(l, b, v_order.width_in),
          'receivedFeet', app_api.film_order_link_received_feet(l, b, v_order.width_in),
          'onTheWayFeet', greatest(
            app_api.film_order_link_covered_feet(l, b, v_order.width_in)
            - app_api.film_order_link_received_feet(l, b, v_order.width_in),
            0
          ),
          'receiptContributionFeet', l.receipt_contribution_feet,
          'receiptSourceWidthIn', l.receipt_source_width_in,
          'receiptFinalizedAt', l.receipt_finalized_at,
          'receiptFinalizedBy', l.receipt_finalized_by,
          'receiptCaptureSource', l.receipt_capture_source,
          'receiptHistoryStatus', app_api.film_order_link_receipt_status(l, b),
          'autoAllocatedFeet', l.auto_allocated_feet,
          'initialFeet', coalesce(b.initial_feet, 0),
          'feetAvailable', coalesce(b.feet_available, 0),
          'status', b.status::text,
          'dealer', b.dealer,
          'orderDate', b.order_date,
          'receivedDate', l.receipt_finalized_at,
          'isReceived', app_api.film_order_link_receipt_status(l, b) = 'FINALIZED',
          'isDirectToJobSite', coalesce(b.direct_to_job_site, false),
          'initialCost', b.purchase_cost
        ))
        order by l.created_at, l.link_id
      ) filter (where b.box_id is not null),
      '[]'::jsonb
    ),
    count(*) filter (
      where b.box_id is null
         or app_api.film_order_link_receipt_status(l, b) = 'MISSING'
    )::integer
  into v_linked_boxes, v_missing_receipt_history_count
  from app.film_order_box_links l
  left join app.boxes b
    on b.org_id = l.org_id
   and b.box_id = l.box_id
  where l.org_id = p_org_id
    and l.film_order_id = v_order.film_order_id;

  return v_result || jsonb_build_object(
    'linkedBoxes', v_linked_boxes,
    'receiptHistoryComplete', v_missing_receipt_history_count = 0,
    'receiptHistoryMissingCount', v_missing_receipt_history_count,
    'receiptLedgerVersion', 'film-order-receipt-v1',
    'orderLedgerVersion', 'film-order-ledger-v2'
  );
end;
$$;

create or replace function public.api_film_orders_correct_received_lf(
  p_org_id uuid,
  p_actor text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_film_order_id text := app_api.require_text(p_payload->>'filmOrderId', 'filmOrderId');
  v_link_id text := app_api.require_text(p_payload->>'linkId', 'linkId');
  v_box_id text := app_api.require_text(p_payload->>'boxId', 'boxId');
  v_corrected_text text := btrim(coalesce(p_payload->>'correctedReceivedFeet', ''));
  v_reason text := app_api.require_text(p_payload->>'reason', 'reason');
  v_actor text := app_api.current_film_order_actor(
    coalesce(
      nullif(current_setting('request.jwt.claim.email', true), ''),
      nullif(p_actor, '')
    )
  );
  v_corrected_feet integer;
  v_order app.film_orders;
  v_box app.boxes;
  v_before app.film_order_box_links;
  v_after app.film_order_box_links;
  v_before_credit integer;
  v_after_credit integer;
begin
  if v_corrected_text !~ '^[0-9]+$'
     or length(v_corrected_text) > 10 then
    raise exception 'Corrected Received LF must be a non-negative whole number.';
  end if;
  if v_corrected_text::numeric > 2147483647 then
    raise exception 'Corrected Received LF must be a non-negative whole number.';
  end if;
  v_corrected_feet := v_corrected_text::integer;

  if char_length(v_reason) > 500 then
    raise exception 'Receipt correction reason must be 500 characters or fewer.';
  end if;

  select *
  into v_order
  from app.film_orders fo
  where fo.org_id = p_org_id
    and fo.film_order_id = v_film_order_id
  for update;

  if not found then
    raise exception 'Film order was not found.' using errcode = 'P0002';
  end if;

  select *
  into v_before
  from app.film_order_box_links l
  where l.org_id = p_org_id
    and l.film_order_id = v_order.film_order_id
    and l.link_id = v_link_id
    and l.box_id = v_box_id
  for update;

  if not found then
    raise exception 'The selected Film Order receipt was not found.' using errcode = 'P0002';
  end if;

  if v_before.receipt_contribution_feet is null
     or v_before.receipt_source_width_in is null
     or v_before.receipt_finalized_at is null then
    raise exception 'Only a finalized Film Order receipt can be corrected.';
  end if;

  if v_before.receipt_contribution_feet = v_corrected_feet then
    raise exception 'Corrected Received LF must differ from the recorded value.';
  end if;

  select *
  into v_box
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = v_before.box_id;

  if not found then
    raise exception 'The linked box was not found.' using errcode = 'P0002';
  end if;

  v_before_credit := app_api.compute_covered_feet_from_allocation(
    v_before.receipt_contribution_feet,
    v_before.receipt_source_width_in,
    v_order.width_in
  );

  begin
    perform set_config('app.film_order_receipt_write_mode', 'CORRECT', true);
    update app.film_order_box_links l
    set receipt_contribution_feet = v_corrected_feet
    where l.id = v_before.id
    returning * into v_after;
    perform set_config('app.film_order_receipt_write_mode', '', true);
  exception when others then
    perform set_config('app.film_order_receipt_write_mode', '', true);
    raise;
  end;

  v_after_credit := app_api.compute_covered_feet_from_allocation(
    v_after.receipt_contribution_feet,
    v_after.receipt_source_width_in,
    v_order.width_in
  );

  perform app_api.append_film_order_event(
    p_org_id,
    v_order.film_order_id,
    'FILM_ORDER_RECEIPT_CORRECTED',
    v_after.box_id,
    v_order.requirement_id,
    jsonb_build_object(
      'filmOrderId', v_order.film_order_id,
      'linkId', v_before.link_id,
      'boxId', v_before.box_id,
      'receiptContributionFeet', v_before.receipt_contribution_feet,
      'receivedFeet', v_before_credit
    ),
    jsonb_build_object(
      'filmOrderId', v_order.film_order_id,
      'linkId', v_after.link_id,
      'boxId', v_after.box_id,
      'receiptContributionFeet', v_after.receipt_contribution_feet,
      'receivedFeet', v_after_credit
    ),
    v_actor,
    now(),
    v_reason
  );

  perform app_api.recalculate_film_order(p_org_id, v_order.film_order_id, v_actor);

  return jsonb_build_object(
    'filmOrderId', v_order.film_order_id,
    'linkId', v_after.link_id,
    'boxId', v_after.box_id,
    'previousReceivedFeet', v_before.receipt_contribution_feet,
    'correctedReceivedFeet', v_after.receipt_contribution_feet,
    'warnings', '[]'::jsonb
  );
end;
$$;

create or replace function public.api_acl_film_orders_correct_received_lf(
  p_org_id uuid,
  p_actor text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'film_orders', 'write');
  return public.api_film_orders_correct_received_lf(p_org_id, p_actor, p_payload);
end;
$$;

do $$
declare
  v_order record;
begin
  for v_order in
    select fo.org_id, fo.film_order_id
    from app.film_orders fo
    where not exists (
      select 1
      from app.film_order_box_links l
      left join app.boxes b
        on b.org_id = l.org_id
       and b.box_id = l.box_id
      where l.org_id = fo.org_id
        and l.film_order_id = fo.film_order_id
        and (
          b.box_id is null
          or app_api.film_order_link_receipt_status(l, b) = 'MISSING'
        )
    )
  loop
    perform app_api.recalculate_film_order(
      v_order.org_id,
      v_order.film_order_id,
      'migration:0199'
    );
  end loop;
end;
$$;

revoke execute on function app_api.api_acl_film_orders_get_pre_0199(uuid, text) from public, anon, authenticated, service_role;
revoke execute on function app_api.finalize_film_order_link_receipt(uuid, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function app_api.finalize_film_order_link_receipt(uuid, text, text, text, timestamptz) to service_role;

revoke execute on function public.api_film_orders_correct_received_lf(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.api_film_orders_correct_received_lf(uuid, text, jsonb) to service_role;
revoke execute on function public.api_acl_film_orders_correct_received_lf(uuid, text, jsonb) from public, anon;
grant execute on function public.api_acl_film_orders_correct_received_lf(uuid, text, jsonb) to authenticated, service_role;
revoke execute on function public.api_acl_film_orders_get(uuid, text) from public, anon;
grant execute on function public.api_acl_film_orders_get(uuid, text) to authenticated, service_role;

do $$
declare
  v_partial_count integer;
  v_ledger_def text;
  v_recalc_def text;
  v_correction_def text;
begin
  select count(*)::integer
  into v_partial_count
  from app.film_order_box_links l
  where (case when l.receipt_contribution_feet is null then 1 else 0 end)
      + (case when l.receipt_source_width_in is null then 1 else 0 end)
      + (case when l.receipt_finalized_at is null then 1 else 0 end)
      + (case when l.receipt_finalized_by is null then 1 else 0 end)
      + (case when l.receipt_capture_source is null then 1 else 0 end)
    not in (0, 5);

  if v_partial_count <> 0 then
    raise exception 'Film Order receipt history contains partial snapshots.';
  end if;

  select pg_get_functiondef('app_api.film_order_ledger_projection(uuid, text[])'::regprocedure)
  into v_ledger_def;
  select pg_get_functiondef('app_api.recalculate_film_order(uuid, text, text)'::regprocedure)
  into v_recalc_def;
  select pg_get_functiondef('public.api_film_orders_correct_received_lf(uuid, text, jsonb)'::regprocedure)
  into v_correction_def;

  if position('film_order_link_covered_feet' in v_ledger_def) = 0
     or position('film_order_link_received_feet' in v_ledger_def) = 0
     or position('film-order-ledger-v2' in v_ledger_def) = 0
     or position('box_physical_feet_available' in v_ledger_def) > 0 then
    raise exception 'Film Order receipt ledger guard failed.';
  end if;

  if position('film_order_link_covered_feet' in v_recalc_def) = 0
     or position('v_missing_receipt_history_count' in v_recalc_def) = 0
     or position('box_physical_feet_available' in v_recalc_def) > 0 then
    raise exception 'Film Order receipt recalculation guard failed.';
  end if;

  if position('FILM_ORDER_RECEIPT_CORRECTED' in v_correction_def) = 0
     or position('receipt_contribution_feet' in v_correction_def) = 0
     or position('initial_feet =' in v_correction_def) > 0
     or position('feet_available =' in v_correction_def) > 0 then
    raise exception 'Film Order receipt correction guard failed.';
  end if;
end;
$$;
