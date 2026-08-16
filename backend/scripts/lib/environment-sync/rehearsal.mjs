import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import pg from 'pg';

import { canonicalDigest } from '../readonly-diagnostics.mjs';
import { applyAuthQuarantine } from './auth-quarantine.mjs';
import { EXPECTED_PROD_EDGE } from './constants.mjs';
import {
  prepareRestoreDatabase,
  removeDisposablePostgres,
  startDisposablePostgres,
  withClient
} from './disposable-postgres.mjs';
import {
  captureEncryptedPgDump,
  restoreEncryptedPgDump,
  verifyEncryptedComponent
} from './encrypted-baseline.mjs';
import { captureEnvironmentInventory } from './inventory.mjs';
import {
  authenticateManifest,
  buildBaselineManifest,
  buildDerivedManifest,
  compareInventoriesWithExceptions,
  verifyAuthenticatedManifest
} from './manifest.mjs';
import { verifySideEffectQuarantine } from './side-effect-quarantine.mjs';

const { Client } = pg;

function rehearsalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function assertProdSourcePlatform(management = {}, edgeHealth = {}) {
  const api = (management.edge?.deployments || []).find(
    (entry) => entry.slug === EXPECTED_PROD_EDGE.slug
  );
  const matches =
    management.available === true &&
    management.project?.status === EXPECTED_PROD_EDGE.projectStatus &&
    management.project?.region === EXPECTED_PROD_EDGE.region &&
    api?.version === EXPECTED_PROD_EDGE.version &&
    api?.status === EXPECTED_PROD_EDGE.status &&
    api?.verifyJwt === EXPECTED_PROD_EDGE.verifyJwt &&
    edgeHealth.available === true &&
    edgeHealth.status === EXPECTED_PROD_EDGE.healthStatus &&
    edgeHealth.buildSha === EXPECTED_PROD_EDGE.buildSha;
  if (!matches) throw rehearsalError('PROD_SOURCE_PLATFORM_DRIFT');
  return true;
}

async function sourceSnapshot({ connectionString, target, projectRef, source, captureDump }) {
  const client = new Client({ connectionString, application_name: 'environment-sync-prod-readonly' });
  let began = false;
  try {
    await client.connect();
    await client.query('begin isolation level repeatable read read only');
    began = true;
    const proof = await client.query(
      `select current_setting('transaction_read_only') as read_only,
              current_setting('transaction_isolation') as isolation`
    );
    if (proof.rows[0]?.read_only !== 'on' || proof.rows[0]?.isolation !== 'repeatable read') {
      throw rehearsalError('SOURCE_SNAPSHOT_NOT_READ_ONLY');
    }
    const snapshot = await client.query('select pg_catalog.pg_export_snapshot() as snapshot_id');
    const capturedAt = new Date().toISOString();
    const inventory = await captureEnvironmentInventory({
      client,
      target,
      projectRef,
      source,
      envValues: source.envValues,
      management: source.management,
      edgeHealth: source.edgeHealth,
      capturedAt
    });
    const dump = await captureDump(snapshot.rows[0]?.snapshot_id);
    await client.query('rollback');
    began = false;
    return { capturedAt, inventory, dump, rollback: true };
  } finally {
    if (began) {
      try { await client.query('rollback'); } catch {}
    }
    await client.end().catch(() => {});
  }
}

