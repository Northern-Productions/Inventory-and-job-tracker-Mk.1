import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  APPLICATION_DEFAULT_ACL_CLASSIFICATIONS,
  APPLICATION_DEFAULT_ACL_SOURCE_0103,
  MANAGED_AUTHENTICATED_APPLICATION_DEFAULT_ACL_INTENT,
  REPOSITORY_APPLICATION_DEFAULT_ACL_INTENT,
  authenticateApplicationDefaultAclManifest,
  assertHardenedApplicationRoutineDefaultProfile,
  buildApplicationDefaultAclPreservationManifest,
  buildApplicationDefaultAclPreservationSql,
  buildApplicationRoutineDefaultRecoverySql,
  buildProfileApplicationDefaultAclManifest,
  buildRepositoryApplicationDefaultAclManifest,
  captureApplicationDefaultAclEntries,
  captureApplicationRoutineDefaultProfile,
  captureFuturePublicFunctionDefaultSecurity,
  normalizeRoutineDefaultProfile,
  verifyApplicationDefaultAclManifest
} from './application-default-acl-preservation.mjs';
import {
  removeDisposablePostgres,
  resolvePostgresTools,
  startDisposablePostgres,
  withClient
} from './disposable-postgres.mjs';

const KEY = Buffer.from('application-default-acl-test-key-material-000000000000000000000000');
const TARGET = Object.freeze({ environment: 'dev', projectRef: 'd'.repeat(20) });
const PROFILE = Object.freeze({
  profileId: 'dev-historical-managed-profile',
  profileDigest: `sha256:${'1'.repeat(64)}`
});

function currentRows() {
  return REPOSITORY_APPLICATION_DEFAULT_ACL_INTENT.map((entry) => ({ ...entry }));
}

function classifiedRows(rows = currentRows()) {
  return rows.map((entry) => ({
    ...entry,
    classification: APPLICATION_DEFAULT_ACL_CLASSIFICATIONS.A,
    sourceEvidence: APPLICATION_DEFAULT_ACL_SOURCE_0103
  }));
}

function certificateFor(rows = currentRows(), target = TARGET, profile = PROFILE) {
  return authenticateApplicationDefaultAclManifest(
    buildRepositoryApplicationDefaultAclManifest({ target, managedProfile: profile, rows }),
    KEY
  );
}

test('repository application default ACL manifest binds exact semantic intent rather than a row count', () => {
  const certificate = certificateFor();
  const verified = verifyApplicationDefaultAclManifest({
    certificate,
    key: KEY,
    target: TARGET,
    managedProfile: PROFILE,
    currentEntries: currentRows()
  });
  assert.equal(verified.authenticated, true);
  assert.equal(verified.entryCount, 6);
  assert.equal(verified.beforeDigest, verified.expectedAfterDigest);
  assert.equal(verified.certificate.unknownCount, 0);
  assert.equal(verified.certificate.strategy, 'authenticated-capture-reapply-before-object-creation');
  assert.deepEqual(
    verified.certificate.entries.map((entry) => [entry.objectClass, entry.privilege]),
    [
      ['sequence', 'SELECT'], ['sequence', 'USAGE'],
      ['table', 'DELETE'], ['table', 'INSERT'], ['table', 'SELECT'], ['table', 'UPDATE']
    ]
  );
});

test('application default ACL manifest is deterministic, authenticated, and profile-bound', () => {
  const left = certificateFor();
  const right = certificateFor([...currentRows()].reverse());
  assert.deepEqual(left, right);

  const tampered = structuredClone(left);
  tampered.entries[0].privilege = 'UPDATE';
  assert.throws(
    () => verifyApplicationDefaultAclManifest({
      certificate: tampered,
      key: KEY,
      target: TARGET,
      managedProfile: PROFILE,
      currentEntries: currentRows()
    }),
    /APPLICATION_DEFAULT_ACL_AUTHENTICATION_FAILED/
  );
  assert.throws(
    () => verifyApplicationDefaultAclManifest({
      certificate: left,
      key: KEY,
      target: { environment: 'sandbox', projectRef: 's'.repeat(20) },
      managedProfile: PROFILE,
      currentEntries: currentRows()
    }),
    /APPLICATION_DEFAULT_ACL_TARGET_MISMATCH/
  );
  assert.throws(
    () => verifyApplicationDefaultAclManifest({
      certificate: left,
      key: KEY,
      target: TARGET,
      managedProfile: { ...PROFILE, profileId: 'sandbox-current-managed-profile' },
      currentEntries: currentRows()
    }),
    /APPLICATION_DEFAULT_ACL_MANAGED_PROFILE_MISMATCH/
  );
});

