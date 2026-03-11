-- Owner/Admin/Member access control and approval workflow.

create table if not exists app.access_requests (
  org_id uuid not null references app.organizations(id) on delete cascade,
  user_id uuid not null,
  status text not null check (status in ('pending', 'approved', 'denied')),
  requested_at timestamptz not null default now(),
  requested_by_email text not null default '',
  decided_at timestamptz,
  decided_by_user_id uuid,
  decided_by_actor text not null default '',
  decision_note text not null default '',
  primary key (org_id, user_id)
);

create table if not exists app.general_feature_permissions (
  org_id uuid not null references app.organizations(id) on delete cascade,
  feature_area text not null check (feature_area in (
    'inventory',
    'allocations',
    'jobs',
    'film_orders',
    'activity_history',
    'reports'
  )),
  read_enabled boolean not null default true,
  write_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by text not null default '',
  primary key (org_id, feature_area)
);

create table if not exists app.admin_feature_permissions (
  org_id uuid not null references app.organizations(id) on delete cascade,
  admin_user_id uuid not null,
  feature_area text not null check (feature_area in (
    'inventory',
    'allocations',
    'jobs',
    'film_orders',
    'activity_history',
    'reports',
    'access_management'
  )),
  read_enabled boolean not null default true,
  write_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by text not null default '',
  primary key (org_id, admin_user_id, feature_area),
  foreign key (org_id, admin_user_id) references app.organization_members(org_id, user_id) on delete cascade
);

create table if not exists app.owner_notification_preferences (
  org_id uuid not null references app.organizations(id) on delete cascade,
  owner_user_id uuid not null,
  in_app_opt_in boolean not null default true,
  email_opt_in boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by text not null default '',
  primary key (org_id, owner_user_id),
  foreign key (org_id, owner_user_id) references app.organization_members(org_id, user_id) on delete cascade
);

create index if not exists idx_access_requests_org_status_requested
  on app.access_requests (org_id, status, requested_at asc);

create index if not exists idx_admin_feature_permissions_org_admin
  on app.admin_feature_permissions (org_id, admin_user_id);

alter table app.access_requests enable row level security;
alter table app.general_feature_permissions enable row level security;
alter table app.admin_feature_permissions enable row level security;
alter table app.owner_notification_preferences enable row level security;

drop policy if exists access_requests_read on app.access_requests;
create policy access_requests_read on app.access_requests
for select using (app.is_org_member(org_id) or user_id = auth.uid());

drop policy if exists general_feature_permissions_read on app.general_feature_permissions;
create policy general_feature_permissions_read on app.general_feature_permissions
for select using (app.is_org_member(org_id));

drop policy if exists admin_feature_permissions_read on app.admin_feature_permissions;
create policy admin_feature_permissions_read on app.admin_feature_permissions
for select using (app.is_org_member(org_id));

drop policy if exists owner_notification_preferences_read on app.owner_notification_preferences;
create policy owner_notification_preferences_read on app.owner_notification_preferences
for select using (app.is_org_member(org_id));

drop policy if exists owner_notification_preferences_write_self on app.owner_notification_preferences;
create policy owner_notification_preferences_write_self on app.owner_notification_preferences
for update using (
  owner_user_id = auth.uid()
  and exists (
    select 1
    from app.organization_members m
    where m.org_id = org_id
      and m.user_id = auth.uid()
      and m.role = 'owner'
  )
) with check (
  owner_user_id = auth.uid()
  and exists (
    select 1
    from app.organization_members m
    where m.org_id = org_id
      and m.user_id = auth.uid()
      and m.role = 'owner'
  )
);

-- Tighten direct writes to organization_members so role transitions happen through guarded RPCs.
drop policy if exists members_write on app.organization_members;
drop policy if exists members_write_owner on app.organization_members;
create policy members_write_owner on app.organization_members
for all using (
  exists (
    select 1
    from app.organization_members self
    where self.org_id = org_id
      and self.user_id = auth.uid()
      and self.role = 'owner'
  )
) with check (
  exists (
    select 1
    from app.organization_members self
    where self.org_id = org_id
      and self.user_id = auth.uid()
      and self.role = 'owner'
  )
);

create or replace function app.prevent_last_owner_loss()
returns trigger
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_remaining_owner_count integer;
begin
  if tg_op = 'DELETE' and old.role = 'owner' then
    select count(*)
    into v_remaining_owner_count
    from app.organization_members m
    where m.org_id = old.org_id
      and m.role = 'owner'
      and m.user_id <> old.user_id;

    if v_remaining_owner_count = 0 then
      perform app_api.raise_http(400, 'At least one owner must remain in this organization.');
    end if;
  end if;

  if tg_op = 'UPDATE' and old.role = 'owner' and new.role <> 'owner' then
    select count(*)
    into v_remaining_owner_count
    from app.organization_members m
    where m.org_id = old.org_id
      and m.role = 'owner'
      and m.user_id <> old.user_id;

    if v_remaining_owner_count = 0 then
      perform app_api.raise_http(400, 'At least one owner must remain in this organization.');
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

