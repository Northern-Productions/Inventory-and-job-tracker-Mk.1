import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { canonicalDigest, canonicalSerialize } from '../readonly-diagnostics.mjs';
import { PROD_PROJECT_REF } from '../target-env-guards.mjs';
import { AUTH_PURGE_ORDER, CURRENT_AUTH_TABLES } from './constants.mjs';
import {
  APPLICATION_ACL_CONTRACT_FORMAT,
  buildApplicationAclConvergenceSql,
  verifyApplicationAclContract
} from './application-acl-convergence.mjs';
import { parseDatabaseConnection, postgresChildEnvironment } from './encrypted-baseline.mjs';
import {
  privateArtifactPath,
  verifyPrivateArtifactProtection,
  verifyPrivateDirectoryProtection,
  writePrivateBytesExclusive,
  writePrivateJsonExclusive
} from './private-artifacts.mjs';
import { runPrivateDiagnosticCommand } from './private-diagnostics.mjs';

const MANAGED_RESTORE_MANIFEST_FORMAT = 'supabase-managed-overlay-restore-manifest-v1';
const MANAGED_RESTORE_CANONICALIZATION = 'supabase-managed-overlay-toc-c14n-v1';
const MANAGED_RESTORE_ACTIONS = Object.freeze([
  'restore',
  'transform',
  'skip-as-managed',
  'recreate-target-locally',
  'preserve-target-native'
]);
const MANAGED_RESTORE_CATEGORIES = Object.freeze({
  A: 'PORTABLE_APPLICATION_OBJECT',
  B: 'PORTABLE_APPLICATION_DATA',
  C: 'PORTABLE_APPLICATION_ROLE_GRANT',
  D: 'AUTH_RELATIONAL_DATA_NEEDED_FOR_UUID_SHAPE',
  E: 'TARGET_MANAGED_OBJECT',
  F: 'TARGET_MANAGED_ROLE_OWNERSHIP',
  G: 'PLATFORM_CONFIG',
  H: 'UNCERTAIN'
});
const REQUIRED_MANAGED_ROLES = Object.freeze([
  'anon',
  'authenticated',
  'authenticator',
  'postgres',
  'service_role',
  'supabase_admin',
  'supabase_auth_admin',
  'supabase_realtime_admin',
  'supabase_storage_admin'
]);
const TARGET_NATIVE_SCHEMAS = Object.freeze([
  'auth',
  'extensions',
  'graphql',
  'graphql_public',
  'public',
  'realtime',
  'storage',
  'vault'
]);
const TARGET_NATIVE_SCHEMA_OWNERS = Object.freeze({
  auth: 'supabase_admin',
  extensions: 'postgres',
  graphql: 'supabase_admin',
  graphql_public: 'supabase_admin',
  public: 'pg_database_owner',
  realtime: 'supabase_admin',
  storage: 'supabase_admin',
  vault: 'supabase_admin'
});
const REQUIRED_TARGET_EXTENSIONS = Object.freeze(['pgcrypto', 'uuid-ossp']);
const AUTH_OVERLAY_TABLES = Object.freeze(['users', 'identities']);
const AUTH_PRESERVED_TABLES = Object.freeze(['instances', 'schema_migrations']);
const AUTH_USERS_COPY_COLUMNS = Object.freeze([
  'instance_id', 'id', 'aud', 'role', 'email', 'encrypted_password',
  'email_confirmed_at', 'invited_at', 'confirmation_token', 'confirmation_sent_at',
  'recovery_token', 'recovery_sent_at', 'email_change_token_new', 'email_change',
  'email_change_sent_at', 'last_sign_in_at', 'raw_app_meta_data', 'raw_user_meta_data',
  'is_super_admin', 'created_at', 'updated_at', 'phone', 'phone_confirmed_at',
  'phone_change', 'phone_change_token', 'phone_change_sent_at',
  'email_change_token_current', 'email_change_confirm_status', 'banned_until',
  'reauthentication_token', 'reauthentication_sent_at', 'is_sso_user', 'deleted_at',
  'is_anonymous'
]);
const AUTH_IDENTITIES_COPY_COLUMNS = Object.freeze([
  'provider_id', 'user_id', 'identity_data', 'provider', 'last_sign_in_at',
  'created_at', 'updated_at', 'id'
]);
const MANAGED_OWNER_ROLES = new Set([
  'pg_database_owner',
  'supabase_admin',
  'supabase_auth_admin',
  'supabase_realtime_admin',
  'supabase_storage_admin'
]);
const TOC_LINE = /^(\d+);\s+(\d+)\s+(\d+)\s+(.+?)\s+(-|app|app_api|auth|public|supabase_migrations)\s+(.+)\s+(\S+)$/;

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function safeCount(value, code = 'MANAGED_RESTORE_COUNT_INVALID') {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw categoricalError(code);
  return count;
}

function parsePgRestoreList(tocText) {
  const lines = String(tocText || '').split(/\r?\n/);
  const entries = [];
  const dumpIds = new Set();
  for (const rawLine of lines) {
    if (!/^\d+;/.test(rawLine)) continue;
    const match = rawLine.match(TOC_LINE);
    if (!match) throw categoricalError('MANAGED_RESTORE_TOC_LINE_UNRECOGNIZED');
    const entry = {
      dumpId: Number(match[1]),
      catalogOid: Number(match[2]),
      objectOid: Number(match[3]),
      objectType: match[4].trim(),
      schema: match[5],
      name: match[6].trim(),
      owner: match[7].trim(),
      rawLine
    };
    if (!Number.isSafeInteger(entry.dumpId) || dumpIds.has(entry.dumpId)) {
      throw categoricalError('MANAGED_RESTORE_TOC_ID_INVALID');
    }
    dumpIds.add(entry.dumpId);
    entries.push(entry);
  }
  if (entries.length === 0) throw categoricalError('MANAGED_RESTORE_TOC_EMPTY');
  return entries;
}

function disposition(category, action, reason) {
  return { category, action, reason };
}

function isSchemaDescriptor(entry, schemaName) {
  return entry.objectType === 'SCHEMA' && entry.schema === '-' && entry.name === schemaName;
}

function isSchemaMetadata(entry, schemaName) {
  return entry.schema === '-' && entry.name === `SCHEMA ${schemaName}`;
}

