-- Allow the Edge service-role REST client to use the app schema.
-- The app schema still remains closed to anon/authenticated direct REST access;
-- user-facing reads and writes continue through Edge handlers and ACL RPCs.

grant usage on schema app to service_role;

grant select, insert, update, delete
on all tables in schema app
to service_role;

grant usage, select
on all sequences in schema app
to service_role;

alter default privileges in schema app
grant select, insert, update, delete on tables to service_role;

alter default privileges in schema app
grant usage, select on sequences to service_role;
