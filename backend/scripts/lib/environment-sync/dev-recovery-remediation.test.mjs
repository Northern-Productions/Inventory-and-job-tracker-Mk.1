import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonicalDigest } from '../readonly-diagnostics.mjs';
import {
  DEV_PROJECT_REF,
  PROD_PROJECT_REF,
  SANDBOX_PROJECT_REF,
  sha256Bytes
} from './dev-certified-contract.mjs';
import { buildOperationFailure, verifyOperationFailure } from './dev-certified-operation-failure.mjs';
import { buildOperationInventory } from './dev-certified-operation-executor.mjs';
import {
  REMEDIATION_EVIDENCE_FORMAT,
  REMEDIATION_OPERATION_STAGES,
  assertRecoveryRemediationEvidence,
  authenticateRecoveryRemediationContract,
  buildRecoveryRemediationContract,
  normalizeOriginalBinding,
  verifyAuthenticatedRecoveryRemediationContract,
  verifyRecoveryRemediationContract
} from './dev-recovery-remediation-contract.mjs';
import {
  runDevRecoveryRemediation,
  runDevRecoveryRemediationRecovery
} from './dev-recovery-remediation-orchestrator.mjs';
import { runFreshAuthentication } from './dev-recovery-remediation-real-stage-worker.mjs';
import { assertRecoveryOwnedStateEqual } from './dev-recovery-remediation-shared.mjs';
import {
  appendRemediationEvent,
  readRemediationJournal,
  remediationRestartDisposition
} from './dev-recovery-remediation-state.mjs';
import { createPrivateDirectory, writePrivateBytesExclusive } from './private-artifacts.mjs';

const PREPARE_ENTRY = fileURLToPath(new URL('../../environment-prepare-dev-recovery-remediation-certified.mjs', import.meta.url));
const REMEDIATE_ENTRY = fileURLToPath(new URL('../../environment-remediate-dev-recovery-certified.mjs', import.meta.url));
const RECOVER_ENTRY = fileURLToPath(new URL('../../environment-recover-dev-recovery-remediation-certified.mjs', import.meta.url));
const RUNBOOK = fileURLToPath(new URL('../../../../docs/automation/nonprod-environment-sync.md', import.meta.url));
const TEST_WORKER = fileURLToPath(new URL('./dev-certified-test-worker.mjs', import.meta.url));

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex')}`;
}

function originalBinding() {
  return {
    refreshAttemptId: 'dev-refresh-20260828000000000-synthetic',
    y2RecoveryId: 'y2-dev-refresh-20260828000000000-synthetic',
    refreshContractDigest: digest('refresh-contract'),
    originalPreparationDigest: digest('preparation'),
    failedJournalDigest: digest('journal'),
    failedStateRecordDigest: digest('failed-state'),
    failedRecoveryMarkerDigest: digest('recovery-marker'),
    failedRecoveryInvocationDigest: digest('recovery-invocation'),
    recoveryState: 'RECOVERY_FAILED',
    retryAllowed: false
  };
}

function contract(attemptId = `dev-recovery-remediation-${crypto.randomBytes(8).toString('hex')}`) {
  const preparedAt = new Date(Date.now() - 1_000).toISOString();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  return buildRecoveryRemediationContract({
    remediationAttemptId: attemptId,
    toolingCommit: 'a'.repeat(40),
    toolingTree: 'b'.repeat(40),
    originalBinding: originalBinding(),
    observedDevCertificateDigest: digest('observed'),
    operationInventoryDigest: digest('inventory'),
    preparedAt,
    expiresAt
  });
}

