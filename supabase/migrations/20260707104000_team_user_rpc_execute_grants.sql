-- Restrict team-user public RPCs to authenticated user sessions only.
-- These RPCs enforce owner/current-org rules internally and are called with
-- the acting user's authenticated session; service-role is reserved for the
-- Supabase Auth Admin invite boundary, not these session RPCs.

revoke execute on function public.api_list_team_users(uuid) from public, anon, service_role;
revoke execute on function public.api_prepare_team_invite(uuid, jsonb) from public, anon, service_role;
revoke execute on function public.api_record_team_invite(uuid, text, jsonb) from public, anon, service_role;
revoke execute on function public.api_change_team_user_role(uuid, text, jsonb) from public, anon, service_role;
revoke execute on function public.api_disable_team_user(uuid, text, jsonb) from public, anon, service_role;
revoke execute on function public.api_reenable_team_user(uuid, text, jsonb) from public, anon, service_role;

grant execute on function public.api_list_team_users(uuid) to authenticated;
grant execute on function public.api_prepare_team_invite(uuid, jsonb) to authenticated;
grant execute on function public.api_record_team_invite(uuid, text, jsonb) to authenticated;
grant execute on function public.api_change_team_user_role(uuid, text, jsonb) to authenticated;
grant execute on function public.api_disable_team_user(uuid, text, jsonb) to authenticated;
grant execute on function public.api_reenable_team_user(uuid, text, jsonb) to authenticated;