function classifyTocEntry(entry) {
  const isData = ['TABLE DATA', 'SEQUENCE SET'].includes(entry.objectType);
  const isGrant = ['ACL', 'DEFAULT ACL'].includes(entry.objectType);

  if (['app', 'app_api'].includes(entry.schema)) {
    if (entry.owner !== 'postgres') {
      return disposition(MANAGED_RESTORE_CATEGORIES.H, '', 'application object has an unreviewed owner');
    }
    if (isData) return disposition(MANAGED_RESTORE_CATEGORIES.B, 'restore', 'application data');
    if (isGrant) return disposition(MANAGED_RESTORE_CATEGORIES.C, 'restore', 'application ACL');
    return disposition(MANAGED_RESTORE_CATEGORIES.A, 'restore', 'application object');
  }

  if (entry.schema === 'public') {
    if (entry.objectType === 'DEFAULT ACL') {
      return disposition(MANAGED_RESTORE_CATEGORIES.F, 'preserve-target-native', 'native public defaults');
    }
    const portableTypes = new Set(['FUNCTION', 'PROCEDURE', 'COMMENT', 'ACL']);
    if (!portableTypes.has(entry.objectType) || entry.owner !== 'postgres') {
      return disposition(MANAGED_RESTORE_CATEGORIES.H, '', 'public object is outside the reviewed application facade');
    }
    if (entry.objectType === 'ACL') {
      return disposition(MANAGED_RESTORE_CATEGORIES.C, 'restore', 'application facade ACL');
    }
    return disposition(MANAGED_RESTORE_CATEGORIES.A, 'restore', 'application facade object');
  }

  if (entry.schema === 'auth') {
    if (isData && AUTH_OVERLAY_TABLES.includes(entry.name)) {
      return disposition(
        MANAGED_RESTORE_CATEGORIES.D,
        'transform',
        'pre-quarantine and transplant relational UUID rows'
      );
    }
    if (isData) {
      const action = AUTH_PRESERVED_TABLES.includes(entry.name)
        ? 'preserve-target-native'
        : 'skip-as-managed';
      return disposition(
        MANAGED_RESTORE_CATEGORIES.E,
        action,
        AUTH_PRESERVED_TABLES.includes(entry.name)
          ? 'target-native Auth control data'
          : 'copied Auth session, token, state, or audit data is omitted'
      );
    }
    if (isGrant) {
      return disposition(MANAGED_RESTORE_CATEGORIES.F, 'preserve-target-native', 'native Auth ownership and ACL');
    }
    return disposition(MANAGED_RESTORE_CATEGORIES.E, 'preserve-target-native', 'native Auth definition');
  }

  if (entry.schema === 'supabase_migrations') {
    if (entry.owner !== 'postgres') {
      return disposition(MANAGED_RESTORE_CATEGORIES.H, '', 'migration ledger owner is unreviewed');
    }
    return disposition(MANAGED_RESTORE_CATEGORIES.G, 'recreate-target-locally', 'migration ledger is restored separately');
  }

  if (entry.schema === '-') {
    if (isSchemaDescriptor(entry, 'app') || isSchemaDescriptor(entry, 'app_api')) {
      return entry.owner === 'postgres'
        ? disposition(MANAGED_RESTORE_CATEGORIES.A, 'restore', 'application schema')
        : disposition(MANAGED_RESTORE_CATEGORIES.H, '', 'application schema owner is unreviewed');
    }
    if (isSchemaMetadata(entry, 'app') || isSchemaMetadata(entry, 'app_api')) {
      return entry.owner === 'postgres'
        ? disposition(MANAGED_RESTORE_CATEGORIES.C, 'restore', 'application schema ACL')
        : disposition(MANAGED_RESTORE_CATEGORIES.H, '', 'application schema ACL owner is unreviewed');
    }
    if (
      isSchemaDescriptor(entry, 'auth') ||
      isSchemaMetadata(entry, 'auth') ||
      isSchemaDescriptor(entry, 'public') ||
      isSchemaMetadata(entry, 'public')
    ) {
      return disposition(
        isGrant ? MANAGED_RESTORE_CATEGORIES.F : MANAGED_RESTORE_CATEGORIES.E,
        'preserve-target-native',
        'native managed schema primitive'
      );
    }
    if (isSchemaDescriptor(entry, 'supabase_migrations') || isSchemaMetadata(entry, 'supabase_migrations')) {
      return entry.owner === 'postgres'
        ? disposition(MANAGED_RESTORE_CATEGORIES.G, 'recreate-target-locally', 'migration ledger schema')
        : disposition(MANAGED_RESTORE_CATEGORIES.H, '', 'migration ledger schema owner is unreviewed');
    }
  }

  if (/\b(?:ROLE|ROLE MEMBERSHIP)\b/.test(entry.objectType)) {
    if (REQUIRED_MANAGED_ROLES.includes(entry.name) || MANAGED_OWNER_ROLES.has(entry.name)) {
      return disposition(MANAGED_RESTORE_CATEGORIES.F, 'preserve-target-native', 'managed role');
    }
  }
  return disposition(MANAGED_RESTORE_CATEGORIES.H, '', 'unreviewed archive object');
}

function manifestPayload(manifest) {
  const { planDigest: _planDigest, ...payload } = manifest;
  return payload;
}

function buildManagedRestoreManifest({ tocText, sourceComponent = {}, applicationAclContract } = {}) {
  if (applicationAclContract !== undefined) verifyApplicationAclContract(applicationAclContract);
  const parsed = parsePgRestoreList(tocText);
  const entries = parsed.map((entry) => {
    const classified = classifyTocEntry(entry);
    return {
      dumpId: entry.dumpId,
      catalogOid: entry.catalogOid,
      objectOid: entry.objectOid,
      objectType: entry.objectType,
      schema: entry.schema,
      name: entry.name,
      owner: entry.owner,
      ...classified
    };
  });
  const unknown = entries.filter((entry) => entry.category === MANAGED_RESTORE_CATEGORIES.H);
  if (unknown.length > 0) throw categoricalError('MANAGED_RESTORE_UNKNOWN_OBJECT');
  const categoryCounts = Object.fromEntries(
    Object.values(MANAGED_RESTORE_CATEGORIES).map((category) => [
      category,
      entries.filter((entry) => entry.category === category).length
    ])
  );
  const actionCounts = Object.fromEntries(
    MANAGED_RESTORE_ACTIONS.map((action) => [action, entries.filter((entry) => entry.action === action).length])
  );
  const manifest = {
    format: MANAGED_RESTORE_MANIFEST_FORMAT,
    version: 1,
    canonicalization: MANAGED_RESTORE_CANONICALIZATION,
    sourceComponent: {
      name: String(sourceComponent.name || 'postgres-logical-custom-encrypted'),
      size: safeCount(sourceComponent.size || 0),
      digest: String(sourceComponent.digest || '').toLowerCase()
    },
    toc: {
      count: entries.length,
      digest: sha256(Buffer.from(String(tocText || '').replace(/\r\n/g, '\n'), 'utf8'))
    },
    categoryCounts,
    actionCounts,
    managedPlane: {
      roles: [...REQUIRED_MANAGED_ROLES],
      schemas: [...TARGET_NATIVE_SCHEMAS],
      copiedAuthDefinitions: false,
      copiedAuthCredentials: false,
      copiedAuthEphemera: false,
      sessionReplicationRoleRequired: false
    },
    applicationAclConvergence: applicationAclContract === undefined ? null : {
      format: APPLICATION_ACL_CONTRACT_FORMAT,
      contractDigest: applicationAclContract.contractDigest,
      objectDigest: applicationAclContract.objectDigest,
      grantDigest: applicationAclContract.grantDigest,
      objectCount: applicationAclContract.objects.length,
      grantCount: applicationAclContract.grants.length
    },
    entries
  };
  manifest.planDigest = sha256(Buffer.from(canonicalSerialize(manifestPayload(manifest)), 'utf8'));
  return manifest;
}

