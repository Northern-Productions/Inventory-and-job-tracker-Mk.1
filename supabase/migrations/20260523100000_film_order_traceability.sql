/**
 * PURPOSE:
 * Adds film order traceability reads, history events, and linked-box
 * correction support without changing the compact film order list contract.
 *
 * AFFECTS:
 * app.film_order_events, scoped film order detail/origin reads, linked box
 * event triggers, requirement-change history, and box delete correction.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * backend runtime film-order reads, Supabase Edge api-handler/read handlers,
 * frontend Film Order Details and Box Origin UI, and schema/latest guard.
 */

create table if not exists app.film_order_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations(id) on delete cascade,
  event_id text not null,
  film_order_id text not null,
  event_type text not null,
  related_box_id text not null default '',
  related_requirement_id uuid,
  actor text not null default '',
  note text not null default '',
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null default now(),
  constraint film_order_events_event_type_present check (btrim(event_type) <> ''),
  constraint film_order_events_film_order_id_present check (btrim(film_order_id) <> ''),
  constraint film_order_events_org_event_unique unique (org_id, event_id)
);

alter table app.film_order_events enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'app'
      and tablename = 'film_order_events'
      and policyname = 'film_order_events_rw'
  ) then
    create policy film_order_events_rw on app.film_order_events
      for all using (app.is_org_member(org_id)) with check (app.is_org_member(org_id));
  end if;
end $$;

create index if not exists idx_film_order_events_org_order_created
  on app.film_order_events (org_id, film_order_id, created_at desc, event_id desc);

create index if not exists idx_film_order_events_org_box_created
  on app.film_order_events (org_id, related_box_id, created_at desc)
  where related_box_id <> '';

create index if not exists idx_film_order_events_org_requirement_created
  on app.film_order_events (org_id, related_requirement_id, created_at desc)
  where related_requirement_id is not null;

create or replace function app_api.current_film_order_actor(p_fallback text default '')
returns text
language sql
stable
as $$
  select coalesce(nullif(current_setting('app.actor', true), ''), nullif(app_api.trim_text(p_fallback), ''), 'system')
$$;

create or replace function app_api.append_film_order_event(
  p_org_id uuid,
  p_film_order_id text,
  p_event_type text,
  p_related_box_id text default '',
  p_related_requirement_id uuid default null,
  p_before_state jsonb default null,
  p_after_state jsonb default null,
  p_actor text default '',
  p_created_at timestamptz default null,
  p_note text default '',
  p_event_id text default ''
)
returns text
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_film_order_id text := app_api.trim_text(p_film_order_id);
  v_event_type text := upper(app_api.trim_text(p_event_type));
  v_event_id text := app_api.trim_text(p_event_id);
begin
  if v_film_order_id = '' or v_event_type = '' then
    return '';
  end if;

  if v_event_id = '' then
    v_event_id := app_api.create_log_id();
  end if;

  insert into app.film_order_events (
    org_id,
    event_id,
    film_order_id,
    event_type,
    related_box_id,
    related_requirement_id,
    actor,
    note,
    before_state,
    after_state,
    created_at
  )
  values (
    p_org_id,
    v_event_id,
    v_film_order_id,
    v_event_type,
    app_api.trim_text(p_related_box_id),
    p_related_requirement_id,
    app_api.current_film_order_actor(p_actor),
    app_api.trim_text(p_note),
    p_before_state,
    p_after_state,
    coalesce(p_created_at, now())
  )
  on conflict (org_id, event_id) do nothing;

  return v_event_id;
end;
$$;

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
    'receivedDate', p_box.received_date
  ))
$$;

create or replace function app_api.trg_film_order_events_for_orders()
returns trigger
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_event_type text;
  v_note text;
