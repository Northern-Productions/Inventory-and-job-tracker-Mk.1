-- Restore authenticated access to the admin access-management RPC surface.
-- Each function body enforces owner/admin role and feature-access checks.

revoke execute on function public.api_list_access_requests(uuid, text) from public;
revoke execute on function public.api_list_access_requests(uuid, text) from anon;
revoke execute on function public.api_list_access_requests(uuid, text) from service_role;
grant execute on function public.api_list_access_requests(uuid, text) to authenticated;

revoke execute on function public.api_approve_access_request(uuid, text, jsonb) from public;
revoke execute on function public.api_approve_access_request(uuid, text, jsonb) from anon;
revoke execute on function public.api_approve_access_request(uuid, text, jsonb) from service_role;
grant execute on function public.api_approve_access_request(uuid, text, jsonb) to authenticated;

revoke execute on function public.api_deny_access_request(uuid, text, jsonb) from public;
revoke execute on function public.api_deny_access_request(uuid, text, jsonb) from anon;
revoke execute on function public.api_deny_access_request(uuid, text, jsonb) from service_role;
grant execute on function public.api_deny_access_request(uuid, text, jsonb) to authenticated;

revoke execute on function public.api_list_username_change_requests(uuid, text) from public;
revoke execute on function public.api_list_username_change_requests(uuid, text) from anon;
revoke execute on function public.api_list_username_change_requests(uuid, text) from service_role;
grant execute on function public.api_list_username_change_requests(uuid, text) to authenticated;

revoke execute on function public.api_approve_username_change_request(uuid, text, jsonb) from public;
revoke execute on function public.api_approve_username_change_request(uuid, text, jsonb) from anon;
revoke execute on function public.api_approve_username_change_request(uuid, text, jsonb) from service_role;
grant execute on function public.api_approve_username_change_request(uuid, text, jsonb) to authenticated;

revoke execute on function public.api_deny_username_change_request(uuid, text, jsonb) from public;
revoke execute on function public.api_deny_username_change_request(uuid, text, jsonb) from anon;
revoke execute on function public.api_deny_username_change_request(uuid, text, jsonb) from service_role;
grant execute on function public.api_deny_username_change_request(uuid, text, jsonb) to authenticated;

revoke execute on function public.api_get_member_feature_permissions(uuid) from public;
revoke execute on function public.api_get_member_feature_permissions(uuid) from anon;
revoke execute on function public.api_get_member_feature_permissions(uuid) from service_role;
grant execute on function public.api_get_member_feature_permissions(uuid) to authenticated;

revoke execute on function public.api_update_member_feature_permissions(uuid, text, jsonb) from public;
revoke execute on function public.api_update_member_feature_permissions(uuid, text, jsonb) from anon;
revoke execute on function public.api_update_member_feature_permissions(uuid, text, jsonb) from service_role;
grant execute on function public.api_update_member_feature_permissions(uuid, text, jsonb) to authenticated;

revoke execute on function public.api_get_user_feature_permissions(uuid, uuid) from public;
revoke execute on function public.api_get_user_feature_permissions(uuid, uuid) from anon;
revoke execute on function public.api_get_user_feature_permissions(uuid, uuid) from service_role;
grant execute on function public.api_get_user_feature_permissions(uuid, uuid) to authenticated;

revoke execute on function public.api_update_user_feature_permissions(uuid, text, jsonb) from public;
revoke execute on function public.api_update_user_feature_permissions(uuid, text, jsonb) from anon;
revoke execute on function public.api_update_user_feature_permissions(uuid, text, jsonb) from service_role;
grant execute on function public.api_update_user_feature_permissions(uuid, text, jsonb) to authenticated;

revoke execute on function public.api_get_admin_feature_permissions(uuid) from public;
revoke execute on function public.api_get_admin_feature_permissions(uuid) from anon;
revoke execute on function public.api_get_admin_feature_permissions(uuid) from service_role;
grant execute on function public.api_get_admin_feature_permissions(uuid) to authenticated;

revoke execute on function public.api_update_admin_feature_permissions(uuid, text, jsonb) from public;
revoke execute on function public.api_update_admin_feature_permissions(uuid, text, jsonb) from anon;
revoke execute on function public.api_update_admin_feature_permissions(uuid, text, jsonb) from service_role;
grant execute on function public.api_update_admin_feature_permissions(uuid, text, jsonb) to authenticated;

revoke execute on function public.api_promote_member_to_admin(uuid, text, jsonb) from public;
revoke execute on function public.api_promote_member_to_admin(uuid, text, jsonb) from anon;
revoke execute on function public.api_promote_member_to_admin(uuid, text, jsonb) from service_role;
grant execute on function public.api_promote_member_to_admin(uuid, text, jsonb) to authenticated;

revoke execute on function public.api_demote_admin_to_member(uuid, text, jsonb) from public;
revoke execute on function public.api_demote_admin_to_member(uuid, text, jsonb) from anon;
revoke execute on function public.api_demote_admin_to_member(uuid, text, jsonb) from service_role;
grant execute on function public.api_demote_admin_to_member(uuid, text, jsonb) to authenticated;

revoke execute on function public.api_promote_admin_to_owner(uuid, text, jsonb) from public;
revoke execute on function public.api_promote_admin_to_owner(uuid, text, jsonb) from anon;
revoke execute on function public.api_promote_admin_to_owner(uuid, text, jsonb) from service_role;
grant execute on function public.api_promote_admin_to_owner(uuid, text, jsonb) to authenticated;
