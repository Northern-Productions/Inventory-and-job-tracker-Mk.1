import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  TARGET_NATIVE_AUTHENTICATOR_PUBLIC_SCHEMA_USAGE,
  applicationAclAugmentationDigest,
  buildApplicationAclContract,
  buildApplicationAclConvergenceManifest,
  buildApplicationAclConvergenceSql,
  captureApplicationAclContract,
  compareApplicationAclContracts,
  renderApplicationAclRevoke,
  verifyApplicationAclContract,
  verifyApplicationAclConvergenceManifest,
  verifyCertifiedManagedAclExceptions
} from './application-acl-convergence.mjs';
import {
  removeDisposablePostgres,
  resolvePostgresTools,
  startDisposablePostgres,
  withClient
} from './disposable-postgres.mjs';
import { canonicalDigest } from '../readonly-diagnostics.mjs';

function routine(name, identityArguments = 'uuid', securityDefiner = true) {
  return {
    objectClass: 'function',
    schemaName: 'public',
    objectName: name,
    identityArguments,
    ownerRole: 'postgres',
    securityDefiner
  };
}

function executeGrant(object, grantee, overrides = {}) {
  return {
    objectClass: object.objectClass,
    schemaName: object.schemaName,
    objectName: object.objectName,
    identityArguments: object.identityArguments,
    ownerRole: object.ownerRole,
    grantor: 'postgres',
    grantee,
    privilege: 'EXECUTE',
    grantable: false,
    ...overrides
  };
}

function contracts() {
  const objects = [
    {
      objectClass: 'schema', schemaName: 'app', objectName: 'app',
      identityArguments: '', ownerRole: 'postgres', securityDefiner: false
    },
    {
      objectClass: 'schema', schemaName: 'app_api', objectName: 'app_api',
      identityArguments: '', ownerRole: 'postgres', securityDefiner: false
    },
    routine('api_acl_probe'),
    routine('api_worker_probe', '')
  ];
  const sourceGrants = [executeGrant(objects[2], 'authenticated')];
  const targetGrants = [
    ...sourceGrants,
    executeGrant(objects[2], 'anon'),
    executeGrant(objects[3], 'service_role')
  ];
  return {
    source: buildApplicationAclContract({ objects, grants: sourceGrants }),
    target: buildApplicationAclContract({ objects, grants: targetGrants })
  };
}

