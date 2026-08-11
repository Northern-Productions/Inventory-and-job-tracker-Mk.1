-- Keep Film Order reads order-scoped while exposing current requirement context separately.

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
          and upper(coalesce(b.status::text, '')) <> 'ORDERED'
      )::integer as received_box_count,
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
            coalesce(b.width_in, (so.f).width_in),
            (so.f).width_in
          )
        ) filter (where b.box_id is not null),
        0
      )::integer as linked_feet,
      coalesce(
        sum(
          app_api.compute_covered_feet_from_allocation(
            case
              when upper(coalesce(b.status::text, '')) in ('IN_STOCK', 'TRANSFER') then
                greatest(coalesce(app_api.box_physical_feet_available(b), b.feet_available, 0), 0)::integer
              else
                greatest(coalesce(b.initial_feet, l.ordered_feet, 0), 0)::integer
            end,
            coalesce(b.width_in, (so.f).width_in),
            (so.f).width_in
          )
        ) filter (
          where b.box_id is not null
            and upper(coalesce(b.status::text, '')) <> 'ORDERED'
        ),
        0
      )::integer as received_feet,
      max(b.received_date) filter (
        where b.box_id is not null
          and upper(coalesce(b.status::text, '')) <> 'ORDERED'
      ) as received_date
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
      'manual_fulfilled_at', canonical.manual_fulfilled_at,
      'manual_fulfilled_by', canonical.manual_fulfilled_by,
      'order_ledger_version', 'film-order-ledger-v1'
    )) as order_json
  from canonical;
$$;

