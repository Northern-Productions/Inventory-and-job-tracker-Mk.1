import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import pg from 'pg';

import { canonicalDigest } from '../readonly-diagnostics.mjs';
import { applyAuthQuarantine, createTargetNativeSmokeIdentity } from './auth-quarantine.mjs';
import { captureApplicationAclContract } from './application-acl-convergence.mjs';
import {
  authenticateApplicationDefaultAclManifest,
  assertHardenedApplicationRoutineDefaultProfile,
  buildApplicationRoutineDefaultRecoverySql,
  buildProfileApplicationDefaultAclManifest,
  captureApplicationDefaultAclEntries,
  captureApplicationRoutineDefaultProfile,
  captureFuturePublicFunctionDefaultSecurity
} from './application-default-acl-preservation.mjs';
import {
  removeDisposablePostgres,
  resolvePostgresTools,
  startDisposablePostgres,
  withClient
} from './disposable-postgres.mjs';
import {
  captureNativeSmokePreservation,
  verifyNativeSmokePreservation
} from './native-smoke-preservation.mjs';
import { parseDatabaseConnection, postgresChildEnvironment } from './encrypted-baseline.mjs';
import {
  assertApplicationReplacementCompatibility,
  assertAuthOverlayCompatibility,
  assertManagedTargetCatalogCompatibility,
  buildAuthPreservationAuthority,
  buildExactAuthRecoveryAuthority,
  buildManagedRestoreManifest,
  captureApplicationReplacementCatalog,
  captureAuthOverlaySourceEvidence,
  captureExactAuthRecoveryEvidence,
  captureManagedTargetCatalog,
  executeManagedOverlayPackage,
  generateManagedOverlayPackage,
  parsePgRestoreList
} from './managed-restore.mjs';
import {
  createPrivateDirectory,
  privateArtifactPath,
  verifyPrivateArtifactProtection,
  verifyPrivateDirectoryProtection,
  writePrivateBytesExclusive
} from './private-artifacts.mjs';
import { runPrivateDiagnosticCommand } from './private-diagnostics.mjs';
import {
  APPLICATION_FACING_ROLES,
  MANAGED_PROFILE_SECURITY_POLICY_FORMAT,
  authenticateManagedProfileCertificate,
  buildManagedProfileCertificate,
  managedProfileEvidenceFromCatalog
} from './managed-profile.mjs';

const { Client } = pg;
const LOCAL_MANAGED_ROLES = Object.freeze([
  ['anon', 'NOLOGIN'],
  ['authenticated', 'NOLOGIN'],
  ['authenticator', 'NOLOGIN'],
  ['cli_login_postgres', 'LOGIN'],
  ['dashboard_user', 'NOLOGIN CREATEROLE CREATEDB REPLICATION'],
  ['pgbouncer', 'NOLOGIN'],
  ['service_role', 'NOLOGIN BYPASSRLS'],
  ['supabase_admin', 'NOLOGIN SUPERUSER'],
  ['supabase_auth_admin', 'NOLOGIN CREATEROLE'],
  ['supabase_etl_admin', 'NOLOGIN REPLICATION BYPASSRLS'],
  ['supabase_privileged_role', 'NOLOGIN'],
  ['supabase_read_only_user', 'NOLOGIN BYPASSRLS'],
  ['supabase_realtime_admin', 'NOLOGIN'],
  ['supabase_replication_admin', 'NOLOGIN REPLICATION'],
  ['supabase_storage_admin', 'NOLOGIN CREATEROLE']
]);

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function compareApplicationPlane(source, target) {
  const comparableKeys = [
    'relationDigest', 'columnDigest', 'routineDigest', 'constraintDigest', 'grantDigest', 'aclObjectDigest',
    'tableDigest', 'tableCount', 'migration'
  ];
  return Object.fromEntries(
    comparableKeys.map((key) => [key, canonicalDigest([source[key]]) === canonicalDigest([target[key]])])
  );
}

function summarizeRoutineDifferences(source, target) {
  const identity = (row) => `${row.schema_name}\u0000${row.proname}\u0000${row.arguments}`;
  const sourceByIdentity = new Map(source.map((row) => [identity(row), row.definition]));
  const targetByIdentity = new Map(target.map((row) => [identity(row), row.definition]));
  let sourceOnly = 0;
  let targetOnly = 0;
  let definitionMismatch = 0;
  for (const [key, definition] of sourceByIdentity) {
    if (!targetByIdentity.has(key)) sourceOnly += 1;
    else if (targetByIdentity.get(key) !== definition) definitionMismatch += 1;
  }
  for (const key of targetByIdentity.keys()) {
    if (!sourceByIdentity.has(key)) targetOnly += 1;
  }
  return { sourceCount: source.length, targetCount: target.length, sourceOnly, targetOnly, definitionMismatch };
}

function privateRun(executable, args, env = {}) {
  try {
    return execFileSync(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
      env
    });
  } catch {
    throw categoricalError('MANAGED_REHEARSAL_PRIVATE_CHILD_FAILED');
  }
}

function capturePrivatePlaintextArchive({ tools, connectionString, archivePath } = {}) {
  writePrivateBytesExclusive(archivePath, Buffer.alloc(0));
  privateRun(
    tools.pgDump,
    [
      '--format=custom', '--no-owner', '--compress=6', '--file', archivePath,
      '--schema', 'app', '--schema', 'app_api', '--schema', 'public',
      '--schema', 'auth', '--schema', 'supabase_migrations'
    ],
    postgresChildEnvironment(connectionString, { PGOPTIONS: '-c statement_timeout=0' })
  );
  verifyPrivateArtifactProtection(archivePath);
  const bytes = fs.readFileSync(archivePath);
  try {
    if (bytes.length === 0) throw categoricalError('MANAGED_REHEARSAL_Y2_ARCHIVE_EMPTY');
    return {
      name: 'postgres-logical-custom-private-recovery',
      size: bytes.length,
      digest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
    };
  } finally {
    bytes.fill(0);
  }
}

async function atRehearsalStage(stage, action) {
  try {
    return await action();
  } catch (error) {
    error.rehearsalStage = stage;
    throw error;
  }
}

function connectionForUser(connectionString, user) {
  const url = new URL(connectionString);
  url.username = user;
  return url.toString();
}

