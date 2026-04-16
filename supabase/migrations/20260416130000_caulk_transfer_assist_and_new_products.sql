-- Adds zero-stock warehouse seeding for new caulk products and a pending transfer workflow for job allocations.

do $$
begin
  create type app.caulk_transfer_status as enum ('PENDING', 'RECEIVED', 'CANCELLED');
exception
  when duplicate_object then
    null;
end;
$$;

alter table app.caulk_job_allocations
  drop constraint if exists caulk_job_allocations_org_id_id_key;
alter table app.caulk_job_allocations
  add constraint caulk_job_allocations_org_id_id_key unique (org_id, id);

create table if not exists app.caulk_transfers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations(id) on delete cascade,
  transfer_id text not null,
  caulk_allocation_id uuid not null,
  job_id uuid references app.jobs(id) on delete set null,
  job_number text not null,
  product_id uuid not null,
  source_warehouse text not null,
  destination_warehouse text not null,
  pending_tubes integer not null,
  status app.caulk_transfer_status not null default 'PENDING',
  notes text not null default '',
  created_at timestamptz not null default now(),
  created_by text not null default '',
  received_at timestamptz,
  received_by text not null default '',
  cancelled_at timestamptz,
  cancelled_by text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text not null default '',
  unique (org_id, transfer_id),
  foreign key (org_id, caulk_allocation_id)
    references app.caulk_job_allocations(org_id, id)
    on delete cascade,
  foreign key (org_id, product_id)
    references app.caulk_products(org_id, id)
    on delete restrict,
  foreign key (org_id, source_warehouse)
    references app.warehouses(org_id, code)
    on delete restrict,
  foreign key (org_id, destination_warehouse)
    references app.warehouses(org_id, code)
    on delete restrict
);

alter table app.caulk_transfers
  drop constraint if exists caulk_transfers_value_format;
alter table app.caulk_transfers
  add constraint caulk_transfers_value_format check (
    transfer_id = upper(btrim(transfer_id))
    and btrim(transfer_id) <> ''
    and btrim(job_number) <> ''
    and source_warehouse = upper(btrim(source_warehouse))
    and destination_warehouse = upper(btrim(destination_warehouse))
    and source_warehouse ~ '^[A-Z]{2}[1-9][0-9]{0,6}$'
    and destination_warehouse ~ '^[A-Z]{2}[1-9][0-9]{0,6}$'
    and source_warehouse <> destination_warehouse
    and pending_tubes > 0
  );

create index if not exists idx_caulk_transfers_org_status_created
  on app.caulk_transfers (org_id, status, created_at desc, id desc);

create index if not exists idx_caulk_transfers_org_allocation_created
  on app.caulk_transfers (org_id, caulk_allocation_id, created_at desc, id desc);

create index if not exists idx_caulk_transfers_destination_product_status
  on app.caulk_transfers (org_id, destination_warehouse, product_id, status, created_at desc, id desc);

create unique index if not exists idx_caulk_transfers_one_pending_per_allocation
  on app.caulk_transfers (org_id, caulk_allocation_id)
  where status = 'PENDING';

create or replace function app_api.caulk_seed_stock_row(
  p_org_id uuid,
  p_actor text,
  p_product_id uuid,
  p_warehouse text
)
returns text
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_actor text := app_api.trim_text(p_actor);
  v_warehouse text := app_api.caulk_require_warehouse(p_org_id, p_warehouse);
begin
  insert into app.caulk_stock (
    org_id,
    product_id,
    warehouse,
    tubes_on_hand,
    updated_by
  )
  values (
    p_org_id,
    p_product_id,
    v_warehouse,
    0,
    v_actor
  )
  on conflict (org_id, product_id, warehouse) do nothing;

  return v_warehouse;
end;
$$;

