create or replace function public.api_get_auth_context(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_email text := app_api.trim_text(auth.jwt()->>'email');
  v_name text := '';
  v_request app.access_requests;
  v_inserted_count integer := 0;
  v_permissions jsonb := '{}'::jsonb;
  v_pending_count integer := 0;
  v_owner_in_app_opt_in boolean := true;
  v_is_admin_console_allowed boolean := false;
  v_default_warehouse text := '';
begin
  if v_user_id is null then
    perform app_api.raise_http(401, 'Authenticated session is required.');
  end if;

  if p_org_id is null then
    perform app_api.raise_http(400, 'Organization is required.');
  end if;

  v_name := app_api.trim_text(
    coalesce(
      nullif(auth.jwt()->'user_metadata'->>'full_name', ''),
      nullif(auth.jwt()->'user_metadata'->>'name', '')
    )
  );
  if v_name = '' then
    v_name := app_api.derive_display_name_from_email(v_email);
  end if;

  perform app_api.ensure_general_feature_permissions(p_org_id, 'auth-context-bootstrap');
  perform app_api.activate_confirmed_invite_membership(p_org_id);

  select m.role
  into v_role
  from app.organization_members m
  where m.org_id = p_org_id
    and m.user_id = v_user_id
    and m.status = 'active';

  if v_role is null then
    select *
    into v_request
    from app.access_requests r
    where r.org_id = p_org_id
      and r.user_id = v_user_id;

    if found and v_request.status = 'denied' then
      return jsonb_build_object(
        'orgId', p_org_id,
        'accessStatus', 'denied',
        'role', '',
        'permissions', '{}'::jsonb,
        'isAdminConsoleAllowed', false,
        'pendingRequestCreated', false,
        'pendingCount', 0,
        'receivesInAppNotifications', false,
        'defaultWarehouse', '',
        'email', v_email
      );
    end if;

    if not found then
      insert into app.access_requests (
        org_id, user_id, status, requested_at, requested_by_email, requested_by_name
      )
      values (p_org_id, v_user_id, 'pending', now(), v_email, v_name)
      on conflict (org_id, user_id) do nothing;
      get diagnostics v_inserted_count = row_count;
    end if;

    return jsonb_build_object(
      'orgId', p_org_id,
      'accessStatus', 'pending',
      'role', '',
      'permissions', '{}'::jsonb,
      'isAdminConsoleAllowed', false,
      'pendingRequestCreated', v_inserted_count > 0,
      'pendingCount', 0,
      'receivesInAppNotifications', false,
      'defaultWarehouse', '',
      'email', v_email
    );
  end if;

  perform app_api.require_org_member_approved(p_org_id);
  v_default_warehouse := app_api.get_user_default_warehouse(p_org_id, v_user_id);

  if v_role = 'owner' then
    perform app_api.ensure_owner_notification_preference(
      p_org_id, v_user_id, 'auth-context-owner-bootstrap'
    );
    select p.in_app_opt_in
    into v_owner_in_app_opt_in
    from app.owner_notification_preferences p
    where p.org_id = p_org_id
      and p.owner_user_id = v_user_id;
    v_owner_in_app_opt_in := coalesce(v_owner_in_app_opt_in, true);
    v_permissions := jsonb_build_object(
      'inventory', app_api.feature_access_json(true, true),
      'allocations', app_api.feature_access_json(true, true),
      'jobs', app_api.feature_access_json(true, true),
      'film_orders', app_api.feature_access_json(true, true),
      'activity_history', app_api.feature_access_json(true, true),
      'reports', app_api.feature_access_json(true, true),
      'access_management', app_api.feature_access_json(true, true),
      'team_management', app_api.feature_access_json(true, true)
    );
    v_is_admin_console_allowed := true;
  elsif v_role = 'admin' then
    perform app_api.ensure_admin_feature_permissions(
      p_org_id, v_user_id, true, 'auth-context-admin-bootstrap'
    );
    v_permissions := app_api.admin_permissions_json(p_org_id, v_user_id);
    v_is_admin_console_allowed := coalesce(
      (v_permissions->'access_management'->>'write')::boolean,
      false
    );
    v_owner_in_app_opt_in := false;
  else
    v_permissions := app_api.member_permissions_for_user_json(p_org_id, v_user_id);
    v_permissions := v_permissions || jsonb_build_object(
      'team_management', app_api.feature_access_json(false, false)
    );
    v_is_admin_console_allowed := false;
    v_owner_in_app_opt_in := false;
  end if;

  select count(*)
  into v_pending_count
  from app.access_requests r
  where r.org_id = p_org_id
    and r.status = 'pending';

  return jsonb_build_object(
    'orgId', p_org_id,
    'accessStatus', 'approved',
    'role', v_role,
    'permissions', v_permissions,
    'isAdminConsoleAllowed', v_is_admin_console_allowed,
    'pendingRequestCreated', false,
    'pendingCount', v_pending_count,
    'receivesInAppNotifications', v_role = 'admin' or (v_role = 'owner' and v_owner_in_app_opt_in),
    'defaultWarehouse', coalesce(v_default_warehouse, ''),
    'email', v_email
  );
end;
$$;

revoke execute on function public.api_get_auth_context(uuid) from public, anon, service_role;
grant execute on function public.api_get_auth_context(uuid) to authenticated;