function databaseConnection(connectionString, database) {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function bootstrapManagedRoles(cluster) {
  const base = new URL(cluster.connectionString());
  const password = decodeURIComponent(base.password);
  if (!/^[0-9a-f]{64}$/.test(password)) throw categoricalError('MANAGED_REHEARSAL_CREDENTIAL_SHAPE_INVALID');
  await withClient(cluster.connectionString(), async (client) => {
    if (decodeURIComponent(base.username) !== 'cluster_admin') {
      throw categoricalError('MANAGED_REHEARSAL_BOOTSTRAP_ROLE_INVALID');
    }
    await client.query(
      `create role postgres login nosuperuser createrole createdb replication bypassrls password '${password}'`
    );
    for (const [role, attributes] of LOCAL_MANAGED_ROLES) {
      await client.query(`create role ${quoteIdentifier(role)} ${attributes}`);
    }
    await client.query('grant anon, authenticated, service_role to authenticator');
    await client.query('grant postgres to cli_login_postgres');
  });
  return cluster.connectionString();
}

async function createDatabase(adminConnection, databaseName, owner) {
  if (!/^x_rehearsal_(?:dev|sandbox)_[a-z0-9_]{1,48}$/.test(databaseName)) {
    throw categoricalError('MANAGED_REHEARSAL_DATABASE_NAME_INVALID');
  }
  await withClient(adminConnection, (client) =>
    client.query(`create database ${quoteIdentifier(databaseName)} owner ${quoteIdentifier(owner)}`)
  );
  return databaseConnection(adminConnection, databaseName);
}

async function installExtensionPlane(connectionString, { removePublic = false } = {}) {
  await withClient(connectionString, async (client) => {
    if (removePublic) await client.query('drop schema public cascade');
    await client.query('create schema extensions authorization postgres');
    await client.query('create extension pgcrypto with schema extensions');
    await client.query('create extension "uuid-ossp" with schema extensions');
  });
}

async function applyManagedAuthPrivilegeProfile(connectionString, profile = 'high-privilege-test-only') {
  if (!['high-privilege-test-only', 'live-like-remediation'].includes(profile)) {
    throw categoricalError('MANAGED_REHEARSAL_AUTH_PRIVILEGE_PROFILE_INVALID');
  }
  await withClient(connectionString, async (client) => {
    await client.query('revoke all privileges on all tables in schema auth from postgres');
    if (profile === 'high-privilege-test-only') {
      await client.query('grant all privileges on all tables in schema auth to postgres');
    } else {
      await client.query('grant select on all tables in schema auth to postgres');
      await client.query(`do $live_like_auth_privileges$
        declare v_table text;
        begin
          for v_table in
            select table_name from information_schema.tables
             where table_schema='auth' and table_type='BASE TABLE'
               and table_name <> 'schema_migrations'
             order by table_name
          loop
            execute format('grant insert, update, delete on table auth.%I to postgres', v_table);
          end loop;
        end
        $live_like_auth_privileges$;`);
    }
    await client.query('grant all privileges on all sequences in schema auth to postgres');
    await client.query('grant usage on schema auth to postgres');
  });
  return { profile, schemaMigrationsReadOnly: profile === 'live-like-remediation' };
}

function authDefinitionList(tocText) {
  const selected = parsePgRestoreList(tocText).filter(
    (entry) =>
      (entry.schema === 'auth' && entry.objectType !== 'TABLE DATA') ||
      (entry.schema === '-' && (entry.name === 'auth' || entry.name === 'SCHEMA auth'))
  );
  if (selected.length === 0) throw categoricalError('MANAGED_REHEARSAL_AUTH_DEFINITIONS_MISSING');
  return `${selected.map((entry) => entry.rawLine).join('\n')}\n`;
}

async function installManagedPlane({
  adminConnection,
  archivePath,
  tocText,
  tools,
  privateDirectory,
  profileStyle,
  authPrivilegeProfile = 'high-privilege-test-only',
  routineDefaultProfile = 'hardened'
}) {
  await installExtensionPlane(adminConnection);
  const listPath = privateArtifactPath(
    privateDirectory,
    `managed-auth-${crypto.randomBytes(8).toString('hex')}.list`
  );
  const listBytes = Buffer.from(authDefinitionList(tocText), 'utf8');
  try {
    writePrivateBytesExclusive(listPath, listBytes);
  } finally {
    listBytes.fill(0);
  }
  privateRun(
    tools.pgRestore,
    [
      '--exit-on-error', '--use-list', listPath,
      '--dbname', parseDatabaseConnection(adminConnection).database,
      archivePath
    ],
    postgresChildEnvironment(adminConnection, { PGOPTIONS: '-c statement_timeout=0' })
  );
  await withClient(adminConnection, async (client) => {
    if (!['dev-historical', 'sandbox-current'].includes(profileStyle)) {
      throw categoricalError('MANAGED_REHEARSAL_PROFILE_STYLE_INVALID');
    }
    if (!['hardened', 'pre0204-dev', 'pre0204-sandbox'].includes(routineDefaultProfile)) {
      throw categoricalError('MANAGED_REHEARSAL_ROUTINE_DEFAULT_PROFILE_INVALID');
    }
    if (profileStyle === 'dev-historical') {
      await client.query('alter schema public owner to postgres');
    }
    for (const [schemaName, owner] of [
      ['storage', 'supabase_admin'],
      ['realtime', 'supabase_admin'],
      ['vault', 'supabase_admin'],
      ['graphql', 'supabase_admin'],
      ['graphql_public', 'supabase_admin']
    ]) {
      await client.query(`create schema ${quoteIdentifier(schemaName)} authorization ${quoteIdentifier(owner)}`);
    }
    await applyManagedAuthPrivilegeProfile(adminConnection, authPrivilegeProfile);
    await client.query('grant usage on schema auth to supabase_auth_admin');
    await client.query('create schema app authorization postgres');
    await client.query('create schema app_api authorization postgres');
    await client.query(
      'alter default privileges for role postgres in schema app grant select, insert, update, delete on tables to service_role'
    );
    await client.query(
      'alter default privileges for role postgres in schema app grant usage, select on sequences to service_role'
    );
    if (profileStyle === 'sandbox-current') {
      await client.query(
        'alter default privileges for role postgres in schema app grant select, insert, update, delete on tables to authenticated'
      );
      await client.query(
        'alter default privileges for role postgres in schema app grant usage, select on sequences to authenticated'
      );
    }
    if (routineDefaultProfile === 'hardened') {
      await client.query('alter default privileges for role postgres revoke execute on functions from public');
    } else if (routineDefaultProfile === 'pre0204-dev') {
      await client.query(
        'alter default privileges for role postgres in schema public revoke execute on functions from public'
      );
    } else {
      await client.query(
        'alter default privileges for role postgres in schema public grant execute on functions to postgres, anon, authenticated, service_role'
      );
    }
    if (profileStyle === 'dev-historical') {
      await client.query(
        'alter default privileges for role supabase_auth_admin in schema auth grant select on tables to postgres'
      );
    } else {
      await client.query('grant usage on schema public to authenticator');
    }
    await client.query('create schema supabase_migrations authorization postgres');
    await client.query('create table supabase_migrations.schema_migrations(version text primary key)');
    await client.query('alter table supabase_migrations.schema_migrations owner to postgres');
    await client.query('create publication supabase_realtime');
  });
  fs.rmSync(listPath, { force: true });
}

async function captureAuthShape(connectionString) {
  return withClient(connectionString, async (client) => {
    const columns = (await client.query(
      `select table_name, ordinal_position, column_name, udt_name, is_nullable,
              is_generated, generation_expression
         from information_schema.columns
        where table_schema = 'auth' and table_name = any(array['users','identities'])
        order by table_name, ordinal_position`
    )).rows;
    const triggers = (await client.query(
      `select c.relname as table_name, t.tgname as trigger_name
         from pg_catalog.pg_trigger t
         join pg_catalog.pg_class c on c.oid = t.tgrelid
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'auth' and c.relname = any(array['users','identities'])
          and not t.tgisinternal
        order by c.relname, t.tgname`
    )).rows;
    return { columns, triggers };
  });
}

async function captureManagedPlaneFingerprintFromClient(client) {
    const publicSchema = (await client.query(
      `select owner.rolname as owner_role
         from pg_catalog.pg_namespace namespace
         join pg_catalog.pg_roles owner on owner.oid = namespace.nspowner
        where namespace.nspname = 'public'`
    )).rows[0];
    const catalog = (await client.query(
      `select n.nspname as schema_name, c.relname as object_name, c.relkind,
              r.rolname as owner_role
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         join pg_catalog.pg_roles r on r.oid = c.relowner
        where n.nspname = any(array['auth','storage','realtime','vault','graphql','graphql_public','extensions'])
        order by n.nspname, c.relkind, c.relname`
    )).rows;
    const routines = (await client.query(
      `select n.nspname as schema_name, p.proname,
              pg_catalog.pg_get_function_identity_arguments(p.oid) as arguments,
              r.rolname as owner_role
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         join pg_catalog.pg_roles r on r.oid = p.proowner
        where n.nspname = any(array['auth','storage','realtime','vault','graphql','graphql_public','extensions'])
        order by n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)`
    )).rows;
    const preservedData = (await client.query(
      `select
         (select count(*)::bigint from auth.instances) as instances,
         (select count(*)::bigint from auth.schema_migrations) as schema_migrations`
    )).rows[0];
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
        where namespace.nspname = any(array['auth','storage','realtime','vault','graphql','graphql_public','extensions','public'])
        order by schema_name, grantee, privilege_type, is_grantable`
    )).rows;
  return {
    publicOwner: publicSchema.owner_role,
    catalogDigest: canonicalDigest(catalog),
    routineDigest: canonicalDigest(routines),
    defaultAclDigest: canonicalDigest(defaultAcls),
    roleMembershipDigest: canonicalDigest(memberships),
    schemaAclDigest: canonicalDigest(schemaAcls),
    instances: Number(preservedData.instances),
    authMigrationRows: Number(preservedData.schema_migrations)
  };
}

async function captureManagedPlaneFingerprint(connectionString) {
  return withClient(connectionString, captureManagedPlaneFingerprintFromClient);
}

async function captureApplicationPlaneFromClient(client, { excludeOrganizationId = '' } = {}) {
  const excludedOrganization = String(excludeOrganizationId || '').toLowerCase();
  if (
    excludedOrganization &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(excludedOrganization)
  ) throw categoricalError('MANAGED_APPLICATION_EXCLUSION_INVALID');
    const relations = (await client.query(
      `select n.nspname as schema_name, c.relname as relation_name, c.relkind
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = any(array['app','app_api']) and c.relkind in ('r','p','v','m','S')
        order by n.nspname, c.relname, c.relkind`
    )).rows;
    const columns = (await client.query(
      `select table_schema as schema_name, table_name, ordinal_position, column_name,
              data_type, udt_schema, udt_name, is_nullable,
              coalesce(column_default, '') as column_default,
              is_identity, coalesce(identity_generation, '') as identity_generation,
              is_generated, coalesce(generation_expression, '') as generation_expression
         from information_schema.columns
        where table_schema = any(array['app','app_api','public'])
        order by table_schema, table_name, ordinal_position`
    )).rows;
    const routines = (await client.query(
      `select n.nspname as schema_name, p.proname,
              pg_catalog.pg_get_function_identity_arguments(p.oid) as arguments,
              pg_catalog.pg_get_functiondef(p.oid) as definition
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = any(array['app','app_api','public'])
        order by n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)`
    )).rows;
    const constraints = (await client.query(
      `select n.nspname as schema_name, c.relname as table_name, con.conname,
              pg_catalog.pg_get_constraintdef(con.oid, true) as definition
         from pg_catalog.pg_constraint con
         join pg_catalog.pg_class c on c.oid = con.conrelid
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = any(array['app','app_api','public'])
          and con.contype <> 'n'
        order by n.nspname, c.relname, con.conname`
    )).rows;
    const aclContract = await captureApplicationAclContract(client);
    const tableRows = [];
    for (const relation of relations.filter((entry) => ['r', 'p'].includes(entry.relkind))) {
      const qualified = `${quoteIdentifier(relation.schema_name)}.${quoteIdentifier(relation.relation_name)}`;
      let exclusion = '';
      let parameters = [];
      if (excludedOrganization && relation.schema_name === 'app') {
        const columns = (await client.query(
          `select column_name from information_schema.columns
            where table_schema=$1 and table_name=$2 and column_name in ('id','org_id')`,
          [relation.schema_name, relation.relation_name]
        )).rows.map((row) => row.column_name);
        if (relation.relation_name === 'organizations' && columns.includes('id')) {
          exclusion = 'where t.id <> $1::uuid';
          parameters = [excludedOrganization];
        } else if (columns.includes('org_id')) {
          exclusion = 'where t.org_id <> $1::uuid';
          parameters = [excludedOrganization];
        }
      }
      const result = (await client.query(
        `select count(*)::bigint as count,
                 md5(coalesce(string_agg(
                   pg_catalog.to_jsonb(t)::text,
                   '|' order by pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text, 'UTF8')
                 ), '')) as digest
           from ${qualified} t ${exclusion}`,
        parameters
      )).rows[0];
      tableRows.push({
        schemaName: relation.schema_name,
        tableName: relation.relation_name,
        count: Number(result.count),
        digest: result.digest
      });
    }
    const migration = (await client.query(
      `select count(*)::bigint as count, max(version) as tip
         from supabase_migrations.schema_migrations`
    )).rows[0];
    const result = {
      relationDigest: canonicalDigest(relations),
      columnDigest: canonicalDigest(columns),
      routineDigest: canonicalDigest(routines),
      constraintDigest: canonicalDigest(constraints),
      grantDigest: aclContract.grantDigest,
      aclObjectDigest: aclContract.objectDigest,
      tableDigest: canonicalDigest(tableRows),
      tableRows,
      tableCount: tableRows.length,
      migration: { count: Number(migration.count), tip: String(migration.tip || '') }
    };
    Object.defineProperty(result, 'routineRows', { value: routines, enumerable: false });
    return result;
}

async function captureApplicationPlane(connectionString, options = {}) {
  return withClient(connectionString, (client) => captureApplicationPlaneFromClient(client, options));
}

async function captureAuthParityFromClient(client, { excludeNativeSmoke = false } = {}) {
    const userPredicate = excludeNativeSmoke
      ? "where coalesce((raw_user_meta_data->>'x_np_target_native_smoke')::boolean, false) is not true"
      : '';
    const identityPredicate = excludeNativeSmoke
      ? "where coalesce((u.raw_user_meta_data->>'x_np_target_native_smoke')::boolean, false) is not true"
      : '';
    const users = (await client.query(`select id::text from auth.users ${userPredicate} order by id`)).rows;
    const identities = (await client.query(
      `select i.id::text, i.user_id::text
         from auth.identities i join auth.users u on u.id = i.user_id
         ${identityPredicate}
        order by i.id`
    )).rows;
    const unsafe = (await client.query(
      `select
         count(*) filter (where email !~ '^[a-z0-9-]+@users\\.invalid$'
                              or encrypted_password <> '!x-np-disabled-v1!'
                              or banned_until <> 'infinity'::timestamptz)::bigint as unsafe_users,
         (select count(*)::bigint from auth.sessions) as sessions,
         (select count(*)::bigint from auth.refresh_tokens) as refresh_tokens
       from auth.users ${userPredicate}`
    )).rows[0];
  return {
    userCount: users.length,
    identityCount: identities.length,
    userDigest: canonicalDigest(users),
    identityDigest: canonicalDigest(identities),
    unsafeUsers: Number(unsafe.unsafe_users),
    sessions: Number(unsafe.sessions),
    refreshTokens: Number(unsafe.refresh_tokens)
  };
}

async function captureAuthParity(connectionString, options = {}) {
  return withClient(connectionString, (client) => captureAuthParityFromClient(client, options));
}

async function assertSourceRestoreAuthority(connectionString) {
  const connection = parseDatabaseConnection(connectionString);
  if (
    connection.host !== '127.0.0.1' ||
    connection.user !== 'cluster_admin' ||
    connection.sslmode !== 'disable'
  ) {
    throw categoricalError('MANAGED_REHEARSAL_SOURCE_RESTORE_AUTHORITY_INVALID');
  }
  const proof = await withClient(connectionString, async (client) => {
    const result = await client.query(
      `select current_user, session_user, rol.rolsuper
         from pg_catalog.pg_roles rol
        where rol.rolname = current_user`
    );
    return result.rows[0];
  });
  if (
    proof?.current_user !== 'cluster_admin' ||
    proof?.session_user !== 'cluster_admin' ||
    proof?.rolsuper !== true
  ) {
    throw categoricalError('MANAGED_REHEARSAL_SOURCE_RESTORE_AUTHORITY_INVALID');
  }
  return { role: 'cluster_admin', superuser: true, loopbackOnly: true };
}

async function restoreSource({ tools, archivePath, connectionString, diagnosticDirectory }) {
  await assertSourceRestoreAuthority(connectionString);
  await runPrivateDiagnosticCommand({
    executable: tools.pgRestore,
    args: [
      '--exit-on-error',
      '--dbname', parseDatabaseConnection(connectionString).database,
      archivePath
    ],
    env: postgresChildEnvironment(connectionString, {
      PGOPTIONS: '-c check_function_bodies=off -c statement_timeout=0'
    }),
    diagnosticDirectory,
    failureCode: 'MANAGED_REHEARSAL_SOURCE_RESTORE_FAILED'
  });
}

async function quarantineSource(connectionString) {
  return withClient(
    connectionString,
    async (client) => {
      await client.query('begin');
      try {
        const result = await applyAuthQuarantine(client);
        const evidence = await captureAuthOverlaySourceEvidence(client);
        await client.query('commit');
        return { result, evidence };
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      }
    },
    { application_name: 'environment-sync-x-rehearsal' }
  );
}

async function installTargetNativeSmoke(connectionString, smokeProfile) {
  return withClient(
    connectionString,
    async (client) => {
      await client.query('begin');
      try {
        const result = await createTargetNativeSmokeIdentity(client, smokeProfile);
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      }
    },
    { application_name: 'environment-sync-x-rehearsal' }
  );
}

async function installTargetNativeSmokeOrganization(connectionString, smokeProfile) {
  return withClient(
    connectionString,
    async (client) => {
      await client.query('begin');
      try {
        const organizationId = (await client.query(
          'insert into app.organizations(name) values ($1) returning id',
          [`Native DEV certification ${crypto.randomBytes(12).toString('hex')}`]
        )).rows[0].id;
        await client.query(
          `insert into app.organization_members(org_id, user_id, role, status, updated_by_actor)
           values ($1::uuid, $2::uuid, 'owner', 'active', 'environment-sync-rehearsal')`,
          [organizationId, smokeProfile.userId]
        );
        await client.query(
          `insert into app.warehouses(org_id, code, name, box_id_prefix, created_by, updated_by)
           values
             ($1::uuid, 'IL1', 'Native DEV IL1', 'IL1', 'environment-sync-rehearsal', 'environment-sync-rehearsal'),
             ($1::uuid, 'MS1', 'Native DEV MS1', 'MS1', 'environment-sync-rehearsal', 'environment-sync-rehearsal')`,
          [organizationId]
        );
        await client.query(
          `insert into app.owner_companies(org_id, code, display_name, created_by, updated_by)
           values
             ($1::uuid, 'MGT', 'MGT', 'environment-sync-rehearsal', 'environment-sync-rehearsal'),
             ($1::uuid, 'EDH', 'EDH', 'environment-sync-rehearsal', 'environment-sync-rehearsal'),
             ($1::uuid, 'KAM', 'KAM', 'environment-sync-rehearsal', 'environment-sync-rehearsal')`,
          [organizationId]
        );
        await client.query(
          `insert into app.general_feature_permissions(
             org_id, feature_area, read_enabled, write_enabled, updated_by
           )
           select $1::uuid, feature_area, true, true, 'environment-sync-rehearsal'
             from unnest(array[
               'inventory','allocations','jobs','film_orders','activity_history','reports'
             ]::text[]) feature_area`,
          [organizationId]
        );
        await client.query('commit');
        return { organizationId: String(organizationId) };
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      }
    },
    { application_name: 'environment-sync-native-smoke-organization-rehearsal' }
  );
}

async function applyPostOverlayMigration(connectionString, migration) {
  if (!migration) return { applied: false, version: '' };
  const version = String(migration.version || '');
  const sql = String(migration.sql || '');
  if (
    !/^20\d{12}$/.test(version) || !sql.trim() ||
    /^\s*(?:begin|commit|rollback)\s*;/im.test(sql)
  ) {
    throw categoricalError('MANAGED_REHEARSAL_POST_OVERLAY_MIGRATION_INVALID');
  }
  return withClient(connectionString, async (client) => {
    await client.query('begin');
    try {
      const existing = await client.query(
        'select count(*)::bigint as count from supabase_migrations.schema_migrations where version = $1',
        [version]
      );
      if (Number(existing.rows[0].count) !== 0) {
        throw categoricalError('MANAGED_REHEARSAL_POST_OVERLAY_MIGRATION_ALREADY_APPLIED');
      }
      await client.query(sql);
      await client.query(
        'insert into supabase_migrations.schema_migrations(version) values ($1)',
        [version]
      );
      await client.query('commit');
      return { applied: true, version };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    }
  });
}

function normalizePostOverlayMigrations(postOverlayMigration, postOverlayMigrations) {
  if (postOverlayMigration !== null && postOverlayMigrations !== null) {
    throw categoricalError('MANAGED_REHEARSAL_POST_OVERLAY_MIGRATION_INPUT_AMBIGUOUS');
  }
  const requested = postOverlayMigrations ?? (postOverlayMigration === null ? [] : [postOverlayMigration]);
  if (!Array.isArray(requested) || requested.length > 8) {
    throw categoricalError('MANAGED_REHEARSAL_POST_OVERLAY_MIGRATION_INVALID');
  }
  const normalized = requested.map((migration) => ({
    version: String(migration?.version || ''),
    sql: String(migration?.sql || '')
  }));
  if (
    normalized.some((migration) => !/^20\d{12}$/.test(migration.version) || !migration.sql.trim()) ||
    new Set(normalized.map((migration) => migration.version)).size !== normalized.length ||
    normalized.some((migration, index) => index > 0 && migration.version <= normalized[index - 1].version)
  ) {
    throw categoricalError('MANAGED_REHEARSAL_POST_OVERLAY_MIGRATION_INVALID');
  }
  return normalized;
}

async function applyPostOverlayMigrations(connectionString, migrations) {
  const results = [];
  for (const migration of migrations) {
    results.push(await applyPostOverlayMigration(connectionString, migration));
  }
  return results;
}

async function capture0203Proof(connectionString) {
  return withClient(connectionString, async (client) => {
    await client.query('begin');
    try {
      const metadata = (await client.query(
        `select owner.rolname as owner_role, routine.prosecdef as security_definer,
                coalesce(routine.proconfig, array[]::text[]) as configuration
           from pg_catalog.pg_proc routine
           join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
           join pg_catalog.pg_roles owner on owner.oid = routine.proowner
          where namespace.nspname = 'public'
            and routine.proname = 'api_get_auth_context'
            and pg_catalog.pg_get_function_identity_arguments(routine.oid) = 'p_org_id uuid'`
      )).rows;
      const grants = (await client.query(
        `select coalesce(grantee.rolname, 'PUBLIC') as grantee,
                acl.privilege_type, acl.is_grantable
           from pg_catalog.pg_proc routine
           join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
           cross join lateral pg_catalog.aclexplode(
             coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
           ) acl
           left join pg_catalog.pg_roles grantee on grantee.oid = nullif(acl.grantee, 0)
          where namespace.nspname = 'public'
            and routine.proname = 'api_get_auth_context'
            and pg_catalog.pg_get_function_identity_arguments(routine.oid) = 'p_org_id uuid'
          order by grantee, acl.privilege_type, acl.is_grantable`
      )).rows;
      const candidate = (await client.query(
        `select member.org_id::text as org_id, member.user_id::text as user_id,
                member.role, users.email,
                app_api.get_user_default_warehouse(member.org_id, member.user_id) as expected_warehouse,
                (select count(*)::bigint from app.organization_members peer
                  where peer.user_id = member.user_id and peer.status = 'active') as active_orgs
           from app.organization_members member
           join auth.users users on users.id = member.user_id
          where member.status = 'active'
          order by active_orgs desc, member.role, member.org_id
          limit 1`
      )).rows[0];
      if (!candidate) throw categoricalError('MANAGED_REHEARSAL_0203_BEHAVIOR_SUBJECT_MISSING');
      await client.query(
        `select pg_catalog.set_config(
           'request.jwt.claims',
           pg_catalog.json_build_object(
             'sub', $1::text,
             'email', $2::text,
             'user_metadata', pg_catalog.json_build_object('name', 'Synthetic Rehearsal')
           )::text,
           true
         )`,
        [candidate.user_id, candidate.email]
      );
      const context = (await client.query(
        'select public.api_get_auth_context($1::uuid) as context',
        [candidate.org_id]
      )).rows[0].context;
      const activeAfter = (await client.query(
        `select count(*)::bigint as count from app.organization_members
          where user_id = $1::uuid and status = 'active'`,
        [candidate.user_id]
      )).rows[0];
      await client.query('rollback');
      const direct = new Map(grants.map((entry) => [entry.grantee, entry]));
      const configuration = metadata[0]?.configuration || [];
      const safe = {
        routineCount: metadata.length,
        ownerExact: metadata[0]?.owner_role === 'postgres',
        securityDefiner: metadata[0]?.security_definer === true,
        searchPathExact:
          configuration.length === 1 && configuration[0] === 'search_path=public, app, app_api',
        authenticatedExecute:
          direct.get('authenticated')?.privilege_type === 'EXECUTE' &&
          direct.get('authenticated')?.is_grantable === false,
        publicExecute: direct.has('PUBLIC'),
        anonExecute: direct.has('anon'),
        serviceRoleExecute: direct.has('service_role'),
        behaviorApproved:
          context?.accessStatus === 'approved' && context?.role === candidate.role &&
          String(context?.defaultWarehouse || '') === String(candidate.expected_warehouse || '') &&
          context?.permissions?.team_management != null,
        activeOrganizationCountStable: Number(activeAfter.count) === Number(candidate.active_orgs),
        multiOrganizationSubject: Number(candidate.active_orgs) > 1
      };
      if (
        safe.routineCount !== 1 || !safe.ownerExact || !safe.securityDefiner ||
        !safe.searchPathExact || !safe.authenticatedExecute || safe.publicExecute ||
        safe.anonExecute || safe.serviceRoleExecute || !safe.behaviorApproved ||
        !safe.activeOrganizationCountStable
      ) {
        throw categoricalError('MANAGED_REHEARSAL_0203_CONTRACT_MISMATCH');
      }
      return safe;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    }
  });
}

async function capture0205Proof(connectionString) {
  return withClient(connectionString, async (client) => {
    const token = `weight-probe-${crypto.randomBytes(12).toString('hex')}`;
    await client.query('begin');
    try {
      const definitions = (await client.query(`
        select
          pg_catalog.pg_get_functiondef(
            'public.api_boxes_set_status(uuid, text, jsonb)'::pg_catalog.regprocedure
          ) as set_status,
          pg_catalog.pg_get_functiondef(
            'public.api_acl_boxes_set_status(uuid, text, jsonb)'::pg_catalog.regprocedure
          ) as set_status_acl,
          pg_catalog.pg_get_functiondef(
            'public.api_acl_boxes_receive_ordered(uuid, text, jsonb)'::pg_catalog.regprocedure
          ) as receive_ordered
      `)).rows[0];
      const privileges = (await client.query(`
        select
          pg_catalog.has_function_privilege(
            'public', 'app_api.resolve_box_weight_calibration(uuid, app.boxes)', 'EXECUTE'
          ) as public_execute,
          pg_catalog.has_function_privilege(
            'anon', 'app_api.resolve_box_weight_calibration(uuid, app.boxes)', 'EXECUTE'
          ) as anon_execute,
          pg_catalog.has_function_privilege(
            'authenticated', 'app_api.resolve_box_weight_calibration(uuid, app.boxes)', 'EXECUTE'
          ) as authenticated_execute,
          pg_catalog.has_function_privilege(
            'service_role', 'app_api.resolve_box_weight_calibration(uuid, app.boxes)', 'EXECUTE'
          ) as service_role_execute
      `)).rows[0];
      const orgId = (await client.query(
        'insert into app.organizations(name) values ($1) returning id',
        [token]
      )).rows[0].id;
      const ownerCompanyId = (await client.query(
        `insert into app.owner_companies(org_id, code, display_name, created_by, updated_by)
         values ($1::uuid, 'MGT', 'Synthetic Rollback Owner', 'rehearsal', 'rehearsal')
         returning id`,
        [orgId]
      )).rows[0].id;
      await client.query(
        `insert into app.warehouses(org_id, code, name, box_id_prefix, created_by, updated_by)
         values ($1::uuid, 'RB1', 'Synthetic Rollback Warehouse', 'RB1', 'rehearsal', 'rehearsal')`,
        [orgId]
      );
      await client.query(
        `insert into app.film_catalog(
           org_id, film_key, manufacturer, film_name,
           sq_ft_weight_lbs_per_sq_ft, default_core_type
         ) values ($1::uuid, $2, 'Synthetic', 'Rollback Probe', 0.0015, 'Red plastic')`,
        [orgId, token]
      );
      const boxes = (await client.query(
        `insert into app.boxes(
           org_id, box_id, warehouse, manufacturer, film_name, width_in,
           initial_feet, feet_available, status, order_date, received_date,
           initial_weight_lbs, last_roll_weight_lbs, film_key, core_type,
           core_weight_lbs, lf_weight_lbs_per_ft, owner_company_id
         ) values
           ($1::uuid, $2, 'RB1', 'Synthetic', 'Rollback Probe', 60,
            100, 5, 'IN_STOCK', current_date, current_date,
            12.0965, 1.82588, $4, 'Red plastic', 1.2847, 0.108118, $5::uuid),
           ($1::uuid, $3, 'RB1', 'Synthetic', 'Rollback Probe', 60,
            100, 0, 'IN_STOCK', current_date, current_date,
            12.0965, 3.44706, $4, 'Red plastic', null, null, $5::uuid)
         returning id, box_id`,
        [orgId, `${token}-saved`, `${token}-self-heal`, token, ownerCompanyId]
      )).rows;
      const byName = new Map(boxes.map((row) => [row.box_id, row.id]));
      const saved = (await client.query(
        `select app_api.resolve_box_weight_calibration($1::uuid, box_row) as result
           from app.boxes box_row where box_row.id = $2::uuid`,
        [orgId, byName.get(`${token}-saved`)]
      )).rows[0].result;
      const selfHeal = (await client.query(
        `select app_api.resolve_box_weight_calibration($1::uuid, box_row) as result
           from app.boxes box_row where box_row.id = $2::uuid`,
        [orgId, byName.get(`${token}-self-heal`)]
      )).rows[0].result;
      const derived = (await client.query(
        `select app_api.derive_feet_available_from_roll_weight(
           $1::numeric, $2::numeric, $3::numeric, 100
         ) as feet`,
        [
          Number(selfHeal.coreWeightLbs) + (Number(selfHeal.lfWeightLbsPerFt) * 20),
          selfHeal.coreWeightLbs,
          selfHeal.lfWeightLbsPerFt
        ]
      )).rows[0];
      const setStatus = String(definitions.set_status || '');
      const setStatusAcl = String(definitions.set_status_acl || '');
      const receiveOrdered = String(definitions.receive_ordered || '');
      const safe = {
        savedCalibrationResolved:
          saved?.resolved === true && saved?.source === 'SAVED_BOX',
        deterministicSelfHealResolved:
          selfHeal?.resolved === true && selfHeal?.source === 'BOX_INITIAL_BASELINE' &&
          Number(selfHeal.coreWeightLbs) >= 0 && Number(selfHeal.lfWeightLbsPerFt) > 0,
        returnedWeightDerivedFeet: Number(derived.feet) === 20,
        staleFeetPayloadIgnored:
          !setStatus.includes("p_payload->>'currentFeetOnRoll'") &&
          setStatus.includes('app_api.resolve_box_weight_calibration(p_org_id, v_existing)') &&
          setStatus.includes('app_api.derive_feet_available_from_roll_weight'),
        selfHealPersistenceContract:
          setStatus.includes('v_box.core_weight_lbs := v_resolved_core_weight') &&
          setStatus.includes('v_box.lf_weight_lbs_per_ft := v_resolved_lf_weight'),
        allocationReconciliationPreserved:
          setStatus.includes('app_api.reconcile_box_checkin_allocations'),
        atomicMaterialFlowLockPreserved:
          setStatusAcl.includes('app_api.lock_film_material_flow()') &&
          setStatusAcl.includes('app_api.api_acl_boxes_set_status_pre_0191'),
        orderedReceiveCalibrationPreserved:
          receiveOrdered.includes('app_api.resolve_box_weight_calibration(p_org_id, v_box)') &&
          receiveOrdered.includes('v_box.lf_weight_lbs_per_ft :=') &&
          receiveOrdered.includes('app_api.process_linked_box_receipt'),
        helperPrivate: Object.values(privileges).every((value) => value === false)
      };
      if (Object.values(safe).some((value) => value !== true)) {
        throw categoricalError('MANAGED_REHEARSAL_0205_CONTRACT_MISMATCH');
      }
      await client.query('rollback');
      const residue = await client.query(
        'select count(*)::bigint as count from app.organizations where name = $1',
        [token]
      );
      if (Number(residue.rows[0].count) !== 0) {
        throw categoricalError('MANAGED_REHEARSAL_0205_PROBE_RESIDUE');
      }
      return { ...safe, probeResidue: 0 };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    }
  });
}

function syntheticManagedSecurityPolicy(evidence) {
  const roles = new Map(evidence.roles.map((entry) => [entry.role_name, entry]));
  const capabilities = new Map(
    evidence.roleCapabilities.map((entry) => [entry.role_name, entry])
  );
  const publicOwner = evidence.schemas.find((entry) => entry.schema_name === 'public')?.owner_role;
  const privilegedRoles = evidence.roles
    .filter(
      (role) =>
        role.rolsuper || role.rolcreaterole || role.rolcreatedb || role.rolreplication ||
        role.rolbypassrls || role.role_name === publicOwner
    )
    .map((role) => role.role_name);
  const memberships = new Map();
  for (const membership of evidence.memberships) {
    if (!memberships.has(membership.member_role)) memberships.set(membership.member_role, new Set());
    memberships.get(membership.member_role).add(membership.granted_role);
  }
  const paths = [];
  for (const sourceRole of APPLICATION_FACING_ROLES) {
    const reached = new Set([sourceRole]);
    const queue = [sourceRole];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const next of memberships.get(current) || []) {
        if (reached.has(next)) continue;
        reached.add(next);
        queue.push(next);
      }
    }
    for (const targetRole of reached) {
      if (roles.get(targetRole)?.rolbypassrls) {
        paths.push({ source_role: sourceRole, target_role: targetRole, capability: 'bypass_rls' });
      }
    }
  }
  return {
    format: MANAGED_PROFILE_SECURITY_POLICY_FORMAT,
    expectedPublicOwner: publicOwner,
    applicationFacingRoles: [...APPLICATION_FACING_ROLES],
    allowedApplicationPublicUsageRoles: APPLICATION_FACING_ROLES.filter(
      (roleName) => capabilities.get(roleName)?.public_usage
    ),
    allowedApplicationLoginRoles: APPLICATION_FACING_ROLES.filter(
      (roleName) => roles.get(roleName)?.rolcanlogin
    ),
    allowedApplicationBypassRlsRoles: APPLICATION_FACING_ROLES.filter(
      (roleName) => roles.get(roleName)?.rolbypassrls
    ),
    allowedApplicationPrivilegePaths: paths,
    certifiedPrivilegedRoles: privilegedRoles
  };
}

async function captureTargetCatalogEvidence(connectionString, manifest) {
  return withClient(
    connectionString,
    async (client) => {
      await client.query('begin isolation level repeatable read read only');
      try {
        const evidence = await captureManagedTargetCatalog(client);
        const applicationEvidence = await captureApplicationReplacementCatalog(client);
        await client.query('rollback');
        return { evidence, applicationEvidence };
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      }
    },
    { application_name: 'environment-sync-x-rehearsal' }
  );
}

function issueSyntheticManagedProfile({ profileId, target, evidence, key }) {
  return authenticateManagedProfileCertificate(buildManagedProfileCertificate({
    profileId,
    target,
    evidence: managedProfileEvidenceFromCatalog(evidence),
    securityPolicy: syntheticManagedSecurityPolicy(evidence)
  }), key);
}

function issueSyntheticApplicationDefaultAcl({ target, targetCatalog, key }) {
  return authenticateApplicationDefaultAclManifest(buildProfileApplicationDefaultAclManifest({
    target,
    managedProfile: {
      profileId: targetCatalog.profileId,
      profileDigest: targetCatalog.profileDigest
    },
    rows: targetCatalog.applicationDefaultAclEntries
  }), key);
}

async function probeFutureObjectDefaults(
  connectionString,
  expectedDefaults,
  expectedFunctionSecurity = {
    publicExecute: false,
    anonExecute: false,
    authenticatedExecute: false,
    serviceRoleExecute: false,
    ownerExecute: true
  }
) {
  return withClient(connectionString, async (client) => {
    await client.query('begin');
    try {
      await client.query('create table app.default_acl_future_table(id bigint)');
      await client.query('create sequence app.default_acl_future_sequence');
      await client.query(
        'create function public.default_acl_future_function() returns integer language sql as $$ select 1 $$'
      );
      const application = (await client.query(`
        select case when relation.relkind = 'S' then 'sequence' else 'table' end as object_class,
               grantee.rolname as grantee, acl.privilege_type, acl.is_grantable
          from pg_catalog.pg_class relation
          join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
          cross join lateral pg_catalog.aclexplode(coalesce(
            relation.relacl,
            pg_catalog.acldefault(
              case when relation.relkind = 'S' then 'S'::"char" else 'r'::"char" end,
              relation.relowner
            )
          )) acl
          join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
         where namespace.nspname = 'app'
           and relation.relname = any(array['default_acl_future_table','default_acl_future_sequence'])
           and grantee.rolname = any(array['authenticated','service_role'])
         order by object_class, grantee, privilege_type, is_grantable
      `)).rows;
      const routine = (await client.query(`
        select
          exists (
            select 1 from pg_catalog.pg_proc routine
            cross join lateral pg_catalog.aclexplode(
              coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
            ) acl
            where routine.oid = 'public.default_acl_future_function()'::regprocedure
              and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
          ) as public_execute,
          pg_catalog.has_function_privilege(
            'anon', 'public.default_acl_future_function()', 'EXECUTE'
          ) as anon_execute,
          pg_catalog.has_function_privilege(
            'authenticated', 'public.default_acl_future_function()', 'EXECUTE'
          ) as authenticated_execute,
          pg_catalog.has_function_privilege(
            'service_role', 'public.default_acl_future_function()', 'EXECUTE'
          ) as service_role_execute,
          pg_catalog.has_function_privilege(
            'postgres', 'public.default_acl_future_function()', 'EXECUTE'
          ) as owner_execute
      `)).rows[0];
      const expectedApplication = expectedDefaults.map((entry) => [
        entry.objectClass,
        entry.grantee,
        entry.privilege,
        entry.grantOption
      ]);
      const observedApplication = application.map((row) => [
        row.object_class,
        row.grantee,
        row.privilege_type,
        row.is_grantable
      ]);
      const observedFunctionSecurity = {
        publicExecute: routine.public_execute === true,
        anonExecute: routine.anon_execute === true,
        authenticatedExecute: routine.authenticated_execute === true,
        serviceRoleExecute: routine.service_role_execute === true,
        ownerExecute: routine.owner_execute === true
      };
      return {
        applicationExact: canonicalDigest(observedApplication) === canonicalDigest(expectedApplication),
        functionExact:
          canonicalDigest(observedFunctionSecurity) === canonicalDigest(expectedFunctionSecurity),
        tableGrantCount: application.filter(
          (row) => row.object_class === 'table' && row.grantee === 'service_role'
        ).length,
        sequenceGrantCount: application.filter(
          (row) => row.object_class === 'sequence' && row.grantee === 'service_role'
        ).length,
        totalApplicationGrantCount: application.length,
        publicFunctionDenied: routine.public_execute === false,
        anonFunctionDenied: routine.anon_execute === false,
        authenticatedFunctionDenied: routine.authenticated_execute === false,
        serviceRoleFunctionDenied: routine.service_role_execute === false,
        ownerFunctionAllowed: routine.owner_execute === true,
        observedFunctionSecurity
      };
    } finally {
      await client.query('rollback');
    }
  });
}

async function captureTargetCatalogProof(connectionString, manifest, managedProfile) {
  const captured = await captureTargetCatalogEvidence(connectionString, manifest);
  const proof = assertManagedTargetCatalogCompatibility(captured.evidence, managedProfile);
  const applicationReplacement = assertApplicationReplacementCompatibility(
    manifest,
    captured.applicationEvidence
  );
  return { ...proof, applicationReplacement };
}

async function generateCurrentDatabaseRecoveryPackage({
  connectionString,
  archivePath,
  sourceComponent,
  privateDirectory,
  attemptId,
  authorityKey,
  postgresBin = '',
  preserveTargetAuth = false,
  target = { environment: 'dev', projectRef: 'd'.repeat(20) }
} = {}) {
  if (!Buffer.isBuffer(authorityKey) || authorityKey.length !== 32) {
    throw categoricalError('DEV_Y2_AUTH_RECOVERY_KEY_INVALID');
  }
  const tools = resolvePostgresTools(postgresBin);
  const tocBytes = execFileSync(tools.pgRestore, ['--list', archivePath], {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 32 * 1024 * 1024
  });
  try {
    const manifest = buildManagedRestoreManifest({
      tocText: tocBytes.toString('utf8'),
      sourceComponent
    });
    const shape = await captureAuthShape(connectionString);
    const authCompatibility = assertAuthOverlayCompatibility({
      sourceColumns: shape.columns,
      targetColumns: shape.columns,
      targetTriggers: shape.triggers
    });
    const normalizedTarget = {
      environment: String(target?.environment || ''),
      projectRef: String(target?.projectRef || '')
    };
    if (
      normalizedTarget.environment !== 'dev' ||
      !/^[a-z0-9]{10,40}$/.test(normalizedTarget.projectRef)
    ) throw categoricalError('DEV_Y2_RECOVERY_TARGET_INVALID');
    const catalogEvidence = await captureTargetCatalogEvidence(connectionString, manifest);
    const profileCertificate = issueSyntheticManagedProfile({
      profileId: 'dev-y2-current-managed-profile',
      target: normalizedTarget,
      evidence: catalogEvidence.evidence,
      key: authorityKey
    });
    const targetCatalog = await captureTargetCatalogProof(connectionString, manifest, {
      certificate: profileCertificate,
      key: authorityKey,
      target: normalizedTarget,
      expectedProfileId: 'dev-y2-current-managed-profile'
    });
    const defaultAclCertificate = issueSyntheticApplicationDefaultAcl({
      target: normalizedTarget,
      targetCatalog,
      key: authorityKey
    });
    const [application, authEvidence, sourceAclContract] = await Promise.all([
      captureApplicationPlane(connectionString),
      withClient(connectionString, captureExactAuthRecoveryEvidence),
      withClient(connectionString, captureApplicationAclContract)
    ]);
    const authAuthority = (preserveTargetAuth
      ? buildAuthPreservationAuthority
      : buildExactAuthRecoveryAuthority)({
      attemptId,
      target: normalizedTarget,
      sourceComponentDigest: sourceComponent.digest,
      migration: application.migration,
      evidence: authEvidence
    }, authorityKey);
    const packageResult = generateManagedOverlayPackage({
      pgRestorePath: tools.pgRestore,
      pgDumpPath: tools.pgDump,
      archivePath,
      sourceConnectionString: connectionString,
      privateDirectory,
      sourceComponent,
      authEvidence: {},
      migration: application.migration,
      authCompatibility,
      targetCatalog,
      applicationReplacement: targetCatalog.applicationReplacement,
      sourceAclContract,
      applicationDefaultAcl: { certificate: defaultAclCertificate, key: authorityKey },
      ...(preserveTargetAuth ? {
        preserveAuth: { authority: authAuthority, key: authorityKey, attemptId }
      } : {
        authRecovery: { authority: authAuthority, key: authorityKey, attemptId }
      })
    });
    return {
      packageResult,
      application,
      auth: await captureAuthParity(connectionString),
      managed: await captureManagedPlaneFingerprint(connectionString),
      routineDefaults: await withClient(connectionString, captureApplicationRoutineDefaultProfile),
      futureSecurity: await withClient(connectionString, captureFuturePublicFunctionDefaultSecurity),
      targetCatalog,
      sourceAclContract
    };
  } finally {
    tocBytes.fill(0);
  }
}

async function prepareGoldenManagedOverlayForTarget({
  archivePath,
  sourceComponent,
  targetConnectionString,
  target,
  authorityKey,
  privateDirectory,
  nativeSmoke,
  postgresBin = '',
  temporaryParent = os.tmpdir()
} = {}) {
  if (!Buffer.isBuffer(authorityKey) || authorityKey.length !== 32) {
    throw categoricalError('MANAGED_PREPARATION_AUTHORITY_KEY_INVALID');
  }
  const normalizedTarget = {
    environment: String(target?.environment || ''),
    projectRef: String(target?.projectRef || '')
  };
  if (
    normalizedTarget.environment !== 'dev' ||
    !/^[a-z0-9]{10,40}$/.test(normalizedTarget.projectRef)
  ) throw categoricalError('MANAGED_PREPARATION_TARGET_INVALID');
  const tools = resolvePostgresTools(postgresBin);
  const token = crypto.randomBytes(8).toString('hex');
  const root = path.join(temporaryParent, `environment-sync-rehearsal-managed-source-${token}`);
  let cluster;
  try {
    cluster = await startDisposablePostgres({
      rootDirectory: root,
      postgresBin: tools.bin,
      bootstrapUser: 'cluster_admin'
    });
    const admin = await bootstrapManagedRoles(cluster);
    const sourceAdmin = await createDatabase(
      admin,
      `x_rehearsal_sandbox_source_${token}`,
      'postgres'
    );
    const sourceConnectionString = sourceAdmin;
    await installExtensionPlane(sourceConnectionString, { removePublic: true });
    await restoreSource({
      tools,
      archivePath,
      connectionString: sourceConnectionString,
      diagnosticDirectory: privateDirectory
    });
    const sourceTransform = await quarantineSource(sourceConnectionString);
    const tocBytes = execFileSync(tools.pgRestore, ['--list', archivePath], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024
    });
    try {
      const manifest = buildManagedRestoreManifest({
        tocText: tocBytes.toString('utf8'),
        sourceComponent
      });
      const [sourceShape, targetShape] = await Promise.all([
        captureAuthShape(sourceConnectionString),
        captureAuthShape(targetConnectionString)
      ]);
      const authCompatibility = assertAuthOverlayCompatibility({
        sourceColumns: sourceShape.columns,
        targetColumns: targetShape.columns,
        targetTriggers: targetShape.triggers
      });
      const targetEvidence = await captureTargetCatalogEvidence(targetConnectionString, manifest);
      const profileCertificate = issueSyntheticManagedProfile({
        profileId: 'dev-certified-live-managed-profile',
        target: normalizedTarget,
        evidence: targetEvidence.evidence,
        key: authorityKey
      });
      const targetCatalog = await captureTargetCatalogProof(targetConnectionString, manifest, {
        certificate: profileCertificate,
        key: authorityKey,
        target: normalizedTarget,
        expectedProfileId: 'dev-certified-live-managed-profile'
      });
      const defaultAclCertificate = issueSyntheticApplicationDefaultAcl({
        target: normalizedTarget,
        targetCatalog,
        key: authorityKey
      });
      const [sourcePlane, sourceAclContract, nativePreservation] = await Promise.all([
        captureApplicationPlane(sourceConnectionString),
        withClient(sourceConnectionString, captureApplicationAclContract),
        withClient(targetConnectionString, (client) => captureNativeSmokePreservation(client, nativeSmoke))
      ]);
      verifyNativeSmokePreservation(nativePreservation);
      const packageResult = generateManagedOverlayPackage({
        pgRestorePath: tools.pgRestore,
        pgDumpPath: tools.pgDump,
        archivePath,
        sourceConnectionString,
        privateDirectory,
        sourceComponent,
        authEvidence: sourceTransform.evidence,
        migration: sourcePlane.migration,
        authCompatibility,
        targetCatalog,
        applicationReplacement: targetCatalog.applicationReplacement,
        sourceAclContract,
        applicationDefaultAcl: { certificate: defaultAclCertificate, key: authorityKey },
        nativePreservation
      });
      return {
        packageResult,
        sourcePlane,
        sourceAuth: await captureAuthParity(sourceConnectionString),
        targetCatalog,
        nativePreservation: nativePreservation.evidence,
        authEvidence: sourceTransform.evidence,
        sourceAclContract
      };
    } finally {
      tocBytes.fill(0);
    }
  } finally {
    if (cluster) await removeDisposablePostgres(cluster);
  }
}

async function runManagedRestoreCompatibilityRehearsal({
  archivePath,
  sourceComponent,
  postOverlayMigration = null,
  postOverlayMigrations = null,
  routineDefaultProfiles = null,
  rehearsePre0204Recovery = false,
  rehearseCurrentDevY2Recovery = false,
  preserveNativeSmokeRelationalState = false,
  retainDisposableTarget = false,
  postgresBin = '',
  temporaryParent = os.tmpdir()
} = {}) {
  const tools = resolvePostgresTools(postgresBin);
  const migrationSequence = normalizePostOverlayMigrations(
    postOverlayMigration,
    postOverlayMigrations
  );
  const includes0204 = migrationSequence.some(
    (migration) => migration.version === '20260823100000'
  );
  const includes0205 = migrationSequence.some(
    (migration) => migration.version === '20260824100000'
  );
  const selectedRoutineDefaultProfiles = routineDefaultProfiles ?? {
    sandbox: 'hardened',
    dev: 'hardened'
  };
  if (
    !selectedRoutineDefaultProfiles ||
    !['hardened', 'pre0204-sandbox'].includes(selectedRoutineDefaultProfiles.sandbox) ||
    !['hardened', 'pre0204-dev'].includes(selectedRoutineDefaultProfiles.dev) ||
    (rehearsePre0204Recovery && (
      !includes0204 || selectedRoutineDefaultProfiles.dev !== 'pre0204-dev'
    )) ||
    (rehearseCurrentDevY2Recovery && (
      rehearsePre0204Recovery || !includes0204 || !includes0205 ||
      selectedRoutineDefaultProfiles.dev !== 'hardened'
    ))
  ) {
    throw categoricalError('MANAGED_REHEARSAL_ROUTINE_DEFAULT_PROFILE_INVALID');
  }
  const token = crypto.randomBytes(8).toString('hex');
  const root = path.join(temporaryParent, `environment-sync-rehearsal-managed-${token}`);
  let cluster;
  let retainCluster = false;
  const managedProfileKey = crypto.randomBytes(32);
  const applicationDefaultAclKey = crypto.randomBytes(32);
  const y2AuthRecoveryKey = crypto.randomBytes(32);
  try {
    cluster = await startDisposablePostgres({
      rootDirectory: root,
      postgresBin: tools.bin,
      bootstrapUser: 'cluster_admin'
    });
    const adminRootConnection = await bootstrapManagedRoles(cluster);
    const sourceName = `x_rehearsal_sandbox_source_${token}`;
    const sandboxName = `x_rehearsal_sandbox_managed_${token}`;
    const devName = `x_rehearsal_dev_managed_${token}`;
    const sourceDatabase = await createDatabase(adminRootConnection, sourceName, 'postgres');
    const sourceMigrationConnection = connectionForUser(sourceDatabase, 'postgres');
    const sandboxAdmin = await createDatabase(adminRootConnection, sandboxName, 'postgres');
    const devAdmin = await createDatabase(adminRootConnection, devName, 'postgres');
    const sandboxConnection = connectionForUser(sandboxAdmin, 'postgres');
    const devConnection = connectionForUser(devAdmin, 'postgres');
    const privateDirectory = path.join(root, 'managed-overlay-private');
    const devInitialPrivateDirectory = path.join(root, 'managed-overlay-private-dev-initial');
    const devRefreshPrivateDirectory = path.join(root, 'managed-overlay-private-dev-refresh');
    const y2PrivateDirectory = path.join(root, 'managed-overlay-private-dev-y2');
    createPrivateDirectory(privateDirectory);
    createPrivateDirectory(devInitialPrivateDirectory);
    createPrivateDirectory(devRefreshPrivateDirectory);
    createPrivateDirectory(y2PrivateDirectory);
    verifyPrivateDirectoryProtection(privateDirectory);
    verifyPrivateDirectoryProtection(devInitialPrivateDirectory);
    verifyPrivateDirectoryProtection(devRefreshPrivateDirectory);
    verifyPrivateDirectoryProtection(y2PrivateDirectory);
    await installExtensionPlane(sourceDatabase, { removePublic: true });
    await restoreSource({
      tools,
      archivePath,
      connectionString: sourceDatabase,
      diagnosticDirectory: privateDirectory
    });

    const tocBytes = execFileSync(tools.pgRestore, ['--list', archivePath], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024
    });
    const tocText = tocBytes.toString('utf8');
    tocBytes.fill(0);
    const manifest = buildManagedRestoreManifest({ tocText, sourceComponent });

    await installManagedPlane({
      adminConnection: sandboxAdmin,
      archivePath,
      tocText,
      tools,
      privateDirectory,
      profileStyle: 'sandbox-current',
      routineDefaultProfile: selectedRoutineDefaultProfiles.sandbox
    });
    await installManagedPlane({
      adminConnection: devAdmin,
      archivePath,
      tocText,
      tools,
      privateDirectory,
      profileStyle: 'dev-historical',
      routineDefaultProfile: selectedRoutineDefaultProfiles.dev
    });
    const routineDefaultsBefore = {
      source: await withClient(sourceDatabase, captureApplicationRoutineDefaultProfile),
      sandbox: await withClient(sandboxConnection, captureApplicationRoutineDefaultProfile),
      dev: await withClient(devConnection, captureApplicationRoutineDefaultProfile)
    };
    const futureFunctionSecurityBefore = {
      dev: await withClient(devConnection, captureFuturePublicFunctionDefaultSecurity)
    };
    const managedBefore = {
      sandbox: await captureManagedPlaneFingerprint(sandboxConnection),
      dev: await captureManagedPlaneFingerprint(devConnection)
    };
    const oldDefaultAclLoss = await withClient(devConnection, async (client) => {
      await client.query('begin');
      try {
        const before = await captureApplicationDefaultAclEntries(client);
        await client.query('drop schema app cascade');
        await client.query('create schema app authorization postgres');
        const afterReplacement = await captureApplicationDefaultAclEntries(client);
        return {
          beforeCount: before.length,
          afterCount: afterReplacement.length,
          reproduced: before.length > 0 && afterReplacement.length === 0
        };
      } finally {
        await client.query('rollback');
      }
    });

    let oldFailure;
    try {
      await runPrivateDiagnosticCommand({
        executable: tools.pgRestore,
        args: [
          '--exit-on-error', '--no-owner', '--clean', '--if-exists',
          '--single-transaction', '--dbname',
          parseDatabaseConnection(sandboxConnection).database,
          archivePath
        ],
        env: postgresChildEnvironment(sandboxConnection, {
          PGOPTIONS: '-c check_function_bodies=off -c statement_timeout=0'
        }),
        diagnosticDirectory: privateDirectory,
        failureCode: 'OLD_MANAGED_RESTORE_FAILED'
      });
      throw categoricalError('OLD_MANAGED_RESTORE_UNEXPECTEDLY_SUCCEEDED');
    } catch (error) {
      if (error.code !== 'OLD_MANAGED_RESTORE_FAILED') throw error;
      oldFailure = error.safeDiagnostic;
    }
    const afterOldFailure = await withClient(sandboxConnection, async (client) => {
      const result = await client.query(
        `select to_regnamespace('app') is not null as app_present,
                to_regnamespace('app_api') is not null as app_api_present,
                (select count(*)::bigint from auth.users) as auth_users`
      );
      return result.rows[0];
    });
    if (
      oldFailure?.classification !== 'POSTGRES_MANAGED_OWNERSHIP_REJECTED' ||
      !afterOldFailure.app_present ||
      !afterOldFailure.app_api_present ||
      Number(afterOldFailure.auth_users) !== 0
    ) {
      throw categoricalError('OLD_MANAGED_RESTORE_REPRODUCTION_MISMATCH');
    }

    const sourceTransform = await quarantineSource(sourceDatabase);
    const [sourceShape, sandboxShape, devShape] = await Promise.all([
      captureAuthShape(sourceDatabase),
      captureAuthShape(sandboxConnection),
      captureAuthShape(devConnection)
    ]);
    const authCompatibility = {
      sandbox: assertAuthOverlayCompatibility({
        sourceColumns: sourceShape.columns,
        targetColumns: sandboxShape.columns,
        targetTriggers: sandboxShape.triggers
      }),
      dev: assertAuthOverlayCompatibility({
        sourceColumns: sourceShape.columns,
        targetColumns: devShape.columns,
        targetTriggers: devShape.triggers
      })
    };
    const profileTargets = {
      sandbox: { environment: 'sandbox', projectRef: 's'.repeat(20) },
      dev: { environment: 'dev', projectRef: 'd'.repeat(20) }
    };
    const initialCatalog = {
      sandbox: await captureTargetCatalogEvidence(sandboxConnection, manifest),
      dev: await captureTargetCatalogEvidence(devConnection, manifest)
    };
    const profileCertificates = {
      sandbox: issueSyntheticManagedProfile({
        profileId: 'sandbox-current-managed-profile',
        target: profileTargets.sandbox,
        evidence: initialCatalog.sandbox.evidence,
        key: managedProfileKey
      }),
      dev: issueSyntheticManagedProfile({
        profileId: 'dev-historical-managed-profile',
        target: profileTargets.dev,
        evidence: initialCatalog.dev.evidence,
        key: managedProfileKey
      })
    };
    const managedProfiles = {
      sandbox: {
        certificate: profileCertificates.sandbox,
        key: managedProfileKey,
        target: profileTargets.sandbox,
        expectedProfileId: 'sandbox-current-managed-profile'
      },
      dev: {
        certificate: profileCertificates.dev,
        key: managedProfileKey,
        target: profileTargets.dev,
        expectedProfileId: 'dev-historical-managed-profile'
      }
    };
    const targetCatalog = {
      sandbox: await captureTargetCatalogProof(sandboxConnection, manifest, managedProfiles.sandbox),
      dev: await captureTargetCatalogProof(devConnection, manifest, managedProfiles.dev)
    };
    const applicationDefaultAclCertificates = {
      sandbox: issueSyntheticApplicationDefaultAcl({
        target: profileTargets.sandbox,
        targetCatalog: targetCatalog.sandbox,
        key: applicationDefaultAclKey
      }),
      dev: issueSyntheticApplicationDefaultAcl({
        target: profileTargets.dev,
        targetCatalog: targetCatalog.dev,
        key: applicationDefaultAclKey
      })
    };
    const applicationDefaultAcls = {
      sandbox: { certificate: applicationDefaultAclCertificates.sandbox, key: applicationDefaultAclKey },
      dev: { certificate: applicationDefaultAclCertificates.dev, key: applicationDefaultAclKey }
    };
    if (
      targetCatalog.sandbox.catalogDigest === targetCatalog.dev.catalogDigest ||
      targetCatalog.sandbox.profileId === targetCatalog.dev.profileId ||
      managedBefore.sandbox.publicOwner !== 'pg_database_owner' ||
      managedBefore.dev.publicOwner !== 'postgres'
    ) {
      throw categoricalError('MANAGED_TARGET_PROFILE_SEPARATION_FAILED');
    }
    const sourcePlane = await captureApplicationPlane(sourceDatabase);
    const sourceAclContract = await withClient(sourceDatabase, captureApplicationAclContract);
    const packageResult = generateManagedOverlayPackage({
      pgRestorePath: tools.pgRestore,
      pgDumpPath: tools.pgDump,
      archivePath,
      sourceConnectionString: sourceDatabase,
      privateDirectory,
      sourceComponent,
      authEvidence: sourceTransform.evidence,
      migration: sourcePlane.migration,
      authCompatibility: authCompatibility.sandbox,
      targetCatalog: targetCatalog.sandbox,
      applicationReplacement: targetCatalog.sandbox.applicationReplacement,
      sourceAclContract,
      applicationDefaultAcl: applicationDefaultAcls.sandbox
    });
    const devInitialPackage = generateManagedOverlayPackage({
      pgRestorePath: tools.pgRestore,
      pgDumpPath: tools.pgDump,
      archivePath,
      sourceConnectionString: sourceDatabase,
      privateDirectory: devInitialPrivateDirectory,
      sourceComponent,
      authEvidence: sourceTransform.evidence,
      migration: sourcePlane.migration,
      authCompatibility: authCompatibility.dev,
      targetCatalog: targetCatalog.dev,
      applicationReplacement: targetCatalog.dev.applicationReplacement,
      sourceAclContract,
      applicationDefaultAcl: applicationDefaultAcls.dev
    });
    if (devInitialPackage.script.semanticDigest === packageResult.script.semanticDigest) {
      throw categoricalError('MANAGED_DUAL_PROFILE_DEFAULT_ACL_NOT_SEPARATED');
    }
    await atRehearsalStage('mock-sandbox-initial-overlay', () => executeManagedOverlayPackage({
      psqlPath: tools.psql,
      connectionString: sandboxConnection,
      packageResult,
      targetGuard: { mode: 'disposable-managed-local', loopback: true },
      diagnosticDirectory: privateDirectory
    }));
    await atRehearsalStage('mock-dev-initial-overlay', () => executeManagedOverlayPackage({
      psqlPath: tools.psql,
      connectionString: devConnection,
      packageResult: devInitialPackage,
      targetGuard: { mode: 'disposable-managed-local', loopback: true },
      diagnosticDirectory: privateDirectory
    }));
    if (rehearseCurrentDevY2Recovery) {
      await atRehearsalStage('mock-dev-current-migrations-before-y2', () =>
        applyPostOverlayMigrations(devConnection, migrationSequence));
      await withClient(devConnection, (client) => client.query(
        `insert into app.organizations(name)
         values ($1)`,
        [`y2-current-only-${token}`]
      ));
    }
    const smokeProfile = {
      userId: crypto.randomUUID(),
      identityId: crypto.randomUUID(),
      email: `smoke-${crypto.randomBytes(20).toString('hex')}@users.invalid`,
      structuralIdentitySharedForParity: false,
      lifecycleTimestamp: new Date().toISOString()
    };
    await installTargetNativeSmoke(devConnection, smokeProfile);
    const smokeOrganization = preserveNativeSmokeRelationalState
      ? await installTargetNativeSmokeOrganization(devConnection, smokeProfile)
      : null;
    const nativePreservation = smokeOrganization
      ? await withClient(devConnection, (client) => captureNativeSmokePreservation(client, {
          userId: smokeProfile.userId,
          organizationId: smokeOrganization.organizationId
        }))
      : null;
    if (nativePreservation) verifyNativeSmokePreservation(nativePreservation);
    const devAuthBeforeReplacement = await captureAuthParity(devConnection);
    if (
      devAuthBeforeReplacement.userCount !== sourceTransform.evidence.users + 1 ||
      devAuthBeforeReplacement.identityCount !== sourceTransform.evidence.identities + 1
    ) {
      throw categoricalError('MANAGED_POPULATED_DEV_SETUP_FAILED');
    }
    let currentDevY2 = null;
    if (rehearseCurrentDevY2Recovery) {
      const y2ArchivePath = privateArtifactPath(y2PrivateDirectory, 'current-dev-y2.private.pgdump');
      const y2SourceComponent = capturePrivatePlaintextArchive({
        tools,
        connectionString: devConnection,
        archivePath: y2ArchivePath
      });
      const y2TocBytes = execFileSync(tools.pgRestore, ['--list', y2ArchivePath], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 32 * 1024 * 1024
      });
      let y2Manifest;
      try {
        y2Manifest = buildManagedRestoreManifest({
          tocText: y2TocBytes.toString('utf8'),
          sourceComponent: y2SourceComponent
        });
      } finally {
        y2TocBytes.fill(0);
      }
      const y2TargetCatalog = await captureTargetCatalogProof(
        devConnection,
        y2Manifest,
        managedProfiles.dev
      );
      const y2AuthEvidence = await withClient(devConnection, captureExactAuthRecoveryEvidence);
      const y2AclContract = await withClient(devConnection, captureApplicationAclContract);
      const y2Application = await captureApplicationPlane(devConnection);
      const y2Auth = await captureAuthParity(devConnection);
      const y2Managed = await captureManagedPlaneFingerprint(devConnection);
      const y2RoutineDefaults = await withClient(
        devConnection,
        captureApplicationRoutineDefaultProfile
      );
      const y2FutureSecurity = await withClient(
        devConnection,
        captureFuturePublicFunctionDefaultSecurity
      );
      const y2AttemptId = `dev-y2-rehearsal-${token}`;
      const y2AuthAuthority = buildExactAuthRecoveryAuthority({
        attemptId: y2AttemptId,
        target: targetCatalog.dev.profileTarget,
        sourceComponentDigest: y2SourceComponent.digest,
        migration: y2Application.migration,
        evidence: y2AuthEvidence
      }, y2AuthRecoveryKey);
      const y2Package = generateManagedOverlayPackage({
        pgRestorePath: tools.pgRestore,
        pgDumpPath: tools.pgDump,
        archivePath: y2ArchivePath,
        sourceConnectionString: devConnection,
        privateDirectory: y2PrivateDirectory,
        sourceComponent: y2SourceComponent,
        authEvidence: {},
        migration: y2Application.migration,
        authCompatibility: authCompatibility.dev,
        targetCatalog: y2TargetCatalog,
        applicationReplacement: y2TargetCatalog.applicationReplacement,
        sourceAclContract: y2AclContract,
        applicationDefaultAcl: applicationDefaultAcls.dev,
        authRecovery: {
          authority: y2AuthAuthority,
          key: y2AuthRecoveryKey,
          attemptId: y2AttemptId
        }
      });
      currentDevY2 = {
        archivePath: y2ArchivePath,
        sourceComponent: y2SourceComponent,
        packageResult: y2Package,
        application: y2Application,
        auth: y2Auth,
        managed: y2Managed,
        routineDefaults: y2RoutineDefaults,
        futureSecurity: y2FutureSecurity
      };
    }
    const devRefreshCatalog = await captureTargetCatalogProof(
      devConnection,
      manifest,
      managedProfiles.dev
    );
    const devRefreshPackage = generateManagedOverlayPackage({
      pgRestorePath: tools.pgRestore,
      pgDumpPath: tools.pgDump,
      archivePath,
      sourceConnectionString: sourceDatabase,
      privateDirectory: devRefreshPrivateDirectory,
      sourceComponent,
      authEvidence: sourceTransform.evidence,
      migration: sourcePlane.migration,
      authCompatibility: authCompatibility.dev,
      targetCatalog: devRefreshCatalog,
      applicationReplacement: devRefreshCatalog.applicationReplacement,
      sourceAclContract,
      applicationDefaultAcl: applicationDefaultAcls.dev,
      nativePreservation
    });
    if (
      !preserveNativeSmokeRelationalState &&
      devRefreshPackage.script.semanticDigest !== devInitialPackage.script.semanticDigest
    ) {
      throw categoricalError('MANAGED_POPULATED_DEV_PACKAGE_DRIFT');
    }
    await atRehearsalStage('mock-dev-populated-replacement', () => executeManagedOverlayPackage({
      psqlPath: tools.psql,
      connectionString: devConnection,
      packageResult: devRefreshPackage,
      targetGuard: { mode: 'disposable-managed-local', loopback: true },
      diagnosticDirectory: devRefreshPrivateDirectory
    }));
    const postOverlay = [
      await atRehearsalStage('post-overlay-migrations-source', () =>
        applyPostOverlayMigrations(sourceMigrationConnection, migrationSequence)),
      await atRehearsalStage('post-overlay-migrations-sandbox', () =>
        applyPostOverlayMigrations(sandboxConnection, migrationSequence)),
      await atRehearsalStage('post-overlay-migrations-dev', () =>
        applyPostOverlayMigrations(devConnection, migrationSequence))
    ];
    const postOverlayContractProof = {};
    if (migrationSequence.some((migration) => migration.version === '20260822100000')) {
      const proof0203 = await Promise.all([
        capture0203Proof(sourceMigrationConnection),
        capture0203Proof(sandboxConnection),
        capture0203Proof(devConnection)
      ]);
      if (
        canonicalDigest(proof0203[0]) !== canonicalDigest(proof0203[1]) ||
        canonicalDigest(proof0203[0]) !== canonicalDigest(proof0203[2])
      ) {
        throw categoricalError('MANAGED_REHEARSAL_POST_OVERLAY_CONTRACT_PARITY_FAILED');
      }
      postOverlayContractProof.migration0203 = proof0203[0];
    }
    const routineDefaultsAfter0204 = {};
    if (includes0204) {
      const profiles = await Promise.all([
        withClient(sourceMigrationConnection, captureApplicationRoutineDefaultProfile),
        withClient(sandboxConnection, captureApplicationRoutineDefaultProfile),
        withClient(devConnection, captureApplicationRoutineDefaultProfile)
      ]);
      const security = await Promise.all([
        withClient(sourceMigrationConnection, captureFuturePublicFunctionDefaultSecurity),
        withClient(sandboxConnection, captureFuturePublicFunctionDefaultSecurity),
        withClient(devConnection, captureFuturePublicFunctionDefaultSecurity)
      ]);
      profiles.forEach(assertHardenedApplicationRoutineDefaultProfile);
      if (security.some((entry) => !entry.hardened)) {
        throw categoricalError('MANAGED_REHEARSAL_0204_CONTRACT_MISMATCH');
      }
      [routineDefaultsAfter0204.source, routineDefaultsAfter0204.sandbox, routineDefaultsAfter0204.dev] = profiles;
      postOverlayContractProof.migration0204 = {
        allTargetsHardened: true,
        sourceRecordCount: profiles[0].records.length,
        sandboxRecordCount: profiles[1].records.length,
        devRecordCount: profiles[2].records.length
      };
    }
    if (includes0205) {
      const proof0205 = await Promise.all([
        capture0205Proof(sourceMigrationConnection),
        capture0205Proof(sandboxConnection),
        capture0205Proof(devConnection)
      ]);
      if (
        canonicalDigest(proof0205[0]) !== canonicalDigest(proof0205[1]) ||
        canonicalDigest(proof0205[0]) !== canonicalDigest(proof0205[2])
      ) {
        throw categoricalError('MANAGED_REHEARSAL_0205_CONTRACT_PARITY_FAILED');
      }
      postOverlayContractProof.migration0205 = proof0205[0];
    }
    const futureObjectProbes = {
      sandbox: await probeFutureObjectDefaults(
        sandboxConnection,
        targetCatalog.sandbox.applicationDefaultAclEntries
      ),
      dev: await probeFutureObjectDefaults(
        devConnection,
        targetCatalog.dev.applicationDefaultAclEntries
      )
    };
    if (
      Object.values(futureObjectProbes).some((probe) =>
        !probe.applicationExact || !probe.functionExact || !probe.publicFunctionDenied ||
        !probe.anonFunctionDenied || !probe.authenticatedFunctionDenied ||
        !probe.serviceRoleFunctionDenied || !probe.ownerFunctionAllowed
      )
    ) {
      throw categoricalError('MANAGED_REHEARSAL_FUTURE_OBJECT_DEFAULT_MISMATCH');
    }
    const applicationDefaultsAfter = {
      sandbox: await withClient(sandboxConnection, captureApplicationDefaultAclEntries),
      dev: await withClient(devConnection, captureApplicationDefaultAclEntries)
    };
    if (
      canonicalDigest(applicationDefaultsAfter.sandbox) !==
        canonicalDigest(targetCatalog.sandbox.applicationDefaultAclEntries) ||
      canonicalDigest(applicationDefaultsAfter.dev) !==
        canonicalDigest(targetCatalog.dev.applicationDefaultAclEntries)
    ) {
      throw categoricalError('MANAGED_REHEARSAL_APPLICATION_DEFAULT_ACL_CHANGED');
    }
    const expectedSourcePlane = await captureApplicationPlane(sourceDatabase);
    const [sandboxPlane, devPlane, sourceAuth, sandboxAuth, devAuthBeforePreservation] = await Promise.all([
      captureApplicationPlane(sandboxConnection),
      captureApplicationPlane(devConnection, {
        excludeOrganizationId: nativePreservation ? smokeOrganization.organizationId : ''
      }),
      captureAuthParity(sourceDatabase),
      captureAuthParity(sandboxConnection),
      captureAuthParity(devConnection, { excludeNativeSmoke: Boolean(nativePreservation) })
    ]);
    const applicationParity = {
      sandbox: compareApplicationPlane(expectedSourcePlane, sandboxPlane),
      dev: compareApplicationPlane(expectedSourcePlane, devPlane)
    };
    const parity = {
      applicationSandbox: Object.values(applicationParity.sandbox).every(Boolean),
      applicationDev: Object.values(applicationParity.dev).every(Boolean),
      authSandbox: canonicalDigest([sourceAuth]) === canonicalDigest([sandboxAuth]),
      authDev: canonicalDigest([sourceAuth]) === canonicalDigest([devAuthBeforePreservation])
    };
    if (Object.values(parity).some((matches) => !matches)) {
      const error = categoricalError('MANAGED_OVERLAY_PARITY_FAILED');
      error.parity = parity;
      error.applicationParity = applicationParity;
      error.routineDifferences = {
        sandbox: summarizeRoutineDifferences(expectedSourcePlane.routineRows, sandboxPlane.routineRows),
        dev: summarizeRoutineDifferences(expectedSourcePlane.routineRows, devPlane.routineRows)
      };
      throw error;
    }
    let devPreservation;
    if (nativePreservation) {
      const observedPreservation = await withClient(devConnection, (client) =>
        captureNativeSmokePreservation(client, {
          userId: smokeProfile.userId,
          organizationId: smokeOrganization.organizationId
        }));
      if (
        observedPreservation.evidence.rowsDigest !== nativePreservation.evidence.rowsDigest ||
        observedPreservation.evidence.rowCount !== nativePreservation.evidence.rowCount
      ) {
        throw categoricalError('MANAGED_NATIVE_SMOKE_PRESERVATION_FAILED');
      }
      devPreservation = {
        userCount: 1,
        identityCount: 1,
        ownerMembershipCount: 1,
        relationalStatePreservedAtomically: true,
        organizationCount: 1
      };
    } else {
      devPreservation = await installTargetNativeSmoke(devConnection, smokeProfile);
    }
    const devAuthAfterPreservation = await captureAuthParity(devConnection);
    if (
      devAuthAfterPreservation.userCount !== sourceAuth.userCount + 1 ||
      devAuthAfterPreservation.identityCount !== sourceAuth.identityCount + 1 ||
      devAuthAfterPreservation.sessions !== 0 ||
      devAuthAfterPreservation.refreshTokens !== 0
    ) {
      throw categoricalError('MANAGED_DEV_PRESERVATION_FAILED');
    }
    const managedAfter = {
      sandbox: await captureManagedPlaneFingerprint(sandboxConnection),
      dev: await captureManagedPlaneFingerprint(devConnection)
    };
    const withoutDefaultAcl = ({ defaultAclDigest: _ignored, ...fingerprint }) => fingerprint;
    const managedPlaneStable = includes0204
      ? canonicalDigest([withoutDefaultAcl(managedBefore.sandbox)]) ===
          canonicalDigest([withoutDefaultAcl(managedAfter.sandbox)]) &&
        canonicalDigest([withoutDefaultAcl(managedBefore.dev)]) ===
          canonicalDigest([withoutDefaultAcl(managedAfter.dev)])
      : canonicalDigest([managedBefore.sandbox]) === canonicalDigest([managedAfter.sandbox]) &&
        canonicalDigest([managedBefore.dev]) === canonicalDigest([managedAfter.dev]);
    const approvedRoutineDefaultDelta = !includes0204 || (
      routineDefaultsAfter0204.source && routineDefaultsAfter0204.sandbox &&
      routineDefaultsAfter0204.dev &&
      (
        selectedRoutineDefaultProfiles.sandbox === 'hardened' ||
        managedBefore.sandbox.defaultAclDigest !== managedAfter.sandbox.defaultAclDigest
      ) &&
      (
        selectedRoutineDefaultProfiles.dev === 'hardened' ||
        managedBefore.dev.defaultAclDigest !== managedAfter.dev.defaultAclDigest
      )
    );
    if (!managedPlaneStable || !approvedRoutineDefaultDelta) {
      throw categoricalError('MANAGED_PLANE_CHANGED');
    }
    let recoveryProof = null;
    if (rehearsePre0204Recovery) {
      let forcedFailureObserved = false;
      try {
        throw categoricalError('MANAGED_REHEARSAL_FORCED_POST_COMMIT_FAILURE');
      } catch (error) {
        if (error.code !== 'MANAGED_REHEARSAL_FORCED_POST_COMMIT_FAILURE') throw error;
        forcedFailureObserved = true;
      }
      await atRehearsalStage('mock-dev-y2-routine-default-recovery', () => withClient(devConnection, async (client) => {
        await client.query('begin');
        try {
          await client.query(buildApplicationRoutineDefaultRecoverySql(routineDefaultsBefore.dev));
          await client.query('commit');
        } catch (error) {
          await client.query('rollback').catch(() => {});
          throw error;
        }
      }));
      await atRehearsalStage('mock-dev-y2-application-recovery', () => executeManagedOverlayPackage({
        psqlPath: tools.psql,
        connectionString: devConnection,
        packageResult: devRefreshPackage,
        targetGuard: { mode: 'disposable-managed-local', loopback: true },
        diagnosticDirectory: devRefreshPrivateDirectory
      }));
      const recoveredProfile = await withClient(
        devConnection,
        captureApplicationRoutineDefaultProfile
      );
      const recoveredManaged = await captureManagedPlaneFingerprint(devConnection);
      const recoveredApplication = await captureApplicationPlane(devConnection);
      const recoveredAuth = await captureAuthParity(devConnection);
      const recoveryFutureProbe = await probeFutureObjectDefaults(
        devConnection,
        targetCatalog.dev.applicationDefaultAclEntries,
        {
          publicExecute: futureFunctionSecurityBefore.dev.publicExecute,
          anonExecute: futureFunctionSecurityBefore.dev.anonExecute,
          authenticatedExecute: futureFunctionSecurityBefore.dev.authenticatedExecute,
          serviceRoleExecute: futureFunctionSecurityBefore.dev.serviceRoleExecute,
          ownerExecute: futureFunctionSecurityBefore.dev.ownerExecute
        }
      );
      const profileEqual = canonicalDigest(recoveredProfile) === canonicalDigest(routineDefaultsBefore.dev);
      const managedEqual = canonicalDigest([recoveredManaged]) === canonicalDigest([managedBefore.dev]);
      const applicationEqual = Object.values(
        compareApplicationPlane(sourcePlane, recoveredApplication)
      ).every(Boolean);
      const authEqual = canonicalDigest([sourceAuth]) === canonicalDigest([recoveredAuth]);
      const migrationStateRestored =
        canonicalDigest(recoveredApplication.migration) === canonicalDigest(sourcePlane.migration);
      if (
        !forcedFailureObserved || !profileEqual || !managedEqual || !applicationEqual ||
        !authEqual || !migrationStateRestored || !recoveryFutureProbe.applicationExact ||
        !recoveryFutureProbe.functionExact
      ) {
        throw categoricalError('MANAGED_REHEARSAL_Y2_RECOVERY_MISMATCH');
      }
      recoveryProof = {
        forcedPostCommitFailureObserved: true,
        pre0204RoutineDefaultsRestored: true,
        managedFingerprintRestored: true,
        applicationPlaneRestored: true,
        authPlaneRestored: true,
        migrationStateRestored,
        futureObjectSemanticsRestored: true,
        futureObjectProbe: recoveryFutureProbe
      };
    }
    let currentDevRecoveryProof = null;
    if (rehearseCurrentDevY2Recovery) {
      if (!currentDevY2) throw categoricalError('MANAGED_REHEARSAL_CURRENT_Y2_MISSING');
      const cutoverDrift = await withClient(devConnection, (client) => client.query(
        'select count(*)::bigint as count from app.organizations where name = $1',
        [`y2-current-only-${token}`]
      ));
      if (Number(cutoverDrift.rows[0].count) !== 0) {
        throw categoricalError('MANAGED_REHEARSAL_CURRENT_DRIFT_SURVIVED_CUTOVER');
      }
      await atRehearsalStage('mock-dev-current-y2-routine-default-recovery', () =>
        withClient(devConnection, async (client) => {
          await client.query('begin');
          try {
            await client.query(buildApplicationRoutineDefaultRecoverySql(currentDevY2.routineDefaults));
            await client.query('commit');
          } catch (error) {
            await client.query('rollback').catch(() => {});
            throw error;
          }
        }));
      await atRehearsalStage('mock-dev-current-y2-application-recovery', () =>
        executeManagedOverlayPackage({
          psqlPath: tools.psql,
          connectionString: devConnection,
          packageResult: currentDevY2.packageResult,
          targetGuard: { mode: 'disposable-managed-local', loopback: true },
          diagnosticDirectory: y2PrivateDirectory
        }));
      const recovered = {
        application: await captureApplicationPlane(devConnection),
        auth: await captureAuthParity(devConnection),
        managed: await captureManagedPlaneFingerprint(devConnection),
        routineDefaults: await withClient(devConnection, captureApplicationRoutineDefaultProfile)
      };
      const recoveryFutureProbe = await probeFutureObjectDefaults(
        devConnection,
        targetCatalog.dev.applicationDefaultAclEntries,
        {
          publicExecute: currentDevY2.futureSecurity.publicExecute,
          anonExecute: currentDevY2.futureSecurity.anonExecute,
          authenticatedExecute: currentDevY2.futureSecurity.authenticatedExecute,
          serviceRoleExecute: currentDevY2.futureSecurity.serviceRoleExecute,
          ownerExecute: currentDevY2.futureSecurity.ownerExecute
        }
      );
      const restoredCurrentOnly = await withClient(devConnection, (client) => client.query(
        'select count(*)::bigint as count from app.organizations where name = $1',
        [`y2-current-only-${token}`]
      ));
      const exact = {
        application:
          Object.values(compareApplicationPlane(currentDevY2.application, recovered.application)).every(Boolean),
        auth: canonicalDigest([currentDevY2.auth]) === canonicalDigest([recovered.auth]),
        managed: canonicalDigest([currentDevY2.managed]) === canonicalDigest([recovered.managed]),
        routineDefaults:
          canonicalDigest(currentDevY2.routineDefaults) === canonicalDigest(recovered.routineDefaults),
        currentOnlyState: Number(restoredCurrentOnly.rows[0].count) === 1,
        futureObjects: recoveryFutureProbe.applicationExact && recoveryFutureProbe.functionExact,
        migration0205:
          recovered.application.migration.count === 188 &&
          recovered.application.migration.tip === '20260824100000'
      };
      if (Object.values(exact).some((value) => value !== true)) {
        const error = categoricalError('MANAGED_REHEARSAL_CURRENT_Y2_RECOVERY_MISMATCH');
        error.failedComparisons = Object.entries(exact)
          .filter(([, value]) => value !== true)
          .map(([name]) => name);
        throw error;
      }
      currentDevRecoveryProof = {
        capturedBeforeDestructiveBoundary: true,
        authenticatedPrivatePackage: true,
        currentOnlyStateRemovedByCutover: true,
        exactApplicationRestored: true,
        exactAuthRestored: true,
        exactManagedProfileRestored: true,
        exactRoutineDefaultsRestored: true,
        currentOnlyStateRestored: true,
        migration0205Restored: true,
        futureObjectSemanticsRestored: true
      };
    }
    const residualFiles = [
      privateDirectory,
      devInitialPrivateDirectory,
      devRefreshPrivateDirectory,
      y2PrivateDirectory
    ].flatMap((directory) =>
      fs.readdirSync(directory).filter((name) => name.startsWith('postgres-diagnostic-'))
    );
    if (residualFiles.length !== 0) throw categoricalError('MANAGED_DIAGNOSTIC_RESIDUE');
    const result = {
      classification: 'MANAGED_OVERLAY_REHEARSAL_PASSED',
      oldMethod: {
        failed: true,
        classification: oldFailure.classification,
        atomicRollback: true,
        applicationDefaultAclLossReproduced: oldDefaultAclLoss.reproduced,
        applicationDefaultAclBeforeCount: oldDefaultAclLoss.beforeCount,
        applicationDefaultAclAfterReplacementCount: oldDefaultAclLoss.afterCount
      },
      manifest: {
        itemCount: manifest.entries.length,
        categoryCounts: manifest.categoryCounts,
        actionCounts: manifest.actionCounts,
        unknownCount: manifest.categoryCounts.UNCERTAIN
      },
      auth: {
        compatibility: authCompatibility.sandbox.compatible && authCompatibility.dev.compatible,
        copiedUsers: sourceAuth.userCount,
        copiedIdentities: sourceAuth.identityCount,
        sessions: sandboxAuth.sessions,
        refreshTokens: sandboxAuth.refreshTokens,
        copiedCredentialShapeCount: sandboxAuth.unsafeUsers,
        targetNativeDefinitionsPreserved: true
      },
      targetCatalog: {
        sandboxCompatible: targetCatalog.sandbox.compatible,
        devCompatible: targetCatalog.dev.compatible,
        readOnlyProof: targetCatalog.sandbox.transactionReadOnly && targetCatalog.dev.transactionReadOnly,
        distinctAuthenticatedProfiles:
          targetCatalog.sandbox.authenticated && targetCatalog.dev.authenticated &&
          targetCatalog.sandbox.catalogDigest !== targetCatalog.dev.catalogDigest,
        sandboxPublicOwnerPreserved:
          managedBefore.sandbox.publicOwner === managedAfter.sandbox.publicOwner,
        devPublicOwnerPreserved: managedBefore.dev.publicOwner === managedAfter.dev.publicOwner,
        defaultAclsPreserved:
          includes0204
            ? approvedRoutineDefaultDelta
            : managedBefore.sandbox.defaultAclDigest === managedAfter.sandbox.defaultAclDigest &&
              managedBefore.dev.defaultAclDigest === managedAfter.dev.defaultAclDigest,
        approvedRoutineDefaultDelta,
        applicationDefaultAclsPreserved:
          canonicalDigest(applicationDefaultsAfter.sandbox) ===
            canonicalDigest(targetCatalog.sandbox.applicationDefaultAclEntries) &&
          canonicalDigest(applicationDefaultsAfter.dev) ===
            canonicalDigest(targetCatalog.dev.applicationDefaultAclEntries),
        membershipsPreserved:
          managedBefore.sandbox.roleMembershipDigest === managedAfter.sandbox.roleMembershipDigest &&
          managedBefore.dev.roleMembershipDigest === managedAfter.dev.roleMembershipDigest
      },
      targets: {
        mockSandboxManaged: {
          applicationParity: parity.applicationSandbox,
          authParity: parity.authSandbox
        },
        mockDevManaged: {
          applicationParity: parity.applicationDev,
          authParityBeforePreservation: parity.authDev,
          populatedApplicationPlaneReplaced: true,
          populatedPackageByteEquivalent: true,
          preExistingTargetIdentityPurged: true,
          preservationUsersAdded: 1
        }
      },
      migration: expectedSourcePlane.migration,
      futureObjectProbes,
      routineDefaultProfiles: {
        selected: { ...selectedRoutineDefaultProfiles },
        beforeRecordCounts: {
          source: routineDefaultsBefore.source.records.length,
          sandbox: routineDefaultsBefore.sandbox.records.length,
          dev: routineDefaultsBefore.dev.records.length
        },
        hardenedBy0204: includes0204
      },
      recovery: {
        destructiveSecondOverlayRestoredApplicationDefaults: true,
        futureObjectSemanticsRestored: futureObjectProbes.dev.applicationExact,
        applicationDefaultAclEntryCount: applicationDefaultsAfter.dev.length,
        pre0204: recoveryProof,
        currentDevY2: currentDevRecoveryProof
      },
      postOverlayMigration: {
        requested: migrationSequence.length > 0,
        appliedToAllTargets:
          postOverlay.flat().every((entry) => entry.applied) || migrationSequence.length === 0,
        versions: migrationSequence.map((migration) => migration.version),
        version: migrationSequence.length === 1 ? migrationSequence[0].version : '',
        contractProof: Object.keys(postOverlayContractProof).length > 0
          ? postOverlayContractProof
          : null
      },
      devPreservation,
      atomic: packageResult.atomic,
      diagnosticResidue: 0,
      managedPlanePreserved: managedPlaneStable && approvedRoutineDefaultDelta
    };
    if (retainDisposableTarget) {
      if (!nativePreservation) {
        throw categoricalError('MANAGED_REHEARSAL_RETAINED_TARGET_CONTRACT_INVALID');
      }
      Object.defineProperty(result, 'disposableSession', {
        enumerable: false,
        value: Object.freeze({
          root: cluster.root,
          dataDirectory: cluster.dataDirectory,
          logPath: cluster.logPath,
          postgresBin: tools.bin,
          connectionString: devConnection,
          smokeUserId: smokeProfile.userId,
          smokeOrganizationId: smokeOrganization.organizationId,
          devRefreshPackage,
          y2Package: currentDevY2?.packageResult || null,
          y2Application: currentDevY2?.application || null,
          y2Auth: currentDevY2?.auth || null,
          y2Managed: currentDevY2?.managed || null,
          y2RoutineDefaults: currentDevY2?.routineDefaults || null,
          y2FutureSecurity: currentDevY2?.futureSecurity || null,
          nativePreservation: nativePreservation.evidence,
          targetCatalog: targetCatalog.dev,
          applicationDefaultAclEntries: targetCatalog.dev.applicationDefaultAclEntries,
          currentApplication: expectedSourcePlane,
          sourceAuth,
          postOverlayContractProof,
          futureObjectProbe: futureObjectProbes.dev
        })
      });
      retainCluster = true;
    }
    return result;
  } finally {
    managedProfileKey.fill(0);
    applicationDefaultAclKey.fill(0);
    y2AuthRecoveryKey.fill(0);
    if (cluster && !retainCluster) await removeDisposablePostgres(cluster);
  }
}

export {
  applyManagedAuthPrivilegeProfile,
  applyPostOverlayMigrations,
  assertSourceRestoreAuthority,
  capture0203Proof,
  capture0205Proof,
  captureApplicationPlane,
  captureApplicationPlaneFromClient,
  captureAuthParity,
  captureAuthParityFromClient,
  captureManagedPlaneFingerprint,
  captureManagedPlaneFingerprintFromClient,
  generateCurrentDatabaseRecoveryPackage,
  prepareGoldenManagedOverlayForTarget,
  probeFutureObjectDefaults,
  restoreSource,
  runManagedRestoreCompatibilityRehearsal
};
