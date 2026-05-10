create or replace function public.api_find_job_by_id(
  p_org_id uuid,
  p_job_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_result jsonb;
begin
  perform app_api.require_org_member(p_org_id);

  select to_jsonb(j)
  into v_result
  from app.jobs j
  where j.org_id = p_org_id
    and j.id = p_job_id;

  return v_result;
end;
$$;

create or replace function public.api_acl_find_job_by_id(
  p_org_id uuid,
  p_job_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'read');
  return public.api_find_job_by_id(p_org_id, p_job_id);
end;
$$;

select app_api.revoke_execute_if_exists('public.api_find_job_by_id(uuid, uuid)', 'authenticated');
select app_api.revoke_execute_if_exists('public.api_find_job_by_id(uuid, uuid)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_find_job_by_id(uuid, uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_find_job_by_id(uuid, uuid)', 'service_role');