create or replace function public.api_list_film_orders(
  p_org_id uuid,
  p_warehouse text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_result jsonb;
  v_warehouse text := upper(app_api.trim_text(p_warehouse));
  v_film_order_ids text[];
begin
  perform app_api.require_org_member(p_org_id);

  if v_warehouse = 'ALL' then
    v_warehouse := '';
  elsif v_warehouse <> '' then
    v_warehouse := app_api.require_org_warehouse(p_org_id, v_warehouse, 'Warehouse');
  end if;

  select coalesce(array_agg(f.film_order_id), array[]::text[])
  into v_film_order_ids
  from app.film_orders f
  where f.org_id = p_org_id
    and (v_warehouse = '' or upper(trim(f.warehouse::text)) = v_warehouse);

  select coalesce(
    jsonb_agg(ledger.order_json order by ledger.created_at desc, ledger.film_order_id desc),
    '[]'::jsonb
  )
  into v_result
  from app_api.film_order_ledger_projection(p_org_id, v_film_order_ids) ledger;

  return v_result;
end;
$$;

create or replace function public.api_list_film_orders_by_job(
  p_org_id uuid,
  p_job_number text
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_result jsonb;
  v_film_order_ids text[];
begin
  perform app_api.require_org_member(p_org_id);

  select coalesce(array_agg(f.film_order_id), array[]::text[])
  into v_film_order_ids
  from app.film_orders f
  where f.org_id = p_org_id
    and upper(f.job_number) = upper(app_api.trim_text(p_job_number));

  select coalesce(
    jsonb_agg(ledger.order_json order by ledger.created_at desc, ledger.film_order_id desc),
    '[]'::jsonb
  )
  into v_result
  from app_api.film_order_ledger_projection(p_org_id, v_film_order_ids) ledger;

  return v_result;
end;
$$;

create or replace function public.api_list_film_orders_by_job_id(
  p_org_id uuid,
  p_job_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_result jsonb;
  v_film_order_ids text[];
begin
  perform app_api.require_org_member(p_org_id);

  if not exists (
    select 1
    from app.jobs j
    where j.org_id = p_org_id
      and j.id = p_job_id
  ) then
    return '[]'::jsonb;
  end if;

  select coalesce(array_agg(f.film_order_id), array[]::text[])
  into v_film_order_ids
  from app.film_orders f
  where f.org_id = p_org_id
    and f.job_id = p_job_id;

  select coalesce(
    jsonb_agg(ledger.order_json order by ledger.created_at desc, ledger.film_order_id desc),
    '[]'::jsonb
  )
  into v_result
  from app_api.film_order_ledger_projection(p_org_id, v_film_order_ids) ledger;

  return v_result;
end;
$$;

create or replace function public.api_acl_list_film_orders_by_job_id(
  p_org_id uuid,
  p_job_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'film_orders', 'read');
  return public.api_list_film_orders_by_job_id(p_org_id, p_job_id);
end;
$$;

create or replace function public.api_find_film_order_by_id(
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
begin
  perform app_api.require_org_member(p_org_id);

  select ledger.order_json
  into v_result
  from app_api.film_order_ledger_projection(
    p_org_id,
    array[app_api.require_text(p_film_order_id, 'filmOrderId')]
  ) ledger;

  return v_result;
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
  v_order app.film_orders;
  v_order_ledger jsonb;
  v_job app.jobs;
  v_requirement app.job_requirements;
  v_phase app.job_phases;
  v_requirement_found boolean := false;
  v_requirement_matches boolean := false;
  v_requirement_context_status text := 'HISTORICAL_UNBOUND';
  v_linked_boxes jsonb := '[]'::jsonb;
  v_history jsonb := '[]'::jsonb;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'film_orders', 'read');

  select *
  into v_order
  from app.film_orders fo
  where fo.org_id = p_org_id
    and fo.film_order_id = app_api.require_text(p_film_order_id, 'filmOrderId');

  if not found then
    return null;
  end if;

  select ledger.order_json
  into v_order_ledger
  from app_api.film_order_ledger_projection(p_org_id, array[v_order.film_order_id]) ledger;

  if v_order.job_id is not null then
    select *
    into v_job
    from app.jobs j
    where j.org_id = p_org_id
      and j.id = v_order.job_id;
  end if;

  if v_order.requirement_id is not null then
    select *
    into v_requirement
    from app.job_requirements r
    where r.org_id = p_org_id
      and r.id = v_order.requirement_id;
    v_requirement_found := found;

    if v_requirement_found then
      select *
      into v_phase
      from app.job_phases p
      where p.org_id = p_org_id
        and p.id = v_requirement.phase_id;

      v_requirement_matches := app_api.film_order_matches_requirement(
        p_org_id,
        v_requirement.id,
        v_requirement.manufacturer,
        v_requirement.film_name,
        v_requirement.width_in,
        v_order.requirement_id,
        v_order.manufacturer,
        v_order.film_name,
        v_order.width_in
      );
    end if;
  end if;

  v_requirement_context_status := case
    when v_order.requirement_id is null then 'HISTORICAL_UNBOUND'
    when v_requirement_found and v_requirement_matches then 'CURRENT'
    else 'UNAVAILABLE'
  end;

  select coalesce(
    jsonb_agg(
      jsonb_strip_nulls(jsonb_build_object(
        'linkId', l.link_id,
        'boxId', l.box_id,
        'orderedFeet', l.ordered_feet,
        'linkedFeet', app_api.compute_covered_feet_from_allocation(
          case
            when upper(coalesce(b.status::text, '')) = 'ORDERED' then
              greatest(coalesce(b.initial_feet, l.ordered_feet, 0), 0)::integer
            when upper(coalesce(b.status::text, '')) in ('IN_STOCK', 'TRANSFER') then
              greatest(coalesce(app_api.box_physical_feet_available(b), b.feet_available, 0), 0)::integer
            else
              greatest(coalesce(b.initial_feet, l.ordered_feet, 0), 0)::integer
          end,
          coalesce(b.width_in, v_order.width_in),
          v_order.width_in
        ),
        'receivedFeet', case
          when upper(coalesce(b.status::text, '')) <> 'ORDERED' then
            app_api.compute_covered_feet_from_allocation(
              case
                when upper(coalesce(b.status::text, '')) in ('IN_STOCK', 'TRANSFER') then
                  greatest(coalesce(app_api.box_physical_feet_available(b), b.feet_available, 0), 0)::integer
                else
                  greatest(coalesce(b.initial_feet, l.ordered_feet, 0), 0)::integer
              end,
              coalesce(b.width_in, v_order.width_in),
              v_order.width_in
            )
          else 0
        end,
        'onTheWayFeet', case
          when upper(coalesce(b.status::text, '')) = 'ORDERED' then
            app_api.compute_covered_feet_from_allocation(
              greatest(coalesce(b.initial_feet, l.ordered_feet, 0), 0)::integer,
              coalesce(b.width_in, v_order.width_in),
              v_order.width_in
            )
          else 0
        end,
        'autoAllocatedFeet', l.auto_allocated_feet,
        'initialFeet', coalesce(b.initial_feet, 0),
        'feetAvailable', coalesce(b.feet_available, 0),
        'status', b.status::text,
        'dealer', b.dealer,
        'orderDate', b.order_date,
        'receivedDate', b.received_date,
        'isReceived', (b.box_id is not null and upper(coalesce(b.status::text, '')) <> 'ORDERED'),
        'isDirectToJobSite', coalesce(b.direct_to_job_site, false),
        'initialCost', b.purchase_cost
      ))
      order by l.created_at, l.link_id
    ) filter (where b.box_id is not null),
    '[]'::jsonb
  )
  into v_linked_boxes
  from app.film_order_box_links l
  left join app.boxes b
    on b.org_id = l.org_id
   and b.box_id = l.box_id
  where l.org_id = p_org_id
    and l.film_order_id = v_order.film_order_id;

  select coalesce(
    jsonb_agg(
      jsonb_strip_nulls(jsonb_build_object(
        'eventId', e.event_id,
        'eventType', e.event_type,
        'filmOrderId', e.film_order_id,
        'relatedBoxId', nullif(e.related_box_id, ''),
        'relatedRequirementId', e.related_requirement_id,
        'actor', e.actor,
        'note', e.note,
        'before', e.before_state,
        'after', e.after_state,
        'createdAt', e.created_at
      ))
      order by e.created_at desc, e.event_id desc
    ),
    '[]'::jsonb
  )
  into v_history
  from app.film_order_events e
  where e.org_id = p_org_id
    and e.film_order_id = v_order.film_order_id;

  return jsonb_strip_nulls(jsonb_build_object(
    'filmOrderId', v_order.film_order_id,
    'jobId', v_order.job_id,
    'requirementId', v_order.requirement_id,
    'jobNumber', v_order.job_number,
    'warehouse', v_order.warehouse,
    'workScope', coalesce(v_phase.sections, v_job.sections, ''),
    'sections', coalesce(v_phase.sections, v_job.sections, ''),
    'manufacturer', v_order.manufacturer,
    'filmName', v_order.film_name,
    'widthIn', v_order.width_in,
    'requestedFeet', (v_order_ledger->>'requested_feet')::integer,
    'linkedFeet', (v_order_ledger->>'linked_feet')::integer,
    'orderedFeet', (v_order_ledger->>'linked_feet')::integer,
    'receivedFeet', (v_order_ledger->>'received_feet')::integer,
    'onTheWayFeet', (v_order_ledger->>'on_the_way_feet')::integer,
    'coveredFeet', (v_order_ledger->>'covered_feet')::integer,
    'remainingToOrderFeet', (v_order_ledger->>'remaining_to_order_feet')::integer,
    'orderOverageFeet', (v_order_ledger->>'order_overage_feet')::integer,
    'completedFeet', (v_order_ledger->>'completed_feet')::integer,
    'installDate', v_order.job_date,
    'crewLeader', v_order.crew_leader,
    'status', v_order.status::text,
    'storedStatus', v_order.status::text,
    'displayStatus', v_order_ledger->>'display_status',
    'needSource', 'ORDER_REQUEST',
    'neededFeet', (v_order_ledger->>'requested_feet')::integer,
    'fulfilledFeet', (v_order_ledger->>'completed_feet')::integer,
    'remainingFeet', (v_order_ledger->>'remaining_to_order_feet')::integer,
    'overageFeet', (v_order_ledger->>'order_overage_feet')::integer,
    'requirementContextStatus', v_requirement_context_status,
    'sourceBoxId', v_order.source_box_id,
    'origin', case
      when app_api.trim_text(v_order.source_box_id) = '' then 'MANUAL'
      else 'AUTO_SHORTAGE'
    end,
    'manualFulfilledAt', v_order_ledger->'manual_fulfilled_at',
    'manualFulfilledBy', v_order_ledger->>'manual_fulfilled_by',
    'createdAt', v_order.created_at,
    'createdBy', v_order.created_by,
    'resolvedAt', v_order.resolved_at,
    'resolvedBy', v_order.resolved_by,
    'orderedDate', v_order.created_at::date,
    'receivedDate', v_order_ledger->'received_date',
    'notes', v_order.notes,
    'orderLedgerVersion', 'film-order-ledger-v1',
    'job', case when v_order.job_id is null then null else jsonb_strip_nulls(jsonb_build_object(
      'jobId', v_order.job_id,
      'jobNumber', v_order.job_number,
      'warehouse', coalesce(v_job.warehouse, v_order.warehouse),
      'workScope', v_job.sections,
      'sections', v_job.sections
    )) end,
    'phase', case when v_phase.id is null then null else jsonb_strip_nulls(jsonb_build_object(
      'phaseId', v_phase.id,
      'phaseNumber', v_phase.phase_number,
      'workScope', v_phase.sections,
      'sections', v_phase.sections,
      'installDate', v_phase.install_date,
      'crewLeader', v_phase.crew_leader
    )) end,
    'requirement', case when v_requirement_found then jsonb_strip_nulls(jsonb_build_object(
      'requirementId', v_requirement.id,
      'phaseId', v_requirement.phase_id,
      'manufacturer', v_requirement.manufacturer,
      'filmName', v_requirement.film_name,
      'widthIn', v_requirement.width_in,
      'requiredFeet', v_requirement.required_feet,
      'status', v_requirement.status,
      'matchesFilmOrder', v_requirement_matches
    )) else null end,
    'linkedBoxes', v_linked_boxes,
    'history', v_history
  ));
end;
$$;

do $$
declare
  v_ledger_def text;
  v_list_def text;
  v_detail_def text;
begin
  select pg_get_functiondef('app_api.film_order_ledger_projection(uuid, text[])'::regprocedure)
  into v_ledger_def;

  select pg_get_functiondef('public.api_list_film_orders(uuid, text)'::regprocedure)
  into v_list_def;

  select pg_get_functiondef('public.api_acl_film_orders_get(uuid, text)'::regprocedure)
  into v_detail_def;

  if position('app_api.compute_covered_feet_from_allocation(' in v_ledger_def) = 0
     or position('app_api.box_physical_feet_available(b)' in v_ledger_def) = 0
     or position('remaining_to_order_feet' in v_ledger_def) = 0
     or position('order_overage_feet' in v_ledger_def) = 0
     or position('on_the_way_feet' in v_ledger_def) = 0
     or position('ORDER_REQUEST' in v_ledger_def) = 0 then
    raise exception 'film-order order-ledger projection guard failed';
  end if;

  if position('app_api.film_order_ledger_projection(' in v_list_def) = 0
     or position('app_api.film_order_ledger_projection(' in v_detail_def) = 0
     or position('requirementContextStatus' in v_detail_def) = 0
     or position('initialCost' in v_detail_def) = 0 then
    raise exception 'film-order list/detail parity guard failed';
  end if;
end;
$$;

revoke execute on function app_api.film_order_ledger_projection(uuid, text[]) from public, anon, authenticated, service_role;
revoke execute on function public.api_list_film_orders_by_job_id(uuid, uuid) from public, anon, authenticated, service_role;
revoke execute on function public.api_acl_list_film_orders_by_job_id(uuid, uuid) from public, anon, service_role;
grant execute on function public.api_acl_list_film_orders_by_job_id(uuid, uuid) to authenticated;
