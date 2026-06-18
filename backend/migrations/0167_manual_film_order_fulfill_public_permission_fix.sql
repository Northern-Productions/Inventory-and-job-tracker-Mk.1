-- Ensure the direct manual film-order fulfill RPC is not executable through
-- PostgreSQL's default PUBLIC grant. User-session callers must use the ACL wrapper.

select app_api.revoke_execute_if_exists('public.api_film_orders_manual_fulfill(uuid, text, jsonb)', 'public');
select app_api.revoke_execute_if_exists('public.api_film_orders_manual_fulfill(uuid, text, jsonb)', 'anon');
select app_api.revoke_execute_if_exists('public.api_film_orders_manual_fulfill(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_film_orders_manual_fulfill(uuid, text, jsonb)', 'service_role');

select app_api.revoke_execute_if_exists('public.api_acl_film_orders_manual_fulfill(uuid, text, jsonb)', 'public');
select app_api.grant_execute_if_exists('public.api_acl_film_orders_manual_fulfill(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_film_orders_manual_fulfill(uuid, text, jsonb)', 'service_role');
