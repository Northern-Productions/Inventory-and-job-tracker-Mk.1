import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AUTH_RECOVERY_TABLE_CLASSIFICATION, CURRENT_AUTH_TABLES } from './constants.mjs';
import {
  prepareRestoreDatabase,
  removeDisposablePostgres,
  resolvePostgresTools,
  startDisposablePostgres,
  withClient
} from './disposable-postgres.mjs';
import { postgresChildEnvironment } from './encrypted-baseline.mjs';

import {
  AUTH_IDENTITIES_COPY_COLUMNS,
  AUTH_USERS_COPY_COLUMNS,
  MANAGED_OVERLAY_COMPATIBILITY_BINDING_FIELDS,
  MANAGED_RESTORE_CATEGORIES,
  applicationContentRestoreList,
  applicationRestoreList,
  applicationSchemaRestoreList,
  assertApplicationReplacementCompatibility,
  assertAuthOverlayCompatibility,
  assertManagedCompatibilityProof,
  assertManagedTargetCatalogCompatibility,
  assertOverlayExecutionGuard,
  authTransformEntries,
  buildApplicationPlaneResetSql,
  buildAuthOverlayPurgeSql,
  buildAuthPreservationAuthority,
  buildExactAuthRecoveryAuthority,
  buildManagedOverlaySql,
  buildManagedOverlayTargetGuard,
  buildManagedRestoreManifest,
  canonicalizePsqlRestrictionTokens,
  captureExactAuthRecoveryEvidence,
  migrationRestoreList,
  normalizeGeneratedSql,
  parsePgRestoreList,
  verifyExactAuthRecoveryAuthority,
  verifyAuthPreservationAuthority,
  verifyManagedRestoreManifest
} from './managed-restore.mjs';

test('managed overlay compatibility field matrix is canonical and fail-closed', () => {
  const digest = (value) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
  const projectRef = 'd'.repeat(20);
  const packageResult = {
    targetCompatibility: {
      authShapeDigest: digest('auth-shape'),
      catalogDigest: digest('catalog'),
      managedProfileDigest: digest('profile'),
      managedProfileId: 'dev-managed-profile-v1',
      managedProfileTarget: { environment: 'dev', projectRef },
      managedProfileSecurityDigest: digest('profile-security'),
      applicationReplacementDigest: digest('application-replacement')
    },
    manifest: { planDigest: digest('restore-plan') }
  };
  const expectedMatrix = [
    ['managedCatalogDigest', 'targetCompatibility.catalogDigest'],
    ['managedProfileDigest', 'targetCompatibility.managedProfileDigest'],
    ['managedProfileId', 'targetCompatibility.managedProfileId'],
    ['managedProfileSecurityDigest', 'targetCompatibility.managedProfileSecurityDigest'],
    ['managedProfileTarget', 'targetCompatibility.managedProfileTarget'],
    ['authShapeDigest', 'targetCompatibility.authShapeDigest'],
    ['applicationReplacementDigest', 'targetCompatibility.applicationReplacementDigest'],
    ['restorePlanDigest', 'manifest.planDigest']
  ];
  assert.deepEqual(
    MANAGED_OVERLAY_COMPATIBILITY_BINDING_FIELDS.map(({ guardField, packageField }) => [
      guardField,
      packageField
    ]),
    expectedMatrix
  );
  const guard = buildManagedOverlayTargetGuard({
    packageResult,
    target: 'dev',
    projectRef,
    mutationGuardPassed: true,
    projectRefMatched: true
  });
  assert.deepEqual(Object.keys(guard), [
    'target',
    'projectRef',
    'mutationGuardPassed',
    'projectRefMatched',
    ...expectedMatrix.map(([guardField]) => guardField)
  ]);
  assert.equal(guard.managedCatalogDigest, packageResult.targetCompatibility.catalogDigest);
  assert.equal(guard.restorePlanDigest, packageResult.manifest.planDigest);
  assert.deepEqual(guard.managedProfileTarget, packageResult.targetCompatibility.managedProfileTarget);
  assert.notEqual(guard.managedProfileTarget, packageResult.targetCompatibility.managedProfileTarget);

  for (const mutate of [
    (value) => { value.targetCompatibility = null; },
    (value) => { value.manifest = null; },
    (value) => { value.targetCompatibility.catalogDigest = ''; },
    (value) => { value.targetCompatibility.managedProfileId = ''; },
    (value) => { value.targetCompatibility.managedProfileTarget = null; },
    (value) => { value.manifest.planDigest = 'sha256:invalid'; }
  ]) {
    const changed = structuredClone(packageResult);
    mutate(changed);
    assert.throws(() => buildManagedOverlayTargetGuard({
      packageResult: changed,
      target: 'dev',
      projectRef,
      mutationGuardPassed: true,
      projectRefMatched: true
    }), { code: 'MANAGED_OVERLAY_COMPATIBILITY_BINDING_INVALID' });
  }
  assert.throws(() => buildManagedOverlayTargetGuard({
    packageResult,
    target: 'sandbox',
    projectRef,
    mutationGuardPassed: true,
    projectRefMatched: true
  }), { code: 'MANAGED_OVERLAY_COMPATIBILITY_BINDING_INVALID' });
  assert.throws(() => buildManagedOverlayTargetGuard({
    packageResult,
    target: 'dev',
    projectRef,
    mutationGuardPassed: false,
    projectRefMatched: true
  }), { code: 'MANAGED_OVERLAY_COMPATIBILITY_BINDING_INVALID' });
});

test('all 23 Auth tables have one exact no-DML recovery classification', () => {
  assert.deepEqual(Object.keys(AUTH_RECOVERY_TABLE_CLASSIFICATION), CURRENT_AUTH_TABLES);
  assert.equal(Object.values(AUTH_RECOVERY_TABLE_CLASSIFICATION)
    .every((entry) => entry.dml === 'none' && entry.recoveryOwned === false), true);
  assert.equal(AUTH_RECOVERY_TABLE_CLASSIFICATION.audit_log_entries.state, 'stable_exact');
  assert.equal(
    AUTH_RECOVERY_TABLE_CLASSIFICATION.audit_log_entries.prerequisite,
    'postgres_audit_storage_disabled'
  );
  assert.equal(AUTH_RECOVERY_TABLE_CLASSIFICATION.users.state, 'native_smoke_volatile');
  assert.equal(AUTH_RECOVERY_TABLE_CLASSIFICATION.identities.state, 'native_smoke_volatile');
  assert.equal(AUTH_RECOVERY_TABLE_CLASSIFICATION.sessions.state, 'bounded_native_smoke_ephemera');
  assert.equal(AUTH_RECOVERY_TABLE_CLASSIFICATION.refresh_tokens.state, 'bounded_native_smoke_ephemera');
  assert.equal(AUTH_RECOVERY_TABLE_CLASSIFICATION.schema_migrations.dml, 'none');
});

test('exact Auth evidence uses canonical bytewise UTF-8 row ordering', async () => {
  const statements = [];
  const emptyDigest = `sha256:${crypto.createHash('sha256').update('').digest('hex')}`;
  const evidence = await captureExactAuthRecoveryEvidence({
    async query(sql) {
      statements.push(sql);
      return { rows: [{ count: 0, digest: emptyDigest }] };
    }
  });
  assert.equal(evidence.serialization, 'postgres-jsonb-text-lf-bytewise-utf8-v1');
  assert.equal(statements.length, 23);
  assert.equal(statements.every((sql) =>
    /order by pg_catalog\.convert_to\(pg_catalog\.to_jsonb\(t\)::text, 'UTF8'\)/.test(sql)), true);
});