function verifyManagedRestoreManifest(manifest) {
  if (
    manifest?.format !== MANAGED_RESTORE_MANIFEST_FORMAT ||
    manifest?.version !== 1 ||
    manifest?.canonicalization !== MANAGED_RESTORE_CANONICALIZATION ||
    !Array.isArray(manifest?.entries) ||
    manifest.entries.length === 0
  ) {
    throw categoricalError('MANAGED_RESTORE_MANIFEST_INVALID');
  }
  if (new Set(manifest.entries.map((entry) => entry.dumpId)).size !== manifest.entries.length) {
    throw categoricalError('MANAGED_RESTORE_MANIFEST_INVALID');
  }
  for (const entry of manifest.entries) {
    if (
      !Object.values(MANAGED_RESTORE_CATEGORIES).includes(entry.category) ||
      !MANAGED_RESTORE_ACTIONS.includes(entry.action) ||
      entry.category === MANAGED_RESTORE_CATEGORIES.H ||
      !String(entry.reason || '').trim()
    ) {
      throw categoricalError('MANAGED_RESTORE_MANIFEST_INVALID');
    }
  }
  if (manifest.applicationAclConvergence != null) {
    const acl = manifest.applicationAclConvergence;
    if (
      acl?.format !== APPLICATION_ACL_CONTRACT_FORMAT ||
      !/^sha256:[a-f0-9]{64}$/.test(String(acl?.contractDigest || '')) ||
      !/^sha256:[a-f0-9]{64}$/.test(String(acl?.objectDigest || '')) ||
      !/^sha256:[a-f0-9]{64}$/.test(String(acl?.grantDigest || '')) ||
      !Number.isSafeInteger(acl?.objectCount) || acl.objectCount < 1 ||
      !Number.isSafeInteger(acl?.grantCount) || acl.grantCount < 0
    ) {
      throw categoricalError('MANAGED_RESTORE_ACL_CONVERGENCE_INVALID');
    }
  }
  const expected = sha256(Buffer.from(canonicalSerialize(manifestPayload(manifest)), 'utf8'));
  if (manifest.planDigest !== expected) throw categoricalError('MANAGED_RESTORE_MANIFEST_DIGEST_MISMATCH');
  return true;
}

function restoreListFromManifest(tocText, manifest, actions) {
  verifyManagedRestoreManifest(manifest);
  const allowed = new Set(actions);
  const selectedIds = new Set(
    manifest.entries.filter((entry) => allowed.has(entry.action)).map((entry) => entry.dumpId)
  );
  const selected = parsePgRestoreList(tocText).filter((entry) => selectedIds.has(entry.dumpId));
  if (selected.length !== selectedIds.size) throw categoricalError('MANAGED_RESTORE_LIST_COVERAGE_MISMATCH');
  return `${selected.map((entry) => entry.rawLine).join('\n')}\n`;
}

function applicationRestoreList(tocText, manifest) {
  return restoreListFromManifest(tocText, manifest, ['restore']);
}

function migrationRestoreList(tocText, manifest) {
  return restoreListFromManifest(tocText, manifest, ['recreate-target-locally']);
}

function authTransformEntries(manifest) {
  verifyManagedRestoreManifest(manifest);
  return manifest.entries.filter((entry) => entry.action === 'transform');
}

function normalizeAuthShape(rows = []) {
  return rows.map((row) => ({
    tableName: String(row.table_name || row.tableName || ''),
    ordinalPosition: Number(row.ordinal_position || row.ordinalPosition || 0),
    columnName: String(row.column_name || row.columnName || ''),
    udtName: String(row.udt_name || row.udtName || ''),
    nullable: String(row.is_nullable || row.nullable || ''),
    generated: String(row.is_generated || row.generated || 'NEVER'),
    generationExpression: String(row.generation_expression || row.generationExpression || '')
  }));
}

function assertAuthOverlayCompatibility({ sourceColumns = [], targetColumns = [], targetTriggers = [] } = {}) {
  const source = normalizeAuthShape(sourceColumns);
  const target = normalizeAuthShape(targetColumns);
  if (canonicalSerialize(source) !== canonicalSerialize(target)) {
    throw categoricalError('MANAGED_AUTH_COLUMN_SHAPE_MISMATCH');
  }
  const expectedCopyColumns = new Map([
    ['users', AUTH_USERS_COPY_COLUMNS],
    ['identities', AUTH_IDENTITIES_COPY_COLUMNS]
  ]);
  for (const [tableName, expected] of expectedCopyColumns) {
    const actual = target
      .filter((column) => column.tableName === tableName && column.generated !== 'ALWAYS')
      .map((column) => column.columnName);
    if (canonicalSerialize(actual) !== canonicalSerialize(expected)) {
      throw categoricalError('MANAGED_AUTH_COPY_COLUMNS_UNREVIEWED');
    }
  }
  if (targetTriggers.length !== 0) throw categoricalError('MANAGED_AUTH_TRIGGER_SHAPE_UNREVIEWED');
  return {
    compatible: true,
    sourceDigest: canonicalDigest(source),
    targetDigest: canonicalDigest(target),
    copiedTables: [...AUTH_OVERLAY_TABLES],
    generatedColumnsOmitted: ['auth.users.confirmed_at', 'auth.identities.email']
  };
}

async function captureManagedTargetCatalog(client) {
  const transaction = (await client.query(
    `select current_setting('transaction_read_only') as transaction_read_only,
            current_user as role_name,
            r.rolsuper,
            pg_catalog.pg_has_role(current_user, 'supabase_admin', 'member') as member_supabase_admin,
            pg_catalog.pg_has_role(current_user, 'supabase_auth_admin', 'member') as member_auth_admin,
            pg_catalog.pg_has_role(current_user, 'supabase_storage_admin', 'member') as member_storage_admin,
            pg_catalog.pg_has_role(current_user, 'supabase_realtime_admin', 'member') as member_realtime_admin,
            pg_catalog.has_parameter_privilege(current_user, 'session_replication_role', 'set') as can_set_replication_role,
            pg_catalog.has_schema_privilege(current_user, 'auth', 'usage') as auth_schema_usage,
            pg_catalog.has_table_privilege(current_user, 'auth.users', 'insert,delete') as auth_users_dml,
            pg_catalog.has_table_privilege(current_user, 'auth.identities', 'insert,delete') as auth_identities_dml
       from pg_catalog.pg_roles r
      where r.rolname = current_user`
  )).rows[0];
  const roles = (await client.query(
    `select rolname as role_name, rolsuper, rolcanlogin
       from pg_catalog.pg_roles
      where rolname = any($1::text[])
      order by rolname`,
    [[...REQUIRED_MANAGED_ROLES, 'pg_database_owner']]
  )).rows;
  const schemas = (await client.query(
    `select n.nspname as schema_name, r.rolname as owner_role
       from pg_catalog.pg_namespace n
       join pg_catalog.pg_roles r on r.oid = n.nspowner
      where n.nspname = any($1::text[])
      order by n.nspname`,
    [[...TARGET_NATIVE_SCHEMAS]]
  )).rows;
  const authOwners = (await client.query(
    `select distinct owner_role from (
       select r.rolname as owner_role
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         join pg_catalog.pg_roles r on r.oid = c.relowner
        where n.nspname = 'auth'
       union all
       select r.rolname
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         join pg_catalog.pg_roles r on r.oid = p.proowner
        where n.nspname = 'auth'
     ) owners order by owner_role`
  )).rows;
  const extensions = (await client.query(
    `select e.extname as extension_name, n.nspname as schema_name
       from pg_catalog.pg_extension e
       join pg_catalog.pg_namespace n on n.oid = e.extnamespace
      where e.extname = any($1::text[])
      order by e.extname`,
    [[...REQUIRED_TARGET_EXTENSIONS]]
  )).rows;
  const publications = (await client.query(
    `select pubname as publication_name
       from pg_catalog.pg_publication
      where pubname = 'supabase_realtime'
      order by pubname`
  )).rows;
  const defaultAcls = (await client.query(
    `select owner.rolname as owner_role,
            coalesce(namespace.nspname, '') as schema_name,
            defaults.defaclobjtype as object_type,
            coalesce(grantee.rolname, 'PUBLIC') as grantee,
            acl.privilege_type, acl.is_grantable
       from pg_catalog.pg_default_acl defaults
       join pg_catalog.pg_roles owner on owner.oid = defaults.defaclrole
       left join pg_catalog.pg_namespace namespace on namespace.oid = defaults.defaclnamespace
       cross join lateral pg_catalog.aclexplode(defaults.defaclacl) acl
       left join pg_catalog.pg_roles grantee on grantee.oid = nullif(acl.grantee, 0)
      order by owner_role, schema_name, object_type, grantee, privilege_type, is_grantable`
  )).rows;
  const memberships = (await client.query(
    `select member.rolname as member_role, granted.rolname as granted_role,
            membership.admin_option, membership.inherit_option, membership.set_option
       from pg_catalog.pg_auth_members membership
       join pg_catalog.pg_roles member on member.oid = membership.member
       join pg_catalog.pg_roles granted on granted.oid = membership.roleid
      order by member_role, granted_role`
  )).rows;
  const schemaAcls = (await client.query(
    `select namespace.nspname as schema_name, owner.rolname as owner_role,
            coalesce(grantee.rolname, 'PUBLIC') as grantee,
            acl.privilege_type, acl.is_grantable
       from pg_catalog.pg_namespace namespace
       join pg_catalog.pg_roles owner on owner.oid = namespace.nspowner
       cross join lateral pg_catalog.aclexplode(
         coalesce(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
       ) acl
       left join pg_catalog.pg_roles grantee on grantee.oid = nullif(acl.grantee, 0)
      where namespace.nspname = any($1::text[])
      order by schema_name, grantee, privilege_type, is_grantable`,
    [[...TARGET_NATIVE_SCHEMAS]]
  )).rows;
  return {
    transaction,
    roles,
    schemas,
    authOwners,
    extensions,
    publications,
    defaultAcls,
    memberships,
    schemaAcls
  };
}