function details(stage) {
  if (['REMEDIATION_PRECHECK', 'CURRENT_Y2_PARITY'].includes(stage)) {
    return { oldRecoveryFailedImmutable: true, currentEqualsOriginalY2: true };
  }
  if (stage === 'R3_CAPTURE') return { coherentSnapshot: true, encrypted: true, authenticatedKeyWrapped: true };
  if (stage === 'R3_VALIDATED') {
    return {
      r3RecoveryId: 'r3-dev-recovery-remediation-synthetic',
      r3ComponentDigest: digest('r3'),
      digestVerified: true,
      canonicalRestoreTested: true,
      currentEqualsR3: true,
      r3EqualsOriginalY2: true
    };
  }
  if (stage === 'RESTORE_ORIGINAL_Y2') return { originalY2Restored: true, transactionOutcome: 'committed' };
  if (stage === 'AUTH_RUNTIME_VERIFIED') {
    return { nativeSmokeActiveOwner: true, freshAuthentication: true, authContextOwner: true };
  }
  if (stage === 'APPLICATION_RUNTIME_VERIFIED') {
    return { inventoryRead: true, jobRead: true, boxRead: true, businessMutations: 0 };
  }
  if (stage === 'FINAL_Y2_PARITY') return { originalY2Exact: true, unexplainedDifferences: 0 };
  if (stage === 'REMEDIATION_RECOVERY_DATABASE') return { r3Restored: true, transactionOutcome: 'committed' };
  if (stage === 'REMEDIATION_RECOVERY_VERIFIED') return { r3Exact: true, unexplainedDifferences: 0 };
  return {};
}

function evidence(value, stage) {
  const stageDetails = details(stage);
  return {
    format: REMEDIATION_EVIDENCE_FORMAT,
    stage,
    attemptId: value.remediationAttemptId,
    target: 'dev',
    projectRef: DEV_PROJECT_REF,
    status: 'passed',
    contractDigest: value.contractDigest,
    safeCount: Object.keys(stageDetails).length,
    evidenceDigest: canonicalDigest(stageDetails),
    details: stageDetails
  };
}

function executor(value, failAt = '') {
  return {
    async run(stage) {
      if (stage === failAt) throw Object.assign(new Error('INJECTED_REMEDIATION_FAILURE'), {
        code: 'INJECTED_REMEDIATION_FAILURE',
        transactionOutcome: stage === 'RESTORE_ORIGINAL_Y2' ? 'ambiguous' : 'not_started'
      });
      return evidence(value, stage);
    }
  };
}

function temporaryRoot(label) {
  return path.join(os.tmpdir(), `${label}-${crypto.randomBytes(8).toString('hex')}`);
}

function spawnIsolated(entry, args, root) {
  const home = path.join(root, 'home');
  const temp = path.join(root, 'temp');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(temp, { recursive: true });
  return spawnSync(process.execPath, [entry, ...args], {
    shell: false,
    windowsHide: true,
    cwd: root,
    encoding: 'utf8',
    env: {
      SystemRoot: process.env.SystemRoot || '',
      WINDIR: process.env.WINDIR || '',
      HOME: home,
      USERPROFILE: home,
      TEMP: temp,
      TMP: temp
    }
  });
}

test('remediation contract is independently authenticated and binds the permanently failed recovery', () => {
  const key = crypto.randomBytes(32);
  try {
    const value = contract();
    assert.equal(verifyRecoveryRemediationContract(value), value);
    assert.equal(value.original.recoveryState, 'RECOVERY_FAILED');
    assert.equal(value.original.retryAllowed, false);
    assert.equal(value.restorePolicy.oldRecoveryStateMutable, false);
    assert.equal(value.restorePolicy.automaticRetry, false);
    assert.deepEqual(value.operationStages, REMEDIATION_OPERATION_STAGES);
    const signed = authenticateRecoveryRemediationContract(value, key);
    assert.equal(verifyAuthenticatedRecoveryRemediationContract(signed, key), value);
    const tampered = structuredClone(signed);
    tampered.contract.original.retryAllowed = true;
    assert.throws(() => verifyAuthenticatedRecoveryRemediationContract(tampered, key), {
      code: 'DEV_REMEDIATION_CONTRACT_AUTHENTICATION_FAILED'
    });
  } finally {
    key.fill(0);
  }
});

test('remediation target, failed-recovery, current-Y2, and R3 guards fail closed', () => {
  const value = contract();
  for (const projectRef of [PROD_PROJECT_REF, SANDBOX_PROJECT_REF]) {
    const wrongTarget = structuredClone(value);
    wrongTarget.target.projectRef = projectRef;
    assert.throws(() => verifyRecoveryRemediationContract(wrongTarget), {
      code: 'DEV_REMEDIATION_CONTRACT_MISMATCH'
    });
  }
  assert.throws(() => normalizeOriginalBinding({ ...originalBinding(), retryAllowed: true }), {
    code: 'DEV_REMEDIATION_ORIGINAL_RECOVERY_NOT_PERMANENTLY_FAILED'
  });
  assert.throws(() => assertRecoveryOwnedStateEqual(
    { application: { count: 1 } },
    { application: { count: 2 } }
  ), { code: 'DEV_REMEDIATION_CURRENT_Y2_MISMATCH' });
  const badR3 = evidence(value, 'R3_VALIDATED');
  badR3.details.currentEqualsR3 = false;
  badR3.evidenceDigest = canonicalDigest(badR3.details);
  assert.throws(() => assertRecoveryRemediationEvidence(badR3, {
    contract: value,
    stage: 'R3_VALIDATED'
  }), { code: 'DEV_REMEDIATION_R3_VALIDATION_INCOMPLETE' });
});