test('application default ACL source correlation fails on missing, unexpected, or unknown semantics', () => {
  assert.throws(
    () => buildRepositoryApplicationDefaultAclManifest({
      target: TARGET,
      managedProfile: PROFILE,
      rows: currentRows().slice(1)
    }),
    /APPLICATION_DEFAULT_ACL_REQUIRED_ENTRY_MISSING/
  );
  assert.throws(
    () => buildRepositoryApplicationDefaultAclManifest({
      target: TARGET,
      managedProfile: PROFILE,
      rows: [...currentRows(), { ...currentRows()[0], grantOption: true }]
    }),
    /APPLICATION_DEFAULT_ACL_UNEXPECTED_ENTRY/
  );
  assert.throws(
    () => buildApplicationDefaultAclPreservationManifest({
      target: TARGET,
      managedProfile: PROFILE,
      entries: [{
        ...currentRows()[0],
        classification: APPLICATION_DEFAULT_ACL_CLASSIFICATIONS.E,
        sourceEvidence: 'unreviewed'
      }]
    }),
    /APPLICATION_DEFAULT_ACL_SOURCE_CLASSIFICATION_UNKNOWN/
  );
});

test('dual-profile manifests preserve complete DEV and SANDBOX application defaults independently', () => {
  const dev = buildProfileApplicationDefaultAclManifest({
    target: TARGET,
    managedProfile: PROFILE,
    rows: currentRows()
  });
  const sandbox = buildProfileApplicationDefaultAclManifest({
    target: { environment: 'sandbox', projectRef: 's'.repeat(20) },
    managedProfile: {
      profileId: 'sandbox-current-managed-profile',
      profileDigest: `sha256:${'2'.repeat(64)}`
    },
    rows: [...currentRows(), ...MANAGED_AUTHENTICATED_APPLICATION_DEFAULT_ACL_INTENT]
  });
  assert.equal(dev.entryCount, 6);
  assert.equal(sandbox.entryCount, 12);
  assert.notEqual(dev.beforeDigest, sandbox.beforeDigest);
  assert.equal(
    sandbox.entries.filter(
      (entry) => entry.classification === APPLICATION_DEFAULT_ACL_CLASSIFICATIONS.B
    ).length,
    6
  );
  assert.throws(
    () => buildProfileApplicationDefaultAclManifest({
      target: TARGET,
      managedProfile: PROFILE,
      rows: [...currentRows(), MANAGED_AUTHENTICATED_APPLICATION_DEFAULT_ACL_INTENT[0]]
    }),
    /APPLICATION_DEFAULT_ACL_MANAGED_PROFILE_PARTIAL/
  );
});

test('every semantic mismatch fails closed even when the number of rows is unchanged', () => {
  const mutations = [
    ['ownerRole', 'other_owner'],
    ['grantorRole', 'other_grantor'],
    ['schemaName', 'app_api'],
    ['grantee', 'authenticated'],
    ['privilege', 'TRUNCATE'],
    ['grantOption', true],
    ['objectClass', 'sequence']
  ];
  for (const [field, value] of mutations) {
    const rows = currentRows();
    rows[0] = { ...rows[0], [field]: value };
    assert.throws(
      () => buildRepositoryApplicationDefaultAclManifest({
        target: TARGET,
        managedProfile: PROFILE,
        rows
      }),
      /APPLICATION_DEFAULT_ACL_(?:REQUIRED_ENTRY_MISSING|UNEXPECTED_ENTRY|PRIVILEGE_INVALID)/,
      `${field} must fail closed`
    );
  }
});

test('verification rejects live missing and additional defaults independently of certificate authentication', () => {
  const certificate = certificateFor();
  assert.throws(
    () => verifyApplicationDefaultAclManifest({
      certificate,
      key: KEY,
      target: TARGET,
      managedProfile: PROFILE,
      currentEntries: currentRows().slice(1)
    }),
    /APPLICATION_DEFAULT_ACL_REQUIRED_ENTRY_MISSING/
  );
  assert.throws(
    () => verifyApplicationDefaultAclManifest({
      certificate,
      key: KEY,
      target: TARGET,
      managedProfile: PROFILE,
      currentEntries: [...currentRows(), { ...currentRows()[0], grantOption: true }]
    }),
    /APPLICATION_DEFAULT_ACL_UNEXPECTED_ENTRY/
  );
});