test('exact Auth evidence round-trips non-ASCII metadata across ICU and C collations', {
  timeout: 120_000
}, async (t) => {
  let tools;
  try {
    tools = resolvePostgresTools();
  } catch {
    t.skip('Complete PostgreSQL server tooling is unavailable.');
    return;
  }
  const token = crypto.randomBytes(8).toString('hex');
  const root = path.join(os.tmpdir(), `environment-sync-rehearsal-${token}`);
  const sourceName = `x_rehearsal_dev_auth_icu_${token}`;
  const targetName = `x_rehearsal_dev_auth_c_${token}`;
  const archivePath = path.join(root, 'auth-collation.private.pgdump');
  let cluster;
  try {
    cluster = await startDisposablePostgres({ rootDirectory: root });
    const targetConnection = await prepareRestoreDatabase(cluster, targetName);
    await withClient(cluster.connectionString(), (client) => client.query(
      `create database "${sourceName}" template template0 locale_provider icu icu_locale 'en-US'`
    ));
    const sourceConnection = cluster.connectionString(sourceName);
    await withClient(sourceConnection, (client) => client.query(`
      drop schema public cascade;
      create schema extensions;
      create extension pgcrypto with schema extensions;
    `));
    await seedManagedSource(sourceConnection);
    const sourceEvidence = await withClient(sourceConnection, captureExactAuthRecoveryEvidence);
    const localeProof = await withClient(cluster.connectionString(), async (client) => (
      await client.query(`select datname, datlocprovider, datcollate
        from pg_catalog.pg_database where datname = any($1::text[]) order by datname`, [
        [sourceName, targetName]
      ])
    ).rows);
    assert.equal(localeProof.length, 2);
    const sourceLocale = localeProof.find((row) => row.datname === sourceName);
    const targetLocale = localeProof.find((row) => row.datname === targetName);
    assert.notDeepEqual(
      [sourceLocale.datlocprovider, sourceLocale.datcollate],
      [targetLocale.datlocprovider, targetLocale.datcollate]
    );
    execFileSync(tools.pgDump, [
      '--format=custom',
      '--schema=auth',
      '--file', archivePath,
      '--dbname', new URL(sourceConnection).pathname.slice(1)
    ], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: postgresChildEnvironment(sourceConnection)
    });
    execFileSync(tools.pgRestore, [
      '--exit-on-error',
      '--dbname', new URL(targetConnection).pathname.slice(1),
      archivePath
    ], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: postgresChildEnvironment(targetConnection)
    });
    const restoredEvidence = await withClient(targetConnection, captureExactAuthRecoveryEvidence);
    assert.deepEqual(restoredEvidence, sourceEvidence);
    assert.equal(restoredEvidence.serialization, 'postgres-jsonb-text-lf-bytewise-utf8-v1');
  } finally {
    if (cluster) await removeDisposablePostgres(cluster);
  }
});
import {
  REPOSITORY_APPLICATION_DEFAULT_ACL_INTENT,
  authenticateApplicationDefaultAclManifest,
  buildRepositoryApplicationDefaultAclManifest,
  verifyApplicationDefaultAclManifest
} from './application-default-acl-preservation.mjs';
import {
  createPrivateDirectory,
  verifyPrivateArtifactProtection,
  writePrivateBytesExclusive
} from './private-artifacts.mjs';
import {
  runPrivateDiagnosticCommand,
  sanitizePostgresDiagnostic
} from './private-diagnostics.mjs';
import {
  restoreSource,
  runManagedRestoreCompatibilityRehearsal
} from './managed-restore-rehearsal.mjs';
import {
  APPLICATION_FACING_ROLES,
  MANAGED_PROFILE_SECURITY_POLICY_FORMAT,
  authenticateManagedProfileCertificate,
  buildManagedProfileCertificate,
  managedProfileEvidenceFromCatalog
} from './managed-profile.mjs';

const MANAGED_PROFILE_TEST_KEY = Buffer.from(
  'managed-restore-profile-test-key-00000000000000000000000000000000'
);
const MANAGED_PROFILE_TEST_TARGET = Object.freeze({
  environment: 'sandbox',
  projectRef: 's'.repeat(20)
});
const SYNTHETIC_0203 = Object.freeze({
  version: '20260822100000',
  sql: `
    create or replace function public.api_get_auth_context(p_org_id uuid)
    returns jsonb
    language sql
    stable
    security definer
    set search_path = public, app, app_api
    as $function$
      select pg_catalog.jsonb_build_object(
        'accessStatus', 'approved',
        'role', member.role,
        'defaultWarehouse', app_api.get_user_default_warehouse(member.org_id, member.user_id),
        'permissions', pg_catalog.jsonb_build_object('team_management', true)
      )
      from app.organization_members member
      where member.org_id = p_org_id
        and member.user_id = (pg_catalog.current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid
        and member.status = 'active'
    $function$;
    revoke execute on function public.api_get_auth_context(uuid) from public, anon, service_role;
    grant execute on function public.api_get_auth_context(uuid) to authenticated;
  `
});
const SYNTHETIC_0204 = Object.freeze({
  version: '20260823100000',
  sql: `
    do $creator_guard$
    begin
      if current_user <> 'postgres' or session_user <> 'postgres' then
        raise exception 'APPLICATION_ROUTINE_CREATOR_ROLE_MISMATCH';
      end if;
    end
    $creator_guard$;
    alter default privileges for role postgres revoke execute on functions from public;
    alter default privileges for role postgres in schema public, app, app_api
      revoke execute on functions from public, anon, authenticated, service_role;
  `
});

function managedCatalogEvidence() {
  const schemaOwners = {
    auth: 'supabase_admin',
    extensions: 'postgres',
    graphql: 'supabase_admin',
    graphql_public: 'supabase_admin',
    public: 'pg_database_owner',
    realtime: 'supabase_admin',
    storage: 'supabase_admin',
    vault: 'supabase_admin'
  };
  return {
    transaction: {
      transaction_read_only: 'on',
      role_name: 'postgres',
      rolsuper: false,
      member_supabase_admin: false,
      member_auth_admin: false,
      member_storage_admin: false,
      member_realtime_admin: false,
      can_set_replication_role: false,
      auth_schema_usage: true,
      auth_users_dml: true,
      auth_identities_dml: true
    },
    roles: [
      'anon', 'authenticated', 'authenticator', 'postgres', 'service_role',
      'supabase_admin', 'supabase_auth_admin', 'supabase_realtime_admin',
      'supabase_storage_admin', 'pg_database_owner'
    ].sort().map((role_name) => ({
      role_name,
      rolsuper: false,
      rolinherit: true,
      rolcreaterole: false,
      rolcreatedb: false,
      rolcanlogin: role_name === 'postgres',
      rolreplication: false,
      rolbypassrls: role_name === 'service_role',
      rolconfig: []
    })),
    schemas: Object.entries(schemaOwners).map(([schema_name, owner_role]) => ({ schema_name, owner_role })),
    authOwners: [{ owner_role: 'supabase_auth_admin' }],
    extensions: [
      { extension_name: 'pgcrypto', schema_name: 'extensions', owner_role: 'postgres', extension_version: '1.3' },
      { extension_name: 'uuid-ossp', schema_name: 'extensions', owner_role: 'postgres', extension_version: '1.1' }
    ],
    publications: [{
      publication_name: 'supabase_realtime', owner_role: 'postgres', all_tables: false,
      insert_enabled: true, update_enabled: true, delete_enabled: true,
      truncate_enabled: true, via_root: false
    }],
    publicationRelations: [],
    defaultAcls: REPOSITORY_APPLICATION_DEFAULT_ACL_INTENT.map((entry) => ({
      owner_role: entry.ownerRole,
      schema_name: entry.schemaName,
      object_type: entry.objectClass === 'table' ? 'r' : 'S',
      grantor_role: entry.grantorRole,
      grantee: entry.grantee,
      privilege_type: entry.privilege,
      is_grantable: entry.grantOption
    })),
    memberships: [],
    schemaAcls: [
      ...APPLICATION_FACING_ROLES.map((grantee) => ({
        schema_name: 'public', owner_role: 'pg_database_owner',
        grantor_role: 'pg_database_owner', grantee, privilege_type: 'USAGE',
        is_grantable: false
      })),
      {
        schema_name: 'public', owner_role: 'pg_database_owner',
        grantor_role: 'pg_database_owner', grantee: 'pg_database_owner',
        privilege_type: 'CREATE', is_grantable: true
      },
      {
        schema_name: 'public', owner_role: 'pg_database_owner',
        grantor_role: 'pg_database_owner', grantee: 'pg_database_owner',
        privilege_type: 'USAGE', is_grantable: true
      }
    ],
    managedObjects: [],
    managedObjectAcls: [],
    roleCapabilities: [
      'anon', 'authenticated', 'authenticator', 'postgres', 'service_role',
      'supabase_admin', 'supabase_auth_admin', 'supabase_realtime_admin',
      'supabase_storage_admin', 'pg_database_owner'
    ].sort().map((role_name) => ({
      role_name,
      public_usage: APPLICATION_FACING_ROLES.includes(role_name) || role_name === 'pg_database_owner',
      public_create: role_name === 'pg_database_owner',
      public_owner_member: role_name === 'pg_database_owner'
    }))
  };
}

