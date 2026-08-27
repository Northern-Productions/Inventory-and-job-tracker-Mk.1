import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonicalDigest } from '../readonly-diagnostics.mjs';
import {
  buildCertifiedRefreshContract,
  sha256Bytes,
  verifyAuthenticatedCertifiedRefreshContract
} from './dev-certified-contract.mjs';
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
import { readJournal } from './dev-certified-state.mjs';
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
    writePrivateBytesExclusive(envPath, Buffer.from('APP_ENV=dev\n', 'utf8'));

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
      return { result, preparation, session, contract, executor };
    };

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
      complete = await runCertifiedDevRefresh({
        rootDirectory: forwardState, key, contract: forward.contract, executor: forward.executor
      });
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
      runCertifiedDevRefresh({
        rootDirectory: recoveryState, key, contract: recovery.contract,
        executor: postCommitFailureExecutor
      }),
      /DEV_REFRESH_RECOVERY_REQUIRED/
    );
    assert.equal(readJournal(recoveryState, key).current.state, 'RECOVERY_REQUIRED');
    const recovered = await runCertifiedDevRecovery({
      rootDirectory: recoveryState, key, contract: recovery.contract,
      executor: recovery.executor
    });
    assert.equal(recovered.classification, 'DEV_REFRESH_RECOVERED');
    assert.equal(readJournal(recoveryState, key).current.state, 'RECOVERED');
  } finally {
    if (disposableRoot) await removeRetainedDisposablePostgres({ rootDirectory: disposableRoot, postgresBin }).catch(() => {});
    if (secondDisposableRoot) await removeRetainedDisposablePostgres({ rootDirectory: secondDisposableRoot, postgresBin }).catch(() => {});
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
