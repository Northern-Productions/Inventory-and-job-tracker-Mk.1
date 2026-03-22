-- Adds caulk job requirements, job allocations, and checkout/checkin workflow.

do $$
begin
  create type app.caulk_job_allocation_status as enum ('ACTIVE', 'CANCELLED');
exception
  when duplicate_object then
    null;
end;
$$;

do $$
begin
  create type app.caulk_job_checkout_status as enum ('OPEN', 'CLOSED');
exception
  when duplicate_object then
    null;
end;
$$;

create table if not exists app.job_caulk_requirements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations(id) on delete cascade,
  job_id uuid not null references app.jobs(id) on delete cascade,
  product_id uuid not null,
  required_tubes integer not null,
  notes text not null default '',
  created_at timestamptz not null default now(),
  created_by text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text not null default '',
  unique (org_id, job_id, product_id),
  foreign key (org_id, product_id) references app.caulk_products(org_id, id) on delete restrict
);

alter table app.job_caulk_requirements
  drop constraint if exists job_caulk_requirements_required_tubes_positive;
alter table app.job_caulk_requirements
  add constraint job_caulk_requirements_required_tubes_positive
  check (required_tubes > 0);

create index if not exists idx_job_caulk_requirements_org_job
  on app.job_caulk_requirements (org_id, job_id);

create table if not exists app.caulk_job_allocations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations(id) on delete cascade,
  caulk_allocation_id text not null,
  job_id uuid references app.jobs(id) on delete set null,
  job_number text not null,
  requirement_id uuid references app.job_caulk_requirements(id) on delete set null,
  product_id uuid not null,
  warehouse text not null,
  allocated_tubes integer not null,
  reserved_tubes_remaining integer not null,
  checked_out_tubes_total integer not null default 0,
  returned_unused_tubes_total integer not null default 0,
  used_tubes_total integer not null default 0,
  overage_tubes_total integer not null default 0,
  status app.caulk_job_allocation_status not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  created_by text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text not null default '',
  resolved_at timestamptz,
  resolved_by text not null default '',
  notes text not null default '',
  unique (org_id, caulk_allocation_id),
  foreign key (org_id, product_id) references app.caulk_products(org_id, id) on delete restrict,
  foreign key (org_id, warehouse) references app.warehouses(org_id, code) on delete restrict
);

alter table app.caulk_job_allocations
  drop constraint if exists caulk_job_allocations_allocated_tubes_positive;
alter table app.caulk_job_allocations
  add constraint caulk_job_allocations_allocated_tubes_positive
  check (allocated_tubes > 0);

alter table app.caulk_job_allocations
  drop constraint if exists caulk_job_allocations_reserved_non_negative;
alter table app.caulk_job_allocations
  add constraint caulk_job_allocations_reserved_non_negative
  check (reserved_tubes_remaining >= 0 and reserved_tubes_remaining <= allocated_tubes);

alter table app.caulk_job_allocations
  drop constraint if exists caulk_job_allocations_totals_non_negative;
alter table app.caulk_job_allocations
  add constraint caulk_job_allocations_totals_non_negative
  check (
    checked_out_tubes_total >= 0
    and returned_unused_tubes_total >= 0
    and used_tubes_total >= 0
    and overage_tubes_total >= 0
    and checked_out_tubes_total >= returned_unused_tubes_total + used_tubes_total
  );

create index if not exists idx_caulk_job_allocations_org_job
  on app.caulk_job_allocations (org_id, upper(job_number));

create index if not exists idx_caulk_job_allocations_org_status
  on app.caulk_job_allocations (org_id, status, updated_at desc);

create table if not exists app.caulk_job_checkouts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations(id) on delete cascade,
  caulk_checkout_id text not null,
  caulk_allocation_id uuid not null references app.caulk_job_allocations(id) on delete cascade,
  job_number text not null,
  product_id uuid not null,
  warehouse text not null,
  checkout_tubes integer not null,
  overage_tubes integer not null default 0,
  status app.caulk_job_checkout_status not null default 'OPEN',
  checked_out_at timestamptz not null default now(),
  checked_out_by text not null default '',
  checked_in_at timestamptz,
  checked_in_by text not null default '',
  unused_tubes integer not null default 0,
  used_tubes integer not null default 0,
  notes text not null default '',
  unique (org_id, caulk_checkout_id),
  foreign key (org_id, product_id) references app.caulk_products(org_id, id) on delete restrict,
  foreign key (org_id, warehouse) references app.warehouses(org_id, code) on delete restrict
);

alter table app.caulk_job_checkouts
  drop constraint if exists caulk_job_checkouts_checkout_positive;