async function captureApplicationReplacementCatalog(client) {
  const schemas = (await client.query(
    `select n.nspname as schema_name, r.rolname as owner_role
       from pg_catalog.pg_namespace n
       join pg_catalog.pg_roles r on r.oid = n.nspowner
      where n.nspname = any(array['app','app_api'])
      order by n.nspname`
  )).rows;
  const publicRoutines = (await client.query(
    `select p.prokind, p.proname as routine_name,
            pg_catalog.oidvectortypes(p.proargtypes) as arguments
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       join pg_catalog.pg_roles r on r.oid = p.proowner
      where n.nspname = 'public' and r.rolname = 'postgres'
      order by p.prokind, p.proname, pg_catalog.oidvectortypes(p.proargtypes)`
  )).rows;
  const external = (await client.query(
    `with app_relations as (
       select c.oid from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = any(array['app','app_api'])
     ), app_routines as (
       select p.oid from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = any(array['app','app_api'])
     )
     select
       (select count(*)::bigint
          from pg_catalog.pg_constraint con
          join app_relations referenced on referenced.oid = con.confrelid
          join pg_catalog.pg_namespace owner_namespace on owner_namespace.oid = con.connamespace
         where owner_namespace.nspname <> all(array['app','app_api'])) as foreign_keys,
       (select count(distinct rewrite.oid)::bigint
          from pg_catalog.pg_depend dependency
          join app_relations referenced
            on dependency.refclassid = 'pg_catalog.pg_class'::regclass
           and dependency.refobjid = referenced.oid
          join pg_catalog.pg_rewrite rewrite
            on dependency.classid = 'pg_catalog.pg_rewrite'::regclass
           and dependency.objid = rewrite.oid
          join pg_catalog.pg_class dependent_relation on dependent_relation.oid = rewrite.ev_class
          join pg_catalog.pg_namespace dependent_namespace on dependent_namespace.oid = dependent_relation.relnamespace
         where dependent_namespace.nspname <> all(array['app','app_api'])) as views,
       (select count(distinct trigger.oid)::bigint
          from pg_catalog.pg_depend dependency
          join app_routines referenced
            on dependency.refclassid = 'pg_catalog.pg_proc'::regclass
           and dependency.refobjid = referenced.oid
          join pg_catalog.pg_trigger trigger
            on dependency.classid = 'pg_catalog.pg_trigger'::regclass
           and dependency.objid = trigger.oid
          join pg_catalog.pg_class dependent_relation on dependent_relation.oid = trigger.tgrelid
          join pg_catalog.pg_namespace dependent_namespace on dependent_namespace.oid = dependent_relation.relnamespace
         where dependent_namespace.nspname <> all(array['app','app_api'])) as triggers,
       (select count(distinct policy.oid)::bigint
          from pg_catalog.pg_depend dependency
          join app_routines referenced
            on dependency.refclassid = 'pg_catalog.pg_proc'::regclass
           and dependency.refobjid = referenced.oid
          join pg_catalog.pg_policy policy
            on dependency.classid = 'pg_catalog.pg_policy'::regclass
           and dependency.objid = policy.oid
          join pg_catalog.pg_class dependent_relation on dependent_relation.oid = policy.polrelid
          join pg_catalog.pg_namespace dependent_namespace on dependent_namespace.oid = dependent_relation.relnamespace
         where dependent_namespace.nspname <> all(array['app','app_api'])) as policies`
  )).rows[0];
  return { schemas, publicRoutines, external };
}

function assertApplicationReplacementCompatibility(manifest, evidence = {}) {
  verifyManagedRestoreManifest(manifest);
  if ((evidence.schemas || []).some((row) => row.owner_role !== 'postgres')) {
    throw categoricalError('MANAGED_APPLICATION_TARGET_OWNER_INCOMPATIBLE');
  }
  const expectedPublicRoutines = new Set(
    manifest.entries
      .filter(
        (entry) =>
          entry.schema === 'public' &&
          entry.action === 'restore' &&
          ['FUNCTION', 'PROCEDURE'].includes(entry.objectType)
      )
      .map((entry) => `${entry.objectType === 'PROCEDURE' ? 'p' : 'f'}:${entry.name}`)
  );
  const targetPublicRoutines = (evidence.publicRoutines || []).map(
    (row) => `${row.prokind}:${row.routine_name}(${row.arguments})`
  );
  if (targetPublicRoutines.some((identity) => !expectedPublicRoutines.has(identity))) {
    throw categoricalError('MANAGED_APPLICATION_TARGET_PUBLIC_ROUTINE_UNREVIEWED');
  }
  const external = evidence.external || {};
  if (['foreign_keys', 'views', 'triggers', 'policies'].some((key) => safeCount(external[key]) !== 0)) {
    throw categoricalError('MANAGED_APPLICATION_EXTERNAL_DEPENDENCY_REJECTED');
  }
  return {
    compatible: true,
    replacementDigest: canonicalDigest(evidence),
    existingApplicationSchemas: (evidence.schemas || []).length,
    reviewedPublicRoutines: targetPublicRoutines.length,
    externalDependencyCount: 0
  };
}

