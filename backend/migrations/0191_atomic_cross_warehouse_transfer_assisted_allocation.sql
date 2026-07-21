-- Atomic cross-warehouse transfer-assisted film allocation.
--
-- Forward-only schema/RPC change. This migration intentionally contains no
-- business-row rewrite or backfill. Existing transfers keep a null allocation
-- link and continue through the explicit legacy receive/cancel path.

alter table app.box_transfers
  add column if not exists transfer_created_allocation_id text;

do $$
declare
  v_invalid_key_count integer := 0;
  v_duplicate_key_count integer := 0;
begin
  select count(*)::integer
  into v_invalid_key_count
  from app.allocations
  where allocation_id is null
     or btrim(allocation_id) = '';

  select count(*)::integer
  into v_duplicate_key_count
  from (
    select org_id, allocation_id
    from app.allocations
    group by org_id, allocation_id
    having count(*) > 1
  ) duplicate_keys;

  if v_invalid_key_count > 0 or v_duplicate_key_count > 0 then
    raise exception '0191 allocation key precondition failed';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'app.allocations'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (org_id, allocation_id)'
  ) then
    raise exception '0191 requires the existing allocations (org_id, allocation_id) unique key';
  end if;
end;
$$;

-- Preserve the fully reasserted pre-0191 allocation implementation, including
-- requirement identity, phase scheduling, checked-out capacity, and planner
-- reconciliation behavior. The public entry points below add transaction and
-- transfer semantics around that exact implementation.
do $$
declare
  v_def text;
begin
  select pg_get_functiondef('public.api_allocations_apply(uuid, text, jsonb)'::regprocedure)
  into v_def;
  v_def := regexp_replace(
    v_def,
    '^CREATE OR REPLACE FUNCTION public\.api_allocations_apply',
    'CREATE OR REPLACE FUNCTION app_api.api_allocations_apply_pre_0191'
  );
  execute v_def;

  select pg_get_functiondef('public.api_acl_allocations_apply(uuid, text, jsonb)'::regprocedure)
  into v_def;
  v_def := regexp_replace(
    v_def,
    '^CREATE OR REPLACE FUNCTION public\.api_acl_allocations_apply',
    'CREATE OR REPLACE FUNCTION app_api.api_acl_allocations_apply_pre_0191'
  );
  execute v_def;
end;
$$;