begin
  if tg_op = 'INSERT' then
    perform app_api.append_film_order_event(
      new.org_id,
      new.film_order_id,
      'FILM_ORDER_CREATED',
      '',
      new.requirement_id,
      null,
      to_jsonb(new),
      new.created_by,
      new.created_at,
      'Film order created.',
      'FILM_ORDER_CREATED:' || new.film_order_id
    );
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if old.status is distinct from new.status then
      v_event_type := case
        when upper(coalesce(new.status::text, '')) = 'CANCELLED' then 'FILM_ORDER_CANCELLED'
        when upper(coalesce(new.status::text, '')) = 'FULFILLED' then 'FILM_ORDER_FULFILLED'
        else 'FILM_ORDER_STATUS_CHANGED'
      end;
      v_note := format('Film order status changed from %s to %s.', old.status::text, new.status::text);
      perform app_api.append_film_order_event(
        new.org_id,
        new.film_order_id,
        v_event_type,
        '',
        new.requirement_id,
        to_jsonb(old),
        to_jsonb(new),
        coalesce(nullif(new.resolved_by, ''), new.created_by),
        now(),
        v_note
      );
    elsif old.requested_feet is distinct from new.requested_feet
       or old.covered_feet is distinct from new.covered_feet
       or old.ordered_feet is distinct from new.ordered_feet
       or old.remaining_to_order_feet is distinct from new.remaining_to_order_feet
       or old.requirement_id is distinct from new.requirement_id then
      perform app_api.append_film_order_event(
        new.org_id,
        new.film_order_id,
        'FILM_ORDER_UPDATED',
        '',
        new.requirement_id,
        to_jsonb(old),
        to_jsonb(new),
        new.created_by,
        now(),
        'Film order planning data changed.'
      );
    end if;
    return new;
  end if;

  perform app_api.append_film_order_event(
    old.org_id,
    old.film_order_id,
    'FILM_ORDER_DELETED',
    '',
    old.requirement_id,
    to_jsonb(old),
    null,
    old.resolved_by,
    now(),
    'Film order deleted.'
  );
  return old;
end;
$$;

drop trigger if exists trg_film_order_events_for_orders on app.film_orders;
create trigger trg_film_order_events_for_orders
after insert or update or delete on app.film_orders
for each row execute function app_api.trg_film_order_events_for_orders();

create or replace function app_api.trg_film_order_events_for_links()
returns trigger
language plpgsql
security definer
set search_path = public, app, app_api
as $$
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

drop trigger if exists trg_film_order_events_for_links on app.film_order_box_links;
create trigger trg_film_order_events_for_links
after insert or delete on app.film_order_box_links
for each row execute function app_api.trg_film_order_events_for_links();

create or replace function app_api.trg_film_order_events_for_linked_boxes()
returns trigger
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_link app.film_order_box_links;
begin
  if tg_op = 'UPDATE' then
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
          new.updated_by,
          now(),
          'Linked box initial LF changed.'
        );
      end if;

      if old.received_date is distinct from new.received_date
         or old.status is distinct from new.status then
        if new.received_date is not null
           and upper(coalesce(new.status::text, '')) <> 'ORDERED'
           and (
             old.received_date is null
             or upper(coalesce(old.status::text, '')) = 'ORDERED'
           ) then
          perform app_api.append_film_order_event(
            new.org_id,
            v_link.film_order_id,
            'LINKED_BOX_RECEIVED',
            new.box_id,
            null,
            app_api.film_order_box_snapshot(old, v_link),
            app_api.film_order_box_snapshot(new, v_link),
            new.updated_by,
            coalesce(new.received_date::timestamptz, now()),
            'Linked box received.'
          );
        end if;
      end if;
    end loop;
    return new;
  end if;

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
      old.updated_by,
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

drop trigger if exists trg_film_order_events_for_linked_boxes_update on app.boxes;
create trigger trg_film_order_events_for_linked_boxes_update
after update of initial_feet, status, received_date on app.boxes
for each row execute function app_api.trg_film_order_events_for_linked_boxes();

drop trigger if exists trg_film_order_events_for_linked_boxes_delete on app.boxes;
create trigger trg_film_order_events_for_linked_boxes_delete
before delete on app.boxes
for each row execute function app_api.trg_film_order_events_for_linked_boxes();

create or replace function app_api.trg_film_order_events_for_requirements()
returns trigger
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_order app.film_orders;
  v_requirement_id uuid;
  v_event_type text;
