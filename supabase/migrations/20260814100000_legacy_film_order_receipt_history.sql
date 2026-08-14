-- Preserve incomplete legacy Film Order receipt aggregates without treating unknown links as zero.

alter table app.film_order_box_links
  drop constraint if exists film_order_box_links_receipt_history_complete;

alter table app.film_order_box_links
  add constraint film_order_box_links_receipt_history_complete
  check (
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
      and receipt_capture_source in ('LIVE_RECEIPT', 'AUDIT_BACKFILL', 'MANUAL_CORRECTION')
    )
  );

create or replace function app_api.guard_film_order_receipt_history_update()
returns trigger
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_mode text := upper(coalesce(current_setting('app.film_order_receipt_write_mode', true), ''));
  v_regular_fields_unchanged boolean;
  v_old_snapshot_missing boolean;
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

  v_old_snapshot_missing :=
    old.receipt_contribution_feet is null
    and old.receipt_source_width_in is null
    and old.receipt_finalized_at is null
    and old.receipt_finalized_by is null
    and old.receipt_capture_source is null;

  if v_mode = 'FINALIZE' then
    if not v_old_snapshot_missing
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
    if v_old_snapshot_missing then
      if new.receipt_contribution_feet is null
         or new.receipt_source_width_in is null
         or new.receipt_finalized_at is null
         or btrim(coalesce(new.receipt_finalized_by, '')) = ''
         or new.receipt_capture_source <> 'MANUAL_CORRECTION'
         or not v_regular_fields_unchanged then
        raise exception 'Legacy Film Order receipt correction did not establish one complete audited snapshot.';
      end if;
      return new;
    end if;

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

