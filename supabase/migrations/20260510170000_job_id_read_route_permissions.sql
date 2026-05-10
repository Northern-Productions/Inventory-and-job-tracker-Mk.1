-- Tighten job-ID read route RPC permissions after introducing the by-ID helper.
-- The direct helper is intentionally callable only by trusted SQL wrappers; app
-- callers must go through the ACL wrapper so jobs:read feature access is checked.

do $$
declare
  v_direct_signature regprocedure := to_regprocedure('public.api_find_job_by_id(uuid, uuid)');
  v_acl_signature regprocedure := to_regprocedure('public.api_acl_find_job_by_id(uuid, uuid)');
begin
  if v_direct_signature is not null then
    execute format('revoke execute on function %s from public', v_direct_signature);
    execute format('revoke execute on function %s from anon', v_direct_signature);
    execute format('revoke execute on function %s from authenticated', v_direct_signature);
    execute format('revoke execute on function %s from service_role', v_direct_signature);
  end if;

  if v_acl_signature is not null then
    execute format('revoke execute on function %s from public', v_acl_signature);
    execute format('revoke execute on function %s from anon', v_acl_signature);
    execute format('grant execute on function %s to authenticated', v_acl_signature);
    execute format('grant execute on function %s to service_role', v_acl_signature);
  end if;
end
$$;