function managedProfileProof(evidence = managedCatalogEvidence()) {
  const certificate = authenticateManagedProfileCertificate(buildManagedProfileCertificate({
    profileId: 'sandbox-current-managed-profile',
    target: MANAGED_PROFILE_TEST_TARGET,
    evidence: managedProfileEvidenceFromCatalog(evidence),
    securityPolicy: {
      format: MANAGED_PROFILE_SECURITY_POLICY_FORMAT,
      expectedPublicOwner: 'pg_database_owner',
      applicationFacingRoles: [...APPLICATION_FACING_ROLES],
      allowedApplicationPublicUsageRoles: [...APPLICATION_FACING_ROLES],
      allowedApplicationLoginRoles: [],
      allowedApplicationBypassRlsRoles: ['service_role'],
      allowedApplicationPrivilegePaths: [
        { source_role: 'service_role', target_role: 'service_role', capability: 'bypass_rls' }
      ],
      certifiedPrivilegedRoles: ['pg_database_owner', 'service_role']
    }
  }), MANAGED_PROFILE_TEST_KEY);
  return {
    certificate,
    key: MANAGED_PROFILE_TEST_KEY,
    target: MANAGED_PROFILE_TEST_TARGET,
    expectedProfileId: 'sandbox-current-managed-profile'
  };
}

function applicationDefaultAclProof(targetCatalog) {
  const certificate = authenticateApplicationDefaultAclManifest(
    buildRepositoryApplicationDefaultAclManifest({
      target: MANAGED_PROFILE_TEST_TARGET,
      managedProfile: {
        profileId: targetCatalog.profileId,
        profileDigest: targetCatalog.profileDigest
      },
      rows: targetCatalog.applicationDefaultAclEntries
    }),
    MANAGED_PROFILE_TEST_KEY
  );
  return verifyApplicationDefaultAclManifest({
    certificate,
    key: MANAGED_PROFILE_TEST_KEY,
    target: MANAGED_PROFILE_TEST_TARGET,
    managedProfile: {
      profileId: targetCatalog.profileId,
      profileDigest: targetCatalog.profileDigest
    },
    currentEntries: targetCatalog.applicationDefaultAclEntries
  });
}

test('generated restore SQL is fatal UTF-8 decoded and LF canonicalized', () => {
  assert.equal(normalizeGeneratedSql(Buffer.from('select 1;\r\nselect 2;\r\n')), 'select 1;\nselect 2;\n');
  assert.throws(
    () => normalizeGeneratedSql(Buffer.from([0xff])),
    /MANAGED_RESTORE_GENERATED_SQL_ENCODING_INVALID/
  );
  assert.equal(normalizeGeneratedSql(Buffer.from('select 1;\rselect 2;', 'utf8')), 'select 1;\rselect 2;');
  assert.equal(
    canonicalizePsqlRestrictionTokens('\\restrict first\nselect 1;\n\\unrestrict first\n'),
    '\\restrict <private-random-token>\nselect 1;\n\\unrestrict <private-random-token>\n'
  );
});

const SYNTHETIC_TOC = `;
1; 0 0 SCHEMA - app postgres
2; 0 0 ACL - SCHEMA app postgres
3; 0 0 SCHEMA - app_api postgres
4; 0 0 SCHEMA - auth supabase_admin
5; 0 0 ACL - SCHEMA auth supabase_admin
6; 0 0 SCHEMA - public pg_database_owner
7; 0 0 ACL - SCHEMA public pg_database_owner
8; 0 0 SCHEMA - supabase_migrations postgres
9; 1259 10 TABLE app boxes postgres
10; 0 10 TABLE DATA app boxes postgres
11; 1255 11 FUNCTION public api_list_boxes(uuid) postgres
12; 0 11 ACL public FUNCTION api_list_boxes(p_org_id uuid) postgres
13; 1259 12 TABLE auth users supabase_auth_admin
14; 0 12 TABLE DATA auth users supabase_auth_admin
15; 1259 13 TABLE auth identities supabase_auth_admin
16; 0 13 TABLE DATA auth identities supabase_auth_admin
17; 0 14 TABLE DATA auth sessions supabase_auth_admin
18; 0 15 TABLE DATA auth instances supabase_auth_admin
19; 0 16 DEFAULT ACL auth DEFAULT PRIVILEGES FOR TABLES supabase_auth_admin
20; 1259 17 TABLE supabase_migrations schema_migrations postgres
21; 0 17 TABLE DATA supabase_migrations schema_migrations postgres
22; 0 0 DEFAULT ACL public DEFAULT PRIVILEGES FOR TABLES supabase_admin
`;

function sourceComponent() {
  return {
    name: 'postgres-logical-custom-encrypted',
    size: 100,
    digest: `sha256:${'a'.repeat(64)}`
  };
}

function exactAuthShape() {
  const users = [...AUTH_USERS_COPY_COLUMNS];
  users.splice(users.indexOf('email_change_token_current'), 0, 'confirmed_at');
  const identities = [...AUTH_IDENTITIES_COPY_COLUMNS];
  identities.splice(identities.indexOf('id'), 0, 'email');
  return [
    ...identities.map((columnName, index) => ({
      table_name: 'identities',
      ordinal_position: index + 1,
      column_name: columnName,
      udt_name: columnName === 'user_id' || columnName === 'id' ? 'uuid' : 'text',
      is_nullable: ['provider_id', 'user_id', 'identity_data', 'provider', 'id'].includes(columnName) ? 'NO' : 'YES',
      is_generated: columnName === 'email' ? 'ALWAYS' : 'NEVER',
      generation_expression: columnName === 'email' ? "lower((identity_data ->> 'email'::text))" : null
    })),
    ...users.map((columnName, index) => ({
      table_name: 'users',
      ordinal_position: index + 1,
      column_name: columnName,
      udt_name: columnName === 'id' || columnName === 'instance_id' ? 'uuid' : 'text',
      is_nullable: ['id', 'is_sso_user', 'is_anonymous'].includes(columnName) ? 'NO' : 'YES',
      is_generated: columnName === 'confirmed_at' ? 'ALWAYS' : 'NEVER',
      generation_expression: columnName === 'confirmed_at'
        ? 'LEAST(email_confirmed_at, phone_confirmed_at)'
        : null
    }))
  ];
}

