-- Close future application routines by default for the canonical migration owner.
-- Existing routine ACLs are intentionally unchanged; migrations must grant EXECUTE
-- explicitly when exposing a newly created routine.

do $application_routine_creator_guard$
begin
  if current_user <> 'postgres' or session_user <> 'postgres' then
    raise exception 'APPLICATION_ROUTINE_CREATOR_ROLE_MISMATCH';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc routine
    join pg_catalog.pg_namespace namespace
      on namespace.oid = routine.pronamespace
    join pg_catalog.pg_roles owner
      on owner.oid = routine.proowner
    where namespace.nspname in ('public', 'app', 'app_api')
      and not exists (
        select 1
        from pg_catalog.pg_depend dependency
        where dependency.classid = 'pg_proc'::regclass
          and dependency.objid = routine.oid
          and dependency.deptype = 'e'
      )
      and owner.rolname <> 'postgres'
  ) then
    raise exception 'APPLICATION_ROUTINE_CREATOR_ROLE_UNRECOGNIZED';
  end if;
end
$application_routine_creator_guard$;

-- A schema-scoped revoke cannot remove PostgreSQL's built-in global PUBLIC
-- function privilege. This global revoke is the security boundary.
alter default privileges for role postgres
revoke execute on functions from public;

-- Supabase-managed profiles can also contain additive schema-scoped grants.
-- Remove only automatic routine exposure for the application schemas; owner
-- capability and unrelated table/sequence defaults remain intact.
alter default privileges for role postgres in schema public, app, app_api
revoke execute on functions from public, anon, authenticated, service_role;

do $application_routine_default_guard$
declare
  v_owner_oid oid := (select oid from pg_catalog.pg_roles where rolname = 'postgres');
begin
  if v_owner_oid is null then
    raise exception 'APPLICATION_ROUTINE_CREATOR_ROLE_MISSING';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_default_acl defaults
    where defaults.defaclrole = v_owner_oid
      and defaults.defaclnamespace = 0
      and defaults.defaclobjtype = 'f'
  ) then
    raise exception 'APPLICATION_ROUTINE_GLOBAL_DEFAULT_MISSING';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_default_acl defaults
    cross join lateral pg_catalog.aclexplode(defaults.defaclacl) grant_entry
    where defaults.defaclrole = v_owner_oid
      and defaults.defaclnamespace = 0
      and defaults.defaclobjtype = 'f'
      and (
        grant_entry.grantee <> v_owner_oid
        or grant_entry.privilege_type <> 'EXECUTE'
        or grant_entry.is_grantable
      )
  ) or not exists (
    select 1
    from pg_catalog.pg_default_acl defaults
    cross join lateral pg_catalog.aclexplode(defaults.defaclacl) grant_entry
    where defaults.defaclrole = v_owner_oid
      and defaults.defaclnamespace = 0
      and defaults.defaclobjtype = 'f'
      and grant_entry.grantee = v_owner_oid
      and grant_entry.privilege_type = 'EXECUTE'
      and not grant_entry.is_grantable
  ) then
    raise exception 'APPLICATION_ROUTINE_GLOBAL_DEFAULT_UNSAFE';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_default_acl defaults
    join pg_catalog.pg_namespace namespace
      on namespace.oid = defaults.defaclnamespace
    cross join lateral pg_catalog.aclexplode(defaults.defaclacl) grant_entry
    where defaults.defaclrole = v_owner_oid
      and defaults.defaclobjtype = 'f'
      and namespace.nspname in ('public', 'app', 'app_api')
      and (
        grant_entry.grantee <> v_owner_oid
        or grant_entry.privilege_type <> 'EXECUTE'
        or grant_entry.is_grantable
      )
  ) then
    raise exception 'APPLICATION_ROUTINE_SCHEMA_DEFAULT_UNSAFE';
  end if;
end
$application_routine_default_guard$;