async function applyTransform(connectionString) {
  return withClient(
    connectionString,
    async (client) => {
      await client.query('begin');
      try {
        const result = await applyAuthQuarantine(client);
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

async function captureLocalInventory(connectionString, target, projectRef, capturedAt, source) {
  return withClient(
    connectionString,
    async (client) => {
      await client.query('begin isolation level repeatable read read only');
      try {
        const inventory = await captureEnvironmentInventory({
          client,
          target,
          projectRef,
          source,
          capturedAt
        });
        await client.query('rollback');
        return inventory;
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      }
    },
    { application_name: 'environment-sync-x-rehearsal' }
  );
}

async function directAppGrantSummary(connectionString) {
  return withClient(connectionString, async (client) => {
    const result = await client.query(
      `select grantee, privilege_type, count(*)::bigint as count
         from information_schema.role_table_grants
        where table_schema = 'app' and grantee in ('anon', 'authenticated', 'service_role')
        group by grantee, privilege_type
        order by grantee, privilege_type`
    );
    return { count: result.rows.length, digest: canonicalDigest(result.rows) };
  });
}

function localSideEffectPolicy(target) {
  return {
    version: 'nonprod-side-effect-policy-v1',
    target,
    authEmailMode: 'disabled',
    smsMode: 'disabled',
    edgeSecretsTargetLocal: true,
    frontendProductionAliasAbsent: true,
    nonprodUrlsVerified: true,
    storageBehaviorReviewed: true,
    databaseNetworkExtensionsDisabled: false,
    allowedSecretNames: []
  };
}

async function runGoldenBaselineRehearsal({
  prodConnectionString,
  prodProjectRef,
  source,
  postgresBin,
  temporaryParent = os.tmpdir()
} = {}) {
  assertProdSourcePlatform(source?.management, source?.edgeHealth);
  const runToken = crypto.randomBytes(8).toString('hex');
  const root = path.join(temporaryParent, `environment-sync-rehearsal-${runToken}`);
  let cluster;
  let key;
  let teardown = false;
  const artifactPath = path.join(root, 'golden-x-rehearsal.pgdump.enc');
  try {
    cluster = await startDisposablePostgres({ rootDirectory: root, postgresBin });
    const snapshot = await sourceSnapshot({
      connectionString: prodConnectionString,
      target: 'prod',
      projectRef: prodProjectRef,
      source,
      captureDump: (snapshotId) =>
        captureEncryptedPgDump({
          pgDumpPath: cluster.tools.pgDump,
          connectionString: prodConnectionString,
          snapshotId,
          artifactPath
        })
    });
    key = snapshot.dump.key;
    if (!verifyEncryptedComponent(snapshot.dump.component, artifactPath)) {
      throw rehearsalError('BASELINE_COMPONENT_INTEGRITY_FAILED');
    }
    const suffix = runToken.slice(0, 8);
    const devName = `x_rehearsal_dev_${suffix}`;
    const sandboxName = `x_rehearsal_sandbox_${suffix}`;
    const devConnection = await prepareRestoreDatabase(cluster, devName);
    const sandboxConnection = await prepareRestoreDatabase(cluster, sandboxName);

    await restoreEncryptedPgDump({
      pgRestorePath: cluster.tools.pgRestore,
      connectionString: devConnection,
      artifactPath,
      key
    });
    if (!verifyEncryptedComponent(snapshot.dump.component, artifactPath)) {
      throw rehearsalError('BASELINE_COMPONENT_INTEGRITY_FAILED');
    }
    await restoreEncryptedPgDump({
      pgRestorePath: cluster.tools.pgRestore,
      connectionString: sandboxConnection,
      artifactPath,
      key
    });

    const grantsBefore = await Promise.all([
      directAppGrantSummary(devConnection),
      directAppGrantSummary(sandboxConnection)
    ]);
    if (JSON.stringify(grantsBefore[0]) !== JSON.stringify(grantsBefore[1])) {
      throw rehearsalError('RESTORED_GRANT_PARITY_FAILED');
    }

    const [devTransform, sandboxTransform] = await Promise.all([
      applyTransform(devConnection),
      applyTransform(sandboxConnection)
    ]);
    const commonCapturedAt = new Date().toISOString();
    const [devInventory, sandboxInventory] = await Promise.all([
      captureLocalInventory(devConnection, 'dev', 'mock-dev-target', commonCapturedAt, source),
      captureLocalInventory(sandboxConnection, 'sandbox', 'mock-sandbox-target', commonCapturedAt, source)
    ]);
    devInventory.declaredDevPreservationLayer = 'smoke-identity-and-target-settings-recreated';
    const sideEffects = {
      dev: verifySideEffectQuarantine({ inventory: devInventory, policy: localSideEffectPolicy('dev') }),
      sandbox: verifySideEffectQuarantine({ inventory: sandboxInventory, policy: localSideEffectPolicy('sandbox') })
    };
    if (!sideEffects.dev.ok || !sideEffects.sandbox.ok) {
      throw rehearsalError('SIDE_EFFECT_QUARANTINE_REHEARSAL_FAILED');
    }

    const exceptions = [
      '/declaredDevPreservationLayer',
      '/target/environment',
      '/target/projectRef'
    ];
    const parity = compareInventoriesWithExceptions(devInventory, sandboxInventory, exceptions);
    if (!parity.ok) throw rehearsalError('DERIVED_TARGET_PARITY_FAILED');

    const manifestKey = crypto.randomBytes(32);
    try {
      const baseline = authenticateManifest(
        buildBaselineManifest({
          baselineId: `x-rehearsal-${runToken}`,
          sourceSnapshotTimestamp: snapshot.capturedAt,
          sourceCommit: source.gitCommit,
          inventory: snapshot.inventory,
          components: [snapshot.dump.component],
          edgeIdentity: source.edgeIdentity,
          platformClassifications: {
            rehearsal: true,
            project: snapshot.inventory.platform.project,
            auth: snapshot.inventory.platform.auth,
            secrets: snapshot.inventory.platform.secrets,
            managementAvailable: snapshot.inventory.platform.managementAvailable,
            edge: snapshot.inventory.edge
          },
          sideEffectInventory: snapshot.inventory.sideEffects,
          allowedExceptions: exceptions
        }),
        manifestKey
      );
      const derivedDev = authenticateManifest(
        buildDerivedManifest({
          baselineManifest: baseline,
          target: devInventory.target,
          transform: { id: 'x-np', version: devTransform.version },
          inventory: devInventory,
          allowedExceptions: exceptions
        }),
        manifestKey
      );
      const derivedSandbox = authenticateManifest(
        buildDerivedManifest({
          baselineManifest: baseline,
          target: sandboxInventory.target,
          transform: { id: 'x-np', version: sandboxTransform.version },
          inventory: sandboxInventory,
          allowedExceptions: exceptions
        }),
        manifestKey
      );
      verifyAuthenticatedManifest(baseline, manifestKey);
      verifyAuthenticatedManifest(derivedDev, manifestKey);
      verifyAuthenticatedManifest(derivedSandbox, manifestKey);
    } finally {
      manifestKey.fill(0);
    }

    return {
      classification: 'X_REHEARSAL_PASSED',
      source: {
        readOnly: true,
        rollback: snapshot.rollback,
        migrationCount: snapshot.inventory.migration.count,
        migrationTip: snapshot.inventory.migration.tip
      },
      component: snapshot.dump.component,
      restores: 2,
      transforms: {
        dev: devTransform,
        sandbox: sandboxTransform
      },
      directGrantParity: true,
      sideEffects,
      parity: {
        ok: parity.ok,
        declaredDifferenceCount: parity.changed.length,
        exceptions
      },
      manifestsAuthenticated: true
    };
  } finally {
    if (key) key.fill(0);
    if (cluster) {
      await removeDisposablePostgres(cluster);
      teardown = !fs.existsSync(root);
    }
    if (cluster && !teardown) throw rehearsalError('REHEARSAL_TEARDOWN_FAILED');
  }
}

export { assertProdSourcePlatform, runGoldenBaselineRehearsal };
