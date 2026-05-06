-- Keep the access-requests list RPC scoped to real authenticated user sessions.

revoke execute on function public.api_list_access_requests(uuid, text) from public;
revoke execute on function public.api_list_access_requests(uuid, text) from anon;
revoke execute on function public.api_list_access_requests(uuid, text) from service_role;

grant execute on function public.api_list_access_requests(uuid, text) to authenticated;
