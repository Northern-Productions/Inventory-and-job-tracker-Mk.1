-- Multi-organization member onboarding and explicit organization selection.
-- Existing accounts remain global; membership, role, and delegated Team access
-- remain scoped to one organization. No existing business rows are backfilled.

create table if not exists app.user_organization_preferences (
  user_id uuid primary key,
  selected_org_id uuid not null,
  updated_at timestamptz not null default now(),
  updated_by_user_id uuid not null,
  foreign key (selected_org_id, user_id)
    references app.organization_members(org_id, user_id)
    on delete cascade
);

alter table app.user_organization_preferences enable row level security;

drop policy if exists user_organization_preferences_read_self on app.user_organization_preferences;
create policy user_organization_preferences_read_self on app.user_organization_preferences
for select using (user_id = auth.uid());

revoke all on table app.user_organization_preferences from public, anon, authenticated, service_role;

alter table app.admin_feature_permissions
  drop constraint if exists admin_feature_permissions_feature_area_check;

alter table app.admin_feature_permissions
  add constraint admin_feature_permissions_feature_area_check
  check (feature_area in (
    'inventory',
    'allocations',
    'jobs',
    'film_orders',
    'activity_history',
    'reports',
    'access_management',
    'team_management'
  ));

alter table app.team_user_audit_log
  drop constraint if exists team_user_audit_log_action_check;

alter table app.team_user_audit_log
  add constraint team_user_audit_log_action_check
  check (action in ('ADD_MEMBER', 'INVITE_USER', 'CHANGE_USER_ROLE', 'DISABLE_USER', 'REENABLE_USER'));

create or replace function app_api.admin_feature_areas()
returns text[]
language sql
immutable
as $$
  select array[
    'inventory',
    'allocations',
    'jobs',
    'film_orders',
    'activity_history',
    'reports',
    'access_management',
    'team_management'
  ]::text[];
$$;

create or replace function app_api.ensure_admin_feature_permissions(
  p_org_id uuid,
  p_admin_user_id uuid,
  p_copy_member_defaults boolean,
  p_actor text default 'system'
)
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_feature text;
  v_read boolean;
  v_write boolean;
begin
  if p_org_id is null or p_admin_user_id is null then
    return;
  end if;

  perform app_api.ensure_general_feature_permissions(p_org_id, p_actor);

  foreach v_feature in array app_api.admin_feature_areas() loop
    if v_feature = 'team_management' then
      v_read := false;
      v_write := false;
    elsif p_copy_member_defaults and v_feature <> 'access_management' then
      select g.read_enabled, g.write_enabled
      into v_read, v_write
      from app.general_feature_permissions g
      where g.org_id = p_org_id
        and g.feature_area = v_feature;
      v_read := coalesce(v_read, true);
      v_write := coalesce(v_write, true);
    else
      v_read := true;
      v_write := true;
    end if;

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
      p_admin_user_id,
      v_feature,
      v_read,
      v_write,
      now(),
      app_api.trim_text(p_actor)
    )
    on conflict (org_id, admin_user_id, feature_area) do nothing;
  end loop;
end;
$$;

