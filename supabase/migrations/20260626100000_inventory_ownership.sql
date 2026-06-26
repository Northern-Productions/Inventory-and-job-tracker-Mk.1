-- Inventory ownership foundation.
-- Separates physical warehouse/location from accounting/legal owner company.

create table if not exists app.owner_companies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations(id) on delete cascade,
  code text not null,
  display_name text not null,
  lookup_key text generated always as (lower(btrim(code))) stored,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text not null default '',
  deactivated_at timestamptz,
  deactivated_by text not null default '',
  unique (org_id, lookup_key),
  constraint owner_companies_code_not_blank check (btrim(code) <> ''),
  constraint owner_companies_display_name_not_blank check (btrim(display_name) <> '')
);

create index if not exists idx_owner_companies_org_active_code
  on app.owner_companies (org_id, is_active desc, code);

alter table app.owner_companies
  drop constraint if exists owner_companies_org_id_id_key;
alter table app.owner_companies
  add constraint owner_companies_org_id_id_key
  unique (org_id, id);

insert into app.owner_companies (org_id, code, display_name, created_by, updated_by)
select o.id, seed.code, seed.display_name, 'migration:0172', 'migration:0172'
from app.organizations o
cross join (
  values
    ('MGT', 'MGT'),
    ('EDH', 'EDH'),
    ('KAM', 'KAM')
) as seed(code, display_name)
on conflict (org_id, lookup_key) do update set
  code = excluded.code,
  display_name = excluded.display_name,
  is_active = true,
  updated_at = now(),
  updated_by = excluded.updated_by;

create or replace function app_api.default_owner_company_code_for_warehouse(p_warehouse text)
returns text
language sql
immutable
as $$
  select case upper(btrim(coalesce(p_warehouse, '')))
    when 'IL2' then 'EDH'
    when 'MO1' then 'EDH'
    when 'IL1' then 'MGT'
    when 'MS1' then 'MGT'
    else 'MGT'
  end
$$;

create or replace function app_api.default_owner_company_id_for_warehouse(p_org_id uuid, p_warehouse text)
returns uuid
language sql
stable
as $$
  select oc.id
  from app.owner_companies oc
  where oc.org_id = p_org_id
    and oc.lookup_key = lower(app_api.default_owner_company_code_for_warehouse(p_warehouse))
  limit 1
$$;

create or replace function app_api.require_owner_company(
  p_org_id uuid,
  p_owner_company_id uuid,
  p_require_active boolean default false
)
returns app.owner_companies
language plpgsql
stable
security definer
set search_path = public, app, app_api
as $$
declare
  v_owner app.owner_companies;
begin
  if p_owner_company_id is null then
    perform app_api.raise_http(400, 'OwnerCompanyId is required.');
  end if;

  select *
  into v_owner
  from app.owner_companies oc
  where oc.org_id = p_org_id
    and oc.id = p_owner_company_id
  limit 1;

  if not found then
    perform app_api.raise_http(400, 'Owner company was not found.');
  end if;

  if p_require_active and not coalesce(v_owner.is_active, false) then
    perform app_api.raise_http(400, 'Owner company is inactive and cannot be selected for new assignments.');
  end if;

  return v_owner;
end;
$$;

alter table app.boxes
  add column if not exists owner_company_id uuid;

update app.boxes b
set owner_company_id = app_api.default_owner_company_id_for_warehouse(b.org_id, b.warehouse)
where b.owner_company_id is null;

alter table app.boxes
  alter column owner_company_id set not null;

alter table app.boxes
  drop constraint if exists boxes_owner_company_fk;
alter table app.boxes
  add constraint boxes_owner_company_fk
  foreign key (org_id, owner_company_id)
  references app.owner_companies(org_id, id)
  on delete restrict;

create index if not exists idx_boxes_org_owner_company
  on app.boxes (org_id, owner_company_id);

alter table app.caulk_stock
  add column if not exists owner_company_id uuid;

update app.caulk_stock s
set owner_company_id = app_api.default_owner_company_id_for_warehouse(s.org_id, s.warehouse)
where s.owner_company_id is null;

alter table app.caulk_stock
  alter column owner_company_id set not null;

alter table app.caulk_stock
  drop constraint if exists caulk_stock_owner_company_fk;
alter table app.caulk_stock
  add constraint caulk_stock_owner_company_fk
  foreign key (org_id, owner_company_id)
  references app.owner_companies(org_id, id)
  on delete restrict;

alter table app.caulk_stock
  drop constraint if exists caulk_stock_org_id_product_id_warehouse_key;
alter table app.caulk_stock
  drop constraint if exists caulk_stock_org_product_warehouse_key;
alter table app.caulk_stock
  add constraint caulk_stock_org_product_warehouse_owner_key
  unique (org_id, product_id, warehouse, owner_company_id);

create index if not exists idx_caulk_stock_org_owner
  on app.caulk_stock (org_id, owner_company_id);

alter table app.caulk_transactions
  add column if not exists owner_company_id uuid;

update app.caulk_transactions t
set owner_company_id = app_api.default_owner_company_id_for_warehouse(t.org_id, t.warehouse)
where t.owner_company_id is null;

alter table app.caulk_transactions
  alter column owner_company_id set not null;

alter table app.caulk_transactions
  drop constraint if exists caulk_transactions_owner_company_fk;
alter table app.caulk_transactions
  add constraint caulk_transactions_owner_company_fk
  foreign key (org_id, owner_company_id)
  references app.owner_companies(org_id, id)
  on delete restrict;

alter table app.caulk_job_allocations
  add column if not exists owner_company_id uuid;

update app.caulk_job_allocations a
set owner_company_id = app_api.default_owner_company_id_for_warehouse(a.org_id, a.warehouse)
where a.owner_company_id is null;

alter table app.caulk_job_allocations
  alter column owner_company_id set not null;

alter table app.caulk_job_allocations
  drop constraint if exists caulk_job_allocations_owner_company_fk;
alter table app.caulk_job_allocations
  add constraint caulk_job_allocations_owner_company_fk
  foreign key (org_id, owner_company_id)
  references app.owner_companies(org_id, id)
  on delete restrict;

alter table app.caulk_transfers
  add column if not exists owner_company_id uuid;

update app.caulk_transfers t
set owner_company_id = app_api.default_owner_company_id_for_warehouse(t.org_id, t.source_warehouse)
where t.owner_company_id is null;

alter table app.caulk_transfers
  alter column owner_company_id set not null;

alter table app.caulk_transfers
  drop constraint if exists caulk_transfers_owner_company_fk;
alter table app.caulk_transfers
  add constraint caulk_transfers_owner_company_fk
  foreign key (org_id, owner_company_id)
  references app.owner_companies(org_id, id)
  on delete restrict;

alter table app.caulk_job_checkouts
  add column if not exists owner_company_id uuid;

update app.caulk_job_checkouts c
set owner_company_id = coalesce(
  a.owner_company_id,
  app_api.default_owner_company_id_for_warehouse(c.org_id, c.warehouse)
)
from app.caulk_job_allocations a
where a.org_id = c.org_id
  and a.id = c.caulk_allocation_id
  and c.owner_company_id is null;