create or replace function app_api.caulk_save_transfer_record(
  p_org_id uuid,
  p_transfer_id text,
  p_caulk_allocation_id uuid,
  p_job_id uuid,
  p_job_number text,
  p_product_id uuid,
  p_source_warehouse text,
  p_destination_warehouse text,
  p_pending_tubes integer,
  p_status app.caulk_transfer_status,
  p_notes text default '',
  p_created_at timestamptz default now(),
  p_created_by text default '',
  p_received_at timestamptz default null,
  p_received_by text default '',
  p_cancelled_at timestamptz default null,
  p_cancelled_by text default '',
  p_updated_at timestamptz default now(),
  p_updated_by text default ''
)
returns app.caulk_transfers
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_row app.caulk_transfers;
begin
  insert into app.caulk_transfers (
    org_id,
    transfer_id,
    caulk_allocation_id,
    job_id,
    job_number,
    product_id,
    source_warehouse,
    destination_warehouse,
    pending_tubes,
    status,
    notes,
    created_at,
    created_by,
    received_at,
    received_by,
    cancelled_at,
    cancelled_by,
    updated_at,
    updated_by
  )
  values (
    p_org_id,
    upper(btrim(p_transfer_id)),
    p_caulk_allocation_id,
    p_job_id,
    app_api.trim_text(p_job_number),
    p_product_id,
    upper(btrim(p_source_warehouse)),
    upper(btrim(p_destination_warehouse)),
    p_pending_tubes,
    p_status,
    app_api.trim_text(p_notes),
    coalesce(p_created_at, now()),
    app_api.trim_text(p_created_by),
    p_received_at,
    app_api.trim_text(p_received_by),
    p_cancelled_at,
    app_api.trim_text(p_cancelled_by),
    coalesce(p_updated_at, now()),
    app_api.trim_text(p_updated_by)
  )
  on conflict (org_id, transfer_id) do update
  set
    caulk_allocation_id = excluded.caulk_allocation_id,
    job_id = excluded.job_id,
    job_number = excluded.job_number,
    product_id = excluded.product_id,
    source_warehouse = excluded.source_warehouse,
    destination_warehouse = excluded.destination_warehouse,
    pending_tubes = excluded.pending_tubes,
    status = excluded.status,
    notes = excluded.notes,
    received_at = excluded.received_at,
    received_by = excluded.received_by,
    cancelled_at = excluded.cancelled_at,
    cancelled_by = excluded.cancelled_by,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function app_api.caulk_reserve_local_tubes(
  p_org_id uuid,
  p_actor text,
  p_product_id uuid,
  p_target_warehouse text,
  p_reserve_tubes integer,
  p_reserve_action text,
  p_reserve_reason text,
  p_source_box_id text default '',
  p_notes text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_actor text := app_api.trim_text(p_actor);
  v_notes text := app_api.trim_text(p_notes);
  v_source_box_id text := app_api.trim_text(p_source_box_id);
  v_target_warehouse text := app_api.caulk_seed_stock_row(
    p_org_id,
    p_actor,
    p_product_id,
    p_target_warehouse
  );
  v_target_stock app.caulk_stock;
  v_target_available integer := 0;
  v_reserved_tubes integer := 0;
  v_shortage_tubes integer := 0;
begin
  if p_reserve_tubes is null or p_reserve_tubes <= 0 then
    perform app_api.raise_http(400, 'Reserve quantity must be greater than zero.');
  end if;

  select *
  into v_target_stock
  from app.caulk_stock s
  where s.org_id = p_org_id
    and s.product_id = p_product_id
    and s.warehouse = v_target_warehouse
  for update;

  v_target_available := coalesce(v_target_stock.tubes_on_hand, 0);
  v_reserved_tubes := least(v_target_available, p_reserve_tubes);
  v_shortage_tubes := greatest(p_reserve_tubes - v_reserved_tubes, 0);

  if v_reserved_tubes > 0 then
    perform app_api.caulk_apply_stock_delta(
      p_org_id,
      v_actor,
      p_product_id,
      v_target_warehouse,
      p_reserve_action,
      -v_reserved_tubes,
      p_reserve_reason,
      '',
      v_source_box_id,
      v_notes
    );
  end if;

  return jsonb_build_object(
    'warehouse', v_target_warehouse,
    'reservedTubes', v_reserved_tubes,
    'shortageTubes', v_shortage_tubes
  );
end;
$$;

create or replace function app_api.caulk_start_pending_transfer(
  p_org_id uuid,
  p_actor text,
  p_allocation_row_id uuid,
  p_allocation_public_id text,
  p_job_id uuid,
  p_job_number text,
  p_product_id uuid,
  p_from_warehouse text,
  p_to_warehouse text,
  p_pending_tubes integer,
  p_notes text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_actor text := app_api.trim_text(p_actor);
  v_notes text := app_api.trim_text(p_notes);
  v_destination_warehouse text;
  v_requested_source_warehouse text := app_api.trim_text(p_from_warehouse);
  v_source_warehouse text;
  v_source_stock app.caulk_stock;
  v_source_available integer := 0;
  v_transfer_id text := '';
begin
  if coalesce(p_pending_tubes, 0) <= 0 then
    return jsonb_build_object(
      'transferId', '',
      'warnings', '[]'::jsonb
    );
  end if;

  v_destination_warehouse := app_api.caulk_seed_stock_row(
    p_org_id,
    p_actor,
    p_product_id,
    p_to_warehouse
  );

  if v_requested_source_warehouse = '' then
    perform app_api.raise_http(
      400,
      format(
        '%s still needs %s tube%s transferred in before this allocation can be saved. Select a source warehouse first.',
        v_destination_warehouse,
        p_pending_tubes,
        case when p_pending_tubes = 1 then '' else 's' end
      )
    );
  end if;

  v_source_warehouse := app_api.caulk_seed_stock_row(
    p_org_id,
    p_actor,
    p_product_id,
    v_requested_source_warehouse
  );

  if v_source_warehouse = v_destination_warehouse then
    perform app_api.raise_http(400, 'Transfer source and destination warehouse must differ.');
  end if;

  select *
  into v_source_stock
  from app.caulk_stock s
  where s.org_id = p_org_id
    and s.product_id = p_product_id
    and s.warehouse = v_source_warehouse
  for update;

  v_source_available := coalesce(v_source_stock.tubes_on_hand, 0);
  if v_source_available < p_pending_tubes then
    perform app_api.raise_http(
      400,
      format(
        '%s only has %s tube%s available; %s tube%s needed to cover the shortage at %s.',
        v_source_warehouse,
        v_source_available,
        case when v_source_available = 1 then '' else 's' end,
        p_pending_tubes,
        case when p_pending_tubes = 1 then '' else 's' end,
        v_destination_warehouse
      )
    );
  end if;

  v_transfer_id := app_api.caulk_create_transaction_id();

  perform app_api.caulk_apply_stock_delta(
    p_org_id,
    v_actor,
    p_product_id,
    v_source_warehouse,
    'TRANSFER_OUT',
    -p_pending_tubes,
    format(
      'Started caulk transfer from %s to %s for job %s.',
      v_source_warehouse,
      v_destination_warehouse,
      app_api.trim_text(p_job_number)
    ),
    v_transfer_id,
    app_api.trim_text(p_allocation_public_id),
    v_notes
  );

  perform app_api.caulk_save_transfer_record(
    p_org_id,
    v_transfer_id,
    p_allocation_row_id,
    p_job_id,
    p_job_number,
    p_product_id,
    v_source_warehouse,
    v_destination_warehouse,
    p_pending_tubes,
    'PENDING',
    v_notes,
    now(),
    v_actor,
    null,
    '',
    null,
    '',
    now(),
    v_actor
  );

  return jsonb_build_object(
    'transferId', v_transfer_id,
    'warnings', jsonb_build_array(
      format(
        'Started transfer of %s tube%s from %s to %s. Receive it before checkout or staging.',
        p_pending_tubes,
        case when p_pending_tubes = 1 then '' else 's' end,
        v_source_warehouse,
        v_destination_warehouse
      )
    )
  );
end;
$$;

create or replace function app_api.caulk_cancel_pending_transfer_internal(
  p_org_id uuid,
  p_actor text,
  p_transfer_id text,
  p_reason text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_transfer app.caulk_transfers;
  v_allocation app.caulk_job_allocations;
  v_actor text := app_api.trim_text(p_actor);
  v_pending_tubes integer := 0;
  v_reason text;
begin
  select *
  into v_transfer
  from app.caulk_transfers t
  where t.org_id = p_org_id
    and t.transfer_id = app_api.require_text(p_transfer_id, 'TransferId')
  for update;

  if not found then
    perform app_api.raise_http(404, 'Caulk transfer not found.');
  end if;

  if v_transfer.status <> 'PENDING' then
    perform app_api.raise_http(
      400,
      format('Caulk transfer %s is already %s.', v_transfer.transfer_id, lower(v_transfer.status::text))
    );
  end if;

  select *
  into v_allocation
  from app.caulk_job_allocations a
  where a.org_id = p_org_id
    and a.id = v_transfer.caulk_allocation_id
  for update;

  v_pending_tubes := coalesce(v_transfer.pending_tubes, 0);
  v_reason := coalesce(
    nullif(app_api.trim_text(p_reason), ''),
    format(
      'Cancelled caulk transfer from %s to %s for job %s.',
      v_transfer.source_warehouse,
      v_transfer.destination_warehouse,
      v_transfer.job_number
    )
  );

  if v_pending_tubes > 0 then
    perform app_api.caulk_apply_stock_delta(
      p_org_id,
      v_actor,
      v_transfer.product_id,
      v_transfer.source_warehouse,
      'TRANSFER_IN',
      v_pending_tubes,
      v_reason,
      v_transfer.transfer_id,
      '',
      v_reason
    );
  end if;

  perform app_api.caulk_save_transfer_record(
    p_org_id,
    v_transfer.transfer_id,
    v_transfer.caulk_allocation_id,
    v_transfer.job_id,
    v_transfer.job_number,
    v_transfer.product_id,
    v_transfer.source_warehouse,
    v_transfer.destination_warehouse,
    v_transfer.pending_tubes,
    'CANCELLED',
    v_reason,
    v_transfer.created_at,
    v_transfer.created_by,
    v_transfer.received_at,
    v_transfer.received_by,
    now(),
    v_actor,
    now(),
    v_actor
  );

  return jsonb_build_object(
    'jobNumber', coalesce(v_allocation.job_number, v_transfer.job_number),
    'caulkAllocationId', coalesce(v_allocation.caulk_allocation_id, ''),
    'transferId', v_transfer.transfer_id,
    'warnings',
      case
        when v_pending_tubes > 0 then jsonb_build_array(
          format(
            'Cancelled transfer %s and returned %s tube%s to %s.',
            v_transfer.transfer_id,
            v_pending_tubes,
            case when v_pending_tubes = 1 then '' else 's' end,
            v_transfer.source_warehouse
          )
        )
        else '[]'::jsonb
      end
  );
end;
$$;

create or replace function app_api.caulk_receive_pending_transfer_internal(
  p_org_id uuid,
  p_actor text,
  p_transfer_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_transfer app.caulk_transfers;
  v_allocation app.caulk_job_allocations;
  v_actor text := app_api.trim_text(p_actor);
  v_pending_tubes integer := 0;
  v_destination_warehouse text := '';
begin
  select *
  into v_transfer
  from app.caulk_transfers t
  where t.org_id = p_org_id
    and t.transfer_id = app_api.require_text(p_transfer_id, 'TransferId')
  for update;

  if not found then
    perform app_api.raise_http(404, 'Caulk transfer not found.');
  end if;

  if v_transfer.status <> 'PENDING' then
    perform app_api.raise_http(
      400,
      format('Caulk transfer %s is already %s.', v_transfer.transfer_id, lower(v_transfer.status::text))
    );
  end if;

  select *
  into v_allocation
  from app.caulk_job_allocations a
  where a.org_id = p_org_id
    and a.id = v_transfer.caulk_allocation_id
  for update;

  if not found then
    perform app_api.raise_http(404, 'Parent caulk allocation was not found.');
  end if;

  if v_allocation.status <> 'ACTIVE' then
    perform app_api.raise_http(400, 'Parent caulk allocation is no longer active.');
  end if;

  v_destination_warehouse := app_api.caulk_seed_stock_row(
    p_org_id,
    p_actor,
    v_transfer.product_id,
    v_transfer.destination_warehouse
  );
  v_pending_tubes := coalesce(v_transfer.pending_tubes, 0);

  if v_pending_tubes > 0 then
    perform app_api.caulk_apply_stock_delta(
      p_org_id,
      v_actor,
      v_transfer.product_id,
      v_destination_warehouse,
      'TRANSFER_IN',
      v_pending_tubes,
      format(
        'Received caulk transfer into %s for job %s.',
        v_destination_warehouse,
        v_allocation.job_number
      ),
      v_transfer.transfer_id,
      v_allocation.caulk_allocation_id,
      v_transfer.notes
    );

    perform app_api.caulk_apply_stock_delta(
      p_org_id,
      v_actor,
      v_transfer.product_id,
      v_destination_warehouse,
      'JOB_ALLOCATE_EDIT_INC',
      -v_pending_tubes,
      format(
        'Received pending caulk transfer for allocation %s.',
        v_allocation.caulk_allocation_id
      ),
      '',
      v_allocation.caulk_allocation_id,
      v_transfer.notes
    );
  end if;

  update app.caulk_job_allocations
  set
    reserved_tubes_remaining = reserved_tubes_remaining + v_pending_tubes,
    updated_at = now(),
    updated_by = v_actor
  where id = v_allocation.id
    and org_id = p_org_id;

  perform app_api.caulk_save_transfer_record(
    p_org_id,
    v_transfer.transfer_id,
    v_transfer.caulk_allocation_id,
    v_transfer.job_id,
    v_transfer.job_number,
    v_transfer.product_id,
    v_transfer.source_warehouse,
    v_transfer.destination_warehouse,
    v_transfer.pending_tubes,
    'RECEIVED',
    v_transfer.notes,
    v_transfer.created_at,
    v_transfer.created_by,
    now(),
    v_actor,
    v_transfer.cancelled_at,
    v_transfer.cancelled_by,
    now(),
    v_actor
  );

  return jsonb_build_object(
    'jobNumber', v_allocation.job_number,
    'caulkAllocationId', v_allocation.caulk_allocation_id,
    'transferId', v_transfer.transfer_id,
    'warnings', jsonb_build_array(
      format(
        'Received %s tube%s into %s and reserved it for allocation %s.',
        v_pending_tubes,
        case when v_pending_tubes = 1 then '' else 's' end,
        v_destination_warehouse,
        v_allocation.caulk_allocation_id
      )
    )
  );
end;
$$;

create or replace function app_api.cancel_active_caulk_allocations_for_job(
  p_org_id uuid,
  p_actor text,
  p_job_number text,
  p_reason text,
  p_fail_on_open_checkouts boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_entry app.caulk_job_allocations;
  v_actor text := app_api.trim_text(p_actor);
  v_job_number text := app_api.require_job_number_digits(p_job_number, 'Job ID number');
  v_reason text := coalesce(nullif(app_api.trim_text(p_reason), ''), format('Cancelled job %s.', v_job_number));
  v_pending_transfer_id text := '';
  v_open_checkout_count integer := 0;
  v_cancelled_count integer := 0;
  v_released_reserved_tubes integer := 0;
begin
  select count(*)
  into v_open_checkout_count
  from app.caulk_job_checkouts c
  join app.caulk_job_allocations a
    on a.id = c.caulk_allocation_id
   and a.org_id = c.org_id
  where c.org_id = p_org_id
    and upper(c.job_number) = upper(v_job_number)
    and c.status = 'OPEN'
    and a.status = 'ACTIVE';

  if p_fail_on_open_checkouts and v_open_checkout_count > 0 then
    perform app_api.raise_http(
      400,
      format(
        'Job %s cannot be closed while %s caulk checkout%s remain open.',
        v_job_number,
        v_open_checkout_count,
        case when v_open_checkout_count = 1 then '' else 's' end
      )
    );
  end if;

  for v_entry in
    select *
    from app.caulk_job_allocations a
    where a.org_id = p_org_id
      and upper(a.job_number) = upper(v_job_number)
      and a.status = 'ACTIVE'
    for update
  loop
    select t.transfer_id
    into v_pending_transfer_id
    from app.caulk_transfers t
    where t.org_id = p_org_id
      and t.caulk_allocation_id = v_entry.id
      and t.status = 'PENDING'
    order by t.created_at desc, t.id desc
    limit 1
    for update;

    if coalesce(v_pending_transfer_id, '') <> '' then
      perform app_api.caulk_cancel_pending_transfer_internal(
        p_org_id,
        v_actor,
        v_pending_transfer_id,
        format(
          'Cancelled pending transfer %s while closing job %s.',
          v_pending_transfer_id,
          v_job_number
        )
      );
    end if;

    if v_entry.reserved_tubes_remaining > 0 then
      perform app_api.caulk_apply_stock_delta(
        p_org_id,
        v_actor,
        v_entry.product_id,
        v_entry.warehouse,
        'JOB_ALLOCATION_CANCEL_RETURN',
        v_entry.reserved_tubes_remaining,
        v_reason,
        '',
        v_entry.caulk_allocation_id,
        v_reason
      );
      v_released_reserved_tubes := v_released_reserved_tubes + v_entry.reserved_tubes_remaining;
    end if;

    update app.caulk_job_allocations
    set
      status = 'CANCELLED',
      reserved_tubes_remaining = 0,
      resolved_at = now(),
      resolved_by = v_actor,
      notes = v_reason,
      updated_at = now(),
      updated_by = v_actor
    where id = v_entry.id
      and org_id = p_org_id;

    v_cancelled_count := v_cancelled_count + 1;
  end loop;

  return jsonb_build_object(
    'jobNumber', v_job_number,
    'openCheckoutCount', v_open_checkout_count,
    'cancelledAllocationCount', v_cancelled_count,
    'releasedReservedTubes', v_released_reserved_tubes
  );
end;
$$;

drop function if exists public.api_acl_list_caulk_job_allocations_by_job(uuid, text);

create or replace function public.api_acl_list_caulk_job_allocations_by_job(
  p_org_id uuid,
  p_job_number text
)
returns table (
  caulk_allocation_id text,
  requirement_id uuid,
  product_id uuid,
  manufacturer_id uuid,
  manufacturer text,
  product_name text,
  product_code text,
  tubes_per_case integer,
  warehouse text,
  allocated_tubes integer,
  reserved_tubes_remaining integer,
  checked_out_tubes_total integer,
  returned_unused_tubes_total integer,
  used_tubes_total integer,
  overage_tubes_total integer,
  outstanding_checkout_tubes integer,
  open_checkout_count integer,
  status text,
  created_at timestamptz,
  created_by text,
  updated_at timestamptz,
  updated_by text,
  resolved_at timestamptz,
  resolved_by text,
  notes text,
  pending_transfer_id text,
  pending_transfer_source_warehouse text,
  pending_transfer_destination_warehouse text,
  pending_transfer_tubes integer,
  pending_transfer_started_at timestamptz,
  pending_transfer_started_by text,
  pending_transfer_notes text
)
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_org_member(p_org_id);

  return query
  with open_counts as (
    select
      c.caulk_allocation_id,
      count(*)::integer as open_checkout_count
    from app.caulk_job_checkouts c
    where c.org_id = p_org_id
      and c.status = 'OPEN'
    group by c.caulk_allocation_id
  ),
  pending_transfers as (
    select distinct on (t.caulk_allocation_id)
      t.caulk_allocation_id,
      t.transfer_id,
      t.source_warehouse,
      t.destination_warehouse,
      t.pending_tubes,
      t.created_at,
      t.created_by,
      t.notes
    from app.caulk_transfers t
    where t.org_id = p_org_id
      and t.status = 'PENDING'
    order by t.caulk_allocation_id, t.created_at desc, t.id desc
  )
  select
    a.caulk_allocation_id,
    a.requirement_id,
    a.product_id,
    p.manufacturer_id,
    m.name,
    p.name,
    p.code,
    p.tubes_per_case,
    a.warehouse,
    a.allocated_tubes,
    a.reserved_tubes_remaining,
    a.checked_out_tubes_total,
    a.returned_unused_tubes_total,
    a.used_tubes_total,
    a.overage_tubes_total,
    greatest(a.checked_out_tubes_total - a.returned_unused_tubes_total - a.used_tubes_total, 0)::integer,
    coalesce(o.open_checkout_count, 0),
    a.status::text,
    a.created_at,
    a.created_by,
    a.updated_at,
    a.updated_by,
    a.resolved_at,
    a.resolved_by,
    a.notes,
    pt.transfer_id,
    pt.source_warehouse,
    pt.destination_warehouse,
    pt.pending_tubes,
    pt.created_at,
    pt.created_by,
    pt.notes
  from app.caulk_job_allocations a
  join app.caulk_products p
    on p.id = a.product_id
   and p.org_id = a.org_id
  join app.caulk_manufacturers m
    on m.id = p.manufacturer_id
   and m.org_id = p.org_id
  left join open_counts o
    on o.caulk_allocation_id = a.id
  left join pending_transfers pt
    on pt.caulk_allocation_id = a.id
  where a.org_id = p_org_id
    and upper(a.job_number) = upper(app_api.require_job_number_digits(p_job_number, 'Job ID number'))
  order by a.created_at desc, a.caulk_allocation_id desc;
end;
$$;

create or replace function public.api_acl_list_caulk_transfers(
  p_org_id uuid,
  p_warehouse text,
  p_product_id uuid default null
)
returns table (
  transfer_id text,
  caulk_allocation_id text,
  job_number text,
  product_id uuid,
  manufacturer_id uuid,
  manufacturer text,
  product_name text,
  product_code text,
  tubes_per_case integer,
  source_warehouse text,
  destination_warehouse text,
  pending_tubes integer,
  status text,
  created_at timestamptz,
  created_by text,
  received_at timestamptz,
  received_by text,
  cancelled_at timestamptz,
  cancelled_by text,
  updated_at timestamptz,
  updated_by text,
  notes text
)
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_warehouse text := app_api.caulk_require_warehouse(p_org_id, p_warehouse);
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'read');

  return query
  select
    t.transfer_id,
    a.caulk_allocation_id,
    a.job_number,
    p.id,
    p.manufacturer_id,
    m.name,
    p.name,
    p.code,
    p.tubes_per_case,
    t.source_warehouse,
    t.destination_warehouse,
    t.pending_tubes,
    t.status::text,
    t.created_at,
    t.created_by,
    t.received_at,
    t.received_by,
    t.cancelled_at,
    t.cancelled_by,
    t.updated_at,
    t.updated_by,
    t.notes
  from app.caulk_transfers t
  join app.caulk_job_allocations a
    on a.org_id = t.org_id
   and a.id = t.caulk_allocation_id
  join app.caulk_products p
    on p.org_id = t.org_id
   and p.id = t.product_id
  join app.caulk_manufacturers m
    on m.org_id = p.org_id
   and m.id = p.manufacturer_id
  where t.org_id = p_org_id
    and t.status = 'PENDING'
    and t.destination_warehouse = v_warehouse
    and (p_product_id is null or t.product_id = p_product_id)
  order by t.created_at desc, t.id desc;
end;
$$;

create or replace function public.api_acl_caulk_upsert_product(
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
  v_product_id uuid := nullif(app_api.trim_text(p_payload->>'productId'), '')::uuid;
  v_manufacturer_id uuid := nullif(app_api.trim_text(p_payload->>'manufacturerId'), '')::uuid;
  v_name text := p_payload->>'productName';
  v_code text := coalesce(p_payload->>'productCode', '');
  v_warehouse text := app_api.trim_text(p_payload->>'warehouse');
  v_tubes_per_case integer := coalesce(nullif(app_api.trim_text(p_payload->>'tubesPerCase'), '')::integer, 16);
  v_is_active boolean := coalesce((p_payload->>'isActive')::boolean, true);
  v_notes text := coalesce(p_payload->>'notes', '');
  v_row app.caulk_products;
  v_manufacturer_name text := '';
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');

  if v_manufacturer_id is null then
    perform app_api.raise_http(400, 'ManufacturerId is required.');
  end if;

  v_row := app_api.caulk_upsert_product(
    p_org_id,
    p_actor,
    v_product_id,
    v_manufacturer_id,
    v_name,
    v_code,
    v_tubes_per_case,
    v_is_active,
    v_notes
  );

  if v_warehouse <> '' then
    perform app_api.caulk_seed_stock_row(
      p_org_id,
      p_actor,
      v_row.id,
      v_warehouse
    );
  end if;

  select m.name
  into v_manufacturer_name
  from app.caulk_manufacturers m
  where m.org_id = p_org_id
    and m.id = v_row.manufacturer_id
  limit 1;

  return jsonb_build_object(
    'productId', v_row.id,
    'manufacturerId', v_row.manufacturer_id,
    'manufacturer', coalesce(v_manufacturer_name, ''),
    'productName', v_row.name,
    'productCode', v_row.code,
    'lookupKey', v_row.lookup_key,
    'tubesPerCase', v_row.tubes_per_case,
    'isActive', v_row.is_active,
    'notes', v_row.notes,
    'updatedAt', v_row.updated_at
  );
end;
$$;

create or replace function public.api_acl_allocations_caulk_add(
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
  v_job app.jobs;
  v_product app.caulk_products;
  v_requirement app.job_caulk_requirements;
  v_allocation_id text := app_api.create_log_id();
  v_allocation_row_id uuid := gen_random_uuid();
  v_job_number text := app_api.require_job_number_digits(p_payload->>'jobNumber', 'Job ID number');
  v_requirement_id uuid := nullif(app_api.trim_text(p_payload->>'requirementId'), '')::uuid;
  v_product_id uuid := nullif(app_api.trim_text(p_payload->>'productId'), '')::uuid;
  v_warehouse text := app_api.caulk_require_warehouse(p_org_id, p_payload->>'warehouse');
  v_allocated_tubes integer := floor(nullif(app_api.trim_text(p_payload->>'allocatedTubes'), '')::numeric);
  v_actor text := app_api.trim_text(p_actor);
  v_notes text := app_api.trim_text(p_payload->>'notes');
  v_local_reservation jsonb := '{}'::jsonb;
  v_reserved_tubes integer := 0;
  v_shortage_tubes integer := 0;
  v_transfer_result jsonb := jsonb_build_object('warnings', '[]'::jsonb);
begin
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'write');

  if v_product_id is null then
    perform app_api.raise_http(400, 'productId is required.');
  end if;

  if v_allocated_tubes is null or v_allocated_tubes <= 0 then
    perform app_api.raise_http(400, 'allocatedTubes must be greater than zero.');
  end if;

  v_job := app_api.require_active_job_for_caulk(p_org_id, v_job_number);

  select *
  into v_product
  from app.caulk_products p
  where p.org_id = p_org_id
    and p.id = v_product_id
  limit 1;

  if not found then
    perform app_api.raise_http(400, 'Product was not found.');
  end if;

  if v_requirement_id is not null then
    select *
    into v_requirement
    from app.job_caulk_requirements r
    where r.org_id = p_org_id
      and r.id = v_requirement_id
      and r.job_id = v_job.id
    for update;

    if not found then
      perform app_api.raise_http(400, 'RequirementId was not found for this job.');
    end if;
  end if;

  v_local_reservation := app_api.caulk_reserve_local_tubes(
    p_org_id,
    v_actor,
    v_product.id,
    v_warehouse,
    v_allocated_tubes,
    'JOB_ALLOCATE',
    format('Allocated caulk to job %s.', v_job.job_number),
    v_allocation_id,
    v_notes
  );
  v_reserved_tubes := coalesce((v_local_reservation->>'reservedTubes')::integer, 0);
  v_shortage_tubes := coalesce((v_local_reservation->>'shortageTubes')::integer, 0);

  insert into app.caulk_job_allocations (
    id,
    org_id,
    caulk_allocation_id,
    job_id,
    job_number,
    requirement_id,
    product_id,
    warehouse,
    allocated_tubes,
    reserved_tubes_remaining,
    checked_out_tubes_total,
    returned_unused_tubes_total,
    used_tubes_total,
    overage_tubes_total,
    status,
    created_at,
    created_by,
    updated_at,
    updated_by,
    notes
  )
  values (
    v_allocation_row_id,
    p_org_id,
    v_allocation_id,
    v_job.id,
    v_job.job_number,
    v_requirement_id,
    v_product.id,
    v_warehouse,
    v_allocated_tubes,
    v_reserved_tubes,
    0,
    0,
    0,
    0,
    'ACTIVE',
    now(),
    v_actor,
    now(),
    v_actor,
    v_notes
  );

  v_transfer_result := app_api.caulk_start_pending_transfer(
    p_org_id,
    v_actor,
    v_allocation_row_id,
    v_allocation_id,
    v_job.id,
    v_job.job_number,
    v_product.id,
    p_payload->>'transferFromWarehouse',
    v_warehouse,
    v_shortage_tubes,
    v_notes
  );

  return jsonb_build_object(
    'jobNumber', v_job.job_number,
    'caulkAllocationId', v_allocation_id,
    'warnings', coalesce(v_transfer_result->'warnings', '[]'::jsonb)
  );
end;
$$;

create or replace function public.api_acl_allocations_caulk_update(
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
  v_allocation app.caulk_job_allocations;
  v_pending_transfer_id text := '';
  v_actor text := app_api.trim_text(p_actor);
  v_caulk_allocation_id text := app_api.require_text(p_payload->>'caulkAllocationId', 'CaulkAllocationId');
  v_has_product_id boolean := p_payload ? 'productId';
  v_has_warehouse boolean := p_payload ? 'warehouse';
  v_has_allocated_tubes boolean := p_payload ? 'allocatedTubes';
  v_has_notes boolean := p_payload ? 'notes';
  v_has_transfer_selection boolean := app_api.trim_text(p_payload->>'transferFromWarehouse') <> '';
  v_has_material_edit boolean := false;
  v_next_product_id uuid;
  v_next_warehouse text;
  v_next_allocated_tubes integer;
  v_next_notes text;
  v_checked_out_tubes integer := 0;
  v_reserved_tubes integer := 0;
  v_allocated_tubes integer := 0;
  v_currently_covered integer := 0;
  v_additional_coverage_needed integer := 0;
  v_release_tubes integer := 0;
  v_next_reserved_tubes integer := 0;
  v_local_reservation jsonb := '{}'::jsonb;
  v_transfer_result jsonb := jsonb_build_object('warnings', '[]'::jsonb);
begin
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'write');

  select *
  into v_allocation
  from app.caulk_job_allocations a
  where a.org_id = p_org_id
    and a.caulk_allocation_id = v_caulk_allocation_id
  for update;

  if not found then
    perform app_api.raise_http(404, format('Caulk allocation %s was not found.', v_caulk_allocation_id));
  end if;

  if v_allocation.status <> 'ACTIVE' then
    perform app_api.raise_http(400, format('Caulk allocation %s is not active.', v_caulk_allocation_id));
  end if;

  perform app_api.require_active_job_for_caulk(p_org_id, v_allocation.job_number);

  select t.transfer_id
  into v_pending_transfer_id
  from app.caulk_transfers t
  where t.org_id = p_org_id
    and t.caulk_allocation_id = v_allocation.id
    and t.status = 'PENDING'
  order by t.created_at desc, t.id desc
  limit 1
  for update;

  v_has_material_edit := v_has_product_id or v_has_warehouse or v_has_allocated_tubes or v_has_transfer_selection;
  if coalesce(v_pending_transfer_id, '') <> '' and v_has_material_edit then
    perform app_api.raise_http(
      400,
      format('Receive or cancel transfer %s before editing this allocation.', v_pending_transfer_id)
    );
  end if;

  v_next_product_id := case
    when v_has_product_id and app_api.trim_text(p_payload->>'productId') <> ''
      then nullif(app_api.trim_text(p_payload->>'productId'), '')::uuid
    else v_allocation.product_id
  end;
  v_next_warehouse := case
    when v_has_warehouse
      then app_api.caulk_require_warehouse(p_org_id, p_payload->>'warehouse')
    else v_allocation.warehouse
  end;
  v_next_allocated_tubes := case
    when v_has_allocated_tubes
      then floor(nullif(app_api.trim_text(p_payload->>'allocatedTubes'), '')::numeric)
    else v_allocation.allocated_tubes
  end;
  v_next_notes := case
    when v_has_notes then app_api.trim_text(p_payload->>'notes')
    else v_allocation.notes
  end;

  if v_next_allocated_tubes is null or v_next_allocated_tubes <= 0 then
    perform app_api.raise_http(400, 'allocatedTubes must be greater than zero.');
  end if;

  if v_next_product_id <> v_allocation.product_id then
    perform 1
    from app.caulk_products p
    where p.org_id = p_org_id
      and p.id = v_next_product_id;
    if not found then
      perform app_api.raise_http(400, 'Product was not found.');
    end if;
  end if;

  v_checked_out_tubes := coalesce(v_allocation.checked_out_tubes_total, 0);
  v_reserved_tubes := coalesce(v_allocation.reserved_tubes_remaining, 0);
  v_allocated_tubes := coalesce(v_allocation.allocated_tubes, 0);

  if v_checked_out_tubes > 0 then
    if v_next_product_id <> v_allocation.product_id or v_next_warehouse <> v_allocation.warehouse then
      perform app_api.raise_http(400, 'Product and warehouse cannot be changed after checkout starts.');
    end if;
    if v_next_allocated_tubes < v_allocated_tubes then
      perform app_api.raise_http(400, 'allocatedTubes can only increase after checkout starts.');
    end if;
  end if;

  if v_next_product_id <> v_allocation.product_id or v_next_warehouse <> v_allocation.warehouse then
    if v_checked_out_tubes > 0 then
      perform app_api.raise_http(400, 'Product and warehouse cannot be changed after checkout starts.');
    end if;

    if v_reserved_tubes > 0 then
      perform app_api.caulk_apply_stock_delta(
        p_org_id,
        v_actor,
        v_allocation.product_id,
        v_allocation.warehouse,
        'JOB_ALLOCATE_EDIT_DEC',
        v_reserved_tubes,
        format('Edited caulk allocation %s.', v_allocation.caulk_allocation_id),
        '',
        v_allocation.caulk_allocation_id,
        'Released prior reserved tubes during edit.'
      );
    end if;

    v_local_reservation := app_api.caulk_reserve_local_tubes(
      p_org_id,
      v_actor,
      v_next_product_id,
      v_next_warehouse,
      v_next_allocated_tubes,
      'JOB_ALLOCATE_EDIT_INC',
      format('Edited caulk allocation %s.', v_allocation.caulk_allocation_id),
      v_allocation.caulk_allocation_id,
      v_next_notes
    );

    update app.caulk_job_allocations
    set
      product_id = v_next_product_id,
      warehouse = v_next_warehouse,
      allocated_tubes = v_next_allocated_tubes,
      reserved_tubes_remaining = coalesce((v_local_reservation->>'reservedTubes')::integer, 0),
      notes = v_next_notes,
      updated_at = now(),
      updated_by = v_actor
    where id = v_allocation.id
      and org_id = p_org_id;

    v_transfer_result := app_api.caulk_start_pending_transfer(
      p_org_id,
      v_actor,
      v_allocation.id,
      v_allocation.caulk_allocation_id,
      v_allocation.job_id,
      v_allocation.job_number,
      v_next_product_id,
      p_payload->>'transferFromWarehouse',
      v_next_warehouse,
      coalesce((v_local_reservation->>'shortageTubes')::integer, 0),
      v_next_notes
    );
  else
    v_currently_covered := v_reserved_tubes + v_checked_out_tubes;
    v_next_reserved_tubes := v_reserved_tubes;

    if v_next_allocated_tubes < v_checked_out_tubes then
      perform app_api.raise_http(400, 'allocatedTubes cannot drop below already checked-out amount.');
    end if;

    if v_next_allocated_tubes > v_currently_covered then
      v_additional_coverage_needed := v_next_allocated_tubes - v_currently_covered;

      v_local_reservation := app_api.caulk_reserve_local_tubes(
        p_org_id,
        v_actor,
        v_allocation.product_id,
        v_allocation.warehouse,
        v_additional_coverage_needed,
        'JOB_ALLOCATE_EDIT_INC',
        format('Increased caulk allocation %s.', v_allocation.caulk_allocation_id),
        v_allocation.caulk_allocation_id,
        v_next_notes
      );

      v_next_reserved_tubes := v_next_reserved_tubes + coalesce((v_local_reservation->>'reservedTubes')::integer, 0);
      v_transfer_result := app_api.caulk_start_pending_transfer(
        p_org_id,
        v_actor,
        v_allocation.id,
        v_allocation.caulk_allocation_id,
        v_allocation.job_id,
        v_allocation.job_number,
        v_allocation.product_id,
        p_payload->>'transferFromWarehouse',
        v_allocation.warehouse,
        coalesce((v_local_reservation->>'shortageTubes')::integer, 0),
        v_next_notes
      );
    elsif v_next_allocated_tubes < v_currently_covered then
      v_release_tubes := least(v_reserved_tubes, v_currently_covered - v_next_allocated_tubes);
      if v_release_tubes > 0 then
        perform app_api.caulk_apply_stock_delta(
          p_org_id,
          v_actor,
          v_allocation.product_id,
          v_allocation.warehouse,
          'JOB_ALLOCATE_EDIT_DEC',
          v_release_tubes,
          format('Reduced caulk allocation %s.', v_allocation.caulk_allocation_id),
          '',
          v_allocation.caulk_allocation_id,
          v_next_notes
        );
        v_next_reserved_tubes := greatest(v_reserved_tubes - v_release_tubes, 0);
      end if;
    end if;

    update app.caulk_job_allocations
    set
      allocated_tubes = v_next_allocated_tubes,
      reserved_tubes_remaining = v_next_reserved_tubes,
      notes = v_next_notes,
      updated_at = now(),
      updated_by = v_actor
    where id = v_allocation.id
      and org_id = p_org_id;
  end if;

  return jsonb_build_object(
    'jobNumber', v_allocation.job_number,
    'caulkAllocationId', v_allocation.caulk_allocation_id,
    'warnings', coalesce(v_transfer_result->'warnings', '[]'::jsonb)
  );
end;
$$;

create or replace function public.api_acl_allocations_caulk_checkout(
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
  v_allocation app.caulk_job_allocations;
  v_checkout_id text := app_api.create_log_id();
  v_actor text := app_api.trim_text(p_actor);
  v_caulk_allocation_id text := app_api.require_text(p_payload->>'caulkAllocationId', 'CaulkAllocationId');
  v_checkout_tubes integer := floor(nullif(app_api.trim_text(p_payload->>'checkoutTubes'), '')::numeric);
  v_pending_transfer_id text := '';
  v_open_checkout_count integer := 0;
  v_shortage integer := 0;
  v_consume_reserved integer;
  v_overage integer;
  v_notes text := app_api.trim_text(p_payload->>'notes');
begin
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'write');

  if v_checkout_tubes is null or v_checkout_tubes <= 0 then
    perform app_api.raise_http(400, 'checkoutTubes must be greater than zero.');
  end if;

  select *
  into v_allocation
  from app.caulk_job_allocations a
  where a.org_id = p_org_id
    and a.caulk_allocation_id = v_caulk_allocation_id
  for update;

  if not found then
    perform app_api.raise_http(404, format('Caulk allocation %s was not found.', v_caulk_allocation_id));
  end if;

  if v_allocation.status <> 'ACTIVE' then
    perform app_api.raise_http(400, format('Caulk allocation %s is not active.', v_caulk_allocation_id));
  end if;

  perform app_api.require_active_job_for_caulk(p_org_id, v_allocation.job_number);

  select t.transfer_id
  into v_pending_transfer_id
  from app.caulk_transfers t
  where t.org_id = p_org_id
    and t.caulk_allocation_id = v_allocation.id
    and t.status = 'PENDING'
  order by t.created_at desc, t.id desc
  limit 1
  for update;

  if coalesce(v_pending_transfer_id, '') <> '' then
    perform app_api.raise_http(
      400,
      format('Receive or cancel transfer %s before checking out this allocation.', v_pending_transfer_id)
    );
  end if;

  v_shortage := greatest(
    v_allocation.allocated_tubes
      - v_allocation.checked_out_tubes_total
      - v_allocation.reserved_tubes_remaining,
    0
  );
  if v_shortage > 0 then
    perform app_api.raise_http(
      400,
      format(
        '%s still needs %s tube%s transferred in before this allocation can be checked out.',
        v_allocation.warehouse,
        v_shortage,
        case when v_shortage = 1 then '' else 's' end
      )
    );
  end if;

  select count(*)
  into v_open_checkout_count
  from app.caulk_job_checkouts c
  where c.org_id = p_org_id
    and c.caulk_allocation_id = v_allocation.id
    and c.status = 'OPEN';

  if v_open_checkout_count > 0 then
    perform app_api.raise_http(
      400,
      format(
        'Caulk allocation %s already has %s open checkout%s and cannot be checked out again until that cycle is closed.',
        v_caulk_allocation_id,
        v_open_checkout_count,
        case when v_open_checkout_count = 1 then '' else 's' end
      )
    );
  end if;

  v_consume_reserved := least(v_checkout_tubes, v_allocation.reserved_tubes_remaining);
  v_overage := greatest(v_checkout_tubes - v_consume_reserved, 0);

  if v_overage > 0 then
    perform app_api.caulk_apply_stock_delta(
      p_org_id,
      v_actor,
      v_allocation.product_id,
      v_allocation.warehouse,
      'JOB_CHECKOUT_OVERAGE',
      -v_overage,
      format('Over-checkout on caulk allocation %s.', v_allocation.caulk_allocation_id),
      '',
      v_allocation.caulk_allocation_id,
      v_notes
    );
  end if;

  insert into app.caulk_job_checkouts (
    id,
    org_id,
    caulk_checkout_id,
    caulk_allocation_id,
    job_number,
    product_id,
    warehouse,
    checkout_tubes,
    overage_tubes,
    status,
    checked_out_at,
    checked_out_by,
    notes
  )
  values (
    gen_random_uuid(),
    p_org_id,
    v_checkout_id,
    v_allocation.id,
    v_allocation.job_number,
    v_allocation.product_id,
    v_allocation.warehouse,
    v_checkout_tubes,
    v_overage,
    'OPEN',
    now(),
    v_actor,
    v_notes
  );

  update app.caulk_job_allocations
  set
    reserved_tubes_remaining = greatest(v_allocation.reserved_tubes_remaining - v_consume_reserved, 0),
    checked_out_tubes_total = v_allocation.checked_out_tubes_total + v_checkout_tubes,
    overage_tubes_total = v_allocation.overage_tubes_total + v_overage,
    updated_at = now(),
    updated_by = v_actor
  where id = v_allocation.id
    and org_id = p_org_id;

  return jsonb_build_object(
    'jobNumber', v_allocation.job_number,
    'caulkAllocationId', v_allocation.caulk_allocation_id,
    'caulkCheckoutId', v_checkout_id,
    'warnings', '[]'::jsonb
  );
end;
$$;

create or replace function public.api_acl_allocations_caulk_remove(
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
  v_allocation app.caulk_job_allocations;
  v_open_checkout_count integer := 0;
  v_actor text := app_api.trim_text(p_actor);
  v_caulk_allocation_id text := app_api.require_text(p_payload->>'caulkAllocationId', 'CaulkAllocationId');
  v_reason text;
  v_released_reserved_tubes integer := 0;
  v_pending_transfer_id text := '';
  v_cancel_result jsonb := '{}'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'write');

  select *
  into v_allocation
  from app.caulk_job_allocations a
  where a.org_id = p_org_id
    and a.caulk_allocation_id = v_caulk_allocation_id
  for update;

  if not found then
    perform app_api.raise_http(404, format('Caulk allocation %s was not found.', v_caulk_allocation_id));
  end if;

  if v_allocation.status <> 'ACTIVE' then
    perform app_api.raise_http(400, format('Caulk allocation %s is not active.', v_caulk_allocation_id));
  end if;

  select count(*)
  into v_open_checkout_count
  from app.caulk_job_checkouts c
  where c.org_id = p_org_id
    and c.caulk_allocation_id = v_allocation.id
    and c.status = 'OPEN';

  if v_open_checkout_count > 0 then
    perform app_api.raise_http(
      400,
      format(
        'Caulk allocation %s has %s open checkout%s. Check in first.',
        v_caulk_allocation_id,
        v_open_checkout_count,
        case when v_open_checkout_count = 1 then '' else 's' end
      )
    );
  end if;

  v_reason := coalesce(
    nullif(app_api.trim_text(p_payload->>'reason'), ''),
    format('Removed from job %s.', v_allocation.job_number)
  );

  select t.transfer_id
  into v_pending_transfer_id
  from app.caulk_transfers t
  where t.org_id = p_org_id
    and t.caulk_allocation_id = v_allocation.id
    and t.status = 'PENDING'
  order by t.created_at desc, t.id desc
  limit 1
  for update;

  if coalesce(v_pending_transfer_id, '') <> '' then
    v_cancel_result := app_api.caulk_cancel_pending_transfer_internal(
      p_org_id,
      v_actor,
      v_pending_transfer_id,
      format(
        'Cancelled pending transfer %s while removing allocation %s.',
        v_pending_transfer_id,
        v_caulk_allocation_id
      )
    );
    v_warnings := v_warnings || coalesce(v_cancel_result->'warnings', '[]'::jsonb);
  end if;

  if v_allocation.reserved_tubes_remaining > 0 then
    perform app_api.caulk_apply_stock_delta(
      p_org_id,
      v_actor,
      v_allocation.product_id,
      v_allocation.warehouse,
      'JOB_ALLOCATION_CANCEL_RETURN',
      v_allocation.reserved_tubes_remaining,
      v_reason,
      '',
      v_allocation.caulk_allocation_id,
      v_reason
    );
    v_released_reserved_tubes := v_allocation.reserved_tubes_remaining;
  end if;

  update app.caulk_job_allocations
  set
    status = 'CANCELLED',
    reserved_tubes_remaining = 0,
    resolved_at = now(),
    resolved_by = v_actor,
    notes = v_reason,
    updated_at = now(),
    updated_by = v_actor
  where id = v_allocation.id
    and org_id = p_org_id;

  return jsonb_build_object(
    'jobNumber', v_allocation.job_number,
    'caulkAllocationId', v_allocation.caulk_allocation_id,
    'releasedReservedTubes', v_released_reserved_tubes,
    'warnings', v_warnings
  );
end;
$$;

create or replace function public.api_acl_caulk_transfer_receive(
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
  v_result jsonb;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');
  v_result := app_api.caulk_receive_pending_transfer_internal(
    p_org_id,
    p_actor,
    p_payload->>'transferId'
  );
  return v_result;
end;
$$;

create or replace function public.api_acl_caulk_transfer_cancel(
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
  v_result jsonb;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');
  v_result := app_api.caulk_cancel_pending_transfer_internal(
    p_org_id,
    p_actor,
    p_payload->>'transferId',
    p_payload->>'reason'
  );
  return v_result;
end;
$$;

select app_api.grant_execute_if_exists('public.api_acl_list_caulk_job_allocations_by_job(uuid, text)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_caulk_transfers(uuid, text, uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_caulk_upsert_product(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_add(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_update(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_checkout(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_remove(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_caulk_transfer_receive(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_caulk_transfer_cancel(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_caulk_job_allocations_by_job(uuid, text)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_list_caulk_transfers(uuid, text, uuid)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_caulk_upsert_product(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_add(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_update(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_checkout(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_remove(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_caulk_transfer_receive(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_caulk_transfer_cancel(uuid, text, jsonb)', 'service_role');