function assertManagedTargetCatalogCompatibility(evidence = {}) {
  const transaction = evidence.transaction || {};
  if (
    !Array.isArray(evidence.defaultAcls) ||
    !Array.isArray(evidence.memberships) ||
    !Array.isArray(evidence.schemaAcls)
  ) {
    throw categoricalError('MANAGED_TARGET_SECURITY_CATALOG_INCOMPATIBLE');
  }
  if (
    transaction.transaction_read_only !== 'on' ||
    transaction.role_name !== 'postgres' ||
    transaction.rolsuper !== false ||
    transaction.member_supabase_admin !== false ||
    transaction.member_auth_admin !== false ||
    transaction.member_storage_admin !== false ||
    transaction.member_realtime_admin !== false ||
    transaction.can_set_replication_role !== false ||
    transaction.auth_schema_usage !== true ||
    transaction.auth_users_dml !== true ||
    transaction.auth_identities_dml !== true
  ) {
    throw categoricalError('MANAGED_TARGET_EXECUTION_ROLE_INCOMPATIBLE');
  }
  const roleNames = new Set((evidence.roles || []).map((row) => row.role_name));
  if (REQUIRED_MANAGED_ROLES.some((roleName) => !roleNames.has(roleName))) {
    throw categoricalError('MANAGED_TARGET_ROLE_SET_INCOMPATIBLE');
  }
  const schemaOwners = new Map((evidence.schemas || []).map((row) => [row.schema_name, row.owner_role]));
  if (
    Object.entries(TARGET_NATIVE_SCHEMA_OWNERS).some(
      ([schemaName, ownerRole]) => schemaOwners.get(schemaName) !== ownerRole
    )
  ) {
    throw categoricalError('MANAGED_TARGET_SCHEMA_OWNERSHIP_INCOMPATIBLE');
  }
  const authOwners = [...new Set((evidence.authOwners || []).map((row) => row.owner_role))];
  if (authOwners.length !== 1 || authOwners[0] !== 'supabase_auth_admin') {
    throw categoricalError('MANAGED_TARGET_AUTH_OWNERSHIP_INCOMPATIBLE');
  }
  const extensions = new Map(
    (evidence.extensions || []).map((row) => [row.extension_name, row.schema_name])
  );
  if (REQUIRED_TARGET_EXTENSIONS.some((extensionName) => extensions.get(extensionName) !== 'extensions')) {
    throw categoricalError('MANAGED_TARGET_EXTENSION_PLANE_INCOMPATIBLE');
  }
  if (
    (evidence.publications || []).length !== 1 ||
    evidence.publications[0]?.publication_name !== 'supabase_realtime'
  ) {
    throw categoricalError('MANAGED_TARGET_PUBLICATION_PLANE_INCOMPATIBLE');
  }
  return {
    compatible: true,
    catalogDigest: canonicalDigest(evidence),
    transactionReadOnly: true,
    executionRole: 'postgres',
    requiredRoles: [...REQUIRED_MANAGED_ROLES],
    requiredSchemas: [...TARGET_NATIVE_SCHEMAS]
  };
}

function assertManagedCompatibilityProof({ authCompatibility, targetCatalog, applicationReplacement } = {}) {
  if (
    authCompatibility?.compatible !== true ||
    authCompatibility?.sourceDigest !== authCompatibility?.targetDigest ||
    !/^sha256:[a-f0-9]{64}$/.test(String(authCompatibility?.targetDigest || '')) ||
    canonicalSerialize(authCompatibility?.copiedTables) !== canonicalSerialize(AUTH_OVERLAY_TABLES) ||
    targetCatalog?.compatible !== true ||
    targetCatalog?.transactionReadOnly !== true ||
    !/^sha256:[a-f0-9]{64}$/.test(String(targetCatalog?.catalogDigest || '')) ||
    applicationReplacement?.compatible !== true ||
    applicationReplacement?.externalDependencyCount !== 0 ||
    !/^sha256:[a-f0-9]{64}$/.test(String(applicationReplacement?.replacementDigest || ''))
  ) {
    throw categoricalError('MANAGED_TARGET_COMPATIBILITY_PROOF_INVALID');
  }
  return {
    authShapeDigest: authCompatibility.targetDigest,
    catalogDigest: targetCatalog.catalogDigest,
    applicationReplacementDigest: applicationReplacement.replacementDigest,
    copiedAuthTables: [...AUTH_OVERLAY_TABLES],
    transactionReadOnly: true
  };
}

async function captureAuthOverlaySourceEvidence(client) {
  const counts = (await client.query(
    `select
       (select count(*)::bigint from auth.users) as users,
       (select count(*)::bigint from auth.identities) as identities,
       (select count(*)::bigint from auth.users
         where email !~ '^[a-z0-9-]+@users\\.invalid$'
            or phone is not null or phone_change <> ''
            or encrypted_password <> '!x-np-disabled-v1!'
            or banned_until <> 'infinity'::timestamptz
            or confirmation_token <> '' or recovery_token <> ''
            or email_change_token_new <> '' or email_change_token_current <> ''
            or reauthentication_token <> '') as unsafe_users,
       (select count(*)::bigint from auth.identities i
          join auth.users u on u.id = i.user_id
         where i.provider <> 'email' or i.provider_id <> u.email
            or i.identity_data->>'email' <> u.email
            or coalesce((i.identity_data->>'x_np_quarantined')::boolean, false) is not true) as unsafe_identities,
       (select count(*)::bigint from auth.identities i
          left join auth.users u on u.id = i.user_id where u.id is null) as dangling_identities`
  )).rows[0];
  const ephemera = {};
  for (const tableName of AUTH_PURGE_ORDER) {
    const result = await client.query(`select count(*)::bigint as count from auth."${tableName}"`);
    ephemera[tableName] = safeCount(result.rows[0]?.count);
  }
  const result = {
    users: safeCount(counts?.users),
    identities: safeCount(counts?.identities),
    unsafeUsers: safeCount(counts?.unsafe_users),
    unsafeIdentities: safeCount(counts?.unsafe_identities),
    danglingIdentities: safeCount(counts?.dangling_identities),
    ephemera
  };
  if (
    result.unsafeUsers !== 0 ||
    result.unsafeIdentities !== 0 ||
    result.danglingIdentities !== 0 ||
    Object.values(ephemera).some((count) => count !== 0)
  ) {
    throw categoricalError('MANAGED_AUTH_SOURCE_NOT_QUARANTINED');
  }
  return result;
}

function buildAuthOverlayPurgeSql() {
  const reviewedTables = new Set([...AUTH_PURGE_ORDER, ...AUTH_OVERLAY_TABLES, ...AUTH_PRESERVED_TABLES]);
  if (
    reviewedTables.size !== CURRENT_AUTH_TABLES.length ||
    CURRENT_AUTH_TABLES.some((tableName) => !reviewedTables.has(tableName))
  ) {
    throw categoricalError('MANAGED_AUTH_TABLE_SHAPE_UNREVIEWED');
  }
  return [
    ...AUTH_PURGE_ORDER.map((tableName) => `delete from auth."${tableName}";`),
    'delete from auth.identities;',
    'delete from auth.users;'
  ].join('\n');
}

function assertChunkBoundary(sql, kind) {
  const text = String(sql || '');
  if (!text.trim()) throw categoricalError(`MANAGED_RESTORE_${kind}_EMPTY`);
  if (/^(?:BEGIN|START TRANSACTION|COMMIT|ROLLBACK)\s*;/gim.test(text)) {
    throw categoricalError('MANAGED_RESTORE_NESTED_TRANSACTION_REJECTED');
  }
  if (/^\s*(?:CREATE|ALTER|DROP)\s+ROLE\b/gim.test(text) || /cli_login_postgres/i.test(text)) {
    throw categoricalError('MANAGED_RESTORE_ROLE_STATEMENT_REJECTED');
  }
  return text;
}