alter table app.caulk_job_checkouts
  add constraint caulk_job_checkouts_checkout_positive
  check (checkout_tubes > 0 and overage_tubes >= 0);

alter table app.caulk_job_checkouts
  drop constraint if exists caulk_job_checkouts_totals_valid;
alter table app.caulk_job_checkouts
  add constraint caulk_job_checkouts_totals_valid
  check (
    unused_tubes >= 0
    and used_tubes >= 0
    and checkout_tubes >= unused_tubes + used_tubes
    and (
      (status = 'OPEN' and checked_in_at is null and unused_tubes = 0 and used_tubes = 0)
      or (status = 'CLOSED' and checked_in_at is not null and checkout_tubes = unused_tubes + used_tubes)
    )
  );

create index if not exists idx_caulk_job_checkouts_org_job
  on app.caulk_job_checkouts (org_id, upper(job_number), checked_out_at desc);

create index if not exists idx_caulk_job_checkouts_org_allocation
  on app.caulk_job_checkouts (org_id, caulk_allocation_id, status, checked_out_at desc);

alter table app.caulk_transactions
  drop constraint if exists caulk_transactions_action_valid;
alter table app.caulk_transactions
  add constraint caulk_transactions_action_valid
  check (
    action in (
      'RECEIVE',
      'USE',
      'ADJUST',
      'TRANSFER_OUT',
      'TRANSFER_IN',
      'BACKFILL_MIGRATE',
      'JOB_ALLOCATE',
      'JOB_ALLOCATE_EDIT_INC',
      'JOB_ALLOCATE_EDIT_DEC',
      'JOB_CHECKOUT_OVERAGE',
      'JOB_CHECKIN_UNUSED',
      'JOB_ALLOCATION_CANCEL_RETURN'
    )
  );