create or replace function app_api.film_order_link_covered_feet(
  p_link app.film_order_box_links,
  p_box app.boxes,
  p_order_width_in numeric
)
returns integer
language sql
stable
as $$
  select case app_api.film_order_link_receipt_status(p_link, p_box)
    when 'FINALIZED' then app_api.compute_covered_feet_from_allocation(
      greatest(p_link.receipt_contribution_feet, 0)::integer,
      p_link.receipt_source_width_in,
      p_order_width_in
    )
    when 'PENDING' then app_api.compute_covered_feet_from_allocation(
      greatest(coalesce(p_box.initial_feet, p_link.ordered_feet, 0), 0)::integer,
      coalesce(p_box.width_in, p_order_width_in),
      p_order_width_in
    )
    else null
  end
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
  select case app_api.film_order_link_receipt_status(p_link, p_box)
    when 'FINALIZED' then app_api.compute_covered_feet_from_allocation(
      greatest(p_link.receipt_contribution_feet, 0)::integer,
      p_link.receipt_source_width_in,
      p_order_width_in
    )
    when 'PENDING' then 0
    else null
  end
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
        sum(app_api.film_order_link_covered_feet(l, b, (so.f).width_in)) filter (
          where b.box_id is not null
            and app_api.film_order_link_receipt_status(l, b) <> 'MISSING'
        ),
        0
      )::integer as captured_linked_feet,
      coalesce(
        sum(app_api.film_order_link_received_feet(l, b, (so.f).width_in)) filter (
          where b.box_id is not null
            and app_api.film_order_link_receipt_status(l, b) <> 'MISSING'
        ),
        0
      )::integer as captured_received_feet,
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
  raw_metrics as (
    select
      so.f as order_row,
      greatest(coalesce((so.f).requested_feet, 0), 0)::integer as requested_feet,
      greatest(coalesce(capacity.captured_linked_feet, 0), 0)::integer as captured_linked_feet,
      greatest(coalesce(capacity.captured_received_feet, 0), 0)::integer as captured_received_feet,
      greatest(coalesce(coverage.covered_feet, 0), 0)::integer as current_covered_feet,
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
  metrics as (
    select
      raw_metrics.*,
      case
        when raw_metrics.missing_receipt_history_count > 0 then
          greatest(coalesce((raw_metrics.order_row).ordered_feet, 0), 0)::integer
        else raw_metrics.captured_linked_feet
      end as linked_feet,
      case
        when raw_metrics.missing_receipt_history_count > 0
          and upper(coalesce((raw_metrics.order_row).status::text, '')) = 'FULFILLED' then
          greatest(coalesce((raw_metrics.order_row).ordered_feet, 0), 0)::integer
        when raw_metrics.missing_receipt_history_count > 0 then null
        else raw_metrics.captured_received_feet
      end as received_feet,
      case
        when raw_metrics.missing_receipt_history_count > 0 then
          greatest(coalesce((raw_metrics.order_row).covered_feet, 0), 0)::integer
        else raw_metrics.current_covered_feet
      end as covered_feet,
      case
        when raw_metrics.missing_receipt_history_count > 0 then
          greatest(coalesce((raw_metrics.order_row).remaining_to_order_feet, 0), 0)::integer
        else greatest(raw_metrics.requested_feet - raw_metrics.captured_linked_feet, 0)::integer
      end as remaining_to_order_feet
    from raw_metrics
  ),
  canonical as (
    select
      metrics.*,
      case
        when metrics.received_feet is null then null
        else greatest(metrics.linked_feet - metrics.received_feet, 0)::integer
      end as on_the_way_feet,
      greatest(metrics.linked_feet - metrics.requested_feet, 0)::integer as order_overage_feet,
      greatest(coalesce(metrics.received_feet, 0), metrics.covered_feet)::integer as completed_feet,
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
      'receipt_totals_source', case
        when canonical.missing_receipt_history_count > 0 then 'STORED_LEGACY_AGGREGATE'
        else 'CAPTURED_SNAPSHOTS'
      end,
      'receipt_ledger_version', 'film-order-receipt-v2',
      'manual_fulfilled_at', canonical.manual_fulfilled_at,
      'manual_fulfilled_by', canonical.manual_fulfilled_by,
      'order_ledger_version', 'film-order-ledger-v2'
    )) as order_json
  from canonical;
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
          'onTheWayFeet', case
            when app_api.film_order_link_covered_feet(l, b, v_order.width_in) is null
              or app_api.film_order_link_received_feet(l, b, v_order.width_in) is null then null
            else greatest(
              app_api.film_order_link_covered_feet(l, b, v_order.width_in)
              - app_api.film_order_link_received_feet(l, b, v_order.width_in),
              0
            )
          end,
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
    'receiptTotalsSource', case
      when v_missing_receipt_history_count > 0 then 'STORED_LEGACY_AGGREGATE'
      else 'CAPTURED_SNAPSHOTS'
    end,
    'receiptLedgerVersion', 'film-order-receipt-v2',
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
  v_establishing_legacy_snapshot boolean := false;
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

  select *
  into v_box
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = v_before.box_id;

  if not found then
    raise exception 'The linked box was not found.' using errcode = 'P0002';
  end if;

  v_establishing_legacy_snapshot :=
    v_before.receipt_contribution_feet is null
    and v_before.receipt_source_width_in is null
    and v_before.receipt_finalized_at is null
    and v_before.receipt_finalized_by is null
    and v_before.receipt_capture_source is null;

  if v_establishing_legacy_snapshot then
    if upper(coalesce(v_box.status::text, '')) = 'ORDERED'
       or coalesce(v_box.width_in, 0) <= 0 then
      raise exception 'Missing receipt history can be corrected only for a received linked box with a valid width.';
    end if;
    v_before_credit := null;
  else
    if v_before.receipt_contribution_feet is null
       or v_before.receipt_source_width_in is null
       or v_before.receipt_finalized_at is null then
      raise exception 'Only a complete or wholly missing Film Order receipt can be corrected.';
    end if;
    if v_before.receipt_contribution_feet = v_corrected_feet then
      raise exception 'Corrected Received LF must differ from the recorded value.';
    end if;
    v_before_credit := app_api.compute_covered_feet_from_allocation(
      v_before.receipt_contribution_feet,
      v_before.receipt_source_width_in,
      v_order.width_in
    );
  end if;

  begin
    perform set_config('app.film_order_receipt_write_mode', 'CORRECT', true);
    if v_establishing_legacy_snapshot then
      update app.film_order_box_links l
      set
        receipt_contribution_feet = v_corrected_feet,
        receipt_source_width_in = v_box.width_in,
        receipt_finalized_at = now(),
        receipt_finalized_by = v_actor,
        receipt_capture_source = 'MANUAL_CORRECTION'
      where l.id = v_before.id
      returning * into v_after;
    else
      update app.film_order_box_links l
      set receipt_contribution_feet = v_corrected_feet
      where l.id = v_before.id
      returning * into v_after;
    end if;
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
      'receivedFeet', v_before_credit,
      'receiptHistoryStatus', case when v_establishing_legacy_snapshot then 'MISSING' else 'FINALIZED' end
    ),
    jsonb_build_object(
      'filmOrderId', v_order.film_order_id,
      'linkId', v_after.link_id,
      'boxId', v_after.box_id,
      'receiptContributionFeet', v_after.receipt_contribution_feet,
      'receivedFeet', v_after_credit,
      'receiptHistoryStatus', 'FINALIZED',
      'receiptCaptureSource', v_after.receipt_capture_source
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

do $$
declare
  v_linked_def text;
  v_received_def text;
  v_ledger_def text;
  v_correction_def text;
  v_guard_def text;
begin
  select pg_get_functiondef('app_api.film_order_link_covered_feet(app.film_order_box_links, app.boxes, numeric)'::regprocedure)
  into v_linked_def;
  select pg_get_functiondef('app_api.film_order_link_received_feet(app.film_order_box_links, app.boxes, numeric)'::regprocedure)
  into v_received_def;
  select pg_get_functiondef('app_api.film_order_ledger_projection(uuid, text[])'::regprocedure)
  into v_ledger_def;
  select pg_get_functiondef('public.api_film_orders_correct_received_lf(uuid, text, jsonb)'::regprocedure)
  into v_correction_def;
  select pg_get_functiondef('app_api.guard_film_order_receipt_history_update()'::regprocedure)
  into v_guard_def;

  if position('else null' in lower(v_linked_def)) = 0
     or position('else null' in lower(v_received_def)) = 0 then
    raise exception 'Missing Film Order receipt history is still represented as numeric zero.';
  end if;
  if position('STORED_LEGACY_AGGREGATE' in v_ledger_def) = 0
     or position('film-order-receipt-v2' in v_ledger_def) = 0 then
    raise exception 'Film Order legacy aggregate preservation is incomplete.';
  end if;
  if position('MANUAL_CORRECTION' in v_correction_def) = 0
     or position('v_establishing_legacy_snapshot' in v_correction_def) = 0
     or position('MANUAL_CORRECTION' in v_guard_def) = 0 then
    raise exception 'Legacy Film Order receipt correction is incomplete.';
  end if;
end
$$;

revoke execute on function app_api.film_order_link_covered_feet(app.film_order_box_links, app.boxes, numeric) from public, anon, authenticated, service_role;
revoke execute on function app_api.film_order_link_received_feet(app.film_order_box_links, app.boxes, numeric) from public, anon, authenticated, service_role;
revoke execute on function app_api.film_order_ledger_projection(uuid, text[]) from public, anon, authenticated, service_role;
revoke execute on function app_api.guard_film_order_receipt_history_update() from public, anon, authenticated, service_role;
revoke execute on function public.api_film_orders_correct_received_lf(uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function public.api_acl_film_orders_get(uuid, text) from public, anon;

select app_api.grant_execute_if_exists('public.api_film_orders_correct_received_lf(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_film_orders_get(uuid, text)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_film_orders_get(uuid, text)', 'service_role');
