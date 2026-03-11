create or replace function app_api.derive_display_name_from_email(p_email text)
returns text
language sql
immutable
as $$
  select app_api.trim_text(
    replace(
      replace(
        replace(split_part(coalesce(p_email, ''), '@', 1), '.', ' '),
        '_',
        ' '
      ),
      '-',
      ' '
    )
  );
$$;

update app.access_requests r
set requested_by_email = app_api.trim_text(u.email)
from auth.users u
where u.id = r.user_id
  and app_api.trim_text(r.requested_by_email) = ''
  and app_api.trim_text(u.email) <> '';

update app.access_requests r
set requested_by_name = app_api.trim_text(
  coalesce(
    nullif(u.raw_user_meta_data->>'full_name', ''),
    nullif(u.raw_user_meta_data->>'name', ''),
    app_api.derive_display_name_from_email(
      coalesce(nullif(r.requested_by_email, ''), u.email, '')
    )
  )
)
from auth.users u
where u.id = r.user_id
  and app_api.trim_text(r.requested_by_name) = '';

create table if not exists app.username_change_requests (
  org_id uuid not null references app.organizations(id) on delete cascade,
  user_id uuid not null,
  requested_name text not null default '',
  status text not null check (status in ('pending', 'approved', 'denied')),
  requested_at timestamptz not null default now(),
  requested_by_actor text not null default '',
  decided_at timestamptz,
  decided_by_user_id uuid,
  decided_by_actor text not null default '',
  decision_note text not null default '',
  primary key (org_id, user_id)
);

create index if not exists idx_username_change_requests_org_status_requested
  on app.username_change_requests (org_id, status, requested_at asc);

alter table app.username_change_requests enable row level security;

drop policy if exists username_change_requests_read on app.username_change_requests;
create policy username_change_requests_read on app.username_change_requests
for select using (
  app.is_org_member(org_id)
  or user_id = auth.uid()
);

