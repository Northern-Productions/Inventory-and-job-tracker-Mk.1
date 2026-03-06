-- Supabase/Postgres schema starter for replacing Apps Script + Google Sheets
-- Run this in Supabase SQL Editor.

create extension if not exists pgcrypto;
create schema if not exists app;

create type app.warehouse as enum ('IL', 'MS');
create type app.box_status as enum ('ORDERED', 'IN_STOCK', 'CHECKED_OUT', 'ZEROED', 'RETIRED');
create type app.allocation_status as enum ('ACTIVE', 'FULFILLED', 'CANCELLED');
create type app.film_order_status as enum ('FILM_ORDER', 'FILM_ON_THE_WAY', 'FULFILLED', 'CANCELLED');
create type app.job_lifecycle_status as enum ('ACTIVE', 'CANCELLED');

create table if not exists app.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists app.organization_members (
  org_id uuid not null references app.organizations(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create table if not exists app.film_catalog (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations(id) on delete cascade,
  film_key text not null,
  manufacturer text not null,
  film_name text not null,
  sq_ft_weight_lbs_per_sq_ft numeric(12,8),
  default_core_type text,
  source_width_in numeric(10,4),
  source_initial_feet integer,
  source_initial_weight_lbs numeric(12,2),
  source_box_id text,
  notes text not null default '',
  updated_at timestamptz not null default now(),
  unique (org_id, film_key)
);

create table if not exists app.boxes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations(id) on delete cascade,
  box_id text not null,
  warehouse app.warehouse not null,
  manufacturer text not null,
  film_name text not null,
  width_in numeric(10,4) not null check (width_in > 0),
  initial_feet integer not null check (initial_feet >= 0),
  feet_available integer not null check (feet_available >= 0),
  lot_run text not null default '',
  status app.box_status not null,
  order_date date not null,
  received_date date,
  initial_weight_lbs numeric(12,2),
  last_roll_weight_lbs numeric(12,2),
  last_weighed_date date,
  film_key text not null,
  core_type text not null default '',
  core_weight_lbs numeric(12,4),
  lf_weight_lbs_per_ft numeric(12,6),
  purchase_cost numeric(12,2),
  notes text not null default '',
  has_ever_been_checked_out boolean not null default false,
  last_checkout_job text not null default '',
  last_checkout_date date,
  zeroed_date date,
  zeroed_reason text not null default '',
  zeroed_by text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, box_id),
  check (feet_available <= initial_feet)
);

create table if not exists app.jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations(id) on delete cascade,
  job_number text not null,
  warehouse app.warehouse not null,
  sections text,
  due_date date,
  lifecycle_status app.job_lifecycle_status not null default 'ACTIVE',
  notes text not null default '',
  created_at timestamptz not null default now(),
  created_by text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text not null default '',
  unique (org_id, job_number)
);

create table if not exists app.job_requirements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations(id) on delete cascade,
  job_id uuid not null references app.jobs(id) on delete cascade,
  manufacturer text not null,
  film_name text not null,
  width_in numeric(10,4) not null check (width_in > 0),
  required_feet integer not null check (required_feet > 0),
  notes text not null default '',
  created_at timestamptz not null default now(),
  created_by text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text not null default ''
);

create table if not exists app.film_orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations(id) on delete cascade,
  film_order_id text not null,
  job_id uuid references app.jobs(id) on delete set null,
  job_number text not null,
  warehouse app.warehouse not null,
  manufacturer text not null,
  film_name text not null,
  width_in numeric(10,4) not null check (width_in > 0),
  requested_feet integer not null check (requested_feet >= 0),
  covered_feet integer not null default 0 check (covered_feet >= 0),
  ordered_feet integer not null default 0 check (ordered_feet >= 0),
  remaining_to_order_feet integer not null default 0 check (remaining_to_order_feet >= 0),
  job_date date,
  crew_leader text not null default '',
  status app.film_order_status not null,
  source_box_id text not null default '',
  resolved_at timestamptz,
  resolved_by text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now(),
  created_by text not null default '',
  unique (org_id, film_order_id)
);

create table if not exists app.allocations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations(id) on delete cascade,
  allocation_id text not null,
  box_id text not null,
  job_id uuid references app.jobs(id) on delete set null,
  job_number text not null,
  warehouse app.warehouse not null,
  job_date date,
  allocated_feet integer not null check (allocated_feet > 0),
  status app.allocation_status not null,
  created_at timestamptz not null default now(),
  created_by text not null default '',
  resolved_at timestamptz,
  resolved_by text not null default '',
  notes text not null default '',
  crew_leader text not null default '',
  film_order_id text not null default '',
  unique (org_id, allocation_id)
);

create table if not exists app.film_order_box_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations(id) on delete cascade,
  link_id text not null,
  film_order_id text not null,
  box_id text not null,
  ordered_feet integer not null check (ordered_feet >= 0),
  auto_allocated_feet integer not null default 0 check (auto_allocated_feet >= 0),
  created_at timestamptz not null default now(),
  created_by text not null default '',
  unique (org_id, link_id)
);

