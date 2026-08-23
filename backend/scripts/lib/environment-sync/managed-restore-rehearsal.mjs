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
  buildProfileApplicationDefaultAclManifest,
  captureApplicationDefaultAclEntries
} from './application-default-acl-preservation.mjs';
import {
  removeDisposablePostgres,
  resolvePostgresTools,
  startDisposablePostgres,
  withClient
} from './disposable-postgres.mjs';
import { parseDatabaseConnection, postgresChildEnvironment } from './encrypted-baseline.mjs';
import {
  assertApplicationReplacementCompatibility,
  assertAuthOverlayCompatibility,
  assertManagedTargetCatalogCompatibility,
  buildManagedRestoreManifest,
  captureApplicationReplacementCatalog,
  captureAuthOverlaySourceEvidence,
  captureManagedTargetCatalog,
  executeManagedOverlayPackage,
  generateManagedOverlayPackage,
  parsePgRestoreList
} from './managed-restore.mjs';
import {
  createPrivateDirectory,
  privateArtifactPath,
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
    'relationDigest', 'routineDigest', 'constraintDigest', 'grantDigest', 'aclObjectDigest',
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
  profileStyle
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
    await client.query('grant all privileges on all tables in schema auth to postgres');
    await client.query('grant all privileges on all sequences in schema auth to postgres');
    await client.query('grant usage on schema auth to postgres');
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
    await client.query('alter default privileges for role postgres revoke execute on functions from public');
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

async function captureManagedPlaneFingerprint(connectionString) {
  return withClient(connectionString, async (client) => {
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
  });
}

async function captureApplicationPlane(connectionString) {
  return withClient(connectionString, async (client) => {
    const relations = (await client.query(
      `select n.nspname as schema_name, c.relname as relation_name, c.relkind
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = any(array['app','app_api']) and c.relkind in ('r','p','v','m','S')
        order by n.nspname, c.relname, c.relkind`
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
        order by n.nspname, c.relname, con.conname`
    )).rows;
    const aclContract = await captureApplicationAclContract(client);
    const tableRows = [];
    for (const relation of relations.filter((entry) => ['r', 'p'].includes(entry.relkind))) {
      const qualified = `${quoteIdentifier(relation.schema_name)}.${quoteIdentifier(relation.relation_name)}`;
      const result = (await client.query(
        `select count(*)::bigint as count,
                md5(coalesce(string_agg(pg_catalog.to_jsonb(t)::text, '|' order by pg_catalog.to_jsonb(t)::text), '')) as digest
           from ${qualified} t`
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
      routineDigest: canonicalDigest(routines),
      constraintDigest: canonicalDigest(constraints),
      grantDigest: aclContract.grantDigest,
      aclObjectDigest: aclContract.objectDigest,
      tableDigest: canonicalDigest(tableRows),
      tableCount: tableRows.length,
      migration: { count: Number(migration.count), tip: String(migration.tip || '') }
    };
    Object.defineProperty(result, 'routineRows', { value: routines, enumerable: false });
    return result;
  });
}

async function captureAuthParity(connectionString) {
  return withClient(connectionString, async (client) => {
    const users = (await client.query('select id::text from auth.users order by id')).rows;
    const identities = (await client.query(
      'select id::text, user_id::text from auth.identities order by id'
    )).rows;
    const unsafe = (await client.query(
      `select
         count(*) filter (where email !~ '^[a-z0-9-]+@users\\.invalid$'
                              or encrypted_password <> '!x-np-disabled-v1!'
                              or banned_until <> 'infinity'::timestamptz)::bigint as unsafe_users,
         (select count(*)::bigint from auth.sessions) as sessions,
         (select count(*)::bigint from auth.refresh_tokens) as refresh_tokens
       from auth.users`
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
  });
}

async function restoreSource({ tools, archivePath, connectionString, diagnosticDirectory }) {
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

async function probeFutureObjectDefaults(connectionString, expectedDefaults) {
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
          ) as anon_execute
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
      return {
        applicationExact: canonicalDigest(observedApplication) === canonicalDigest(expectedApplication),
        tableGrantCount: application.filter(
          (row) => row.object_class === 'table' && row.grantee === 'service_role'
        ).length,
        sequenceGrantCount: application.filter(
          (row) => row.object_class === 'sequence' && row.grantee === 'service_role'
        ).length,
        totalApplicationGrantCount: application.length,
        publicFunctionDenied: routine.public_execute === false,
        anonFunctionDenied: routine.anon_execute === false
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

async function runManagedRestoreCompatibilityRehearsal({
  archivePath,
  sourceComponent,
  postOverlayMigration = null,
  postgresBin = '',
  temporaryParent = os.tmpdir()
} = {}) {
  const tools = resolvePostgresTools(postgresBin);
  const token = crypto.randomBytes(8).toString('hex');
  const root = path.join(temporaryParent, `environment-sync-rehearsal-managed-${token}`);
  let cluster;
  const managedProfileKey = crypto.randomBytes(32);
  const applicationDefaultAclKey = crypto.randomBytes(32);
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
    const sandboxAdmin = await createDatabase(adminRootConnection, sandboxName, 'postgres');
    const devAdmin = await createDatabase(adminRootConnection, devName, 'postgres');
    const sandboxConnection = connectionForUser(sandboxAdmin, 'postgres');
    const devConnection = connectionForUser(devAdmin, 'postgres');
    const privateDirectory = path.join(root, 'managed-overlay-private');
    const devInitialPrivateDirectory = path.join(root, 'managed-overlay-private-dev-initial');
    const devRefreshPrivateDirectory = path.join(root, 'managed-overlay-private-dev-refresh');
    createPrivateDirectory(privateDirectory);
    createPrivateDirectory(devInitialPrivateDirectory);
    createPrivateDirectory(devRefreshPrivateDirectory);
    verifyPrivateDirectoryProtection(privateDirectory);
    verifyPrivateDirectoryProtection(devInitialPrivateDirectory);
    verifyPrivateDirectoryProtection(devRefreshPrivateDirectory);
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
      profileStyle: 'sandbox-current'
    });
    await installManagedPlane({
      adminConnection: devAdmin,
      archivePath,
      tocText,
      tools,
      privateDirectory,
      profileStyle: 'dev-historical'
    });
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
    const smokeProfile = {
      userId: crypto.randomUUID(),
      identityId: crypto.randomUUID(),
      email: `smoke-${crypto.randomBytes(20).toString('hex')}@users.invalid`,
      structuralIdentitySharedForParity: false,
      lifecycleTimestamp: new Date().toISOString()
    };
    await installTargetNativeSmoke(devConnection, smokeProfile);
    const devAuthBeforeReplacement = await captureAuthParity(devConnection);
    if (
      devAuthBeforeReplacement.userCount !== sourceTransform.evidence.users + 1 ||
      devAuthBeforeReplacement.identityCount !== sourceTransform.evidence.identities + 1
    ) {
      throw categoricalError('MANAGED_POPULATED_DEV_SETUP_FAILED');
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
      applicationDefaultAcl: applicationDefaultAcls.dev
    });
    if (devRefreshPackage.script.semanticDigest !== devInitialPackage.script.semanticDigest) {
      throw categoricalError('MANAGED_POPULATED_DEV_PACKAGE_DRIFT');
    }
    await atRehearsalStage('mock-dev-populated-replacement', () => executeManagedOverlayPackage({
      psqlPath: tools.psql,
      connectionString: devConnection,
      packageResult: devRefreshPackage,
      targetGuard: { mode: 'disposable-managed-local', loopback: true },
      diagnosticDirectory: devRefreshPrivateDirectory
    }));
    const postOverlay = await Promise.all([
      applyPostOverlayMigration(sourceDatabase, postOverlayMigration),
      applyPostOverlayMigration(sandboxConnection, postOverlayMigration),
      applyPostOverlayMigration(devConnection, postOverlayMigration)
    ]);
    const postOverlayContractProof = postOverlayMigration?.version === '20260822100000'
      ? await Promise.all([
          capture0203Proof(sourceDatabase),
          capture0203Proof(sandboxConnection),
          capture0203Proof(devConnection)
        ])
      : [];
    if (
      postOverlayContractProof.length > 0 &&
      (
        canonicalDigest(postOverlayContractProof[0]) !== canonicalDigest(postOverlayContractProof[1]) ||
        canonicalDigest(postOverlayContractProof[0]) !== canonicalDigest(postOverlayContractProof[2])
      )
    ) {
      throw categoricalError('MANAGED_REHEARSAL_POST_OVERLAY_CONTRACT_PARITY_FAILED');
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
        !probe.applicationExact || !probe.publicFunctionDenied || !probe.anonFunctionDenied
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
      captureApplicationPlane(devConnection),
      captureAuthParity(sourceDatabase),
      captureAuthParity(sandboxConnection),
      captureAuthParity(devConnection)
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
    const devPreservation = await installTargetNativeSmoke(devConnection, smokeProfile);
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
    if (
      canonicalDigest([managedBefore.sandbox]) !== canonicalDigest([managedAfter.sandbox]) ||
      canonicalDigest([managedBefore.dev]) !== canonicalDigest([managedAfter.dev])
    ) {
      throw categoricalError('MANAGED_PLANE_CHANGED');
    }
    const residualFiles = [
      privateDirectory,
      devInitialPrivateDirectory,
      devRefreshPrivateDirectory
    ].flatMap((directory) =>
      fs.readdirSync(directory).filter((name) => name.startsWith('postgres-diagnostic-'))
    );
    if (residualFiles.length !== 0) throw categoricalError('MANAGED_DIAGNOSTIC_RESIDUE');
    return {
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
          managedBefore.sandbox.defaultAclDigest === managedAfter.sandbox.defaultAclDigest &&
          managedBefore.dev.defaultAclDigest === managedAfter.dev.defaultAclDigest,
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
      recovery: {
        destructiveSecondOverlayRestoredApplicationDefaults: true,
        futureObjectSemanticsRestored: futureObjectProbes.dev.applicationExact,
        applicationDefaultAclEntryCount: applicationDefaultsAfter.dev.length
      },
      postOverlayMigration: {
        requested: postOverlayMigration !== null,
        appliedToAllTargets: postOverlay.every((entry) => entry.applied) || postOverlayMigration === null,
        version: postOverlayMigration === null ? '' : postOverlay[0].version,
        contractProof: postOverlayContractProof[0] || null
      },
      devPreservation,
      atomic: packageResult.atomic,
      diagnosticResidue: 0,
      managedPlanePreserved: true
    };
  } finally {
    managedProfileKey.fill(0);
    applicationDefaultAclKey.fill(0);
    if (cluster) await removeDisposablePostgres(cluster);
  }
}

export { runManagedRestoreCompatibilityRehearsal };