test('generated preservation SQL uses supported ALTER DEFAULT PRIVILEGES before an exact semantic postcheck', () => {
  const certificate = certificateFor();
  const verified = verifyApplicationDefaultAclManifest({
    certificate,
    key: KEY,
    target: TARGET,
    managedProfile: PROFILE,
    currentEntries: currentRows()
  });
  const sql = buildApplicationDefaultAclPreservationSql(verified);
  assert.match(sql, /ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "app"/);
  assert.match(sql, /GRANT DELETE, INSERT, SELECT, UPDATE ON TABLES TO "service_role"/);
  assert.match(sql, /GRANT SELECT, USAGE ON SEQUENCES TO "service_role"/);
  assert.match(sql, /APPLICATION_DEFAULT_ACL_POSTCHECK_MISMATCH/);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+pg_catalog\.pg_default_acl/i);
  assert.doesNotMatch(sql, /UPDATE\s+pg_catalog\.pg_default_acl/i);
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+pg_catalog\.pg_default_acl/i);
});

test('routine-default profiles fail closed on unknown scope, recipient, grant option, or duplicate entry', () => {
  const safe = {
    format: 'application-routine-default-profile-v1',
    ownerRole: 'postgres',
    schemaNames: ['public', 'app', 'app_api'],
    records: []
  };
  assert.deepEqual(normalizeRoutineDefaultProfile(safe), safe);
  for (const changed of [
    { ...safe, ownerRole: 'alternate_creator' },
    { ...safe, schemaNames: ['app', 'app_api', 'public'] },
    { ...safe, records: [{ scope: 'private', entries: [] }] },
    {
      ...safe,
      records: [{
        scope: 'public',
        entries: [{ grantorRole: 'postgres', grantee: 'reader', privilege: 'EXECUTE', grantOption: false }]
      }]
    },
    {
      ...safe,
      records: [{
        scope: 'public',
        entries: [
          { grantorRole: 'postgres', grantee: 'anon', privilege: 'EXECUTE', grantOption: false },
          { grantorRole: 'postgres', grantee: 'anon', privilege: 'EXECUTE', grantOption: false }
        ]
      }]
    }
  ]) {
    assert.throws(
      () => normalizeRoutineDefaultProfile(changed),
      /APPLICATION_ROUTINE_DEFAULT_PROFILE_INVALID/
    );
  }
  assert.throws(
    () => buildApplicationRoutineDefaultRecoverySql({
      ...safe,
      records: [{
        scope: 'public',
        entries: [{ grantorRole: 'postgres', grantee: 'anon', privilege: 'EXECUTE', grantOption: true }]
      }]
    }),
    /APPLICATION_ROUTINE_RECOVERY_PROFILE_UNSUPPORTED/
  );
});

test('pre-0204 recovery is exact-profile only and restores defaults before object creation', () => {
  const pre0204 = normalizeRoutineDefaultProfile({
    format: 'application-routine-default-profile-v1',
    ownerRole: 'postgres',
    schemaNames: ['public', 'app', 'app_api'],
    records: [{
      scope: 'public',
      entries: [
        { grantorRole: 'postgres', grantee: 'anon', privilege: 'EXECUTE', grantOption: false },
        { grantorRole: 'postgres', grantee: 'postgres', privilege: 'EXECUTE', grantOption: false }
      ]
    }]
  });
  const sql = buildApplicationRoutineDefaultRecoverySql(pre0204);
  assert.match(sql, /APPLICATION_ROUTINE_RECOVERY_PRECONDITION_MISMATCH/);
  assert.match(sql, /grant execute on functions to public;/i);
  assert.match(sql, /in schema "public" grant execute on functions to "anon";/i);
  assert.match(sql, /APPLICATION_ROUTINE_RECOVERY_POSTCHECK_MISMATCH/);
  assert.doesNotMatch(sql, /create\s+(?:or\s+replace\s+)?function/i);
  const hardened = normalizeRoutineDefaultProfile({
    ...pre0204,
    records: [{
      scope: '<global>',
      entries: [{
        grantorRole: 'postgres', grantee: 'postgres', privilege: 'EXECUTE', grantOption: false
      }]
    }]
  });
  const hardenedSql = buildApplicationRoutineDefaultRecoverySql(hardened);
  assert.match(hardenedSql, /revoke execute on functions from public, anon, authenticated, service_role/i);
  assert.match(hardenedSql, /grant execute on functions to postgres/i);
});