async function seedManagedSource(connectionString) {
  await withClient(connectionString, async (client) => {
    await client.query(`
      create schema auth authorization supabase_admin;
      create schema app authorization postgres;
      create schema app_api authorization postgres;
      create schema public authorization pg_database_owner;
      create schema supabase_migrations authorization postgres;
      create table auth.users (
        instance_id uuid, id uuid primary key, aud varchar(255), role varchar(255), email varchar(255) unique,
        encrypted_password varchar(255), email_confirmed_at timestamptz, invited_at timestamptz,
        confirmation_token varchar(255) not null default '', confirmation_sent_at timestamptz,
        recovery_token varchar(255) not null default '', recovery_sent_at timestamptz,
        email_change_token_new varchar(255) not null default '', email_change varchar(255) not null default '',
        email_change_sent_at timestamptz, last_sign_in_at timestamptz,
        raw_app_meta_data jsonb, raw_user_meta_data jsonb, is_super_admin boolean,
        created_at timestamptz not null, updated_at timestamptz not null, phone text,
        phone_confirmed_at timestamptz, phone_change text not null default '',
        phone_change_token varchar(255) not null default '', phone_change_sent_at timestamptz,
        confirmed_at timestamptz generated always as (least(email_confirmed_at, phone_confirmed_at)) stored,
        email_change_token_current varchar(255) not null default '',
        email_change_confirm_status smallint not null default 0, banned_until timestamptz,
        reauthentication_token varchar(255) not null default '', reauthentication_sent_at timestamptz,
        is_sso_user boolean not null default false, deleted_at timestamptz,
        is_anonymous boolean not null default false
      );
      create table auth.identities (
        provider_id text not null, user_id uuid not null references auth.users(id), identity_data jsonb not null,
        provider text not null, last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz,
        email text generated always as (lower(identity_data ->> 'email')) stored,
        id uuid primary key
      );
    `);
    for (const tableName of CURRENT_AUTH_TABLES.filter((name) => !['users', 'identities'].includes(name))) {
      await client.query(`create table auth."${tableName}" (id text primary key)`);
    }
    await client.query(`
      create table app.organization_members (
        id uuid primary key,
        org_id uuid not null,
        user_id uuid not null references auth.users(id),
        role text not null,
        status text not null
      );
      create function app_api.get_user_default_warehouse(p_org_id uuid, p_user_id uuid)
      returns uuid language sql stable
        as $$ select '55555555-5555-5555-5555-555555555555'::uuid $$;
      create function public.api_get_auth_context(p_org_id uuid)
      returns jsonb language sql stable security definer
      set search_path = public, app, app_api
        as $$ select pg_catalog.jsonb_build_object('accessStatus', 'legacy') $$;
      revoke execute on function public.api_get_auth_context(uuid) from public, anon, service_role;
      grant execute on function public.api_get_auth_context(uuid) to authenticated;
      create function app_api.member_count() returns bigint language sql stable
        as $$ select count(*) from app.organization_members $$;
      create function public.api_member_count() returns bigint language sql stable
        as $$ select app_api.member_count() $$;
      create table supabase_migrations.schema_migrations(version text primary key);
      insert into supabase_migrations.schema_migrations(version) values ('20260814210000');
      insert into auth.users(
        instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,confirmation_token,
        recovery_token,email_change_token_new,email_change,raw_app_meta_data,raw_user_meta_data,
        created_at,updated_at,phone,phone_change,phone_change_token,email_change_token_current,
        email_change_confirm_status,reauthentication_token,is_sso_user,is_anonymous
      ) values (
        '00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
        'authenticated','authenticated','synthetic@example.test','$2a$10$synthetic',now(),
        'confirmation','recovery','email-new','new@example.test',
        '{"provider":"email","providers":["email"],"locale":"pl-PL"}',
        '{"display":"Żółć Éclair 한국어"}',
        now(),now(),'+15555550100','pending','phone-token','email-current',0,'reauth',false,false
      );
      insert into auth.identities(provider_id,user_id,identity_data,provider,created_at,updated_at,id)
      values ('synthetic@example.test','11111111-1111-1111-1111-111111111111',
              '{"sub":"11111111-1111-1111-1111-111111111111","email":"synthetic@example.test"}',
              'email',now(),now(),'22222222-2222-2222-2222-222222222222');
      insert into auth.sessions(id) values ('synthetic-session');
      insert into auth.refresh_tokens(id) values ('synthetic-refresh');
      insert into app.organization_members values (
        '33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444',
        '11111111-1111-1111-1111-111111111111','admin','active'
      );
      grant usage on schema app, app_api to authenticated;
      grant select on app.organization_members to authenticated;
      revoke execute on function app_api.member_count() from public;
      revoke execute on function public.api_member_count() from public;
      grant execute on function public.api_member_count() to authenticated;
    `);
    for (const tableName of CURRENT_AUTH_TABLES) {
      await client.query(`alter table auth."${tableName}" owner to supabase_auth_admin`);
    }
    await client.query('grant usage on schema auth to postgres');
    await client.query('grant all privileges on all tables in schema auth to postgres');
  });
}

test('managed restore manifest classifies every reviewed object and produces exact lists', () => {
  const parsed = parsePgRestoreList(SYNTHETIC_TOC);
  assert.equal(parsed.length, 22);
  const manifest = buildManagedRestoreManifest({ tocText: SYNTHETIC_TOC, sourceComponent: sourceComponent() });
  assert.equal(verifyManagedRestoreManifest(manifest), true);
  assert.equal(manifest.categoryCounts[MANAGED_RESTORE_CATEGORIES.H], 0);
  assert.equal(manifest.categoryCounts[MANAGED_RESTORE_CATEGORIES.D], 2);
  assert.equal(authTransformEntries(manifest).length, 2);
  const appList = applicationRestoreList(SYNTHETIC_TOC, manifest);
  const schemaList = applicationSchemaRestoreList(SYNTHETIC_TOC, manifest);
  const contentList = applicationContentRestoreList(SYNTHETIC_TOC, manifest);
  assert.match(appList, /TABLE app boxes/);
  assert.match(appList, /FUNCTION public api_list_boxes/);
  assert.match(schemaList, /SCHEMA - app postgres/);
  assert.match(schemaList, /SCHEMA - app_api postgres/);
  assert.doesNotMatch(schemaList, /TABLE app boxes/);
  assert.doesNotMatch(contentList, /SCHEMA - app postgres/);
  assert.doesNotMatch(contentList, /SCHEMA - app_api postgres/);
  assert.match(contentList, /TABLE app boxes/);
  assert.doesNotMatch(appList, /SCHEMA - auth/);
  assert.doesNotMatch(appList, /TABLE DATA auth/);
  assert.doesNotMatch(appList, /supabase_migrations/);
  const migrationList = migrationRestoreList(SYNTHETIC_TOC, manifest);
  assert.match(migrationList, /SCHEMA - supabase_migrations/);
  assert.match(migrationList, /TABLE DATA supabase_migrations schema_migrations/);
  const resetSql = buildApplicationPlaneResetSql(manifest);
  assert.match(resetSql, /DROP SCHEMA IF EXISTS app_api CASCADE;/);
  assert.match(resetSql, /DROP FUNCTION IF EXISTS public\.api_list_boxes\(uuid\);/);
  assert.doesNotMatch(resetSql, /DROP SCHEMA IF EXISTS auth/);
  assert.equal(manifest.actionCounts.transform, 2);
  assert.equal(manifest.managedPlane.copiedAuthDefinitions, false);
  assert.equal(manifest.managedPlane.sessionReplicationRoleRequired, false);
});

test('managed restore manifest is deterministic and digest protected', () => {
  const left = buildManagedRestoreManifest({ tocText: SYNTHETIC_TOC, sourceComponent: sourceComponent() });
  const right = buildManagedRestoreManifest({ tocText: SYNTHETIC_TOC, sourceComponent: sourceComponent() });
  assert.deepEqual(left, right);
  const changed = structuredClone(left);
  changed.entries[0].reason = 'changed';
  assert.throws(() => verifyManagedRestoreManifest(changed), /MANAGED_RESTORE_MANIFEST_DIGEST_MISMATCH/);
});

test('all source default ACL entries remain target-native and never enter the restore list', () => {
  const toc = `${SYNTHETIC_TOC}23; 0 0 DEFAULT ACL app DEFAULT PRIVILEGES FOR FUNCTIONS postgres\n`;
  const manifest = buildManagedRestoreManifest({ tocText: toc, sourceComponent: sourceComponent() });
  const entry = manifest.entries.find((candidate) => candidate.dumpId === 23);
  assert.equal(entry.action, 'preserve-target-native');
  assert.equal(entry.category, MANAGED_RESTORE_CATEGORIES.F);
  assert.doesNotMatch(applicationRestoreList(toc, manifest), /DEFAULT ACL app/);
});

test('unknown public objects and managed-owned application objects fail closed', () => {
  const unknown = `${SYNTHETIC_TOC}23; 1259 22 TABLE public unreviewed postgres\n`;
  assert.throws(
    () => buildManagedRestoreManifest({ tocText: unknown, sourceComponent: sourceComponent() }),
    /MANAGED_RESTORE_UNKNOWN_OBJECT/
  );
  const wrongOwner = SYNTHETIC_TOC.replace('TABLE app boxes postgres', 'TABLE app boxes supabase_admin');
  assert.throws(
    () => buildManagedRestoreManifest({ tocText: wrongOwner, sourceComponent: sourceComponent() }),
    /MANAGED_RESTORE_UNKNOWN_OBJECT/
  );
});