function assertApplicationChunk(sql) {
  const text = assertChunkBoundary(sql, 'APPLICATION_CHUNK');
  for (const line of text.split(/\r?\n/)) {
    const normalized = line.trim();
    if (
      /^(?:CREATE|ALTER|DROP|TRUNCATE)\s+(?:SCHEMA|TABLE|SEQUENCE|TYPE|FUNCTION|PROCEDURE|VIEW|MATERIALIZED VIEW)\b.*\bauth\b/i.test(normalized) ||
      /^COPY\s+auth\./i.test(normalized) ||
      /^DROP SCHEMA\b.*\bpublic\b/i.test(normalized) ||
      /^ALTER DEFAULT PRIVILEGES\b.*\b(?:supabase_admin|supabase_auth_admin)\b/i.test(normalized)
    ) {
      throw categoricalError('MANAGED_RESTORE_MANAGED_PLANE_MUTATION_REJECTED');
    }
  }
  return text;
}

function buildApplicationPlaneResetSql(manifest) {
  verifyManagedRestoreManifest(manifest);
  const routines = manifest.entries.filter(
    (entry) =>
      entry.schema === 'public' &&
      entry.action === 'restore' &&
      ['FUNCTION', 'PROCEDURE'].includes(entry.objectType)
  );
  const drops = routines.map((entry) => {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*\([A-Za-z0-9_., ()\[\]"]*\)$/.test(entry.name) ||
      /(?:--|\/\*|\*\/|;)/.test(entry.name)
    ) {
      throw categoricalError('MANAGED_APPLICATION_ROUTINE_IDENTITY_UNREVIEWED');
    }
    return `DROP ${entry.objectType} IF EXISTS public.${entry.name};`;
  });
  return `do $managed_application_owner_guard$
begin
  if exists (
    select 1
      from pg_catalog.pg_namespace n
      join pg_catalog.pg_roles r on r.oid = n.nspowner
     where n.nspname = any(array['app','app_api'])
       and r.rolname <> current_user
  ) then raise exception 'MANAGED_APPLICATION_SCHEMA_OWNER_MISMATCH'; end if;
end
$managed_application_owner_guard$;
DROP SCHEMA IF EXISTS app_api CASCADE;
DROP SCHEMA IF EXISTS app CASCADE;
${drops.join('\n')}`;
}

function assertAuthDataChunk(sql, tableName) {
  const text = assertChunkBoundary(sql, 'AUTH_DATA_CHUNK');
  const otherTable = tableName === 'users' ? 'identities' : 'users';
  if (
    !new RegExp(`\\bauth\\.${tableName}\\b`, 'i').test(text) ||
    new RegExp(`\\bauth\\.${otherTable}\\b`, 'i').test(text) ||
    /session_replication_role/i.test(text) ||
    /@(?!(?:users\.invalid)\b)[A-Za-z0-9.-]+/i.test(text)
  ) {
    throw categoricalError('MANAGED_AUTH_DATA_CHUNK_REJECTED');
  }
  return text;
}

function buildVerificationSql({ authEvidence = {}, migration = {} } = {}) {
  const users = safeCount(authEvidence.users || 0);
  const identities = safeCount(authEvidence.identities || 0);
  const migrationCount = safeCount(migration.count || 0);
  const migrationTip = String(migration.tip || '');
  if (!/^\d{14}$/.test(migrationTip)) throw categoricalError('MANAGED_RESTORE_MIGRATION_TIP_INVALID');
  const ephemeraAssertions = AUTH_PURGE_ORDER.map(
    (tableName) =>
      `if exists (select 1 from auth."${tableName}") then raise exception 'MANAGED_AUTH_EPHEMERA_NOT_EMPTY'; end if;`
  ).join('\n  ');
  return `do $managed_overlay_verify$
declare
  v_users bigint;
  v_identities bigint;
  v_migrations bigint;
  v_tip text;
begin
  if to_regnamespace('app') is null or to_regnamespace('app_api') is null then
    raise exception 'MANAGED_APPLICATION_SCHEMA_MISSING';
  end if;
  select count(*) into v_users from auth.users;
  select count(*) into v_identities from auth.identities;
  if v_users <> ${users} or v_identities <> ${identities} then
    raise exception 'MANAGED_AUTH_COUNT_MISMATCH';
  end if;
  if exists (
    select 1 from auth.users
     where email !~ '^[a-z0-9-]+@users\\.invalid$'
        or phone is not null or phone_change <> ''
        or encrypted_password <> '!x-np-disabled-v1!'
        or banned_until <> 'infinity'::timestamptz
  ) then raise exception 'MANAGED_AUTH_QUARANTINE_MISMATCH'; end if;
  if exists (
    select 1 from auth.identities i
    left join auth.users u on u.id = i.user_id
    where u.id is null or i.provider <> 'email' or i.provider_id <> u.email
       or i.identity_data->>'email' <> u.email
       or coalesce((i.identity_data->>'x_np_quarantined')::boolean, false) is not true
  ) then raise exception 'MANAGED_AUTH_IDENTITY_MISMATCH'; end if;
  ${ephemeraAssertions}
  select count(*), max(version) into v_migrations, v_tip
    from supabase_migrations.schema_migrations;
  if v_migrations <> ${migrationCount} or v_tip <> '${migrationTip}' then
    raise exception 'MANAGED_MIGRATION_LEDGER_MISMATCH';
  end if;
end
$managed_overlay_verify$;`;
}

function buildManagedOverlaySql({
  applicationResetSql,
  applicationPreDataSql,
  applicationDataSql,
  applicationPostDataSql,
  applicationAclConvergenceSql,
  authUsersSql,
  authIdentitiesSql,
  migrationSql,
  authEvidence,
  migration
} = {}) {
  const chunks = {
    applicationResetSql: assertApplicationChunk(applicationResetSql),
    applicationPreDataSql: assertApplicationChunk(applicationPreDataSql),
    applicationDataSql: assertApplicationChunk(applicationDataSql),
    applicationPostDataSql: assertApplicationChunk(applicationPostDataSql),
    applicationAclConvergenceSql: assertApplicationChunk(applicationAclConvergenceSql),
    authUsersSql: assertAuthDataChunk(authUsersSql, 'users'),
    authIdentitiesSql: assertAuthDataChunk(authIdentitiesSql, 'identities'),
    migrationSql: assertChunkBoundary(migrationSql, 'MIGRATION_CHUNK')
  };
  for (const line of chunks.migrationSql.split(/\r?\n/)) {
    const normalized = line.trim();
    if (
      /^(?:CREATE|ALTER|DROP|TRUNCATE|DELETE FROM|INSERT INTO|COPY)\b/i.test(normalized) &&
      !/\bsupabase_migrations\./i.test(normalized) &&
      !/^CREATE SCHEMA\b.*\bsupabase_migrations\b/i.test(normalized) &&
      !/^DROP SCHEMA\b.*\bsupabase_migrations\b/i.test(normalized)
    ) {
      throw categoricalError('MANAGED_RESTORE_MIGRATION_CHUNK_REJECTED');
    }
  }
  const verification = buildVerificationSql({ authEvidence, migration });
  return `\\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL statement_timeout = 0;
\\echo MANAGED_OVERLAY_STAGE_APPLICATION_RESET
${chunks.applicationResetSql}
\\echo MANAGED_OVERLAY_STAGE_APPLICATION_DEFINITION
${chunks.applicationPreDataSql}
\\echo MANAGED_OVERLAY_STAGE_AUTH_PURGE
${buildAuthOverlayPurgeSql()}
\\echo MANAGED_OVERLAY_STAGE_AUTH_USERS
${chunks.authUsersSql}
\\echo MANAGED_OVERLAY_STAGE_AUTH_IDENTITIES
${chunks.authIdentitiesSql}
\\echo MANAGED_OVERLAY_STAGE_APPLICATION_DATA
${chunks.applicationDataSql}
\\echo MANAGED_OVERLAY_STAGE_MIGRATION_LEDGER
${chunks.migrationSql}
\\echo MANAGED_OVERLAY_STAGE_APPLICATION_POST_DATA
${chunks.applicationPostDataSql}
\\echo MANAGED_OVERLAY_STAGE_APPLICATION_ACL_CONVERGENCE
${chunks.applicationAclConvergenceSql}
\\echo MANAGED_OVERLAY_STAGE_VERIFY
${verification}
COMMIT;
`;
}

function privateGeneratedText(executable, args, env = {}) {
  try {
    return execFileSync(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
      maxBuffer: 256 * 1024 * 1024
    });
  } catch {
    throw categoricalError('MANAGED_RESTORE_PACKAGE_GENERATION_FAILED');
  }
}

