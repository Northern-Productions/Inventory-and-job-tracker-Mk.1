-- Dedicated caulk inventory subsystem (separate from film boxes).
-- Supports warehouse-level stock in tubes with case conversion metadata.

create table if not exists app.caulk_manufacturers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations(id) on delete cascade,
  name text not null,
  lookup_key text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text not null default '',
  unique (org_id, lookup_key)
);

alter table app.caulk_manufacturers
  drop constraint if exists caulk_manufacturers_name_not_blank;
alter table app.caulk_manufacturers
  add constraint caulk_manufacturers_name_not_blank
  check (btrim(name) <> '' and btrim(lookup_key) <> '' and lookup_key = lower(lookup_key));

create index if not exists idx_caulk_manufacturers_org_name_ci
  on app.caulk_manufacturers (org_id, lower(name));

create table if not exists app.caulk_products (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations(id) on delete cascade,
  manufacturer_id uuid not null references app.caulk_manufacturers(id) on delete restrict,
  name text not null,
  code text not null default '',
  lookup_key text not null,
  tubes_per_case integer not null default 16,
  is_active boolean not null default true,
  notes text not null default '',
  created_at timestamptz not null default now(),
  created_by text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text not null default '',
  unique (org_id, manufacturer_id, lookup_key)
);

alter table app.caulk_products
  drop constraint if exists caulk_products_name_not_blank;
alter table app.caulk_products
  add constraint caulk_products_name_not_blank
  check (btrim(name) <> '' and btrim(lookup_key) <> '' and lookup_key = lower(lookup_key));

alter table app.caulk_products
  drop constraint if exists caulk_products_tubes_per_case_positive;
alter table app.caulk_products
  add constraint caulk_products_tubes_per_case_positive
  check (tubes_per_case > 0);

create unique index if not exists idx_caulk_products_org_id_pair
  on app.caulk_products (org_id, id);

create index if not exists idx_caulk_products_org_manufacturer
  on app.caulk_products (org_id, manufacturer_id, lower(name));

create table if not exists app.caulk_stock (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  product_id uuid not null,
  warehouse text not null,
  tubes_on_hand integer not null default 0,
  updated_at timestamptz not null default now(),
  updated_by text not null default '',
  unique (org_id, product_id, warehouse),
  foreign key (org_id, product_id) references app.caulk_products(org_id, id) on delete cascade,
  foreign key (org_id, warehouse) references app.warehouses(org_id, code) on delete restrict
);

alter table app.caulk_stock
  drop constraint if exists caulk_stock_tubes_non_negative;
alter table app.caulk_stock
  add constraint caulk_stock_tubes_non_negative
  check (tubes_on_hand >= 0);

create index if not exists idx_caulk_stock_org_warehouse
  on app.caulk_stock (org_id, warehouse);

create table if not exists app.caulk_transactions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations(id) on delete cascade,
  transaction_id text not null,
  product_id uuid not null,
  warehouse text not null,
  action text not null,
  delta_tubes integer not null,
  resulting_tubes_on_hand integer not null,
  tubes_per_case integer not null,
  reason text not null default '',
  notes text not null default '',
  transfer_id text not null default '',
  source_box_id text not null default '',
  created_at timestamptz not null default now(),
  created_by text not null default '',
  unique (org_id, transaction_id),
  foreign key (org_id, product_id) references app.caulk_products(org_id, id) on delete restrict,
  foreign key (org_id, warehouse) references app.warehouses(org_id, code) on delete restrict
);

alter table app.caulk_transactions
  drop constraint if exists caulk_transactions_action_valid;
alter table app.caulk_transactions
  add constraint caulk_transactions_action_valid
  check (action in ('RECEIVE', 'USE', 'ADJUST', 'TRANSFER_OUT', 'TRANSFER_IN', 'BACKFILL_MIGRATE'));

alter table app.caulk_transactions
  drop constraint if exists caulk_transactions_result_non_negative;
alter table app.caulk_transactions
  add constraint caulk_transactions_result_non_negative
  check (resulting_tubes_on_hand >= 0 and tubes_per_case > 0);

create index if not exists idx_caulk_transactions_org_created
  on app.caulk_transactions (org_id, created_at desc);

create index if not exists idx_caulk_transactions_org_product
  on app.caulk_transactions (org_id, product_id, created_at desc);