create or replace function app_api.admin_permissions_json(p_org_id uuid, p_admin_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select coalesce(
    jsonb_object_agg(
      feature.value,
      app_api.feature_access_json(
        case
          when feature.value = 'team_management' then coalesce(permission.read_enabled, false)
          when feature.value = 'access_management' then coalesce(permission.read_enabled, true)
          else coalesce(permission.read_enabled, general.read_enabled, true)
        end,
        case
          when feature.value = 'team_management' then coalesce(permission.write_enabled, false)
          when feature.value = 'access_management' then coalesce(permission.write_enabled, true)
          else coalesce(permission.write_enabled, general.write_enabled, true)
        end
      )
    ),
    '{}'::jsonb
  )
  from unnest(app_api.admin_feature_areas()) as feature(value)
  left join app.admin_feature_permissions permission
    on permission.org_id = p_org_id
   and permission.admin_user_id = p_admin_user_id
   and permission.feature_area = feature.value
  left join app.general_feature_permissions general
    on general.org_id = p_org_id
   and general.feature_area = feature.value;
$$;

create or replace function public.api_update_admin_feature_permissions(
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
  v_target_user_id uuid := nullif(app_api.trim_text(p_payload->>'userId'), '')::uuid;
  v_target_role text;
  v_feature text;
  v_read text;
  v_write text;
begin
  perform app_api.require_org_owner(p_org_id);

  if v_target_user_id is null then
    perform app_api.raise_http(400, 'userId is required.');
  end if;

  select m.role
  into v_target_role
  from app.organization_members m
  where m.org_id = p_org_id
    and m.user_id = v_target_user_id
    and m.status = 'active'
  for update;

  if v_target_role is distinct from 'admin' then
    perform app_api.raise_http(400, 'Target user must be an active admin.');
  end if;

  perform app_api.ensure_admin_feature_permissions(
    p_org_id,
    v_target_user_id,
    true,
    app_api.trim_text(p_actor)
  );

  foreach v_feature in array app_api.admin_feature_areas() loop
    if not ((p_payload->'permissions') ? v_feature) then
      continue;
    end if;

    v_read := lower(app_api.trim_text(p_payload->'permissions'->v_feature->>'read'));
    v_write := lower(app_api.trim_text(p_payload->'permissions'->v_feature->>'write'));

    if v_feature = 'team_management'
       and (v_read not in ('true', 'false') or v_write not in ('true', 'false') or v_read <> v_write) then
      perform app_api.raise_http(400, 'Manage Team Members must be enabled or disabled as one permission.');
    end if;

    update app.admin_feature_permissions a
    set
      read_enabled = case when v_read in ('true', 'false') then v_read::boolean else a.read_enabled end,
      write_enabled = case when v_write in ('true', 'false') then v_write::boolean else a.write_enabled end,
      updated_at = now(),
      updated_by = app_api.trim_text(p_actor)
    where a.org_id = p_org_id
      and a.admin_user_id = v_target_user_id
      and a.feature_area = v_feature;
  end loop;

  return app_api.admin_permissions_json(p_org_id, v_target_user_id);
end;
$$;

create or replace function app_api.activate_confirmed_invite_membership(p_org_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_user_id uuid := auth.uid();
  v_updated integer := 0;
begin
  if v_user_id is null then
    return 0;
  end if;

  with activated as (
    update app.organization_members m
    set
      status = 'active',
      updated_at = now(),
      updated_by_actor = 'accepted invite',
      disabled_at = null,
      disabled_by_user_id = null
    from auth.users u
    where m.user_id = v_user_id
      and u.id = m.user_id
      and m.status = 'invited'
      and (p_org_id is null or m.org_id = p_org_id)
      and (
        u.email_confirmed_at is not null
        or u.confirmed_at is not null
      )
    returning m.org_id, m.user_id
  ), approved_requests as (
    update app.access_requests r
    set
      status = 'approved',
      decided_at = now(),
      decided_by_user_id = v_user_id,
      decided_by_actor = 'accepted invite',
      decision_note = 'Organization invitation accepted.'
    from activated a
    where r.org_id = a.org_id
      and r.user_id = a.user_id
    returning r.org_id, r.user_id
  )
  select count(*)::integer
  into v_updated
  from activated a
  left join approved_requests r
    on r.org_id = a.org_id
   and r.user_id = a.user_id;

  return v_updated;
end;
$$;

create or replace function public.api_list_memberships()
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null then
    perform app_api.raise_http(401, 'Authenticated session is required.');
  end if;

  perform app_api.activate_confirmed_invite_membership(null);

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'org_id', m.org_id,
        'org_name', o.name,
        'role', m.role,
        'status', m.status,
        'selected', preference.selected_org_id = m.org_id,
        'created_at', to_char(m.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
      order by m.created_at asc, m.org_id asc
    ),
    '[]'::jsonb
  )
  into v_result
  from app.organization_members m
  join app.organizations o
    on o.id = m.org_id
  left join app.user_organization_preferences preference
    on preference.user_id = m.user_id
  where m.user_id = auth.uid()
    and m.status = 'active';

  return v_result;
end;
$$;

create or replace function public.api_select_organization(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    perform app_api.raise_http(401, 'Authenticated session is required.');
  end if;

  if p_org_id is null then
    perform app_api.raise_http(400, 'Organization is required.');
  end if;

  perform 1
  from app.organization_members m
  where m.org_id = p_org_id
    and m.user_id = v_user_id
    and m.status = 'active'
  for share;

  if not found then
    perform app_api.raise_http(403, 'Organization access is not available.');
  end if;

  insert into app.user_organization_preferences (
    user_id,
    selected_org_id,
    updated_at,
    updated_by_user_id
  )
  values (
    v_user_id,
    p_org_id,
    now(),
    v_user_id
  )
  on conflict (user_id) do update set
    selected_org_id = excluded.selected_org_id,
    updated_at = excluded.updated_at,
    updated_by_user_id = excluded.updated_by_user_id;

  return jsonb_build_object('orgId', p_org_id);
end;
$$;

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
      'email', v_email
    );
  end if;

  perform app_api.require_org_member_approved(p_org_id);

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
    'email', v_email
  );
end;
$$;

create or replace function app_api.require_team_manager(p_org_id uuid)
returns text
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_allowed boolean := false;
begin
  if v_user_id is null then
    perform app_api.raise_http(401, 'Authenticated session is required.');
  end if;

  if p_org_id is null then
    perform app_api.raise_http(400, 'Organization is required.');
  end if;

  select m.role
  into v_role
  from app.organization_members m
  where m.org_id = p_org_id
    and m.user_id = v_user_id
    and m.status = 'active'
  for share;

  if v_role = 'owner' then
    return v_role;
  end if;

  if v_role = 'admin' then
    select a.read_enabled and a.write_enabled
    into v_allowed
    from app.admin_feature_permissions a
    where a.org_id = p_org_id
      and a.admin_user_id = v_user_id
      and a.feature_area = 'team_management'
    for share;
  end if;

  if not coalesce(v_allowed, false) then
    perform app_api.raise_http(403, 'Team management access is required.');
  end if;

  return v_role;
end;
$$;

create or replace function app_api.require_team_target_allowed(
  p_actor_role text,
  p_target_user_id uuid,
  p_target_role text,
  p_requested_role text default null
)
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  if p_actor_role <> 'admin' then
    return;
  end if;

  if p_target_user_id is not null and p_target_user_id = auth.uid() then
    perform app_api.raise_http(403, 'Admins cannot change their own Team membership.');
  end if;

  if p_target_role = 'owner' or p_requested_role = 'owner' then
    perform app_api.raise_http(403, 'Admins cannot change an Owner membership.');
  end if;
end;
$$;

create or replace function public.api_list_team_users(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_result jsonb;
begin
  perform app_api.require_team_manager(p_org_id);

  select coalesce(
    jsonb_agg(
      app_api.team_user_public_json(
        m,
        coalesce(nullif(u.email, ''), nullif(r.requested_by_email, '')),
        coalesce(nullif(u.raw_user_meta_data->>'full_name', ''), nullif(u.raw_user_meta_data->>'name', ''), nullif(r.requested_by_name, ''))
      )
      order by
        case m.status when 'active' then 1 when 'invited' then 2 else 3 end,
        case m.role when 'owner' then 1 when 'admin' then 2 else 3 end,
        coalesce(nullif(u.email, ''), nullif(r.requested_by_email, ''), m.user_id::text)
    ),
    '[]'::jsonb
  )
  into v_result
  from app.organization_members m
  left join auth.users u
    on u.id = m.user_id
  left join lateral (
    select a.requested_by_email, a.requested_by_name
    from app.access_requests a
    where a.org_id = m.org_id
      and a.user_id = m.user_id
    order by a.requested_at desc
    limit 1
  ) r on true
  where m.org_id = p_org_id;

  return v_result;
end;
$$;

create or replace function public.api_add_team_member(
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
  v_actor_user_id uuid := auth.uid();
  v_actor_role text;
  v_email text := lower(app_api.trim_text(p_payload->>'email'));
  v_role text := lower(app_api.trim_text(p_payload->>'role'));
  v_user_count integer := 0;
  v_user auth.users;
  v_current app.organization_members;
  v_member app.organization_members;
  v_name text := '';
begin
  v_actor_role := app_api.require_team_manager(p_org_id);

  if v_email = '' or position('@' in v_email) <= 1 then
    perform app_api.raise_http(400, 'A valid email is required.');
  end if;

  if v_role not in ('owner', 'admin', 'member') then
    perform app_api.raise_http(400, 'A valid role is required.');
  end if;

  perform app_api.require_team_target_allowed(v_actor_role, null, null, v_role);
  perform pg_advisory_xact_lock(hashtextextended(v_email, 0));

  select count(*)::integer
  into v_user_count
  from auth.users u
  where lower(app_api.trim_text(u.email)) = v_email;

  if v_user_count > 1 then
    perform app_api.raise_http(409, 'The account could not be resolved safely. Contact support.');
  end if;

  if v_user_count = 0 then
    if exists (
      select 1
      from app.organization_members member_row
      join app.access_requests request_row
        on request_row.org_id = member_row.org_id
       and request_row.user_id = member_row.user_id
      left join auth.users auth_row
        on auth_row.id = member_row.user_id
      where auth_row.id is null
        and lower(app_api.trim_text(request_row.requested_by_email)) = v_email
    ) then
      perform app_api.raise_http(409, 'The account could not be resolved safely. Contact support.');
    end if;

    return jsonb_build_object(
      'action', 'invite-new-user',
      'email', v_email,
      'name', app_api.trim_text(p_payload->>'name'),
      'role', v_role
    );
  end if;

  select *
  into v_user
  from auth.users u
  where lower(app_api.trim_text(u.email)) = v_email
  for update;

  if v_user.deleted_at is not null then
    perform app_api.raise_http(409, 'The account could not be resolved safely. Contact support.');
  end if;

  if exists (
    select 1
    from app.organization_members member_row
    join app.access_requests request_row
      on request_row.org_id = member_row.org_id
     and request_row.user_id = member_row.user_id
    where member_row.user_id <> v_user.id
      and lower(app_api.trim_text(request_row.requested_by_email)) = v_email
  ) then
    perform app_api.raise_http(409, 'The account could not be resolved safely. Contact support.');
  end if;

  if coalesce(v_user.banned_until > now(), false)
     or lower(app_api.trim_text(v_user.raw_app_meta_data->>'disabled')) = 'true' then
    return jsonb_build_object('outcome', 'account_unavailable');
  end if;

  v_name := coalesce(
    nullif(app_api.trim_text(v_user.raw_user_meta_data->>'full_name'), ''),
    nullif(app_api.trim_text(v_user.raw_user_meta_data->>'name'), ''),
    app_api.derive_display_name_from_email(v_email)
  );

  select *
  into v_current
  from app.organization_members m
  where m.org_id = p_org_id
    and m.user_id = v_user.id
  for update;

  if found then
    perform app_api.require_team_target_allowed(v_actor_role, v_user.id, v_current.role, v_role);

    if v_current.status = 'active' then
      return jsonb_build_object(
        'outcome', 'already_active',
        'entry', app_api.team_user_public_json(v_current, v_email, v_name)
      );
    end if;

    if v_current.status = 'invited' then
      return jsonb_build_object(
        'outcome', 'already_invited',
        'entry', app_api.team_user_public_json(v_current, v_email, v_name)
      );
    end if;

    if v_current.status = 'disabled' then
      return jsonb_build_object(
        'outcome', 'disabled_confirmation_required',
        'entry', app_api.team_user_public_json(v_current, v_email, v_name)
      );
    end if;

    perform app_api.raise_http(409, 'The membership state could not be resolved safely.');
  end if;

  if v_user.email_confirmed_at is null and v_user.confirmed_at is null then
    return jsonb_build_object(
      'action', 'invite-existing-unconfirmed',
      'userId', v_user.id,
      'email', v_email,
      'role', v_role
    );
  end if;

  insert into app.organization_members (
    org_id,
    user_id,
    role,
    status,
    created_at,
    updated_at,
    updated_by_actor
  )
  values (
    p_org_id,
    v_user.id,
    v_role,
    'active',
    now(),
    now(),
    app_api.trim_text(p_actor)
  )
  returning * into v_member;

  insert into app.access_requests (
    org_id,
    user_id,
    status,
    requested_at,
    requested_by_email,
    requested_by_name,
    decided_at,
    decided_by_user_id,
    decided_by_actor,
    decision_note
  )
  values (
    p_org_id,
    v_user.id,
    'approved',
    now(),
    v_email,
    v_name,
    now(),
    v_actor_user_id,
    app_api.trim_text(p_actor),
    'Existing account added to organization.'
  )
  on conflict (org_id, user_id) do update set
    status = 'approved',
    requested_by_email = excluded.requested_by_email,
    requested_by_name = excluded.requested_by_name,
    decided_at = excluded.decided_at,
    decided_by_user_id = excluded.decided_by_user_id,
    decided_by_actor = excluded.decided_by_actor,
    decision_note = excluded.decision_note;

  if v_role = 'owner' then
    perform app_api.ensure_owner_notification_preference(p_org_id, v_user.id, app_api.trim_text(p_actor));
  elsif v_role = 'admin' then
    perform app_api.ensure_admin_feature_permissions(p_org_id, v_user.id, true, app_api.trim_text(p_actor));
  end if;

  perform app_api.team_user_audit(
    p_org_id,
    'ADD_MEMBER',
    v_actor_user_id,
    p_actor,
    v_user.id,
    v_email,
    '{}'::jsonb,
    jsonb_build_object('role', v_role, 'status', 'active')
  );

  return jsonb_build_object(
    'outcome', 'added_existing',
    'entry', app_api.team_user_public_json(v_member, v_email, v_name)
  );
end;
$$;

create or replace function public.api_record_team_invite(
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
  v_actor_user_id uuid := auth.uid();
  v_actor_role text;
  v_user_id uuid := nullif(app_api.trim_text(p_payload->>'userId'), '')::uuid;
  v_email text := lower(app_api.trim_text(p_payload->>'email'));
  v_role text := lower(app_api.trim_text(p_payload->>'role'));
  v_invite_kind text := lower(app_api.trim_text(p_payload->>'inviteKind'));
  v_user_count integer := 0;
  v_user auth.users;
  v_existing app.organization_members;
  v_member app.organization_members;
  v_name text := '';
  v_status text := 'invited';
  v_access_status text := 'pending';
begin
  v_actor_role := app_api.require_team_manager(p_org_id);

  if v_user_id is null or v_email = '' then
    perform app_api.raise_http(400, 'Invited account identity is required.');
  end if;

  if v_role not in ('owner', 'admin', 'member') then
    perform app_api.raise_http(400, 'A valid role is required.');
  end if;

  if v_invite_kind not in ('new', 'existing_unconfirmed') then
    perform app_api.raise_http(400, 'Invite classification is required.');
  end if;

  perform app_api.require_team_target_allowed(v_actor_role, v_user_id, null, v_role);
  perform pg_advisory_xact_lock(hashtextextended(v_email, 0));

  select count(*)::integer
  into v_user_count
  from auth.users u
  where lower(app_api.trim_text(u.email)) = v_email;

  if v_user_count <> 1 then
    perform app_api.raise_http(409, 'The account could not be resolved safely. Contact support.');
  end if;

  select *
  into v_user
  from auth.users u
  where lower(app_api.trim_text(u.email)) = v_email
  for update;

  if v_user.id <> v_user_id then
    perform app_api.raise_http(409, 'The account could not be resolved safely. Contact support.');
  end if;

  if v_user.deleted_at is not null then
    perform app_api.raise_http(409, 'The account could not be resolved safely. Contact support.');
  end if;

  if exists (
    select 1
    from app.organization_members member_row
    join app.access_requests request_row
      on request_row.org_id = member_row.org_id
     and request_row.user_id = member_row.user_id
    where member_row.user_id <> v_user_id
      and lower(app_api.trim_text(request_row.requested_by_email)) = v_email
  ) then
    perform app_api.raise_http(409, 'The account could not be resolved safely. Contact support.');
  end if;

  if coalesce(v_user.banned_until > now(), false)
     or lower(app_api.trim_text(v_user.raw_app_meta_data->>'disabled')) = 'true' then
    perform app_api.raise_http(409, 'This account is not available for organization access.');
  end if;

  v_name := coalesce(
    nullif(app_api.trim_text(v_user.raw_user_meta_data->>'full_name'), ''),
    nullif(app_api.trim_text(v_user.raw_user_meta_data->>'name'), ''),
    case when v_invite_kind = 'new' then nullif(app_api.trim_text(p_payload->>'name'), '') else null end,
    app_api.derive_display_name_from_email(v_email)
  );
  v_status := case
    when v_user.email_confirmed_at is not null or v_user.confirmed_at is not null then 'active'
    else 'invited'
  end;
  v_access_status := case when v_status = 'active' then 'approved' else 'pending' end;

  select *
  into v_existing
  from app.organization_members m
  where m.org_id = p_org_id
    and m.user_id = v_user_id
  for update;

  if found then
    perform app_api.require_team_target_allowed(v_actor_role, v_user_id, v_existing.role, v_role);

    if v_existing.status = 'active' then
      return jsonb_build_object(
        'outcome', 'already_active',
        'entry', app_api.team_user_public_json(v_existing, v_email, v_name)
      );
    end if;
    if v_existing.status = 'invited' then
      return jsonb_build_object(
        'outcome', 'already_invited',
        'entry', app_api.team_user_public_json(v_existing, v_email, v_name)
      );
    end if;
    if v_existing.status = 'disabled' then
      return jsonb_build_object(
        'outcome', 'disabled_confirmation_required',
        'entry', app_api.team_user_public_json(v_existing, v_email, v_name)
      );
    end if;
  end if;

  insert into app.organization_members (
    org_id,
    user_id,
    role,
    status,
    created_at,
    invited_at,
    invited_by_user_id,
    updated_at,
    updated_by_actor
  )
  values (
    p_org_id,
    v_user_id,
    v_role,
    v_status,
    now(),
    now(),
    v_actor_user_id,
    now(),
    app_api.trim_text(p_actor)
  )
  returning * into v_member;

  insert into app.access_requests (
    org_id,
    user_id,
    status,
    requested_at,
    requested_by_email,
    requested_by_name,
    decided_at,
    decided_by_user_id,
    decided_by_actor,
    decision_note
  )
  values (
    p_org_id,
    v_user_id,
    v_access_status,
    now(),
    v_email,
    v_name,
    case when v_status = 'active' then now() else null end,
    case when v_status = 'active' then v_actor_user_id else null end,
    case when v_status = 'active' then app_api.trim_text(p_actor) else '' end,
    'Organization invitation recorded.'
  )
  on conflict (org_id, user_id) do update set
    status = excluded.status,
    requested_at = excluded.requested_at,
    requested_by_email = excluded.requested_by_email,
    requested_by_name = excluded.requested_by_name,
    decided_at = excluded.decided_at,
    decided_by_user_id = excluded.decided_by_user_id,
    decided_by_actor = excluded.decided_by_actor,
    decision_note = excluded.decision_note;

  if v_status = 'active' and v_role = 'owner' then
    perform app_api.ensure_owner_notification_preference(p_org_id, v_user_id, app_api.trim_text(p_actor));
  elsif v_status = 'active' and v_role = 'admin' then
    perform app_api.ensure_admin_feature_permissions(p_org_id, v_user_id, true, app_api.trim_text(p_actor));
  end if;

  perform app_api.team_user_audit(
    p_org_id,
    'INVITE_USER',
    v_actor_user_id,
    p_actor,
    v_user_id,
    v_email,
    '{}'::jsonb,
    jsonb_build_object('role', v_role, 'status', v_status)
  );

  return jsonb_build_object(
    'outcome', case
      when v_invite_kind = 'existing_unconfirmed' then 'invited_existing_unconfirmed'
      else 'invited_new'
    end,
    'entry', app_api.team_user_public_json(v_member, v_email, v_name)
  );
end;
$$;

create or replace function public.api_change_team_user_role(
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
  v_actor_user_id uuid := auth.uid();
  v_actor_role text;
  v_target_user_id uuid := nullif(app_api.trim_text(p_payload->>'userId'), '')::uuid;
  v_role text := lower(app_api.trim_text(p_payload->>'role'));
  v_before app.organization_members;
  v_after app.organization_members;
  v_email text := '';
  v_name text := '';
begin
  v_actor_role := app_api.require_team_manager(p_org_id);

  if v_target_user_id is null then
    perform app_api.raise_http(400, 'userId is required.');
  end if;
  if v_role not in ('owner', 'admin', 'member') then
    perform app_api.raise_http(400, 'A valid role is required.');
  end if;

  select *
  into v_before
  from app.organization_members m
  where m.org_id = p_org_id
    and m.user_id = v_target_user_id
  for update;

  if not found then
    perform app_api.raise_http(404, 'Target user is not a member of this organization.');
  end if;

  perform app_api.require_team_target_allowed(v_actor_role, v_target_user_id, v_before.role, v_role);

  select
    coalesce(nullif(u.email, ''), nullif(r.requested_by_email, '')),
    coalesce(nullif(u.raw_user_meta_data->>'full_name', ''), nullif(u.raw_user_meta_data->>'name', ''), nullif(r.requested_by_name, ''))
  into v_email, v_name
  from app.organization_members m
  left join auth.users u on u.id = m.user_id
  left join lateral (
    select a.requested_by_email, a.requested_by_name
    from app.access_requests a
    where a.org_id = m.org_id and a.user_id = m.user_id
    order by a.requested_at desc
    limit 1
  ) r on true
  where m.org_id = p_org_id
    and m.user_id = v_target_user_id;

  if v_before.role = v_role then
    return app_api.team_user_public_json(v_before, v_email, v_name);
  end if;

  update app.organization_members m
  set
    role = v_role,
    updated_at = now(),
    updated_by_actor = app_api.trim_text(p_actor)
  where m.org_id = p_org_id
    and m.user_id = v_target_user_id
  returning * into v_after;

  if v_before.role = 'admin' and v_role <> 'admin' then
    delete from app.admin_feature_permissions a
    where a.org_id = p_org_id
      and a.admin_user_id = v_target_user_id;
  end if;

  if v_after.status = 'active' and v_role = 'owner' then
    perform app_api.ensure_owner_notification_preference(p_org_id, v_target_user_id, app_api.trim_text(p_actor));
  elsif v_after.status = 'active' and v_role = 'admin' then
    perform app_api.ensure_admin_feature_permissions(p_org_id, v_target_user_id, true, app_api.trim_text(p_actor));
  end if;

  perform app_api.team_user_audit(
    p_org_id,
    'CHANGE_USER_ROLE',
    v_actor_user_id,
    p_actor,
    v_target_user_id,
    v_email,
    jsonb_build_object('role', v_before.role, 'status', v_before.status),
    jsonb_build_object('role', v_after.role, 'status', v_after.status)
  );

  return app_api.team_user_public_json(v_after, v_email, v_name);
end;
$$;

create or replace function public.api_disable_team_user(
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
  v_actor_user_id uuid := auth.uid();
  v_actor_role text;
  v_target_user_id uuid := nullif(app_api.trim_text(p_payload->>'userId'), '')::uuid;
  v_before app.organization_members;
  v_after app.organization_members;
  v_email text := '';
  v_name text := '';
begin
  v_actor_role := app_api.require_team_manager(p_org_id);

  if v_target_user_id is null then
    perform app_api.raise_http(400, 'userId is required.');
  end if;

  select *
  into v_before
  from app.organization_members m
  where m.org_id = p_org_id
    and m.user_id = v_target_user_id
  for update;

  if not found then
    perform app_api.raise_http(404, 'Target user is not a member of this organization.');
  end if;

  perform app_api.require_team_target_allowed(v_actor_role, v_target_user_id, v_before.role, null);

  select
    coalesce(nullif(u.email, ''), nullif(r.requested_by_email, '')),
    coalesce(nullif(u.raw_user_meta_data->>'full_name', ''), nullif(u.raw_user_meta_data->>'name', ''), nullif(r.requested_by_name, ''))
  into v_email, v_name
  from app.organization_members m
  left join auth.users u on u.id = m.user_id
  left join lateral (
    select a.requested_by_email, a.requested_by_name
    from app.access_requests a
    where a.org_id = m.org_id and a.user_id = m.user_id
    order by a.requested_at desc
    limit 1
  ) r on true
  where m.org_id = p_org_id
    and m.user_id = v_target_user_id;

  if v_before.status = 'disabled' then
    return app_api.team_user_public_json(v_before, v_email, v_name);
  end if;

  update app.organization_members m
  set
    status = 'disabled',
    disabled_at = now(),
    disabled_by_user_id = v_actor_user_id,
    updated_at = now(),
    updated_by_actor = app_api.trim_text(p_actor)
  where m.org_id = p_org_id
    and m.user_id = v_target_user_id
  returning * into v_after;

  insert into app.access_requests (
    org_id, user_id, status, requested_at, requested_by_email, requested_by_name,
    decided_at, decided_by_user_id, decided_by_actor, decision_note
  )
  values (
    p_org_id, v_target_user_id, 'denied', now(), v_email, v_name,
    now(), v_actor_user_id, app_api.trim_text(p_actor), 'Disabled by Team manager.'
  )
  on conflict (org_id, user_id) do update set
    status = 'denied',
    requested_by_email = coalesce(nullif(excluded.requested_by_email, ''), app.access_requests.requested_by_email),
    requested_by_name = coalesce(nullif(excluded.requested_by_name, ''), app.access_requests.requested_by_name),
    decided_at = excluded.decided_at,
    decided_by_user_id = excluded.decided_by_user_id,
    decided_by_actor = excluded.decided_by_actor,
    decision_note = excluded.decision_note;

  perform app_api.team_user_audit(
    p_org_id,
    'DISABLE_USER',
    v_actor_user_id,
    p_actor,
    v_target_user_id,
    v_email,
    jsonb_build_object('role', v_before.role, 'status', v_before.status),
    jsonb_build_object('role', v_after.role, 'status', v_after.status)
  );

  return app_api.team_user_public_json(v_after, v_email, v_name);
end;
$$;

create or replace function public.api_reenable_team_user(
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
  v_actor_user_id uuid := auth.uid();
  v_actor_role text;
  v_target_user_id uuid := nullif(app_api.trim_text(p_payload->>'userId'), '')::uuid;
  v_role text := lower(app_api.trim_text(p_payload->>'role'));
  v_before app.organization_members;
  v_after app.organization_members;
  v_user auth.users;
  v_next_status text := 'invited';
  v_access_status text := 'pending';
  v_email text := '';
  v_name text := '';
begin
  v_actor_role := app_api.require_team_manager(p_org_id);

  if v_target_user_id is null then
    perform app_api.raise_http(400, 'userId is required.');
  end if;
  if v_role not in ('owner', 'admin', 'member') then
    perform app_api.raise_http(400, 'A valid role is required.');
  end if;

  select *
  into v_before
  from app.organization_members m
  where m.org_id = p_org_id
    and m.user_id = v_target_user_id
  for update;

  if not found then
    perform app_api.raise_http(404, 'Target user is not a member of this organization.');
  end if;

  perform app_api.require_team_target_allowed(v_actor_role, v_target_user_id, v_before.role, v_role);

  select *
  into v_user
  from auth.users u
  where u.id = v_target_user_id
  for update;

  if not found then
    perform app_api.raise_http(409, 'The account could not be resolved safely. Contact support.');
  end if;

  if v_user.deleted_at is not null then
    perform app_api.raise_http(409, 'The account could not be resolved safely. Contact support.');
  end if;

  if coalesce(v_user.banned_until > now(), false)
     or lower(app_api.trim_text(v_user.raw_app_meta_data->>'disabled')) = 'true' then
    perform app_api.raise_http(409, 'This account is not available for organization access.');
  end if;

  v_email := app_api.trim_text(v_user.email);
  v_name := coalesce(
    nullif(app_api.trim_text(v_user.raw_user_meta_data->>'full_name'), ''),
    nullif(app_api.trim_text(v_user.raw_user_meta_data->>'name'), ''),
    app_api.derive_display_name_from_email(v_email)
  );

  if v_before.status = 'active' then
    return jsonb_build_object(
      'outcome', 'already_active',
      'entry', app_api.team_user_public_json(v_before, v_email, v_name)
    );
  end if;

  if v_before.status = 'invited' then
    return jsonb_build_object(
      'outcome', 'already_invited',
      'entry', app_api.team_user_public_json(v_before, v_email, v_name)
    );
  end if;

  if v_before.status <> 'disabled' then
    perform app_api.raise_http(409, 'The membership state could not be resolved safely.');
  end if;

  v_next_status := case
    when v_user.email_confirmed_at is not null or v_user.confirmed_at is not null then 'active'
    else 'invited'
  end;
  v_access_status := case when v_next_status = 'active' then 'approved' else 'pending' end;

  update app.organization_members m
  set
    role = v_role,
    status = v_next_status,
    disabled_at = null,
    disabled_by_user_id = null,
    updated_at = now(),
    updated_by_actor = app_api.trim_text(p_actor)
  where m.org_id = p_org_id
    and m.user_id = v_target_user_id
  returning * into v_after;

  if v_before.role = 'admin' and v_role <> 'admin' then
    delete from app.admin_feature_permissions a
    where a.org_id = p_org_id
      and a.admin_user_id = v_target_user_id;
  end if;

  insert into app.access_requests (
    org_id, user_id, status, requested_at, requested_by_email, requested_by_name,
    decided_at, decided_by_user_id, decided_by_actor, decision_note
  )
  values (
    p_org_id, v_target_user_id, v_access_status, now(), v_email, v_name,
    case when v_next_status = 'active' then now() else null end,
    case when v_next_status = 'active' then v_actor_user_id else null end,
    case when v_next_status = 'active' then app_api.trim_text(p_actor) else '' end,
    case
      when v_next_status = 'active' then 'Re-enabled by Team manager.'
      else 'Invitation restored by Team manager; confirmation is still required.'
    end
  )
  on conflict (org_id, user_id) do update set
    status = excluded.status,
    requested_by_email = excluded.requested_by_email,
    requested_by_name = excluded.requested_by_name,
    decided_at = excluded.decided_at,
    decided_by_user_id = excluded.decided_by_user_id,
    decided_by_actor = excluded.decided_by_actor,
    decision_note = excluded.decision_note;

  if v_after.status = 'active' and v_role = 'owner' then
    perform app_api.ensure_owner_notification_preference(p_org_id, v_target_user_id, app_api.trim_text(p_actor));
  elsif v_after.status = 'active' and v_role = 'admin' then
    perform app_api.ensure_admin_feature_permissions(p_org_id, v_target_user_id, true, app_api.trim_text(p_actor));
  end if;

  perform app_api.team_user_audit(
    p_org_id,
    'REENABLE_USER',
    v_actor_user_id,
    p_actor,
    v_target_user_id,
    v_email,
    jsonb_build_object('role', v_before.role, 'status', v_before.status),
    jsonb_build_object('role', v_after.role, 'status', v_after.status)
  );

  return jsonb_build_object(
    'outcome', 'reenabled',
    'entry', app_api.team_user_public_json(v_after, v_email, v_name)
  );
end;
$$;

select app_api.grant_execute_if_exists('public.api_list_memberships()', 'authenticated');
select app_api.grant_execute_if_exists('public.api_select_organization(uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_list_team_users(uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_add_team_member(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_record_team_invite(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_change_team_user_role(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_disable_team_user(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_reenable_team_user(uuid, text, jsonb)', 'authenticated');

revoke execute on function public.api_select_organization(uuid) from public, anon, service_role;
revoke execute on function public.api_list_memberships() from public, anon, service_role;
revoke execute on function public.api_add_team_member(uuid, text, jsonb) from public, anon, service_role;
revoke execute on function public.api_record_team_invite(uuid, text, jsonb) from public, anon, service_role;
revoke execute on function public.api_list_team_users(uuid) from public, anon, service_role;
revoke execute on function public.api_change_team_user_role(uuid, text, jsonb) from public, anon, service_role;
revoke execute on function public.api_disable_team_user(uuid, text, jsonb) from public, anon, service_role;
revoke execute on function public.api_reenable_team_user(uuid, text, jsonb) from public, anon, service_role;

grant execute on function public.api_select_organization(uuid) to authenticated;
grant execute on function public.api_add_team_member(uuid, text, jsonb) to authenticated;
grant execute on function public.api_record_team_invite(uuid, text, jsonb) to authenticated;
grant execute on function public.api_list_team_users(uuid) to authenticated;
grant execute on function public.api_change_team_user_role(uuid, text, jsonb) to authenticated;
grant execute on function public.api_disable_team_user(uuid, text, jsonb) to authenticated;
grant execute on function public.api_reenable_team_user(uuid, text, jsonb) to authenticated;
