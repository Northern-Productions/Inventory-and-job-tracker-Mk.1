import { canonicalDigest, canonicalSerialize } from '../readonly-diagnostics.mjs';
import { authenticateManifest, unsignedManifest, verifyAuthenticatedManifest } from './manifest.mjs';

const APPLICATION_DEFAULT_ACL_MANIFEST_FORMAT =
  'application-default-acl-preservation-manifest-v1';
const APPLICATION_DEFAULT_ACL_CANONICALIZATION =
  'application-default-acl-preservation-c14n-v1';
const APPLICATION_DEFAULT_ACL_STRATEGY =
  'authenticated-capture-reapply-before-object-creation';
const APPLICATION_DEFAULT_ACL_CLASSIFICATIONS = Object.freeze({
  A: 'APPLICATION_REQUIRED_TARGET_STATE',
  B: 'MANAGED_PLATFORM_TARGET_STATE',
  C: 'SOURCE_GOLDEN_APPLICATION_STATE',
  D: 'SUPERSEDED_HISTORICAL_STATE',
  E: 'UNKNOWN'
});
const APPLICATION_DEFAULT_ACL_SCHEMAS = Object.freeze(['app', 'app_api']);
const OBJECT_CLASS_BY_CATALOG_CODE = Object.freeze({
  r: 'table',
  S: 'sequence',
  f: 'function',
  T: 'type',
  n: 'schema'
});
const SQL_OBJECT_CLASS = Object.freeze({
  table: 'TABLES',
  sequence: 'SEQUENCES',
  function: 'FUNCTIONS',
  type: 'TYPES',
  schema: 'SCHEMAS'
});
const OBJECT_CLASS_PRIVILEGES = Object.freeze({
  table: Object.freeze(['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']),
  sequence: Object.freeze(['SELECT', 'UPDATE', 'USAGE']),
  function: Object.freeze(['EXECUTE']),
  type: Object.freeze(['USAGE']),
  schema: Object.freeze(['CREATE', 'USAGE'])
});
const APPLICATION_DEFAULT_ACL_CATALOG_SQL = `select owner.rolname as "ownerRole",
       namespace.nspname as "schemaName",
       case defaults.defaclobjtype
         when 'r' then 'table'
         when 'S' then 'sequence'
         when 'f' then 'function'
         when 'T' then 'type'
         when 'n' then 'schema'
         else defaults.defaclobjtype::text
       end as "objectClass",
       grantor.rolname as "grantorRole",
       coalesce(grantee.rolname, 'PUBLIC')::text as "grantee",
       acl.privilege_type::text as "privilege",
       acl.is_grantable as "grantOption"
  from pg_catalog.pg_default_acl defaults
  join pg_catalog.pg_roles owner on owner.oid = defaults.defaclrole
  join pg_catalog.pg_namespace namespace on namespace.oid = defaults.defaclnamespace
  cross join lateral pg_catalog.aclexplode(defaults.defaclacl) acl
  join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
  left join pg_catalog.pg_roles grantee on grantee.oid = nullif(acl.grantee, 0)
 where namespace.nspname = any(array['app','app_api'])
 order by "ownerRole", "schemaName", "objectClass", "grantorRole", "grantee",
          "privilege", "grantOption"`;
const APPLICATION_DEFAULT_ACL_SOURCE_0103 =
  '0103_service_role_app_schema_rest_access';
const APPLICATION_DEFAULT_ACL_SOURCE_MANAGED_AUTHENTICATED =
  'supabase-managed-application-defaults';
const APPLICATION_ROUTINE_DEFAULT_PROFILE_FORMAT =
  'application-routine-default-profile-v1';
const APPLICATION_ROUTINE_DEFAULT_SCHEMAS = Object.freeze(['public', 'app', 'app_api']);
const APPLICATION_ROUTINE_DEFAULT_GRANTEES = Object.freeze([
  'PUBLIC',
  'anon',
  'authenticated',
  'service_role',
  'postgres'
]);
const REPOSITORY_APPLICATION_DEFAULT_ACL_INTENT = Object.freeze([
  ['table', 'DELETE'],
  ['table', 'INSERT'],
  ['table', 'SELECT'],
  ['table', 'UPDATE'],
  ['sequence', 'SELECT'],
  ['sequence', 'USAGE']
].map(([objectClass, privilege]) => Object.freeze({
  ownerRole: 'postgres',
  schemaName: 'app',
  objectClass,
  grantorRole: 'postgres',
  grantee: 'service_role',
  privilege,
  grantOption: false
})));
const MANAGED_AUTHENTICATED_APPLICATION_DEFAULT_ACL_INTENT = Object.freeze(
  REPOSITORY_APPLICATION_DEFAULT_ACL_INTENT.map((entry) => Object.freeze({
    ...entry,
    grantee: 'authenticated'
  }))
);

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function checkedIdentifier(value, code) {
  const text = String(value ?? '');
  if (!/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(text)) throw categoricalError(code);
  return text;
}