create table if not exists app.caulk_backfill_map (
  org_id uuid not null references app.organizations(id) on delete cascade,
  source_box_id text not null,
  product_id uuid not null,
  warehouse text not null,
  transaction_id text not null,
  migrated_at timestamptz not null default now(),
  migrated_by text not null default '',
  notes text not null default '',
  primary key (org_id, source_box_id),
  foreign key (org_id, product_id) references app.caulk_products(org_id, id) on delete restrict,
  foreign key (org_id, warehouse) references app.warehouses(org_id, code) on delete restrict
);

create index if not exists idx_caulk_backfill_org_product
  on app.caulk_backfill_map (org_id, product_id, migrated_at desc);

create or replace function app_api.normalize_caulk_label(p_value text)
returns text
language sql
immutable
as $$
  select app_api.normalize_collapsed_catalog_label(p_value);
$$;

create or replace function app_api.normalize_caulk_lookup_key(p_value text)
returns text
language sql
immutable
as $$
  select lower(app_api.normalize_caulk_label(p_value));
$$;

create or replace function app_api.caulk_create_transaction_id()
returns text
language sql
volatile
as $$
  select to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || '-' || substr(encode(gen_random_bytes(2), 'hex'), 1, 4);
$$;

create or replace function app_api.caulk_require_warehouse(
  p_org_id uuid,
  p_warehouse text
)
returns text
language plpgsql
stable
security definer
set search_path = public, app, app_api
as $$
declare
  v_warehouse text := app_api.normalize_indexed_warehouse_code(p_warehouse, 'Warehouse');
begin
  if not exists (
    select 1
    from app.warehouses w
    where w.org_id = p_org_id
      and w.code = v_warehouse
  ) then
    perform app_api.raise_http(400, format('Warehouse %s was not found for this organization.', v_warehouse));
  end if;

  return v_warehouse;
end;
$$;

create or replace function app_api.caulk_upsert_manufacturer(
  p_org_id uuid,
  p_actor text,
  p_name text,
  p_is_active boolean default true
)
returns app.caulk_manufacturers
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_name text := app_api.normalize_caulk_label(p_name);
  v_lookup_key text := app_api.normalize_caulk_lookup_key(p_name);
  v_actor text := app_api.trim_text(p_actor);
  v_row app.caulk_manufacturers;
begin
  if v_name = '' then
    perform app_api.raise_http(400, 'Manufacturer name is required.');
  end if;

  insert into app.caulk_manufacturers (
    org_id,
    name,
    lookup_key,
    is_active,
    created_by,
    updated_by
  )
  values (
    p_org_id,
    v_name,
    v_lookup_key,
    coalesce(p_is_active, true),
    v_actor,
    v_actor
  )
  on conflict (org_id, lookup_key) do update set
    name = excluded.name,
    is_active = excluded.is_active,
    updated_at = now(),
    updated_by = excluded.updated_by
  returning *
  into v_row;

  return v_row;
end;
$$;

create or replace function app_api.caulk_upsert_product(
  p_org_id uuid,
  p_actor text,
  p_product_id uuid,
  p_manufacturer_id uuid,
  p_name text,
  p_code text,
  p_tubes_per_case integer,
  p_is_active boolean,
  p_notes text
)
returns app.caulk_products
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_name text := app_api.normalize_caulk_label(p_name);
  v_code text := app_api.normalize_caulk_label(p_code);
  v_lookup_key text := app_api.normalize_caulk_lookup_key(
    case
      when app_api.normalize_caulk_label(p_code) = '' then app_api.normalize_caulk_label(p_name)
      else app_api.normalize_caulk_label(p_name) || ' ' || app_api.normalize_caulk_label(p_code)
    end
  );
  v_actor text := app_api.trim_text(p_actor);
  v_row app.caulk_products;