test('ACL convergence manifest is stable, exact, digest protected, and signature based', () => {
  const { source, target } = contracts();
  assert.equal(verifyApplicationAclContract(source), true);
  const manifest = buildApplicationAclConvergenceManifest({ source, target });
  assert.equal(verifyApplicationAclConvergenceManifest(manifest), true);
  assert.equal(manifest.operationCount, 2);
  assert.equal(manifest.unknownCount, 0);
  assert.match(manifest.operationDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(applicationAclAugmentationDigest(manifest.operations), /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(manifest.operations.map((entry) => entry.grantee), ['anon', 'service_role']);
  assert.ok(manifest.operations.every((entry) => !('oid' in entry)));
  const sql = manifest.operations.map(renderApplicationAclRevoke).join('\n');
  assert.match(sql, /REVOKE EXECUTE ON FUNCTION "public"\."api_acl_probe"\(uuid\) FROM "anon";/);
  assert.match(sql, /REVOKE EXECUTE ON FUNCTION "public"\."api_worker_probe"\(\) FROM "service_role";/);
  const changed = structuredClone(manifest);
  changed.operations[0].grantee = 'authenticated';
  assert.throws(
    () => verifyApplicationAclConvergenceManifest(changed),
    /APPLICATION_ACL_CONVERGENCE_MANIFEST_DIGEST_MISMATCH/
  );
});

test('ACL convergence fails closed for missing grants, value drift, signature drift, and unknown roles', () => {
  const { source, target } = contracts();
  const missing = buildApplicationAclContract({
    objects: target.objects,
    grants: target.grants.filter((entry) => entry.grantee !== 'authenticated')
  });
  assert.throws(
    () => buildApplicationAclConvergenceManifest({ source, target: missing }),
    /APPLICATION_ACL_SOURCE_GRANT_MISSING/
  );
  const mismatched = buildApplicationAclContract({
    objects: target.objects,
    grants: target.grants.map((entry) => entry.grantee === 'authenticated'
      ? { ...entry, grantable: true }
      : entry)
  });
  assert.throws(
    () => buildApplicationAclConvergenceManifest({ source, target: mismatched }),
    /APPLICATION_ACL_GRANT_VALUE_MISMATCH/
  );
  const signatureDrift = buildApplicationAclContract({
    objects: target.objects.map((entry) => entry.objectName === 'api_worker_probe'
      ? { ...entry, identityArguments: 'text' }
      : entry),
    grants: target.grants.filter((entry) => entry.objectName !== 'api_worker_probe')
  });
  assert.throws(
    () => buildApplicationAclConvergenceManifest({ source, target: signatureDrift }),
    /APPLICATION_ACL_SOURCE_OBJECT_MISSING/
  );
  const unknown = buildApplicationAclContract({
    objects: target.objects,
    grants: [
      ...target.grants,
      executeGrant(target.objects.find((entry) => entry.objectName === 'api_acl_probe'), 'unexpected_role')
    ]
  });
  assert.throws(
    () => buildApplicationAclConvergenceManifest({ source, target: unknown }),
    /APPLICATION_ACL_TARGET_ONLY_GRANT_UNREVIEWED/
  );
});

test('managed ACL exception verifier accepts only the certified effective authenticator usage identity', () => {
  const certified = structuredClone(TARGET_NATIVE_AUTHENTICATOR_PUBLIC_SCHEMA_USAGE);
  assert.equal(verifyCertifiedManagedAclExceptions([certified]), true);

  const drifts = [
    ['classification', 'UNEXPECTED_MANAGED_EXCEPTION'],
    ['count', 2],
    ['digest', 'sha256:' + '0'.repeat(64)],
    ['catalogDigest', 'sha256:' + '1'.repeat(64)],
    ['grantee', 'authenticated'],
    ['schema', 'app'],
    ['privilege', 'CREATE'],
    ['create', true],
    ['tableOperations', 1],
    ['sequenceOperations', 1],
    ['directApplicationFunctionExecute', 1],
    ['additionalApplicationOperations', 1],
    ['targetPrestatePreserved', false],
    ['prodPeerMatch', false],
    ['broadSchemaIgnore', true]
  ];
  for (const [field, value] of drifts) {
    assert.throws(
      () => verifyCertifiedManagedAclExceptions([{ ...certified, [field]: value }]),
      /MANAGED_ACL_EXCEPTION_UNCERTIFIED/,
      field
    );
  }
  assert.throws(
    () => verifyCertifiedManagedAclExceptions([]),
    /MANAGED_ACL_EXCEPTION_SET_UNCERTIFIED/
  );
  assert.throws(
    () => verifyCertifiedManagedAclExceptions([certified, certified]),
    /MANAGED_ACL_EXCEPTION_SET_UNCERTIFIED/
  );
  assert.throws(
    () => verifyCertifiedManagedAclExceptions([{ ...certified, ignored: true }]),
    /MANAGED_ACL_EXCEPTION_UNCERTIFIED/
  );
});

test('managed-overlay ACL stage embeds an immutable source contract and avoids broad/default ACL mutation', () => {
  const { source } = contracts();
  const sql = buildApplicationAclConvergenceSql(source);
  assert.match(sql, /APPLICATION_ACL_SOURCE_GRANT_MISSING/);
  assert.match(sql, /APPLICATION_ACL_TARGET_ONLY_GRANT_UNREVIEWED/);
  assert.match(sql, /APPLICATION_ACL_GRANT_POSTCHECK_MISMATCH/);
  assert.match(sql, /REVOKE %s ON %s %I\.%I\(%s\) FROM %s/);
  assert.doesNotMatch(sql, /REVOKE EXECUTE ON ALL FUNCTIONS/i);
  assert.doesNotMatch(sql, /ALTER DEFAULT PRIVILEGES/i);
  assert.doesNotMatch(sql, /pg_default_acl\s+(?:DELETE|UPDATE|INSERT)/i);
});

test('native default EXECUTE expansion converges to the source contract without changing defaults', { timeout: 120_000 }, async (t) => {
  try {
    resolvePostgresTools();
  } catch {
    t.skip('PostgreSQL 18 server tooling is unavailable.');
    return;
  }
  const root = path.join(
    os.tmpdir(),
    `environment-sync-rehearsal-managed-${crypto.randomBytes(8).toString('hex')}`
  );
  let cluster;
  try {
    cluster = await startDisposablePostgres({ rootDirectory: root });
    await withClient(cluster.connectionString(), async (client) => {
      await client.query(`
        create role anon;
        create role authenticated;
        create role authenticator;
        create role service_role;
        set role postgres;
        create schema app authorization postgres;
        create schema app_api authorization postgres;
        create function public.api_acl_probe(p_org_id uuid) returns integer
          language sql security definer as 'select 1';
        revoke execute on function public.api_acl_probe(uuid) from public;
        grant execute on function public.api_acl_probe(uuid) to authenticated;
        reset role;
      `);
      const source = await captureApplicationAclContract(client);
      await client.query(`
        set role postgres;
        drop function public.api_acl_probe(uuid);
        alter default privileges for role postgres in schema public grant execute on functions to anon;
        alter default privileges for role postgres in schema public grant execute on functions to authenticated;
        alter default privileges for role postgres in schema public grant execute on functions to service_role;
        create function public.api_acl_probe(p_org_id uuid) returns integer
          language sql security definer as 'select 1';
        revoke execute on function public.api_acl_probe(uuid) from public;
        reset role;
      `);
      const target = await captureApplicationAclContract(client);
      const manifest = buildApplicationAclConvergenceManifest({ source, target });
      assert.equal(manifest.operationCount, 2);
      assert.deepEqual(manifest.operations.map((entry) => entry.grantee), ['anon', 'service_role']);
      const defaultsBefore = (await client.query(`
        select defaclrole::regrole::text as owner_role, defaclnamespace::regnamespace::text as schema_name,
               defaclobjtype, defaclacl::text as acl
          from pg_catalog.pg_default_acl order by 1,2,3,4
      `)).rows;
      await client.query('begin isolation level serializable');
      await client.query(buildApplicationAclConvergenceSql(source));
      await client.query('commit');
      const after = await captureApplicationAclContract(client);
      assert.equal(compareApplicationAclContracts(source, after).exact, true);
      const defaultsAfter = (await client.query(`
        select defaclrole::regrole::text as owner_role, defaclnamespace::regnamespace::text as schema_name,
               defaclobjtype, defaclacl::text as acl
          from pg_catalog.pg_default_acl order by 1,2,3,4
      `)).rows;
      assert.equal(canonicalDigest(defaultsAfter), canonicalDigest(defaultsBefore));
    });
  } finally {
    if (cluster) await removeDisposablePostgres(cluster);
  }
});
