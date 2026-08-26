const APPLICATION_ROUTINE_SCHEMAS = Object.freeze(['public', 'app', 'app_api']);
const APPLICATION_ROUTINE_CREATOR_ROLES = Object.freeze(['postgres']);
const APPLICATION_ROUTINE_PLATFORM_ROLES = Object.freeze([
  'anon',
  'authenticated',
  'service_role'
]);

const APPLICATION_ROUTINE_OWNER_SQL = `
  select
    namespace.nspname as schema_name,
    owner.rolname as owner_role,
    count(*)::integer as routine_count
  from pg_catalog.pg_proc routine
  join pg_catalog.pg_namespace namespace
    on namespace.oid = routine.pronamespace
  join pg_catalog.pg_roles owner
    on owner.oid = routine.proowner
  where namespace.nspname = any($1::text[])
    and not exists (
      select 1
      from pg_catalog.pg_depend dependency
      where dependency.classid = 'pg_proc'::regclass
        and dependency.objid = routine.oid
        and dependency.deptype = 'e'
    )
  group by namespace.nspname, owner.rolname
  order by namespace.nspname, owner.rolname
`;

const APPLICATION_ROUTINE_DEFAULT_SQL = `
  with selected_owner as (
    select oid
    from pg_catalog.pg_roles
    where rolname = $1::name
  ), relevant_defaults as (
    select
      defaults.oid,
      defaults.defaclnamespace,
      coalesce(namespace.nspname, '<global>') as scope,
      defaults.defaclacl
    from selected_owner owner
    join pg_catalog.pg_default_acl defaults
      on defaults.defaclrole = owner.oid
     and defaults.defaclobjtype = 'f'
    left join pg_catalog.pg_namespace namespace
      on namespace.oid = defaults.defaclnamespace
    where defaults.defaclnamespace = 0
       or namespace.nspname = any($2::text[])
  )
  select
    defaults.scope,
    case
      when grant_entry.grantee = 0 then 'PUBLIC'
      else grantee.rolname
    end as grantee,
    grant_entry.privilege_type,
    grant_entry.is_grantable
  from relevant_defaults defaults
  cross join lateral pg_catalog.aclexplode(defaults.defaclacl) grant_entry
  left join pg_catalog.pg_roles grantee
    on grantee.oid = grant_entry.grantee
  order by defaults.scope, grantee, grant_entry.privilege_type, grant_entry.is_grantable
`;

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeRows(rows) {
  return rows.map((row) => ({
    ...row,
    routine_count: row.routine_count === undefined ? undefined : Number(row.routine_count)
  }));
}

async function captureApplicationRoutineDefaultSecurity(client) {
  if (!client || typeof client.query !== 'function') {
    throw categoricalError('APPLICATION_ROUTINE_SECURITY_CLIENT_INVALID');
  }
  const [ownerResult, defaultResult] = await Promise.all([
    client.query(APPLICATION_ROUTINE_OWNER_SQL, [APPLICATION_ROUTINE_SCHEMAS]),
    client.query(APPLICATION_ROUTINE_DEFAULT_SQL, [
      APPLICATION_ROUTINE_CREATOR_ROLES[0],
      APPLICATION_ROUTINE_SCHEMAS
    ])
  ]);
  return {
    creatorRoles: [...APPLICATION_ROUTINE_CREATOR_ROLES],
    schemas: [...APPLICATION_ROUTINE_SCHEMAS],
    ownerDistribution: normalizeRows(ownerResult.rows),
    functionDefaults: normalizeRows(defaultResult.rows)
  };
}

function assertApplicationRoutineDefaultSecurity(contract) {
  if (!contract || !Array.isArray(contract.ownerDistribution) || !Array.isArray(contract.functionDefaults)) {
    throw categoricalError('APPLICATION_ROUTINE_SECURITY_CONTRACT_INVALID');
  }
  const recognizedOwners = new Set(APPLICATION_ROUTINE_CREATOR_ROLES);
  if (
    contract.ownerDistribution.length === 0 ||
    contract.ownerDistribution.some(
      (entry) => !recognizedOwners.has(entry.owner_role) || !APPLICATION_ROUTINE_SCHEMAS.includes(entry.schema_name)
    )
  ) {
    throw categoricalError('APPLICATION_ROUTINE_CREATOR_ROLE_UNRECOGNIZED');
  }

  const globalEntries = contract.functionDefaults.filter((entry) => entry.scope === '<global>');
  if (globalEntries.length === 0) {
    throw categoricalError('APPLICATION_ROUTINE_GLOBAL_DEFAULT_MISSING');
  }
  if (
    globalEntries.length !== 1 ||
    globalEntries[0].grantee !== APPLICATION_ROUTINE_CREATOR_ROLES[0] ||
    globalEntries[0].privilege_type !== 'EXECUTE' ||
    globalEntries[0].is_grantable !== false
  ) {
    throw categoricalError('APPLICATION_ROUTINE_GLOBAL_DEFAULT_UNSAFE');
  }

  const unsafeSchemaEntry = contract.functionDefaults.find(
    (entry) =>
      entry.scope !== '<global>' &&
      (entry.grantee !== APPLICATION_ROUTINE_CREATOR_ROLES[0] ||
        entry.privilege_type !== 'EXECUTE' ||
        entry.is_grantable !== false)
  );
  if (unsafeSchemaEntry) {
    throw categoricalError('APPLICATION_ROUTINE_SCHEMA_DEFAULT_UNSAFE');
  }

  if (
    contract.functionDefaults.some(
      (entry) => entry.grantee === 'PUBLIC' || APPLICATION_ROUTINE_PLATFORM_ROLES.includes(entry.grantee)
    )
  ) {
    throw categoricalError('APPLICATION_ROUTINE_DEFAULT_EXECUTE_EXPOSED');
  }
  return contract;
}

export {
  APPLICATION_ROUTINE_CREATOR_ROLES,
  APPLICATION_ROUTINE_DEFAULT_SQL,
  APPLICATION_ROUTINE_OWNER_SQL,
  APPLICATION_ROUTINE_PLATFORM_ROLES,
  APPLICATION_ROUTINE_SCHEMAS,
  assertApplicationRoutineDefaultSecurity,
  captureApplicationRoutineDefaultSecurity
};
