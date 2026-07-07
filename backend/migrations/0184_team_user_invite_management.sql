-- Team / Users invite management.
-- Adds explicit membership lifecycle state, owner-only team RPCs, and a
-- dedicated audit log for user-management actions.

alter table app.organization_members
  add column if not exists status text not null default 'active',
  add column if not exists invited_at timestamptz,
  add column if not exists invited_by_user_id uuid,
  add column if not exists disabled_at timestamptz,
  add column if not exists disabled_by_user_id uuid,
  add column if not exists updated_at timestamptz,
  add column if not exists updated_by_actor text;

update app.organization_members
set status = 'active'
where status is null
   or status not in ('invited', 'active', 'disabled');

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'organization_members_status_check'
      and conrelid = 'app.organization_members'::regclass
  ) then
    alter table app.organization_members
      add constraint organization_members_status_check
      check (status in ('invited', 'active', 'disabled'));
  end if;
end;
$$;

create index if not exists organization_members_org_status_role_idx
  on app.organization_members(org_id, status, role);

create index if not exists organization_members_user_status_idx
  on app.organization_members(user_id, status);

create table if not exists app.team_user_audit_log (
  event_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations(id) on delete cascade,
  action text not null check (action in ('INVITE_USER', 'CHANGE_USER_ROLE', 'DISABLE_USER', 'REENABLE_USER')),
  actor_user_id uuid,
  actor_email text not null default '',
  actor_label text not null default '',
  target_user_id uuid,
  target_email text not null default '',
  before_state jsonb not null default '{}'::jsonb,
  after_state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table app.team_user_audit_log enable row level security;
drop policy if exists team_user_audit_owner_select on app.team_user_audit_log;
create policy team_user_audit_owner_select on app.team_user_audit_log
for select using (app.is_org_owner(org_id));

revoke all on table app.team_user_audit_log from public, anon, authenticated;
grant select, insert, update, delete on table app.team_user_audit_log to service_role;

create index if not exists team_user_audit_log_org_created_idx
  on app.team_user_audit_log(org_id, created_at desc);

create index if not exists team_user_audit_log_target_idx
  on app.team_user_audit_log(org_id, target_user_id, created_at desc);

create or replace function app.is_org_member(target_org_id uuid)
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
      and member_row.status = 'active'
  );
$$;

revoke all on function app.is_org_member(uuid) from public;
grant execute on function app.is_org_member(uuid) to authenticated, service_role;

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
      and member_row.status = 'active'
  );
$$;

revoke all on function app.is_org_owner(uuid) from public;
grant execute on function app.is_org_owner(uuid) to authenticated, service_role;

drop policy if exists members_write_owner on app.organization_members;
create policy members_write_owner on app.organization_members
for all
using (app.is_org_owner(org_id))
with check (app.is_org_owner(org_id));

create or replace function app.prevent_last_owner_loss()
returns trigger
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_remaining_owner_count integer;
  v_loses_active_owner boolean := false;
begin
  if tg_op = 'DELETE' and old.role = 'owner' and old.status = 'active' then
    v_loses_active_owner := true;
  elsif tg_op = 'UPDATE' and old.role = 'owner' and old.status = 'active' then
    v_loses_active_owner := not (
      new.org_id = old.org_id
      and new.user_id = old.user_id
      and new.role = 'owner'
      and new.status = 'active'
    );
  end if;

  if v_loses_active_owner then
    select count(*)
    into v_remaining_owner_count
    from app.organization_members m
    where m.org_id = old.org_id
      and m.role = 'owner'
      and m.status = 'active'
      and m.user_id <> old.user_id;

    if v_remaining_owner_count = 0 then
      perform app_api.raise_http(400, 'At least one active owner must remain in this organization.');
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_prevent_last_owner_loss on app.organization_members;
create trigger trg_prevent_last_owner_loss
before update or delete on app.organization_members
for each row
execute function app.prevent_last_owner_loss();

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
    );

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