begin
  v_requirement_id := case when tg_op = 'DELETE' then old.id else new.id end;

  if tg_op = 'UPDATE'
     and old.required_feet is not distinct from new.required_feet
     and old.manufacturer is not distinct from new.manufacturer
     and old.film_name is not distinct from new.film_name
     and old.width_in is not distinct from new.width_in
     and old.phase_id is not distinct from new.phase_id
     and old.status is not distinct from new.status then
    return new;
  end if;

  for v_order in
    select *
    from app.film_orders fo
    where fo.org_id = case when tg_op = 'DELETE' then old.org_id else new.org_id end
      and fo.requirement_id = v_requirement_id
  loop
    if tg_op = 'DELETE' then
      v_event_type := 'REQUIREMENT_REMOVED';
    elsif app_api.film_order_matches_requirement(
      new.org_id,
      new.id,
      new.manufacturer,
      new.film_name,
      new.width_in,
      v_order.requirement_id,
      v_order.manufacturer,
      v_order.film_name,
      v_order.width_in
    ) then
      v_event_type := 'REQUIREMENT_NEED_CHANGED';
    else
      v_event_type := 'REQUIREMENT_NO_LONGER_MATCHES';
    end if;

    perform app_api.append_film_order_event(
      v_order.org_id,
      v_order.film_order_id,
      v_event_type,
      '',
      v_requirement_id,
      case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(old) end,
      case when tg_op = 'DELETE' then null else to_jsonb(new) end,
      case when tg_op = 'DELETE' then old.updated_by else new.updated_by end,
      now(),
      case
        when v_event_type = 'REQUIREMENT_REMOVED' then 'Linked requirement was removed.'
        when v_event_type = 'REQUIREMENT_NO_LONGER_MATCHES' then 'Linked requirement no longer matches this film order.'
        else 'Linked requirement need changed.'
      end
    );
  end loop;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_film_order_events_for_requirements_update on app.job_requirements;
create trigger trg_film_order_events_for_requirements_update
after update of required_feet, manufacturer, film_name, width_in, phase_id, status on app.job_requirements
for each row execute function app_api.trg_film_order_events_for_requirements();

drop trigger if exists trg_film_order_events_for_requirements_delete on app.job_requirements;
create trigger trg_film_order_events_for_requirements_delete
before delete on app.job_requirements
for each row execute function app_api.trg_film_order_events_for_requirements();

insert into app.film_order_events (
  org_id,
  event_id,
  film_order_id,
  event_type,
  related_requirement_id,
  actor,
  note,
  after_state,
  created_at
)
select
  fo.org_id,
  'FILM_ORDER_CREATED:' || fo.film_order_id,
  fo.film_order_id,
  'FILM_ORDER_CREATED',
  fo.requirement_id,
  app_api.current_film_order_actor(fo.created_by),
  'Backfilled deterministic film order creation event.',
  to_jsonb(fo),
  fo.created_at
from app.film_orders fo
on conflict (org_id, event_id) do nothing;

insert into app.film_order_events (
  org_id,
  event_id,
  film_order_id,
  event_type,
  related_requirement_id,
  actor,
  note,
  before_state,
  after_state,
  created_at
)
select
  fo.org_id,
  'FILM_ORDER_RESOLVED:' || fo.film_order_id,
  fo.film_order_id,
  case when upper(coalesce(fo.status::text, '')) = 'CANCELLED' then 'FILM_ORDER_CANCELLED' else 'FILM_ORDER_RESOLVED' end,
  fo.requirement_id,
  app_api.current_film_order_actor(fo.resolved_by),
  'Backfilled deterministic film order resolution event.',
  null,
  to_jsonb(fo),
  fo.resolved_at
from app.film_orders fo
where fo.resolved_at is not null
  and upper(coalesce(fo.status::text, '')) in ('CANCELLED', 'FULFILLED')
on conflict (org_id, event_id) do nothing;

insert into app.film_order_events (
  org_id,
  event_id,
  film_order_id,
  event_type,
  related_box_id,
  actor,
  note,
  after_state,
  created_at
)
select
  l.org_id,
  'BOX_LINKED:' || l.film_order_id || ':' || l.link_id,
  l.film_order_id,
  'BOX_LINKED',
  l.box_id,
  app_api.current_film_order_actor(l.created_by),
  'Backfilled deterministic box link event.',
  to_jsonb(l),
  l.created_at