test('remediation completes in a separate lineage and is permanently one-shot', async () => {
  const root = temporaryRoot('dev-remediation-success');
  const key = crypto.randomBytes(32);
  const value = contract();
  try {
    const result = await runDevRecoveryRemediation({
      rootDirectory: root,
      key,
      contract: value,
      executor: executor(value)
    });
    assert.equal(result.classification, 'DEV_RECOVERY_REMEDIATION_COMPLETE');
    assert.equal(result.originalRecoveryState, 'RECOVERY_FAILED');
    const journal = readRemediationJournal(root, key);
    assert.equal(journal.current.state, 'REMEDIATION_COMPLETE');
    assert.equal(journal.current.transactionOutcome, 'committed');
    assert.equal(journal.marker.oldRecoveryMutable, false);
    assert.equal(journal.marker.reusable, false);
    assert.equal(remediationRestartDisposition(root, key), 'REMEDIATION_COMPLETE');
    await assert.rejects(runDevRecoveryRemediation({
      rootDirectory: root,
      key,
      contract: value,
      executor: executor(value)
    }));
    await assert.rejects(runDevRecoveryRemediationRecovery({
      rootDirectory: root,
      key,
      contract: value,
      executor: executor(value)
    }), { code: 'DEV_REMEDIATION_RECOVERY_NOT_PERMITTED' });
  } finally {
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pre-boundary remediation failure is terminal without creating a marker', async () => {
  const root = temporaryRoot('dev-remediation-pre-boundary');
  const key = crypto.randomBytes(32);
  const value = contract();
  try {
    await assert.rejects(runDevRecoveryRemediation({
      rootDirectory: root,
      key,
      contract: value,
      executor: executor(value, 'R3_VALIDATED')
    }), { code: 'INJECTED_REMEDIATION_FAILURE' });
    const journal = readRemediationJournal(root, key);
    assert.equal(journal.current.state, 'FAILED_PRE_MUTATION');
    assert.equal(journal.marker, null);
    assert.equal(journal.boundary, null);
    assert.equal(journal.recovery, null);
  } finally {
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('post-boundary failure requires separate one-shot R3 recovery', async () => {
  const root = temporaryRoot('dev-remediation-post-boundary');
  const key = crypto.randomBytes(32);
  const value = contract();
  try {
    await assert.rejects(runDevRecoveryRemediation({
      rootDirectory: root,
      key,
      contract: value,
      executor: executor(value, 'AUTH_RUNTIME_VERIFIED')
    }), (error) => error.code === 'DEV_REMEDIATION_RECOVERY_REQUIRED' && error.transactionOutcome === 'committed');
    let journal = readRemediationJournal(root, key);
    assert.equal(journal.current.state, 'REMEDIATION_RECOVERY_REQUIRED');
    assert.equal(journal.current.transactionOutcome, 'committed');
    const recovered = await runDevRecoveryRemediationRecovery({
      rootDirectory: root,
      key,
      contract: value,
      executor: executor(value)
    });
    assert.equal(recovered.classification, 'DEV_RECOVERY_REMEDIATION_R3_RECOVERED');
    journal = readRemediationJournal(root, key);
    assert.equal(journal.current.state, 'REMEDIATION_RECOVERED');
    assert.equal(journal.recovery.retryAllowed, false);
    await assert.rejects(runDevRecoveryRemediationRecovery({
      rootDirectory: root,
      key,
      contract: value,
      executor: executor(value)
    }), { code: 'DEV_REMEDIATION_RECOVERY_NOT_PERMITTED' });
  } finally {
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('authenticated operation failure v2 preserves transaction outcome and v1 remains accepted', () => {
  const expected = {
    stage: 'RESTORE_ORIGINAL_Y2',
    attemptId: 'dev-recovery-remediation-synthetic',
    target: 'dev',
    projectRef: DEV_PROJECT_REF,
    contractDigest: digest('contract')
  };
  const error = Object.assign(new Error('MANAGED_OVERLAY_EXECUTION_FAILED'), {
    code: 'MANAGED_OVERLAY_EXECUTION_FAILED',
    failureSubstep: 'MANAGED_OVERLAY_EXECUTION',
    transactionOutcome: 'ambiguous',
    safeDiagnostic: {
      classification: 'POSTGRES_CHILD_FAILED', sqlState: '08006', statementCategory: 'DDL',
      exitCode: 2, signal: '', overflow: false, excerpt: 'connection failure'
    }
  });
  const failure = buildOperationFailure({ ...expected, error });
  assert.equal(failure.cause.format, 'dev-certified-operation-cause-v2');
  assert.equal(failure.cause.transactionOutcome, 'ambiguous');
  assert.equal(verifyOperationFailure(failure, expected), failure);
});

test('custom remediation operation inventory is exact and synthetic workers remain rejected', () => {
  const root = temporaryRoot('dev-remediation-inventory');
  const envPath = path.join(root, 'synthetic.env');
  fs.mkdirSync(root, { recursive: true });
  writePrivateBytesExclusive(envPath, Buffer.from('APP_ENV=dev\n', 'utf8'));
  const executableBytes = fs.readFileSync(process.execPath);
  const workerBytes = fs.readFileSync(TEST_WORKER);
  try {
    const operations = REMEDIATION_OPERATION_STAGES.map((stage) => ({
      stage,
      runtime: 'node',
      executable: process.execPath,
      executableDigest: sha256Bytes(executableBytes),
      script: TEST_WORKER,
      scriptDigest: sha256Bytes(workerBytes),
      cwd: root,
      args: ['operation'],
      environmentNames: [],
      timeoutMs: 10_000
    }));
    assert.throws(() => buildOperationInventory({
      attemptId: contract().attemptId,
      envFileDigest: digest('env'),
      operations,
      requiredStages: REMEDIATION_OPERATION_STAGES
    }), { code: 'DEV_REFRESH_SYNTHETIC_WORKER_REJECTED' });
    const accepted = buildOperationInventory({
      attemptId: contract().attemptId,
      envFileDigest: digest('env'),
      operations,
      requiredStages: REMEDIATION_OPERATION_STAGES,
      testOnlyAllowSynthetic: true
    });
    assert.deepEqual(accepted.operations.map((operation) => operation.stage), REMEDIATION_OPERATION_STAGES);
  } finally {
    executableBytes.fill(0);
    workerBytes.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('operation events are append-only, authenticated, and transaction-outcome bounded', async () => {
  const root = temporaryRoot('dev-remediation-events');
  const key = crypto.randomBytes(32);
  const value = contract();
  try {
    await assert.rejects(runDevRecoveryRemediation({
      rootDirectory: root,
      key,
      contract: value,
      executor: executor(value, 'AUTH_RUNTIME_VERIFIED')
    }));
    const first = appendRemediationEvent(root, key, {
      stage: 'RESTORE_ORIGINAL_Y2',
      substep: 'TRANSACTION_COMMITTED',
      transactionOutcome: 'committed',
      details: { exitCode: 0 }
    });
    const second = appendRemediationEvent(root, key, {
      stage: 'FINAL_Y2_PARITY',
      substep: 'RESULT_PUBLISHED',
      transactionOutcome: 'committed',
      details: { accepted: true }
    });
    assert.equal(first.sequence, 0);
    assert.equal(second.sequence, 1);
    assert.equal(second.previousDigest, canonicalDigest(first));
    assert.throws(() => appendRemediationEvent(root, key, {
      stage: 'FINAL_Y2_PARITY', substep: 'INVALID', transactionOutcome: 'unknown'
    }), { code: 'DEV_REMEDIATION_EVENT_INVALID' });
  } finally {
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fresh authentication uses only the guarded endpoint and performs read-only application calls', async () => {
  const seen = [];
  const server = http.createServer(async (request, response) => {
    seen.push(`${request.method} ${new URL(request.url, 'http://localhost').pathname}`);
    response.setHeader('content-type', 'application/json');
    if (request.url.startsWith('/auth/v1/token')) {
      response.end(JSON.stringify({ access_token: 'local-access', refresh_token: 'local-refresh' }));
      return;
    }
    if (request.url === '/auth/v1/logout') {
      response.end('{}');
      return;
    }
    if (request.url === '/auth/context') {
      response.end(JSON.stringify({ data: { role: 'owner', defaultWarehouse: 'LOCAL' } }));
      return;
    }
    response.end(JSON.stringify({ data: [] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const previous = Object.fromEntries([
    'SUPABASE_URL', 'EDGE_API_BASE_URL', 'SUPABASE_ANON_KEY', 'SMOKE_USER_EMAIL', 'SMOKE_USER_PASSWORD'
  ].map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    SUPABASE_URL: origin,
    EDGE_API_BASE_URL: origin,
    SUPABASE_ANON_KEY: 'local-anon',
    SMOKE_USER_EMAIL: 'local@example.invalid',
    SMOKE_USER_PASSWORD: 'local-only'
  });
  try {
    const result = await runFreshAuthentication({ preparation: { mode: 'disposable-managed-local' } });
    assert.equal(result.freshAuthentication, true);
    assert.equal(result.authContextOwner, true);
    assert.equal(result.inventoryRead, true);
    assert.equal(result.jobRead, true);
    assert.equal(result.boxRead, true);
    assert.equal(result.sessionRevoked, true);
    assert.deepEqual(seen, [
      'POST /auth/v1/token', 'GET /auth/context', 'GET /jobs/list', 'GET /boxes/search', 'POST /auth/v1/logout'
    ]);
    process.env.SUPABASE_URL = 'https://example.com';
    await assert.rejects(runFreshAuthentication({ preparation: { mode: 'disposable-managed-local' } }), {
      code: 'DEV_REMEDIATION_AUTH_NETWORK_TARGET_REJECTED'
    });
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await new Promise((resolve) => server.close(resolve));
  }
});

test('all remediation CLI entrypoints guard before repository-local imports and private path access', () => {
  const root = temporaryRoot('dev-remediation-cli');
  fs.mkdirSync(root, { recursive: true });
  try {
    for (const entry of [PREPARE_ENTRY, REMEDIATE_ENTRY, RECOVER_ENTRY]) {
      const source = fs.readFileSync(entry, 'utf8');
      const staticImports = [...source.matchAll(/^import .*? from '([^']+)';$/gm)].map((match) => match[1]);
      assert.ok(staticImports.length > 0);
      assert.ok(staticImports.every((specifier) => specifier.startsWith('node:')));
      assert.ok(source.indexOf('preparse(') < source.indexOf("await import('./lib/environment-sync/"));
      const help = spawnIsolated(entry, ['--help'], root);
      assert.equal(help.status, 0);
      assert.match(help.stdout, /^Usage:/);
      const missing = spawnIsolated(entry, [], root);
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /DEV_REMEDIATION_/);
      assert.doesNotMatch(missing.stderr, /authority|contract|state-dir|evidence-dir/i);
    }
    assert.deepEqual(fs.readdirSync(root).sort(), ['home', 'temp']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('preparation source is read-only against shared DEV and defers R3 creation to execution', () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL('./dev-recovery-remediation-preparation.mjs', import.meta.url)),
    'utf8'
  );
  assert.match(source, /captureRecoveryOwnedState/);
  assert.match(source, /sharedMutationsDuringPreparation:\s*0/);
  assert.doesNotMatch(source, /captureEncryptedPgDump|executeManagedOverlayPackage|R3_CAPTURE/);
  assert.doesNotMatch(source, /\b(?:insert|update|delete|truncate|alter table|drop schema)\b/i);
});

test('remediation runbook passes the signed preparation artifact to both one-shot commands', () => {
  const source = fs.readFileSync(RUNBOOK, 'utf8');
  for (const command of [
    'env:remediate-dev-recovery-certified',
    'env:recover-dev-recovery-remediation-certified'
  ]) {
    const line = source.split(/\r?\n/).find((candidate) => candidate.includes(command));
    assert.ok(line, `${command} must be documented`);
    assert.match(line, / --preparation <[^>]+>/);
  }
});
