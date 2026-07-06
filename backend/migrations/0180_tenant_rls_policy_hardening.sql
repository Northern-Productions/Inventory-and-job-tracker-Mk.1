-- Tenant RLS policy hardening.
-- Keep tenant table access behind RLS/RPCs, fix ambiguous owner policies, and
-- leave service_role/admin RPC workflows intact.

create or replace function app.is_org_owner(target_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = app, public
as $$
  select exists (
    select 1
    from app.organization_members member_row
    where member_row.org_id = target_org_id
      and member_row.user_id = auth.uid()
      and member_row.role = 'owner'
  );
$$;

revoke all on function app.is_org_owner(uuid) from public;
grant execute on function app.is_org_owner(uuid) to authenticated, service_role;

drop policy if exists members_write_owner on app.organization_members;
create policy members_write_owner on app.organization_members
for all
using (app.is_org_owner(org_id))
with check (app.is_org_owner(org_id));

drop policy if exists owner_notification_preferences_write_self on app.owner_notification_preferences;
create policy owner_notification_preferences_write_self on app.owner_notification_preferences
for update
using (
  owner_user_id = auth.uid()
  and app.is_org_owner(org_id)
)
with check (
  owner_user_id = auth.uid()
  and app.is_org_owner(org_id)
);

do $$
declare
  tenant_table text;
  tenant_tables text[] := array[
    'allocation_planner_suppressions',
    'box_dealers',
    'box_id_aliases',
    'box_transfers',
    'caulk_backfill_map',
    'caulk_job_allocations',
    'caulk_job_checkouts',
    'caulk_manufacturers',
    'caulk_products',
    'caulk_stock',
    'caulk_transactions',
    'caulk_transfers',
    'film_name_aliases',
    'inventory_ownership_events',
    'job_caulk_requirements',
    'owner_companies',
    'warehouses'
  ];
begin
  foreach tenant_table in array tenant_tables loop
    execute format('alter table app.%I enable row level security', tenant_table);
    execute format('drop policy if exists tenant_member_select on app.%I', tenant_table);
    execute format(
      'create policy tenant_member_select on app.%I for select using (app.is_org_member(org_id))',
      tenant_table
    );
    execute format(
      'revoke select, insert, update, delete on table app.%I from public, anon, authenticated',
      tenant_table
    );
  end loop;
end;
$$;