revoke execute on function app_api.api_allocations_apply_pre_0191(uuid, text, jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function app_api.api_acl_allocations_apply_pre_0191(uuid, text, jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.api_allocations_apply(
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
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_result jsonb;
  v_cross_warehouse boolean := coalesce((v_payload->>'crossWarehouse')::boolean, false);
  v_payload_job_warehouse text := upper(app_api.trim_text(v_payload->>'jobWarehouse'));
  v_job_id_text text := app_api.trim_text(v_payload->>'jobId');
  v_job_number text := app_api.trim_text(v_payload->>'jobNumber');
  v_job app.jobs;
  v_pre_box app.boxes;
  v_pre_states jsonb := '{}'::jsonb;
  v_pre_state jsonb;
  v_payload_box_ids text[] := array[]::text[];
  v_box_id text;
  v_distinct_payload_box_count integer := 0;
  v_allocation_id text;
  v_allocation app.allocations;
  v_allocation_job_warehouse text := '';
  v_pre_warehouse text := '';
  v_cross_box_counts jsonb := '{}'::jsonb;
  v_cross_box_count integer := 0;
  v_transfer app.box_transfers;
  v_transfer_ids text[] := array[]::text[];
begin
  perform app_api.lock_film_material_flow();

  if v_job_id_text <> '' then
    begin
      select *
      into v_job
      from app.jobs j
      where j.org_id = p_org_id
        and j.id = v_job_id_text::uuid;
    exception
      when invalid_text_representation then
        perform app_api.raise_http(400, 'jobId must be a valid UUID.');
    end;

    if v_job.id is null then
      perform app_api.raise_http(404, 'Job was not found.');
    end if;

    if v_payload_job_warehouse <> '' and v_payload_job_warehouse <> upper(v_job.warehouse) then
      perform app_api.raise_http(409, 'Job warehouse changed before allocation. Reload and retry.');
    end if;
    v_payload_job_warehouse := upper(v_job.warehouse);
  elsif v_payload_job_warehouse = '' and v_job_number <> '' then
    select min(j.warehouse), count(*)::integer
    into v_payload_job_warehouse, v_distinct_payload_box_count
    from app.jobs j
    where j.org_id = p_org_id
      and upper(j.job_number) = upper(v_job_number);

    if v_distinct_payload_box_count > 1 then
      v_payload_job_warehouse := '';
    end if;
    v_payload_job_warehouse := upper(coalesce(v_payload_job_warehouse, ''));
  end if;

  v_payload_box_ids := array_append(
    v_payload_box_ids,
    app_api.require_text(v_payload->>'boxId', 'BoxID')
  );

  if v_payload ? 'selectedSuggestionBoxIds' then
    if jsonb_typeof(v_payload->'selectedSuggestionBoxIds') <> 'array' then
      perform app_api.raise_http(400, 'selectedSuggestionBoxIds must be an array.');
    end if;

    for v_box_id in
      select app_api.trim_text(value)
      from jsonb_array_elements_text(v_payload->'selectedSuggestionBoxIds')
    loop
      if v_box_id <> '' then
        v_payload_box_ids := array_append(v_payload_box_ids, v_box_id);
      end if;
    end loop;
  end if;

  if v_payload ? 'extraAllocations' then
    if jsonb_typeof(v_payload->'extraAllocations') <> 'array' then
      perform app_api.raise_http(400, 'extraAllocations must be an array.');
    end if;

    for v_box_id in
      select app_api.trim_text(value->>'boxId')
      from jsonb_array_elements(v_payload->'extraAllocations')
    loop
      if v_box_id <> '' then
        v_payload_box_ids := array_append(v_payload_box_ids, v_box_id);
      end if;
    end loop;
  end if;

  select count(distinct upper(entry))::integer
  into v_distinct_payload_box_count
  from unnest(v_payload_box_ids) entry;

  if v_distinct_payload_box_count <> coalesce(array_length(v_payload_box_ids, 1), 0) then
    perform app_api.raise_http(
      409,
      'The same box cannot be selected more than once in one allocation apply request.'
    );
  end if;

  -- Capture pre-apply state before the preserved allocator writes anything.
  -- The global advisory lock makes this the canonical mutation snapshot while
  -- avoiding a broad row-lock sweep across every box in the organization.
  for v_pre_box in
    select *
    from app.boxes b
    where b.org_id = p_org_id
    order by b.box_id
  loop
    v_pre_states := v_pre_states || jsonb_build_object(
      v_pre_box.box_id,
      jsonb_build_object(
        'status', upper(coalesce(v_pre_box.status::text, '')),
        'warehouse', upper(coalesce(v_pre_box.warehouse, '')),
        'physicalFeet', app_api.box_physical_feet_available(v_pre_box),
        'reservationCount', (
          select count(*)::integer
          from app.allocations a
          where a.org_id = p_org_id
            and a.box_id = v_pre_box.box_id
            and app_api.film_allocation_reserves_capacity(a, v_pre_box.status::text)
        ),
        'pendingTransfer', exists (
          select 1
          from app.box_transfers t
          where t.org_id = p_org_id
            and t.box_record_id = v_pre_box.id
            and t.status = 'PENDING'
        )
      )
    );
  end loop;

  v_result := app_api.api_allocations_apply_pre_0191(p_org_id, p_actor, v_payload);

  for v_allocation_id in
    select jsonb_array_elements_text(coalesce(v_result->'allocationIds', '[]'::jsonb))
  loop
    select *
    into v_allocation
    from app.allocations a
    where a.org_id = p_org_id
      and a.allocation_id = v_allocation_id
    for update;

    if not found then
      perform app_api.raise_http(409, 'Allocation result changed before transfer validation completed.');
    end if;

    v_pre_state := v_pre_states->v_allocation.box_id;
    if v_pre_state is null then
      perform app_api.raise_http(409, 'Allocation box changed before transfer validation completed.');
    end if;

    if upper(coalesce(v_pre_state->>'status', '')) = 'TRANSFER'
      or coalesce((v_pre_state->>'pendingTransfer')::boolean, false)
    then
      perform app_api.raise_http(409, 'Pending-transfer boxes cannot receive additional allocations.');
    end if;

    select upper(j.warehouse)
    into v_allocation_job_warehouse
    from app.jobs j
    where j.org_id = p_org_id
      and j.id = v_allocation.job_id;

    v_pre_warehouse := upper(coalesce(v_pre_state->>'warehouse', ''));
    if coalesce(v_allocation_job_warehouse, '') <> ''
      and v_pre_warehouse <> v_allocation_job_warehouse
    then
      if not v_cross_warehouse then
        perform app_api.raise_http(409, 'Cross-warehouse allocation requires crossWarehouse approval.');
      end if;

      if v_payload_job_warehouse <> '' and v_payload_job_warehouse <> v_allocation_job_warehouse then
        perform app_api.raise_http(409, 'Allocation destination does not match the current job warehouse.');
      end if;

      if upper(coalesce(v_pre_state->>'status', '')) <> 'IN_STOCK' then
        perform app_api.raise_http(409, 'Transfer-assisted allocation can start only from an in-stock box.');
      end if;

      if coalesce((v_pre_state->>'reservationCount')::integer, 0) <> 0 then
        perform app_api.raise_http(409, 'Transfer-assisted allocation requires a box with zero prior reservations.');
      end if;

      if coalesce(v_allocation.allocation_kind::text, 'REQUIREMENT') <> 'REQUIREMENT'
        or v_allocation.requirement_id is null
      then
        perform app_api.raise_http(
          409,
          'Cross-warehouse extra film must be transferred and received before it can be allocated.'
        );
      end if;

      v_cross_box_count := coalesce((v_cross_box_counts->>v_allocation.box_id)::integer, 0) + 1;
      if v_cross_box_count <> 1 then
        perform app_api.raise_http(409, 'A cross-warehouse box can satisfy only one requirement per apply request.');
      end if;
      v_cross_box_counts := jsonb_set(
        v_cross_box_counts,
        array[v_allocation.box_id],
        to_jsonb(v_cross_box_count),
        true
      );

      v_transfer := app_api.start_box_transfer_locked(
        p_org_id,
        p_actor,
        v_allocation.box_id,
        v_allocation_job_warehouse,
        'Transfer-assisted allocation.',
        v_allocation.allocation_id,
        '',
        nullif(v_pre_state->>'physicalFeet', '')::integer
      );
      v_transfer_ids := array_append(v_transfer_ids, v_transfer.transfer_id);
    end if;
  end loop;

  return v_result || jsonb_build_object('transferIds', to_jsonb(v_transfer_ids));
end;
$$;

create or replace function public.api_acl_allocations_apply(
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
  perform app_api.lock_film_material_flow();
  return app_api.api_acl_allocations_apply_pre_0191(p_org_id, p_actor, p_payload);
end;
$$;

alter table app.box_transfers
  drop constraint if exists box_transfers_transfer_created_allocation_fk;

alter table app.box_transfers
  add constraint box_transfers_transfer_created_allocation_fk
  foreign key (org_id, transfer_created_allocation_id)
  references app.allocations(org_id, allocation_id)
  on update no action
  on delete no action
  deferrable initially deferred;

create unique index if not exists idx_box_transfers_transfer_created_allocation
  on app.box_transfers (org_id, transfer_created_allocation_id)
  where transfer_created_allocation_id is not null;

create or replace function app_api.lock_film_material_flow()
returns void
language sql
volatile
security definer
set search_path = public, app, app_api
as $$
  select pg_advisory_xact_lock(hashtextextended('film-material-flow', 0));
$$;

create or replace function app_api.current_transfer_workflow_action()
returns text
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select lower(coalesce(current_setting('app.transfer_workflow_action', true), ''));
$$;

create or replace function app_api.public_box_transfer_json(p_transfer app.box_transfers)
returns jsonb
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select jsonb_build_object(
    'transferId', coalesce((p_transfer).transfer_id, ''),
    'boxId', case
      when (p_transfer).status = 'RECEIVED' then coalesce((p_transfer).destination_box_id, '')
      else coalesce((p_transfer).source_box_id, '')
    end,
    'sourceBoxId', coalesce((p_transfer).source_box_id, ''),
    'destinationBoxId', coalesce((p_transfer).destination_box_id, ''),
    'sourceWarehouse', coalesce((p_transfer).source_warehouse, ''),
    'destinationWarehouse', coalesce((p_transfer).destination_warehouse, ''),
    'status', coalesce((p_transfer).status, 'PENDING'),
    'workflowKind', case
      when app_api.trim_text((p_transfer).transfer_created_allocation_id) = '' then 'ORDINARY'
      else 'ALLOCATION_ASSISTED'
    end,
    'createdAt', coalesce(to_char((p_transfer).created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''),
    'createdBy', coalesce((p_transfer).created_by, ''),
    'receivedAt', coalesce(to_char((p_transfer).received_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''),
    'receivedBy', coalesce((p_transfer).received_by, ''),
    'cancelledAt', coalesce(to_char((p_transfer).cancelled_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''),
    'cancelledBy', coalesce((p_transfer).cancelled_by, ''),
    'notes', coalesce((p_transfer).notes, '')
  );
$$;

create or replace function app_api.resolve_transfer_destination_box_id(
  p_org_id uuid,
  p_box app.boxes,
  p_destination_warehouse text,
  p_destination_box_id_override text default ''
)
returns text
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_source_prefix text := '';
  v_destination_prefix text := '';
  v_destination_warehouse text := upper(app_api.require_text(p_destination_warehouse, 'ToWarehouse'));
  v_destination_box_id text := '';
begin
  if upper(coalesce((p_box).warehouse, '')) = v_destination_warehouse then
    perform app_api.raise_http(400, 'Transfer destination must be different from the current warehouse.');
  end if;

  select coalesce(nullif(upper(btrim(w.box_id_prefix)), ''), upper(btrim(w.code)))
  into v_source_prefix
  from app.warehouses w
  where w.org_id = p_org_id
    and w.code = upper(coalesce((p_box).warehouse, ''));

  if not found then
    perform app_api.raise_http(400, 'CurrentWarehouse is not configured.');
  end if;

  select coalesce(nullif(upper(btrim(w.box_id_prefix)), ''), upper(btrim(w.code)))
  into v_destination_prefix
  from app.warehouses w
  where w.org_id = p_org_id
    and w.code = v_destination_warehouse;

  if not found then
    perform app_api.raise_http(400, 'ToWarehouse is not configured.');
  end if;

  if app_api.trim_text(p_destination_box_id_override) <> '' then
    v_destination_box_id := upper(app_api.trim_text(p_destination_box_id_override));
    if left(v_destination_box_id, length(v_destination_prefix) + 1) <> v_destination_prefix || '-' then
      perform app_api.raise_http(
        400,
        format('Arrival BoxID must use the %s warehouse prefix.', v_destination_prefix)
      );
    end if;
  else
    v_destination_box_id := app_api.plan_transfer_destination_box_id(
      p_org_id,
      (p_box).box_id,
      v_source_prefix,
      v_destination_prefix
    );
  end if;

  if v_destination_box_id = upper(coalesce((p_box).box_id, '')) then
    perform app_api.raise_http(400, 'Arrival BoxID must differ from the source BoxID.');
  end if;

  return v_destination_box_id;
end;
$$;

create or replace function app_api.assert_transfer_destination_available(
  p_org_id uuid,
  p_box_record_id uuid,
  p_destination_box_id text,
  p_excluded_transfer_id text default ''
)
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_destination_box_id text := upper(app_api.require_text(p_destination_box_id, 'DestinationBoxID'));
begin
  if exists (
    select 1
    from app.boxes b
    where b.org_id = p_org_id
      and b.box_id = v_destination_box_id
      and b.id is distinct from p_box_record_id
  ) then
    perform app_api.raise_http(409, format('Arrival BoxID %s already exists.', v_destination_box_id));
  end if;

  if exists (
    select 1
    from app.box_id_aliases a
    left join app.boxes b
      on b.org_id = a.org_id
     and b.box_id = a.canonical_box_id
    where a.org_id = p_org_id
      and a.old_box_id = v_destination_box_id
      and b.id is distinct from p_box_record_id
  ) then
    perform app_api.raise_http(409, format('Arrival BoxID %s is reserved by a box alias.', v_destination_box_id));
  end if;

  if exists (
    select 1
    from app.box_transfers t
    where t.org_id = p_org_id
      and t.status = 'PENDING'
      and t.destination_box_id = v_destination_box_id
      and t.transfer_id <> app_api.trim_text(p_excluded_transfer_id)
  ) then
    perform app_api.raise_http(409, format('Arrival BoxID %s is reserved by another pending transfer.', v_destination_box_id));
  end if;
end;
$$;

create or replace function app_api.start_box_transfer_locked(
  p_org_id uuid,
  p_actor text,
  p_box_id text,
  p_destination_warehouse text,
  p_notes text default '',
  p_transfer_created_allocation_id text default '',
  p_destination_box_id_override text default '',
  p_physical_feet_available integer default null
)
returns app.box_transfers
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_box app.boxes;
  v_allocation app.allocations;
  v_transfer app.box_transfers;
  v_destination_box_id text := '';
  v_destination_warehouse text := upper(app_api.require_text(p_destination_warehouse, 'ToWarehouse'));
  v_allocation_id text := app_api.trim_text(p_transfer_created_allocation_id);
  v_reservation_count integer := 0;
  v_physical_feet integer := p_physical_feet_available;
  v_before jsonb;
begin
  perform app_api.lock_film_material_flow();

  select *
  into v_box
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = app_api.resolve_box_id_alias(p_org_id, app_api.require_text(p_box_id, 'BoxID'))
  for update;

  if not found then
    perform app_api.raise_http(404, 'Box not found.');
  end if;

  if upper(coalesce(v_box.status::text, '')) <> 'IN_STOCK' then
    perform app_api.raise_http(
      409,
      format('Only in-stock boxes can start a transfer. Box %s is %s.', v_box.box_id, v_box.status)
    );
  end if;

  if exists (
    select 1
    from app.box_transfers t
    where t.org_id = p_org_id
      and t.box_record_id = v_box.id
      and t.status = 'PENDING'
  ) then
    perform app_api.raise_http(409, format('Box %s already has a pending transfer.', v_box.box_id));
  end if;

  select count(*)::integer
  into v_reservation_count
  from app.allocations a
  where a.org_id = p_org_id
    and a.box_id = v_box.box_id
    and app_api.film_allocation_reserves_capacity(a, v_box.status::text);

  if v_allocation_id = '' then
    if v_reservation_count <> 0 then
      perform app_api.raise_http(
        409,
        format('Box %s has reserved film and cannot start an ordinary transfer.', v_box.box_id)
      );
    end if;
  else
    select *
    into v_allocation
    from app.allocations a
    where a.org_id = p_org_id
      and a.allocation_id = v_allocation_id
    for update;

    if not found
      or v_allocation.box_id <> v_box.box_id
      or coalesce(v_allocation.allocation_kind::text, 'REQUIREMENT') <> 'REQUIREMENT'
      or v_allocation.requirement_id is null
      or not app_api.film_allocation_reserves_capacity(v_allocation, v_box.status::text)
    then
      perform app_api.raise_http(409, 'Transfer-created allocation is not a reserving requirement allocation for this box.');
    end if;

    if v_reservation_count <> 1 then
      perform app_api.raise_http(409, 'A transfer-assisted box must have exactly one first reservation.');
    end if;

    if not exists (
      select 1
      from app.jobs j
      where j.org_id = p_org_id
        and j.id = v_allocation.job_id
        and upper(j.warehouse) = v_destination_warehouse
    ) then
      perform app_api.raise_http(409, 'Transfer destination must match the linked allocation job warehouse.');
    end if;
  end if;

  v_destination_box_id := app_api.resolve_transfer_destination_box_id(
    p_org_id,
    v_box,
    v_destination_warehouse,
    p_destination_box_id_override
  );
  perform app_api.assert_transfer_destination_available(
    p_org_id,
    v_box.id,
    v_destination_box_id,
    ''
  );

  v_physical_feet := coalesce(v_physical_feet, app_api.box_physical_feet_available(v_box), 0);
  v_before := app_api.public_box_json(v_box);
  perform set_config('app.transfer_workflow_action', 'start', true);

  begin
    insert into app.box_transfers (
      org_id,
      transfer_id,
      box_record_id,
      source_box_id,
      destination_box_id,
      source_warehouse,
      destination_warehouse,
      status,
      notes,
      created_at,
      created_by,
      updated_at,
      updated_by,
      transfer_created_allocation_id
    )
    values (
      p_org_id,
      upper('TRF-' || app_api.create_log_id()),
      v_box.id,
      v_box.box_id,
      v_destination_box_id,
      upper(v_box.warehouse),
      v_destination_warehouse,
      'PENDING',
      app_api.trim_text(p_notes),
      timezone('utc', now()),
      app_api.require_text(p_actor, 'Actor'),
      timezone('utc', now()),
      app_api.require_text(p_actor, 'Actor'),
      nullif(v_allocation_id, '')
    )
    returning * into v_transfer;
  exception
    when unique_violation then
      perform app_api.raise_http(409, 'A competing transfer reserved this box or destination. Retry from current data.');
  end;

  update app.boxes
  set status = 'TRANSFER',
      updated_at = timezone('utc', now()),
      updated_by = app_api.require_text(p_actor, 'Actor')
  where org_id = p_org_id
    and id = v_box.id
  returning * into v_box;

  perform app_api.recalculate_physical_box_allocatable_now(
    p_org_id,
    v_box.box_id,
    v_physical_feet
  );

  select * into v_box
  from app.boxes b
  where b.org_id = p_org_id
    and b.id = v_box.id;

  perform app_api.append_audit_entry(
    p_org_id,
    'START_TRANSFER',
    v_box.box_id,
    v_before,
    app_api.public_box_json(v_box),
    p_actor,
    coalesce(nullif(app_api.trim_text(p_notes), ''), format('Started transfer to %s.', v_destination_warehouse))
  );

  return v_transfer;
end;
$$;

create or replace function public.api_box_transfer_start(
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
  v_transfer app.box_transfers;
  v_box app.boxes;
  v_log_id text := '';
begin
  perform app_api.require_org_member(p_org_id);
  perform app_api.lock_film_material_flow();

  v_transfer := app_api.start_box_transfer_locked(
    p_org_id,
    p_actor,
    p_payload->>'boxId',
    p_payload->>'toWarehouse',
    p_payload->>'notes',
    '',
    p_payload->>'destinationBoxIdOverride',
    null
  );

  select * into v_box
  from app.boxes b
  where b.org_id = p_org_id
    and b.id = v_transfer.box_record_id;

  select coalesce(a.log_id, '')
  into v_log_id
  from app.audit_log a
  where a.org_id = p_org_id
    and a.action = 'START_TRANSFER'
    and a.box_id = v_box.box_id
    and a.actor = app_api.trim_text(p_actor)
  order by a.created_at desc, a.id desc
  limit 1;

  return jsonb_build_object(
    'box', app_api.public_box_json(v_box),
    'transfer', app_api.public_box_transfer_json(v_transfer),
    'logId', v_log_id,
    'cancelledAllocationCount', 0,
    'releasedFeet', 0,
    'warnings', '[]'::jsonb
  );
end;
$$;

create or replace function public.api_box_transfer_receive(
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
  v_transfer app.box_transfers;
  v_box app.boxes;
  v_before jsonb;
  v_source_box_id text := '';
  v_destination_box_id text := '';
  v_physical_feet integer := 0;
  v_log_id text := '';
  v_now timestamptz := timezone('utc', now());
begin
  perform app_api.require_org_member(p_org_id);
  perform app_api.lock_film_material_flow();

  select *
  into v_transfer
  from app.box_transfers t
  where t.org_id = p_org_id
    and t.transfer_id = upper(app_api.require_text(p_payload->>'transferId', 'TransferID'))
  for update;

  if not found then
    perform app_api.raise_http(404, 'Transfer not found.');
  end if;

  if v_transfer.status <> 'PENDING' then
    perform app_api.raise_http(409, format('Transfer %s is already %s.', v_transfer.transfer_id, v_transfer.status));
  end if;

  select *
  into v_box
  from app.boxes b
  where b.org_id = p_org_id
    and b.id = v_transfer.box_record_id
  for update;

  if not found then
    perform app_api.raise_http(404, 'Box not found for this transfer.');
  end if;

  if upper(coalesce(v_box.status::text, '')) <> 'TRANSFER'
    or v_box.box_id <> v_transfer.source_box_id
    or upper(v_box.warehouse) <> v_transfer.source_warehouse
  then
    perform app_api.raise_http(409, 'Pending transfer custody no longer matches the source box.');
  end if;

  v_source_box_id := v_transfer.source_box_id;
  v_destination_box_id := v_transfer.destination_box_id;
  v_physical_feet := coalesce(app_api.box_physical_feet_available(v_box), 0);
  v_before := app_api.public_box_json(v_box);

  perform app_api.assert_transfer_destination_available(
    p_org_id,
    v_box.id,
    v_destination_box_id,
    v_transfer.transfer_id
  );

  -- A previous round trip may leave the destination ID as an alias pointing
  -- back to this same physical record. Release only that reusable alias.
  delete from app.box_id_aliases a
  using app.boxes canonical_box
  where a.org_id = p_org_id
    and a.old_box_id = v_destination_box_id
    and canonical_box.org_id = a.org_id
    and canonical_box.box_id = a.canonical_box_id
    and canonical_box.id = v_box.id;

  perform set_config('app.transfer_workflow_action', 'receive', true);

  update app.boxes
  set box_id = v_destination_box_id,
      warehouse = v_transfer.destination_warehouse,
      status = 'IN_STOCK',
      updated_at = v_now,
      updated_by = app_api.require_text(p_actor, 'Actor')
  where org_id = p_org_id
    and id = v_box.id
  returning * into v_box;

  -- Move every reference to the physical box identity. This intentionally
  -- includes cancelled/history allocations; receipt never reactivates them.
  update app.allocations
  set box_id = v_destination_box_id,
      warehouse = v_transfer.destination_warehouse
  where org_id = p_org_id
    and box_id = v_source_box_id;

  update app.audit_log
  set box_id = v_destination_box_id
  where org_id = p_org_id
    and box_id = v_source_box_id;

  update app.roll_weight_log
  set box_id = v_destination_box_id,
      warehouse = v_transfer.destination_warehouse
  where org_id = p_org_id
    and box_id = v_source_box_id;

  update app.film_order_box_links
  set box_id = v_destination_box_id
  where org_id = p_org_id
    and box_id = v_source_box_id;

  update app.film_orders
  set source_box_id = v_destination_box_id
  where org_id = p_org_id
    and source_box_id = v_source_box_id;

  update app.film_catalog
  set source_box_id = v_destination_box_id,
      updated_at = v_now
  where org_id = p_org_id
    and source_box_id = v_source_box_id;

  insert into app.box_id_aliases (
    org_id,
    old_box_id,
    canonical_box_id,
    expires_at,
    created_by,
    updated_by,
    updated_at
  )
  values (
    p_org_id,
    v_source_box_id,
    v_destination_box_id,
    v_now + interval '365 days',
    app_api.require_text(p_actor, 'Actor'),
    app_api.require_text(p_actor, 'Actor'),
    v_now
  )
  on conflict (org_id, old_box_id) do update set
    canonical_box_id = excluded.canonical_box_id,
    expires_at = excluded.expires_at,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  update app.box_transfers
  set status = 'RECEIVED',
      received_at = v_now,
      received_by = app_api.require_text(p_actor, 'Actor'),
      updated_at = v_now,
      updated_by = app_api.require_text(p_actor, 'Actor')
  where org_id = p_org_id
    and id = v_transfer.id
  returning * into v_transfer;

  perform app_api.recalculate_physical_box_allocatable_now(
    p_org_id,
    v_destination_box_id,
    v_physical_feet
  );

  select * into v_box
  from app.boxes b
  where b.org_id = p_org_id
    and b.id = v_transfer.box_record_id;

  v_log_id := app_api.append_audit_entry(
    p_org_id,
    'RECEIVE_TRANSFER',
    v_box.box_id,
    v_before,
    app_api.public_box_json(v_box),
    p_actor,
    format('Received transfer into %s.', v_transfer.destination_warehouse)
  );

  return jsonb_build_object(
    'box', app_api.public_box_json(v_box),
    'transfer', app_api.public_box_transfer_json(v_transfer),
    'logId', v_log_id,
    'cancelledAllocationCount', 0,
    'releasedFeet', 0,
    'warnings', '[]'::jsonb
  );
end;
$$;

create or replace function public.api_box_transfer_cancel(
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
  v_transfer app.box_transfers;
  v_box app.boxes;
  v_before jsonb;
  v_reason text := '';
  v_physical_feet integer := 0;
  v_cancelled_count integer := 0;
  v_released_feet integer := 0;
  v_log_id text := '';
  v_now timestamptz := timezone('utc', now());
begin
  perform app_api.require_org_member(p_org_id);
  perform app_api.lock_film_material_flow();

  select *
  into v_transfer
  from app.box_transfers t
  where t.org_id = p_org_id
    and t.transfer_id = upper(app_api.require_text(p_payload->>'transferId', 'TransferID'))
  for update;

  if not found then
    perform app_api.raise_http(404, 'Transfer not found.');
  end if;

  if v_transfer.status <> 'PENDING' then
    perform app_api.raise_http(409, format('Transfer %s is already %s.', v_transfer.transfer_id, v_transfer.status));
  end if;

  select *
  into v_box
  from app.boxes b
  where b.org_id = p_org_id
    and b.id = v_transfer.box_record_id
  for update;

  if not found then
    perform app_api.raise_http(404, 'Box not found for this transfer.');
  end if;

  if upper(coalesce(v_box.status::text, '')) <> 'TRANSFER'
    or v_box.box_id <> v_transfer.source_box_id
    or upper(v_box.warehouse) <> v_transfer.source_warehouse
  then
    perform app_api.raise_http(409, 'Pending transfer custody no longer matches the source box.');
  end if;

  v_reason := coalesce(
    nullif(app_api.trim_text(p_payload->>'reason'), ''),
    format('Cancelled transfer to %s.', v_transfer.destination_warehouse)
  );
  v_physical_feet := coalesce(app_api.box_physical_feet_available(v_box), 0);
  v_before := app_api.public_box_json(v_box);
  perform set_config('app.transfer_workflow_action', 'cancel', true);

  if app_api.trim_text(v_transfer.transfer_created_allocation_id) <> '' then
    select coalesce(sum(a.allocated_feet), 0)::integer
    into v_released_feet
    from app.allocations a
    where a.org_id = p_org_id
      and a.allocation_id = v_transfer.transfer_created_allocation_id
      and a.status = 'ACTIVE';

    update app.allocations
    set status = 'CANCELLED',
        resolved_at = v_now,
        resolved_by = app_api.require_text(p_actor, 'Actor'),
        notes = trim(
          coalesce(notes, '') ||
          case when coalesce(notes, '') = '' then '' else ' ' end ||
          v_reason
        )
    where org_id = p_org_id
      and allocation_id = v_transfer.transfer_created_allocation_id
      and status = 'ACTIVE';
    get diagnostics v_cancelled_count = row_count;
  else
    -- Explicit compatibility path for historical/ordinary null-link transfers.
    select coalesce(sum(a.allocated_feet), 0)::integer
    into v_released_feet
    from app.allocations a
    join app.jobs j
      on j.org_id = a.org_id
     and j.id = a.job_id
    where a.org_id = p_org_id
      and a.box_id = v_transfer.source_box_id
      and a.status = 'ACTIVE'
      and upper(j.warehouse) = v_transfer.destination_warehouse;

    update app.allocations a
    set status = 'CANCELLED',
        resolved_at = v_now,
        resolved_by = app_api.require_text(p_actor, 'Actor'),
        notes = trim(
          coalesce(a.notes, '') ||
          case when coalesce(a.notes, '') = '' then '' else ' ' end ||
          v_reason
        )
    from app.jobs j
    where a.org_id = p_org_id
      and a.box_id = v_transfer.source_box_id
      and a.status = 'ACTIVE'
      and j.org_id = a.org_id
      and j.id = a.job_id
      and upper(j.warehouse) = v_transfer.destination_warehouse;
    get diagnostics v_cancelled_count = row_count;
  end if;

  update app.boxes
  set status = 'IN_STOCK',
      updated_at = v_now,
      updated_by = app_api.require_text(p_actor, 'Actor')
  where org_id = p_org_id
    and id = v_box.id
  returning * into v_box;

  update app.box_transfers
  set status = 'CANCELLED',
      notes = v_reason,
      cancelled_at = v_now,
      cancelled_by = app_api.require_text(p_actor, 'Actor'),
      updated_at = v_now,
      updated_by = app_api.require_text(p_actor, 'Actor')
  where org_id = p_org_id
    and id = v_transfer.id
  returning * into v_transfer;

  perform app_api.recalculate_physical_box_allocatable_now(
    p_org_id,
    v_box.box_id,
    v_physical_feet
  );

  select * into v_box
  from app.boxes b
  where b.org_id = p_org_id
    and b.id = v_transfer.box_record_id;

  v_log_id := app_api.append_audit_entry(
    p_org_id,
    'CANCEL_TRANSFER',
    v_box.box_id,
    v_before,
    app_api.public_box_json(v_box),
    p_actor,
    v_reason
  );

  return jsonb_build_object(
    'box', app_api.public_box_json(v_box),
    'transfer', app_api.public_box_transfer_json(v_transfer),
    'logId', v_log_id,
    'cancelledAllocationCount', v_cancelled_count,
    'releasedFeet', v_released_feet,
    'warnings', '[]'::jsonb
  );
end;
$$;

create or replace function public.api_acl_box_transfer_start(
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
  perform app_api.lock_film_material_flow();
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');
  return public.api_box_transfer_start(p_org_id, p_actor, p_payload);
end;
$$;

create or replace function public.api_acl_box_transfer_receive(
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
  perform app_api.lock_film_material_flow();
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');
  return public.api_box_transfer_receive(p_org_id, p_actor, p_payload);
end;
$$;

create or replace function public.api_acl_box_transfer_cancel(
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
  perform app_api.lock_film_material_flow();
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');
  return public.api_box_transfer_cancel(p_org_id, p_actor, p_payload);
end;
$$;

create or replace function app_api.guard_pending_transfer_allocation_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_transfer app.box_transfers;
  v_action text := app_api.current_transfer_workflow_action();
  v_old_reserves boolean := false;
  v_new_reserves boolean := false;
  v_org_id uuid;
  v_allocation_id text := '';
  v_old_box_id text := '';
  v_new_box_id text := '';
begin
  if tg_op = 'DELETE' then
    v_org_id := old.org_id;
    v_allocation_id := old.allocation_id;
    v_old_box_id := old.box_id;
  elsif tg_op = 'INSERT' then
    v_org_id := new.org_id;
    v_allocation_id := new.allocation_id;
    v_new_box_id := new.box_id;
  else
    v_org_id := new.org_id;
    v_allocation_id := new.allocation_id;
    v_old_box_id := old.box_id;
    v_new_box_id := new.box_id;
  end if;

  if tg_op = 'UPDATE' then
    if new.org_id is distinct from old.org_id
      or new.id is distinct from old.id
      or new.allocation_id is distinct from old.allocation_id
    then
      perform app_api.raise_http(409, 'allocation_id is an immutable canonical allocation key.');
    end if;
  end if;

  if tg_op = 'DELETE' and exists (
    select 1
    from app.box_transfers t
    where t.org_id = old.org_id
      and t.transfer_created_allocation_id = old.allocation_id
  ) then
    perform app_api.raise_http(409, 'Transfer-created allocation history cannot be deleted.');
  end if;

  select *
  into v_transfer
  from app.box_transfers t
  where t.status = 'PENDING'
    and t.org_id = v_org_id
    and (
      t.transfer_created_allocation_id = v_allocation_id
      or (v_old_box_id <> '' and t.source_box_id = v_old_box_id)
      or (
        v_new_box_id <> ''
        and v_new_box_id in (t.source_box_id, t.destination_box_id)
      )
    )
  order by t.created_at, t.id
  limit 1;

  if not found then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    perform app_api.raise_http(409, 'Allocations associated with a pending transfer must be status-released, not deleted.');
  end if;

  if tg_op = 'INSERT' then
    if v_action <> 'start'
      or app_api.trim_text(v_transfer.transfer_created_allocation_id) = ''
      or new.allocation_id <> v_transfer.transfer_created_allocation_id
    then
      perform app_api.raise_http(409, 'Pending-transfer boxes cannot receive additional allocations.');
    end if;
    return new;
  end if;

  if v_action = 'receive' then
    return new;
  end if;

  v_old_reserves := app_api.film_allocation_reserves_capacity(old, 'TRANSFER');
  v_new_reserves := app_api.film_allocation_reserves_capacity(new, 'TRANSFER');

  if upper(coalesce(new.status::text, '')) = 'FULFILLED'
    and upper(coalesce(old.status::text, '')) <> 'FULFILLED'
  then
    perform app_api.raise_http(409, 'A pending-transfer allocation cannot be fulfilled before receipt.');
  end if;

  if not v_old_reserves and v_new_reserves then
    perform app_api.raise_http(409, 'A pending-transfer allocation cannot be reactivated.');
  end if;

  if v_old_reserves and v_new_reserves then
    if new.allocation_id <> v_transfer.transfer_created_allocation_id
      or new.allocated_feet > old.allocated_feet
      or new.status is distinct from old.status
      or new.box_id is distinct from old.box_id
      or new.warehouse is distinct from old.warehouse
      or new.job_id is distinct from old.job_id
      or new.job_number is distinct from old.job_number
      or new.requirement_id is distinct from old.requirement_id
      or new.allocation_kind is distinct from old.allocation_kind
    then
      perform app_api.raise_http(409, 'A pending-transfer allocation cannot be strengthened or reassigned.');
    end if;
    return new;
  end if;

  if v_old_reserves and not v_new_reserves then
    if v_action not in ('cancel', 'release') then
      perform set_config('app.transfer_workflow_action', 'release', true);
    end if;
    return new;
  end if;

  -- Job/requirement removal uses ON DELETE SET NULL after the allocation has
  -- already been status-released. Preserve every other historical field while
  -- allowing only those canonical FK pointers to clear.
  if v_action in ('cancel', 'release')
    and new.box_id is not distinct from old.box_id
    and new.warehouse is not distinct from old.warehouse
    and new.job_number is not distinct from old.job_number
    and new.allocation_kind is not distinct from old.allocation_kind
    and new.allocated_feet is not distinct from old.allocated_feet
    and (
      new.job_id is not distinct from old.job_id
      or (old.job_id is not null and new.job_id is null)
    )
    and (
      new.requirement_id is not distinct from old.requirement_id
      or (old.requirement_id is not null and new.requirement_id is null)
    )
  then
    return new;
  end if;

  if new.box_id is distinct from old.box_id
    or new.warehouse is distinct from old.warehouse
    or new.job_id is distinct from old.job_id
    or new.job_number is distinct from old.job_number
    or new.requirement_id is distinct from old.requirement_id
    or new.allocation_kind is distinct from old.allocation_kind
    or new.allocated_feet is distinct from old.allocated_feet
  then
    perform app_api.raise_http(409, 'Released pending-transfer allocation history cannot be reassigned.');
  end if;

  return new;
end;
$$;

drop trigger if exists trg_0191_guard_pending_transfer_allocations on app.allocations;
create trigger trg_0191_guard_pending_transfer_allocations
before insert or update or delete on app.allocations
for each row execute function app_api.guard_pending_transfer_allocation_mutation();

create or replace function app_api.guard_pending_transfer_box_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_transfer app.box_transfers;
  v_action text := app_api.current_transfer_workflow_action();
begin
  if tg_op = 'DELETE' then
    select * into v_transfer
    from app.box_transfers t
    where t.org_id = old.org_id
      and t.box_record_id = old.id
      and t.status = 'PENDING'
    limit 1;

    if found then
      perform app_api.raise_http(409, 'A box with a pending transfer cannot be deleted.');
    end if;
    return old;
  end if;

  select * into v_transfer
  from app.box_transfers t
  where t.org_id = new.org_id
    and t.box_record_id = new.id
    and t.status = 'PENDING'
  limit 1;

  if not found then
    return new;
  end if;

  if v_action = 'start' then
    if (to_jsonb(new) - array['status', 'feet_available', 'updated_at', 'updated_by']::text[])
      is distinct from
      (to_jsonb(old) - array['status', 'feet_available', 'updated_at', 'updated_by']::text[])
      or upper(coalesce(new.status::text, '')) <> 'TRANSFER'
    then
      perform app_api.raise_http(409, 'Transfer start may only reserve the in-stock box for transit.');
    end if;
    return new;
  end if;

  if v_action = 'receive' then
    if new.id is distinct from old.id
      or new.org_id is distinct from old.org_id
      or new.box_id <> v_transfer.destination_box_id
      or upper(new.warehouse) <> v_transfer.destination_warehouse
      or upper(coalesce(new.status::text, '')) <> 'IN_STOCK'
      or new.initial_feet is distinct from old.initial_feet
      or new.last_roll_weight_lbs is distinct from old.last_roll_weight_lbs
      or new.core_weight_lbs is distinct from old.core_weight_lbs
      or new.lf_weight_lbs_per_ft is distinct from old.lf_weight_lbs_per_ft
    then
      perform app_api.raise_http(409, 'Transfer receipt must preserve physical box quantity and weight.');
    end if;
    return new;
  end if;

  if v_action = 'cancel' then
    if (to_jsonb(new) - array['status', 'feet_available', 'updated_at', 'updated_by']::text[])
      is distinct from
      (to_jsonb(old) - array['status', 'feet_available', 'updated_at', 'updated_by']::text[])
      or upper(coalesce(new.status::text, '')) <> 'IN_STOCK'
    then
      perform app_api.raise_http(409, 'Transfer cancellation must restore the reviewed in-stock source state.');
    end if;
    return new;
  end if;

  if v_action = 'release' then
    if (to_jsonb(new) - array['feet_available', 'updated_at', 'updated_by']::text[])
      is distinct from
      (to_jsonb(old) - array['feet_available', 'updated_at', 'updated_by']::text[])
    then
      perform app_api.raise_http(409, 'Allocation release may only recalculate available LF on a pending-transfer box.');
    end if;
    return new;
  end if;

  perform app_api.raise_http(
    409,
    format('Box %s has a pending transfer and can only be received, cancelled, or have its linked claim released.', old.box_id)
  );
  return new;
end;
$$;

drop trigger if exists trg_0191_guard_pending_transfer_boxes on app.boxes;
create trigger trg_0191_guard_pending_transfer_boxes
before update or delete on app.boxes
for each row execute function app_api.guard_pending_transfer_box_mutation();

create or replace function app_api.guard_box_transfer_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_box app.boxes;
  v_linked app.allocations;
  v_action text := app_api.current_transfer_workflow_action();
  v_reservation_count integer := 0;
begin
  if tg_op = 'DELETE' then
    perform app_api.raise_http(409, 'Transfer history cannot be deleted.');
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'PENDING' or v_action <> 'start' then
      perform app_api.raise_http(409, 'Transfers must begin through the canonical pending-transfer start workflow.');
    end if;

    select * into v_box
    from app.boxes b
    where b.org_id = new.org_id
      and b.id = new.box_record_id
    for update;

    if not found
      or upper(coalesce(v_box.status::text, '')) <> 'IN_STOCK'
      or v_box.box_id <> new.source_box_id
      or upper(v_box.warehouse) <> new.source_warehouse
    then
      perform app_api.raise_http(409, 'A transfer may start only from its current in-stock source box.');
    end if;

    select count(*)::integer
    into v_reservation_count
    from app.allocations a
    where a.org_id = new.org_id
      and a.box_id = new.source_box_id
      and app_api.film_allocation_reserves_capacity(a, v_box.status::text);

    if app_api.trim_text(new.transfer_created_allocation_id) = '' then
      if v_reservation_count <> 0 then
        perform app_api.raise_http(409, 'Ordinary transfers require zero film reservations.');
      end if;
    else
      select * into v_linked
      from app.allocations a
      where a.org_id = new.org_id
        and a.allocation_id = new.transfer_created_allocation_id
      for update;

      if not found
        or v_reservation_count <> 1
        or v_linked.box_id <> new.source_box_id
        or coalesce(v_linked.allocation_kind::text, 'REQUIREMENT') <> 'REQUIREMENT'
        or v_linked.requirement_id is null
        or not app_api.film_allocation_reserves_capacity(v_linked, v_box.status::text)
        or not exists (
          select 1
          from app.jobs j
          where j.org_id = new.org_id
            and j.id = v_linked.job_id
            and upper(j.warehouse) = new.destination_warehouse
        )
      then
        perform app_api.raise_http(409, 'Allocation-assisted transfer requires exactly its one first reservation.');
      end if;
    end if;
    return new;
  end if;

  if new.org_id is distinct from old.org_id
    or new.id is distinct from old.id
    or new.transfer_id is distinct from old.transfer_id
    or new.box_record_id is distinct from old.box_record_id
    or new.source_box_id is distinct from old.source_box_id
    or new.source_warehouse is distinct from old.source_warehouse
    or new.destination_box_id is distinct from old.destination_box_id
    or new.destination_warehouse is distinct from old.destination_warehouse
    or new.transfer_created_allocation_id is distinct from old.transfer_created_allocation_id
  then
    perform app_api.raise_http(409, 'Transfer identity and allocation linkage are immutable.');
  end if;

  if old.status <> 'PENDING' then
    perform app_api.raise_http(409, 'Completed or cancelled transfer history is immutable.');
  end if;

  if new.status = 'RECEIVED' and v_action = 'receive' then
    return new;
  end if;
  if new.status = 'CANCELLED' and v_action = 'cancel' then
    return new;
  end if;

  perform app_api.raise_http(409, 'Pending transfers may only be received or cancelled through the canonical workflow.');
  return new;
end;
$$;

drop trigger if exists trg_0191_guard_box_transfers on app.box_transfers;
create trigger trg_0191_guard_box_transfers
before insert or update or delete on app.box_transfers
for each row execute function app_api.guard_box_transfer_mutation();

create or replace function app_api.release_pending_transfer_allocations(
  p_org_id uuid,
  p_actor text,
  p_job_id uuid default null,
  p_requirement_id uuid default null,
  p_reason text default 'Released because the linked business need was removed.',
  p_phase_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_entry record;
  v_physical_feet integer := 0;
  v_released_count integer := 0;
  v_actor text := coalesce(nullif(app_api.trim_text(p_actor), ''), 'transfer-lifecycle-guard');
begin
  perform app_api.lock_film_material_flow();
  perform set_config('app.transfer_workflow_action', 'release', true);

  for v_entry in
    select
      a.allocation_id,
      a.box_id,
      b.id as box_record_id
    from app.box_transfers t
    join app.allocations a
      on a.org_id = t.org_id
     and a.allocation_id = t.transfer_created_allocation_id
    join app.boxes b
      on b.org_id = a.org_id
     and b.box_id = a.box_id
    left join app.job_requirements requirement
      on requirement.org_id = a.org_id
     and requirement.id = a.requirement_id
    where t.org_id = p_org_id
      and t.status = 'PENDING'
      and t.transfer_created_allocation_id is not null
      and a.status = 'ACTIVE'
      and (p_job_id is null or a.job_id = p_job_id)
      and (p_requirement_id is null or a.requirement_id = p_requirement_id)
      and (p_phase_id is null or requirement.phase_id = p_phase_id)
    order by b.box_id, a.allocation_id
    for update of b, a
  loop
    select coalesce(app_api.box_physical_feet_available(b), 0)
    into v_physical_feet
    from app.boxes b
    where b.org_id = p_org_id
      and b.id = v_entry.box_record_id;

    update app.allocations
    set status = 'CANCELLED',
        resolved_at = timezone('utc', now()),
        resolved_by = v_actor,
        notes = trim(
          coalesce(notes, '') ||
          case when coalesce(notes, '') = '' then '' else ' ' end ||
          app_api.trim_text(p_reason)
        )
    where org_id = p_org_id
      and allocation_id = v_entry.allocation_id
      and status = 'ACTIVE';

    if found then
      v_released_count := v_released_count + 1;
      perform app_api.recalculate_physical_box_allocatable_now(
        p_org_id,
        v_entry.box_id,
        v_physical_feet
      );
    end if;
  end loop;

  return v_released_count;
end;
$$;

create or replace function app_api.guard_pending_transfer_job_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_actor text := coalesce(nullif(current_setting('app.actor', true), ''), 'transfer-lifecycle-guard');
  v_has_pending boolean := false;
begin
  select exists (
    select 1
    from app.box_transfers t
    join app.allocations a
      on a.org_id = t.org_id
     and a.allocation_id = t.transfer_created_allocation_id
    where t.org_id = old.org_id
      and t.status = 'PENDING'
      and a.job_id = old.id
  ) into v_has_pending;

  if not v_has_pending then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    perform app_api.release_pending_transfer_allocations(
      old.org_id,
      v_actor,
      old.id,
      null,
      'Released because the linked job was deleted.'
    );
    return old;
  end if;

  if new.is_staged_for_pickup and not coalesce(old.is_staged_for_pickup, false) then
    perform app_api.raise_http(409, 'A job with film still in transfer cannot be staged for pickup.');
  end if;

  if new.lifecycle_status::text = 'COMPLETED'
    and old.lifecycle_status is distinct from new.lifecycle_status
  then
    perform app_api.raise_http(409, 'A job with film still in transfer cannot be completed or consumed.');
  end if;

  if new.lifecycle_status::text = 'CANCELLED'
    and old.lifecycle_status is distinct from new.lifecycle_status
  then
    perform app_api.release_pending_transfer_allocations(
      old.org_id,
      v_actor,
      old.id,
      null,
      'Released because the linked job was cancelled.'
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_0191_guard_pending_transfer_jobs on app.jobs;
create trigger trg_0191_guard_pending_transfer_jobs
before update or delete on app.jobs
for each row execute function app_api.guard_pending_transfer_job_mutation();

create or replace function app_api.guard_pending_transfer_requirement_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_actor text := coalesce(nullif(current_setting('app.actor', true), ''), 'transfer-lifecycle-guard');
  v_has_pending boolean := false;
begin
  select exists (
    select 1
    from app.box_transfers t
    join app.allocations a
      on a.org_id = t.org_id
     and a.allocation_id = t.transfer_created_allocation_id
    where t.org_id = old.org_id
      and t.status = 'PENDING'
      and a.requirement_id = old.id
  ) into v_has_pending;

  if not v_has_pending then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    perform app_api.release_pending_transfer_allocations(
      old.org_id,
      v_actor,
      null,
      old.id,
      'Released because the linked requirement was removed.'
    );
    return old;
  end if;

  if new.status is distinct from old.status
    or new.actual_used_feet > old.actual_used_feet
    or new.required_feet is distinct from old.required_feet
    or new.manufacturer is distinct from old.manufacturer
    or new.film_name is distinct from old.film_name
    or new.width_in is distinct from old.width_in
    or new.job_id is distinct from old.job_id
    or new.phase_id is distinct from old.phase_id
  then
    perform app_api.raise_http(409, 'A requirement with film still in transfer cannot be completed, consumed, or reassigned.');
  end if;

  return new;
end;
$$;

drop trigger if exists trg_0191_guard_pending_transfer_requirements on app.job_requirements;
create trigger trg_0191_guard_pending_transfer_requirements
before update or delete on app.job_requirements
for each row execute function app_api.guard_pending_transfer_requirement_mutation();

create or replace function app_api.guard_pending_transfer_phase_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_actor text := coalesce(nullif(current_setting('app.actor', true), ''), 'transfer-lifecycle-guard');
  v_has_pending boolean := false;
begin
  select exists (
    select 1
    from app.box_transfers t
    join app.allocations a
      on a.org_id = t.org_id
     and a.allocation_id = t.transfer_created_allocation_id
    join app.job_requirements requirement
      on requirement.org_id = a.org_id
     and requirement.id = a.requirement_id
    where t.org_id = old.org_id
      and t.status = 'PENDING'
      and requirement.phase_id = old.id
  ) into v_has_pending;

  if not v_has_pending then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    perform app_api.release_pending_transfer_allocations(
      old.org_id,
      v_actor,
      null,
      null,
      'Released because the linked phase was removed.',
      old.id
    );
    return old;
  end if;

  if new.workflow_status = 'PLACEHOLDER'
    and old.workflow_status is distinct from new.workflow_status
  then
    perform app_api.release_pending_transfer_allocations(
      old.org_id,
      v_actor,
      null,
      null,
      'Released because the linked phase was made a placeholder.',
      old.id
    );
  elsif new.workflow_status = 'ACTIVE'
    and old.workflow_status is distinct from new.workflow_status
  then
    perform app_api.raise_http(409, 'A phase with film still in transfer cannot be reactivated.');
  end if;

  if upper(coalesce(new.labor_status, '')) = 'COMPLETE'
    and old.labor_status is distinct from new.labor_status
  then
    perform app_api.raise_http(409, 'A phase with film still in transfer cannot be completed or consumed.');
  end if;

  if new.job_id is distinct from old.job_id then
    perform app_api.raise_http(409, 'A phase with film still in transfer cannot be reassigned.');
  end if;

  return new;
end;
$$;

drop trigger if exists trg_0191_guard_pending_transfer_phases on app.job_phases;
create trigger trg_0191_guard_pending_transfer_phases
before update or delete on app.job_phases
for each row execute function app_api.guard_pending_transfer_phase_mutation();

create or replace function app_api.assert_pending_transfer_consistency(
  p_org_id uuid,
  p_box_record_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_transfer app.box_transfers;
  v_box app.boxes;
  v_linked app.allocations;
begin
  select * into v_transfer
  from app.box_transfers t
  where t.org_id = p_org_id
    and t.box_record_id = p_box_record_id
    and t.status = 'PENDING'
  limit 1;

  if not found then
    return;
  end if;

  select * into v_box
  from app.boxes b
  where b.org_id = p_org_id
    and b.id = p_box_record_id;

  if not found
    or upper(coalesce(v_box.status::text, '')) <> 'TRANSFER'
    or v_box.box_id <> v_transfer.source_box_id
    or upper(v_box.warehouse) <> v_transfer.source_warehouse
  then
    perform app_api.raise_http(409, 'Pending transfer and physical box custody are inconsistent.');
  end if;

  if app_api.trim_text(v_transfer.transfer_created_allocation_id) <> '' then
    select * into v_linked
    from app.allocations a
    where a.org_id = p_org_id
      and a.allocation_id = v_transfer.transfer_created_allocation_id;

    if not found
      or v_linked.box_id <> v_transfer.source_box_id
      or coalesce(v_linked.allocation_kind::text, 'REQUIREMENT') <> 'REQUIREMENT'
    then
      perform app_api.raise_http(409, 'Pending transfer allocation linkage is inconsistent.');
    end if;

    if app_api.film_allocation_reserves_capacity(v_linked, v_box.status::text)
      and (
        v_linked.requirement_id is null
        or not exists (
          select 1
          from app.jobs j
          where j.org_id = p_org_id
            and j.id = v_linked.job_id
            and upper(j.warehouse) = v_transfer.destination_warehouse
        )
      )
    then
      perform app_api.raise_http(409, 'Pending transfer active business linkage is inconsistent.');
    end if;

    if exists (
      select 1
      from app.allocations a
      where a.org_id = p_org_id
        and a.box_id = v_transfer.source_box_id
        and a.allocation_id <> v_transfer.transfer_created_allocation_id
        and app_api.film_allocation_reserves_capacity(a, v_box.status::text)
    ) then
      perform app_api.raise_http(409, 'Pending transfer has more than its one transfer-created reservation.');
    end if;
  end if;
end;
$$;

create or replace function app_api.enforce_pending_transfer_consistency_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_org_id uuid;
  v_box_record_id uuid;
begin
  if tg_table_name = 'box_transfers' then
    if tg_op = 'DELETE' then
      v_org_id := old.org_id;
      v_box_record_id := old.box_record_id;
    else
      v_org_id := new.org_id;
      v_box_record_id := new.box_record_id;
    end if;
  elsif tg_table_name = 'boxes' then
    if tg_op = 'DELETE' then
      v_org_id := old.org_id;
      v_box_record_id := old.id;
    else
      v_org_id := new.org_id;
      v_box_record_id := new.id;
    end if;
  else
    if tg_op = 'DELETE' then
      v_org_id := old.org_id;
      select t.box_record_id
      into v_box_record_id
      from app.box_transfers t
      where t.org_id = v_org_id
        and t.status = 'PENDING'
        and (
          t.transfer_created_allocation_id = old.allocation_id
          or t.source_box_id = old.box_id
        )
      limit 1;
    else
      v_org_id := new.org_id;
      select t.box_record_id
      into v_box_record_id
      from app.box_transfers t
      where t.org_id = v_org_id
        and t.status = 'PENDING'
        and (
          t.transfer_created_allocation_id = new.allocation_id
          or t.source_box_id = new.box_id
        )
      limit 1;
    end if;
  end if;

  if v_org_id is not null and v_box_record_id is not null then
    perform app_api.assert_pending_transfer_consistency(v_org_id, v_box_record_id);
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_0191_transfer_consistency_transfer on app.box_transfers;
create constraint trigger trg_0191_transfer_consistency_transfer
after insert or update or delete on app.box_transfers
deferrable initially deferred
for each row execute function app_api.enforce_pending_transfer_consistency_trigger();

drop trigger if exists trg_0191_transfer_consistency_box on app.boxes;
create constraint trigger trg_0191_transfer_consistency_box
after update or delete on app.boxes
deferrable initially deferred
for each row execute function app_api.enforce_pending_transfer_consistency_trigger();

drop trigger if exists trg_0191_transfer_consistency_allocation on app.allocations;
create constraint trigger trg_0191_transfer_consistency_allocation
after insert or update or delete on app.allocations
deferrable initially deferred
for each row execute function app_api.enforce_pending_transfer_consistency_trigger();

-- Put all existing material-flow entry points behind the same advisory lock
-- before their historical row-lock order begins. The preserved implementations
-- remain private and continue to own their existing business behavior.
do $$
declare
  v_sources text[] := array[
    'api_allocations_remove_box',
    'api_acl_allocations_remove_box',
    'api_acl_boxes_set_status',
    'api_acl_boxes_resolve_checkout_allocations',
    'api_acl_jobs_update',
    'api_acl_job_requirement_set_state',
    'api_acl_job_phase_set_state',
    'api_acl_film_orders_cancel',
    'api_acl_jobs_set_staged_pickup',
    'api_acl_jobs_set_staged_pickup_for_user'
  ];
  v_targets text[] := array[
    'api_allocations_remove_box_pre_0191',
    'api_acl_allocations_remove_box_pre_0191',
    'api_acl_boxes_set_status_pre_0191',
    'api_acl_boxes_resolve_checkout_allocations_pre_0191',
    'api_acl_jobs_update_pre_0191',
    'api_acl_job_requirement_set_state_pre_0191',
    'api_acl_job_phase_set_state_pre_0191',
    'api_acl_film_orders_cancel_pre_0191',
    'api_acl_jobs_set_staged_pickup_pre_0191',
    'api_acl_jobs_set_staged_pickup_for_user_pre_0191'
  ];
  v_signatures text[] := array[
    'public.api_allocations_remove_box(uuid, text, jsonb)',
    'public.api_acl_allocations_remove_box(uuid, text, jsonb)',
    'public.api_acl_boxes_set_status(uuid, text, jsonb)',
    'public.api_acl_boxes_resolve_checkout_allocations(uuid, text, jsonb)',
    'public.api_acl_jobs_update(uuid, text, jsonb)',
    'public.api_acl_job_requirement_set_state(uuid, text, jsonb)',
    'public.api_acl_job_phase_set_state(uuid, text, jsonb)',
    'public.api_acl_film_orders_cancel(uuid, text, jsonb)',
    'public.api_acl_jobs_set_staged_pickup(uuid, text, jsonb)',
    'public.api_acl_jobs_set_staged_pickup_for_user(uuid, uuid, text, jsonb)'
  ];
  v_index integer;
  v_def text;
begin
  for v_index in 1..array_length(v_sources, 1) loop
    select pg_get_functiondef(v_signatures[v_index]::regprocedure)
    into v_def;
    v_def := regexp_replace(
      v_def,
      '^CREATE OR REPLACE FUNCTION public\.' || v_sources[v_index],
      'CREATE OR REPLACE FUNCTION app_api.' || v_targets[v_index]
    );
    execute v_def;
  end loop;
end;
$$;

revoke execute on function app_api.api_allocations_remove_box_pre_0191(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke execute on function app_api.api_acl_allocations_remove_box_pre_0191(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke execute on function app_api.api_acl_boxes_set_status_pre_0191(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke execute on function app_api.api_acl_boxes_resolve_checkout_allocations_pre_0191(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke execute on function app_api.api_acl_jobs_update_pre_0191(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke execute on function app_api.api_acl_job_requirement_set_state_pre_0191(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke execute on function app_api.api_acl_job_phase_set_state_pre_0191(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke execute on function app_api.api_acl_film_orders_cancel_pre_0191(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke execute on function app_api.api_acl_jobs_set_staged_pickup_pre_0191(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke execute on function app_api.api_acl_jobs_set_staged_pickup_for_user_pre_0191(uuid, uuid, text, jsonb) from public, anon, authenticated, service_role;

create or replace function public.api_allocations_remove_box(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.lock_film_material_flow();
  perform set_config('app.transfer_workflow_action', 'release', true);
  return app_api.api_allocations_remove_box_pre_0191(p_org_id, p_actor, p_payload);
end;
$$;

create or replace function public.api_acl_allocations_remove_box(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.lock_film_material_flow();
  perform set_config('app.transfer_workflow_action', 'release', true);
  return app_api.api_acl_allocations_remove_box_pre_0191(p_org_id, p_actor, p_payload);
end;
$$;

create or replace function public.api_acl_boxes_set_status(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.lock_film_material_flow();
  return app_api.api_acl_boxes_set_status_pre_0191(p_org_id, p_actor, p_payload);
end;
$$;

create or replace function public.api_acl_boxes_resolve_checkout_allocations(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.lock_film_material_flow();
  return app_api.api_acl_boxes_resolve_checkout_allocations_pre_0191(p_org_id, p_actor, p_payload);
end;
$$;

create or replace function public.api_acl_jobs_update(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.lock_film_material_flow();
  return app_api.api_acl_jobs_update_pre_0191(p_org_id, p_actor, p_payload);
end;
$$;

create or replace function public.api_acl_job_requirement_set_state(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.lock_film_material_flow();
  return app_api.api_acl_job_requirement_set_state_pre_0191(p_org_id, p_actor, p_payload);
end;
$$;

create or replace function public.api_acl_job_phase_set_state(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.lock_film_material_flow();
  return app_api.api_acl_job_phase_set_state_pre_0191(p_org_id, p_actor, p_payload);
end;
$$;

create or replace function public.api_acl_film_orders_cancel(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.lock_film_material_flow();
  perform set_config('app.transfer_workflow_action', 'release', true);
  return app_api.api_acl_film_orders_cancel_pre_0191(p_org_id, p_actor, p_payload);
end;
$$;

create or replace function public.api_acl_jobs_set_staged_pickup(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.lock_film_material_flow();
  return app_api.api_acl_jobs_set_staged_pickup_pre_0191(p_org_id, p_actor, p_payload);
end;
$$;

create or replace function public.api_acl_jobs_set_staged_pickup_for_user(
  p_org_id uuid,
  p_actor_user_id uuid,
  p_actor text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.lock_film_material_flow();
  return app_api.api_acl_jobs_set_staged_pickup_for_user_pre_0191(
    p_org_id,
    p_actor_user_id,
    p_actor,
    p_payload
  );
end;
$$;

revoke execute on function public.api_box_transfer_start(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke execute on function public.api_box_transfer_receive(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke execute on function public.api_box_transfer_cancel(uuid, text, jsonb) from public, anon, authenticated, service_role;

revoke execute on function public.api_acl_box_transfer_start(uuid, text, jsonb) from public, anon, service_role;
revoke execute on function public.api_acl_box_transfer_receive(uuid, text, jsonb) from public, anon, service_role;
revoke execute on function public.api_acl_box_transfer_cancel(uuid, text, jsonb) from public, anon, service_role;
grant execute on function public.api_acl_box_transfer_start(uuid, text, jsonb) to authenticated;
grant execute on function public.api_acl_box_transfer_receive(uuid, text, jsonb) to authenticated;
grant execute on function public.api_acl_box_transfer_cancel(uuid, text, jsonb) to authenticated;

revoke execute on function app_api.lock_film_material_flow() from public, anon, authenticated, service_role;
revoke execute on function app_api.current_transfer_workflow_action() from public, anon, authenticated, service_role;
revoke execute on function app_api.public_box_transfer_json(app.box_transfers) from public, anon, authenticated, service_role;
revoke execute on function app_api.resolve_transfer_destination_box_id(uuid, app.boxes, text, text) from public, anon, authenticated, service_role;
revoke execute on function app_api.assert_transfer_destination_available(uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke execute on function app_api.start_box_transfer_locked(uuid, text, text, text, text, text, text, integer) from public, anon, authenticated, service_role;
revoke execute on function app_api.release_pending_transfer_allocations(uuid, text, uuid, uuid, text, uuid) from public, anon, authenticated, service_role;
revoke execute on function app_api.guard_pending_transfer_allocation_mutation() from public, anon, authenticated, service_role;
revoke execute on function app_api.guard_pending_transfer_box_mutation() from public, anon, authenticated, service_role;
revoke execute on function app_api.guard_box_transfer_mutation() from public, anon, authenticated, service_role;
revoke execute on function app_api.guard_pending_transfer_job_mutation() from public, anon, authenticated, service_role;
revoke execute on function app_api.guard_pending_transfer_requirement_mutation() from public, anon, authenticated, service_role;
revoke execute on function app_api.guard_pending_transfer_phase_mutation() from public, anon, authenticated, service_role;
revoke execute on function app_api.assert_pending_transfer_consistency(uuid, uuid) from public, anon, authenticated, service_role;
revoke execute on function app_api.enforce_pending_transfer_consistency_trigger() from public, anon, authenticated, service_role;
