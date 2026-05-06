-- Restore the admin access-requests read RPC after public RPC hardening.
-- The function body still enforces owner/admin access and feature permissions.

revoke execute on function public.api_list_access_requests(uuid, text) from public;
revoke execute on function public.api_list_access_requests(uuid, text) from anon;

grant execute on function public.api_list_access_requests(uuid, text) to authenticated;