function normalizeTarget(target = {}) {
  const environment = String(target.environment || '').trim().toLowerCase();
  const projectRef = String(target.projectRef || '').trim().toLowerCase();
  if (!['dev', 'sandbox'].includes(environment) || !/^[a-z0-9]{20}$/.test(projectRef)) {
    throw categoricalError('APPLICATION_DEFAULT_ACL_TARGET_INVALID');
  }
  return { environment, projectRef };
}

function normalizeManagedProfile(profile = {}) {
  const profileId = String(profile.profileId || '').trim();
  const profileDigest = String(profile.profileDigest || '').trim().toLowerCase();
  if (
    !/^[a-z][a-z0-9._-]{2,95}$/.test(profileId) ||
    !/^sha256:[a-f0-9]{64}$/.test(profileDigest)
  ) {
    throw categoricalError('APPLICATION_DEFAULT_ACL_MANAGED_PROFILE_INVALID');
  }
  return { profileId, profileDigest };
}

function normalizeObjectClass(value) {
  const raw = String(value ?? '');
  const objectClass = OBJECT_CLASS_BY_CATALOG_CODE[raw] || raw.toLowerCase();
  if (!Object.hasOwn(SQL_OBJECT_CLASS, objectClass)) {
    throw categoricalError('APPLICATION_DEFAULT_ACL_OBJECT_CLASS_INVALID');
  }
  return objectClass;
}

function normalizeSemanticEntry(row = {}) {
  const schemaName = checkedIdentifier(
    row.schemaName ?? row.schema_name,
    'APPLICATION_DEFAULT_ACL_SCHEMA_INVALID'
  );
  if (!APPLICATION_DEFAULT_ACL_SCHEMAS.includes(schemaName)) {
    throw categoricalError('APPLICATION_DEFAULT_ACL_SCHEMA_INVALID');
  }
  const objectClass = normalizeObjectClass(row.objectClass ?? row.object_type);
  const privilege = String(row.privilege ?? row.privilege_type ?? '').trim().toUpperCase();
  if (!OBJECT_CLASS_PRIVILEGES[objectClass].includes(privilege)) {
    throw categoricalError('APPLICATION_DEFAULT_ACL_PRIVILEGE_INVALID');
  }
  const ownerRole = checkedIdentifier(
    row.ownerRole ?? row.owner_role,
    'APPLICATION_DEFAULT_ACL_OWNER_INVALID'
  );
  const grantorRole = checkedIdentifier(
    row.grantorRole ?? row.grantor_role,
    'APPLICATION_DEFAULT_ACL_GRANTOR_INVALID'
  );
  const rawGrantee = String(row.grantee ?? '');
  const grantee = rawGrantee === 'PUBLIC'
    ? 'PUBLIC'
    : checkedIdentifier(rawGrantee, 'APPLICATION_DEFAULT_ACL_GRANTEE_INVALID');
  const grantOption = row.grantOption === true || row.is_grantable === true;
  return {
    ownerRole,
    schemaName,
    objectClass,
    grantorRole,
    grantee,
    privilege,
    grantOption
  };
}

function semanticKey(entry) {
  return [
    entry.ownerRole,
    entry.schemaName,
    entry.objectClass,
    entry.grantorRole,
    entry.grantee,
    entry.privilege,
    entry.grantOption ? '1' : '0'
  ].join('\u0000');
}

function sortSemanticEntries(entries) {
  return [...entries].sort((left, right) => semanticKey(left).localeCompare(semanticKey(right), 'en'));
}

function normalizeSemanticEntries(rows = []) {
  if (!Array.isArray(rows)) throw categoricalError('APPLICATION_DEFAULT_ACL_ENTRIES_INVALID');
  const normalized = sortSemanticEntries(rows.map(normalizeSemanticEntry));
  if (new Set(normalized.map(semanticKey)).size !== normalized.length) {
    throw categoricalError('APPLICATION_DEFAULT_ACL_ENTRY_DUPLICATE');
  }
  return normalized;
}

function sourceMappingFor(entry) {
  const repository = REPOSITORY_APPLICATION_DEFAULT_ACL_INTENT.some(
    (candidate) => semanticKey(candidate) === semanticKey(entry)
  );
  if (repository) {
    return {
        classification: APPLICATION_DEFAULT_ACL_CLASSIFICATIONS.A,
        sourceEvidence: APPLICATION_DEFAULT_ACL_SOURCE_0103
    };
  }
  const managed = MANAGED_AUTHENTICATED_APPLICATION_DEFAULT_ACL_INTENT.some(
    (candidate) => semanticKey(candidate) === semanticKey(entry)
  );
  return managed
    ? {
        classification: APPLICATION_DEFAULT_ACL_CLASSIFICATIONS.B,
        sourceEvidence: APPLICATION_DEFAULT_ACL_SOURCE_MANAGED_AUTHENTICATED
      }
    : {
        classification: APPLICATION_DEFAULT_ACL_CLASSIFICATIONS.E,
        sourceEvidence: 'unreviewed'
      };
}

