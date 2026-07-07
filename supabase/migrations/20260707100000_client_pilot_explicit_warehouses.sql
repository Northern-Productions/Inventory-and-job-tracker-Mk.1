-- Client pilot orgs manage warehouses explicitly.
-- Existing org warehouse rows remain untouched; only the automatic org-insert seed trigger is removed.
drop trigger if exists trg_seed_default_warehouses on app.organizations;

comment on function app_api.seed_default_warehouses_for_new_org()
  is 'Legacy/internal bootstrap helper retained for explicit use only. New organizations do not auto-seed IL1/MS1 warehouses.';

comment on function app_api.ensure_default_warehouses_for_org(uuid, text)
  is 'Explicit legacy/internal warehouse bootstrap helper. Client pilot organizations should create only their intended warehouse rows.';

comment on table app.warehouses
  is 'Warehouses are explicit per organization. Creating an organization must not automatically create internal IL1/MS1 warehouses.';