function normalizeGeneratedSql(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw categoricalError('MANAGED_RESTORE_GENERATED_SQL_ENCODING_INVALID');
  }
  return text.replaceAll('\r\n', '\n');
}

function canonicalizePsqlRestrictionTokens(text) {
  return String(text || '').replace(
    /^(\\(?:un)?restrict)[ \t]+\S+[ \t]*$/gm,
    '$1 <private-random-token>'
  );
}

function writePrivateGeneratedFile(filePath, bytes) {
  try {
    writePrivateBytesExclusive(filePath, bytes);
    verifyPrivateArtifactProtection(filePath);
  } finally {
    bytes.fill(0);
  }
}

function generatePgRestoreChunk({ pgRestorePath, archivePath, listPath, section = '', clean = false }) {
  const args = [
    '--exit-on-error',
    '--no-owner',
    '--use-list', listPath,
    ...(section ? ['--section', section] : []),
    ...(clean ? ['--clean', '--if-exists'] : []),
    '--file=-',
    archivePath
  ];
  return privateGeneratedText(pgRestorePath, args);
}

function generateAuthDataChunk({ pgDumpPath, sourceConnectionString, tableName }) {
  return privateGeneratedText(
    pgDumpPath,
    [
      '--data-only',
      '--column-inserts',
      '--no-owner',
      '--no-privileges',
      '--table', `auth.${tableName}`
    ],
    postgresChildEnvironment(sourceConnectionString, { PGOPTIONS: '-c statement_timeout=0' })
  );
}

function generateManagedOverlayPackage({
  pgRestorePath,
  pgDumpPath,
  archivePath,
  sourceConnectionString,
  privateDirectory,
  sourceComponent,
  authEvidence,
  migration,
  authCompatibility,
  targetCatalog,
  applicationReplacement,
  sourceAclContract
} = {}) {
  verifyPrivateArtifactProtection(archivePath);
  verifyPrivateDirectoryProtection(privateDirectory);
  const tocBytes = privateGeneratedText(pgRestorePath, ['--list', archivePath]);
  let appPre;
  let appData;
  let appPost;
  let users;
  let identities;
  let migrationSql;
  try {
    const targetCompatibility = assertManagedCompatibilityProof({
      authCompatibility,
      targetCatalog,
      applicationReplacement
    });
    verifyApplicationAclContract(sourceAclContract);
    const tocText = tocBytes.toString('utf8');
    const manifest = buildManagedRestoreManifest({
      tocText,
      sourceComponent,
      applicationAclContract: sourceAclContract
    });
    verifyManagedRestoreManifest(manifest);
    const appListPath = privateArtifactPath(privateDirectory, 'application-restore.list');
    const migrationListPath = privateArtifactPath(privateDirectory, 'migration-ledger-restore.list');
    const manifestPath = privateArtifactPath(privateDirectory, 'managed-restore-manifest.json');
    const aclContractPath = privateArtifactPath(privateDirectory, 'application-acl-contract.json');
    const scriptPath = privateArtifactPath(privateDirectory, 'managed-overlay.sql');
    writePrivateBytesExclusive(appListPath, Buffer.from(applicationRestoreList(tocText, manifest), 'utf8'));
    writePrivateBytesExclusive(migrationListPath, Buffer.from(migrationRestoreList(tocText, manifest), 'utf8'));
    writePrivateJsonExclusive(manifestPath, manifest);
    writePrivateJsonExclusive(aclContractPath, sourceAclContract);
    appPre = generatePgRestoreChunk({
      pgRestorePath,
      archivePath,
      listPath: appListPath,
      section: 'pre-data',
      clean: false
    });
    appData = generatePgRestoreChunk({
      pgRestorePath,
      archivePath,
      listPath: appListPath,
      section: 'data'
    });
    appPost = generatePgRestoreChunk({
      pgRestorePath,
      archivePath,
      listPath: appListPath,
      section: 'post-data'
    });
    users = generateAuthDataChunk({ pgDumpPath, sourceConnectionString, tableName: 'users' });
    identities = generateAuthDataChunk({ pgDumpPath, sourceConnectionString, tableName: 'identities' });
    migrationSql = generatePgRestoreChunk({
      pgRestorePath,
      archivePath,
      listPath: migrationListPath,
      clean: true
    });
    const script = Buffer.from(buildManagedOverlaySql({
      applicationResetSql: buildApplicationPlaneResetSql(manifest),
      applicationPreDataSql: normalizeGeneratedSql(appPre),
      applicationDataSql: normalizeGeneratedSql(appData),
      applicationPostDataSql: normalizeGeneratedSql(appPost),
      applicationAclConvergenceSql: buildApplicationAclConvergenceSql(sourceAclContract),
      authUsersSql: normalizeGeneratedSql(users),
      authIdentitiesSql: normalizeGeneratedSql(identities),
      migrationSql: normalizeGeneratedSql(migrationSql),
      authEvidence,
      migration
    }), 'utf8');
    writePrivateGeneratedFile(scriptPath, script);
    const scriptBytes = fs.readFileSync(scriptPath);
    let scriptDigest;
    let semanticDigest;
    try {
      scriptDigest = sha256(scriptBytes);
      const semanticBytes = Buffer.from(
        canonicalizePsqlRestrictionTokens(normalizeGeneratedSql(scriptBytes)),
        'utf8'
      );
      try {
        semanticDigest = sha256(semanticBytes);
      } finally {
        semanticBytes.fill(0);
      }
    } finally {
      scriptBytes.fill(0);
    }
    return {
      manifest,
      paths: { appListPath, migrationListPath, manifestPath, aclContractPath, scriptPath },
      script: { size: fs.statSync(scriptPath).size, digest: scriptDigest, semanticDigest },
      targetCompatibility,
      sourceAclContract,
      atomic: true,
      sessionReplicationRoleRequired: false
    };
  } finally {
    for (const bytes of [tocBytes, appPre, appData, appPost, users, identities, migrationSql]) {
      if (Buffer.isBuffer(bytes)) bytes.fill(0);
    }
  }
}

