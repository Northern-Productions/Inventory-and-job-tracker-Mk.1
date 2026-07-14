-- Forward-only remediation for the historical 0027/0028 migration mirror gap.
-- Reassert permission behavior only. Existing permission rows and overrides are
-- intentionally left unchanged by this migration.

create or replace function app_api.member_permissions_for_user_json(p_org_id uuid, p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select jsonb_build_object(
    'inventory', app_api.feature_access_json(
      coalesce((select a.read_enabled from app.admin_feature_permissions a where a.org_id = p_org_id and a.admin_user_id = p_user_id and a.feature_area = 'inventory'), coalesce((select g.read_enabled from app.general_feature_permissions g where g.org_id = p_org_id and g.feature_area = 'inventory'), true)),
      false
    ),
    'allocations', app_api.feature_access_json(
      coalesce((select a.read_enabled from app.admin_feature_permissions a where a.org_id = p_org_id and a.admin_user_id = p_user_id and a.feature_area = 'allocations'), coalesce((select g.read_enabled from app.general_feature_permissions g where g.org_id = p_org_id and g.feature_area = 'allocations'), true)),
      false
    ),
    'jobs', app_api.feature_access_json(
      coalesce((select a.read_enabled from app.admin_feature_permissions a where a.org_id = p_org_id and a.admin_user_id = p_user_id and a.feature_area = 'jobs'), coalesce((select g.read_enabled from app.general_feature_permissions g where g.org_id = p_org_id and g.feature_area = 'jobs'), true)),
      false
    ),
    'film_orders', app_api.feature_access_json(
      coalesce((select a.read_enabled from app.admin_feature_permissions a where a.org_id = p_org_id and a.admin_user_id = p_user_id and a.feature_area = 'film_orders'), coalesce((select g.read_enabled from app.general_feature_permissions g where g.org_id = p_org_id and g.feature_area = 'film_orders'), true)),
      false
    ),
    'activity_history', app_api.feature_access_json(
      coalesce((select a.read_enabled from app.admin_feature_permissions a where a.org_id = p_org_id and a.admin_user_id = p_user_id and a.feature_area = 'activity_history'), coalesce((select g.read_enabled from app.general_feature_permissions g where g.org_id = p_org_id and g.feature_area = 'activity_history'), true)),
      false
    ),
    'reports', app_api.feature_access_json(
      coalesce((select a.read_enabled from app.admin_feature_permissions a where a.org_id = p_org_id and a.admin_user_id = p_user_id and a.feature_area = 'reports'), coalesce((select g.read_enabled from app.general_feature_permissions g where g.org_id = p_org_id and g.feature_area = 'reports'), true)),
      false
    ),
    'access_management', app_api.feature_access_json(false, false)
  );
$$;

create or replace function app_api.require_effective_feature_access(
  p_org_id uuid,
  p_feature_area text,
  p_access_mode text
)
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_role text;
  v_feature text := app_api.trim_text(p_feature_area);
  v_mode text := app_api.trim_text(p_access_mode);
  v_allowed boolean := false;
begin
  if v_mode not in ('read', 'write') then
    perform app_api.raise_http(400, 'Feature access mode must be read or write.');
  end if;

  v_role := app_api.require_org_member_approved(p_org_id);
  perform app_api.ensure_general_feature_permissions(p_org_id, 'feature-access-check');

  if v_role = 'owner' then
    return;
  end if;

  if v_role = 'member' then
    if v_feature = 'access_management' then
      perform app_api.raise_http(403, 'Feature access denied.');
    end if;

    if v_feature <> all(app_api.member_feature_areas()) then
      perform app_api.raise_http(400, 'Unsupported feature area.');
    end if;

    if v_mode = 'write' then
      perform app_api.raise_http(403, 'Feature access denied.');
    end if;

    select coalesce(a.read_enabled, g.read_enabled, false)
    into v_allowed
    from app.general_feature_permissions g
    left join app.admin_feature_permissions a
      on a.org_id = g.org_id
     and a.admin_user_id = auth.uid()
     and a.feature_area = g.feature_area
    where g.org_id = p_org_id
      and g.feature_area = v_feature;
  elsif v_role = 'admin' then
    if v_feature <> all(app_api.admin_feature_areas()) then
      perform app_api.raise_http(400, 'Unsupported feature area.');
    end if;

    perform app_api.ensure_admin_feature_permissions(
      p_org_id,
      auth.uid(),
      true,
      'feature-access-check'
    );

    select
      case
        when v_mode = 'read' then a.read_enabled
        else a.write_enabled
      end
    into v_allowed
    from app.admin_feature_permissions a
    where a.org_id = p_org_id
      and a.admin_user_id = auth.uid()
      and a.feature_area = v_feature;
  else
    perform app_api.raise_http(403, 'Feature access denied.');
  end if;

  if not coalesce(v_allowed, false) then
    perform app_api.raise_http(403, 'Feature access denied.');
  end if;
end;
$$;

create or replace function public.api_update_user_feature_permissions(
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
  v_actor_role text;
  v_target_user_id uuid := nullif(app_api.trim_text(p_payload->>'userId'), '')::uuid;
  v_target_role text;
  v_feature text;
  v_permissions jsonb;
  v_feature_payload jsonb;
  v_read text;
  v_read_enabled boolean;
  v_has_updates boolean := false;
begin
  v_actor_role := app_api.require_org_admin_or_owner(p_org_id);
  if v_actor_role = 'admin' then
    perform app_api.require_effective_feature_access(p_org_id, 'access_management', 'write');
  end if;

  if jsonb_typeof(coalesce(p_payload, 'null'::jsonb)) <> 'object' then
    perform app_api.raise_http(400, 'Payload must be a JSON object.');
  end if;

  if v_target_user_id is null then
    perform app_api.raise_http(400, 'userId is required.');
  end if;

  v_permissions := p_payload->'permissions';
  if jsonb_typeof(coalesce(v_permissions, 'null'::jsonb)) <> 'object' then
    perform app_api.raise_http(400, 'permissions must be an object keyed by feature area.');
  end if;

  select m.role
  into v_target_role
  from app.organization_members m
  where m.org_id = p_org_id
    and m.user_id = v_target_user_id
  for update;

  if v_target_role is null then
    perform app_api.raise_http(404, 'Target user is not an organization member.');
  end if;

  if v_target_role <> 'member' then
    perform app_api.raise_http(400, 'Only member accounts can be changed from this page.');
  end if;

  perform app_api.ensure_general_feature_permissions(p_org_id, app_api.trim_text(p_actor));

  foreach v_feature in array app_api.member_feature_areas() loop
    if not (v_permissions ? v_feature) then
      continue;
    end if;

    v_feature_payload := v_permissions->v_feature;
    if jsonb_typeof(coalesce(v_feature_payload, 'null'::jsonb)) <> 'object' then
      perform app_api.raise_http(400, format('permissions.%s must be an object.', v_feature));
    end if;

    v_read := lower(app_api.trim_text(v_feature_payload->>'read'));
    if v_read not in ('true', 'false') then
      perform app_api.raise_http(400, format('permissions.%s.read must be true or false.', v_feature));
    end if;
    v_read_enabled := (v_read = 'true');

    insert into app.admin_feature_permissions (
      org_id,
      admin_user_id,
      feature_area,
      read_enabled,
      write_enabled,
      updated_at,
      updated_by
    )
    values (
      p_org_id,
      v_target_user_id,
      v_feature,
      coalesce((select g.read_enabled from app.general_feature_permissions g where g.org_id = p_org_id and g.feature_area = v_feature), true),
      false,
      now(),
      app_api.trim_text(p_actor)
    )
    on conflict (org_id, admin_user_id, feature_area) do nothing;

    update app.admin_feature_permissions a
    set
      read_enabled = v_read_enabled,
      write_enabled = false,
      updated_at = now(),
      updated_by = app_api.trim_text(p_actor)
    where a.org_id = p_org_id
      and a.admin_user_id = v_target_user_id
      and a.feature_area = v_feature;

    v_has_updates := true;
  end loop;

  if not v_has_updates then
    perform app_api.raise_http(400, 'permissions must include at least one member feature entry.');
  end if;

  delete from app.admin_feature_permissions a
  where a.org_id = p_org_id
    and a.admin_user_id = v_target_user_id
    and a.feature_area = 'access_management';

  return app_api.member_permissions_for_user_json(p_org_id, v_target_user_id);
end;
$$;

-- Preserve the active-membership lifecycle introduced by 0184 while restoring
-- the per-user read-only permission projection established by 0027/0028.
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
        'email', v_email
      );
    end if;

    if not found then
      insert into app.access_requests (
        org_id,
        user_id,
        status,
        requested_at,
        requested_by_email,
        requested_by_name
      )
      values (
        p_org_id,
        v_user_id,
        'pending',
        now(),
        v_email,
        v_name
      )
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
      'email', v_email
    );
  end if;

  perform app_api.require_org_member_approved(p_org_id);

  if v_role = 'owner' then
    perform app_api.ensure_owner_notification_preference(
      p_org_id,
      v_user_id,
      'auth-context-owner-bootstrap'
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
      'access_management', app_api.feature_access_json(true, true)
    );
    v_is_admin_console_allowed := true;
  elsif v_role = 'admin' then
    perform app_api.ensure_admin_feature_permissions(
      p_org_id,
      v_user_id,
      true,
      'auth-context-admin-bootstrap'
    );
    v_permissions := app_api.admin_permissions_json(p_org_id, v_user_id);
    v_is_admin_console_allowed := coalesce((v_permissions->'access_management'->>'write')::boolean, false);
    v_owner_in_app_opt_in := false;
  else
    v_permissions := app_api.member_permissions_for_user_json(p_org_id, v_user_id);
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
    'email', v_email
  );
end;
$$;

-- Keep the public RPC surface user-session scoped. Internal app_api functions
-- remain unreachable without app_api schema usage.
revoke execute on function public.api_get_auth_context(uuid) from public, anon, service_role;
grant execute on function public.api_get_auth_context(uuid) to authenticated;

revoke execute on function public.api_update_user_feature_permissions(uuid, text, jsonb) from public, anon, service_role;
grant execute on function public.api_update_user_feature_permissions(uuid, text, jsonb) to authenticated;
