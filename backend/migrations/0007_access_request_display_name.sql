alter table app.access_requests
  add column if not exists requested_by_name text not null default '';

update app.access_requests
set requested_by_name = app_api.trim_text(
  replace(
    replace(
      replace(split_part(requested_by_email, '@', 1), '.', ' '),
      '_',
      ' '
    ),
    '-',
    ' '
  )
)
where app_api.trim_text(requested_by_name) = ''
  and app_api.trim_text(requested_by_email) <> '';

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
    v_name := app_api.trim_text(
      replace(
        replace(
          replace(split_part(v_email, '@', 1), '.', ' '),
          '_',
          ' '
        ),
        '-',
        ' '
      )
    );
  end if;

  perform app_api.ensure_general_feature_permissions(p_org_id, 'auth-context-bootstrap');

  select m.role
  into v_role
  from app.organization_members m
  where m.org_id = p_org_id
    and m.user_id = v_user_id;

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
    v_permissions := app_api.member_permissions_json(p_org_id);
    v_is_admin_console_allowed := false;
    v_owner_in_app_opt_in := false;
  end if;

  if v_role = 'admin' or (v_role = 'owner' and v_owner_in_app_opt_in) then
    select count(*)
    into v_pending_count
    from app.access_requests r
    where r.org_id = p_org_id
      and r.status = 'pending';
  end if;

  return jsonb_build_object(
    'orgId', p_org_id,
    'accessStatus', 'approved',
    'role', v_role,
    'permissions', coalesce(v_permissions, '{}'::jsonb),
    'isAdminConsoleAllowed', v_is_admin_console_allowed,
    'pendingRequestCreated', false,
    'pendingCount', coalesce(v_pending_count, 0),
    'receivesInAppNotifications', (v_role = 'admin') or (v_role = 'owner' and v_owner_in_app_opt_in),
    'email', v_email
  );
end;
$$;

create or replace function public.api_list_access_requests(
  p_org_id uuid,
  p_status text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_actor_role text;
  v_result jsonb;
begin
  v_actor_role := app_api.require_org_admin_or_owner(p_org_id);
  if v_actor_role = 'admin' then
    perform app_api.require_effective_feature_access(p_org_id, 'access_management', 'read');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'userId', r.user_id,
        'name', coalesce(r.requested_by_name, ''),
        'email', r.requested_by_email,
        'status', r.status,
        'requestedAt', to_char(r.requested_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'decidedAt', coalesce(to_char(r.decided_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''),
        'decidedByActor', coalesce(r.decided_by_actor, ''),
        'decisionNote', coalesce(r.decision_note, ''),
        'currentRole', coalesce(m.role, '')
      )
      order by r.requested_at asc, r.user_id asc
    ),
    '[]'::jsonb
  )
  into v_result
  from app.access_requests r
  left join app.organization_members m
    on m.org_id = r.org_id
   and m.user_id = r.user_id
  where r.org_id = p_org_id
    and (
      app_api.trim_text(p_status) = ''
      or lower(r.status) = lower(app_api.trim_text(p_status))
    );

  return v_result;
end;
$$;

create or replace function public.api_get_admin_feature_permissions(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_result jsonb;
begin
  perform app_api.require_org_owner(p_org_id);

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'userId', m.user_id,
        'name', coalesce(r.requested_by_name, ''),
        'email', coalesce(r.requested_by_email, ''),
        'role', m.role,
        'permissions', app_api.admin_permissions_json(p_org_id, m.user_id)
      )
      order by m.created_at asc, m.user_id asc
    ),
    '[]'::jsonb
  )
  into v_result
  from app.organization_members m
  left join lateral (
    select a.requested_by_name, a.requested_by_email
    from app.access_requests a
    where a.org_id = m.org_id
      and a.user_id = m.user_id
    order by a.requested_at desc
    limit 1
  ) r on true
  where m.org_id = p_org_id
    and m.role = 'admin';

  return v_result;
end;
$$;