create or replace function app_api.require_org_member_approved(p_org_id uuid)
returns text
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
begin
  if v_user_id is null then
    perform app_api.raise_http(401, 'Authenticated session is required.');
  end if;

  if p_org_id is null then
    perform app_api.raise_http(400, 'Organization is required.');
  end if;

  perform app_api.activate_confirmed_invite_membership(p_org_id);

  select m.role
  into v_role
  from app.organization_members m
  where m.org_id = p_org_id
    and m.user_id = v_user_id
    and m.status = 'active';

  if v_role is null then
    perform app_api.raise_http(403, 'You do not have active access to this inventory workspace.');
  end if;

  insert into app.access_requests (
    org_id,
    user_id,
    status,
    requested_at,
    requested_by_email,
    decided_at,
    decided_by_user_id,
    decided_by_actor,
    decision_note
  )
  values (
    p_org_id,
    v_user_id,
    'approved',
    now(),
    app_api.trim_text((auth.jwt()->>'email')),
    now(),
    v_user_id,
    'auto-approved from active membership',
    ''
  )
  on conflict (org_id, user_id) do nothing;

  update app.access_requests r
  set
    status = 'approved',
    decided_at = now(),
    decided_by_user_id = v_user_id,
    decided_by_actor = 'auto-approved from active membership',
    decision_note = ''
  where r.org_id = p_org_id
    and r.user_id = v_user_id
    and r.status <> 'approved';

  if v_role = 'owner' then
    perform app_api.ensure_owner_notification_preference(
      p_org_id,
      v_user_id,
      'auto-seed owner preference'
    );
  end if;

  if v_role = 'admin' then
    perform app_api.ensure_admin_feature_permissions(
      p_org_id,
      v_user_id,
      false,
      'auto-seed admin permissions'
    );
  end if;

  return v_role;
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
        'role', m.role,
        'status', m.status,
        'created_at', to_char(m.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
      order by m.created_at asc, m.org_id asc
    ),
    '[]'::jsonb
  )
  into v_result
  from app.organization_members m
  where m.user_id = auth.uid()
    and m.status = 'active';

  return v_result;
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

create or replace function app_api.team_user_audit(
  p_org_id uuid,
  p_action text,
  p_actor_user_id uuid,
  p_actor_label text,
  p_target_user_id uuid,
  p_target_email text,
  p_before_state jsonb,
  p_after_state jsonb
)
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  insert into app.team_user_audit_log (
    org_id,
    action,
    actor_user_id,
    actor_email,
    actor_label,
    target_user_id,
    target_email,
    before_state,
    after_state
  )
  values (
    p_org_id,
    p_action,
    p_actor_user_id,
    app_api.trim_text(auth.jwt()->>'email'),
    app_api.trim_text(p_actor_label),
    p_target_user_id,
    app_api.trim_text(p_target_email),
    coalesce(p_before_state, '{}'::jsonb),
    coalesce(p_after_state, '{}'::jsonb)
  );
end;
$$;