create or replace function app_api.caulk_apply_stock_delta(
  p_org_id uuid,
  p_actor text,
  p_product_id uuid,
  p_warehouse text,
  p_action text,
  p_delta_tubes integer,
  p_reason text,
  p_transfer_id text default '',
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
  v_action text := upper(app_api.trim_text(p_action));
  v_reason text := app_api.trim_text(p_reason);
  v_warehouse text := app_api.caulk_require_warehouse(p_org_id, p_warehouse);
  v_product app.caulk_products;
  v_manufacturer app.caulk_manufacturers;
  v_stock app.caulk_stock;
  v_before integer := 0;
  v_after integer := 0;
  v_transaction_id text := app_api.caulk_create_transaction_id();
begin
  if p_delta_tubes is null or p_delta_tubes = 0 then
    perform app_api.raise_http(400, 'DeltaTubes must be a non-zero integer.');
  end if;

  if v_action not in (
    'RECEIVE',
    'USE',
    'ADJUST',
    'TRANSFER_OUT',
    'TRANSFER_IN',
    'BACKFILL_MIGRATE',
    'JOB_ALLOCATE',
    'JOB_ALLOCATE_EDIT_INC',
    'JOB_ALLOCATE_EDIT_DEC',
    'JOB_CHECKOUT_OVERAGE',
    'JOB_CHECKIN_UNUSED',
    'JOB_ALLOCATION_CANCEL_RETURN'
  ) then
    perform app_api.raise_http(400, 'Unsupported caulk stock action.');
  end if;

  select *
  into v_product
  from app.caulk_products p
  where p.org_id = p_org_id
    and p.id = p_product_id
  limit 1;

  if not found then
    perform app_api.raise_http(400, 'Product was not found for this organization.');
  end if;

  select *
  into v_manufacturer
  from app.caulk_manufacturers m
  where m.org_id = p_org_id
    and m.id = v_product.manufacturer_id
  limit 1;

  if not found then
    perform app_api.raise_http(400, 'Manufacturer for product was not found.');
  end if;

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

  select *
  into v_stock
  from app.caulk_stock s
  where s.org_id = p_org_id
    and s.product_id = p_product_id
    and s.warehouse = v_warehouse
  for update;

  v_before := coalesce(v_stock.tubes_on_hand, 0);
  v_after := v_before + p_delta_tubes;

  if v_after < 0 then
    perform app_api.raise_http(400, format('Insufficient stock. Requested delta would move tubes below zero (%s).', v_after));
  end if;

  update app.caulk_stock s
  set
    tubes_on_hand = v_after,
    updated_at = now(),
    updated_by = v_actor
  where s.org_id = p_org_id
    and s.product_id = p_product_id
    and s.warehouse = v_warehouse;

  insert into app.caulk_transactions (
    org_id,
    transaction_id,
    product_id,
    warehouse,
    action,
    delta_tubes,
    resulting_tubes_on_hand,
    tubes_per_case,
    reason,
    notes,
    transfer_id,
    source_box_id,
    created_by
  )
  values (
    p_org_id,
    v_transaction_id,
    p_product_id,
    v_warehouse,
    v_action,
    p_delta_tubes,
    v_after,
    v_product.tubes_per_case,
    v_reason,
    app_api.trim_text(p_notes),
    app_api.trim_text(p_transfer_id),
    app_api.trim_text(p_source_box_id),
    v_actor
  );

  return jsonb_build_object(
    'transactionId', v_transaction_id,
    'productId', v_product.id,
    'manufacturer', v_manufacturer.name,
    'productName', v_product.name,
    'productCode', v_product.code,
    'warehouse', v_warehouse,
    'action', v_action,
    'deltaTubes', p_delta_tubes,
    'tubesPerCase', v_product.tubes_per_case,
    'tubesBefore', v_before,
    'tubesOnHand', v_after,
    'casesOnHand', floor(v_after::numeric / v_product.tubes_per_case::numeric)::integer,
    'looseTubes', mod(v_after, v_product.tubes_per_case)
  );
end;
$$;

create or replace function app_api.caulk_requirement_rows_from_payload(p_requirements jsonb)
returns table (
  product_id uuid,
  required_tubes integer
)
language plpgsql
stable
as $$
declare
  v_value jsonb;
  v_product_id uuid;
  v_required_tubes integer;
begin
  if p_requirements is not null and jsonb_typeof(p_requirements) = 'array' then
    for v_value in
      select value
      from jsonb_array_elements(p_requirements)
    loop
      v_product_id := nullif(app_api.trim_text(v_value->>'productId'), '')::uuid;
      v_required_tubes := floor(nullif(app_api.trim_text(v_value->>'requiredTubes'), '')::numeric);

      if v_product_id is null then
        perform app_api.raise_http(400, 'caulkRequirements[].productId is required.');
      end if;

      if v_required_tubes is null or v_required_tubes <= 0 then
        perform app_api.raise_http(400, 'caulkRequirements[].requiredTubes must be greater than zero.');
      end if;
    end loop;
  end if;

  return query
  with normalized as (
    select
      (nullif(app_api.trim_text(value->>'productId'), '')::uuid) as product_id,
      floor(nullif(app_api.trim_text(value->>'requiredTubes'), '')::numeric)::integer as required_tubes
    from jsonb_array_elements(
      case
        when p_requirements is null or jsonb_typeof(p_requirements) <> 'array' then '[]'::jsonb
        else p_requirements
      end
    )
  )
  select
    n.product_id,
    sum(n.required_tubes)::integer as required_tubes
  from normalized n
  group by n.product_id;
end;
$$;

create or replace function app_api.replace_job_caulk_requirements(
  p_org_id uuid,
  p_job app.jobs,
  p_requirements jsonb,
  p_actor text,
  p_now timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_requirement record;
begin
  delete from app.job_caulk_requirements
  where org_id = p_org_id
    and job_id = p_job.id;

  for v_requirement in
    select *
    from app_api.caulk_requirement_rows_from_payload(p_requirements)
  loop
    insert into app.job_caulk_requirements (
      id,
      org_id,
      job_id,
      product_id,
      required_tubes,
      notes,
      created_at,
      created_by,
      updated_at,
      updated_by
    )
    values (
      gen_random_uuid(),
      p_org_id,
      p_job.id,
      v_requirement.product_id,
      v_requirement.required_tubes,
      '',
      p_now,
      app_api.trim_text(p_actor),
      p_now,
      app_api.trim_text(p_actor)
    );
  end loop;
end;
$$;

create or replace function public.api_jobs_create(
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
  v_now timestamptz := now();
begin
  perform app_api.require_org_member(p_org_id);

  select *
  into v_job
  from app.jobs j
  where j.org_id = p_org_id
    and j.job_number = app_api.require_job_number_digits(p_payload->>'jobNumber', 'Job ID number')
  for update;

  if not found then
    v_job.id := gen_random_uuid();
    v_job.created_at := v_now;
    v_job.created_by := app_api.trim_text(p_actor);
  end if;

  v_job.org_id := p_org_id;
  v_job.job_number := app_api.require_job_number_digits(p_payload->>'jobNumber', 'Job ID number');
  v_job.warehouse := app_api.require_org_warehouse(p_org_id, p_payload->>'warehouse', 'Warehouse');
  v_job.sections := app_api.normalize_job_sections(p_payload->>'sections');
  v_job.due_date := nullif(app_api.trim_text(p_payload->>'dueDate'), '')::date;
  v_job.crew_leader := app_api.trim_text(p_payload->>'crewLeader');
  v_job.lifecycle_status := app_api.normalize_job_lifecycle_status(p_payload->>'lifecycleStatus');
  v_job.notes := app_api.trim_text(p_payload->>'notes');
  v_job.updated_at := v_now;
  v_job.updated_by := app_api.trim_text(p_actor);

  v_job := app_api.save_job(v_job);
  perform app_api.replace_job_requirements(p_org_id, v_job, p_payload->'requirements', p_actor, v_now);
  perform app_api.replace_job_caulk_requirements(p_org_id, v_job, p_payload->'caulkRequirements', p_actor, v_now);

  return jsonb_build_object(
    'jobNumber', v_job.job_number,
    'warnings', '[]'::jsonb
  );
end;
$$;

create or replace function public.api_jobs_update(
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
  v_now timestamptz := now();
begin
  perform app_api.require_org_member(p_org_id);

  select *
  into v_job
  from app.jobs j
  where j.org_id = p_org_id
    and j.job_number = app_api.require_job_number_digits(p_payload->>'jobNumber', 'Job ID number')
  for update;

  if not found then
    v_job.id := gen_random_uuid();
    v_job.org_id := p_org_id;
    v_job.job_number := app_api.require_job_number_digits(p_payload->>'jobNumber', 'Job ID number');
    v_job.warehouse := coalesce(
      case
        when app_api.trim_text(p_payload->>'warehouse') <> ''
          then app_api.require_org_warehouse(p_org_id, p_payload->>'warehouse', 'Warehouse')
        else null
      end,
      (
        select w.code
        from app.warehouses w
        where w.org_id = p_org_id
          and w.box_id_prefix = ''
        order by case when w.code = 'IL' then 0 else 1 end, w.code
        limit 1
      ),
      (
        select w.code
        from app.warehouses w
        where w.org_id = p_org_id
        order by w.code
        limit 1
      )
    );
    if v_job.warehouse is null then
      perform app_api.raise_http(400, 'No warehouse is configured for this organization.');
    end if;
    v_job.sections := null;
    v_job.due_date := null;
    v_job.crew_leader := '';
    v_job.lifecycle_status := 'ACTIVE';
    v_job.notes := '';
    v_job.created_at := v_now;
    v_job.created_by := app_api.trim_text(p_actor);
  end if;

  if p_payload ? 'warehouse' then
    v_job.warehouse := app_api.require_org_warehouse(p_org_id, p_payload->>'warehouse', 'Warehouse');
  end if;
  if p_payload ? 'sections' then
    v_job.sections := app_api.normalize_job_sections(p_payload->>'sections');
  end if;
  if p_payload ? 'dueDate' then
    v_job.due_date := nullif(app_api.trim_text(p_payload->>'dueDate'), '')::date;
  end if;
  if p_payload ? 'crewLeader' then
    v_job.crew_leader := app_api.trim_text(p_payload->>'crewLeader');
  end if;
  if p_payload ? 'lifecycleStatus' then
    v_job.lifecycle_status := app_api.normalize_job_lifecycle_status(p_payload->>'lifecycleStatus');
  end if;
  if p_payload ? 'notes' then
    v_job.notes := app_api.trim_text(p_payload->>'notes');
  end if;

  v_job.updated_at := v_now;
  v_job.updated_by := app_api.trim_text(p_actor);
  v_job := app_api.save_job(v_job);
  perform app_api.replace_job_requirements(p_org_id, v_job, p_payload->'requirements', p_actor, v_now);
  perform app_api.replace_job_caulk_requirements(p_org_id, v_job, p_payload->'caulkRequirements', p_actor, v_now);

  return jsonb_build_object(
    'jobNumber', v_job.job_number,
    'warnings', '[]'::jsonb
  );
end;
$$;

create or replace function app_api.require_active_job_for_caulk(
  p_org_id uuid,
  p_job_number text
)
returns app.jobs
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_job app.jobs;
begin
  select *
  into v_job
  from app.jobs j
  where j.org_id = p_org_id
    and j.job_number = app_api.require_job_number_digits(p_job_number, 'Job ID number')
  for update;

  if not found then
    perform app_api.raise_http(404, format('Job %s was not found.', app_api.trim_text(p_job_number)));
  end if;

  if app_api.normalize_job_lifecycle_status(v_job.lifecycle_status::text) <> 'ACTIVE'::app.job_lifecycle_status then
    perform app_api.raise_http(400, format('Job %s is closed and cannot receive caulk allocations.', v_job.job_number));
  end if;

  return v_job;
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

create or replace function public.api_acl_jobs_cancel_caulk_allocations(
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
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'write');

  return app_api.cancel_active_caulk_allocations_for_job(
    p_org_id,
    p_actor,
    p_payload->>'jobNumber',
    coalesce(nullif(app_api.trim_text(p_payload->>'reason'), ''), 'Job completed.'),
    true
  );
end;
$$;

create or replace function public.api_acl_list_job_caulk_requirements_by_job(
  p_org_id uuid,
  p_job_number text
)
returns table (
  requirement_id uuid,
  job_number text,
  product_id uuid,
  manufacturer_id uuid,
  manufacturer text,
  product_name text,
  product_code text,
  tubes_per_case integer,
  required_tubes integer,
  notes text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_org_member(p_org_id);

  return query
  select
    r.id,
    j.job_number,
    r.product_id,
    p.manufacturer_id,
    m.name,
    p.name,
    p.code,
    p.tubes_per_case,
    r.required_tubes,
    r.notes,
    r.updated_at
  from app.job_caulk_requirements r
  join app.jobs j
    on j.id = r.job_id
   and j.org_id = r.org_id
  join app.caulk_products p
    on p.id = r.product_id
   and p.org_id = r.org_id
  join app.caulk_manufacturers m
    on m.id = p.manufacturer_id
   and m.org_id = p.org_id
  where r.org_id = p_org_id
    and upper(j.job_number) = upper(app_api.require_job_number_digits(p_job_number, 'Job ID number'))
  order by lower(m.name), lower(p.name), lower(p.code);
end;
$$;

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
  notes text
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
    a.notes
  from app.caulk_job_allocations a
  join app.caulk_products p
    on p.id = a.product_id
   and p.org_id = a.org_id
  join app.caulk_manufacturers m
    on m.id = p.manufacturer_id
   and m.org_id = p.org_id
  left join open_counts o
    on o.caulk_allocation_id = a.id
  where a.org_id = p_org_id
    and upper(a.job_number) = upper(app_api.require_job_number_digits(p_job_number, 'Job ID number'))
  order by a.created_at desc, a.caulk_allocation_id desc;
end;
$$;

create or replace function public.api_acl_list_caulk_job_checkouts_by_job(
  p_org_id uuid,
  p_job_number text
)
returns table (
  caulk_checkout_id text,
  caulk_allocation_id text,
  product_id uuid,
  manufacturer_id uuid,
  manufacturer text,
  product_name text,
  product_code text,
  tubes_per_case integer,
  warehouse text,
  checkout_tubes integer,
  overage_tubes integer,
  status text,
  checked_out_at timestamptz,
  checked_out_by text,
  checked_in_at timestamptz,
  checked_in_by text,
  unused_tubes integer,
  used_tubes integer,
  notes text
)
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_org_member(p_org_id);

  return query
  select
    c.caulk_checkout_id,
    a.caulk_allocation_id,
    c.product_id,
    p.manufacturer_id,
    m.name,
    p.name,
    p.code,
    p.tubes_per_case,
    c.warehouse,
    c.checkout_tubes,
    c.overage_tubes,
    c.status::text,
    c.checked_out_at,
    c.checked_out_by,
    c.checked_in_at,
    c.checked_in_by,
    c.unused_tubes,
    c.used_tubes,
    c.notes
  from app.caulk_job_checkouts c
  join app.caulk_job_allocations a
    on a.id = c.caulk_allocation_id
   and a.org_id = c.org_id
  join app.caulk_products p
    on p.id = c.product_id
   and p.org_id = c.org_id
  join app.caulk_manufacturers m
    on m.id = p.manufacturer_id
   and m.org_id = p.org_id
  where c.org_id = p_org_id
    and upper(c.job_number) = upper(app_api.require_job_number_digits(p_job_number, 'Job ID number'))
  order by c.checked_out_at desc, c.caulk_checkout_id desc;
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
  v_allocation app.caulk_job_allocations;
  v_allocation_id text := app_api.create_log_id();
  v_job_number text := app_api.require_job_number_digits(p_payload->>'jobNumber', 'Job ID number');
  v_requirement_id uuid := nullif(app_api.trim_text(p_payload->>'requirementId'), '')::uuid;
  v_product_id uuid := nullif(app_api.trim_text(p_payload->>'productId'), '')::uuid;
  v_warehouse text := app_api.caulk_require_warehouse(p_org_id, p_payload->>'warehouse');
  v_allocated_tubes integer := floor(nullif(app_api.trim_text(p_payload->>'allocatedTubes'), '')::numeric);
  v_actor text := app_api.trim_text(p_actor);
  v_notes text := app_api.trim_text(p_payload->>'notes');
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

  perform app_api.caulk_apply_stock_delta(
    p_org_id,
    v_actor,
    v_product.id,
    v_warehouse,
    'JOB_ALLOCATE',
    -v_allocated_tubes,
    format('Allocated caulk to job %s.', v_job.job_number),
    '',
    v_allocation_id,
    v_notes
  );

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
    gen_random_uuid(),
    p_org_id,
    v_allocation_id,
    v_job.id,
    v_job.job_number,
    v_requirement_id,
    v_product.id,
    v_warehouse,
    v_allocated_tubes,
    v_allocated_tubes,
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
  )
  returning * into v_allocation;

  return jsonb_build_object(
    'jobNumber', v_allocation.job_number,
    'caulkAllocationId', v_allocation.caulk_allocation_id,
    'warnings', '[]'::jsonb
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
  v_actor text := app_api.trim_text(p_actor);
  v_caulk_allocation_id text := app_api.require_text(p_payload->>'caulkAllocationId', 'CaulkAllocationId');
  v_next_product_id uuid;
  v_next_warehouse text;
  v_next_allocated_tubes integer;
  v_delta integer;
  v_notes text;
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

  v_next_product_id := coalesce(nullif(app_api.trim_text(p_payload->>'productId'), '')::uuid, v_allocation.product_id);
  v_next_warehouse := case
    when p_payload ? 'warehouse' then app_api.caulk_require_warehouse(p_org_id, p_payload->>'warehouse')
    else v_allocation.warehouse
  end;
  v_next_allocated_tubes := case
    when p_payload ? 'allocatedTubes' then floor(nullif(app_api.trim_text(p_payload->>'allocatedTubes'), '')::numeric)
    else v_allocation.allocated_tubes
  end;
  v_notes := case
    when p_payload ? 'notes' then app_api.trim_text(p_payload->>'notes')
    else v_allocation.notes
  end;

  if v_next_allocated_tubes is null or v_next_allocated_tubes <= 0 then
    perform app_api.raise_http(400, 'allocatedTubes must be greater than zero.');
  end if;

  if v_allocation.checked_out_tubes_total > 0 then
    if v_next_product_id <> v_allocation.product_id or v_next_warehouse <> v_allocation.warehouse then
      perform app_api.raise_http(400, 'Product and warehouse cannot be changed after checkout starts.');
    end if;
    if v_next_allocated_tubes < v_allocation.allocated_tubes then
      perform app_api.raise_http(400, 'allocatedTubes can only increase after checkout starts.');
    end if;
  end if;

  if v_next_product_id <> v_allocation.product_id or v_next_warehouse <> v_allocation.warehouse then
    if v_allocation.checked_out_tubes_total > 0 then
      perform app_api.raise_http(400, 'Product and warehouse cannot be changed after checkout starts.');
    end if;

    if v_allocation.reserved_tubes_remaining > 0 then
      perform app_api.caulk_apply_stock_delta(
        p_org_id,
        v_actor,
        v_allocation.product_id,
        v_allocation.warehouse,
        'JOB_ALLOCATE_EDIT_DEC',
        v_allocation.reserved_tubes_remaining,
        format('Edited caulk allocation %s.', v_allocation.caulk_allocation_id),
        '',
        v_allocation.caulk_allocation_id,
        'Released prior reserved tubes during edit.'
      );
    end if;

    perform app_api.caulk_apply_stock_delta(
      p_org_id,
      v_actor,
      v_next_product_id,
      v_next_warehouse,
      'JOB_ALLOCATE_EDIT_INC',
      -v_next_allocated_tubes,
      format('Edited caulk allocation %s.', v_allocation.caulk_allocation_id),
      '',
      v_allocation.caulk_allocation_id,
      'Reserved tubes for updated product/warehouse.'
    );

    update app.caulk_job_allocations
    set
      product_id = v_next_product_id,
      warehouse = v_next_warehouse,
      allocated_tubes = v_next_allocated_tubes,
      reserved_tubes_remaining = v_next_allocated_tubes,
      notes = v_notes,
      updated_at = now(),
      updated_by = v_actor
    where id = v_allocation.id
      and org_id = p_org_id;
  else
    v_delta := v_next_allocated_tubes - v_allocation.allocated_tubes;

    if v_delta > 0 then
      perform app_api.caulk_apply_stock_delta(
        p_org_id,
        v_actor,
        v_allocation.product_id,
        v_allocation.warehouse,
        'JOB_ALLOCATE_EDIT_INC',
        -v_delta,
        format('Increased caulk allocation %s.', v_allocation.caulk_allocation_id),
        '',
        v_allocation.caulk_allocation_id,
        v_notes
      );
    elsif v_delta < 0 then
      if abs(v_delta) > v_allocation.reserved_tubes_remaining then
        perform app_api.raise_http(400, 'allocatedTubes cannot drop below already checked-out amount.');
      end if;
      perform app_api.caulk_apply_stock_delta(
        p_org_id,
        v_actor,
        v_allocation.product_id,
        v_allocation.warehouse,
        'JOB_ALLOCATE_EDIT_DEC',
        abs(v_delta),
        format('Reduced caulk allocation %s.', v_allocation.caulk_allocation_id),
        '',
        v_allocation.caulk_allocation_id,
        v_notes
      );
    end if;

    update app.caulk_job_allocations
    set
      allocated_tubes = v_next_allocated_tubes,
      reserved_tubes_remaining = greatest(v_allocation.reserved_tubes_remaining + v_delta, 0),
      notes = v_notes,
      updated_at = now(),
      updated_by = v_actor
    where id = v_allocation.id
      and org_id = p_org_id;
  end if;

  return jsonb_build_object(
    'jobNumber', v_allocation.job_number,
    'caulkAllocationId', v_allocation.caulk_allocation_id,
    'warnings', '[]'::jsonb
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

create or replace function public.api_acl_allocations_caulk_checkin(
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
  v_checkout app.caulk_job_checkouts;
  v_allocation app.caulk_job_allocations;
  v_actor text := app_api.trim_text(p_actor);
  v_caulk_checkout_id text := app_api.require_text(p_payload->>'caulkCheckoutId', 'CaulkCheckoutId');
  v_unused_tubes integer := floor(nullif(app_api.trim_text(p_payload->>'unusedTubes'), '')::numeric);
  v_used_tubes integer;
  v_notes text := app_api.trim_text(p_payload->>'notes');
begin
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'write');

  if v_unused_tubes is null or v_unused_tubes < 0 then
    perform app_api.raise_http(400, 'unusedTubes must be zero or greater.');
  end if;

  select *
  into v_checkout
  from app.caulk_job_checkouts c
  where c.org_id = p_org_id
    and c.caulk_checkout_id = v_caulk_checkout_id
  for update;

  if not found then
    perform app_api.raise_http(404, format('Caulk checkout %s was not found.', v_caulk_checkout_id));
  end if;

  if v_checkout.status <> 'OPEN' then
    perform app_api.raise_http(400, format('Caulk checkout %s is already closed.', v_caulk_checkout_id));
  end if;

  if v_unused_tubes > v_checkout.checkout_tubes then
    perform app_api.raise_http(400, 'unusedTubes cannot exceed checkoutTubes.');
  end if;

  select *
  into v_allocation
  from app.caulk_job_allocations a
  where a.org_id = p_org_id
    and a.id = v_checkout.caulk_allocation_id
  for update;

  if not found then
    perform app_api.raise_http(404, 'Parent caulk allocation was not found.');
  end if;

  if v_allocation.status <> 'ACTIVE' then
    perform app_api.raise_http(400, 'Parent caulk allocation is no longer active.');
  end if;

  v_used_tubes := v_checkout.checkout_tubes - v_unused_tubes;

  if v_unused_tubes > 0 then
    perform app_api.caulk_apply_stock_delta(
      p_org_id,
      v_actor,
      v_allocation.product_id,
      v_allocation.warehouse,
      'JOB_CHECKIN_UNUSED',
      v_unused_tubes,
      format('Checked in unused caulk from allocation %s.', v_allocation.caulk_allocation_id),
      '',
      v_allocation.caulk_allocation_id,
      v_notes
    );
  end if;

  update app.caulk_job_checkouts
  set
    status = 'CLOSED',
    checked_in_at = now(),
    checked_in_by = v_actor,
    unused_tubes = v_unused_tubes,
    used_tubes = v_used_tubes,
    notes = v_notes
  where id = v_checkout.id
    and org_id = p_org_id;

  update app.caulk_job_allocations
  set
    returned_unused_tubes_total = v_allocation.returned_unused_tubes_total + v_unused_tubes,
    used_tubes_total = v_allocation.used_tubes_total + v_used_tubes,
    updated_at = now(),
    updated_by = v_actor
  where id = v_allocation.id
    and org_id = p_org_id;

  return jsonb_build_object(
    'jobNumber', v_allocation.job_number,
    'caulkAllocationId', v_allocation.caulk_allocation_id,
    'caulkCheckoutId', v_checkout.caulk_checkout_id,
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
  v_reason text := coalesce(nullif(app_api.trim_text(p_payload->>'reason'), ''), format('Removed from job %s.', app_api.trim_text(p_payload->>'jobNumber')));
  v_released_reserved_tubes integer := 0;
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
      format('Caulk allocation %s has %s open checkout%s. Check in first.', v_caulk_allocation_id, v_open_checkout_count, case when v_open_checkout_count = 1 then '' else 's' end)
    );
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
    'warnings', '[]'::jsonb
  );
end;
$$;

create or replace function public.api_film_orders_cancel(
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
  v_job_number text := app_api.require_text(p_payload->>'jobNumber', 'JobNumber');
  v_reason text := coalesce(nullif(app_api.trim_text(p_payload->>'reason'), ''), 'Job cancelled.');
  v_entry app.allocations;
  v_order app.film_orders;
  v_box app.boxes;
  v_released_by_box jsonb := '{}'::jsonb;
  v_released_count integer := 0;
  v_affected_box_count integer := 0;
  v_deleted_film_order_count integer := 0;
  v_caulk_result jsonb;
  v_caulk_cancelled_count integer := 0;
  v_caulk_released_reserved_tubes integer := 0;
begin
  perform app_api.require_org_member(p_org_id);

  v_caulk_result := app_api.cancel_active_caulk_allocations_for_job(
    p_org_id,
    p_actor,
    v_job_number,
    v_reason,
    true
  );
  v_caulk_cancelled_count := coalesce((v_caulk_result->>'cancelledAllocationCount')::integer, 0);
  v_caulk_released_reserved_tubes := coalesce((v_caulk_result->>'releasedReservedTubes')::integer, 0);

  for v_entry in
    select *
    from app.allocations a
    where a.org_id = p_org_id
      and upper(a.job_number) = upper(v_job_number)
      and a.status = 'ACTIVE'
    for update
  loop
    v_released_by_box := jsonb_set(
      v_released_by_box,
      array[v_entry.box_id],
      to_jsonb(coalesce((v_released_by_box->>v_entry.box_id)::integer, 0) + v_entry.allocated_feet),
      true
    );
    v_entry.status := 'CANCELLED';
    v_entry.resolved_at := now();
    v_entry.resolved_by := app_api.trim_text(p_actor);
    v_entry.notes := v_reason;
    perform app_api.save_allocation(v_entry);
    v_released_count := v_released_count + 1;
  end loop;

  for v_box in
    select *
    from app.boxes b
    where b.org_id = p_org_id
      and v_released_by_box ? b.box_id
    for update
  loop
    if v_box.status not in ('ZEROED', 'RETIRED') then
      v_box.feet_available := v_box.feet_available + coalesce((v_released_by_box->>v_box.box_id)::integer, 0);
      perform app_api.save_box(v_box);
    end if;
    v_affected_box_count := v_affected_box_count + 1;
  end loop;

  for v_order in
    select *
    from app.film_orders f
    where f.org_id = p_org_id
      and upper(f.job_number) = upper(v_job_number)
    for update
  loop
    perform app_api.delete_film_order_links_by_film_order_id(p_org_id, v_order.film_order_id);
    perform app_api.delete_film_order(p_org_id, v_order.film_order_id);
    v_deleted_film_order_count := v_deleted_film_order_count + 1;
  end loop;

  update app.jobs
  set lifecycle_status = 'CANCELLED',
      updated_at = now(),
      updated_by = app_api.trim_text(p_actor)
  where org_id = p_org_id
    and job_number = v_job_number;

  return jsonb_build_object(
    'jobNumber', v_job_number,
    'warnings', jsonb_build_array(
      format(
        'Cancelled job %s. Released %s active film allocation%s across %s box%s, released %s reserved caulk tube%s across %s caulk allocation%s, and deleted %s film order%s.',
        v_job_number,
        v_released_count,
        case when v_released_count = 1 then '' else 's' end,
        v_affected_box_count,
        case when v_affected_box_count = 1 then '' else 'es' end,
        v_caulk_released_reserved_tubes,
        case when v_caulk_released_reserved_tubes = 1 then '' else 's' end,
        v_caulk_cancelled_count,
        case when v_caulk_cancelled_count = 1 then '' else 's' end,
        v_deleted_film_order_count,
        case when v_deleted_film_order_count = 1 then '' else 's' end
      )
    )
  );
end;
$$;

select app_api.grant_execute_if_exists('public.api_acl_jobs_cancel_caulk_allocations(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_job_caulk_requirements_by_job(uuid, text)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_caulk_job_allocations_by_job(uuid, text)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_caulk_job_checkouts_by_job(uuid, text)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_add(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_update(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_checkout(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_checkin(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_remove(uuid, text, jsonb)', 'authenticated');

select app_api.grant_execute_if_exists('public.api_acl_jobs_cancel_caulk_allocations(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_list_job_caulk_requirements_by_job(uuid, text)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_list_caulk_job_allocations_by_job(uuid, text)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_list_caulk_job_checkouts_by_job(uuid, text)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_add(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_update(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_checkout(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_checkin(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_remove(uuid, text, jsonb)', 'service_role');
