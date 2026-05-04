-- Harden public RPC privileges before restoring authenticated schema visibility.
-- This grants the schema USAGE required to resolve public RPCs, while ensuring
-- legacy direct public.api_* functions do not become callable through default
-- PUBLIC EXECUTE privileges.

grant usage on schema public to authenticated;

do $$
declare
  v_signature regprocedure;
begin
  for v_signature in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n
      on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname like 'api\_%' escape '\'
  loop
    execute format('revoke execute on function %s from public', v_signature);
    execute format('revoke execute on function %s from anon', v_signature);
    execute format('revoke execute on function %s from authenticated', v_signature);
  end loop;
end
$$;

do $$
declare
  v_signature regprocedure;
begin
  for v_signature in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n
      on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (
        p.proname like 'api\_acl\_%' escape '\'
        or p.proname in (
          'api_get_auth_context',
          'api_request_username_change',
          'api_list_username_change_requests',
          'api_get_user_feature_permissions',
          'api_update_user_feature_permissions'
        )
      )
  loop
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
end
$$;

alter default privileges in schema public revoke execute on functions from public;