test('Auth overlay requires byte-equivalent reviewed native shape and no user triggers', () => {
  const shape = exactAuthShape();
  const result = assertAuthOverlayCompatibility({ sourceColumns: shape, targetColumns: shape, targetTriggers: [] });
  assert.equal(result.compatible, true);
  assert.deepEqual(result.copiedTables, ['users', 'identities']);
  assert.deepEqual(result.generatedColumnsOmitted, [
    'auth.users.confirmed_at',
    'auth.identities.email'
  ]);
  const changed = structuredClone(shape);
  changed.find((column) => column.column_name === 'encrypted_password').udt_name = 'bytea';
  assert.throws(
    () => assertAuthOverlayCompatibility({ sourceColumns: shape, targetColumns: changed, targetTriggers: [] }),
    /MANAGED_AUTH_COLUMN_SHAPE_MISMATCH/
  );
  assert.throws(
    () => assertAuthOverlayCompatibility({ sourceColumns: shape, targetColumns: shape, targetTriggers: [{}] }),
    /MANAGED_AUTH_TRIGGER_SHAPE_UNREVIEWED/
  );
});

test('managed target proof requires native ownership and a read-only non-superuser executor', () => {
  const catalogEvidence = managedCatalogEvidence();
  const catalog = assertManagedTargetCatalogCompatibility(
    catalogEvidence,
    managedProfileProof(catalogEvidence)
  );
  const shape = exactAuthShape();
  const auth = assertAuthOverlayCompatibility({ sourceColumns: shape, targetColumns: shape, targetTriggers: [] });
  const manifest = buildManagedRestoreManifest({ tocText: SYNTHETIC_TOC, sourceComponent: sourceComponent() });
  const applicationReplacement = assertApplicationReplacementCompatibility(manifest, {
    schemas: [],
    publicRoutines: [],
    external: { foreign_keys: 0, views: 0, triggers: 0, policies: 0 }
  });
  const proof = assertManagedCompatibilityProof({
    authCompatibility: auth,
    targetCatalog: catalog,
    applicationReplacement,
    applicationDefaultAcl: applicationDefaultAclProof(catalog)
  });
  assert.equal(proof.transactionReadOnly, true);
  assert.equal(proof.catalogDigest, catalog.catalogDigest);
  assert.equal(proof.authShapeDigest, auth.targetDigest);
  assert.equal(proof.applicationReplacementDigest, applicationReplacement.replacementDigest);
  assert.equal(proof.applicationDefaultAclEntryCount, 6);

  const superuser = structuredClone(managedCatalogEvidence());
  superuser.transaction.rolsuper = true;
  assert.throws(
    () => assertManagedTargetCatalogCompatibility(superuser, managedProfileProof(superuser)),
    /MANAGED_TARGET_EXECUTION_ROLE_INCOMPATIBLE/
  );
  const wrongOwner = structuredClone(managedCatalogEvidence());
  wrongOwner.schemas.find((entry) => entry.schema_name === 'public').owner_role = 'postgres';
  assert.throws(
    () => assertManagedTargetCatalogCompatibility(wrongOwner, managedProfileProof()),
    /MANAGED_PROFILE_EVIDENCE_MISMATCH/
  );
  assert.throws(
    () => assertApplicationReplacementCompatibility(manifest, {
      schemas: [],
      publicRoutines: [],
      external: { foreign_keys: 1, views: 0, triggers: 0, policies: 0 }
    }),
    /MANAGED_APPLICATION_EXTERNAL_DEPENDENCY_REJECTED/
  );
});

test('Auth purge omits target-native instances and Auth migration history', () => {
  const sql = buildAuthOverlayPurgeSql();
  assert.match(sql, /delete from auth\."sessions";/);
  assert.match(sql, /delete from auth\.identities;/);
  assert.match(sql, /delete from auth\.users;/);
  assert.doesNotMatch(sql, /delete from auth\.instances/);
  assert.doesNotMatch(sql, /delete from auth\.schema_migrations/);
});

test('exact Y2 Auth recovery is authenticated, fixed-table, target-bound, and restores preserved rows', () => {
  const key = crypto.randomBytes(32);
  const digest = `sha256:${crypto.createHash('sha256').update('').digest('hex')}`;
  const evidence = {
    format: 'dev-y2-exact-auth-evidence-v1',
    algorithm: 'sha256',
    serialization: 'postgres-jsonb-text-lf-bytewise-utf8-v1',
    tables: CURRENT_AUTH_TABLES.map((tableName) => ({ tableName, count: 0, digest }))
  };
  const binding = {
    attemptId: 'dev-y2-attempt-synthetic',
    target: { environment: 'dev', projectRef: 'd'.repeat(20) },
    sourceComponentDigest: `sha256:${'1'.repeat(64)}`,
    migration: { count: 188, tip: '20260824100000' }
  };
  try {
    const authority = buildExactAuthRecoveryAuthority({ ...binding, evidence }, key);
    assert.equal(verifyExactAuthRecoveryAuthority(authority, key, binding), authority);
    const tampered = structuredClone(authority);
    tampered.authEvidence.tables[0].count = 1;
    assert.throws(
      () => verifyExactAuthRecoveryAuthority(tampered, key, binding),
      /Manifest authentication failed/
    );
    assert.throws(
      () => verifyExactAuthRecoveryAuthority(authority, key, {
        ...binding,
        target: { environment: 'dev', projectRef: 'e'.repeat(20) }
      }),
      /DEV_Y2_AUTH_RECOVERY_AUTHORITY_MISMATCH/
    );
    const purge = buildAuthOverlayPurgeSql({ exactRecovery: true });
    assert.match(purge, /delete from auth\.instances;/);
    assert.match(purge, /delete from auth\.schema_migrations;/);
    const sql = buildManagedOverlaySql({
      applicationResetSql: 'DROP SCHEMA IF EXISTS app_api CASCADE;\nDROP SCHEMA IF EXISTS app CASCADE;',
      applicationSchemaSql: 'CREATE SCHEMA app;\nCREATE SCHEMA app_api;',
      applicationDefaultAclPreservationSql:
        'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA app GRANT SELECT ON TABLES TO service_role;',
      applicationPreDataSql: 'CREATE TABLE app.boxes(id bigint);',
      applicationDataSql: 'INSERT INTO app.boxes VALUES (1);',
      applicationPostDataSql: 'GRANT USAGE ON SCHEMA app TO authenticated;',
      applicationAclConvergenceSql: 'DO $$ BEGIN NULL; END $$;',
      applicationDefaultAclVerificationSql: 'DO $$ BEGIN NULL; END $$;',
      authRecoverySql: "INSERT INTO auth.users (email) VALUES ('synthetic@users.invalid');",
      migrationSql: "CREATE TABLE supabase_migrations.schema_migrations(version text);\nINSERT INTO supabase_migrations.schema_migrations VALUES ('20260824100000');",
      authEvidence: {},
      migration: binding.migration,
      authMode: 'exact-dev-y2-recovery',
      authRecoveryAuthority: authority
    });
    assert.match(sql, /MANAGED_OVERLAY_STAGE_AUTH_EXACT_RECOVERY/);
    assert.match(sql, /DEV_Y2_AUTH_RECOVERY_POSTCHECK_MISMATCH/);
    assert.doesNotMatch(sql, /MANAGED_AUTH_QUARANTINE_MISMATCH/);
    assert.throws(
      () => buildManagedOverlaySql({
        applicationResetSql: 'DROP SCHEMA IF EXISTS app_api CASCADE;\nDROP SCHEMA IF EXISTS app CASCADE;',
        applicationSchemaSql: 'CREATE SCHEMA app;\nCREATE SCHEMA app_api;',
        applicationDefaultAclPreservationSql: 'DO $$ BEGIN NULL; END $$;',
        applicationPreDataSql: 'CREATE TABLE app.boxes(id bigint);',
        applicationDataSql: 'INSERT INTO app.boxes VALUES (1);',
        applicationPostDataSql: 'GRANT USAGE ON SCHEMA app TO authenticated;',
        applicationAclConvergenceSql: 'DO $$ BEGIN NULL; END $$;',
        applicationDefaultAclVerificationSql: 'DO $$ BEGIN NULL; END $$;',
        authRecoverySql: 'UPDATE auth.users SET email = email;',
        migrationSql: "CREATE TABLE supabase_migrations.schema_migrations(version text);\nINSERT INTO supabase_migrations.schema_migrations VALUES ('20260824100000');",
        authEvidence: {}, migration: binding.migration,
        authMode: 'exact-dev-y2-recovery', authRecoveryAuthority: authority
      }),
      /DEV_Y2_AUTH_RECOVERY_DATA_CHUNK_REJECTED/
    );
  } finally {
    key.fill(0);
  }
});

