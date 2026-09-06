import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonicalDigest } from '../readonly-diagnostics.mjs';
import {
  DEV_CERTIFIED_EVIDENCE_FORMAT,
  DEV_PROJECT_REF,
  authenticateCertifiedRefreshContract,
  buildCertifiedRefreshContract,
  sha256Bytes,
  verifyAuthenticatedCertifiedRefreshContract
} from './dev-certified-contract.mjs';
import { runDevCertifiedCli } from './dev-certified-cli.mjs';
import {
  appendFixtureId,
  appendFixtureIds,
  cleanupTargetsFromLedger,
  closeFixtureLedger,
  createFixtureLedger,
  readFixtureLedger
} from './dev-certified-fixture-ledger.mjs';
import {
  REQUIRED_OPERATION_STAGES,
  authenticateOperationInventory,
  buildOperationInventory,
  createOperationExecutor,
  verifyOperationInventory
} from './dev-certified-operation-executor.mjs';
import {
  REAL_STAGE_WORKER,
  prepareCertifiedDevRefresh
} from './dev-certified-preparation.mjs';
import { runCertifiedDevRecovery, runCertifiedDevRefresh } from './dev-certified-orchestrator.mjs';
import { readJournal, restartDisposition, signPayload } from './dev-certified-state.mjs';
import { removeRetainedDisposablePostgres } from './disposable-postgres.mjs';
import {
  cleanupCertifiedWorkflowFixtures,
  runCertifiedWorkflowHarness,
  verifyCertifiedWorkflowCleanup
} from './dev-certified-workflow-runner.mjs';
import { GOLDEN_WORKFLOW_CONTRACT } from './constants.mjs';
import {
  createPrivateDirectory,
  writePrivateBytesExclusive
} from './private-artifacts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const SYNTHETIC_WORKER = path.join(HERE, 'dev-certified-test-worker.mjs');

function authority(attemptId = 'dev-refresh-20260826000000000-test') {
  return {
    projectRef: 'uxiltcpbhthhinonttrc',
    attemptId,
    smokeActorId: '00000000-0000-4000-8000-000000000001',
    primaryOrganizationId: '00000000-0000-4000-8000-000000000002',
    temporaryCrossOrganizationAllowed: true,
    workflows: [...GOLDEN_WORKFLOW_CONTRACT],
    entityLimits: {
      box: 2,
      membership: 2,
      owner_notification_preference_restore: 1,
      preference_restore: 1,
      organization_preference_restore: 1
    }
  };
}

function temporaryRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function privateJson(filePath) {
  const bytes = fs.readFileSync(filePath);
  try { return JSON.parse(bytes.toString('utf8')); }
  finally { bytes.fill(0); }
}