from app.film_order_box_links l
on conflict (org_id, event_id) do nothing;

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
  v_job app.jobs;
  v_requirement app.job_requirements;
  v_phase app.job_phases;
  v_requirement_found boolean := false;
  v_requirement_matches boolean := false;
  v_has_removed_requirement_event boolean := false;
  v_need_source text := 'LEGACY_SNAPSHOT';
  v_needed_feet integer := 0;
  v_fulfilled_feet integer := 0;
  v_remaining_feet integer := 0;
  v_overage_feet integer := 0;
  v_display_status text := 'FILM_ORDER';
  v_linked_boxes jsonb := '[]'::jsonb;
  v_history jsonb := '[]'::jsonb;
  v_received_date date;
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

  if v_order.job_id is not null then
    select *
    into v_job
    from app.jobs j
    where j.org_id = p_org_id
      and j.id = v_order.job_id;
  end if;

  if v_order.requirement_id is null then
    select exists (
      select 1
      from app.film_order_events e
      where e.org_id = p_org_id
        and e.film_order_id = v_order.film_order_id
        and e.event_type in ('REQUIREMENT_REMOVED', 'REQUIREMENT_NO_LONGER_MATCHES')
    )
    into v_has_removed_requirement_event;
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

  if v_has_removed_requirement_event then
    v_need_source := 'NO_LONGER_NEEDED';
    v_needed_feet := 0;
  elsif v_order.requirement_id is not null and (not v_requirement_found or not v_requirement_matches) then
    v_need_source := 'NO_LONGER_NEEDED';
    v_needed_feet := 0;
  elsif v_requirement_found and v_requirement_matches then
    v_need_source := 'CURRENT_REQUIREMENT';
    v_needed_feet := greatest(coalesce(v_requirement.required_feet, 0), 0);
  else
    v_need_source := 'LEGACY_SNAPSHOT';
    v_needed_feet := greatest(coalesce(v_order.requested_feet, 0), 0);
  end if;

  select
    coalesce(sum(greatest(coalesce(b.initial_feet, 0), 0)), 0)::integer,
    max(b.received_date),
    coalesce(
      jsonb_agg(
        jsonb_strip_nulls(jsonb_build_object(
          'linkId', l.link_id,
          'boxId', l.box_id,
          'orderedFeet', l.ordered_feet,
          'autoAllocatedFeet', l.auto_allocated_feet,
          'initialFeet', coalesce(b.initial_feet, 0),
          'feetAvailable', coalesce(b.feet_available, 0),
          'status', b.status::text,
          'dealer', b.dealer,
          'orderDate', b.order_date,
          'receivedDate', b.received_date,
          'isReceived', (b.box_id is not null and upper(coalesce(b.status::text, '')) <> 'ORDERED'),
          'isDirectToJobSite', coalesce(b.direct_to_job_site, false)
        ))
        order by l.created_at, l.link_id
      ) filter (where b.box_id is not null),
      '[]'::jsonb
    )
  into v_fulfilled_feet, v_received_date, v_linked_boxes
  from app.film_order_box_links l
  left join app.boxes b
    on b.org_id = l.org_id
   and b.box_id = l.box_id
  where l.org_id = p_org_id
    and l.film_order_id = v_order.film_order_id;

  v_remaining_feet := greatest(v_needed_feet - v_fulfilled_feet, 0);
  v_overage_feet := greatest(v_fulfilled_feet - v_needed_feet, 0);

  v_display_status := case
    when upper(coalesce(v_order.status::text, '')) = 'CANCELLED' then 'CANCELLED'
    when v_need_source = 'NO_LONGER_NEEDED' then 'NO_LONGER_NEEDED'
    when v_fulfilled_feet <= 0 and v_needed_feet > 0 then 'FILM_ORDER'
    when v_fulfilled_feet > 0 and v_fulfilled_feet < v_needed_feet then 'INCOMPLETE'
    when v_fulfilled_feet >= v_needed_feet then 'FULFILLED_COVERED'
    else 'FILM_ORDER'
  end;

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
    'requestedFeet', v_order.requested_feet,
    'coveredFeet', v_order.covered_feet,
    'orderedFeet', v_order.ordered_feet,
    'remainingToOrderFeet', v_order.remaining_to_order_feet,
    'installDate', v_order.job_date,
    'crewLeader', v_order.crew_leader,
    'status', v_order.status::text,
    'storedStatus', v_order.status::text,
    'displayStatus', v_display_status,
    'needSource', v_need_source,
    'neededFeet', v_needed_feet,
    'fulfilledFeet', v_fulfilled_feet,
    'remainingFeet', v_remaining_feet,
    'overageFeet', v_overage_feet,
    'sourceBoxId', v_order.source_box_id,
    'origin', v_order.origin,
    'createdAt', v_order.created_at,
    'createdBy', v_order.created_by,
    'resolvedAt', v_order.resolved_at,
    'resolvedBy', v_order.resolved_by,
    'orderedDate', v_order.created_at::date,
    'receivedDate', v_received_date,
    'notes', v_order.notes,
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