test('remediation preserve-Auth mode emits no Auth DML and bounds only native-Smoke volatility', () => {
  const key = crypto.randomBytes(32);
  const digest = `sha256:${crypto.createHash('sha256').update('').digest('hex')}`;
  const evidence = {
    format: 'dev-y2-exact-auth-evidence-v1',
    algorithm: 'sha256',
    serialization: 'postgres-jsonb-text-lf-bytewise-utf8-v1',
    tables: CURRENT_AUTH_TABLES.map((tableName) => ({ tableName, count: 0, digest }))
  };
  const binding = {
    attemptId: 'dev-remediation-preserve-auth-synthetic',
    target: { environment: 'dev', projectRef: 'd'.repeat(20) },
    sourceComponentDigest: `sha256:${'2'.repeat(64)}`,
    migration: { count: 188, tip: '20260824100000' }
  };
  try {
    const authority = buildAuthPreservationAuthority({ ...binding, evidence }, key);
    assert.equal(verifyAuthPreservationAuthority(authority, key, binding), authority);
    const sql = buildManagedOverlaySql({
      applicationResetSql: 'DROP SCHEMA IF EXISTS app_api CASCADE;\nDROP SCHEMA IF EXISTS app CASCADE;',
      applicationSchemaSql: 'CREATE SCHEMA app;\nCREATE SCHEMA app_api;',
      applicationDefaultAclPreservationSql: 'DO $$ BEGIN NULL; END $$;',
      applicationPreDataSql: 'CREATE TABLE app.boxes(id bigint);',
      applicationDataSql: 'INSERT INTO app.boxes VALUES (1);',
      applicationPostDataSql: 'GRANT USAGE ON SCHEMA app TO authenticated;',
      applicationAclConvergenceSql: 'DO $$ BEGIN NULL; END $$;',
      applicationDefaultAclVerificationSql: 'DO $$ BEGIN NULL; END $$;',
      migrationSql: "CREATE TABLE supabase_migrations.schema_migrations(version text);\nINSERT INTO supabase_migrations.schema_migrations VALUES ('20260824100000');",
      authEvidence: {},
      migration: binding.migration,
      authMode: 'preserve-target-native-auth',
      authRecoveryAuthority: authority
    });
    assert.match(sql, /MANAGED_OVERLAY_STAGE_AUTH_PRESERVED/);
    assert.match(sql, /managed_auth_preserved/);
    assert.equal(
      (sql.match(/DEV_Y2_AUTH_RECOVERY_POSTCHECK_MISMATCH/g) || []).length,
      CURRENT_AUTH_TABLES.length - 4
    );
    assert.equal((sql.match(/DEV_REMEDIATION_AUTH_PRESERVATION_COUNT_MISMATCH/g) || []).length, 2);
    assert.equal((sql.match(/DEV_REMEDIATION_AUTH_PRESERVATION_EPHEMERA_MISMATCH/g) || []).length, 2);
    assert.match(sql, /v_auth_count > 1/);
    assert.doesNotMatch(sql, /(?:delete from|insert into|update|truncate) auth\./i);
  } finally {
    key.fill(0);
  }
});

test('managed overlay SQL orders app pre-data, quarantined Auth, data, ledger, and post-data atomically', () => {
  const sql = buildManagedOverlaySql({
    applicationResetSql: 'DROP SCHEMA IF EXISTS app_api CASCADE;\nDROP SCHEMA IF EXISTS app CASCADE;',
    applicationSchemaSql: 'CREATE SCHEMA app;\nCREATE SCHEMA app_api;',
    applicationDefaultAclPreservationSql:
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA app GRANT SELECT ON TABLES TO service_role;',
    applicationPreDataSql: 'CREATE TABLE app.boxes(id bigint);',
    applicationDataSql: "INSERT INTO app.boxes VALUES ('safe');",
    applicationPostDataSql: 'GRANT USAGE ON SCHEMA app TO authenticated;',
    applicationAclConvergenceSql: 'DO $$ BEGIN NULL; END $$;',
    applicationDefaultAclVerificationSql: 'DO $$ BEGIN NULL; END $$;',
    authUsersSql: "INSERT INTO auth.users (email) VALUES ('np-safe@users.invalid');",
    authIdentitiesSql: "INSERT INTO auth.identities (provider_id) VALUES ('np-safe@users.invalid');",
    migrationSql: "CREATE SCHEMA supabase_migrations;\nCREATE TABLE supabase_migrations.schema_migrations(version text);\nINSERT INTO supabase_migrations.schema_migrations VALUES ('20260814210000');",
    authEvidence: { users: 1, identities: 1 },
    migration: { count: 1, tip: '20260814210000' }
  });
  assert.match(sql, /^\\set ON_ERROR_STOP on\nBEGIN ISOLATION LEVEL SERIALIZABLE;/);
  assert.ok(sql.indexOf('DROP SCHEMA IF EXISTS app CASCADE') < sql.indexOf('CREATE SCHEMA app;'));
  assert.doesNotMatch(sql, /DROP SCHEMA(?: IF EXISTS)? public\b/i);
  assert.doesNotMatch(sql, /CREATE SCHEMA public\b/i);
  assert.doesNotMatch(sql, /ALTER SCHEMA public OWNER\b/i);
  assert.match(sql, /ALTER DEFAULT PRIVILEGES\b/i);
  assert.ok(sql.indexOf('CREATE SCHEMA app;') < sql.indexOf('ALTER DEFAULT PRIVILEGES'));
  assert.ok(sql.indexOf('ALTER DEFAULT PRIVILEGES') < sql.indexOf('CREATE TABLE app.boxes'));
  assert.ok(sql.indexOf('CREATE SCHEMA app;') < sql.indexOf('delete from auth.users;'));
  assert.ok(sql.indexOf('delete from auth.users;') < sql.indexOf('INSERT INTO auth.users'));
  assert.ok(sql.indexOf('INSERT INTO auth.identities') < sql.indexOf('INSERT INTO app.boxes'));
  assert.ok(sql.indexOf('INSERT INTO app.boxes') < sql.indexOf('CREATE SCHEMA supabase_migrations'));
  assert.ok(sql.indexOf('CREATE SCHEMA supabase_migrations') < sql.indexOf('GRANT USAGE ON SCHEMA app'));
  assert.ok(sql.indexOf('GRANT USAGE ON SCHEMA app') < sql.indexOf('MANAGED_OVERLAY_STAGE_APPLICATION_ACL_CONVERGENCE'));
  assert.match(sql, /MANAGED_AUTH_EPHEMERA_NOT_EMPTY/);
  assert.match(sql, /COMMIT;\n$/);
  assert.doesNotMatch(sql, /session_replication_role/);
});

