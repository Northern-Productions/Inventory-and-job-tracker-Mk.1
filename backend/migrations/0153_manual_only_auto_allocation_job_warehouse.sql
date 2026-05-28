-- Manual-only allocation: keep demand visible, but stop hidden planner allocation.
--
-- The old app_api.reconcile_auto_planned_allocations function inserted,
-- updated, and cancelled stored AUTO_PLANNED film/caulk reservations whenever
-- many unrelated mutation routes ran. Allocation is now intentional: users
-- allocate film or caulk through the visible Auto Allocate / allocation actions.

create or replace function app_api.reconcile_auto_planned_allocations(
  p_org_id uuid,
  p_actor text,
  p_scope jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  return jsonb_build_object(
    'filmInserted', 0,
    'filmUpdated', 0,
    'filmCancelled', 0,
    'caulkInserted', 0,
    'caulkUpdated', 0,
    'caulkCancelled', 0,
    'warnings', '[]'::jsonb,
    'warningCount', 0,
    'manualOnly', true
  );
end;
$$;

comment on function app_api.reconcile_auto_planned_allocations(uuid, text, jsonb)
  is 'Manual-only allocation mode: legacy planner reconciliation is intentionally a no-op so job edits, requirement changes, inventory updates, and other mutations cannot silently auto-allocate film or caulk.';

create or replace function public.api_acl_reconcile_auto_planned_allocations(
  p_org_id uuid,
  p_actor text,
  p_scope jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'write');
  return app_api.reconcile_auto_planned_allocations(
    p_org_id,
    p_actor,
    coalesce(p_scope, '{}'::jsonb)
  );
end;
$$;

comment on function public.api_acl_reconcile_auto_planned_allocations(uuid, text, jsonb)
  is 'Permission-checked wrapper for manual-only no-op planner reconciliation.';

select app_api.grant_execute_if_exists(
  'app_api.reconcile_auto_planned_allocations(uuid, text, jsonb)',
  'authenticated'
);
select app_api.grant_execute_if_exists(
  'app_api.reconcile_auto_planned_allocations(uuid, text, jsonb)',
  'service_role'
);
select app_api.grant_execute_if_exists(
  'public.api_acl_reconcile_auto_planned_allocations(uuid, text, jsonb)',
  'authenticated'
);
select app_api.grant_execute_if_exists(
  'public.api_acl_reconcile_auto_planned_allocations(uuid, text, jsonb)',
  'service_role'
);