function normalizeClassifiedEntry(row = {}) {
  const semantic = normalizeSemanticEntry(row);
  const classification = String(row.classification || '');
  const sourceEvidence = String(row.sourceEvidence || '').trim();
  if (
    !Object.values(APPLICATION_DEFAULT_ACL_CLASSIFICATIONS).includes(classification) ||
    classification === APPLICATION_DEFAULT_ACL_CLASSIFICATIONS.E ||
    !/^[a-z0-9][a-z0-9._-]{2,127}$/.test(sourceEvidence)
  ) {
    throw categoricalError('APPLICATION_DEFAULT_ACL_SOURCE_CLASSIFICATION_UNKNOWN');
  }
  return { ...semantic, classification, sourceEvidence };
}

function buildPlan(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = canonicalSerialize({
      ownerRole: entry.ownerRole,
      schemaName: entry.schemaName,
      objectClass: entry.objectClass,
      grantorRole: entry.grantorRole,
      grantee: entry.grantee,
      grantOption: entry.grantOption,
      classification: entry.classification,
      sourceEvidence: entry.sourceEvidence
    });
    if (!groups.has(key)) {
      groups.set(key, {
        operation: 'grant',
        ownerRole: entry.ownerRole,
        schemaName: entry.schemaName,
        objectClass: entry.objectClass,
        grantorRole: entry.grantorRole,
        grantee: entry.grantee,
        grantOption: entry.grantOption,
        classification: entry.classification,
        sourceEvidence: entry.sourceEvidence,
        privileges: []
      });
    }
    groups.get(key).privileges.push(entry.privilege);
  }
  return [...groups.values()]
    .map((entry) => ({ ...entry, privileges: [...entry.privileges].sort() }))
    .sort((left, right) => canonicalSerialize(left).localeCompare(canonicalSerialize(right), 'en'));
}

function manifestPayload(manifest) {
  return unsignedManifest(manifest);
}

function buildApplicationDefaultAclPreservationManifest({
  target,
  managedProfile,
  entries = []
} = {}) {
  const normalizedTarget = normalizeTarget(target);
  const normalizedProfile = normalizeManagedProfile(managedProfile);
  if (!Array.isArray(entries)) throw categoricalError('APPLICATION_DEFAULT_ACL_ENTRIES_INVALID');
  const classifiedEntries = entries.map(normalizeClassifiedEntry).sort((left, right) => {
    const semantic = semanticKey(left).localeCompare(semanticKey(right), 'en');
    return semantic || canonicalSerialize(left).localeCompare(canonicalSerialize(right), 'en');
  });
  if (classifiedEntries.length === 0) {
    throw categoricalError('APPLICATION_DEFAULT_ACL_REQUIRED_ENTRY_MISSING');
  }
  if (new Set(classifiedEntries.map(semanticKey)).size !== classifiedEntries.length) {
    throw categoricalError('APPLICATION_DEFAULT_ACL_ENTRY_DUPLICATE');
  }
  const semanticEntries = classifiedEntries.map((entry) => normalizeSemanticEntry(entry));
  const plan = buildPlan(classifiedEntries);
  const semanticDigest = canonicalDigest(semanticEntries);
  return {
    format: APPLICATION_DEFAULT_ACL_MANIFEST_FORMAT,
    version: 1,
    canonicalization: APPLICATION_DEFAULT_ACL_CANONICALIZATION,
    strategy: APPLICATION_DEFAULT_ACL_STRATEGY,
    target: normalizedTarget,
    managedProfile: normalizedProfile,
    entries: classifiedEntries,
    entryCount: classifiedEntries.length,
    unknownCount: 0,
    beforeDigest: semanticDigest,
    expectedAfterDigest: semanticDigest,
    plan,
    planDigest: canonicalDigest(plan)
  };
}

function buildRepositoryApplicationDefaultAclManifest({ target, managedProfile, rows = [] } = {}) {
  const normalizedRows = normalizeSemanticEntries(rows);
  const actual = new Set(normalizedRows.map(semanticKey));
  const expected = new Set(REPOSITORY_APPLICATION_DEFAULT_ACL_INTENT.map(semanticKey));
  if ([...expected].some((key) => !actual.has(key))) {
    throw categoricalError('APPLICATION_DEFAULT_ACL_REQUIRED_ENTRY_MISSING');
  }
  if ([...actual].some((key) => !expected.has(key))) {
    throw categoricalError('APPLICATION_DEFAULT_ACL_UNEXPECTED_ENTRY');
  }
  return buildApplicationDefaultAclPreservationManifest({
    target,
    managedProfile,
    entries: normalizedRows.map((entry) => ({ ...entry, ...sourceMappingFor(entry) }))
  });
}