function connectionProjectRef(connectionString) {
  const parsed = parseDatabaseConnection(connectionString);
  const direct = parsed.host.toLowerCase().match(/^db\.([a-z0-9]{10,40})\.supabase\.co$/);
  if (direct) return direct[1];
  const pooled = parsed.host.toLowerCase().endsWith('.pooler.supabase.com')
    ? parsed.user.toLowerCase().match(/^postgres\.([a-z0-9]{10,40})$/)
    : null;
  return pooled?.[1] || '';
}

function assertOverlayExecutionGuard(connectionString, targetGuard = {}) {
  const connection = parseDatabaseConnection(connectionString);
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(connection.host.toLowerCase());
  if (targetGuard.mode === 'disposable-managed-local') {
    if (!loopback || targetGuard.loopback !== true) {
      throw categoricalError('MANAGED_OVERLAY_TARGET_GUARD_REJECTED');
    }
    return { target: 'local', projectRef: '', loopback: true };
  }
  const projectRef = connectionProjectRef(connectionString);
  if (
    targetGuard.mutationGuardPassed !== true ||
    targetGuard.projectRefMatched !== true ||
    !['dev', 'sandbox'].includes(targetGuard.target) ||
    !projectRef ||
    projectRef !== targetGuard.projectRef ||
    projectRef === PROD_PROJECT_REF ||
    loopback
  ) {
    throw categoricalError('MANAGED_OVERLAY_TARGET_GUARD_REJECTED');
  }
  return { target: targetGuard.target, projectRef, loopback: false };
}

function classifyManagedScriptFailure(scriptPath, safeDiagnostic = {}) {
  const lineNumber = Number(String(safeDiagnostic.excerpt || '').match(/:(\d+):\s+(?:ERROR|FATAL)/i)?.[1]);
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) return 'UNCLASSIFIED_STATEMENT';
  const bytes = fs.readFileSync(scriptPath);
  try {
    const line = normalizeGeneratedSql(bytes).split('\n')[lineNumber - 1]?.trim() || '';
    if (/^INSERT INTO auth\.users\b/i.test(line)) return 'AUTH_USERS_INSERT';
    if (/^INSERT INTO auth\.identities\b/i.test(line)) return 'AUTH_IDENTITIES_INSERT';
    if (/^(?:DELETE FROM|TRUNCATE) auth\./i.test(line)) return 'AUTH_PURGE';
    if (/^(?:SELECT|PERFORM)\b/i.test(line)) return 'READ_OR_VERIFY';
    if (/^(?:CREATE|ALTER|DROP)\b/i.test(line)) return 'DDL';
    if (/^\\/.test(line)) return 'PSQL_META_COMMAND';
    return 'OTHER_REVIEWED_SQL';
  } finally {
    bytes.fill(0);
  }
}

async function executeManagedOverlayPackage({
  psqlPath,
  connectionString,
  packageResult,
  targetGuard,
  diagnosticDirectory
} = {}) {
  const executionTarget = assertOverlayExecutionGuard(connectionString, targetGuard);
  verifyManagedRestoreManifest(packageResult?.manifest);
  verifyApplicationAclContract(packageResult?.sourceAclContract);
  if (
    packageResult.manifest?.applicationAclConvergence?.contractDigest !==
      packageResult.sourceAclContract.contractDigest
  ) {
    throw categoricalError('MANAGED_OVERLAY_ACL_CONTRACT_BINDING_REJECTED');
  }
  const targetCompatibility = packageResult?.targetCompatibility;
  if (
    !targetCompatibility ||
    (executionTarget.loopback !== true && (
      targetGuard?.managedCatalogDigest !== targetCompatibility.catalogDigest ||
      targetGuard?.authShapeDigest !== targetCompatibility.authShapeDigest ||
      targetGuard?.applicationReplacementDigest !== targetCompatibility.applicationReplacementDigest ||
      targetGuard?.restorePlanDigest !== packageResult.manifest.planDigest
    ))
  ) {
    throw categoricalError('MANAGED_OVERLAY_COMPATIBILITY_BINDING_REJECTED');
  }
  const scriptPath = packageResult?.paths?.scriptPath;
  const aclContractPath = packageResult?.paths?.aclContractPath;
  verifyPrivateArtifactProtection(aclContractPath);
  verifyPrivateArtifactProtection(scriptPath);
  const contractBytes = fs.readFileSync(aclContractPath);
  try {
    const storedContract = JSON.parse(normalizeGeneratedSql(contractBytes));
    verifyApplicationAclContract(storedContract);
    if (canonicalSerialize(storedContract) !== canonicalSerialize(packageResult.sourceAclContract)) {
      throw categoricalError('MANAGED_OVERLAY_ACL_CONTRACT_ARTIFACT_MISMATCH');
    }
  } finally {
    contractBytes.fill(0);
  }
  const scriptBytes = fs.readFileSync(scriptPath);
  try {
    if (
      scriptBytes.length !== packageResult?.script?.size ||
      sha256(scriptBytes) !== packageResult?.script?.digest
    ) {
      throw categoricalError('MANAGED_OVERLAY_SCRIPT_ARTIFACT_MISMATCH');
    }
  } finally {
    scriptBytes.fill(0);
  }
  let result;
  try {
    result = await runPrivateDiagnosticCommand({
      executable: psqlPath,
      args: ['--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--file', scriptPath],
      env: postgresChildEnvironment(connectionString, {
        PGAPPNAME: 'environment-sync-managed-overlay',
        PGOPTIONS: '-c statement_timeout=0'
      }),
      diagnosticDirectory,
      failureCode: 'MANAGED_OVERLAY_EXECUTION_FAILED'
    });
  } catch (error) {
    if (error?.safeDiagnostic) {
      error.safeDiagnostic.statementCategory = classifyManagedScriptFailure(
        scriptPath,
        error.safeDiagnostic
      );
    }
    throw error;
  }
  return { applied: true, atomic: true, diagnostic: result.safeDiagnostic };
}

export {
  AUTH_IDENTITIES_COPY_COLUMNS,
  AUTH_OVERLAY_TABLES,
  AUTH_PRESERVED_TABLES,
  AUTH_USERS_COPY_COLUMNS,
  MANAGED_RESTORE_ACTIONS,
  MANAGED_RESTORE_CANONICALIZATION,
  MANAGED_RESTORE_CATEGORIES,
  MANAGED_RESTORE_MANIFEST_FORMAT,
  REQUIRED_MANAGED_ROLES,
  TARGET_NATIVE_SCHEMAS,
  TARGET_NATIVE_SCHEMA_OWNERS,
  applicationRestoreList,
  assertApplicationReplacementCompatibility,
  assertAuthOverlayCompatibility,
  assertManagedCompatibilityProof,
  assertManagedTargetCatalogCompatibility,
  assertOverlayExecutionGuard,
  authTransformEntries,
  buildAuthOverlayPurgeSql,
  buildApplicationPlaneResetSql,
  buildManagedOverlaySql,
  buildManagedRestoreManifest,
  captureAuthOverlaySourceEvidence,
  captureApplicationReplacementCatalog,
  captureManagedTargetCatalog,
  canonicalizePsqlRestrictionTokens,
  classifyTocEntry,
  executeManagedOverlayPackage,
  generateManagedOverlayPackage,
  migrationRestoreList,
  normalizeGeneratedSql,
  normalizeAuthShape,
  parsePgRestoreList,
  verifyManagedRestoreManifest
};
