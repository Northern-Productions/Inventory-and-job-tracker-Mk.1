-- Normalize exact calendar and film-order-cancel function grants to least privilege.
-- PROD-only service_role grants were historical drift; checked-in callers use authenticated ACL wrappers.
revoke execute on function public.api_jobs_calendar(uuid, text, text) from public, anon, authenticated, service_role;
revoke execute on function public.api_acl_list_jobs_calendar(uuid, text, text) from public, anon, service_role;
grant execute on function public.api_acl_list_jobs_calendar(uuid, text, text) to authenticated;

revoke execute on function public.api_film_orders_cancel(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke execute on function public.api_acl_film_orders_cancel(uuid, text, jsonb) from public, anon, service_role;
grant execute on function public.api_acl_film_orders_cancel(uuid, text, jsonb) to authenticated;