create or replace function app_api.member_feature_areas()
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
    'reports'
  ]::text[];
$$;

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
    'access_management'
  ]::text[];
$$;

create or replace function app_api.feature_access_json(p_read boolean, p_write boolean)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'read', coalesce(p_read, false),
    'write', coalesce(p_write, false)
  );
$$;

create or replace function app_api.ensure_general_feature_permissions(p_org_id uuid, p_actor text default 'system')
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_feature text;
begin
  if p_org_id is null then
    return;
  end if;

  foreach v_feature in array app_api.member_feature_areas() loop
    insert into app.general_feature_permissions (
      org_id,
      feature_area,
      read_enabled,
      write_enabled,
      updated_at,
      updated_by
    )
    values (
      p_org_id,
      v_feature,
      true,
      true,
      now(),
      app_api.trim_text(p_actor)
    )
    on conflict (org_id, feature_area) do nothing;
  end loop;
end;
$$;

create or replace function app_api.ensure_owner_notification_preference(
  p_org_id uuid,
  p_owner_user_id uuid,
  p_actor text default 'system'
)
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  if p_org_id is null or p_owner_user_id is null then
    return;
  end if;

  insert into app.owner_notification_preferences (
    org_id,
    owner_user_id,
    in_app_opt_in,
    email_opt_in,
    updated_at,
    updated_by
  )
  values (
    p_org_id,
    p_owner_user_id,
    true,
    true,
    now(),
    app_api.trim_text(p_actor)
  )
  on conflict (org_id, owner_user_id) do nothing;
end;
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
    if p_copy_member_defaults and v_feature <> 'access_management' then
      select g.read_enabled, g.write_enabled
      into v_read, v_write
      from app.general_feature_permissions g
      where g.org_id = p_org_id
        and g.feature_area = v_feature;
      v_read := coalesce(v_read, true);
      v_write := coalesce(v_write, true);
    elsif p_copy_member_defaults and v_feature = 'access_management' then
      v_read := true;
      v_write := true;
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

  select m.role
  into v_role
  from app.organization_members m
  where m.org_id = p_org_id
    and m.user_id = v_user_id;

  if v_role is null then
    perform app_api.raise_http(403, 'You do not have access to this inventory workspace.');
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
    'auto-approved from membership',
    ''
  )
  on conflict (org_id, user_id) do nothing;

  update app.access_requests r
  set
    status = 'approved',
    decided_at = now(),
    decided_by_user_id = v_user_id,
    decided_by_actor = 'auto-approved from membership',
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

