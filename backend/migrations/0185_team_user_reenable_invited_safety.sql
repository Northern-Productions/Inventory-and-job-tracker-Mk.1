-- Keep re-enable from converting an unaccepted invite into active access.
-- Confirmed disabled users become active again; disabled unaccepted invites
-- return to invited/pending so acceptance is still required before app access.

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

select app_api.grant_execute_if_exists('public.api_reenable_team_user(uuid, text, jsonb)', 'authenticated');

revoke execute on function public.api_reenable_team_user(uuid, text, jsonb) from public, anon, service_role;
grant execute on function public.api_reenable_team_user(uuid, text, jsonb) to authenticated;