test('managed overlay SQL rejects managed-plane DDL and role statements', () => {
  const base = {
    applicationResetSql: 'DROP SCHEMA IF EXISTS app_api CASCADE;\nDROP SCHEMA IF EXISTS app CASCADE;',
    applicationSchemaSql: 'CREATE SCHEMA app;\nCREATE SCHEMA app_api;',
    applicationDefaultAclPreservationSql:
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA app GRANT SELECT ON TABLES TO service_role;',
    applicationPreDataSql: 'CREATE SCHEMA app;',
    applicationDataSql: 'INSERT INTO app.boxes VALUES (1);',
    applicationPostDataSql: 'GRANT USAGE ON SCHEMA app TO authenticated;',
    applicationAclConvergenceSql: 'DO $$ BEGIN NULL; END $$;',
    applicationDefaultAclVerificationSql: 'DO $$ BEGIN NULL; END $$;',
    authUsersSql: "INSERT INTO auth.users (email) VALUES ('np-safe@users.invalid');",
    authIdentitiesSql: "INSERT INTO auth.identities (provider_id) VALUES ('np-safe@users.invalid');",
    migrationSql: "CREATE TABLE supabase_migrations.schema_migrations(version text);\nINSERT INTO supabase_migrations.schema_migrations VALUES ('20260814210000');",
    authEvidence: { users: 1, identities: 1 },
    migration: { count: 1, tip: '20260814210000' }
  };
  assert.throws(
    () => buildManagedOverlaySql({ ...base, applicationPreDataSql: 'DROP TABLE auth.users;' }),
    /MANAGED_RESTORE_MANAGED_PLANE_MUTATION_REJECTED/
  );
  assert.throws(
    () => buildManagedOverlaySql({ ...base, applicationPostDataSql: 'GRANT postgres TO cli_login_postgres;' }),
    /MANAGED_RESTORE_ROLE_STATEMENT_REJECTED/
  );
});

test('overlay execution target guard rejects PROD and accepts only proven nonproduction or loopback', () => {
  assert.deepEqual(
    assertOverlayExecutionGuard('postgresql://postgres:local@127.0.0.1:5432/postgres?sslmode=disable', {
      mode: 'disposable-managed-local',
      loopback: true
    }),
    { target: 'local', projectRef: '', loopback: true }
  );
  const sandboxRef = 'sandboxprojectref1234';
  const accepted = assertOverlayExecutionGuard(
    `postgresql://postgres:synthetic@db.${sandboxRef}.supabase.co:5432/postgres?sslmode=require`,
    {
      target: 'sandbox',
      projectRef: sandboxRef,
      mutationGuardPassed: true,
      projectRefMatched: true
    }
  );
  assert.equal(accepted.target, 'sandbox');
  assert.throws(
    () => assertOverlayExecutionGuard(
      'postgresql://postgres:synthetic@db.tiwpulgvxtwlmqdnyuzd.supabase.co:5432/postgres?sslmode=require',
      {
        target: 'sandbox',
        projectRef: 'tiwpulgvxtwlmqdnyuzd',
        mutationGuardPassed: true,
        projectRefMatched: true
      }
    ),
    /MANAGED_OVERLAY_TARGET_GUARD_REJECTED/
  );
});

test('managed-like PostgreSQL proves 0203/0204 cutover and exact pre-0204 Y2 recovery on both profiles', { timeout: 240_000 }, async (t) => {
  let tools;
  try {
    tools = resolvePostgresTools();
  } catch {
    t.skip('PostgreSQL 18 server tooling is unavailable.');
    return;
  }
  const token = crypto.randomBytes(8).toString('hex');
  const sourceRoot = path.join(os.tmpdir(), `environment-sync-rehearsal-managed-source-${token}`);
  let sourceCluster;
  let archiveBytes;
  try {
    sourceCluster = await startDisposablePostgres({ rootDirectory: sourceRoot });
    const sourceConnection = await prepareRestoreDatabase(
      sourceCluster,
      `x_rehearsal_dev_source_${token}`
    );
    await seedManagedSource(sourceConnection);
    archiveBytes = execFileSync(
      tools.pgDump,
      [
        '--format=custom',
        '--schema=app', '--schema=app_api', '--schema=auth', '--schema=public',
        '--schema=supabase_migrations',
        '--dbname', new URL(sourceConnection).pathname.slice(1)
      ],
      {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: postgresChildEnvironment(sourceConnection),
        maxBuffer: 64 * 1024 * 1024
      }
    );
    const archivePath = path.join(sourceRoot, 'synthetic-managed-source.pgdump');
    writePrivateBytesExclusive(archivePath, archiveBytes);
    let result;
    try {
      result = await runManagedRestoreCompatibilityRehearsal({
        archivePath,
        sourceComponent: {
          name: 'postgres-logical-custom-encrypted',
          size: archiveBytes.length,
          digest: `sha256:${crypto.createHash('sha256').update(archiveBytes).digest('hex')}`
        },
        postOverlayMigrations: [SYNTHETIC_0203, SYNTHETIC_0204],
        routineDefaultProfiles: {
          sandbox: 'pre0204-sandbox',
          dev: 'pre0204-dev'
        },
        rehearsePre0204Recovery: true,
        postgresBin: tools.bin
      });
    } catch (error) {
      assert.fail(JSON.stringify({
        code: error?.code || 'MANAGED_REHEARSAL_FAILED',
        stage: error?.rehearsalStage || 'unclassified-stage',
        classification: error?.safeDiagnostic?.classification || 'unclassified-diagnostic',
        statementCategory: error?.safeDiagnostic?.statementCategory || 'unclassified-statement',
        excerpt: String(error?.safeDiagnostic?.excerpt || '').split(/\r?\n/).filter(Boolean).slice(0, 3)
      }));
    }
    assert.equal(result.classification, 'MANAGED_OVERLAY_REHEARSAL_PASSED');
    assert.equal(result.oldMethod.classification, 'POSTGRES_MANAGED_OWNERSHIP_REJECTED');
    assert.equal(result.oldMethod.atomicRollback, true);
    assert.equal(result.oldMethod.applicationDefaultAclLossReproduced, true);
    assert.equal(result.oldMethod.applicationDefaultAclBeforeCount, 6);
    assert.equal(result.oldMethod.applicationDefaultAclAfterReplacementCount, 0);
    assert.equal(result.targets.mockSandboxManaged.applicationParity, true);
    assert.equal(result.targets.mockDevManaged.populatedApplicationPlaneReplaced, true);
    assert.equal(result.targets.mockDevManaged.populatedPackageByteEquivalent, true);
    assert.equal(result.auth.sessions, 0);
    assert.equal(result.auth.refreshTokens, 0);
    assert.equal(result.manifest.unknownCount, 0);
    assert.equal(result.targetCatalog.distinctAuthenticatedProfiles, true);
    assert.equal(result.targetCatalog.sandboxPublicOwnerPreserved, true);
    assert.equal(result.targetCatalog.devPublicOwnerPreserved, true);
    assert.equal(result.targetCatalog.defaultAclsPreserved, true);
    assert.equal(result.targetCatalog.applicationDefaultAclsPreserved, true);
    assert.equal(result.targetCatalog.membershipsPreserved, true);
    assert.equal(result.futureObjectProbes.dev.applicationExact, true);
    assert.equal(result.futureObjectProbes.dev.tableGrantCount, 4);
    assert.equal(result.futureObjectProbes.dev.sequenceGrantCount, 2);
    assert.equal(result.futureObjectProbes.dev.totalApplicationGrantCount, 6);
    assert.equal(result.futureObjectProbes.dev.publicFunctionDenied, true);
    assert.equal(result.futureObjectProbes.dev.anonFunctionDenied, true);
    assert.equal(result.futureObjectProbes.dev.authenticatedFunctionDenied, true);
    assert.equal(result.futureObjectProbes.dev.serviceRoleFunctionDenied, true);
    assert.equal(result.futureObjectProbes.dev.ownerFunctionAllowed, true);
    assert.equal(result.futureObjectProbes.dev.functionExact, true);
    assert.equal(result.futureObjectProbes.sandbox.applicationExact, true);
    assert.equal(result.futureObjectProbes.sandbox.totalApplicationGrantCount, 12);
    assert.equal(result.recovery.destructiveSecondOverlayRestoredApplicationDefaults, true);
    assert.equal(result.recovery.futureObjectSemanticsRestored, true);
    assert.equal(result.recovery.pre0204.forcedPostCommitFailureObserved, true);
    assert.equal(result.recovery.pre0204.pre0204RoutineDefaultsRestored, true);
    assert.equal(result.recovery.pre0204.managedFingerprintRestored, true);
    assert.equal(result.recovery.pre0204.applicationPlaneRestored, true);
    assert.equal(result.recovery.pre0204.authPlaneRestored, true);
    assert.equal(result.recovery.pre0204.migrationStateRestored, true);
    assert.equal(result.recovery.pre0204.futureObjectSemanticsRestored, true);
    assert.equal(result.recovery.pre0204.futureObjectProbe.functionExact, true);
    assert.equal(result.recovery.pre0204.futureObjectProbe.publicFunctionDenied, false);
    assert.equal(result.postOverlayMigration.appliedToAllTargets, true);
    assert.deepEqual(result.postOverlayMigration.versions, ['20260822100000', '20260823100000']);
    assert.equal(result.postOverlayMigration.contractProof.migration0204.allTargetsHardened, true);
    assert.equal(result.routineDefaultProfiles.hardenedBy0204, true);
    assert.equal(result.diagnosticResidue, 0);
  } finally {
    archiveBytes?.fill(0);
    if (sourceCluster) await removeDisposablePostgres(sourceCluster);
  }
});