test('disposable PostgreSQL reproduces schema-drop loss and proves corrected future-object inheritance', { timeout: 120_000 }, async (t) => {
  try {
    resolvePostgresTools();
  } catch {
    t.skip('PostgreSQL server tooling is unavailable.');
    return;
  }
  const root = path.join(os.tmpdir(), `environment-sync-rehearsal-managed-${crypto.randomBytes(8).toString('hex')}`);
  let cluster;
  try {
    cluster = await startDisposablePostgres({ rootDirectory: root });
    await withClient(cluster.connectionString(), async (client) => {
      await client.query('create role anon nologin');
      await client.query('create role authenticated nologin');
      await client.query('create role service_role nologin');
      await client.query('create schema app authorization postgres');
      await client.query('create schema app_api authorization postgres');
      await client.query('alter default privileges for role postgres in schema app grant select, insert, update, delete on tables to service_role');
      await client.query('alter default privileges for role postgres in schema app grant usage, select on sequences to service_role');
      const before = await captureApplicationDefaultAclEntries(client);
      assert.deepEqual(before, currentRows().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));

      await client.query('drop schema app cascade');
      await client.query('create schema app authorization postgres');
      assert.deepEqual(await captureApplicationDefaultAclEntries(client), []);

      const certificate = certificateFor(before);
      const verified = verifyApplicationDefaultAclManifest({
        certificate,
        key: KEY,
        target: TARGET,
        managedProfile: PROFILE,
        currentEntries: before
      });
      await client.query(buildApplicationDefaultAclPreservationSql(verified));
      assert.deepEqual(await captureApplicationDefaultAclEntries(client), before);

      await client.query('create table app.future_table_probe(id bigint)');
      await client.query('create sequence app.future_sequence_probe');
      const inherited = (await client.query(`
        select n.nspname as schema_name, c.relname as object_name,
               case when c.relkind = 'S' then 'sequence' else 'table' end as object_class,
               coalesce(grantee.rolname, 'PUBLIC') as grantee,
               acl.privilege_type, acl.is_grantable
          from pg_catalog.pg_class c
          join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          cross join lateral pg_catalog.aclexplode(coalesce(
            c.relacl,
            pg_catalog.acldefault(case when c.relkind = 'S' then 'S'::"char" else 'r'::"char" end, c.relowner)
          )) acl
          left join pg_catalog.pg_roles grantee on grantee.oid = nullif(acl.grantee, 0)
         where n.nspname = 'app'
           and c.relname = any(array['future_table_probe','future_sequence_probe'])
           and grantee.rolname = 'service_role'
         order by object_class, privilege_type
      `)).rows;
      assert.deepEqual(
        inherited.map((row) => [row.object_class, row.privilege_type, row.is_grantable]),
        [
          ['sequence', 'SELECT', false], ['sequence', 'USAGE', false],
          ['table', 'DELETE', false], ['table', 'INSERT', false],
          ['table', 'SELECT', false], ['table', 'UPDATE', false]
        ]
      );

      const unsafeFunctionDefaults = await captureFuturePublicFunctionDefaultSecurity(client);
      assert.equal(unsafeFunctionDefaults.publicExecute, true);
      assert.equal(unsafeFunctionDefaults.anonExecute, true);
      assert.equal(unsafeFunctionDefaults.authenticatedExecute, true);
      assert.equal(unsafeFunctionDefaults.serviceRoleExecute, true);
      assert.equal(unsafeFunctionDefaults.ownerExecute, true);
      assert.equal(unsafeFunctionDefaults.hardened, false);
      await client.query(
        'alter default privileges in schema public revoke execute on functions from public'
      );
      const schemaScopedRevoke = await captureFuturePublicFunctionDefaultSecurity(client);
      assert.equal(schemaScopedRevoke.publicExecute, true);
      assert.equal(schemaScopedRevoke.anonExecute, true);
      assert.equal(schemaScopedRevoke.hardened, false);
      const pre0204Profile = await captureApplicationRoutineDefaultProfile(client);
      assert.deepEqual(pre0204Profile.records, []);
      await client.query('alter default privileges for role postgres revoke execute on functions from public');
      const hardenedFunctionDefaults = await captureFuturePublicFunctionDefaultSecurity(client);
      assert.equal(hardenedFunctionDefaults.publicExecute, false);
      assert.equal(hardenedFunctionDefaults.anonExecute, false);
      assert.equal(hardenedFunctionDefaults.authenticatedExecute, false);
      assert.equal(hardenedFunctionDefaults.serviceRoleExecute, false);
      assert.equal(hardenedFunctionDefaults.ownerExecute, true);
      assert.equal(hardenedFunctionDefaults.hardened, true);
      assert.deepEqual(
        assertHardenedApplicationRoutineDefaultProfile(hardenedFunctionDefaults.profile),
        hardenedFunctionDefaults.profile
      );
      await client.query('create function public.future_function_probe() returns integer language sql as $$ select 1 $$');
      const publicExecute = (await client.query(`
        select exists (
          select 1
            from pg_catalog.pg_proc p
            cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
           where p.oid = 'public.future_function_probe()'::regprocedure
             and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as allowed
      `)).rows[0].allowed;
      assert.equal(publicExecute, false);

      await client.query('drop function public.future_function_probe()');
      await client.query(buildApplicationRoutineDefaultRecoverySql(pre0204Profile));
      assert.deepEqual(await captureApplicationRoutineDefaultProfile(client), pre0204Profile);
      const recoveredFunctionDefaults = await captureFuturePublicFunctionDefaultSecurity(client);
      assert.equal(recoveredFunctionDefaults.publicExecute, true);
      assert.equal(recoveredFunctionDefaults.anonExecute, true);
      assert.equal(recoveredFunctionDefaults.authenticatedExecute, true);
      assert.equal(recoveredFunctionDefaults.serviceRoleExecute, true);
      assert.equal(recoveredFunctionDefaults.ownerExecute, true);
      assert.equal(recoveredFunctionDefaults.hardened, false);
      await client.query('drop sequence app.future_sequence_probe');
      await client.query('drop table app.future_table_probe');
    });
  } finally {
    if (cluster) await removeDisposablePostgres(cluster);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('defaults restored after object creation cannot retroactively protect a future object', { timeout: 120_000 }, async (t) => {
  try {
    resolvePostgresTools();
  } catch {
    t.skip('PostgreSQL server tooling is unavailable.');
    return;
  }
  const root = path.join(os.tmpdir(), `environment-sync-rehearsal-managed-${crypto.randomBytes(8).toString('hex')}`);
  let cluster;
  try {
    cluster = await startDisposablePostgres({ rootDirectory: root });
    await withClient(cluster.connectionString(), async (client) => {
      await client.query('create role service_role nologin');
      await client.query('create schema app authorization postgres');
      await client.query('create schema app_api authorization postgres');
      await client.query('create table app.created_too_early(id bigint)');
      const certificate = certificateFor();
      const verified = verifyApplicationDefaultAclManifest({
        certificate,
        key: KEY,
        target: TARGET,
        managedProfile: PROFILE,
        currentEntries: currentRows()
      });
      await client.query(buildApplicationDefaultAclPreservationSql(verified));
      const inherited = (await client.query(`
        select count(*)::integer as count
          from pg_catalog.pg_class c
          join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          cross join lateral pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) acl
          join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
         where n.nspname = 'app' and c.relname = 'created_too_early'
           and grantee.rolname = 'service_role'
      `)).rows[0].count;
      assert.equal(inherited, 0);
    });
  } finally {
    if (cluster) await removeDisposablePostgres(cluster);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('current-object grants do not substitute for future-object default semantics', () => {
  assert.throws(
    () => buildRepositoryApplicationDefaultAclManifest({
      target: TARGET,
      managedProfile: PROFILE,
      rows: []
    }),
    /APPLICATION_DEFAULT_ACL_REQUIRED_ENTRY_MISSING/
  );
});

test('source classification remains categorical and contains no target identifiers', () => {
  const manifest = buildApplicationDefaultAclPreservationManifest({
    target: TARGET,
    managedProfile: PROFILE,
    entries: classifiedRows()
  });
  assert.ok(manifest.entries.every((entry) => entry.sourceEvidence === APPLICATION_DEFAULT_ACL_SOURCE_0103));
  assert.ok(manifest.entries.every((entry) => entry.classification === APPLICATION_DEFAULT_ACL_CLASSIFICATIONS.A));
});