begin
  if v_name = '' then
    perform app_api.raise_http(400, 'Product name is required.');
  end if;

  if p_tubes_per_case is null or p_tubes_per_case <= 0 then
    perform app_api.raise_http(400, 'TubesPerCase must be greater than zero.');
  end if;

  if not exists (
    select 1
    from app.caulk_manufacturers m
    where m.org_id = p_org_id
      and m.id = p_manufacturer_id
  ) then
    perform app_api.raise_http(400, 'Manufacturer was not found for this organization.');
  end if;

  if p_product_id is not null then
    update app.caulk_products p
    set
      manufacturer_id = p_manufacturer_id,
      name = v_name,
      code = v_code,
      lookup_key = v_lookup_key,
      tubes_per_case = p_tubes_per_case,
      is_active = coalesce(p_is_active, p.is_active),
      notes = app_api.trim_text(coalesce(p_notes, p.notes)),
      updated_at = now(),
      updated_by = v_actor
    where p.org_id = p_org_id
      and p.id = p_product_id
    returning *
    into v_row;

    if found then
      return v_row;
    end if;
  end if;

  insert into app.caulk_products (
    org_id,
    manufacturer_id,
    name,
    code,
    lookup_key,
    tubes_per_case,
    is_active,
    notes,
    created_by,
    updated_by
  )
  values (
    p_org_id,
    p_manufacturer_id,
    v_name,
    v_code,
    v_lookup_key,
    p_tubes_per_case,
    coalesce(p_is_active, true),
    app_api.trim_text(p_notes),
    v_actor,
    v_actor
  )
  on conflict (org_id, manufacturer_id, lookup_key) do update set
    tubes_per_case = excluded.tubes_per_case,
    is_active = excluded.is_active,
    notes = excluded.notes,
    updated_at = now(),
    updated_by = excluded.updated_by
  returning *
  into v_row;

  return v_row;
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

  if v_action not in ('RECEIVE', 'USE', 'ADJUST', 'TRANSFER_OUT', 'TRANSFER_IN', 'BACKFILL_MIGRATE') then
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

create or replace function public.api_acl_list_caulk_manufacturers(p_org_id uuid)
returns table (
  manufacturer_id uuid,
  name text,
  lookup_key text,
  is_active boolean,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'read');

  return query
  select
    m.id,
    m.name,
    m.lookup_key,
    m.is_active,
    m.updated_at
  from app.caulk_manufacturers m
  where m.org_id = p_org_id
  order by lower(m.name);
end;
$$;

create or replace function public.api_acl_list_caulk_products(p_org_id uuid)
returns table (
  product_id uuid,
  manufacturer_id uuid,
  manufacturer text,
  product_name text,
  product_code text,
  lookup_key text,
  tubes_per_case integer,
  is_active boolean,
  notes text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'read');

  return query
  select
    p.id,
    p.manufacturer_id,
    m.name,
    p.name,
    p.code,
    p.lookup_key,
    p.tubes_per_case,
    p.is_active,
    p.notes,
    p.updated_at
  from app.caulk_products p
  join app.caulk_manufacturers m
    on m.org_id = p.org_id
   and m.id = p.manufacturer_id
  where p.org_id = p_org_id
  order by lower(m.name), lower(p.name), lower(p.code);
end;
$$;