create or replace function public.api_acl_box_film_order_origins(
  p_org_id uuid,
  p_box_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_box_id text := app_api.require_text(p_box_id, 'boxId');
  v_result jsonb;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'read');

  select coalesce(
    jsonb_agg(
      jsonb_strip_nulls(jsonb_build_object(
        'jobId', fo.job_id,
        'jobNumber', fo.job_number,
        'workScope', coalesce(p.sections, j.sections, ''),
        'sections', coalesce(p.sections, j.sections, ''),
        'phaseId', p.id,
        'phaseNumber', p.phase_number,
        'filmOrderId', fo.film_order_id,
        'orderedFeet', l.ordered_feet,
        'orderedDate', coalesce(b.order_date, fo.created_at::date),
        'receivedDate', b.received_date
      ))
      order by l.created_at desc, l.link_id desc
    ),
    '[]'::jsonb
  )
  into v_result
  from app.film_order_box_links l
  join app.film_orders fo
    on fo.org_id = l.org_id
   and fo.film_order_id = l.film_order_id
  left join app.boxes b
    on b.org_id = l.org_id
   and b.box_id = l.box_id
  left join app.job_requirements r
    on r.org_id = fo.org_id
   and r.id = fo.requirement_id
  left join app.job_phases p
    on p.org_id = r.org_id
   and p.id = r.phase_id
  left join app.jobs j
    on j.org_id = fo.org_id
   and j.id = fo.job_id
  where l.org_id = p_org_id
    and l.box_id = v_box_id;

  return v_result;
end;
$$;

create or replace function public.api_boxes_delete(
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
  v_box app.boxes;
  v_active_allocation_count integer := 0;
  v_log_id text;
  v_reason text := coalesce(nullif(app_api.trim_text(p_payload->>'reason'), ''), 'Deleted from box details.');
begin
  perform app_api.require_org_member(p_org_id);

  select *
  into v_box
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = app_api.require_text(p_payload->>'boxId', 'BoxID')
  for update;

  if not found then
    perform app_api.raise_http(404, 'Box not found.');
  end if;

  if v_box.status = 'CHECKED_OUT' then
    perform app_api.raise_http(400, 'Checked-out boxes cannot be deleted. Check the box in or zero it out first.');
  end if;

  select count(*)
  into v_active_allocation_count
  from app.allocations a
  where a.org_id = p_org_id
    and a.box_id = v_box.box_id
    and a.status = 'ACTIVE';

  if v_active_allocation_count > 0 then
    perform app_api.raise_http(400, 'Boxes with active allocations cannot be deleted. Resolve the allocations first.');
  end if;

  perform set_config('app.actor', app_api.current_film_order_actor(p_actor), true);
  perform app_api.delete_box(p_org_id, v_box.box_id);
  v_log_id := app_api.append_audit_entry(
    p_org_id,
    'DELETE_BOX',
    v_box.box_id,
    app_api.public_box_json(v_box),
    null,
    p_actor,
    v_reason
  );

  return jsonb_build_object(
    'boxId', v_box.box_id,
    'logId', v_log_id,
    'warnings', '[]'::jsonb
  );
end;
$$;

grant execute on function app_api.append_film_order_event(uuid, text, text, text, uuid, jsonb, jsonb, text, timestamptz, text, text) to service_role;
grant execute on function public.api_acl_film_orders_get(uuid, text) to authenticated, service_role;
grant execute on function public.api_acl_box_film_order_origins(uuid, text) to authenticated, service_role;
grant execute on function public.api_boxes_delete(uuid, text, jsonb) to service_role;