function buildProfileApplicationDefaultAclManifest({ target, managedProfile, rows = [] } = {}) {
  const normalizedRows = normalizeSemanticEntries(rows);
  const actual = new Set(normalizedRows.map(semanticKey));
  const repository = new Set(REPOSITORY_APPLICATION_DEFAULT_ACL_INTENT.map(semanticKey));
  const managed = new Set(MANAGED_AUTHENTICATED_APPLICATION_DEFAULT_ACL_INTENT.map(semanticKey));
  if ([...repository].some((key) => !actual.has(key))) {
    throw categoricalError('APPLICATION_DEFAULT_ACL_REQUIRED_ENTRY_MISSING');
  }
  const managedCount = [...managed].filter((key) => actual.has(key)).length;
  if (managedCount !== 0 && managedCount !== managed.size) {
    throw categoricalError('APPLICATION_DEFAULT_ACL_MANAGED_PROFILE_PARTIAL');
  }
  if ([...actual].some((key) => !repository.has(key) && !managed.has(key))) {
    throw categoricalError('APPLICATION_DEFAULT_ACL_UNEXPECTED_ENTRY');
  }
  return buildApplicationDefaultAclPreservationManifest({
    target,
    managedProfile,
    entries: normalizedRows.map((entry) => ({ ...entry, ...sourceMappingFor(entry) }))
  });
}

function authenticateApplicationDefaultAclManifest(manifest, key) {
  return authenticateManifest(manifest, key);
}

function verifyApplicationDefaultAclManifest({
  certificate,
  key,
  target,
  managedProfile,
  currentEntries
} = {}) {
  try {
    verifyAuthenticatedManifest(certificate, key);
  } catch {
    throw categoricalError('APPLICATION_DEFAULT_ACL_AUTHENTICATION_FAILED');
  }
  const rebuilt = buildApplicationDefaultAclPreservationManifest({
    target: certificate.target,
    managedProfile: certificate.managedProfile,
    entries: certificate.entries
  });
  if (canonicalSerialize(rebuilt) !== canonicalSerialize(manifestPayload(certificate))) {
    throw categoricalError('APPLICATION_DEFAULT_ACL_MANIFEST_DIGEST_MISMATCH');
  }
  if (canonicalSerialize(rebuilt.target) !== canonicalSerialize(normalizeTarget(target))) {
    throw categoricalError('APPLICATION_DEFAULT_ACL_TARGET_MISMATCH');
  }
  if (
    canonicalSerialize(rebuilt.managedProfile) !==
    canonicalSerialize(normalizeManagedProfile(managedProfile))
  ) {
    throw categoricalError('APPLICATION_DEFAULT_ACL_MANAGED_PROFILE_MISMATCH');
  }
  if (currentEntries !== undefined) {
    const current = normalizeSemanticEntries(currentEntries);
    const expected = rebuilt.entries.map(normalizeSemanticEntry);
    if (canonicalSerialize(current) !== canonicalSerialize(expected)) {
      const currentKeys = new Set(current.map(semanticKey));
      const expectedKeys = new Set(expected.map(semanticKey));
      if ([...expectedKeys].some((entry) => !currentKeys.has(entry))) {
        throw categoricalError('APPLICATION_DEFAULT_ACL_REQUIRED_ENTRY_MISSING');
      }
      throw categoricalError('APPLICATION_DEFAULT_ACL_UNEXPECTED_ENTRY');
    }
  }
  return {
    authenticated: true,
    target: rebuilt.target,
    managedProfile: rebuilt.managedProfile,
    entryCount: rebuilt.entryCount,
    beforeDigest: rebuilt.beforeDigest,
    expectedAfterDigest: rebuilt.expectedAfterDigest,
    planDigest: rebuilt.planDigest,
    certificate: rebuilt
  };
}

async function captureApplicationDefaultAclEntries(client) {
  if (!client || typeof client.query !== 'function') {
    throw categoricalError('APPLICATION_DEFAULT_ACL_CLIENT_INVALID');
  }
  return normalizeSemanticEntries((await client.query(APPLICATION_DEFAULT_ACL_CATALOG_SQL)).rows);
}

function normalizeRoutineDefaultProfile(profile = {}) {
  if (
    profile.format !== APPLICATION_ROUTINE_DEFAULT_PROFILE_FORMAT ||
    profile.ownerRole !== 'postgres' ||
    canonicalSerialize(profile.schemaNames) !== canonicalSerialize(APPLICATION_ROUTINE_DEFAULT_SCHEMAS) ||
    !Array.isArray(profile.records)
  ) {
    throw categoricalError('APPLICATION_ROUTINE_DEFAULT_PROFILE_INVALID');
  }
  const seenScopes = new Set();
  const records = profile.records.map((record) => {
    const scope = String(record?.scope || '');
    if (
      (scope !== '<global>' && !APPLICATION_ROUTINE_DEFAULT_SCHEMAS.includes(scope)) ||
      seenScopes.has(scope) ||
      !Array.isArray(record?.entries)
    ) {
      throw categoricalError('APPLICATION_ROUTINE_DEFAULT_PROFILE_INVALID');
    }
    seenScopes.add(scope);
    const entries = record.entries.map((entry) => {
      const normalized = {
        grantorRole: String(entry?.grantorRole || ''),
        grantee: String(entry?.grantee || ''),
        privilege: String(entry?.privilege || ''),
        grantOption: entry?.grantOption
      };
      if (
        normalized.grantorRole !== 'postgres' ||
        !APPLICATION_ROUTINE_DEFAULT_GRANTEES.includes(normalized.grantee) ||
        normalized.privilege !== 'EXECUTE' ||
        typeof normalized.grantOption !== 'boolean'
      ) {
        throw categoricalError('APPLICATION_ROUTINE_DEFAULT_PROFILE_INVALID');
      }
      return normalized;
    }).sort((left, right) => canonicalSerialize(left).localeCompare(canonicalSerialize(right)));
    if (new Set(entries.map(canonicalSerialize)).size !== entries.length) {
      throw categoricalError('APPLICATION_ROUTINE_DEFAULT_PROFILE_INVALID');
    }
    return { scope, entries };
  }).sort((left, right) => left.scope.localeCompare(right.scope));
  return {
    format: APPLICATION_ROUTINE_DEFAULT_PROFILE_FORMAT,
    ownerRole: 'postgres',
    schemaNames: [...APPLICATION_ROUTINE_DEFAULT_SCHEMAS],
    records
  };
}