create or replace function app_api.require_org_member(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_org_member_approved(p_org_id);
end;
$$;

create or replace function app_api.require_org_admin_or_owner(p_org_id uuid)
returns text
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_role text;
begin
  v_role := app_api.require_org_member_approved(p_org_id);
  if v_role not in ('admin', 'owner') then
    perform app_api.raise_http(403, 'Admin or owner access is required.');
  end if;
  return v_role;
end;
$$;

create or replace function app_api.require_org_owner(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_role text;
begin
  v_role := app_api.require_org_member_approved(p_org_id);
  if v_role <> 'owner' then
    perform app_api.raise_http(403, 'Owner access is required.');
  end if;
end;
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
  v_allowed boolean := false;
begin
  if app_api.trim_text(p_access_mode) not in ('read', 'write') then
    perform app_api.raise_http(400, 'Feature access mode must be read or write.');
  end if;

  v_role := app_api.require_org_member_approved(p_org_id);
  perform app_api.ensure_general_feature_permissions(p_org_id, 'feature-access-check');

  if v_role = 'owner' then
    return;
  end if;

  if v_role = 'member' then
    if p_feature_area = 'access_management' then
      perform app_api.raise_http(403, 'Feature access denied.');
    end if;

    if p_feature_area <> all(app_api.member_feature_areas()) then
      perform app_api.raise_http(400, 'Unsupported feature area.');
    end if;

    select
      case
        when p_access_mode = 'read' then g.read_enabled
        else g.write_enabled
      end
    into v_allowed
    from app.general_feature_permissions g
    where g.org_id = p_org_id
      and g.feature_area = p_feature_area;
  elsif v_role = 'admin' then
    if p_feature_area <> all(app_api.admin_feature_areas()) then
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
        when p_access_mode = 'read' then a.read_enabled
        else a.write_enabled
      end
    into v_allowed
    from app.admin_feature_permissions a
    where a.org_id = p_org_id
      and a.admin_user_id = auth.uid()
      and a.feature_area = p_feature_area;
  else
    perform app_api.raise_http(403, 'Feature access denied.');
  end if;

  if not coalesce(v_allowed, false) then
    perform app_api.raise_http(403, 'Feature access denied.');
  end if;
end;
$$;

create or replace function app_api.member_permissions_json(p_org_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select jsonb_build_object(
    'inventory', app_api.feature_access_json(
      coalesce((select read_enabled from app.general_feature_permissions where org_id = p_org_id and feature_area = 'inventory'), true),
      coalesce((select write_enabled from app.general_feature_permissions where org_id = p_org_id and feature_area = 'inventory'), true)
    ),
    'allocations', app_api.feature_access_json(
      coalesce((select read_enabled from app.general_feature_permissions where org_id = p_org_id and feature_area = 'allocations'), true),
      coalesce((select write_enabled from app.general_feature_permissions where org_id = p_org_id and feature_area = 'allocations'), true)
    ),
    'jobs', app_api.feature_access_json(
      coalesce((select read_enabled from app.general_feature_permissions where org_id = p_org_id and feature_area = 'jobs'), true),
      coalesce((select write_enabled from app.general_feature_permissions where org_id = p_org_id and feature_area = 'jobs'), true)
    ),
    'film_orders', app_api.feature_access_json(
      coalesce((select read_enabled from app.general_feature_permissions where org_id = p_org_id and feature_area = 'film_orders'), true),
      coalesce((select write_enabled from app.general_feature_permissions where org_id = p_org_id and feature_area = 'film_orders'), true)
    ),
    'activity_history', app_api.feature_access_json(
      coalesce((select read_enabled from app.general_feature_permissions where org_id = p_org_id and feature_area = 'activity_history'), true),
      coalesce((select write_enabled from app.general_feature_permissions where org_id = p_org_id and feature_area = 'activity_history'), true)
    ),
    'reports', app_api.feature_access_json(
      coalesce((select read_enabled from app.general_feature_permissions where org_id = p_org_id and feature_area = 'reports'), true),
      coalesce((select write_enabled from app.general_feature_permissions where org_id = p_org_id and feature_area = 'reports'), true)
    ),
    'access_management', app_api.feature_access_json(false, false)
  );
$$;

create or replace function app_api.admin_permissions_json(p_org_id uuid, p_admin_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select jsonb_build_object(
    'inventory', app_api.feature_access_json(
      coalesce((select read_enabled from app.admin_feature_permissions where org_id = p_org_id and admin_user_id = p_admin_user_id and feature_area = 'inventory'), coalesce((select read_enabled from app.general_feature_permissions where org_id = p_org_id and feature_area = 'inventory'), true)),
      coalesce((select write_enabled from app.admin_feature_permissions where org_id = p_org_id and admin_user_id = p_admin_user_id and feature_area = 'inventory'), coalesce((select write_enabled from app.general_feature_permissions where org_id = p_org_id and feature_area = 'inventory'), true))
    ),
    'allocations', app_api.feature_access_json(
      coalesce((select read_enabled from app.admin_feature_permissions where org_id = p_org_id and admin_user_id = p_admin_user_id and feature_area = 'allocations'), coalesce((select read_enabled from app.general_feature_permissions where org_id = p_org_id and feature_area = 'allocations'), true)),
      coalesce((select write_enabled from app.admin_feature_permissions where org_id = p_org_id and admin_user_id = p_admin_user_id and feature_area = 'allocations'), coalesce((select write_enabled from app.general_feature_permissions where org_id = p_org_id and feature_area = 'allocations'), true))
    ),
    'jobs', app_api.feature_access_json(
      coalesce((select read_enabled from app.admin_feature_permissions where org_id = p_org_id and admin_user_id = p_admin_user_id and feature_area = 'jobs'), coalesce((select read_enabled from app.general_feature_permissions where org_id = p_org_id and feature_area = 'jobs'), true)),
      coalesce((select write_enabled from app.admin_feature_permissions where org_id = p_org_id and admin_user_id = p_admin_user_id and feature_area = 'jobs'), coalesce((select write_enabled from app.general_feature_permissions where org_id = p_org_id and feature_area = 'jobs'), true))
    ),
    'film_orders', app_api.feature_access_json(
      coalesce((select read_enabled from app.admin_feature_permissions where org_id = p_org_id and admin_user_id = p_admin_user_id and feature_area = 'film_orders'), coalesce((select read_enabled from app.general_feature_permissions where org_id = p_org_id and feature_area = 'film_orders'), true)),
      coalesce((select write_enabled from app.admin_feature_permissions where org_id = p_org_id and admin_user_id = p_admin_user_id and feature_area = 'film_orders'), coalesce((select write_enabled from app.general_feature_permissions where org_id = p_org_id and feature_area = 'film_orders'), true))
    ),
    'activity_history', app_api.feature_access_json(
      coalesce((select read_enabled from app.admin_feature_permissions where org_id = p_org_id and admin_user_id = p_admin_user_id and feature_area = 'activity_history'), coalesce((select read_enabled from app.general_feature_permissions where org_id = p_org_id and feature_area = 'activity_history'), true)),
      coalesce((select write_enabled from app.admin_feature_permissions where org_id = p_org_id and admin_user_id = p_admin_user_id and feature_area = 'activity_history'), coalesce((select write_enabled from app.general_feature_permissions where org_id = p_org_id and feature_area = 'activity_history'), true))
    ),
    'reports', app_api.feature_access_json(
      coalesce((select read_enabled from app.admin_feature_permissions where org_id = p_org_id and admin_user_id = p_admin_user_id and feature_area = 'reports'), coalesce((select read_enabled from app.general_feature_permissions where org_id = p_org_id and feature_area = 'reports'), true)),
      coalesce((select write_enabled from app.admin_feature_permissions where org_id = p_org_id and admin_user_id = p_admin_user_id and feature_area = 'reports'), coalesce((select write_enabled from app.general_feature_permissions where org_id = p_org_id and feature_area = 'reports'), true))
    ),
    'access_management', app_api.feature_access_json(
      coalesce((select read_enabled from app.admin_feature_permissions where org_id = p_org_id and admin_user_id = p_admin_user_id and feature_area = 'access_management'), true),
      coalesce((select write_enabled from app.admin_feature_permissions where org_id = p_org_id and admin_user_id = p_admin_user_id and feature_area = 'access_management'), true)
    )
  );
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
        requested_by_email
      )
      values (
        p_org_id,
        v_user_id,
        'pending',
        now(),
        v_email
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

create or replace function public.api_list_access_notification_recipients(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    perform app_api.raise_http(403, 'Service role is required.');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'user_id', m.user_id,
        'role', m.role
      )
      order by m.role asc, m.user_id asc
    ),
    '[]'::jsonb
  )
  into v_result
  from app.organization_members m
  left join app.owner_notification_preferences p
    on p.org_id = m.org_id
   and p.owner_user_id = m.user_id
  where m.org_id = p_org_id
    and (
      m.role = 'admin'
      or (m.role = 'owner' and coalesce(p.email_opt_in, true))
    );

  return v_result;
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

create or replace function public.api_approve_access_request(
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
  v_current_role text;
  v_effective_role text;
begin
  v_actor_role := app_api.require_org_admin_or_owner(p_org_id);
  if v_actor_role = 'admin' then
    perform app_api.require_effective_feature_access(p_org_id, 'access_management', 'write');
  end if;

  if v_target_user_id is null then
    perform app_api.raise_http(400, 'userId is required.');
  end if;

  select m.role
  into v_current_role
  from app.organization_members m
  where m.org_id = p_org_id
    and m.user_id = v_target_user_id;

  if v_current_role is null then
    insert into app.organization_members (
      org_id,
      user_id,
      role,
      created_at
    )
    values (
      p_org_id,
      v_target_user_id,
      'member',
      now()
    )
    on conflict (org_id, user_id) do nothing;

    v_effective_role := 'member';
  else
    v_effective_role := v_current_role;
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
    v_target_user_id,
    'approved',
    now(),
    '',
    now(),
    auth.uid(),
    app_api.trim_text(p_actor),
    app_api.trim_text(p_payload->>'note')
  )
  on conflict (org_id, user_id) do update set
    status = 'approved',
    decided_at = excluded.decided_at,
    decided_by_user_id = excluded.decided_by_user_id,
    decided_by_actor = excluded.decided_by_actor,
    decision_note = excluded.decision_note;

  if v_effective_role = 'admin' then
    perform app_api.ensure_admin_feature_permissions(
      p_org_id,
      v_target_user_id,
      false,
      app_api.trim_text(p_actor)
    );
  elsif v_effective_role = 'owner' then
    perform app_api.ensure_owner_notification_preference(
      p_org_id,
      v_target_user_id,
      app_api.trim_text(p_actor)
    );
  end if;

  return jsonb_build_object(
    'userId', v_target_user_id,
    'status', 'approved',
    'role', v_effective_role
  );
end;
$$;

create or replace function public.api_deny_access_request(
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
  v_existing_role text;
begin
  v_actor_role := app_api.require_org_admin_or_owner(p_org_id);
  if v_actor_role = 'admin' then
    perform app_api.require_effective_feature_access(p_org_id, 'access_management', 'write');
  end if;

  if v_target_user_id is null then
    perform app_api.raise_http(400, 'userId is required.');
  end if;

  select m.role
  into v_existing_role
  from app.organization_members m
  where m.org_id = p_org_id
    and m.user_id = v_target_user_id;

  if v_existing_role is not null then
    perform app_api.raise_http(400, 'This user is already a workspace member and cannot be denied.');
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
    v_target_user_id,
    'denied',
    now(),
    '',
    now(),
    auth.uid(),
    app_api.trim_text(p_actor),
    app_api.trim_text(p_payload->>'note')
  )
  on conflict (org_id, user_id) do update set
    status = 'denied',
    decided_at = excluded.decided_at,
    decided_by_user_id = excluded.decided_by_user_id,
    decided_by_actor = excluded.decided_by_actor,
    decision_note = excluded.decision_note;

  return jsonb_build_object(
    'userId', v_target_user_id,
    'status', 'denied'
  );
end;
$$;

create or replace function public.api_get_member_feature_permissions(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_actor_role text;
begin
  v_actor_role := app_api.require_org_admin_or_owner(p_org_id);
  if v_actor_role = 'admin' then
    perform app_api.require_effective_feature_access(p_org_id, 'access_management', 'read');
  end if;

  perform app_api.ensure_general_feature_permissions(p_org_id, 'read-member-feature-permissions');
  return app_api.member_permissions_json(p_org_id);
end;
$$;

create or replace function public.api_update_member_feature_permissions(
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
  v_feature text;
  v_read text;
  v_write text;
begin
  v_actor_role := app_api.require_org_admin_or_owner(p_org_id);
  if v_actor_role = 'admin' then
    perform app_api.require_effective_feature_access(p_org_id, 'access_management', 'write');
  end if;

  perform app_api.ensure_general_feature_permissions(p_org_id, app_api.trim_text(p_actor));

  foreach v_feature in array app_api.member_feature_areas() loop
    if not ((p_payload->'permissions') ? v_feature) then
      continue;
    end if;

    v_read := lower(app_api.trim_text((p_payload->'permissions'->v_feature->>'read')));
    v_write := lower(app_api.trim_text((p_payload->'permissions'->v_feature->>'write')));

    update app.general_feature_permissions g
    set
      read_enabled = case when v_read in ('true', 'false') then v_read::boolean else g.read_enabled end,
      write_enabled = case when v_write in ('true', 'false') then v_write::boolean else g.write_enabled end,
      updated_at = now(),
      updated_by = app_api.trim_text(p_actor)
    where g.org_id = p_org_id
      and g.feature_area = v_feature;
  end loop;

  return app_api.member_permissions_json(p_org_id);
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
        'role', m.role,
        'permissions', app_api.admin_permissions_json(p_org_id, m.user_id)
      )
      order by m.created_at asc, m.user_id asc
    ),
    '[]'::jsonb
  )
  into v_result
  from app.organization_members m
  where m.org_id = p_org_id
    and m.role = 'admin';

  return v_result;
end;
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
    and m.user_id = v_target_user_id;

  if v_target_role <> 'admin' then
    perform app_api.raise_http(400, 'Target user must be an admin.');
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

    v_read := lower(app_api.trim_text((p_payload->'permissions'->v_feature->>'read')));
    v_write := lower(app_api.trim_text((p_payload->'permissions'->v_feature->>'write')));

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

create or replace function public.api_promote_member_to_admin(
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
begin
  v_actor_role := app_api.require_org_admin_or_owner(p_org_id);
  if v_actor_role = 'admin' then
    perform app_api.require_effective_feature_access(p_org_id, 'access_management', 'write');
  end if;

  if v_target_user_id is null then
    perform app_api.raise_http(400, 'userId is required.');
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
    perform app_api.raise_http(400, 'Only member accounts can be promoted to admin.');
  end if;

  update app.organization_members m
  set role = 'admin'
  where m.org_id = p_org_id
    and m.user_id = v_target_user_id;

  perform app_api.ensure_admin_feature_permissions(
    p_org_id,
    v_target_user_id,
    true,
    app_api.trim_text(p_actor)
  );

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
    v_target_user_id,
    'approved',
    now(),
    '',
    now(),
    auth.uid(),
    app_api.trim_text(p_actor),
    'Promoted member to admin.'
  )
  on conflict (org_id, user_id) do update set
    status = 'approved',
    decided_at = excluded.decided_at,
    decided_by_user_id = excluded.decided_by_user_id,
    decided_by_actor = excluded.decided_by_actor,
    decision_note = excluded.decision_note;

  return jsonb_build_object(
    'userId', v_target_user_id,
    'role', 'admin'
  );
end;
$$;

create or replace function public.api_demote_admin_to_member(
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
  for update;

  if v_target_role <> 'admin' then
    perform app_api.raise_http(400, 'Target user must be an admin.');
  end if;

  update app.organization_members m
  set role = 'member'
  where m.org_id = p_org_id
    and m.user_id = v_target_user_id;

  delete from app.admin_feature_permissions a
  where a.org_id = p_org_id
    and a.admin_user_id = v_target_user_id;

  return jsonb_build_object(
    'userId', v_target_user_id,
    'role', 'member'
  );
end;
$$;

create or replace function public.api_promote_admin_to_owner(
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
  for update;

  if v_target_role <> 'admin' then
    perform app_api.raise_http(400, 'Target user must be an admin.');
  end if;

  update app.organization_members m
  set role = 'owner'
  where m.org_id = p_org_id
    and m.user_id = v_target_user_id;

  perform app_api.ensure_owner_notification_preference(
    p_org_id,
    v_target_user_id,
    app_api.trim_text(p_actor)
  );

  return jsonb_build_object(
    'userId', v_target_user_id,
    'role', 'owner'
  );
end;
$$;

create or replace function public.api_get_owner_notification_preferences(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_user_id uuid := auth.uid();
  v_in_app boolean := true;
  v_email boolean := true;
begin
  perform app_api.require_org_owner(p_org_id);
  perform app_api.ensure_owner_notification_preference(
    p_org_id,
    v_user_id,
    'owner-preference-read'
  );

  select p.in_app_opt_in, p.email_opt_in
  into v_in_app, v_email
  from app.owner_notification_preferences p
  where p.org_id = p_org_id
    and p.owner_user_id = v_user_id;

  return jsonb_build_object(
    'inAppOptIn', coalesce(v_in_app, true),
    'emailOptIn', coalesce(v_email, true)
  );
end;
$$;

create or replace function public.api_update_owner_notification_preferences(
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
  v_user_id uuid := auth.uid();
  v_in_app text := lower(app_api.trim_text(p_payload->>'inAppOptIn'));
  v_email text := lower(app_api.trim_text(p_payload->>'emailOptIn'));
begin
  perform app_api.require_org_owner(p_org_id);
  perform app_api.ensure_owner_notification_preference(
    p_org_id,
    v_user_id,
    app_api.trim_text(p_actor)
  );

  update app.owner_notification_preferences p
  set
    in_app_opt_in = case when v_in_app in ('true', 'false') then v_in_app::boolean else p.in_app_opt_in end,
    email_opt_in = case when v_email in ('true', 'false') then v_email::boolean else p.email_opt_in end,
    updated_at = now(),
    updated_by = app_api.trim_text(p_actor)
  where p.org_id = p_org_id
    and p.owner_user_id = v_user_id;

  return public.api_get_owner_notification_preferences(p_org_id);
end;
$$;

-- Read wrappers with per-feature enforcement.
create or replace function public.api_acl_list_boxes(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'read');
  return public.api_list_boxes(p_org_id);
end;
$$;

create or replace function public.api_acl_find_box_by_id(p_org_id uuid, p_box_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'read');
  return public.api_find_box_by_id(p_org_id, p_box_id);
end;
$$;

create or replace function public.api_acl_list_film_catalog(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'read');
  return public.api_list_film_catalog(p_org_id);
end;
$$;

create or replace function public.api_acl_list_allocations(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'read');
  return public.api_list_allocations(p_org_id);
end;
$$;

create or replace function public.api_acl_list_allocations_by_box(p_org_id uuid, p_box_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'read');
  return public.api_list_allocations_by_box(p_org_id, p_box_id);
end;
$$;

create or replace function public.api_acl_list_allocations_by_job(p_org_id uuid, p_job_number text)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'read');
  return public.api_list_allocations_by_job(p_org_id, p_job_number);
end;
$$;

create or replace function public.api_acl_list_allocations_by_film_order_id(p_org_id uuid, p_film_order_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'read');
  return public.api_list_allocations_by_film_order_id(p_org_id, p_film_order_id);
end;
$$;

create or replace function public.api_acl_list_allocations_by_ids(p_org_id uuid, p_allocation_ids text[])
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'read');
  return public.api_list_allocations_by_ids(p_org_id, p_allocation_ids);
end;
$$;

create or replace function public.api_acl_list_active_allocations(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'read');
  return public.api_list_active_allocations(p_org_id);
end;
$$;

create or replace function public.api_acl_list_film_orders(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'film_orders', 'read');
  return public.api_list_film_orders(p_org_id);
end;
$$;

create or replace function public.api_acl_list_film_orders_by_job(p_org_id uuid, p_job_number text)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'film_orders', 'read');
  return public.api_list_film_orders_by_job(p_org_id, p_job_number);
end;
$$;

create or replace function public.api_acl_find_film_order_by_id(p_org_id uuid, p_film_order_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'film_orders', 'read');
  return public.api_find_film_order_by_id(p_org_id, p_film_order_id);
end;
$$;

create or replace function public.api_acl_list_film_order_links_by_film_order_id(p_org_id uuid, p_film_order_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'film_orders', 'read');
  return public.api_list_film_order_links_by_film_order_id(p_org_id, p_film_order_id);
end;
$$;

create or replace function public.api_acl_list_jobs(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'read');
  return public.api_list_jobs(p_org_id);
end;
$$;

create or replace function public.api_acl_find_job_by_number(p_org_id uuid, p_job_number text)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'read');
  return public.api_find_job_by_number(p_org_id, p_job_number);
end;
$$;

create or replace function public.api_acl_list_job_requirements(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'read');
  return public.api_list_job_requirements(p_org_id);
end;
$$;

create or replace function public.api_acl_list_job_requirements_by_job(p_org_id uuid, p_job_number text)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'read');
  return public.api_list_job_requirements_by_job(p_org_id, p_job_number);
