-- Tenant direct write grants hardening.
--
-- Close remaining direct INSERT/UPDATE/DELETE grants on org-bearing app tables.
-- App writes continue through SECURITY DEFINER RPC/API surfaces; service_role
-- privileges are intentionally left unchanged.

do $$
declare
  tenant_table text;
  tenant_tables text[] := array[
    'access_requests',
    'admin_feature_permissions',
    'allocations',
    'audit_log',
    'boxes',
    'film_catalog',
    'film_order_box_links',
    'film_order_events',
    'film_orders',
    'film_weight_pending_reviews',
    'film_weight_profiles',
    'film_weight_samples',
    'general_feature_permissions',
    'job_phases',
    'job_requirements',
    'jobs',
    'organization_members',
    'organizations',
    'owner_notification_preferences',
    'roll_weight_log',
    'user_preferences',
    'username_change_requests'
  ];
begin
  foreach tenant_table in array tenant_tables loop
    execute format(
      'revoke insert, update, delete on table app.%I from public, anon, authenticated',
      tenant_table
    );
  end loop;
end;
$$;