create or replace function public.api_acl_list_caulk_stock(
  p_org_id uuid,
  p_warehouse text default '',
  p_manufacturer text default '',
  p_q text default ''
)
returns table (
  warehouse text,
  product_id uuid,
  manufacturer_id uuid,
  manufacturer text,
  product_name text,
  product_code text,
  tubes_per_case integer,
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
    s.warehouse,
    p.id,
    p.manufacturer_id,
    m.name,
    p.name,
    p.code,
    p.tubes_per_case,
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
  where s.org_id = p_org_id
    and (v_warehouse = '' or v_warehouse = 'ALL' or s.warehouse = v_warehouse)
    and (v_manufacturer_lookup = '' or m.lookup_key = v_manufacturer_lookup)
    and (
      v_q = ''
      or app_api.normalize_caulk_lookup_key(p.name) like ('%' || v_q || '%')
      or app_api.normalize_caulk_lookup_key(p.code) like ('%' || v_q || '%')
      or app_api.normalize_caulk_lookup_key(m.name) like ('%' || v_q || '%')
    )
  order by s.warehouse, lower(m.name), lower(p.name), lower(p.code);
end;
$$;

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
    m.name,
    p.name,
    p.code,
    t.action,
    t.delta_tubes,
    t.resulting_tubes_on_hand,
    t.tubes_per_case,
    t.reason,
    t.notes,
    t.transfer_id,
    t.source_box_id,
    t.created_at,
    t.created_by
  from app.caulk_transactions t
  join app.caulk_products p
    on p.org_id = t.org_id
   and p.id = t.product_id
  join app.caulk_manufacturers m
    on m.org_id = p.org_id
   and m.id = p.manufacturer_id
  where t.org_id = p_org_id
    and (v_warehouse = '' or v_warehouse = 'ALL' or t.warehouse = v_warehouse)
    and (p_product_id is null or t.product_id = p_product_id)
  order by t.created_at desc
  limit v_limit;
end;
$$;

create or replace function public.api_acl_owner_upsert_caulk_manufacturer(
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
  v_name text := app_api.normalize_caulk_label(p_payload->>'name');
  v_is_active boolean := coalesce((p_payload->>'isActive')::boolean, true);
  v_row app.caulk_manufacturers;
begin
  perform app_api.require_org_owner(p_org_id);

  if v_name = '' then
    perform app_api.raise_http(400, 'Manufacturer name is required.');
  end if;

  v_row := app_api.caulk_upsert_manufacturer(p_org_id, p_actor, v_name, v_is_active);

  return jsonb_build_object(
    'manufacturerId', v_row.id,
    'name', v_row.name,
    'lookupKey', v_row.lookup_key,
    'isActive', v_row.is_active,
    'updatedAt', v_row.updated_at
  );
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
  v_cases integer := coalesce(nullif(app_api.trim_text(p_payload->>'cases'), '')::integer, 0);
  v_tubes integer := coalesce(nullif(app_api.trim_text(p_payload->>'tubes'), '')::integer, 0);
  v_delta_override integer := nullif(app_api.trim_text(p_payload->>'deltaTubes'), '')::integer;
  v_reason text := coalesce(p_payload->>'reason', v_action);
  v_notes text := coalesce(p_payload->>'notes', '');
  v_tubes_per_case integer;
  v_delta integer;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');

  if v_product_id is null then
    perform app_api.raise_http(400, 'ProductId is required.');
  end if;

  if v_action not in ('RECEIVE', 'USE', 'ADJUST') then
    perform app_api.raise_http(400, 'Action must be RECEIVE, USE, or ADJUST.');
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

  if v_action = 'RECEIVE' then
    if v_delta <= 0 then
      perform app_api.raise_http(400, 'Receive requires a positive quantity.');
    end if;
    return app_api.caulk_apply_stock_delta(
      p_org_id,
      p_actor,
      v_product_id,
      v_warehouse,
      'RECEIVE',
      v_delta,
      v_reason,
      '',
      '',
      v_notes
    );
  end if;

  if v_action = 'USE' then
    if v_delta <= 0 then
      perform app_api.raise_http(400, 'Use requires a positive quantity.');
    end if;
    return app_api.caulk_apply_stock_delta(
      p_org_id,
      p_actor,
      v_product_id,
      v_warehouse,
      'USE',
      -v_delta,
      v_reason,
      '',
      '',
      v_notes
    );
  end if;

  if v_delta = 0 then
    perform app_api.raise_http(400, 'Adjust requires a non-zero delta.');
  end if;

  return app_api.caulk_apply_stock_delta(
    p_org_id,
    p_actor,
    v_product_id,
    v_warehouse,
    'ADJUST',
    v_delta,
    v_reason,
    '',
    '',
    v_notes
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

  v_out := app_api.caulk_apply_stock_delta(
    p_org_id,
    p_actor,
    v_product_id,
    v_from_code,
    'TRANSFER_OUT',
    -v_delta,
    v_reason,
    v_transfer_id,
    '',
    v_notes
  );

  v_in := app_api.caulk_apply_stock_delta(
    p_org_id,
    p_actor,
    v_product_id,
    v_to_code,
    'TRANSFER_IN',
    v_delta,
    v_reason,
    v_transfer_id,
    '',
    v_notes
  );

  return jsonb_build_object(
    'transferId', v_transfer_id,
    'movedTubes', v_delta,
    'from', v_out,
    'to', v_in
  );
end;
$$;

select app_api.grant_execute_if_exists('public.api_acl_list_caulk_manufacturers(uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_caulk_products(uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_caulk_stock(uuid, text, text, text)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_caulk_transactions(uuid, text, uuid, integer)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_owner_upsert_caulk_manufacturer(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_caulk_upsert_product(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_caulk_mutate_stock(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_caulk_transfer_stock(uuid, text, jsonb)', 'authenticated');

select app_api.grant_execute_if_exists('public.api_acl_list_caulk_manufacturers(uuid)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_list_caulk_products(uuid)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_list_caulk_stock(uuid, text, text, text)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_list_caulk_transactions(uuid, text, uuid, integer)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_owner_upsert_caulk_manufacturer(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_caulk_upsert_product(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_caulk_mutate_stock(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_caulk_transfer_stock(uuid, text, jsonb)', 'service_role');