end;
$$;

create or replace function public.api_acl_list_audit_entries(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'activity_history', 'read');
  return public.api_list_audit_entries(p_org_id);
end;
$$;

create or replace function public.api_acl_list_audit_entries_by_box(p_org_id uuid, p_box_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'activity_history', 'read');
  return public.api_list_audit_entries_by_box(p_org_id, p_box_id);
end;
$$;

create or replace function public.api_acl_list_roll_history_by_box(p_org_id uuid, p_box_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'activity_history', 'read');
  return public.api_list_roll_history_by_box(p_org_id, p_box_id);
end;
$$;

-- Mutation wrappers with per-feature enforcement.
create or replace function public.api_acl_boxes_add(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');
  return public.api_boxes_add(p_org_id, p_actor, p_payload);
end;
$$;

create or replace function public.api_acl_boxes_update(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');
  return public.api_boxes_update(p_org_id, p_actor, p_payload);
end;
$$;

create or replace function public.api_acl_boxes_set_status(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');
  return public.api_boxes_set_status(p_org_id, p_actor, p_payload);
end;
$$;

create or replace function public.api_acl_boxes_delete(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');
  return public.api_boxes_delete(p_org_id, p_actor, p_payload);
end;
$$;

create or replace function public.api_acl_allocations_apply(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'write');
  return public.api_allocations_apply(p_org_id, p_actor, p_payload);
end;
$$;

create or replace function public.api_acl_jobs_create(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'write');
  return public.api_jobs_create(p_org_id, p_actor, p_payload);
end;
$$;

create or replace function public.api_acl_jobs_update(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'write');
  return public.api_jobs_update(p_org_id, p_actor, p_payload);
end;
$$;

create or replace function public.api_acl_film_orders_create(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'film_orders', 'write');
  return public.api_film_orders_create(p_org_id, p_actor, p_payload);
end;
$$;

create or replace function public.api_acl_film_orders_cancel(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'film_orders', 'write');
  return public.api_film_orders_cancel(p_org_id, p_actor, p_payload);
end;
$$;

create or replace function public.api_acl_film_orders_delete(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'film_orders', 'write');
  return public.api_film_orders_delete(p_org_id, p_actor, p_payload);
end;
$$;

create or replace function public.api_acl_audit_undo(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'activity_history', 'write');
  return public.api_audit_undo(p_org_id, p_actor, p_payload);
end;
$$;

-- Seed permissions and backfill statuses.
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
select
  m.org_id,
  m.user_id,
  'approved',
  m.created_at,
  '',
  m.created_at,
  m.user_id,
  'migration-backfill',
  'Existing membership backfill.'
from app.organization_members m
on conflict (org_id, user_id) do nothing;

insert into app.owner_notification_preferences (
  org_id,
  owner_user_id,
  in_app_opt_in,
  email_opt_in,
  updated_at,
  updated_by
)
select
  m.org_id,
  m.user_id,
  true,
  true,
  now(),
  'migration-backfill'
from app.organization_members m
where m.role = 'owner'
on conflict (org_id, owner_user_id) do nothing;

insert into app.general_feature_permissions (
  org_id,
  feature_area,
  read_enabled,
  write_enabled,
  updated_at,
  updated_by
)
select
  o.id as org_id,
  feature_area.value as feature_area,
  true,
  true,
  now(),
  'migration-backfill'
from app.organizations o
cross join lateral unnest(app_api.member_feature_areas()) as feature_area(value)
on conflict (org_id, feature_area) do nothing;

insert into app.admin_feature_permissions (
  org_id,
  admin_user_id,
  feature_area,
  read_enabled,
  write_enabled,
  updated_at,
  updated_by
)
select
  m.org_id,
  m.user_id,
  feature_area.value as feature_area,
  true,
  true,
  now(),
  'migration-backfill'
from app.organization_members m
cross join lateral unnest(app_api.admin_feature_areas()) as feature_area(value)
where m.role = 'admin'
on conflict (org_id, admin_user_id, feature_area) do nothing;

-- Restrict old RPC access and grant new ACL wrappers and governance endpoints.
create or replace function app_api.revoke_execute_if_exists(
  p_signature text,
  p_grantee text
)
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  if to_regprocedure(p_signature) is null then
    return;
  end if;

  execute format('revoke execute on function %s from %I', p_signature, p_grantee);
end;
$$;

create or replace function app_api.grant_execute_if_exists(
  p_signature text,
  p_grantee text
)
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  if to_regprocedure(p_signature) is null then
    return;
  end if;

  execute format('grant execute on function %s to %I', p_signature, p_grantee);
end;
$$;

select app_api.revoke_execute_if_exists('public.api_list_boxes(uuid)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_find_box_by_id(uuid, text)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_list_film_catalog(uuid)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_list_allocations(uuid)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_list_allocations_by_box(uuid, text)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_list_allocations_by_job(uuid, text)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_list_allocations_by_film_order_id(uuid, text)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_list_allocations_by_ids(uuid, text[])', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_list_active_allocations(uuid)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_list_film_orders(uuid)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_list_film_orders_by_job(uuid, text)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_find_film_order_by_id(uuid, text)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_list_film_order_links(uuid)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_list_film_order_links_by_film_order_id(uuid, text)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_list_film_order_links_by_box_id(uuid, text)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_list_jobs(uuid)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_find_job_by_number(uuid, text)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_list_job_requirements(uuid)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_list_job_requirements_by_job(uuid, text)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_list_audit_entries(uuid)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_list_audit_entries_by_box(uuid, text)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_find_audit_entry_by_log_id(uuid, text)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_list_roll_history_by_box(uuid, text)', 'authenticated');

select app_api.revoke_execute_if_exists('public.api_jobs_create(uuid, text, jsonb)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_jobs_update(uuid, text, jsonb)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_film_orders_create(uuid, text, jsonb)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_film_orders_cancel(uuid, text, jsonb)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_film_orders_delete(uuid, text, jsonb)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_boxes_add(uuid, text, jsonb)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_boxes_update(uuid, text, jsonb)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_boxes_set_status(uuid, text, jsonb)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_boxes_delete(uuid, text, jsonb)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_allocations_apply(uuid, text, jsonb)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_audit_undo(uuid, text, jsonb)', 'authenticated');

select app_api.grant_execute_if_exists('public.api_get_auth_context(uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_list_access_requests(uuid, text)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_approve_access_request(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_deny_access_request(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_get_member_feature_permissions(uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_update_member_feature_permissions(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_get_admin_feature_permissions(uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_update_admin_feature_permissions(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_promote_member_to_admin(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_demote_admin_to_member(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_promote_admin_to_owner(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_get_owner_notification_preferences(uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_update_owner_notification_preferences(uuid, text, jsonb)', 'authenticated');

select app_api.grant_execute_if_exists('public.api_acl_list_boxes(uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_find_box_by_id(uuid, text)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_film_catalog(uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_allocations(uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_allocations_by_box(uuid, text)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_allocations_by_job(uuid, text)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_allocations_by_film_order_id(uuid, text)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_allocations_by_ids(uuid, text[])', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_active_allocations(uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_film_orders(uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_film_orders_by_job(uuid, text)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_find_film_order_by_id(uuid, text)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_film_order_links_by_film_order_id(uuid, text)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_jobs(uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_find_job_by_number(uuid, text)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_job_requirements(uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_job_requirements_by_job(uuid, text)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_audit_entries(uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_audit_entries_by_box(uuid, text)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_roll_history_by_box(uuid, text)', 'authenticated');

select app_api.grant_execute_if_exists('public.api_acl_boxes_add(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_boxes_update(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_boxes_set_status(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_boxes_delete(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_allocations_apply(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_jobs_create(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_jobs_update(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_film_orders_create(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_film_orders_cancel(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_film_orders_delete(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_audit_undo(uuid, text, jsonb)', 'authenticated');

select app_api.grant_execute_if_exists('public.api_list_access_notification_recipients(uuid)', 'service_role');