alter table app.caulk_job_checkouts
  alter column owner_company_id set not null;

alter table app.caulk_job_checkouts
  drop constraint if exists caulk_job_checkouts_owner_company_fk;
alter table app.caulk_job_checkouts
  add constraint caulk_job_checkouts_owner_company_fk
  foreign key (org_id, owner_company_id)
  references app.owner_companies(org_id, id)
  on delete restrict;

create table if not exists app.inventory_ownership_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations(id) on delete cascade,
  resource_type text not null,
  resource_id text not null,
  resource_label text not null default '',
  old_owner_company_id uuid not null,
  old_owner_code text not null,
  old_owner_display_name text not null,
  new_owner_company_id uuid not null,
  new_owner_code text not null,
  new_owner_display_name text not null,
  actor text not null default '',
  note text not null default '',
  batch_id text not null default '',
  created_at timestamptz not null default now(),
  foreign key (org_id, old_owner_company_id) references app.owner_companies(org_id, id) on delete restrict,
  foreign key (org_id, new_owner_company_id) references app.owner_companies(org_id, id) on delete restrict,
  constraint inventory_ownership_events_resource_type_valid
    check (resource_type in ('film_box', 'caulk_stock'))
);

create index if not exists idx_inventory_ownership_events_org_resource
  on app.inventory_ownership_events (org_id, resource_type, resource_id, created_at desc);

do $$
declare
  v_def text;
  v_base text;
  v_next text;
begin
  select pg_get_functiondef('app_api.save_box(app.boxes)'::regprocedure)
  into v_def;

  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  if position('owner_company_id = coalesce(excluded.owner_company_id' in v_base) > 0 then
    return;
  end if;

  v_next := replace(v_next, E'    warehouse,\n', E'    warehouse,\n    owner_company_id,\n');
  v_next := replace(v_next, E'    p_box.warehouse,\n', E'    p_box.warehouse,\n    p_box.owner_company_id,\n');
  v_next := replace(
    v_next,
    E'    warehouse = excluded.warehouse,\n',
    E'    warehouse = excluded.warehouse,\n    owner_company_id = coalesce(excluded.owner_company_id, app.boxes.owner_company_id),\n'
  );

  if v_next = v_base
     or position('p_box.owner_company_id' in v_next) = 0
     or position('owner_company_id = coalesce(excluded.owner_company_id' in v_next) = 0 then
    raise exception 'app_api.save_box owner_company_id patch did not match expected snippets';
  end if;

  execute v_next;
end;
$$;

do $$
declare
  v_def text;
  v_base text;
  v_next text;
begin
  select pg_get_functiondef('app_api.public_box_json(app.boxes)'::regprocedure)
  into v_def;

  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  if position('''ownerCompanyId'', coalesce(p_box.owner_company_id::text, '''')' in v_base) > 0 then
    return;
  end if;

  v_next := replace(
    v_next,
    replace($old$
    'warehouse', coalesce(p_box.warehouse::text, ''),
$old$, E'\r\n', E'\n'),
    replace($new$
    'warehouse', coalesce(p_box.warehouse::text, ''),
    'ownerCompanyId', coalesce(p_box.owner_company_id::text, ''),
    'ownerCompanyCode', coalesce((select oc.code from app.owner_companies oc where oc.org_id = p_box.org_id and oc.id = p_box.owner_company_id limit 1), ''),
    'ownerCompanyDisplayName', coalesce((select oc.display_name from app.owner_companies oc where oc.org_id = p_box.org_id and oc.id = p_box.owner_company_id limit 1), ''),
    'ownerCompanyIsActive', coalesce((select oc.is_active from app.owner_companies oc where oc.org_id = p_box.org_id and oc.id = p_box.owner_company_id limit 1), false),
$new$, E'\r\n', E'\n')
  );

  if v_next = v_base
     or position('''ownerCompanyId'', coalesce(p_box.owner_company_id::text, '''')' in v_next) = 0 then
    raise exception 'app_api.public_box_json owner fields patch did not match expected snippets';
  end if;

  execute v_next;
end;
$$;