test('source materialization restores owner-bearing archives with disposable bootstrap authority', { timeout: 120_000 }, async (t) => {
  let tools;
  try {
    tools = resolvePostgresTools();
  } catch {
    t.skip('PostgreSQL 18 server tooling is unavailable.');
    return;
  }
  const token = crypto.randomBytes(8).toString('hex');
  const root = path.join(os.tmpdir(), `environment-sync-rehearsal-managed-source-${token}`);
  let cluster;
  let archiveBytes;
  try {
    cluster = await startDisposablePostgres({
      rootDirectory: root,
      postgresBin: tools.bin,
      bootstrapUser: 'cluster_admin'
    });
    const base = new URL(cluster.connectionString());
    const password = decodeURIComponent(base.password);
    assert.match(password, /^[0-9a-f]{64}$/);
    await withClient(cluster.connectionString(), async (client) => {
      await client.query(
        `create role postgres login nosuperuser createrole createdb replication bypassrls password '${password}'`
      );
      await client.query('create role supabase_admin nologin superuser');
      await client.query(`create database "x_rehearsal_dev_source_${token}" owner postgres`);
      await client.query(`create database "x_rehearsal_dev_restored_${token}" owner postgres`);
      await client.query(`create database "x_rehearsal_dev_rejected_${token}" owner postgres`);
    });
    const source = new URL(cluster.connectionString());
    source.pathname = `/x_rehearsal_dev_source_${token}`;
    await withClient(source.toString(), async (client) => {
      await client.query('create schema auth authorization supabase_admin');
      await client.query('create table auth.restore_authority_probe(id bigint)');
      await client.query('alter table auth.restore_authority_probe owner to supabase_admin');
    });
    archiveBytes = execFileSync(
      tools.pgDump,
      ['--format=custom', '--schema=auth', '--dbname', `x_rehearsal_dev_source_${token}`],
      {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: postgresChildEnvironment(source.toString()),
        maxBuffer: 16 * 1024 * 1024
      }
    );
    const archivePath = path.join(root, 'owner-bearing-source.private.pgdump');
    const diagnosticDirectory = path.join(root, 'source-restore-diagnostics');
    writePrivateBytesExclusive(archivePath, archiveBytes);
    createPrivateDirectory(diagnosticDirectory);

    const restored = new URL(cluster.connectionString());
    restored.pathname = `/x_rehearsal_dev_restored_${token}`;
    await restoreSource({
      tools,
      archivePath,
      connectionString: restored.toString(),
      diagnosticDirectory
    });
    const restoredOwner = await withClient(restored.toString(), async (client) => {
      const result = await client.query(
        `select pg_catalog.pg_get_userbyid(c.relowner) as owner
           from pg_catalog.pg_class c
           join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'auth' and c.relname = 'restore_authority_probe'`
      );
      return result.rows[0]?.owner;
    });
    assert.equal(restoredOwner, 'supabase_admin');

    const rejected = new URL(cluster.connectionString());
    rejected.pathname = `/x_rehearsal_dev_rejected_${token}`;
    rejected.username = 'postgres';
    await assert.rejects(
      restoreSource({
        tools,
        archivePath,
        connectionString: rejected.toString(),
        diagnosticDirectory
      }),
      /MANAGED_REHEARSAL_SOURCE_RESTORE_AUTHORITY_INVALID/
    );
  } finally {
    archiveBytes?.fill(0);
    if (cluster) await removeDisposablePostgres(cluster);
  }
});

test('PostgreSQL diagnostics redact credentials while preserving useful managed-ownership context', () => {
  const result = sanitizePostgresDiagnostic(
    'pg_restore: error: postgresql://user:private@db.abcdefghijklmnopqrst.supabase.co/postgres\n' +
    'ERROR: must be owner of table users\npassword=private Bearer token.value.parts\n' +
    'Command was: ALTER TABLE auth.users DROP CONSTRAINT users_pkey;'
  );
  assert.equal(result.classification, 'POSTGRES_MANAGED_OWNERSHIP_REJECTED');
  assert.equal(result.sqlState, '42501');
  assert.match(result.excerpt, /must be owner of table users/);
  assert.doesNotMatch(result.excerpt, /private|abcdefghijklmnopqrst|token\.value/);
  assert.doesNotMatch(result.excerpt, /Command was:/);

  const noisy = sanitizePostgresDiagnostic(
    `${Array.from({ length: 40 }, () => 'SET').join('\n')}\n` +
    'psql:C:/private/rehearsal/managed-overlay.sql:25: ERROR: must be owner of schema app\n' +
    'psql:/tmp/private/rehearsal/managed-overlay.sql:25: ERROR: permission denied for schema auth'
  );
  assert.equal(noisy.classification, 'POSTGRES_MANAGED_OWNERSHIP_REJECTED');
  assert.match(noisy.excerpt.split('\n')[0], /must be owner of schema app/);
  assert.doesNotMatch(noisy.excerpt, /C:\/private|rehearsal/);
  assert.doesNotMatch(noisy.excerpt, /\/tmp\/private/);
});

test('private diagnostic command retains raw bytes only during failure classification and removes them', async () => {
  const root = path.join(os.tmpdir(), `environment-sync-diagnostic-${crypto.randomBytes(12).toString('hex')}`);
  createPrivateDirectory(root);
  let callbackObserved = false;
  try {
    await assert.rejects(
      runPrivateDiagnosticCommand({
        executable: process.execPath,
        args: ['-e', "process.stderr.write('ERROR: must be owner of table users\\npassword=private');process.exit(3)"],
        env: {
          SystemRoot: process.env.SystemRoot || '',
          WINDIR: process.env.WINDIR || '',
          PATH: process.env.PATH || ''
        },
        diagnosticDirectory: root,
        failureCode: 'SYNTHETIC_RESTORE_FAILED',
        onFailureDiagnostic: ({ artifactPath, safeDiagnostic }) => {
          callbackObserved = true;
          assert.equal(verifyPrivateArtifactProtection(artifactPath).ownerOnly, true);
          assert.equal(safeDiagnostic.classification, 'POSTGRES_MANAGED_OWNERSHIP_REJECTED');
          assert.equal(safeDiagnostic.exitCode, 3);
          assert.equal(safeDiagnostic.signal, '');
          assert.equal(safeDiagnostic.overflow, false);
          assert.doesNotMatch(safeDiagnostic.excerpt, /private/);
        }
      }),
      (error) => {
        assert.equal(error.code, 'SYNTHETIC_RESTORE_FAILED');
        assert.equal(error.safeDiagnostic.classification, 'POSTGRES_MANAGED_OWNERSHIP_REJECTED');
        assert.equal(error.safeDiagnostic.exitCode, 3);
        assert.equal(error.safeDiagnostic.signal, '');
        assert.equal(error.safeDiagnostic.overflow, false);
        return true;
      }
    );
    assert.equal(callbackObserved, true);
    assert.deepEqual(fs.readdirSync(root), []);

    const success = await runPrivateDiagnosticCommand({
      executable: process.execPath,
      args: ['-e', "process.stdout.write('ok')"],
      env: {
        SystemRoot: process.env.SystemRoot || '',
        WINDIR: process.env.WINDIR || '',
        PATH: process.env.PATH || ''
      },
      diagnosticDirectory: root
    });
    assert.equal(success.ok, true);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