async function captureApplicationRoutineDefaultProfile(client) {
  if (!client || typeof client.query !== 'function') {
    throw categoricalError('APPLICATION_DEFAULT_ACL_CLIENT_INVALID');
  }
  const rows = (await client.query(`
    select coalesce(namespace.nspname, '<global>')::text as scope,
           grantor.rolname::text as "grantorRole",
           coalesce(grantee.rolname, 'PUBLIC')::text as grantee,
           acl.privilege_type::text as privilege,
           acl.is_grantable as "grantOption"
      from pg_catalog.pg_default_acl defaults
      join pg_catalog.pg_roles owner on owner.oid = defaults.defaclrole
      left join pg_catalog.pg_namespace namespace on namespace.oid = defaults.defaclnamespace
      cross join lateral pg_catalog.aclexplode(defaults.defaclacl) acl
      join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
      left join pg_catalog.pg_roles grantee on grantee.oid = nullif(acl.grantee, 0)
     where owner.rolname = 'postgres'
       and defaults.defaclobjtype = 'f'
       and (
         defaults.defaclnamespace = 0
         or namespace.nspname = any(array['public','app','app_api'])
       )
     order by scope, "grantorRole", grantee, privilege, "grantOption"
  `)).rows;
  const byScope = new Map();
  for (const row of rows) {
    if (!byScope.has(row.scope)) byScope.set(row.scope, []);
    byScope.get(row.scope).push({
      grantorRole: row.grantorRole,
      grantee: row.grantee,
      privilege: row.privilege,
      grantOption: row.grantOption
    });
  }
  return normalizeRoutineDefaultProfile({
    format: APPLICATION_ROUTINE_DEFAULT_PROFILE_FORMAT,
    ownerRole: 'postgres',
    schemaNames: [...APPLICATION_ROUTINE_DEFAULT_SCHEMAS],
    records: [...byScope].map(([scope, entries]) => ({ scope, entries }))
  });
}

function assertHardenedApplicationRoutineDefaultProfile(profile) {
  const normalized = normalizeRoutineDefaultProfile(profile);
  const global = normalized.records.find((record) => record.scope === '<global>');
  if (
    !global || global.entries.length !== 1 ||
    global.entries[0].grantorRole !== 'postgres' ||
    global.entries[0].grantee !== 'postgres' ||
    global.entries[0].privilege !== 'EXECUTE' ||
    global.entries[0].grantOption
  ) {
    throw categoricalError('APPLICATION_ROUTINE_GLOBAL_DEFAULT_UNSAFE');
  }
  if (
    normalized.records
      .filter((record) => record.scope !== '<global>')
      .some((record) => record.entries.some(
        (entry) => entry.grantee !== 'postgres' || entry.privilege !== 'EXECUTE' || entry.grantOption
      ))
  ) {
    throw categoricalError('APPLICATION_ROUTINE_SCHEMA_DEFAULT_UNSAFE');
  }
  return normalized;
}

function routineProfileCatalogSql() {
  return `select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'scope', observed.scope,
      'grantorRole', observed.grantor_role,
      'grantee', observed.grantee,
      'privilege', observed.privilege,
      'grantOption', observed.grant_option
    ) order by observed.scope, observed.grantor_role, observed.grantee,
             observed.privilege, observed.grant_option), '[]'::jsonb)
    from (
      select coalesce(namespace.nspname, '<global>')::text as scope,
             grantor.rolname::text as grantor_role,
             coalesce(grantee.rolname, 'PUBLIC')::text as grantee,
             acl.privilege_type::text as privilege,
             acl.is_grantable as grant_option
        from pg_catalog.pg_default_acl defaults
        join pg_catalog.pg_roles owner on owner.oid = defaults.defaclrole
        left join pg_catalog.pg_namespace namespace on namespace.oid = defaults.defaclnamespace
        cross join lateral pg_catalog.aclexplode(defaults.defaclacl) acl
        join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
        left join pg_catalog.pg_roles grantee on grantee.oid = nullif(acl.grantee, 0)
       where owner.rolname = 'postgres'
         and defaults.defaclobjtype = 'f'
         and (defaults.defaclnamespace = 0 or namespace.nspname = any(array['public','app','app_api']))
    ) observed`;
}