create or replace function app_api.set_user_display_name(p_user_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = public, app, app_api, auth
as $$
declare
  v_name text := app_api.trim_text(p_name);
begin
  if p_user_id is null then
    return;
  end if;

  if v_name = '' then
    return;
  end if;

  update auth.users
  set
    raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
      || jsonb_build_object('name', v_name, 'full_name', v_name),
    updated_at = now()
  where id = p_user_id;
end;
$$;

create or replace function public.api_request_username_change(
  p_org_id uuid,
  p_actor text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api, auth
as $$
declare
  v_user_id uuid := auth.uid();
  v_requested_name text := app_api.trim_text(p_payload->>'username');
  v_role text;
  v_email text;
  v_actor text := app_api.trim_text(p_actor);
begin
  if p_org_id is null then
    perform app_api.raise_http(400, 'Organization is required.');
  end if;

  if v_user_id is null then
    perform app_api.raise_http(401, 'Authenticated session is required.');
  end if;

  if v_requested_name = '' then
    perform app_api.raise_http(400, 'Username is required.');
  end if;

  if length(v_requested_name) < 2 then
    perform app_api.raise_http(400, 'Username must be at least 2 characters.');
  end if;

  if length(v_requested_name) > 64 then
    perform app_api.raise_http(400, 'Username must be 64 characters or fewer.');
  end if;

  select app_api.trim_text(u.email)
  into v_email
  from auth.users u
  where u.id = v_user_id;

  if not exists (
    select 1
    from app.organization_members m
    where m.org_id = p_org_id
      and m.user_id = v_user_id
  ) and not exists (
    select 1
    from app.access_requests r
    where r.org_id = p_org_id
      and r.user_id = v_user_id
  ) then
    perform app_api.raise_http(403, 'No organization access request exists for this user.');
  end if;

  select m.role
  into v_role
  from app.organization_members m
  where m.org_id = p_org_id
    and m.user_id = v_user_id;

  if coalesce(v_role, '') in ('owner', 'admin') then
    perform app_api.set_user_display_name(v_user_id, v_requested_name);

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
      coalesce(v_email, ''),
      v_requested_name
    )
    on conflict (org_id, user_id) do update
    set
      requested_by_email = case
        when app_api.trim_text(app.access_requests.requested_by_email) = '' then excluded.requested_by_email
        else app.access_requests.requested_by_email
      end,
      requested_by_name = excluded.requested_by_name;

    insert into app.username_change_requests (
      org_id,
      user_id,
      requested_name,
      status,
      requested_at,
      requested_by_actor,
      decided_at,
      decided_by_user_id,
      decided_by_actor,
      decision_note
    )
    values (
      p_org_id,
      v_user_id,
      v_requested_name,
      'approved',
      now(),
      v_actor,
      now(),
      v_user_id,
      v_actor,
      'Auto-approved admin/owner self-update.'
    )
    on conflict (org_id, user_id) do update
    set
      requested_name = excluded.requested_name,
      status = 'approved',
      requested_at = excluded.requested_at,
      requested_by_actor = excluded.requested_by_actor,
      decided_at = excluded.decided_at,
      decided_by_user_id = excluded.decided_by_user_id,
      decided_by_actor = excluded.decided_by_actor,
      decision_note = excluded.decision_note;

    return jsonb_build_object(
      'status', 'approved',
      'requiresApproval', false,
      'username', v_requested_name
    );
  end if;

  insert into app.username_change_requests (
    org_id,
    user_id,
    requested_name,
    status,
    requested_at,
    requested_by_actor,
    decided_at,
    decided_by_user_id,
    decided_by_actor,
    decision_note
  )
  values (
    p_org_id,
    v_user_id,
    v_requested_name,
    'pending',
    now(),
    v_actor,
    null,
    null,
    '',
    ''
  )
  on conflict (org_id, user_id) do update
  set
    requested_name = excluded.requested_name,
    status = 'pending',
    requested_at = excluded.requested_at,
    requested_by_actor = excluded.requested_by_actor,
    decided_at = null,
    decided_by_user_id = null,
    decided_by_actor = '',
    decision_note = '';

  if app_api.trim_text(v_email) <> '' then
    update app.access_requests r
    set requested_by_email = v_email
    where r.org_id = p_org_id
      and r.user_id = v_user_id
      and app_api.trim_text(r.requested_by_email) = '';
  end if;

  return jsonb_build_object(
    'status', 'pending',
    'requiresApproval', true,
    'username', v_requested_name
  );
end;
$$;

create or replace function public.api_list_username_change_requests(
  p_org_id uuid,
  p_status text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api, auth
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
        'email', coalesce(nullif(a.requested_by_email, ''), coalesce(u.email, '')),
        'currentName', coalesce(
          nullif(a.requested_by_name, ''),
          nullif(u.raw_user_meta_data->>'full_name', ''),
          nullif(u.raw_user_meta_data->>'name', ''),
          app_api.derive_display_name_from_email(
            coalesce(nullif(a.requested_by_email, ''), u.email, '')
          ),
          r.user_id::text
        ),
        'requestedName', r.requested_name,
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
  from app.username_change_requests r
  left join app.organization_members m
    on m.org_id = r.org_id
   and m.user_id = r.user_id
  left join app.access_requests a
    on a.org_id = r.org_id
   and a.user_id = r.user_id
  left join auth.users u
    on u.id = r.user_id
  where r.org_id = p_org_id
    and (
      app_api.trim_text(p_status) = ''
      or lower(r.status) = lower(app_api.trim_text(p_status))
    );

  return v_result;
end;
$$;

create or replace function public.api_approve_username_change_request(
  p_org_id uuid,
  p_actor text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api, auth
as $$
declare
  v_actor_role text;
  v_target_user_id uuid := nullif(app_api.trim_text(p_payload->>'userId'), '')::uuid;
  v_note text := app_api.trim_text(p_payload->>'note');
  v_requested_name text;
  v_email text;
begin
  v_actor_role := app_api.require_org_admin_or_owner(p_org_id);
  if v_actor_role = 'admin' then
    perform app_api.require_effective_feature_access(p_org_id, 'access_management', 'write');
  end if;

  if v_target_user_id is null then
    perform app_api.raise_http(400, 'userId is required.');
  end if;

  select r.requested_name
  into v_requested_name
  from app.username_change_requests r
  where r.org_id = p_org_id
    and r.user_id = v_target_user_id
    and r.status = 'pending'
  for update;

  if not found then
    perform app_api.raise_http(404, 'No pending username change request was found for this user.');
  end if;

  perform app_api.set_user_display_name(v_target_user_id, v_requested_name);

  select app_api.trim_text(u.email)
  into v_email
  from auth.users u
  where u.id = v_target_user_id;

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
    v_target_user_id,
    'pending',
    now(),
    coalesce(v_email, ''),
    v_requested_name
  )
  on conflict (org_id, user_id) do update
  set
    requested_by_email = case
      when app_api.trim_text(app.access_requests.requested_by_email) = '' then excluded.requested_by_email
      else app.access_requests.requested_by_email
    end,
    requested_by_name = excluded.requested_by_name;

  update app.username_change_requests
  set
    status = 'approved',
    decided_at = now(),
    decided_by_user_id = auth.uid(),
    decided_by_actor = app_api.trim_text(p_actor),
    decision_note = v_note
  where org_id = p_org_id
    and user_id = v_target_user_id;

  return jsonb_build_object(
    'userId', v_target_user_id,
    'status', 'approved',
    'username', v_requested_name
  );
end;
$$;

create or replace function public.api_deny_username_change_request(
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
  v_note text := app_api.trim_text(p_payload->>'note');
begin
  v_actor_role := app_api.require_org_admin_or_owner(p_org_id);
  if v_actor_role = 'admin' then
    perform app_api.require_effective_feature_access(p_org_id, 'access_management', 'write');
  end if;

  if v_target_user_id is null then
    perform app_api.raise_http(400, 'userId is required.');
  end if;

  update app.username_change_requests
  set
    status = 'denied',
    decided_at = now(),
    decided_by_user_id = auth.uid(),
    decided_by_actor = app_api.trim_text(p_actor),
    decision_note = v_note
  where org_id = p_org_id
    and user_id = v_target_user_id
    and status = 'pending';

  if not found then
    perform app_api.raise_http(404, 'No pending username change request was found for this user.');
  end if;

  return jsonb_build_object(
    'userId', v_target_user_id,
    'status', 'denied'
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
        'name', coalesce(
          nullif(r.requested_by_name, ''),
          nullif(u.raw_user_meta_data->>'full_name', ''),
          nullif(u.raw_user_meta_data->>'name', ''),
          app_api.derive_display_name_from_email(
            coalesce(nullif(r.requested_by_email, ''), u.email, '')
          ),
          r.user_id::text
        ),
        'email', coalesce(nullif(r.requested_by_email, ''), coalesce(u.email, '')),
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
  left join auth.users u
    on u.id = r.user_id
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
        'name', coalesce(
          nullif(r.requested_by_name, ''),
          nullif(u.raw_user_meta_data->>'full_name', ''),
          nullif(u.raw_user_meta_data->>'name', ''),
          app_api.derive_display_name_from_email(
            coalesce(nullif(r.requested_by_email, ''), u.email, '')
          ),
          m.user_id::text
        ),
        'email', coalesce(nullif(r.requested_by_email, ''), coalesce(u.email, '')),
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
  left join auth.users u
    on u.id = m.user_id
  where m.org_id = p_org_id
    and m.role = 'admin';

  return v_result;
end;
$$;

select app_api.grant_execute_if_exists('public.api_request_username_change(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_list_username_change_requests(uuid, text)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_approve_username_change_request(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_deny_username_change_request(uuid, text, jsonb)', 'authenticated');
