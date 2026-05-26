create table if not exists app.user_preferences (
  org_id uuid not null references app.organizations(id) on delete cascade,
  user_id uuid not null,
  default_warehouse text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text not null default '',
  primary key (org_id, user_id),
  foreign key (org_id, user_id) references app.organization_members(org_id, user_id) on delete cascade,
  constraint user_preferences_default_warehouse_format check (
    default_warehouse = ''
    or default_warehouse ~ '^[A-Z]{2}[1-9][0-9]{0,6}$'
  )
);

create index if not exists idx_user_preferences_org_default_warehouse
  on app.user_preferences (org_id, default_warehouse)
  where default_warehouse <> '';

alter table app.user_preferences enable row level security;

drop policy if exists user_preferences_read_self on app.user_preferences;
create policy user_preferences_read_self on app.user_preferences
for select using (
  user_id = auth.uid()
  and app.is_org_member(org_id)
);

drop policy if exists user_preferences_insert_self on app.user_preferences;
create policy user_preferences_insert_self on app.user_preferences
for insert with check (
  user_id = auth.uid()
  and app.is_org_member(org_id)
);

drop policy if exists user_preferences_update_self on app.user_preferences;
create policy user_preferences_update_self on app.user_preferences
for update using (
  user_id = auth.uid()
  and app.is_org_member(org_id)
) with check (
  user_id = auth.uid()
  and app.is_org_member(org_id)
);

create or replace function app_api.get_user_default_warehouse(
  p_org_id uuid,
  p_user_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = public, app, app_api
as $$
declare
  v_default text := '';
begin
  select coalesce(p.default_warehouse, '')
  into v_default
  from app.user_preferences p
  join app.warehouses w
    on w.org_id = p.org_id
   and w.code = p.default_warehouse
  where p.org_id = p_org_id
    and p.user_id = p_user_id
    and p.default_warehouse <> '';

  return coalesce(v_default, '');
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
        'defaultWarehouse', '',
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
      'defaultWarehouse', '',
      'email', v_email
    );
  end if;

  perform app_api.require_org_member_approved(p_org_id);
  v_default_warehouse := app_api.get_user_default_warehouse(p_org_id, v_user_id);

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
    'defaultWarehouse', coalesce(v_default_warehouse, ''),
    'email', v_email
  );
end;
$$;

create or replace function public.api_update_user_default_warehouse(
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
  v_actor text := app_api.trim_text(p_actor);
  v_input text := upper(app_api.trim_text(coalesce(
    p_payload->>'defaultWarehouse',
    p_payload->>'warehouse'
  )));
  v_default_warehouse text := '';
begin
  perform app_api.require_org_member_approved(p_org_id);

  if v_user_id is null then
    perform app_api.raise_http(401, 'Authenticated session is required.');
  end if;

  if v_input not in ('', 'ALL', 'ALL_WAREHOUSES', 'ALL WAREHOUSES') then
    v_default_warehouse := app_api.require_org_warehouse(p_org_id, v_input, 'Warehouse');
  end if;

  insert into app.user_preferences (
    org_id,
    user_id,
    default_warehouse,
    updated_at,
    updated_by
  )
  values (
    p_org_id,
    v_user_id,
    v_default_warehouse,
    now(),
    v_actor
  )
  on conflict (org_id, user_id) do update
  set
    default_warehouse = excluded.default_warehouse,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by;

  return jsonb_build_object(
    'defaultWarehouse', v_default_warehouse
  );
end;
$$;

drop function if exists public.api_acl_list_film_orders(uuid);
drop function if exists public.api_list_film_orders(uuid);

create or replace function public.api_list_film_orders(
  p_org_id uuid,
  p_warehouse text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_result jsonb;
  v_warehouse text := upper(app_api.trim_text(p_warehouse));
begin
  perform app_api.require_org_member(p_org_id);

  if v_warehouse = 'ALL' then
    v_warehouse := '';
  elsif v_warehouse <> '' then
    v_warehouse := app_api.require_org_warehouse(p_org_id, v_warehouse, 'Warehouse');
  end if;

  select coalesce(
    jsonb_agg(to_jsonb(f) order by f.created_at desc, f.film_order_id desc),
    '[]'::jsonb
  )
  into v_result
  from app.film_orders f
  where f.org_id = p_org_id
    and (
      v_warehouse = ''
      or upper(trim(f.warehouse::text)) = v_warehouse
    );

  return v_result;
end;
$$;

create or replace function public.api_acl_list_film_orders(
  p_org_id uuid,
  p_warehouse text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'film_orders', 'read');
  return public.api_list_film_orders(p_org_id, p_warehouse);
end;
$$;

drop function if exists public.api_acl_list_jobs(uuid);
drop function if exists public.api_list_jobs(uuid);

create or replace function public.api_list_jobs(
  p_org_id uuid,
  p_warehouse text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_result jsonb;
  v_warehouse text := upper(app_api.trim_text(p_warehouse));
begin
  perform app_api.require_org_member(p_org_id);

  if v_warehouse = 'ALL' then
    v_warehouse := '';
  elsif v_warehouse <> '' then
    v_warehouse := app_api.require_org_warehouse(p_org_id, v_warehouse, 'Warehouse');
  end if;

  select coalesce(
    jsonb_agg(to_jsonb(j) order by j.due_date desc nulls last, j.updated_at desc, j.job_number desc),
    '[]'::jsonb
  )
  into v_result
  from app.jobs j
  where j.org_id = p_org_id
    and (
      v_warehouse = ''
      or upper(trim(j.warehouse::text)) = v_warehouse
    );

  return v_result;
end;
$$;

create or replace function public.api_acl_list_jobs(
  p_org_id uuid,
  p_warehouse text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'read');
  return public.api_list_jobs(p_org_id, p_warehouse);
end;
$$;

revoke execute on function public.api_update_user_default_warehouse(uuid, text, jsonb) from public;
revoke execute on function public.api_update_user_default_warehouse(uuid, text, jsonb) from anon;
revoke execute on function public.api_update_user_default_warehouse(uuid, text, jsonb) from service_role;
grant execute on function public.api_update_user_default_warehouse(uuid, text, jsonb) to authenticated;

revoke execute on function public.api_list_film_orders(uuid, text) from public;
revoke execute on function public.api_list_film_orders(uuid, text) from anon;
revoke execute on function public.api_list_film_orders(uuid, text) from authenticated;
revoke execute on function public.api_list_film_orders(uuid, text) from service_role;
revoke execute on function public.api_acl_list_film_orders(uuid, text) from public;
revoke execute on function public.api_acl_list_film_orders(uuid, text) from anon;
revoke execute on function public.api_acl_list_film_orders(uuid, text) from service_role;
grant execute on function public.api_acl_list_film_orders(uuid, text) to authenticated;

revoke execute on function public.api_list_jobs(uuid, text) from public;
revoke execute on function public.api_list_jobs(uuid, text) from anon;
revoke execute on function public.api_list_jobs(uuid, text) from authenticated;
revoke execute on function public.api_list_jobs(uuid, text) from service_role;
revoke execute on function public.api_acl_list_jobs(uuid, text) from public;
revoke execute on function public.api_acl_list_jobs(uuid, text) from anon;
revoke execute on function public.api_acl_list_jobs(uuid, text) from service_role;
grant execute on function public.api_acl_list_jobs(uuid, text) to authenticated;