function digestFile(filePath) {
  const bytes = fs.readFileSync(filePath);
  try { return sha256Bytes(bytes); }
  finally { bytes.fill(0); }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function isZeroed(bytes) {
  return bytes.every((value) => value === 0);
}

function lifecycleStageDetails(stage) {
  if (stage === 'Y2_VALIDATED') {
    return {
      y2RecoveryId: 'dev-pre-refresh-recovery-y2-lifecycle',
      encrypted: true,
      authenticated: true,
      digestVerified: true,
      restoreTested: true,
      attemptBound: true,
      frozenManifests: [
        'golden-source', 'x-np-transform', 'managed-profile', 'auth-scope',
        'default-acl', 'application-acl', 'migrations', 'workflow-fixture',
        'cleanup-authority', 'runtime-provenance', 'side-effect-policy', 'y2-recovery'
      ].map((name, index) => ({ name, size: index + 1, digest: canonicalDigest(name) }))
    };
  }
  if (stage === 'DATABASE_CUTOVER') {
    return {
      migrations: POST_GOLDEN_MIGRATIONS.map(({ id, version, digest }) => ({ id, version, digest }))
    };
  }
  if (stage === 'WORKFLOW_CERTIFICATION') {
    return { workflows: GOLDEN_WORKFLOW_CONTRACT.map((name) => ({ name, status: 'passed' })) };
  }
  if (stage === 'FIXTURE_CLEANUP') return { fixtureResidue: 0 };
  if (stage === 'FINAL_PARITY') {
    return {
      targetDev: true,
      goldenDerived: true,
      migration0205: true,
      applicationAclExact: true,
      defaultAclPreserved: true,
      managedProfilePreserved: true,
      authQuarantineExact: true,
      smokeOwnerExact: true,
      copiedUsersFrozen: true,
      sideEffectsSafe: true,
      runtimeExact: true,
      workflowsPassed: true,
      fixturesZero: true,
      tenantIsolationExact: true,
      unexplainedStateAbsent: true
    };
  }
  if (stage === 'RECOVERY_VERIFIED') {
    return {
      preCutoverParity: true,
      fixtureResidue: 0,
      y2Exact: true,
      edgeRestored: true,
      sideEffectsRestored: true
    };
  }
  return { categorical: true };
}

function lifecycleEvidence(contract, stage) {
  const details = lifecycleStageDetails(stage);
  return {
    format: DEV_CERTIFIED_EVIDENCE_FORMAT,
    stage,
    attemptId: contract.attemptId,
    target: 'dev',
    projectRef: DEV_PROJECT_REF,
    status: 'passed',
    contractDigest: contract.contractDigest,
    safeCount: Object.keys(details).length,
    evidenceDigest: canonicalDigest(details),
    details
  };
}

function lifecycleExecutor(contract, { failAt = '', failCode = '' } = {}) {
  return {
    async run(stage) {
      if (stage === failAt) {
        const category = failCode || `DEV_REFRESH_INJECTED_${stage}_FAILURE`;
        throw Object.assign(new Error(category), { code: category });
      }
      return lifecycleEvidence(contract, stage);
    }
  };
}

function createCliLifecycleHarness(label, { recoveryState = false } = {}) {
  const root = temporaryRoot(`dev-certified-cli-${label}-`);
  const key = crypto.randomBytes(32);
  const expectedKey = Buffer.from(key);
  const keyPath = path.join(root, 'authority.private.bin');
  const envPath = path.join(root, 'synthetic.private.env');
  const contractPath = path.join(root, 'contract.private.json');
  const inventoryPath = path.join(root, 'inventory.private.json');
  const stateDirectory = path.join(root, 'state');
  const evidenceDirectory = path.join(root, 'evidence');
  const lineage = {
    toolingCommit: '1'.repeat(40),
    toolingTree: '2'.repeat(40),
    canonicalMainCommit: '3'.repeat(40),
    canonicalMainTree: '4'.repeat(40),
    certifiedToolingAncestor: '5'.repeat(40)
  };
  const attemptLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48);
  const attemptId = `dev-refresh-cli-${attemptLabel}-${crypto.randomBytes(8).toString('hex')}`;
  const contract = buildCertifiedRefreshContract({
    attemptId,
    toolingCommit: lineage.toolingCommit,
    toolingTree: lineage.toolingTree,
    goldenManifestDigest: canonicalDigest('golden'),
    currentDevProfileDigest: canonicalDigest('dev-profile'),
    operationInventoryDigest: canonicalDigest('operations')
  });
  try {
    writePrivateBytesExclusive(keyPath, key);
    writePrivateBytesExclusive(envPath, Buffer.from(
      `SUPABASE_URL=https://${DEV_PROJECT_REF}.supabase.co\n` +
      `DATABASE_URL=postgresql://postgres:synthetic@db.${DEV_PROJECT_REF}.supabase.co:5432/postgres\n`,
      'utf8'
    ));
    writePrivateBytesExclusive(
      contractPath,
      Buffer.from(`${JSON.stringify(authenticateCertifiedRefreshContract(contract, key))}\n`, 'utf8')
    );
    writePrivateBytesExclusive(inventoryPath, Buffer.from('{"testOnly":true}\n', 'utf8'));
    if (recoveryState) createPrivateDirectory(stateDirectory);
  } finally {
    key.fill(0);
  }
  const runtime = {
    createOperationExecutorFn: () => ({ testOnly: true }),
    verifyMigrationBytesFn: () => [],
    verifyRepositoryLineageFn: () => lineage
  };
  return {
    contract,
    expectedKey,
    root,
    runtime,
    stateDirectory,
    args(mode) {
      return [
        '--apply', '--quiet-window-active',
        ...(mode === 'recover' ? ['--recovery-authorized'] : []),
        '--env', envPath,
        '--authority-key', keyPath,
        '--contract', contractPath,
        '--operation-inventory', inventoryPath,
        '--state-dir', stateDirectory,
        '--evidence-dir', evidenceDirectory
      ];
    },
    cleanup() {
      expectedKey.fill(0);
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

test('refresh and recovery keep the authority key live until asynchronous settlement', async () => {
  for (const mode of ['refresh', 'recover']) {
    for (const outcome of ['resolve', 'reject']) {
      const harness = createCliLifecycleHarness(`${mode}-${outcome}`, { recoveryState: mode === 'recover' });
      const entered = deferred();
      const settlement = deferred();
      let observedKey;
      const operation = async ({ key }) => {
        observedKey = key;
        entered.resolve();
        await settlement.promise;
        if (outcome === 'reject') {
          throw Object.assign(new Error('DEV_REFRESH_INJECTED_ASYNC_REJECTION'), {
            code: 'DEV_REFRESH_INJECTED_ASYNC_REJECTION'
          });
        }
        return { classification: `DEV_REFRESH_TEST_${mode.toUpperCase()}_COMPLETE` };
      };
      try {
        const pending = runDevCertifiedCli(mode, harness.args(mode), REPO_ROOT, {
          ...harness.runtime,
          ...(mode === 'refresh' ? { runRefreshFn: operation } : { runRecoveryFn: operation })
        });
        await entered.promise;
        assert.deepEqual(observedKey, harness.expectedKey, `${mode}:${outcome}:pending`);
        assert.equal(isZeroed(observedKey), false, `${mode}:${outcome}:pending`);
        settlement.resolve();
        if (outcome === 'reject') {
          await assert.rejects(pending, /DEV_REFRESH_INJECTED_ASYNC_REJECTION/);
        } else {
          await pending;
        }
        assert.equal(isZeroed(observedKey), true, `${mode}:${outcome}:settled`);
      } finally {
        harness.cleanup();
      }
    }
  }
});

test('CLI zeroizes authority material for synchronous and pre-dispatch failures without unhandled promises', async () => {
  const synchronous = createCliLifecycleHarness('synchronous-failure');
  let synchronousKey;
  try {
    await assert.rejects(
      runDevCertifiedCli('refresh', synchronous.args('refresh'), REPO_ROOT, {
        ...synchronous.runtime,
        runRefreshFn: ({ key }) => {
          synchronousKey = key;
          throw Object.assign(new Error('DEV_REFRESH_INJECTED_SYNCHRONOUS_FAILURE'), {
            code: 'DEV_REFRESH_INJECTED_SYNCHRONOUS_FAILURE'
          });
        }
      }),
      /DEV_REFRESH_INJECTED_SYNCHRONOUS_FAILURE/
    );
    assert.equal(isZeroed(synchronousKey), true);
  } finally {
    synchronous.cleanup();
  }

  const invalid = createCliLifecycleHarness('invalid-contract');
  let invalidKey;
  let unhandled = false;
  const onUnhandled = () => { unhandled = true; };
  process.on('unhandledRejection', onUnhandled);
  try {
    const invalidContractPath = invalid.args('refresh')[invalid.args('refresh').indexOf('--contract') + 1];
    const record = privateJson(invalidContractPath);
    record.authentication.digest = `sha256:${'0'.repeat(64)}`;
    fs.writeFileSync(invalidContractPath, `${JSON.stringify(record)}\n`, 'utf8');
    await assert.rejects(
      runDevCertifiedCli('refresh', invalid.args('refresh'), REPO_ROOT, {
        ...invalid.runtime,
        readAuthorityKeyFn: () => {
          invalidKey = Buffer.from(invalid.expectedKey);
          return invalidKey;
        }
      }),
      /DEV_REFRESH_CONTRACT_AUTHENTICATION_FAILED/
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(isZeroed(invalidKey), true);
    assert.equal(unhandled, false);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    invalid.cleanup();
  }
});

test('fixed dispatch signs active evidence with the intended key and rejects the historical zero-key signature', async () => {
  const payload = { format: 'dev-refresh-key-lifecycle-regression-v1', categorical: true };
  const zeroKey = Buffer.alloc(32);
  const historicalKey = crypto.randomBytes(32);
  const historicalExpected = Buffer.from(historicalKey);
  let historicalSignature = '';
  async function historicalDispatch() {
    try {
      return (async () => {
        await Promise.resolve();
        historicalSignature = signPayload(payload, historicalKey);
      })();
    } finally {
      historicalKey.fill(0);
    }
  }
  try {
    await historicalDispatch();
    assert.equal(historicalSignature, signPayload(payload, zeroKey));
    assert.notEqual(historicalSignature, signPayload(payload, historicalExpected));
  } finally {
    historicalKey.fill(0);
    historicalExpected.fill(0);
  }

  const harness = createCliLifecycleHarness('cryptographic-regression');
  let activeKey;
  let activeSignature = '';
  try {
    await runDevCertifiedCli('refresh', harness.args('refresh'), REPO_ROOT, {
      ...harness.runtime,
      runRefreshFn: async ({ key }) => {
        activeKey = key;
        await Promise.resolve();
        activeSignature = signPayload(payload, key);
        return { classification: 'DEV_REFRESH_TEST_CRYPTOGRAPHIC_COMPLETE' };
      }
    });
    assert.equal(activeSignature, signPayload(payload, harness.expectedKey));
    assert.notEqual(activeSignature, signPayload(payload, zeroKey));
    assert.equal(isZeroed(activeKey), true);
  } finally {
    zeroKey.fill(0);
    harness.cleanup();
  }
});

test('pre-mutation CLI failures append authenticated terminal journals before key zeroization', async () => {
  for (const stage of ['PRECHECK', 'QUIET_WINDOW', 'Y2_CAPTURE']) {
    const harness = createCliLifecycleHarness(`pre-mutation-${stage.toLowerCase()}`);
    let observedKey;
    try {
      await assert.rejects(
        runDevCertifiedCli('refresh', harness.args('refresh'), REPO_ROOT, {
          ...harness.runtime,
          runRefreshFn: ({ rootDirectory, key, contract }) => {
            observedKey = key;
            return runCertifiedDevRefresh({
              rootDirectory,
              key,
              contract,
              executor: lifecycleExecutor(contract, { failAt: stage })
            });
          }
        }),
        new RegExp(`DEV_REFRESH_INJECTED_${stage}_FAILURE`)
      );
      const journal = readJournal(harness.stateDirectory, harness.expectedKey);
      assert.equal(journal.current.state, 'FAILED_PRE_MUTATION', stage);
      assert.equal(journal.current.failureCategory, `DEV_REFRESH_INJECTED_${stage}_FAILURE`, stage);
      assert.equal(restartDisposition(harness.stateDirectory, harness.expectedKey), 'PRE_MUTATION_ABORT_ONLY');
      assert.equal(isZeroed(observedKey), true, stage);
    } finally {
      harness.cleanup();
    }
  }
});

test('post-boundary refresh and recovery journals settle authentically before each key is zeroized', async () => {
  const harness = createCliLifecycleHarness('post-boundary-recovery');
  let refreshKey;
  let recoveryKey;
  try {
    await assert.rejects(
      runDevCertifiedCli('refresh', harness.args('refresh'), REPO_ROOT, {
        ...harness.runtime,
        runRefreshFn: ({ rootDirectory, key, contract }) => {
          refreshKey = key;
          return runCertifiedDevRefresh({
            rootDirectory,
            key,
            contract,
            executor: lifecycleExecutor(contract, { failAt: 'DATABASE_CUTOVER' })
          });
        }
      }),
      /DEV_REFRESH_RECOVERY_REQUIRED/
    );
    assert.equal(readJournal(harness.stateDirectory, harness.expectedKey).current.state, 'RECOVERY_REQUIRED');
    assert.equal(restartDisposition(harness.stateDirectory, harness.expectedKey), 'RECOVERY_REQUIRED');
    assert.equal(isZeroed(refreshKey), true);

    const recovered = await runDevCertifiedCli('recover', harness.args('recover'), REPO_ROOT, {
      ...harness.runtime,
      runRecoveryFn: ({ rootDirectory, key, contract }) => {
        recoveryKey = key;
        return runCertifiedDevRecovery({
          rootDirectory,
          key,
          contract,
          executor: lifecycleExecutor(contract)
        });
      }
    });
    assert.equal(recovered.classification, 'DEV_REFRESH_RECOVERED');
    assert.equal(readJournal(harness.stateDirectory, harness.expectedKey).current.state, 'RECOVERED');
    assert.equal(isZeroed(recoveryKey), true);
  } finally {
    harness.cleanup();
  }
});

test('recovery failure is durably authenticated before the recovery key is zeroized', async () => {
  const harness = createCliLifecycleHarness('recovery-failure');
  let recoveryKey;
  try {
    await assert.rejects(
      runDevCertifiedCli('refresh', harness.args('refresh'), REPO_ROOT, {
        ...harness.runtime,
        runRefreshFn: ({ rootDirectory, key, contract }) => runCertifiedDevRefresh({
          rootDirectory,
          key,
          contract,
          executor: lifecycleExecutor(contract, { failAt: 'DATABASE_CUTOVER' })
        })
      }),
      /DEV_REFRESH_RECOVERY_REQUIRED/
    );
    await assert.rejects(
      runDevCertifiedCli('recover', harness.args('recover'), REPO_ROOT, {
        ...harness.runtime,
        runRecoveryFn: ({ rootDirectory, key, contract }) => {
          recoveryKey = key;
          return runCertifiedDevRecovery({
            rootDirectory,
            key,
            contract,
            executor: lifecycleExecutor(contract, { failAt: 'RECOVERY_AUTH_RUNTIME' })
          });
        }
      }),
      /DEV_REFRESH_RECOVERY_FAILED/
    );
    assert.equal(readJournal(harness.stateDirectory, harness.expectedKey).current.state, 'RECOVERY_FAILED');
    assert.equal(isZeroed(recoveryKey), true);
  } finally {
    harness.cleanup();
  }
});

test('authenticated fixture ledger records exact batches, restoration authority, and terminal cleanup', () => {
  const root = temporaryRoot('dev-certified-ledger-');
  const key = crypto.randomBytes(32);
  const ledgerPath = path.join(root, 'fixtures.private.jsonl');
  try {
    createFixtureLedger(ledgerPath, key, authority());
    appendFixtureIds(ledgerPath, key, [
      {
        workflow: GOLDEN_WORKFLOW_CONTRACT[4], entityType: 'box', stableId: 'BOX-1',
        organizationId: authority().primaryOrganizationId, actorId: authority().smokeActorId
      },
      {
        workflow: GOLDEN_WORKFLOW_CONTRACT[3], entityType: 'preference_restore',
        stableId: authority().smokeActorId, organizationId: authority().primaryOrganizationId,
        actorId: authority().smokeActorId,
        restore: {
          existed: true, defaultWarehouse: 'IL1',
          updatedAt: '2026-08-26T00:00:00.000Z', updatedBy: 'native-owner'
        }
      },
      {
        workflow: GOLDEN_WORKFLOW_CONTRACT[17], entityType: 'organization_preference_restore',
        stableId: authority().smokeActorId, organizationId: authority().primaryOrganizationId,
        actorId: authority().smokeActorId,
        restore: {
          existed: true, selectedOrganizationId: authority().primaryOrganizationId,
          updatedAt: '2026-08-26T00:00:00.000Z', updatedByUserId: authority().smokeActorId
        }
      },
      {
        workflow: GOLDEN_WORKFLOW_CONTRACT[1], entityType: 'owner_notification_preference_restore',
        stableId: authority().smokeActorId, organizationId: authority().primaryOrganizationId,
        actorId: authority().smokeActorId,
        restore: { existed: false }
      }
    ], '2026-08-26T00:00:01.000Z');
    appendFixtureId(ledgerPath, key, {
      workflow: GOLDEN_WORKFLOW_CONTRACT[4], entityType: 'box', stableId: 'BOX-2',
      organizationId: authority().primaryOrganizationId, actorId: authority().smokeActorId,
      recordedAt: '2026-08-26T00:00:02.000Z'
    });
    const observed = readFixtureLedger(ledgerPath, key, { attemptId: authority().attemptId });
    assert.equal(observed.entries.length, 5);
    assert.equal(observed.counts.box, 2);
    assert.deepEqual(cleanupTargetsFromLedger(ledgerPath, key)[1].restore, {
      existed: true, defaultWarehouse: 'IL1',
      updatedAt: '2026-08-26T00:00:00.000Z', updatedBy: 'native-owner'
    });
    closeFixtureLedger(ledgerPath, key, {
      removedCount: 5, residueCount: 0,
      parityDigest: canonicalDigest({ exact: true })
    });
    assert.equal(readFixtureLedger(ledgerPath, key).terminal.status, 'cleanup_verified');
    assert.throws(() => appendFixtureId(ledgerPath, key, {
      workflow: GOLDEN_WORKFLOW_CONTRACT[4], entityType: 'box', stableId: 'BOX-3',
      organizationId: authority().primaryOrganizationId, actorId: authority().smokeActorId
    }), /DEV_REFRESH_FIXTURE_LEDGER_CLOSED/);
  } finally {
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fixture ledger rejects tampering, duplicates, excess counts, and malformed restoration data', () => {
  const root = temporaryRoot('dev-certified-ledger-negative-');
  const key = crypto.randomBytes(32);
  const ledgerPath = path.join(root, 'fixtures.private.jsonl');
  try {
    createFixtureLedger(ledgerPath, key, authority());
    const entry = {
      workflow: GOLDEN_WORKFLOW_CONTRACT[4], entityType: 'box', stableId: 'BOX-1',
      organizationId: authority().primaryOrganizationId, actorId: authority().smokeActorId
    };
    appendFixtureId(ledgerPath, key, entry);
    assert.throws(() => appendFixtureId(ledgerPath, key, entry), /DEV_REFRESH_FIXTURE_LEDGER_ENTRY_INVALID/);
    appendFixtureId(ledgerPath, key, { ...entry, stableId: 'BOX-2' });
    assert.throws(() => appendFixtureId(ledgerPath, key, { ...entry, stableId: 'BOX-3' }), /DEV_REFRESH_FIXTURE_LEDGER_LIMIT_EXCEEDED/);
    assert.throws(() => appendFixtureId(ledgerPath, key, {
      ...entry, entityType: 'preference_restore', stableId: authority().smokeActorId,
      restore: { existed: true, defaultWarehouse: 'bad', updatedAt: 'bad', updatedBy: '' }
    }), /DEV_REFRESH_FIXTURE_LEDGER_RESTORE_INVALID/);
    assert.throws(() => appendFixtureId(ledgerPath, key, {
      ...entry, entityType: 'organization_preference_restore', stableId: authority().smokeActorId,
      restore: { existed: true, selectedOrganizationId: '', updatedAt: 'bad', updatedByUserId: '' }
    }), /DEV_REFRESH_FIXTURE_LEDGER_ORGANIZATION_RESTORE_INVALID/);
    assert.throws(() => appendFixtureId(ledgerPath, key, {
      ...entry, entityType: 'owner_notification_preference_restore', stableId: authority().smokeActorId,
      restore: { existed: true, inAppOptIn: 'yes', emailOptIn: true, updatedAt: 'bad', updatedBy: '' }
    }), /DEV_REFRESH_FIXTURE_LEDGER_OWNER_NOTIFICATION_RESTORE_INVALID/);
    const bytes = fs.readFileSync(ledgerPath);
    bytes[Math.floor(bytes.length / 2)] ^= 1;
    fs.writeFileSync(ledgerPath, bytes);
    bytes.fill(0);
    assert.throws(() => readFixtureLedger(ledgerPath, key), /DEV_REFRESH_FIXTURE_LEDGER_/);
  } finally {
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fixture ledger scopes duplicate identities by organization', () => {
  const root = temporaryRoot('dev-certified-ledger-tenant-identity-');
  const key = crypto.randomBytes(32);
  const ledgerPath = path.join(root, 'fixtures.private.jsonl');
  const firstOrganizationId = authority().primaryOrganizationId;
  const secondOrganizationId = '00000000-0000-4000-8000-000000000003';
  const entry = {
    workflow: GOLDEN_WORKFLOW_CONTRACT[17],
    entityType: 'membership',
    stableId: authority().smokeActorId,
    organizationId: firstOrganizationId,
    actorId: authority().smokeActorId
  };
  try {
    createFixtureLedger(ledgerPath, key, authority());
    appendFixtureId(ledgerPath, key, entry);
    appendFixtureId(ledgerPath, key, { ...entry, organizationId: secondOrganizationId });
    assert.equal(readFixtureLedger(ledgerPath, key).counts.membership, 2);
    assert.throws(
      () => appendFixtureId(ledgerPath, key, { ...entry, organizationId: secondOrganizationId }),
      /DEV_REFRESH_FIXTURE_LEDGER_ENTRY_INVALID/
    );
  } finally {
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('live operation inventories reject the synthetic worker even when correctly signed', () => {
  const root = temporaryRoot('dev-certified-operation-negative-');
  const key = crypto.randomBytes(32);
  const envPath = path.join(root, 'local.env');
  try {
    fs.writeFileSync(envPath, 'APP_ENV=dev\n', { mode: 0o600 });
    const operations = REQUIRED_OPERATION_STAGES.map((stage) => ({
      stage, runtime: 'node', executable: process.execPath, executableDigest: digestFile(process.execPath),
      script: SYNTHETIC_WORKER, scriptDigest: digestFile(SYNTHETIC_WORKER), cwd: REPO_ROOT,
      args: [], environmentNames: [], timeoutMs: 10_000
    }));
    assert.throws(() => buildOperationInventory({
      attemptId: authority().attemptId, envFileDigest: digestFile(envPath), operations
    }), /DEV_REFRESH_SYNTHETIC_WORKER_REJECTED/);
    const inventory = buildOperationInventory({
      attemptId: authority().attemptId, envFileDigest: digestFile(envPath), operations,
      testOnlyAllowSynthetic: true
    });
    const contract = buildCertifiedRefreshContract({
      attemptId: authority().attemptId,
      toolingCommit: '1'.repeat(40), toolingTree: '2'.repeat(40),
      goldenManifestDigest: `sha256:${'3'.repeat(64)}`,
      currentDevProfileDigest: `sha256:${'4'.repeat(64)}`,
      operationInventoryDigest: inventory.inventoryDigest
    });
    const signed = authenticateOperationInventory(inventory, key);
    assert.throws(() => verifyOperationInventory(signed, key, contract, envPath), /DEV_REFRESH_SYNTHETIC_WORKER_REJECTED/);
  } finally {
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('real stage source exposes all required operations and contains no Edge or platform mutator', () => {
  const source = fs.readFileSync(REAL_STAGE_WORKER, 'utf8');
  for (const stage of REQUIRED_OPERATION_STAGES) assert.match(source, new RegExp(`\\b${stage}:`));
  assert.doesNotMatch(source, /supabase\s+functions\s+deploy|projects\/[^\s]+\/config|updateAuthConfig|vercel\s+(?:deploy|--prod)/i);
  assert.match(source, /configurationMutations:\s*0/);
  assert.match(source, /deployments:\s*0/);
  const snapshotCapture = source.indexOf('const before = await captureCoreState(context.preparation, { client });');
  const snapshotRollback = source.indexOf("await client.query('rollback');", snapshotCapture);
  assert.ok(snapshotCapture > 0);
  assert.ok(snapshotRollback > snapshotCapture);
});

test('real disposable preparation, cutover, workflow cleanup, and Y2 recovery', {
  skip: process.env.RUN_ENV_SYNC_DISPOSABLE_E2E !== '1'
}, async () => {
  const retainedRoot = String(process.env.ENV_SYNC_RETAINED_ROOT || '');
  const postgresBin = String(process.env.POSTGRES_BIN || '');
  assert.ok(path.isAbsolute(retainedRoot) && path.isAbsolute(postgresBin));
  const root = temporaryRoot('dev-certified-real-e2e-');
  const key = crypto.randomBytes(32);
  let disposableRoot = '';
  let secondDisposableRoot = '';
  try {
    const keyPath = path.join(root, 'authority.private.bin');
    const envPath = path.join(root, 'synthetic.private.env');
    writePrivateBytesExclusive(keyPath, key);
    writePrivateBytesExclusive(envPath, Buffer.from(
      `APP_ENV=dev\nSUPABASE_URL=https://${DEV_PROJECT_REF}.supabase.co\n` +
      `DATABASE_URL=postgresql://postgres:synthetic@db.${DEV_PROJECT_REF}.supabase.co:5432/postgres\n`,
      'utf8'
    ));

    const runPreparation = async (name) => {
      const outputDirectory = path.join(root, name);
      const result = await prepareCertifiedDevRefresh({
        repoRoot: REPO_ROOT, envFilePath: envPath, authorityKeyPath: keyPath,
        retainedRoot, outputDirectory, disposable: true, postgresBin
      });
      assert.equal(result.realStageCount, 15);
      assert.equal(result.syntheticWorkerAbsent, true);
      const preparationRecord = privateJson(result.output.preparationPath);
      const preparation = preparationRecord.preparation;
      const session = preparation.targetBefore.session;
      const contractRecord = privateJson(result.output.contractPath);
      const inventoryRecord = privateJson(result.output.inventoryPath);
      const contract = verifyAuthenticatedCertifiedRefreshContract(contractRecord, key);
      const executor = createOperationExecutor({
        inventory: inventoryRecord, key, contract, envFilePath: envPath,
        evidenceDirectory: path.join(root, `${name}-evidence`)
      });
      return {
        result,
        preparation,
        session,
        contract,
        executor,
        contractPath: result.output.contractPath,
        inventoryPath: result.output.inventoryPath
      };
    };

    const cliArgs = (prepared, stateDirectory, evidenceDirectory, { recovery = false } = {}) => [
      '--apply', '--quiet-window-active',
      ...(recovery ? ['--recovery-authorized'] : []),
      '--env', envPath,
      '--authority-key', keyPath,
      '--contract', prepared.contractPath,
      '--operation-inventory', prepared.inventoryPath,
      '--state-dir', stateDirectory,
      '--evidence-dir', evidenceDirectory
    ];

    const forward = await runPreparation('forward-preparation');
    disposableRoot = forward.session.root;
    const retryRoot = createPrivateDirectory(path.join(root, 'browser-child-retry'));
    const retryResult = await runCertifiedWorkflowHarness({
      repoRoot: REPO_ROOT,
      connectionString: forward.session.connectionString,
      fixtureAuthority: forward.preparation.fixtureAuthority,
      rootDirectory: retryRoot,
      key,
      attemptId: forward.contract.attemptId,
      maxBrowserChildRetries: 1,
      testOnlyFailureInjection: 'browser_child_first_run_after_bootstrap'
    });
    assert.equal(retryResult.browserChildRetries, 1);
    await cleanupCertifiedWorkflowFixtures({
      connectionString: forward.session.connectionString,
      ledgerPath: retryResult.ledgerPath,
      key
    });
    assert.equal((await verifyCertifiedWorkflowCleanup({
      connectionString: forward.session.connectionString,
      ledgerPath: retryResult.ledgerPath,
      key
    })).fixtureResidue, 0);
    const forwardState = path.join(root, 'forward-state');
    let complete;
    try {
      complete = await runDevCertifiedCli(
        'refresh',
        cliArgs(forward, forwardState, path.join(root, 'forward-cli-evidence')),
        REPO_ROOT
      );
    } catch (error) {
      const failedStage = String(error?.failedStage || 'UNKNOWN_STAGE').replace(/[^A-Z0-9_]/gi, '_');
      const causeCategory = String(error?.causeCategory || error?.code || 'UNKNOWN_CAUSE').replace(/[^A-Z0-9_]/gi, '_');
      assert.fail(`DISPOSABLE_FORWARD_FAILED_${failedStage}_${causeCategory}`);
    }
    assert.equal(complete.classification, 'DEV_REFRESH_COMPLETE');
    assert.equal(readJournal(forwardState, key).current.state, 'COMPLETE');

    const recovery = await runPreparation('recovery-preparation');
    secondDisposableRoot = recovery.session.root;
    const recoveryState = path.join(root, 'recovery-state');
    const postCommitFailureExecutor = {
      async run(stage, context) {
        const evidence = await recovery.executor.run(stage, context);
        if (stage === 'DATABASE_CUTOVER') throw Object.assign(new Error('CERTIFIED_POST_COMMIT_FAILURE'), { code: 'CERTIFIED_POST_COMMIT_FAILURE' });
        return evidence;
      }
    };
    await assert.rejects(
      runDevCertifiedCli(
        'refresh',
        cliArgs(recovery, recoveryState, path.join(root, 'recovery-cli-evidence')),
        REPO_ROOT,
        { createOperationExecutorFn: () => postCommitFailureExecutor }
      ),
      /DEV_REFRESH_RECOVERY_REQUIRED/
    );
    assert.equal(readJournal(recoveryState, key).current.state, 'RECOVERY_REQUIRED');
    const recovered = await runDevCertifiedCli(
      'recover',
      cliArgs(
        recovery,
        recoveryState,
        path.join(root, 'recovery-cli-evidence'),
        { recovery: true }
      ),
      REPO_ROOT
    );
    assert.equal(recovered.classification, 'DEV_REFRESH_RECOVERED');
    assert.equal(readJournal(recoveryState, key).current.state, 'RECOVERED');
  } finally {
    if (disposableRoot) await removeRetainedDisposablePostgres({ rootDirectory: disposableRoot, postgresBin }).catch(() => {});
    if (secondDisposableRoot) await removeRetainedDisposablePostgres({ rootDirectory: secondDisposableRoot, postgresBin }).catch(() => {});
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
