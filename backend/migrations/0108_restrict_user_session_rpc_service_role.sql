-- Keep user-session RPCs scoped to real authenticated user sessions.

revoke execute on function public.api_get_auth_context(uuid) from public;
revoke execute on function public.api_get_auth_context(uuid) from anon;
revoke execute on function public.api_get_auth_context(uuid) from service_role;
grant execute on function public.api_get_auth_context(uuid) to authenticated;

revoke execute on function public.api_request_username_change(uuid, text, jsonb) from public;
revoke execute on function public.api_request_username_change(uuid, text, jsonb) from anon;
revoke execute on function public.api_request_username_change(uuid, text, jsonb) from service_role;
grant execute on function public.api_request_username_change(uuid, text, jsonb) to authenticated;