function buildApplicationRoutineDefaultRecoverySql(beforeProfile) {
  const before = normalizeRoutineDefaultProfile(beforeProfile);
  if (before.records.some((record) => record.scope === '<global>')) {
    throw categoricalError('APPLICATION_ROUTINE_RECOVERY_PROFILE_UNSUPPORTED');
  }
  const schemaEntries = before.records.flatMap((record) =>
    record.entries.map((entry) => ({ ...entry, scope: record.scope }))
  );
  if (schemaEntries.some(
    (entry) => entry.grantOption || entry.privilege !== 'EXECUTE' ||
      !APPLICATION_ROUTINE_DEFAULT_GRANTEES.includes(entry.grantee)
  )) {
    throw categoricalError('APPLICATION_ROUTINE_RECOVERY_PROFILE_UNSUPPORTED');
  }
  const expectedRows = schemaEntries
    .map((entry) => ({
      scope: entry.scope,
      grantorRole: entry.grantorRole,
      grantee: entry.grantee,
      privilege: entry.privilege,
      grantOption: entry.grantOption
    }))
    .sort((left, right) => canonicalSerialize(left).localeCompare(canonicalSerialize(right)));
  const expectedJson = JSON.stringify(expectedRows).replaceAll("'", "''");
  const reset = APPLICATION_ROUTINE_DEFAULT_SCHEMAS.map((schemaName) =>
    `alter default privileges for role postgres in schema ${quoteIdentifier(schemaName)} ` +
    'revoke execute on functions from public, anon, authenticated, service_role, postgres;'
  ).join('\n');
  const grants = before.records
    .filter((record) => record.scope !== '<global>')
    .flatMap((record) => record.entries.map((entry) =>
      `alter default privileges for role postgres in schema ${quoteIdentifier(record.scope)} ` +
      `grant execute on functions to ${entry.grantee === 'PUBLIC' ? 'PUBLIC' : quoteIdentifier(entry.grantee)};`
    )).join('\n');
  return `do $application_routine_recovery_precheck$
begin
  if current_user <> 'postgres' or session_user <> 'postgres' then
    raise exception 'APPLICATION_ROUTINE_RECOVERY_ROLE_MISMATCH';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_default_acl defaults
    join pg_catalog.pg_roles owner on owner.oid = defaults.defaclrole
    cross join lateral pg_catalog.aclexplode(defaults.defaclacl) acl
    where owner.rolname = 'postgres' and defaults.defaclnamespace = 0
      and defaults.defaclobjtype = 'f' and acl.grantee = owner.oid
      and acl.privilege_type = 'EXECUTE' and not acl.is_grantable
  ) or exists (
    select 1 from pg_catalog.pg_default_acl defaults
    join pg_catalog.pg_roles owner on owner.oid = defaults.defaclrole
    left join pg_catalog.pg_namespace namespace on namespace.oid = defaults.defaclnamespace
    cross join lateral pg_catalog.aclexplode(defaults.defaclacl) acl
    where owner.rolname = 'postgres' and defaults.defaclobjtype = 'f'
      and (defaults.defaclnamespace = 0 or namespace.nspname = any(array['public','app','app_api']))
      and (acl.grantee <> owner.oid or acl.privilege_type <> 'EXECUTE' or acl.is_grantable)
  ) then
    raise exception 'APPLICATION_ROUTINE_RECOVERY_PRECONDITION_MISMATCH';
  end if;
end
$application_routine_recovery_precheck$;
alter default privileges for role postgres grant execute on functions to public;
${reset}
${grants}
do $application_routine_recovery_postcheck$
declare
  v_expected jsonb := '${expectedJson}'::jsonb;
  v_actual jsonb;
begin
  select (${routineProfileCatalogSql()}) into v_actual;
  if v_actual <> v_expected then
    raise exception 'APPLICATION_ROUTINE_RECOVERY_POSTCHECK_MISMATCH';
  end if;
end
$application_routine_recovery_postcheck$;`;
}

