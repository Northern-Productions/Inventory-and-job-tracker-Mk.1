-- Restore authenticated access to the membership-list RPC used by auth resolution.
--
-- The Edge/local auth resolver calls public.api_list_memberships() with the
-- current user-scoped authenticated client before an org context is selected.
-- Keep the function unavailable to anon/public callers and avoid broad grants.

revoke execute on function public.api_list_memberships() from public;
revoke execute on function public.api_list_memberships() from anon;

grant execute on function public.api_list_memberships() to authenticated;
