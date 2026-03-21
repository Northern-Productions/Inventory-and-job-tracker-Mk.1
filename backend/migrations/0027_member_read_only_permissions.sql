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

    if p_access_mode = 'write' then
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
  v_read text;
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
    perform app_api.raise_http(400, 'Only member accounts can be changed from this page.');
  end if;

  perform app_api.ensure_general_feature_permissions(p_org_id, app_api.trim_text(p_actor));

  foreach v_feature in array app_api.member_feature_areas() loop
    if not ((p_payload->'permissions') ? v_feature) then
      continue;
    end if;

    v_read := lower(app_api.trim_text((p_payload->'permissions'->v_feature)->>'read'));

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
      read_enabled = case when v_read in ('true', 'false') then v_read::boolean else a.read_enabled end,
      write_enabled = false,
      updated_at = now(),
      updated_by = app_api.trim_text(p_actor)
    where a.org_id = p_org_id
      and a.admin_user_id = v_target_user_id
      and a.feature_area = v_feature;
  end loop;

  delete from app.admin_feature_permissions a
  where a.org_id = p_org_id
    and a.admin_user_id = v_target_user_id
    and a.feature_area = 'access_management';

  return app_api.member_permissions_for_user_json(p_org_id, v_target_user_id);
end;
$$;

update app.admin_feature_permissions a
set
  write_enabled = false,
  updated_at = now(),
  updated_by = '0027_member_read_only_permissions'
from app.organization_members m
where m.org_id = a.org_id
  and m.user_id = a.admin_user_id
  and m.role = 'member'
  and a.feature_area = any(app_api.member_feature_areas())
  and a.write_enabled is distinct from false;

delete from app.admin_feature_permissions a
using app.organization_members m
where m.org_id = a.org_id
  and m.user_id = a.admin_user_id
  and m.role = 'member'
  and a.feature_area = 'access_management';