create or replace function app_api.team_user_public_json(
  p_member app.organization_members,
  p_email text,
  p_name text
)
returns jsonb
language sql
stable
set search_path = public, app, app_api
as $$
  select jsonb_build_object(
    'userId', p_member.user_id,
    'email', coalesce(app_api.trim_text(p_email), ''),
    'name', coalesce(nullif(app_api.trim_text(p_name), ''), app_api.derive_display_name_from_email(app_api.trim_text(p_email))),
    'role', p_member.role,
    'status', p_member.status,
    'createdAt', coalesce(to_char(p_member.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''),
    'invitedAt', coalesce(to_char(p_member.invited_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''),
    'disabledAt', coalesce(to_char(p_member.disabled_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''),
    'updatedAt', coalesce(to_char(p_member.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '')
  );
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
  perform app_api.require_org_owner(p_org_id);

  select coalesce(
    jsonb_agg(
      app_api.team_user_public_json(
        m,
        coalesce(nullif(u.email, ''), nullif(r.requested_by_email, '')),
        coalesce(nullif(r.requested_by_name, ''), nullif(u.raw_user_meta_data->>'full_name', ''), nullif(u.raw_user_meta_data->>'name', ''))
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

create or replace function public.api_prepare_team_invite(
  p_org_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_email text := lower(app_api.trim_text(p_payload->>'email'));
  v_role text := lower(app_api.trim_text(p_payload->>'role'));
  v_name text := app_api.trim_text(p_payload->>'name');
  v_user_id uuid;
  v_current app.organization_members;
  v_conflict app.organization_members;
begin
  perform app_api.require_org_owner(p_org_id);

  if v_email = '' or position('@' in v_email) <= 1 then
    perform app_api.raise_http(400, 'A valid email is required.');
  end if;

  if v_role not in ('owner', 'admin', 'member') then
    perform app_api.raise_http(400, 'A valid role is required.');
  end if;

  select u.id
  into v_user_id
  from auth.users u
  where lower(u.email) = v_email
  order by u.created_at asc
  limit 1;

  if v_user_id is not null then
    select *
    into v_current
    from app.organization_members m
    where m.org_id = p_org_id
      and m.user_id = v_user_id;

    if found and v_current.status = 'active' then
      return jsonb_build_object(
        'action', 'already-member',
        'userId', v_user_id,
        'email', v_email,
        'role', v_current.role,
        'status', v_current.status
      );
    end if;

    if found and v_current.status = 'invited' then
      return jsonb_build_object(
        'action', 'already-invited',
        'userId', v_user_id,
        'email', v_email,
        'role', v_current.role,
        'status', v_current.status
      );
    end if;

    if found and v_current.status = 'disabled' then
      return jsonb_build_object(
        'action', 'current-disabled',
        'userId', v_user_id,
        'email', v_email,
        'role', v_current.role,
        'status', v_current.status
      );
    end if;

    select *
    into v_conflict
    from app.organization_members m
    where m.user_id = v_user_id
      and m.org_id <> p_org_id
      and m.status in ('active', 'invited')
    limit 1;

    if found then
      perform app_api.raise_http(409, 'This email is already attached to another active or invited organization.');
    end if;

    return jsonb_build_object(
      'action', 'existing-user-unsupported',
      'userId', v_user_id,
      'email', v_email,
      'name', v_name,
      'role', v_role
    );
  end if;

  return jsonb_build_object(
    'action', 'invite-new-user',
    'email', v_email,
    'name', v_name,
    'role', v_role
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
  v_user_id uuid := nullif(app_api.trim_text(p_payload->>'userId'), '')::uuid;
  v_email text := lower(app_api.trim_text(p_payload->>'email'));
  v_name text := app_api.trim_text(p_payload->>'name');
  v_role text := lower(app_api.trim_text(p_payload->>'role'));
  v_existing app.organization_members;
  v_conflict app.organization_members;
  v_member app.organization_members;
begin
  perform app_api.require_org_owner(p_org_id);

  if v_user_id is null then
    perform app_api.raise_http(400, 'userId is required after invite.');
  end if;

  if v_email = '' then
    select lower(app_api.trim_text(u.email))
    into v_email
    from auth.users u
    where u.id = v_user_id;
  end if;

  if v_email = '' then
    perform app_api.raise_http(400, 'Invite email is required.');
  end if;

  if v_role not in ('owner', 'admin', 'member') then
    perform app_api.raise_http(400, 'A valid role is required.');
  end if;

  select *
  into v_conflict
  from app.organization_members m
  where m.user_id = v_user_id
    and m.org_id <> p_org_id
    and m.status in ('active', 'invited')
  limit 1;

  if found then
    perform app_api.raise_http(409, 'This email is already attached to another active or invited organization.');
  end if;

  select *
  into v_existing
  from app.organization_members m
  where m.org_id = p_org_id
    and m.user_id = v_user_id
  for update;

  if found and v_existing.status = 'active' then
    return jsonb_build_object(
      'userId', v_user_id,
      'email', v_email,
      'role', v_existing.role,
      'status', 'active',
      'alreadyMember', true
    );
  end if;

  if found and v_existing.status = 'invited' then
    return jsonb_build_object(
      'userId', v_user_id,
      'email', v_email,
      'role', v_existing.role,
      'status', 'invited',
      'alreadyInvited', true
    );
  end if;

  if found and v_existing.status = 'disabled' then
    perform app_api.raise_http(409, 'This user is disabled in this organization. Re-enable them instead of inviting again.');
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
    'invited',
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
    'pending',
    now(),
    v_email,
    v_name,
    null,
    null,
    '',
    'Invited by owner.'
  )
  on conflict (org_id, user_id) do update set
    status = 'pending',
    requested_at = excluded.requested_at,
    requested_by_email = excluded.requested_by_email,
    requested_by_name = excluded.requested_by_name,
    decided_at = null,
    decided_by_user_id = null,
    decided_by_actor = '',
    decision_note = excluded.decision_note;

  perform app_api.team_user_audit(
    p_org_id,
    'INVITE_USER',
    v_actor_user_id,
    p_actor,
    v_user_id,
    v_email,
    '{}'::jsonb,
    jsonb_build_object('role', v_role, 'status', 'invited')
  );

  return app_api.team_user_public_json(v_member, v_email, v_name);
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
  v_target_user_id uuid := nullif(app_api.trim_text(p_payload->>'userId'), '')::uuid;
  v_role text := lower(app_api.trim_text(p_payload->>'role'));
  v_before app.organization_members;
  v_after app.organization_members;
  v_email text := '';
  v_name text := '';
begin
  perform app_api.require_org_owner(p_org_id);

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

  select
    coalesce(nullif(u.email, ''), nullif(r.requested_by_email, '')),
    coalesce(nullif(r.requested_by_name, ''), nullif(u.raw_user_meta_data->>'full_name', ''), nullif(u.raw_user_meta_data->>'name', ''))
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
  v_target_user_id uuid := nullif(app_api.trim_text(p_payload->>'userId'), '')::uuid;
  v_before app.organization_members;
  v_after app.organization_members;
  v_email text := '';
  v_name text := '';
begin
  perform app_api.require_org_owner(p_org_id);

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

  select
    coalesce(nullif(u.email, ''), nullif(r.requested_by_email, '')),
    coalesce(nullif(r.requested_by_name, ''), nullif(u.raw_user_meta_data->>'full_name', ''), nullif(u.raw_user_meta_data->>'name', ''))
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
    v_target_user_id,
    'denied',
    now(),
    v_email,
    v_name,
    now(),
    v_actor_user_id,
    app_api.trim_text(p_actor),
    'Disabled by owner.'
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
  v_target_user_id uuid := nullif(app_api.trim_text(p_payload->>'userId'), '')::uuid;
  v_before app.organization_members;
  v_after app.organization_members;
  v_next_status text := 'invited';
  v_access_request_status text := 'pending';
  v_email text := '';
  v_name text := '';
begin
  perform app_api.require_org_owner(p_org_id);

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

  if v_before.status <> 'disabled' then
    perform app_api.raise_http(400, 'Only disabled users can be re-enabled.');
  end if;

  select
    coalesce(nullif(u.email, ''), nullif(r.requested_by_email, '')),
    coalesce(nullif(r.requested_by_name, ''), nullif(u.raw_user_meta_data->>'full_name', ''), nullif(u.raw_user_meta_data->>'name', '')),
    case
      when u.email_confirmed_at is not null or u.confirmed_at is not null then 'active'
      else 'invited'
    end
  into v_email, v_name, v_next_status
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

  v_next_status := coalesce(nullif(v_next_status, ''), 'invited');
  v_access_request_status := case when v_next_status = 'active' then 'approved' else 'pending' end;

  update app.organization_members m
  set
    status = v_next_status,
    disabled_at = null,
    disabled_by_user_id = null,
    updated_at = now(),
    updated_by_actor = app_api.trim_text(p_actor)
  where m.org_id = p_org_id
    and m.user_id = v_target_user_id
  returning * into v_after;

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
    v_target_user_id,
    v_access_request_status,
    now(),
    v_email,
    v_name,
    case when v_next_status = 'active' then now() else null end,
    case when v_next_status = 'active' then v_actor_user_id else null end,
    case when v_next_status = 'active' then app_api.trim_text(p_actor) else '' end,
    case
      when v_next_status = 'active' then 'Re-enabled by owner.'
      else 'Invite restored by owner; acceptance is still required.'
    end
  )
  on conflict (org_id, user_id) do update set
    status = excluded.status,
    requested_by_email = coalesce(nullif(excluded.requested_by_email, ''), app.access_requests.requested_by_email),
    requested_by_name = coalesce(nullif(excluded.requested_by_name, ''), app.access_requests.requested_by_name),
    decided_at = excluded.decided_at,
    decided_by_user_id = excluded.decided_by_user_id,
    decided_by_actor = excluded.decided_by_actor,
    decision_note = excluded.decision_note;

  if v_after.status = 'active' and v_after.role = 'owner' then
    perform app_api.ensure_owner_notification_preference(p_org_id, v_target_user_id, app_api.trim_text(p_actor));
  elsif v_after.status = 'active' and v_after.role = 'admin' then
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

  return app_api.team_user_public_json(v_after, v_email, v_name);
end;
$$;

select app_api.grant_execute_if_exists('public.api_list_memberships()', 'authenticated');
select app_api.grant_execute_if_exists('public.api_get_auth_context(uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_list_team_users(uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_prepare_team_invite(uuid, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_record_team_invite(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_change_team_user_role(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_disable_team_user(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_reenable_team_user(uuid, text, jsonb)', 'authenticated');

revoke execute on function public.api_list_team_users(uuid) from public, anon, service_role;
revoke execute on function public.api_prepare_team_invite(uuid, jsonb) from public, anon, service_role;
revoke execute on function public.api_record_team_invite(uuid, text, jsonb) from public, anon, service_role;
revoke execute on function public.api_change_team_user_role(uuid, text, jsonb) from public, anon, service_role;
revoke execute on function public.api_disable_team_user(uuid, text, jsonb) from public, anon, service_role;
revoke execute on function public.api_reenable_team_user(uuid, text, jsonb) from public, anon, service_role;

grant execute on function public.api_list_team_users(uuid) to authenticated;
grant execute on function public.api_prepare_team_invite(uuid, jsonb) to authenticated;
grant execute on function public.api_record_team_invite(uuid, text, jsonb) to authenticated;
grant execute on function public.api_change_team_user_role(uuid, text, jsonb) to authenticated;
grant execute on function public.api_disable_team_user(uuid, text, jsonb) to authenticated;
grant execute on function public.api_reenable_team_user(uuid, text, jsonb) to authenticated;