create or replace function app_api.resolve_caulk_stock_owner_company_id(
  p_org_id uuid,
  p_product_id uuid,
  p_warehouse text,
  p_owner_company_id uuid default null,
  p_stock_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_warehouse text := app_api.caulk_require_warehouse(p_org_id, p_warehouse);
  v_owner_company_id uuid;
  v_count integer := 0;
begin
  if p_stock_id is not null then
    select s.owner_company_id
    into v_owner_company_id
    from app.caulk_stock s
    where s.org_id = p_org_id
      and s.id = p_stock_id
      and s.product_id = p_product_id
      and s.warehouse = v_warehouse
    limit 1;

    if v_owner_company_id is null then
      perform app_api.raise_http(400, 'Caulk stock row was not found for this product and warehouse.');
    end if;
    return v_owner_company_id;
  end if;

  if p_owner_company_id is not null then
    perform app_api.require_owner_company(p_org_id, p_owner_company_id, false);
    return p_owner_company_id;
  end if;

  select count(*), min(s.owner_company_id)
  into v_count, v_owner_company_id
  from app.caulk_stock s
  where s.org_id = p_org_id
    and s.product_id = p_product_id
    and s.warehouse = v_warehouse;

  if v_count = 1 then
    return v_owner_company_id;
  end if;

  if v_count = 0 then
    return app_api.default_owner_company_id_for_warehouse(p_org_id, v_warehouse);
  end if;

  perform app_api.raise_http(400, 'Multiple owner rows exist for this caulk product and warehouse. Select an exact owner row.');
end;
$$;

create or replace function app_api.caulk_seed_stock_row_for_owner(
  p_org_id uuid,
  p_actor text,
  p_product_id uuid,
  p_warehouse text,
  p_owner_company_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_warehouse text := app_api.caulk_require_warehouse(p_org_id, p_warehouse);
  v_owner app.owner_companies;
begin
  v_owner := app_api.require_owner_company(p_org_id, p_owner_company_id, true);

  insert into app.caulk_stock (
    org_id,
    product_id,
    warehouse,
    owner_company_id,
    tubes_on_hand,
    updated_by
  )
  values (
    p_org_id,
    p_product_id,
    v_warehouse,
    v_owner.id,
    0,
    app_api.trim_text(p_actor)
  )
  on conflict (org_id, product_id, warehouse, owner_company_id) do nothing;

  return v_warehouse;
end;
$$;

create or replace function app_api.caulk_apply_stock_delta_for_owner(
  p_org_id uuid,
  p_actor text,
  p_product_id uuid,
  p_warehouse text,
  p_owner_company_id uuid,
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
  v_warehouse text := app_api.caulk_seed_stock_row_for_owner(p_org_id, v_actor, p_product_id, p_warehouse, p_owner_company_id);
  v_owner app.owner_companies := app_api.require_owner_company(p_org_id, p_owner_company_id, false);
  v_product app.caulk_products;
  v_stock app.caulk_stock;
  v_before integer := 0;
  v_after integer := 0;
  v_transaction_id text := app_api.caulk_create_transaction_id();
begin
  if p_delta_tubes is null or p_delta_tubes = 0 then
    perform app_api.raise_http(400, 'DeltaTubes must be a non-zero integer.');
  end if;

  if v_action not in ('RECEIVE', 'USE', 'ADJUST', 'TRANSFER_OUT', 'TRANSFER_IN', 'JOB_ALLOCATE', 'JOB_ALLOCATE_EDIT_INC', 'JOB_ALLOCATE_EDIT_DEC', 'JOB_CHECKOUT_OVERAGE', 'JOB_CHECKIN_UNUSED', 'BACKFILL_MIGRATE') then
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
  into v_stock
  from app.caulk_stock s
  where s.org_id = p_org_id
    and s.product_id = p_product_id
    and s.warehouse = v_warehouse
    and s.owner_company_id = v_owner.id
  for update;

  v_before := coalesce(v_stock.tubes_on_hand, 0);
  v_after := v_before + p_delta_tubes;

  if v_after < 0 then
    perform app_api.raise_http(400, format('Insufficient stock. Requested delta would move tubes below zero (%s).', v_after));
  end if;

  update app.caulk_stock s
  set tubes_on_hand = v_after,
      updated_at = now(),
      updated_by = v_actor
  where s.org_id = p_org_id
    and s.product_id = p_product_id
    and s.warehouse = v_warehouse
    and s.owner_company_id = v_owner.id;

  insert into app.caulk_transactions (
    org_id,
    transaction_id,
    product_id,
    warehouse,
    owner_company_id,
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
    v_owner.id,
    v_action,
    p_delta_tubes,
    v_after,
    v_product.tubes_per_case,
    v_reason,
    coalesce(p_notes, ''),
    coalesce(p_transfer_id, ''),
    coalesce(p_source_box_id, ''),
    v_actor
  );

  return jsonb_build_object(
    'stockId', v_stock.id,
    'productId', p_product_id,
    'warehouse', v_warehouse,
    'ownerCompanyId', v_owner.id,
    'ownerCompanyCode', v_owner.code,
    'ownerCompanyDisplayName', v_owner.display_name,
    'tubesOnHand', v_after,
    'tubesPerCase', v_product.tubes_per_case,
    'casesOnHand', floor(v_after::numeric / v_product.tubes_per_case::numeric)::integer,
    'looseTubes', mod(v_after, v_product.tubes_per_case)
  );
end;
$$;

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
  v_warehouse text := app_api.caulk_require_warehouse(p_org_id, p_warehouse);
  v_owner_company_id uuid;
begin
  v_owner_company_id := app_api.resolve_caulk_stock_owner_company_id(
    p_org_id,
    p_product_id,
    v_warehouse,
    null,
    null
  );

  return app_api.caulk_seed_stock_row_for_owner(
    p_org_id,
    p_actor,
    p_product_id,
    v_warehouse,
    v_owner_company_id
  );
end;
$$;

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
  v_owner_company_id uuid;
begin
  v_owner_company_id := app_api.resolve_caulk_stock_owner_company_id(
    p_org_id,
    p_product_id,
    p_warehouse,
    null,
    null
  );

  return app_api.caulk_apply_stock_delta_for_owner(
    p_org_id,
    p_actor,
    p_product_id,
    p_warehouse,
    v_owner_company_id,
    p_action,
    p_delta_tubes,
    p_reason,
    p_transfer_id,
    p_source_box_id,
    p_notes
  );
end;
$$;

create or replace function app_api.caulk_owner_from_allocation_public_id(
  p_org_id uuid,
  p_caulk_allocation_id text
)
returns uuid
language sql
stable
as $$
  select a.owner_company_id
  from app.caulk_job_allocations a
  where a.org_id = p_org_id
    and a.caulk_allocation_id = app_api.trim_text(p_caulk_allocation_id)
  limit 1
$$;

create or replace function app_api.caulk_reserve_local_tubes_for_owner(
  p_org_id uuid,
  p_actor text,
  p_product_id uuid,
  p_target_warehouse text,
  p_owner_company_id uuid,
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
  v_target_warehouse text := app_api.caulk_seed_stock_row_for_owner(
    p_org_id,
    p_actor,
    p_product_id,
    p_target_warehouse,
    p_owner_company_id
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
    and s.owner_company_id = p_owner_company_id
  for update;

  v_target_available := coalesce(v_target_stock.tubes_on_hand, 0);
  v_reserved_tubes := least(v_target_available, p_reserve_tubes);
  v_shortage_tubes := greatest(p_reserve_tubes - v_reserved_tubes, 0);

  if v_reserved_tubes > 0 then
    perform app_api.caulk_apply_stock_delta_for_owner(
      p_org_id,
      v_actor,
      p_product_id,
      v_target_warehouse,
      p_owner_company_id,
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
    'ownerCompanyId', p_owner_company_id,
    'reservedTubes', v_reserved_tubes,
    'shortageTubes', v_shortage_tubes
  );
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
  v_warehouse text := app_api.caulk_require_warehouse(p_org_id, p_target_warehouse);
  v_owner_company_id uuid;
begin
  v_owner_company_id := coalesce(
    app_api.caulk_owner_from_allocation_public_id(p_org_id, p_source_box_id),
    app_api.resolve_caulk_stock_owner_company_id(p_org_id, p_product_id, v_warehouse, null, null)
  );

  return app_api.caulk_reserve_local_tubes_for_owner(
    p_org_id,
    p_actor,
    p_product_id,
    v_warehouse,
    v_owner_company_id,
    p_reserve_tubes,
    p_reserve_action,
    p_reserve_reason,
    p_source_box_id,
    p_notes
  );
end;
$$;

create or replace function app_api.caulk_start_pending_transfer_for_owner(
  p_org_id uuid,
  p_actor text,
  p_allocation_row_id uuid,
  p_allocation_public_id text,
  p_job_id uuid,
  p_job_number text,
  p_product_id uuid,
  p_owner_company_id uuid,
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
    return jsonb_build_object('transferId', '', 'warnings', '[]'::jsonb);
  end if;

  v_destination_warehouse := app_api.caulk_seed_stock_row_for_owner(
    p_org_id,
    p_actor,
    p_product_id,
    p_to_warehouse,
    p_owner_company_id
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

  v_source_warehouse := app_api.caulk_seed_stock_row_for_owner(
    p_org_id,
    p_actor,
    p_product_id,
    v_requested_source_warehouse,
    p_owner_company_id
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
    and s.owner_company_id = p_owner_company_id
  for update;

  v_source_available := coalesce(v_source_stock.tubes_on_hand, 0);
  if v_source_available < p_pending_tubes then
    perform app_api.raise_http(
      400,
      format(
        '%s only has %s tube%s available for the selected owner; %s tube%s needed to cover the shortage at %s.',
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

  perform app_api.caulk_apply_stock_delta_for_owner(
    p_org_id,
    v_actor,
    p_product_id,
    v_source_warehouse,
    p_owner_company_id,
    'TRANSFER_OUT',
    -p_pending_tubes,
    format('Started caulk transfer from %s to %s for job %s.', v_source_warehouse, v_destination_warehouse, p_job_number),
    v_transfer_id,
    p_allocation_public_id,
    v_notes
  );

  insert into app.caulk_transfers (
    org_id,
    transfer_id,
    caulk_allocation_id,
    job_id,
    job_number,
    product_id,
    owner_company_id,
    source_warehouse,
    destination_warehouse,
    pending_tubes,
    status,
    notes,
    created_by,
    updated_by
  )
  values (
    p_org_id,
    v_transfer_id,
    p_allocation_row_id,
    p_job_id,
    p_job_number,
    p_product_id,
    p_owner_company_id,
    v_source_warehouse,
    v_destination_warehouse,
    p_pending_tubes,
    'PENDING',
    v_notes,
    v_actor,
    v_actor
  );

  return jsonb_build_object(
    'transferId', v_transfer_id,
    'warnings', jsonb_build_array(format('Started caulk transfer %s from %s to %s.', v_transfer_id, v_source_warehouse, v_destination_warehouse))
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
  v_owner_company_id uuid;
begin
  v_owner_company_id := coalesce(
    app_api.caulk_owner_from_allocation_public_id(p_org_id, p_allocation_public_id),
    app_api.resolve_caulk_stock_owner_company_id(p_org_id, p_product_id, p_to_warehouse, null, null)
  );

  return app_api.caulk_start_pending_transfer_for_owner(
    p_org_id,
    p_actor,
    p_allocation_row_id,
    p_allocation_public_id,
    p_job_id,
    p_job_number,
    p_product_id,
    v_owner_company_id,
    p_from_warehouse,
    p_to_warehouse,
    p_pending_tubes,
    p_notes
  );
end;
$$;

create or replace function app_api.set_caulk_job_allocation_owner_company()
returns trigger
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  if new.owner_company_id is null then
    new.owner_company_id := app_api.resolve_caulk_stock_owner_company_id(
      new.org_id,
      new.product_id,
      new.warehouse,
      null,
      null
    );
  end if;

  return new;
end;
$$;

drop trigger if exists set_caulk_job_allocation_owner_company on app.caulk_job_allocations;
create trigger set_caulk_job_allocation_owner_company
before insert or update of product_id, warehouse, owner_company_id on app.caulk_job_allocations
for each row execute function app_api.set_caulk_job_allocation_owner_company();

create or replace function app_api.set_caulk_transfer_owner_company()
returns trigger
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_allocation_owner uuid;
begin
  if new.owner_company_id is null then
    select a.owner_company_id
    into v_allocation_owner
    from app.caulk_job_allocations a
    where a.org_id = new.org_id
      and a.id = new.caulk_allocation_id
    limit 1;

    new.owner_company_id := coalesce(
      v_allocation_owner,
      app_api.resolve_caulk_stock_owner_company_id(new.org_id, new.product_id, new.source_warehouse, null, null)
    );
  end if;

  return new;
end;
$$;

drop trigger if exists set_caulk_transfer_owner_company on app.caulk_transfers;
create trigger set_caulk_transfer_owner_company
before insert or update of product_id, source_warehouse, owner_company_id on app.caulk_transfers
for each row execute function app_api.set_caulk_transfer_owner_company();

create or replace function app_api.set_caulk_checkout_owner_company()
returns trigger
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_allocation_owner uuid;
begin
  if new.owner_company_id is null then
    select a.owner_company_id
    into v_allocation_owner
    from app.caulk_job_allocations a
    where a.org_id = new.org_id
      and a.id = new.caulk_allocation_id
    limit 1;

    new.owner_company_id := coalesce(
      v_allocation_owner,
      app_api.resolve_caulk_stock_owner_company_id(new.org_id, new.product_id, new.warehouse, null, null)
    );
  end if;

  return new;
end;
$$;

drop trigger if exists set_caulk_checkout_owner_company on app.caulk_job_checkouts;
create trigger set_caulk_checkout_owner_company
before insert or update of product_id, warehouse, owner_company_id on app.caulk_job_checkouts
for each row execute function app_api.set_caulk_checkout_owner_company();

drop function if exists public.api_acl_list_caulk_stock(uuid, text, text, text);
create or replace function public.api_acl_list_caulk_stock(
  p_org_id uuid,
  p_warehouse text default '',
  p_manufacturer text default '',
  p_q text default '',
  p_product_id uuid default null,
  p_stock_id uuid default null,
  p_owner_company_id uuid default null
)
returns table (
  stock_id uuid,
  warehouse text,
  product_id uuid,
  manufacturer_id uuid,
  manufacturer text,
  product_name text,
  product_code text,
  tubes_per_case integer,
  owner_company_id uuid,
  owner_company_code text,
  owner_company_display_name text,
  owner_company_is_active boolean,
  tubes_on_hand integer,
  cases_on_hand integer,
  loose_tubes integer,
  updated_at timestamptz,
  updated_by text
)
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_warehouse text := upper(btrim(coalesce(p_warehouse, '')));
  v_manufacturer_lookup text := app_api.normalize_caulk_lookup_key(p_manufacturer);
  v_q text := app_api.normalize_caulk_lookup_key(p_q);
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'read');

  if v_warehouse <> '' and v_warehouse <> 'ALL' then
    v_warehouse := app_api.caulk_require_warehouse(p_org_id, v_warehouse);
  end if;

  return query
  select
    s.id,
    s.warehouse,
    p.id,
    p.manufacturer_id,
    m.name,
    p.name,
    p.code,
    p.tubes_per_case,
    s.owner_company_id,
    oc.code,
    oc.display_name,
    oc.is_active,
    s.tubes_on_hand,
    floor(s.tubes_on_hand::numeric / p.tubes_per_case::numeric)::integer,
    mod(s.tubes_on_hand, p.tubes_per_case),
    s.updated_at,
    s.updated_by
  from app.caulk_stock s
  join app.caulk_products p
    on p.org_id = s.org_id
   and p.id = s.product_id
  join app.caulk_manufacturers m
    on m.org_id = p.org_id
   and m.id = p.manufacturer_id
  join app.owner_companies oc
    on oc.org_id = s.org_id
   and oc.id = s.owner_company_id
  where s.org_id = p_org_id
    and (v_warehouse = '' or v_warehouse = 'ALL' or s.warehouse = v_warehouse)
    and (v_manufacturer_lookup = '' or m.lookup_key = v_manufacturer_lookup)
    and (p_product_id is null or s.product_id = p_product_id)
    and (p_stock_id is null or s.id = p_stock_id)
    and (p_owner_company_id is null or s.owner_company_id = p_owner_company_id)
    and (
      v_q = ''
      or app_api.normalize_caulk_lookup_key(p.name) like ('%' || v_q || '%')
      or app_api.normalize_caulk_lookup_key(p.code) like ('%' || v_q || '%')
      or app_api.normalize_caulk_lookup_key(m.name) like ('%' || v_q || '%')
      or app_api.normalize_caulk_lookup_key(oc.code) like ('%' || v_q || '%')
      or app_api.normalize_caulk_lookup_key(oc.display_name) like ('%' || v_q || '%')
    )
  order by s.warehouse, oc.code, lower(m.name), lower(p.name), lower(p.code);
end;
$$;

drop function if exists public.api_acl_list_caulk_transactions(uuid, text, uuid, integer);
create or replace function public.api_acl_list_caulk_transactions(
  p_org_id uuid,
  p_warehouse text default '',
  p_product_id uuid default null,
  p_limit integer default 200
)
returns table (
  transaction_id text,
  product_id uuid,
  warehouse text,
  owner_company_id uuid,
  owner_company_code text,
  owner_company_display_name text,
  manufacturer text,
  product_name text,
  product_code text,
  action text,
  delta_tubes integer,
  resulting_tubes_on_hand integer,
  tubes_per_case integer,
  reason text,
  notes text,
  transfer_id text,
  source_box_id text,
  job_id uuid,
  job_number text,
  job_warehouse text,
  created_at timestamptz,
  created_by text
)
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_warehouse text := upper(btrim(coalesce(p_warehouse, '')));
  v_limit integer := greatest(1, least(coalesce(p_limit, 200), 1000));
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'read');

  if v_warehouse <> '' and v_warehouse <> 'ALL' then
    v_warehouse := app_api.caulk_require_warehouse(p_org_id, v_warehouse);
  end if;

  return query
  select
    t.transaction_id,
    t.product_id,
    t.warehouse,
    t.owner_company_id,
    oc.code,
    oc.display_name,
    m.name,
    p.name,
    p.code,
    t.action,
    t.delta_tubes,
    t.resulting_tubes_on_hand,
    t.tubes_per_case,
    case
      when t.action = 'JOB_CHECKIN_UNUSED'
        and btrim(coalesce(source_allocation.job_number, '')) <> ''
        then format('Checked in unused caulk from job %s.', source_allocation.job_number)
      when t.action = 'ADJUST'
        and lower(btrim(coalesce(t.reason, ''))) = 'inventory edit'
        and btrim(coalesce(t.notes, '')) <> ''
        then btrim(t.notes)
      else t.reason
    end,
    t.notes,
    t.transfer_id,
    t.source_box_id,
    resolved_job.id,
    resolved_job.job_number,
    resolved_job.warehouse,
    t.created_at,
    t.created_by
  from app.caulk_transactions t
  join app.caulk_products p
    on p.org_id = t.org_id
   and p.id = t.product_id
  join app.caulk_manufacturers m
    on m.org_id = p.org_id
   and m.id = p.manufacturer_id
  left join app.owner_companies oc
    on oc.org_id = t.org_id
   and oc.id = t.owner_company_id
  left join app.caulk_job_allocations source_allocation
    on source_allocation.org_id = t.org_id
   and source_allocation.caulk_allocation_id = t.source_box_id
  left join app.caulk_transfers source_transfer
    on source_transfer.org_id = t.org_id
   and source_transfer.transfer_id = t.transfer_id
   and btrim(coalesce(t.transfer_id, '')) <> ''
  left join app.caulk_job_allocations transfer_allocation
    on transfer_allocation.org_id = source_transfer.org_id
   and transfer_allocation.id = source_transfer.caulk_allocation_id
  left join app.jobs resolved_job
    on resolved_job.org_id = t.org_id
   and resolved_job.id = coalesce(source_allocation.job_id, source_transfer.job_id, transfer_allocation.job_id)
  where t.org_id = p_org_id
    and (v_warehouse = '' or v_warehouse = 'ALL' or t.warehouse = v_warehouse)
    and (p_product_id is null or t.product_id = p_product_id)
  order by t.created_at desc
  limit v_limit;
end;
$$;

drop function if exists public.api_acl_list_caulk_transfers(uuid, text, uuid);
create or replace function public.api_acl_list_caulk_transfers(
  p_org_id uuid,
  p_warehouse text,
  p_product_id uuid default null
)
returns table (
  transfer_id text,
  caulk_allocation_id text,
  job_number text,
  job_id uuid,
  job_warehouse text,
  product_id uuid,
  manufacturer_id uuid,
  manufacturer text,
  product_name text,
  product_code text,
  tubes_per_case integer,
  owner_company_id uuid,
  owner_company_code text,
  owner_company_display_name text,
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
    coalesce(t.job_id, a.job_id),
    coalesce(job_by_id.warehouse, legacy_job.warehouse),
    p.id,
    p.manufacturer_id,
    m.name,
    p.name,
    p.code,
    p.tubes_per_case,
    t.owner_company_id,
    oc.code,
    oc.display_name,
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
  left join app.jobs job_by_id
    on job_by_id.org_id = t.org_id
   and job_by_id.id = coalesce(t.job_id, a.job_id)
  left join app.jobs legacy_job
    on legacy_job.org_id = a.org_id
   and coalesce(t.job_id, a.job_id) is null
   and upper(trim(legacy_job.job_number)) = upper(trim(a.job_number))
  join app.caulk_products p
    on p.org_id = t.org_id
   and p.id = t.product_id
  join app.caulk_manufacturers m
    on m.org_id = p.org_id
   and m.id = p.manufacturer_id
  left join app.owner_companies oc
    on oc.org_id = t.org_id
   and oc.id = t.owner_company_id
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
  v_owner_id uuid := nullif(app_api.trim_text(p_payload->>'ownerCompanyId'), '')::uuid;
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
    perform app_api.require_owner_company(p_org_id, v_owner_id, true);
    perform app_api.caulk_seed_stock_row_for_owner(
      p_org_id,
      p_actor,
      v_row.id,
      v_warehouse,
      v_owner_id
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

create or replace function public.api_acl_caulk_mutate_stock(
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
  v_action text := upper(app_api.trim_text(p_payload->>'action'));
  v_product_id uuid := nullif(app_api.trim_text(p_payload->>'productId'), '')::uuid;
  v_warehouse text := p_payload->>'warehouse';
  v_stock_id uuid := nullif(app_api.trim_text(p_payload->>'stockId'), '')::uuid;
  v_owner_id uuid := nullif(app_api.trim_text(p_payload->>'ownerCompanyId'), '')::uuid;
  v_cases integer := coalesce(nullif(app_api.trim_text(p_payload->>'cases'), '')::integer, 0);
  v_tubes integer := coalesce(nullif(app_api.trim_text(p_payload->>'tubes'), '')::integer, 0);
  v_delta_override integer := nullif(app_api.trim_text(p_payload->>'deltaTubes'), '')::integer;
  v_reason text := app_api.trim_text(coalesce(p_payload->>'reason', v_action));
  v_notes text := app_api.trim_text(coalesce(p_payload->>'notes', ''));
  v_tubes_per_case integer;
  v_delta integer;
  v_resolved_owner uuid;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');

  if v_product_id is null then
    perform app_api.raise_http(400, 'ProductId is required.');
  end if;

  if v_action not in ('RECEIVE', 'USE', 'ADJUST') then
    perform app_api.raise_http(400, 'Action must be RECEIVE, USE, or ADJUST.');
  end if;

  if v_action = 'ADJUST' and v_notes <> '' and lower(v_reason) = 'inventory edit' then
    v_reason := v_notes;
  end if;

  select p.tubes_per_case
  into v_tubes_per_case
  from app.caulk_products p
  where p.org_id = p_org_id
    and p.id = v_product_id
  limit 1;

  if not found then
    perform app_api.raise_http(400, 'Product was not found.');
  end if;

  if v_delta_override is null then
    v_delta := (v_cases * v_tubes_per_case) + v_tubes;
  else
    v_delta := v_delta_override;
  end if;

  v_resolved_owner := app_api.resolve_caulk_stock_owner_company_id(
    p_org_id,
    v_product_id,
    v_warehouse,
    v_owner_id,
    v_stock_id
  );

  if v_action = 'RECEIVE' then
    if v_delta <= 0 then
      perform app_api.raise_http(400, 'Receive requires a positive quantity.');
    end if;
    return app_api.caulk_apply_stock_delta_for_owner(
      p_org_id, p_actor, v_product_id, v_warehouse, v_resolved_owner, 'RECEIVE', v_delta, v_reason, '', '', v_notes
    );
  end if;

  if v_action = 'USE' then
    if v_delta <= 0 then
      perform app_api.raise_http(400, 'Use requires a positive quantity.');
    end if;
    return app_api.caulk_apply_stock_delta_for_owner(
      p_org_id, p_actor, v_product_id, v_warehouse, v_resolved_owner, 'USE', -v_delta, v_reason, '', '', v_notes
    );
  end if;

  if v_delta = 0 then
    perform app_api.raise_http(400, 'Adjust requires a non-zero delta.');
  end if;

  return app_api.caulk_apply_stock_delta_for_owner(
    p_org_id, p_actor, v_product_id, v_warehouse, v_resolved_owner, 'ADJUST', v_delta, v_reason, '', '', v_notes
  );
end;
$$;

create or replace function public.api_acl_caulk_transfer_stock(
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
  v_from_warehouse text := p_payload->>'fromWarehouse';
  v_to_warehouse text := p_payload->>'toWarehouse';
  v_stock_id uuid := nullif(app_api.trim_text(p_payload->>'stockId'), '')::uuid;
  v_owner_id uuid := nullif(app_api.trim_text(p_payload->>'ownerCompanyId'), '')::uuid;
  v_cases integer := coalesce(nullif(app_api.trim_text(p_payload->>'cases'), '')::integer, 0);
  v_tubes integer := coalesce(nullif(app_api.trim_text(p_payload->>'tubes'), '')::integer, 0);
  v_delta_override integer := nullif(app_api.trim_text(p_payload->>'deltaTubes'), '')::integer;
  v_reason text := coalesce(p_payload->>'reason', 'TRANSFER');
  v_notes text := coalesce(p_payload->>'notes', '');
  v_tubes_per_case integer;
  v_delta integer;
  v_transfer_id text := app_api.caulk_create_transaction_id();
  v_out jsonb;
  v_in jsonb;
  v_from_code text;
  v_to_code text;
  v_resolved_owner uuid;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');

  if v_product_id is null then
    perform app_api.raise_http(400, 'ProductId is required.');
  end if;

  v_from_code := app_api.caulk_require_warehouse(p_org_id, v_from_warehouse);
  v_to_code := app_api.caulk_require_warehouse(p_org_id, v_to_warehouse);

  if v_from_code = v_to_code then
    perform app_api.raise_http(400, 'Transfer source and destination warehouse must differ.');
  end if;

  select p.tubes_per_case
  into v_tubes_per_case
  from app.caulk_products p
  where p.org_id = p_org_id
    and p.id = v_product_id
  limit 1;

  if not found then
    perform app_api.raise_http(400, 'Product was not found.');
  end if;

  if v_delta_override is null then
    v_delta := (v_cases * v_tubes_per_case) + v_tubes;
  else
    v_delta := v_delta_override;
  end if;

  if v_delta <= 0 then
    perform app_api.raise_http(400, 'Transfer requires a positive quantity.');
  end if;

  v_resolved_owner := app_api.resolve_caulk_stock_owner_company_id(
    p_org_id,
    v_product_id,
    v_from_code,
    v_owner_id,
    v_stock_id
  );

  v_out := app_api.caulk_apply_stock_delta_for_owner(
    p_org_id, p_actor, v_product_id, v_from_code, v_resolved_owner, 'TRANSFER_OUT', -v_delta, v_reason, v_transfer_id, '', v_notes
  );

  v_in := app_api.caulk_apply_stock_delta_for_owner(
    p_org_id, p_actor, v_product_id, v_to_code, v_resolved_owner, 'TRANSFER_IN', v_delta, v_reason, v_transfer_id, '', v_notes
  );

  return jsonb_build_object(
    'transferId', v_transfer_id,
    'movedTubes', v_delta,
    'from', v_out,
    'to', v_in
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
  v_job_id_text text := app_api.trim_text(p_payload->>'jobId');
  v_has_job_id boolean := v_job_id_text <> '';
  v_job_id uuid := null;
  v_requirement_id uuid := nullif(app_api.trim_text(p_payload->>'requirementId'), '')::uuid;
  v_product_id uuid := nullif(app_api.trim_text(p_payload->>'productId'), '')::uuid;
  v_stock_id uuid := nullif(app_api.trim_text(p_payload->>'stockId'), '')::uuid;
  v_owner_id uuid := nullif(app_api.trim_text(p_payload->>'ownerCompanyId'), '')::uuid;
  v_source_stock_id uuid := nullif(app_api.trim_text(p_payload->>'sourceStockId'), '')::uuid;
  v_source_owner_id uuid := nullif(app_api.trim_text(p_payload->>'sourceOwnerCompanyId'), '')::uuid;
  v_warehouse text := app_api.caulk_require_warehouse(p_org_id, p_payload->>'warehouse');
  v_allocated_tubes integer := floor(nullif(app_api.trim_text(p_payload->>'allocatedTubes'), '')::numeric);
  v_actor text := app_api.trim_text(p_actor);
  v_notes text := app_api.trim_text(p_payload->>'notes');
  v_resolved_owner uuid;
  v_local_reservation jsonb := '{}'::jsonb;
  v_reserved_tubes integer := 0;
  v_shortage_tubes integer := 0;
  v_transfer_result jsonb := jsonb_build_object('warnings', '[]'::jsonb);
  v_planner_result jsonb := '{}'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'write');

  if v_product_id is null then
    perform app_api.raise_http(400, 'productId is required.');
  end if;

  if v_allocated_tubes is null or v_allocated_tubes <= 0 then
    perform app_api.raise_http(400, 'allocatedTubes must be greater than zero.');
  end if;

  if v_has_job_id then
    begin
      v_job_id := v_job_id_text::uuid;
    exception when others then
      perform app_api.raise_http(400, 'jobId must be a valid UUID.');
    end;

    select *
    into v_job
    from app.jobs j
    where j.org_id = p_org_id
      and j.id = v_job_id
    for update;

    if not found then
      perform app_api.raise_http(404, 'Job was not found.');
    end if;

    if upper(trim(v_job.job_number)) <> upper(trim(v_job_number)) then
      perform app_api.raise_http(400, 'Job identity mismatch: selected job does not match jobNumber.');
    end if;

    if app_api.normalize_job_lifecycle_status(v_job.lifecycle_status::text) <> 'ACTIVE'::app.job_lifecycle_status then
      perform app_api.raise_http(400, format('Job %s is closed and cannot receive caulk allocations.', v_job.job_number));
    end if;
  else
    v_job := app_api.require_active_job_for_caulk(p_org_id, v_job_number);
  end if;

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

  v_resolved_owner := app_api.resolve_caulk_stock_owner_company_id(
    p_org_id,
    v_product_id,
    v_warehouse,
    v_owner_id,
    v_stock_id
  );

  v_local_reservation := app_api.caulk_reserve_local_tubes_for_owner(
    p_org_id,
    v_actor,
    v_product.id,
    v_warehouse,
    v_resolved_owner,
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
    owner_company_id,
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
    v_resolved_owner,
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

  v_transfer_result := app_api.caulk_start_pending_transfer_for_owner(
    p_org_id,
    v_actor,
    v_allocation_row_id,
    v_allocation_id,
    v_job.id,
    v_job.job_number,
    v_product.id,
    v_resolved_owner,
    p_payload->>'transferFromWarehouse',
    v_warehouse,
    v_shortage_tubes,
    v_notes
  );

  v_warnings := coalesce(v_transfer_result->'warnings', '[]'::jsonb);
  v_planner_result := app_api.reconcile_auto_planned_allocations(
    p_org_id,
    v_actor,
    jsonb_build_object(
      'jobIds', jsonb_build_array(v_job.id),
      'jobNumbers', jsonb_build_array(v_job.job_number),
      'caulkProductWarehousePairs',
      jsonb_build_array(jsonb_build_object('productId', v_product.id, 'warehouse', v_warehouse))
    )
  );
  v_warnings := v_warnings || coalesce(v_planner_result->'warnings', '[]'::jsonb);

  return jsonb_build_object(
    'jobId', v_job.id::text,
    'jobNumber', v_job.job_number,
    'caulkAllocationId', v_allocation_id,
    'warnings', v_warnings
  );
end;
$$;

create or replace function public.api_acl_owner_companies_list(
  p_org_id uuid,
  p_include_inactive boolean default false
)
returns setof app.owner_companies
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'read');

  return query
  select *
  from app.owner_companies oc
  where oc.org_id = p_org_id
    and (p_include_inactive or oc.is_active)
  order by oc.is_active desc, oc.code asc;
end;
$$;

create or replace function public.api_acl_owner_companies_upsert(
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
  v_code text := upper(regexp_replace(app_api.trim_text(p_payload->>'code'), '[^A-Za-z0-9]+', '', 'g'));
  v_display_name text := app_api.trim_text(coalesce(p_payload->>'displayName', ''));
  v_row app.owner_companies;
begin
  perform app_api.require_org_owner(p_org_id);

  if v_code = '' then
    perform app_api.raise_http(400, 'Owner code is required.');
  end if;
  if length(v_code) > 16 then
    perform app_api.raise_http(400, 'Owner code must be 16 characters or fewer.');
  end if;
  if v_display_name = '' then
    v_display_name := v_code;
  end if;

  insert into app.owner_companies (org_id, code, display_name, is_active, created_by, updated_by)
  values (p_org_id, v_code, v_display_name, true, app_api.trim_text(p_actor), app_api.trim_text(p_actor))
  on conflict (org_id, lookup_key) do update set
    code = excluded.code,
    display_name = excluded.display_name,
    is_active = true,
    deactivated_at = null,
    deactivated_by = '',
    updated_at = now(),
    updated_by = excluded.updated_by
  returning * into v_row;

  return to_jsonb(v_row);
end;
$$;

create or replace function public.api_acl_owner_companies_deactivate(
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
  v_owner_id uuid := nullif(app_api.trim_text(p_payload->>'ownerCompanyId'), '')::uuid;
  v_row app.owner_companies;
begin
  perform app_api.require_org_owner(p_org_id);

  update app.owner_companies oc
  set is_active = false,
      deactivated_at = now(),
      deactivated_by = app_api.trim_text(p_actor),
      updated_at = now(),
      updated_by = app_api.trim_text(p_actor)
  where oc.org_id = p_org_id
    and oc.id = v_owner_id
  returning * into v_row;

  if v_row.id is null then
    perform app_api.raise_http(404, 'Owner company was not found.');
  end if;

  return to_jsonb(v_row);
end;
$$;

create or replace function public.api_acl_inventory_ownership_update_box(
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
  v_box_id text := upper(app_api.trim_text(p_payload->>'boxId'));
  v_owner_id uuid := nullif(app_api.trim_text(p_payload->>'ownerCompanyId'), '')::uuid;
  v_note text := app_api.trim_text(coalesce(p_payload->>'note', ''));
  v_before app.boxes;
  v_after app.boxes;
  v_old_owner app.owner_companies;
  v_new_owner app.owner_companies;
  v_event app.inventory_ownership_events;
begin
  perform app_api.require_org_owner(p_org_id);
  v_new_owner := app_api.require_owner_company(p_org_id, v_owner_id, true);

  select *
  into v_before
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = v_box_id
  for update;

  if not found then
    perform app_api.raise_http(404, 'Box not found.');
  end if;

  v_old_owner := app_api.require_owner_company(p_org_id, v_before.owner_company_id, false);
  if v_old_owner.id = v_new_owner.id then
    return jsonb_build_object('changedCount', 0, 'events', '[]'::jsonb);
  end if;

  update app.boxes b
  set owner_company_id = v_new_owner.id
  where b.org_id = p_org_id
    and b.box_id = v_box_id
  returning * into v_after;

  insert into app.inventory_ownership_events (
    org_id,
    resource_type,
    resource_id,
    resource_label,
    old_owner_company_id,
    old_owner_code,
    old_owner_display_name,
    new_owner_company_id,
    new_owner_code,
    new_owner_display_name,
    actor,
    note,
    batch_id
  )
  values (
    p_org_id,
    'film_box',
    v_after.box_id,
    v_after.box_id,
    v_old_owner.id,
    v_old_owner.code,
    v_old_owner.display_name,
    v_new_owner.id,
    v_new_owner.code,
    v_new_owner.display_name,
    app_api.trim_text(p_actor),
    v_note,
    coalesce(nullif(app_api.trim_text(p_payload->>'batchId'), ''), gen_random_uuid()::text)
  )
  returning * into v_event;

  perform app_api.append_audit_entry(
    p_org_id,
    'OWNER_CHANGE',
    v_after.box_id,
    app_api.public_box_json(v_before),
    app_api.public_box_json(v_after),
    p_actor,
    coalesce(nullif(v_note, ''), format('Changed owner from %s to %s.', v_old_owner.code, v_new_owner.code))
  );

  return jsonb_build_object(
    'changedCount', 1,
    'batchId', v_event.batch_id,
    'events', jsonb_build_array(to_jsonb(v_event))
  );
end;
$$;

create or replace function public.api_acl_inventory_ownership_update_caulk_stock(
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
  v_stock_id uuid := nullif(app_api.trim_text(p_payload->>'stockId'), '')::uuid;
  v_owner_id uuid := nullif(app_api.trim_text(p_payload->>'ownerCompanyId'), '')::uuid;
  v_note text := app_api.trim_text(coalesce(p_payload->>'note', ''));
  v_stock app.caulk_stock;
  v_target app.caulk_stock;
  v_old_owner app.owner_companies;
  v_new_owner app.owner_companies;
  v_event app.inventory_ownership_events;
begin
  perform app_api.require_org_owner(p_org_id);
  v_new_owner := app_api.require_owner_company(p_org_id, v_owner_id, true);

  select *
  into v_stock
  from app.caulk_stock s
  where s.org_id = p_org_id
    and s.id = v_stock_id
  for update;

  if not found then
    perform app_api.raise_http(404, 'Caulk stock row was not found.');
  end if;

  v_old_owner := app_api.require_owner_company(p_org_id, v_stock.owner_company_id, false);
  if v_old_owner.id = v_new_owner.id then
    return jsonb_build_object('changedCount', 0, 'events', '[]'::jsonb);
  end if;

  select *
  into v_target
  from app.caulk_stock s
  where s.org_id = p_org_id
    and s.product_id = v_stock.product_id
    and s.warehouse = v_stock.warehouse
    and s.owner_company_id = v_new_owner.id
    and s.id <> v_stock.id
  for update;

  if v_target.id is not null then
    update app.caulk_stock
    set tubes_on_hand = tubes_on_hand + v_stock.tubes_on_hand,
        updated_at = now(),
        updated_by = app_api.trim_text(p_actor)
    where org_id = p_org_id
      and id = v_target.id;

    delete from app.caulk_stock
    where org_id = p_org_id
      and id = v_stock.id;
  else
    update app.caulk_stock
    set owner_company_id = v_new_owner.id,
        updated_at = now(),
        updated_by = app_api.trim_text(p_actor)
    where org_id = p_org_id
      and id = v_stock.id;
  end if;

  insert into app.inventory_ownership_events (
    org_id,
    resource_type,
    resource_id,
    resource_label,
    old_owner_company_id,
    old_owner_code,
    old_owner_display_name,
    new_owner_company_id,
    new_owner_code,
    new_owner_display_name,
    actor,
    note,
    batch_id
  )
  values (
    p_org_id,
    'caulk_stock',
    v_stock.id::text,
    v_stock.warehouse,
    v_old_owner.id,
    v_old_owner.code,
    v_old_owner.display_name,
    v_new_owner.id,
    v_new_owner.code,
    v_new_owner.display_name,
    app_api.trim_text(p_actor),
    v_note,
    coalesce(nullif(app_api.trim_text(p_payload->>'batchId'), ''), gen_random_uuid()::text)
  )
  returning * into v_event;

  return jsonb_build_object(
    'changedCount', 1,
    'batchId', v_event.batch_id,
    'events', jsonb_build_array(to_jsonb(v_event))
  );
end;
$$;

create or replace function public.api_acl_inventory_ownership_bulk_transfer(
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
  v_owner_id uuid := nullif(app_api.trim_text(p_payload->>'ownerCompanyId'), '')::uuid;
  v_note text := app_api.trim_text(coalesce(p_payload->>'note', ''));
  v_batch_id text := gen_random_uuid()::text;
  v_box_id text;
  v_stock_id text;
  v_result jsonb;
  v_events jsonb := '[]'::jsonb;
  v_changed integer := 0;
begin
  perform app_api.require_org_owner(p_org_id);
  perform app_api.require_owner_company(p_org_id, v_owner_id, true);

  for v_box_id in select jsonb_array_elements_text(coalesce(p_payload->'filmBoxIds', '[]'::jsonb)) loop
    v_result := public.api_acl_inventory_ownership_update_box(
      p_org_id,
      p_actor,
      jsonb_build_object('boxId', v_box_id, 'ownerCompanyId', v_owner_id, 'note', v_note, 'batchId', v_batch_id)
    );
    v_changed := v_changed + coalesce((v_result->>'changedCount')::integer, 0);
    v_events := v_events || coalesce(v_result->'events', '[]'::jsonb);
  end loop;

  for v_stock_id in select jsonb_array_elements_text(coalesce(p_payload->'caulkStockIds', '[]'::jsonb)) loop
    v_result := public.api_acl_inventory_ownership_update_caulk_stock(
      p_org_id,
      p_actor,
      jsonb_build_object('stockId', v_stock_id, 'ownerCompanyId', v_owner_id, 'note', v_note, 'batchId', v_batch_id)
    );
    v_changed := v_changed + coalesce((v_result->>'changedCount')::integer, 0);
    v_events := v_events || coalesce(v_result->'events', '[]'::jsonb);
  end loop;

  if v_changed = 0 and jsonb_array_length(coalesce(p_payload->'filmBoxIds', '[]'::jsonb)) = 0 and jsonb_array_length(coalesce(p_payload->'caulkStockIds', '[]'::jsonb)) = 0 then
    perform app_api.raise_http(400, 'Select at least one exact film box or caulk stock row.');
  end if;

  return jsonb_build_object('changedCount', v_changed, 'batchId', v_batch_id, 'events', v_events);
end;
$$;

select app_api.grant_execute_if_exists('public.api_acl_list_caulk_stock(uuid, text, text, text, uuid, uuid, uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_caulk_transactions(uuid, text, uuid, integer)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_caulk_transfers(uuid, text, uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_caulk_upsert_product(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_caulk_mutate_stock(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_caulk_transfer_stock(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_add(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_caulk_stock(uuid, text, text, text, uuid, uuid, uuid)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_list_caulk_transactions(uuid, text, uuid, integer)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_list_caulk_transfers(uuid, text, uuid)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_caulk_upsert_product(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_caulk_mutate_stock(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_caulk_transfer_stock(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_allocations_caulk_add(uuid, text, jsonb)', 'service_role');

select app_api.grant_execute_if_exists('public.api_acl_owner_companies_list(uuid, boolean)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_owner_companies_upsert(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_owner_companies_deactivate(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_inventory_ownership_update_box(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_inventory_ownership_update_caulk_stock(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_inventory_ownership_bulk_transfer(uuid, text, jsonb)', 'authenticated');

revoke execute on function public.api_acl_owner_companies_list(uuid, boolean) from anon, public, service_role;
revoke execute on function public.api_acl_owner_companies_upsert(uuid, text, jsonb) from anon, public, service_role;
revoke execute on function public.api_acl_owner_companies_deactivate(uuid, text, jsonb) from anon, public, service_role;
revoke execute on function public.api_acl_inventory_ownership_update_box(uuid, text, jsonb) from anon, public, service_role;
revoke execute on function public.api_acl_inventory_ownership_update_caulk_stock(uuid, text, jsonb) from anon, public, service_role;
revoke execute on function public.api_acl_inventory_ownership_bulk_transfer(uuid, text, jsonb) from anon, public, service_role;