create table if not exists app.audit_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations(id) on delete cascade,
  log_id text not null,
  action text not null,
  box_id text not null,
  before_state jsonb,
  after_state jsonb,
  actor text not null,
  notes text not null default '',
  created_at timestamptz not null default now(),
  unique (org_id, log_id)
);

create table if not exists app.roll_weight_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations(id) on delete cascade,
  log_id text not null,
  box_id text not null,
  warehouse app.warehouse not null,
  manufacturer text not null,
  film_name text not null,
  width_in numeric(10,4) not null,
  job_number text not null default '',
  checked_out_at timestamptz,
  checked_out_by text not null default '',
  checked_out_weight_lbs numeric(12,2),
  checked_in_at timestamptz,
  checked_in_by text not null default '',
  checked_in_weight_lbs numeric(12,2),
  weight_delta_lbs numeric(12,2),
  feet_before integer not null default 0,
  feet_after integer not null default 0,
  notes text not null default '',
  unique (org_id, log_id)
);

create index if not exists idx_boxes_org_warehouse_status on app.boxes (org_id, warehouse, status);
create index if not exists idx_boxes_org_film on app.boxes (org_id, manufacturer, film_name, width_in);
create index if not exists idx_boxes_org_updated_at on app.boxes (org_id, updated_at desc);
create index if not exists idx_allocations_org_job_number on app.allocations (org_id, job_number);
create index if not exists idx_allocations_org_box_id on app.allocations (org_id, box_id);
create index if not exists idx_allocations_org_film_order_id on app.allocations (org_id, film_order_id);
create index if not exists idx_film_orders_org_job_number on app.film_orders (org_id, job_number);
create index if not exists idx_film_orders_org_status on app.film_orders (org_id, status);
create index if not exists idx_film_order_links_org_film_order_id on app.film_order_box_links (org_id, film_order_id);
create index if not exists idx_jobs_org_due_date on app.jobs (org_id, due_date desc);
create index if not exists idx_requirements_org_job_id on app.job_requirements (org_id, job_id);
create index if not exists idx_audit_log_org_created_at on app.audit_log (org_id, created_at desc);
create index if not exists idx_roll_weight_org_box_id on app.roll_weight_log (org_id, box_id);

create or replace function app.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_boxes_set_updated_at on app.boxes;
create trigger trg_boxes_set_updated_at
before update on app.boxes
for each row
execute function app.set_updated_at();

drop trigger if exists trg_jobs_set_updated_at on app.jobs;
create trigger trg_jobs_set_updated_at
before update on app.jobs
for each row
execute function app.set_updated_at();

drop trigger if exists trg_job_requirements_set_updated_at on app.job_requirements;
create trigger trg_job_requirements_set_updated_at
before update on app.job_requirements
for each row
execute function app.set_updated_at();

create or replace function app.is_org_member(target_org_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from app.organization_members m
    where m.org_id = target_org_id
      and m.user_id = auth.uid()
  );
$$;

alter table app.organizations enable row level security;
alter table app.organization_members enable row level security;
alter table app.film_catalog enable row level security;
alter table app.boxes enable row level security;
alter table app.jobs enable row level security;
alter table app.job_requirements enable row level security;
alter table app.film_orders enable row level security;
alter table app.allocations enable row level security;
alter table app.film_order_box_links enable row level security;
alter table app.audit_log enable row level security;
alter table app.roll_weight_log enable row level security;

create policy orgs_read on app.organizations
for select using (app.is_org_member(id));

create policy members_read on app.organization_members
for select using (app.is_org_member(org_id));
create policy members_write on app.organization_members
for all using (app.is_org_member(org_id)) with check (app.is_org_member(org_id));

create policy film_catalog_rw on app.film_catalog
for all using (app.is_org_member(org_id)) with check (app.is_org_member(org_id));

create policy boxes_rw on app.boxes
for all using (app.is_org_member(org_id)) with check (app.is_org_member(org_id));

create policy jobs_rw on app.jobs
for all using (app.is_org_member(org_id)) with check (app.is_org_member(org_id));

create policy requirements_rw on app.job_requirements
for all using (app.is_org_member(org_id)) with check (app.is_org_member(org_id));

create policy film_orders_rw on app.film_orders
for all using (app.is_org_member(org_id)) with check (app.is_org_member(org_id));

create policy allocations_rw on app.allocations
for all using (app.is_org_member(org_id)) with check (app.is_org_member(org_id));

create policy film_order_links_rw on app.film_order_box_links
for all using (app.is_org_member(org_id)) with check (app.is_org_member(org_id));

create policy audit_log_rw on app.audit_log
for all using (app.is_org_member(org_id)) with check (app.is_org_member(org_id));

create policy roll_weight_rw on app.roll_weight_log
for all using (app.is_org_member(org_id)) with check (app.is_org_member(org_id));