async function captureFuturePublicFunctionDefaultSecurity(
  client,
  { ownerRole = 'postgres', schemaName = 'public' } = {}
) {
  if (!client || typeof client.query !== 'function') {
    throw categoricalError('APPLICATION_DEFAULT_ACL_CLIENT_INVALID');
  }
  const owner = checkedIdentifier(ownerRole, 'APPLICATION_DEFAULT_ACL_OWNER_INVALID');
  const schema = checkedIdentifier(schemaName, 'APPLICATION_DEFAULT_ACL_SCHEMA_INVALID');
  const result = (await client.query(`
    with selected_owner as (
      select oid from pg_catalog.pg_roles where rolname = $1::name
    ), selected_schema as (
      select oid from pg_catalog.pg_namespace where nspname = $2::name
    ), global_acl as (
      select coalesce(defaults.defaclacl, pg_catalog.acldefault('f', owner.oid)) as acl,
             defaults.oid is not null as record_present
        from selected_owner owner
        left join pg_catalog.pg_default_acl defaults
          on defaults.defaclrole = owner.oid
         and defaults.defaclnamespace = 0
         and defaults.defaclobjtype = 'f'
    ), schema_acl as (
      select defaults.defaclacl as acl, defaults.oid is not null as record_present
        from selected_owner owner
        cross join selected_schema namespace
        left join pg_catalog.pg_default_acl defaults
          on defaults.defaclrole = owner.oid
         and defaults.defaclnamespace = namespace.oid
         and defaults.defaclobjtype = 'f'
    ), combined_acl as (
      select acl.* from global_acl defaults
      cross join lateral pg_catalog.aclexplode(defaults.acl) acl
      union all
      select acl.* from schema_acl defaults
      cross join lateral pg_catalog.aclexplode(defaults.acl) acl
    ), public_execute as (
      select exists (
        select 1 from combined_acl acl
        where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
      ) as allowed
    )
    select
      (select allowed from public_execute) as public_execute,
      (select allowed from public_execute) or exists (
        select 1 from combined_acl grants
        join pg_catalog.pg_roles grantee on grantee.oid = grants.grantee
        where grantee.rolname = 'anon' and grants.privilege_type = 'EXECUTE'
      ) as anon_execute,
      (select allowed from public_execute) or exists (
        select 1 from combined_acl grants
        join pg_catalog.pg_roles grantee on grantee.oid = grants.grantee
        where grantee.rolname = 'authenticated' and grants.privilege_type = 'EXECUTE'
      ) as authenticated_execute,
      (select allowed from public_execute) or exists (
        select 1 from combined_acl grants
        join pg_catalog.pg_roles grantee on grantee.oid = grants.grantee
        where grantee.rolname = 'service_role' and grants.privilege_type = 'EXECUTE'
      ) as service_role_execute,
      (select allowed from public_execute) or exists (
        select 1 from combined_acl grants
        join pg_catalog.pg_roles grantee on grantee.oid = grants.grantee
        where grantee.rolname = $1::name and grants.privilege_type = 'EXECUTE'
      ) as owner_execute,
      coalesce((select record_present from global_acl), false) as global_record_present,
      coalesce((select record_present from schema_acl), false) as schema_record_present
  `, [owner, schema])).rows[0];
  if (!result) throw categoricalError('APPLICATION_DEFAULT_ACL_FUNCTION_SECURITY_UNAVAILABLE');
  const profile = await captureApplicationRoutineDefaultProfile(client);
  let hardenedProfile = false;
  try {
    assertHardenedApplicationRoutineDefaultProfile(profile);
    hardenedProfile = true;
  } catch (error) {
    if (!['APPLICATION_ROUTINE_GLOBAL_DEFAULT_UNSAFE', 'APPLICATION_ROUTINE_SCHEMA_DEFAULT_UNSAFE'].includes(error.code)) {
      throw error;
    }
  }
  return {
    ownerRole: owner,
    schemaName: schema,
    publicExecute: result.public_execute === true,
    anonExecute: result.anon_execute === true,
    authenticatedExecute: result.authenticated_execute === true,
    serviceRoleExecute: result.service_role_execute === true,
    ownerExecute: result.owner_execute === true,
    globalRecordPresent: result.global_record_present === true,
    schemaRecordPresent: result.schema_record_present === true,
    profile,
    hardened:
      hardenedProfile && result.public_execute === false && result.anon_execute === false &&
      result.authenticated_execute === false && result.service_role_execute === false &&
      result.owner_execute === true
  };
}

function quoteIdentifier(value) {
  return `"${checkedIdentifier(value, 'APPLICATION_DEFAULT_ACL_IDENTIFIER_INVALID').replaceAll('"', '""')}"`;
}

function renderPlanOperation(operation) {
  if (
    operation.operation !== 'grant' ||
    operation.ownerRole !== operation.grantorRole ||
    !APPLICATION_DEFAULT_ACL_SCHEMAS.includes(operation.schemaName) ||
    !Object.hasOwn(SQL_OBJECT_CLASS, operation.objectClass) ||
    !Array.isArray(operation.privileges) ||
    operation.privileges.length === 0 ||
    operation.privileges.some((privilege) => !OBJECT_CLASS_PRIVILEGES[operation.objectClass].includes(privilege))
  ) {
    throw categoricalError('APPLICATION_DEFAULT_ACL_PLAN_INVALID');
  }
  const grantee = operation.grantee === 'PUBLIC' ? 'PUBLIC' : quoteIdentifier(operation.grantee);
  return `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(operation.ownerRole)} ` +
    `IN SCHEMA ${quoteIdentifier(operation.schemaName)} GRANT ${operation.privileges.join(', ')} ` +
    `ON ${SQL_OBJECT_CLASS[operation.objectClass]} TO ${grantee}` +
    `${operation.grantOption ? ' WITH GRANT OPTION' : ''};`;
}

function sqlJson(value) {
  return JSON.stringify(value).replaceAll("'", "''");
}

function buildApplicationDefaultAclVerificationSql(verified, failureCode = 'APPLICATION_DEFAULT_ACL_POSTCHECK_MISMATCH') {
  const manifest = verified?.certificate;
  if (!manifest || verified.authenticated !== true) {
    throw categoricalError('APPLICATION_DEFAULT_ACL_VERIFIED_MANIFEST_REQUIRED');
  }
  if (!/^[A-Z][A-Z0-9_]{2,80}$/.test(failureCode)) {
    throw categoricalError('APPLICATION_DEFAULT_ACL_FAILURE_CODE_INVALID');
  }
  const expected = manifest.entries.map(normalizeSemanticEntry);
  return `do $application_default_acl_verify$
declare
  v_expected jsonb := '${sqlJson(expected)}'::jsonb;
  v_actual jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into v_actual
    from (${APPLICATION_DEFAULT_ACL_CATALOG_SQL}) q;
  if jsonb_array_length(v_expected) <> jsonb_array_length(v_actual)
     or exists (select 1 from jsonb_array_elements(v_expected) e
                 where not v_actual @> jsonb_build_array(e))
     or exists (select 1 from jsonb_array_elements(v_actual) a
                 where not v_expected @> jsonb_build_array(a)) then
    raise exception '${failureCode}';
  end if;
end
$application_default_acl_verify$;`;
}

function buildApplicationDefaultAclPreservationSql(verified) {
  const manifest = verified?.certificate;
  if (!manifest || verified.authenticated !== true) {
    throw categoricalError('APPLICATION_DEFAULT_ACL_VERIFIED_MANIFEST_REQUIRED');
  }
  const owners = [...new Set(manifest.plan.map((entry) => entry.ownerRole))];
  const grantors = [...new Set(manifest.plan.map((entry) => entry.grantorRole))];
  if (
    owners.length !== 1 || grantors.length !== 1 ||
    owners[0] !== grantors[0] || owners[0] !== 'postgres'
  ) {
    throw categoricalError('APPLICATION_DEFAULT_ACL_EXECUTION_CONTEXT_INVALID');
  }
  const statements = manifest.plan.map(renderPlanOperation).join('\n');
  return `do $application_default_acl_owner_guard$
begin
  if current_user <> '${owners[0]}' then
    raise exception 'APPLICATION_DEFAULT_ACL_EXECUTION_ROLE_MISMATCH';
  end if;
  if exists (
    select 1 from pg_catalog.pg_namespace namespace
    join pg_catalog.pg_roles owner on owner.oid = namespace.nspowner
    where namespace.nspname = any(array['app','app_api'])
      and owner.rolname <> current_user
  ) then raise exception 'APPLICATION_DEFAULT_ACL_SCHEMA_OWNER_MISMATCH'; end if;
  if exists (
    select 1 from pg_catalog.pg_default_acl defaults
    join pg_catalog.pg_namespace namespace on namespace.oid = defaults.defaclnamespace
    where namespace.nspname = any(array['app','app_api'])
  ) then raise exception 'APPLICATION_DEFAULT_ACL_POST_SCHEMA_NOT_EMPTY'; end if;
end
$application_default_acl_owner_guard$;
${statements}
${buildApplicationDefaultAclVerificationSql(verified)}`;
}

export {
  APPLICATION_DEFAULT_ACL_CANONICALIZATION,
  APPLICATION_DEFAULT_ACL_CATALOG_SQL,
  APPLICATION_DEFAULT_ACL_CLASSIFICATIONS,
  APPLICATION_DEFAULT_ACL_MANIFEST_FORMAT,
  APPLICATION_DEFAULT_ACL_SOURCE_0103,
  APPLICATION_DEFAULT_ACL_SOURCE_MANAGED_AUTHENTICATED,
  APPLICATION_ROUTINE_DEFAULT_PROFILE_FORMAT,
  APPLICATION_DEFAULT_ACL_STRATEGY,
  MANAGED_AUTHENTICATED_APPLICATION_DEFAULT_ACL_INTENT,
  REPOSITORY_APPLICATION_DEFAULT_ACL_INTENT,
  authenticateApplicationDefaultAclManifest,
  buildApplicationDefaultAclPreservationManifest,
  buildApplicationDefaultAclPreservationSql,
  buildApplicationDefaultAclVerificationSql,
  buildApplicationRoutineDefaultRecoverySql,
  buildProfileApplicationDefaultAclManifest,
  buildRepositoryApplicationDefaultAclManifest,
  captureApplicationDefaultAclEntries,
  captureApplicationRoutineDefaultProfile,
  captureFuturePublicFunctionDefaultSecurity,
  assertHardenedApplicationRoutineDefaultProfile,
  normalizeRoutineDefaultProfile,
  normalizeSemanticEntries,
  verifyApplicationDefaultAclManifest
};
