import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonicalDigest, canonicalSerialize } from '../readonly-diagnostics.mjs';
import {
  DEV_PROJECT_REF,
  PROD_PROJECT_REF,
  SANDBOX_PROJECT_REF,
  authenticateCertifiedRefreshContract,
  buildCertifiedRefreshContract,
  sha256Bytes
} from './dev-certified-contract.mjs';
import { buildOperationFailure, verifyOperationFailure } from './dev-certified-operation-failure.mjs';
import {
  REQUIRED_OPERATION_STAGES,
  authenticateOperationInventory,
  buildOperationInventory
} from './dev-certified-operation-executor.mjs';
import {
  REAL_STAGE_WORKER,
  authenticatePreparation,
  verifyHistoricalPreparation,
  verifyPreparation
} from './dev-certified-preparation.mjs';
import {
  CURRENT_REMEDIATION_WORKER_REPO_PATH,
  REMEDIATION_EVIDENCE_FORMAT,
  REMEDIATION_OPERATION_STAGES,
  REMEDIATION_READ_ONLY_ROUTES,
  REMEDIATION_STAGE_INPUT_CENSUS,
  REMEDIATION_PROVENANCE_FIX_BASE_COMMIT,
  assertRecoveryRemediationContractFresh,
  assertRecoveryRemediationEvidence,
  authenticateRecoveryRemediationContract,
  buildRemediationProvenanceBridge,
  buildRecoveryRemediationContract,
  normalizeOriginalBinding,
  remediationStageEnvironmentNames,
  verifyAuthenticatedRecoveryRemediationContract,
  verifyRecoveryRemediationContract
} from './dev-recovery-remediation-contract.mjs';
import {
  runDevRecoveryRemediation,
  runDevRecoveryRemediationRecovery
} from './dev-recovery-remediation-orchestrator.mjs';
import {
  disposableLoopbackOverlayGuard,
  managedDevOverlayGuard,
  remediationDatabaseOverlayGuard,
  runFreshAuthentication
} from './dev-recovery-remediation-real-stage-worker.mjs';
import {
  REMEDIATION_REAL_STAGE_WORKER,
  assertFreshAuthConfiguration,
  authenticateRemediationPreparation,
  verifyFrozenRemediationPreparation,
  verifyRemediationPreparation
} from './dev-recovery-remediation-preparation.mjs';
import { assertRecoveryOwnedStateEqual } from './dev-recovery-remediation-shared.mjs';
import {
  assertOverlayExecutionGuard,
  executeManagedOverlayPackage
} from './managed-restore.mjs';
import {
  appendRemediationAuthCanaryState,
  appendRemediationEvent,
  authCanaryUnresolved,
  beginRemediationAuthCanary,
  freezeRemediationAuthCanaryAllowance,
  initializeRemediationJournal,
  readRemediationAuthCanaries,
  readRemediationJournal,
  reconcileRemediationAuthCanary,
  remediationAuthCanaryDisposition,
  remediationRestartDisposition
} from './dev-recovery-remediation-state.mjs';
import { createPrivateDirectory, writePrivateBytesExclusive } from './private-artifacts.mjs';

const PREPARE_ENTRY = fileURLToPath(new URL('../../environment-prepare-dev-recovery-remediation-certified.mjs', import.meta.url));
const REMEDIATE_ENTRY = fileURLToPath(new URL('../../environment-remediate-dev-recovery-certified.mjs', import.meta.url));
const RECOVER_ENTRY = fileURLToPath(new URL('../../environment-recover-dev-recovery-remediation-certified.mjs', import.meta.url));
const RUNBOOK = fileURLToPath(new URL('../../../../docs/automation/nonprod-environment-sync.md', import.meta.url));
const CI_WORKFLOW = fileURLToPath(new URL('../../../../.github/workflows/ci.yml', import.meta.url));
const TEST_WORKER = fileURLToPath(new URL('./dev-certified-test-worker.mjs', import.meta.url));
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const HISTORICAL_TOOLING_COMMIT = 'ecdde2894b28300f8cb90ac8cb44e46509c09577';
const REFRESH_WORKER_REPO_PATH = 'backend/scripts/lib/environment-sync/dev-certified-real-stage-worker.mjs';
const REFRESH_SYNTHETIC_REPO_PATH = 'backend/scripts/lib/environment-sync/dev-certified-test-worker.mjs';

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex')}`;
}

test('CI materializes complete history required by immutable provenance checks', () => {
  const workflow = fs.readFileSync(CI_WORKFLOW, 'utf8');
  const checkoutSteps = workflow.split('uses: actions/checkout@v4').slice(1);
  assert.equal(checkoutSteps.length, 2);
  for (const step of checkoutSteps) {
    assert.match(step.split('- name:', 1)[0], /fetch-depth:\s*0/);
  }
});

function syntheticAccessToken(userId, sessionId) {
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, session_id: sessionId })}.synthetic`;
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

function contract(
  attemptId = `dev-recovery-remediation-${crypto.randomBytes(8).toString('hex')}`,
  {
    preparedAt = new Date(Date.now() - 1_000).toISOString(),
    expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  } = {}
) {
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
    return {
      oldRecoveryFailedImmutable: true,
      currentEqualsOriginalY2: true,
      ...(stage === 'REMEDIATION_PRECHECK' ? {
        realQuietWindow: true,
        freshEdgeExact: true,
        freshSideEffectsSafe: true,
        freshAuthentication: true,
        smokeUserExact: true,
        smokeOrganizationExact: true,
        defaultWarehouseExact: true,
        filmCatalogReadSucceeded: true,
        boxSearchReadSucceeded: true,
        jobsReadSucceeded: true,
        authSemanticParity: true
      } : {})
    };
  }
  if (stage === 'R3_CAPTURE') return { coherentSnapshot: true, encrypted: true, authenticatedKeyWrapped: true };
  if (stage === 'R3_VALIDATED') {
    return {
      preparationDigest: digest('preparation'),
      operationInventoryDigest: digest('inventory-placeholder'),
      stageWorkerDigest: digest('worker'),
      r3RecoveryId: 'r3-dev-recovery-remediation-synthetic',
      r3ComponentDigest: digest('r3'),
      r3RecoveryPackageDigest: digest('r3-package'),
      originalY2RecoveryPackageDigest: digest('original-y2-package'),
      r3StageBindingDigest: digest('r3-stage'),
      digestVerified: true,
      canonicalRestoreTested: true,
      currentEqualsR3: true,
      r3EqualsOriginalY2: true,
      authMutationScope: 'preserve-target-native-auth',
      realQuietWindowRechecked: true,
      freshEdgeRechecked: true,
      freshSideEffectsRechecked: true,
      recoveryPackageAuthenticated: true,
      originalY2PackageAuthenticated: true,
      finalSemanticAuthExact: true,
      nativeSmokeActiveOwner: true,
      rawMetadataMarker: true,
      identityMetadataMarker: true,
      providerCredentialDigestsExact: true,
      selectedOrganizationExact: true,
      signedDefaultWarehouseExact: true,
      copiedUsersExact: true,
      copiedIdentitiesExact: true
    };
  }
  if (stage === 'RESTORE_ORIGINAL_Y2') return { originalY2Restored: true, transactionOutcome: 'committed' };
  if (stage === 'AUTH_RUNTIME_VERIFIED') {
    return {
      nativeSmokeActiveOwner: true,
      freshAuthentication: true,
      authContextOwner: true,
      smokeUserExact: true,
      smokeOrganizationExact: true,
      defaultWarehouseExact: true,
      filmCatalogReadSucceeded: true,
      boxSearchReadSucceeded: true,
      jobsReadSucceeded: true,
      authSemanticParity: true,
      boundedEphemera: true,
      copiedUsersExact: true,
      copiedIdentitiesExact: true,
      sessionRevoked: true,
      ephemeralSessionException: false
    };
  }
  if (stage === 'APPLICATION_RUNTIME_VERIFIED') {
    return {
      readOnlyApiSucceeded: true,
      filmCatalogReadSucceeded: true,
      boxSearchReadSucceeded: true,
      jobsReadSucceeded: true,
      businessMutations: 0
    };
  }
  if (stage === 'FINAL_Y2_PARITY') return {
    originalY2Exact: true,
    unexplainedDifferences: 0,
    authSemanticParity: true,
    boundedEphemera: true,
    sessionRevoked: true
  };
  if (stage === 'REMEDIATION_RECOVERY_PRECHECK') return {
    targetExact: true,
    exactAttemptAndR3Binding: true,
    recoveryRequiredStateExact: true,
    noExistingRecoveryInvocation: true,
    retainedRecoveryPackageAuthenticated: true,
    realQuietWindow: true,
    activeClients: 0,
    idleInTransaction: 0,
    lockWaiters: 0,
    writeShaped: 0,
    freshEdgeExact: true,
    freshSideEffectsSafe: true,
    recoverablePlaneExact: true,
    authSemanticParity: true,
    sharedMutations: 0
  };
  if (stage === 'REMEDIATION_RECOVERY_DATABASE') return {
    r3Restored: true,
    transactionOutcome: 'committed',
    retainedPackageUsed: true,
    databaseStateReconciled: false,
    commitDirectlyObserved: true
  };
  if (stage === 'REMEDIATION_RECOVERY_VERIFIED') return {
    r3Exact: true,
    unexplainedDifferences: 0,
    freshAuthentication: true,
    smokeUserExact: true,
    smokeOrganizationExact: true,
    defaultWarehouseExact: true,
    filmCatalogReadSucceeded: true,
    boxSearchReadSucceeded: true,
    jobsReadSucceeded: true,
    readOnlyApiSucceeded: true,
    authSemanticParity: true,
    boundedEphemera: true,
    sessionRevoked: true,
    ephemeralSessionException: false
  };
  return {};
}

function evidence(value, stage) {
  const stageDetails = details(stage);
  if (stage === 'R3_VALIDATED') {
    stageDetails.operationInventoryDigest = value.operationInventoryDigest;
    if (value.version === 2) {
      stageDetails.stageWorkerDigest = value.provenanceBridge.currentExecution.workerDigest;
    }
  }
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

async function createRecoveryRequiredState(rootDirectory, key, value) {
  await assert.rejects(runDevRecoveryRemediation({
    rootDirectory,
    key,
    contract: value,
    executor: executor(value, 'AUTH_RUNTIME_VERIFIED')
  }), { code: 'DEV_REMEDIATION_RECOVERY_REQUIRED' });
}

function remediationPreparationRecord(value, key, { attemptId = value.remediationAttemptId } = {}) {
  const workerBytes = fs.readFileSync(REMEDIATION_REAL_STAGE_WORKER);
  const syntheticBytes = fs.readFileSync(TEST_WORKER);
  try {
    const preparation = {
      format: 'dev-recovery-remediation-preparation-v1',
      version: 1,
      remediationAttemptId: attemptId,
      target: { environment: 'dev', projectRef: DEV_PROJECT_REF },
      candidate: value.candidate,
      original: { binding: value.original },
      currentObserved: { value: true },
      operationInventoryDigest: value.operationInventoryDigest,
      stageWorker: {
        path: path.resolve(REMEDIATION_REAL_STAGE_WORKER),
        digest: sha256Bytes(workerBytes),
        rejectedSyntheticWorkerDigest: sha256Bytes(syntheticBytes),
        syntheticWorkerAllowed: false
      },
      expiresAt: value.expiresAt
    };
    preparation.currentObserved.certificateDigest = canonicalDigest({ value: true });
    return authenticateRemediationPreparation(preparation, key);
  } finally {
    workerBytes.fill(0);
    syntheticBytes.fill(0);
  }
}

function executorForPreparation(value, preparationRecord, failAt = '') {
  return {
    async run(stage) {
      if (stage === failAt) {
        throw Object.assign(new Error('INJECTED_REMEDIATION_FAILURE'), {
          code: 'INJECTED_REMEDIATION_FAILURE',
          transactionOutcome: stage === 'RESTORE_ORIGINAL_Y2' ? 'ambiguous' : 'not_started'
        });
      }
      const result = evidence(value, stage);
      if (stage === 'R3_VALIDATED') {
        result.details.preparationDigest = canonicalDigest(preparationRecord.preparation);
        result.details.stageWorkerDigest = preparationRecord.preparation.stageWorker.digest;
        result.evidenceDigest = canonicalDigest(result.details);
      }
      return result;
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

function gitBytes(commit, repoPath) {
  return execFileSync('git', ['show', `${commit}:${repoPath}`], {
    cwd: REPO_ROOT,
    encoding: null,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  });
}

function gitIdentity(commit, suffix = 'commit') {
  return execFileSync('git', ['rev-parse', `${commit}^{${suffix}}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim();
}

function historicalRefreshArtifacts(key, {
  historicalCommit = HISTORICAL_TOOLING_COMMIT,
  historicalTree = gitIdentity(historicalCommit, 'tree'),
  workerDigestOverride = ''
} = {}) {
  const attemptId = 'dev-refresh-20260828181151989-synthetic';
  const workerBytes = gitBytes(historicalCommit, REFRESH_WORKER_REPO_PATH);
  const syntheticBytes = gitBytes(historicalCommit, REFRESH_SYNTHETIC_REPO_PATH);
  const executableBytes = fs.readFileSync(process.execPath);
  try {
    const workerDigest = workerDigestOverride || sha256Bytes(workerBytes);
    const operations = REQUIRED_OPERATION_STAGES.map((stage) => ({
      stage,
      runtime: 'node',
      executable: process.execPath,
      executableDigest: sha256Bytes(executableBytes),
      script: path.resolve(REAL_STAGE_WORKER),
      scriptDigest: workerDigest,
      cwd: REPO_ROOT,
      args: ['--preparation', path.join(REPO_ROOT, 'historical-preparation.private.json')],
      environmentNames: [],
      timeoutMs: 30 * 60 * 1000
    }));
    const inventory = buildOperationInventory({
      attemptId,
      envFileDigest: digest('historical-env'),
      operations
    });
    const contractValue = buildCertifiedRefreshContract({
      attemptId,
      toolingCommit: historicalCommit,
      toolingTree: historicalTree,
      goldenManifestDigest: digest('golden'),
      currentDevProfileDigest: digest('profile'),
      operationInventoryDigest: inventory.inventoryDigest
    });
    const preparation = {
      format: 'dev-certified-preparation-v1',
      version: 1,
      attemptId,
      mode: 'managed-dev',
      target: { environment: 'dev', projectRef: DEV_PROJECT_REF },
      candidate: contractValue.candidate,
      sideEffects: { mutationAllowed: false },
      edge: { deploymentPolicy: 'read-only-no-deploy' },
      fixtureAuthority: { cleanupAuthority: 'exact-authenticated-ledger-only' },
      stageWorker: {
        path: path.resolve(REAL_STAGE_WORKER),
        digest: workerDigest,
        syntheticWorkerDigest: sha256Bytes(syntheticBytes),
        syntheticWorkerAllowed: false
      }
    };
    return {
      attemptId,
      preparation,
      preparationRecord: authenticatePreparation(preparation, key),
      contract: contractValue,
      contractRecord: authenticateCertifiedRefreshContract(contractValue, key),
      inventory,
      inventoryRecord: authenticateOperationInventory(inventory, key)
    };
  } finally {
    workerBytes.fill(0);
    syntheticBytes.fill(0);
    executableBytes.fill(0);
  }
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
    assert.deepEqual(value.functionalVerification.readOnlyRoutes, REMEDIATION_READ_ONLY_ROUTES);
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

test('Auth canary unresolved classification depends only on authenticated reconciliation', () => {
  for (const state of [
    'CANARY_NOT_STARTED',
    'LOGIN_STARTED',
    'LOGIN_SUCCEEDED',
    'LOGOUT_ATTEMPTED',
    'LOGOUT_SUCCEEDED',
    'BOUNDED_EPHEMERA_POSSIBLE',
    'CANARY_COMPLETE'
  ]) {
    for (const allowance of [
      null,
      { sessions: [], refreshTokens: [] },
      { sessions: ['attempt-owned-session'], refreshTokens: ['attempt-owned-refresh'] }
    ]) assert.equal(authCanaryUnresolved({ current: { state }, allowance }), true);
  }
  assert.equal(authCanaryUnresolved({
    current: { state: 'EPHEMERA_RECONCILED' },
    allowance: { sessions: ['historical-private-session'], refreshTokens: [] }
  }), false);
});

test('all eleven remediation stages have an exact least-privilege input census', () => {
  assert.deepEqual(Object.keys(REMEDIATION_STAGE_INPUT_CENSUS), REMEDIATION_OPERATION_STAGES);
  const expectedManaged = {
    REMEDIATION_PRECHECK: [
      'EDGE_API_BASE_URL', 'SMOKE_USER_EMAIL', 'SMOKE_USER_PASSWORD', 'SUPABASE_ACCESS_TOKEN',
      'SUPABASE_ANON_KEY', 'SUPABASE_URL'
    ],
    CURRENT_Y2_PARITY: [],
    R3_CAPTURE: [],
    R3_VALIDATED: ['EDGE_API_BASE_URL', 'SUPABASE_ACCESS_TOKEN', 'SUPABASE_URL'],
    RESTORE_ORIGINAL_Y2: [],
    AUTH_RUNTIME_VERIFIED: [
      'EDGE_API_BASE_URL', 'SMOKE_USER_EMAIL', 'SMOKE_USER_PASSWORD', 'SUPABASE_ACCESS_TOKEN',
      'SUPABASE_ANON_KEY', 'SUPABASE_URL'
    ],
    APPLICATION_RUNTIME_VERIFIED: [],
    FINAL_Y2_PARITY: [],
    REMEDIATION_RECOVERY_PRECHECK: ['EDGE_API_BASE_URL', 'SUPABASE_ACCESS_TOKEN', 'SUPABASE_URL'],
    REMEDIATION_RECOVERY_DATABASE: ['EDGE_API_BASE_URL', 'SUPABASE_ACCESS_TOKEN', 'SUPABASE_URL'],
    REMEDIATION_RECOVERY_VERIFIED: [
      'EDGE_API_BASE_URL', 'SMOKE_USER_EMAIL', 'SMOKE_USER_PASSWORD', 'SUPABASE_ACCESS_TOKEN',
      'SUPABASE_ANON_KEY', 'SUPABASE_URL'
    ]
  };
  for (const stage of REMEDIATION_OPERATION_STAGES) {
    const entry = REMEDIATION_STAGE_INPUT_CENSUS[stage];
    assert.deepEqual(remediationStageEnvironmentNames(stage), expectedManaged[stage]);
    assert.ok(entry.privateInputs.length > 0);
    assert.ok(entry.databaseMode);
    assert.ok(entry.expectedTargetState);
    assert.ok(entry.mutationCapability);
    assert.ok(entry.failureDisposition);
    assert.ok(entry.recoveryDependency);
  }
  assert.deepEqual(remediationStageEnvironmentNames('REMEDIATION_PRECHECK', { disposable: true }), [
    'EDGE_API_BASE_URL', 'SMOKE_USER_EMAIL', 'SMOKE_USER_PASSWORD', 'SUPABASE_ANON_KEY', 'SUPABASE_URL'
  ]);
  assert.deepEqual(remediationStageEnvironmentNames('R3_VALIDATED', { disposable: true }), [
    'EDGE_API_BASE_URL', 'SUPABASE_URL'
  ]);
  assert.deepEqual(remediationStageEnvironmentNames('REMEDIATION_RECOVERY_DATABASE', { disposable: true }), [
    'EDGE_API_BASE_URL', 'SUPABASE_URL'
  ]);
  assert.throws(() => remediationStageEnvironmentNames('UNKNOWN'), {
    code: 'DEV_REMEDIATION_OPERATION_STAGE_INVALID'
  });
});

test('managed preparation requires management authority while disposable preparation does not', () => {
  const base = {
    SUPABASE_URL: `https://${DEV_PROJECT_REF}.supabase.co`,
    EDGE_API_BASE_URL: `https://${DEV_PROJECT_REF}.supabase.co/functions/v1/api`,
    SUPABASE_ANON_KEY: 'local-only',
    SMOKE_USER_EMAIL: 'local@example.invalid',
    SMOKE_USER_PASSWORD: 'local-only'
  };
  assert.throws(() => assertFreshAuthConfiguration(base), {
    code: 'DEV_REMEDIATION_MANAGEMENT_TOKEN_MISSING'
  });
  assert.doesNotThrow(() => assertFreshAuthConfiguration({
    ...base,
    SUPABASE_ACCESS_TOKEN: 'local-only-management-authority'
  }));
  assert.doesNotThrow(() => assertFreshAuthConfiguration({
    ...base,
    SUPABASE_URL: 'http://127.0.0.1:54321',
    EDGE_API_BASE_URL: 'http://127.0.0.1:54321/functions/v1/api'
  }, { disposable: true }));
});

test('remediation overlay guards are selected by the actual mutation destination', async () => {
  const loopback = 'postgresql://postgres:local@127.0.0.1:5432/postgres?sslmode=disable';
  const managedDev = `postgresql://postgres:synthetic@db.${DEV_PROJECT_REF}.supabase.co:5432/postgres?sslmode=require`;
  const managedSandbox = `postgresql://postgres:synthetic@db.${SANDBOX_PROJECT_REF}.supabase.co:5432/postgres?sslmode=require`;
  const managedProd = `postgresql://postgres:synthetic@db.${PROD_PROJECT_REF}.supabase.co:5432/postgres?sslmode=require`;
  const packageResult = {
    targetCompatibility: {
      authShapeDigest: digest('auth-shape'),
      catalogDigest: digest('catalog'),
      managedProfileDigest: digest('profile'),
      managedProfileId: 'dev-managed-profile-v1',
      managedProfileTarget: { environment: 'dev', projectRef: DEV_PROJECT_REF },
      managedProfileSecurityDigest: digest('profile-security'),
      applicationReplacementDigest: digest('application-replacement')
    },
    manifest: { planDigest: digest('restore-plan') }
  };
  const localGuard = disposableLoopbackOverlayGuard();
  const devGuard = managedDevOverlayGuard(packageResult);

  assert.deepEqual(
    assertOverlayExecutionGuard(loopback, localGuard),
    { target: 'local', projectRef: '', loopback: true }
  );
  assert.equal(assertOverlayExecutionGuard(managedDev, devGuard).target, 'dev');
  assert.deepEqual(
    remediationDatabaseOverlayGuard({ preparation: { mode: 'disposable-managed-local' } }, packageResult),
    localGuard
  );
  assert.deepEqual(
    remediationDatabaseOverlayGuard({ preparation: { mode: 'managed-dev' } }, packageResult),
    devGuard
  );

  for (const [connectionString, targetGuard] of [
    [loopback, devGuard],
    [managedDev, localGuard],
    [managedProd, devGuard],
    [managedProd, localGuard],
    [managedSandbox, devGuard]
  ]) {
    await assert.rejects(executeManagedOverlayPackage({ connectionString, targetGuard }), {
      code: 'MANAGED_OVERLAY_TARGET_GUARD_REJECTED'
    });
  }
});

test('R3 canonical overlays are loopback-guarded while remediation restores remain target-guarded', () => {
  const source = fs.readFileSync(REMEDIATION_REAL_STAGE_WORKER, 'utf8');
  const r3Validation = source.slice(
    source.indexOf('async function runR3Validated'),
    source.indexOf('async function databaseSessionEvidence')
  );
  assert.equal(
    r3Validation.match(/targetGuard:\s*disposableLoopbackOverlayGuard\(\)/g)?.length,
    2
  );
  assert.equal(
    r3Validation.match(/targetGuard:\s*remediationDatabaseOverlayGuard\(context, recovery\.packageResult\)/g)?.length,
    1
  );
  assert.match(r3Validation, /verifyManagedOverlayPackageForExecution\(\{[\s\S]*recoveryPackageAuthenticated/);
  const knownRestore = source.slice(
    source.indexOf('async function executeKnownRestore'),
    source.indexOf('async function runRestoreOriginalY2')
  );
  assert.match(
    knownRestore,
    /const overlayGuard = remediationDatabaseOverlayGuard\(context, packageResult\);[\s\S]*verifyManagedOverlayPackageForExecution\([\s\S]*targetGuard:\s*overlayGuard[\s\S]*executeManagedOverlayPackage\([\s\S]*targetGuard:\s*overlayGuard/
  );
  assert.match(
    knownRestore,
    /expectedPackageAuthentication[\s\S]*canonicalDigest\(packageAuthentication\) !== canonicalDigest\(expectedPackageAuthentication\)/
  );
  assert.match(
    source,
    /packageResult:\s*r3\.originalY2RecoveryPackage,\s*expectedPackageAuthentication:\s*r3\.originalY2PackageAuthentication/
  );
  assert.match(
    source,
    /packageResult:\s*r3\.recoveryPackage,\s*expectedPackageAuthentication:\s*r3\.recoveryPackageAuthentication/
  );
  assert.match(source, /function managedDevOverlayGuard\(packageResult\)[\s\S]*buildManagedOverlayTargetGuard\(\{/);
  assert.doesNotMatch(source, /\.\.\.packageResult\.targetCompatibility/);

  const refreshSource = fs.readFileSync(path.join(REPO_ROOT, REFRESH_WORKER_REPO_PATH), 'utf8');
  assert.match(refreshSource, /function targetGuard\(preparation, packageResult\)[\s\S]*buildManagedOverlayTargetGuard\(\{/);
  assert.equal(
    refreshSource.match(/targetGuard\(context\.preparation,\s*(?:session\.devRefreshPackage|y2\.recoveryPackage)\)/g)?.length,
    2
  );
  assert.doesNotMatch(refreshSource, /\.\.\.packageResult\.targetCompatibility/);
});

test('fallback authenticates and executes the prevalidated R3 package without postfailure regeneration', () => {
  const source = fs.readFileSync(REMEDIATION_REAL_STAGE_WORKER, 'utf8');
  const recoveryPrecheck = source.slice(
    source.indexOf('async function runRemediationRecoveryPrecheck'),
    source.indexOf('async function runRemediationRecoveryDatabase')
  );
  const recoveryDatabase = source.slice(
    source.indexOf('async function runRemediationRecoveryDatabase'),
    source.indexOf('async function runRemediationRecoveryVerified')
  );
  assert.match(recoveryPrecheck, /verifyManagedOverlayPackageForExecution/);
  assert.match(recoveryPrecheck, /packageResult:\s*r3\.recoveryPackage/);
  assert.match(recoveryDatabase, /packageResult:\s*r3\.recoveryPackage/g);
  assert.match(recoveryDatabase, /retainedPackageUsed:\s*true/);
  assert.doesNotMatch(recoveryDatabase, /generateCurrentDatabaseRecoveryPackage/);
  assert.doesNotMatch(recoveryDatabase, /decryptBaselineBytes|readWrappedBaselineDataKey|captureEncryptedPgDump/);
});

test('R3 validation requires final semantic Auth evidence immediately before durable marker publication', () => {
  const source = fs.readFileSync(REMEDIATION_REAL_STAGE_WORKER, 'utf8');
  const r3Validation = source.slice(
    source.indexOf('async function runR3Validated'),
    source.indexOf('async function databaseSessionEvidence')
  );
  assert.match(r3Validation, /freshPreBoundaryPosture\(context\)[\s\S]*captureRemediationAuthCertificate/);
  assert.match(r3Validation, /signedDefaultWarehouseExact/);
  assert.match(r3Validation, /copiedUsersExact:[\s\S]*copiedIdentitiesExact/);
  const orchestrator = fs.readFileSync(fileURLToPath(
    new URL('./dev-recovery-remediation-orchestrator.mjs', import.meta.url)
  ), 'utf8');
  assert.match(orchestrator, /runStage\(executor, currentStage, context\)[\s\S]*assertRecoveryRemediationContractFresh[\s\S]*publishRemediationMarker/);
});

test('historical refresh provenance remains exact while a signed successor bridge binds current execution', () => {
  const key = crypto.randomBytes(32);
  const currentWorkerBytes = fs.readFileSync(REMEDIATION_REAL_STAGE_WORKER);
  const syntheticWorkerBytes = fs.readFileSync(TEST_WORKER);
  try {
    const currentToolingCommit = gitIdentity('HEAD');
    const historical = historicalRefreshArtifacts(key);
    assert.throws(() => verifyPreparation(
      historical.preparationRecord, key, historical.attemptId
    ), { code: 'DEV_REFRESH_PREPARATION_INVALID' });
    const verified = verifyHistoricalPreparation({
      preparationRecord: historical.preparationRecord,
      contractRecord: historical.contractRecord,
      inventoryRecord: historical.inventoryRecord,
      key,
      repoRoot: REPO_ROOT,
      currentToolingCommit,
      expectedAttemptId: historical.attemptId
    });
    assert.equal(verified.provenance.toolingCommit, HISTORICAL_TOOLING_COMMIT);
    assert.equal(verified.provenance.workerDigest, historical.preparation.stageWorker.digest);
    assert.equal(verified.provenance.operationInventoryDigest, historical.inventory.inventoryDigest);

    const currentInventoryDigest = digest('current-remediation-inventory');
    const currentToolingTree = gitIdentity(currentToolingCommit, 'tree');
    const bridge = buildRemediationProvenanceBridge({
      historical: verified.provenance,
      currentExecution: {
        format: 'dev-recovery-current-execution-provenance-v1',
        digestScope: 'exact-committed-file-sha256-v1',
        compatibilityBaseCommit: REMEDIATION_PROVENANCE_FIX_BASE_COMMIT,
        toolingCommit: currentToolingCommit,
        toolingTree: currentToolingTree,
        workerRepoPath: CURRENT_REMEDIATION_WORKER_REPO_PATH,
        workerDigest: sha256Bytes(currentWorkerBytes),
        rejectedSyntheticWorkerDigest: sha256Bytes(syntheticWorkerBytes),
        operationInventoryDigest: currentInventoryDigest
      }
    });
    const binding = {
      ...originalBinding(),
      refreshAttemptId: historical.attemptId,
      refreshContractDigest: verified.provenance.refreshContractDigest,
      originalPreparationDigest: verified.provenance.originalPreparationDigest,
      originalOperationInventoryDigest: verified.provenance.operationInventoryDigest,
      historicalProvenanceDigest: verified.provenance.provenanceDigest
    };
    const preparedAt = new Date(Date.now() - 1_000).toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const bridged = buildRecoveryRemediationContract({
      remediationAttemptId: 'dev-recovery-remediation-successor',
      toolingCommit: currentToolingCommit,
      toolingTree: currentToolingTree,
      originalBinding: binding,
      provenanceBridge: bridge,
      observedDevCertificateDigest: digest('observed'),
      operationInventoryDigest: currentInventoryDigest,
      preparedAt,
      expiresAt
    });
    assert.equal(bridged.version, 2);
    assert.equal(verifyRecoveryRemediationContract(bridged), bridged);
    assert.notEqual(
      bridged.provenanceBridge.historical.workerDigest,
      bridged.provenanceBridge.currentExecution.workerDigest
    );

    const preparationPayload = {
      format: 'dev-recovery-remediation-preparation-v1',
      version: 2,
      remediationAttemptId: bridged.remediationAttemptId,
      target: { environment: 'dev', projectRef: DEV_PROJECT_REF },
      candidate: bridged.candidate,
      original: {
        binding,
        provenance: verified.provenance,
        originalInventoryPath: 'private-inventory'
      },
      provenanceBridge: bridge,
      contractDigest: bridged.contractDigest,
      operationInventoryDigest: currentInventoryDigest,
      currentObserved: { value: true },
      stageWorker: {
        path: path.resolve(REMEDIATION_REAL_STAGE_WORKER),
        digest: sha256Bytes(currentWorkerBytes),
        rejectedSyntheticWorkerDigest: sha256Bytes(syntheticWorkerBytes),
        syntheticWorkerAllowed: false
      },
      expiresAt
    };
    preparationPayload.currentObserved.certificateDigest = canonicalDigest({ value: true });
    const preparationRecord = authenticateRemediationPreparation(preparationPayload, key);
    assert.equal(
      verifyRemediationPreparation(preparationRecord, key, bridged.remediationAttemptId),
      preparationPayload
    );

    const authHardening = {
      format: 'dev-recovery-remediation-auth-hardening-v1',
      baseline: { format: 'dev-recovery-remediation-semantic-auth-v1' },
      auditPosture: {
        format: 'dev-recovery-remediation-auth-audit-posture-v1',
        source: 'disposable-auth-provider-config',
        postgresStorage: 'disabled',
        prerequisiteExact: true
      },
      canary: {
        freshAuthentication: true,
        stableStateExact: true,
        sessionRevoked: true,
        ephemeralSessionException: false,
        ephemeraMode: 'IMMEDIATE_CANARY_DISCOVERY',
        allowedNativeEphemera: {
          sessions: [], refreshTokens: [], sessionRows: [], refreshTokenRows: []
        }
      },
      readiness: {
        realQuietWindow: true,
        freshSideEffectsSafe: true,
        freshEdgeExact: true
      }
    };
    const emptyWarehousePreparation = structuredClone(preparationPayload);
    emptyWarehousePreparation.version = 3;
    emptyWarehousePreparation.authHardening = authHardening;
    emptyWarehousePreparation.targetSession = { smokeDefaultWarehouse: '' };
    emptyWarehousePreparation.currentObserved = { authHardening };
    emptyWarehousePreparation.currentObserved.certificateDigest = canonicalDigest({ authHardening });
    assert.equal(
      verifyRemediationPreparation(
        authenticateRemediationPreparation(emptyWarehousePreparation, key),
        key,
        bridged.remediationAttemptId
      ).targetSession.smokeDefaultWarehouse,
      ''
    );
    const missingWarehousePreparation = structuredClone(emptyWarehousePreparation);
    delete missingWarehousePreparation.targetSession.smokeDefaultWarehouse;
    assert.throws(() => verifyRemediationPreparation(
      authenticateRemediationPreparation(missingWarehousePreparation, key),
      key,
      bridged.remediationAttemptId
    ), { code: 'DEV_REMEDIATION_PREPARATION_AUTH_HARDENING_INVALID' });

    for (const mutate of [
      (value) => { value.provenanceBridge.currentExecution.workerDigest = digest('wrong-worker'); },
      (value) => { value.provenanceBridge.currentExecution.toolingCommit = 'c'.repeat(40); },
      (value) => { value.provenanceBridge.currentExecution.operationInventoryDigest = verified.provenance.operationInventoryDigest; },
      (value) => { value.provenanceBridge.historical.provenanceDigest = digest('rewritten-history'); }
    ]) {
      const tampered = structuredClone(bridged);
      mutate(tampered);
      assert.throws(() => verifyRecoveryRemediationContract(tampered));
    }

    const invalidSignature = structuredClone(historical.preparationRecord);
    invalidSignature.preparation.stageWorker.digest = digest('tampered');
    assert.throws(() => verifyHistoricalPreparation({
      preparationRecord: invalidSignature,
      contractRecord: historical.contractRecord,
      inventoryRecord: historical.inventoryRecord,
      key,
      repoRoot: REPO_ROOT,
      currentToolingCommit,
      expectedAttemptId: historical.attemptId
    }), { code: 'DEV_REFRESH_PREPARATION_INVALID' });

    const wrongWorker = historicalRefreshArtifacts(key, { workerDigestOverride: digest('wrong-worker') });
    assert.throws(() => verifyHistoricalPreparation({
      preparationRecord: wrongWorker.preparationRecord,
      contractRecord: wrongWorker.contractRecord,
      inventoryRecord: wrongWorker.inventoryRecord,
      key,
      repoRoot: REPO_ROOT,
      currentToolingCommit,
      expectedAttemptId: wrongWorker.attemptId
    }), { code: 'DEV_REFRESH_HISTORICAL_WORKER_INVALID' });

    const historicalSyntheticBytes = gitBytes(HISTORICAL_TOOLING_COMMIT, REFRESH_SYNTHETIC_REPO_PATH);
    try {
      const syntheticHistorical = historicalRefreshArtifacts(key, {
        workerDigestOverride: sha256Bytes(historicalSyntheticBytes)
      });
      assert.throws(() => verifyHistoricalPreparation({
        preparationRecord: syntheticHistorical.preparationRecord,
        contractRecord: syntheticHistorical.contractRecord,
        inventoryRecord: syntheticHistorical.inventoryRecord,
        key,
        repoRoot: REPO_ROOT,
        currentToolingCommit,
        expectedAttemptId: syntheticHistorical.attemptId
      }), { code: 'DEV_REFRESH_HISTORICAL_WORKER_INVALID' });
    } finally {
      historicalSyntheticBytes.fill(0);
    }

    const wrongTree = historicalRefreshArtifacts(key, { historicalTree: 'd'.repeat(40) });
    assert.throws(() => verifyHistoricalPreparation({
      preparationRecord: wrongTree.preparationRecord,
      contractRecord: wrongTree.contractRecord,
      inventoryRecord: wrongTree.inventoryRecord,
      key,
      repoRoot: REPO_ROOT,
      currentToolingCommit,
      expectedAttemptId: wrongTree.attemptId
    }), { code: 'DEV_REFRESH_HISTORICAL_LINEAGE_INVALID' });

    const substitutedInventory = structuredClone(historical.inventoryRecord);
    substitutedInventory.inventory.envFileDigest = digest('substituted');
    assert.throws(() => verifyHistoricalPreparation({
      preparationRecord: historical.preparationRecord,
      contractRecord: historical.contractRecord,
      inventoryRecord: substitutedInventory,
      key,
      repoRoot: REPO_ROOT,
      currentToolingCommit,
      expectedAttemptId: historical.attemptId
    }), { code: 'DEV_REFRESH_HISTORICAL_WORKER_INVALID' });

    assert.throws(() => verifyHistoricalPreparation({
      preparationRecord: historical.preparationRecord,
      contractRecord: historical.contractRecord,
      inventoryRecord: historical.inventoryRecord,
      key,
      repoRoot: REPO_ROOT,
      currentToolingCommit,
      expectedAttemptId: 'dev-refresh-20260828181151989-wrong'
    }), { code: 'DEV_REFRESH_PREPARATION_INVALID' });

    assert.throws(() => verifyHistoricalPreparation({
      preparationRecord: historical.preparationRecord,
      contractRecord: historical.contractRecord,
      inventoryRecord: historical.inventoryRecord,
      key,
      repoRoot: REPO_ROOT,
      currentToolingCommit: historical.contract.candidate.canonicalMainCommit,
      expectedAttemptId: historical.attemptId
    }), { code: 'DEV_REFRESH_HISTORICAL_SUCCESSOR_INVALID' });
  } finally {
    key.fill(0);
    currentWorkerBytes.fill(0);
    syntheticWorkerBytes.fill(0);
  }
});

test('v1 remediation contract normalization remains byte-identical', () => {
  const value = contract('dev-recovery-remediation-v1-compatible');
  assert.equal(value.version, 1);
  assert.equal(canonicalSerialize(verifyRecoveryRemediationContract(value)), canonicalSerialize(value));
  assert.equal(Object.hasOwn(value, 'provenanceBridge'), false);
});

test('pre-boundary freshness rejects stale invocation and expiry immediately before marker publication', async () => {
  const baseNow = Date.now();
  const value = contract(undefined, {
    preparedAt: new Date(baseNow - 1_000).toISOString(),
    expiresAt: new Date(baseNow + 1_000).toISOString()
  });
  const key = crypto.randomBytes(32);
  const preparationRecord = remediationPreparationRecord(value, key);
  const root = temporaryRoot('dev-remediation-expiry-preboundary');
  let observedNow = baseNow;
  try {
    assert.throws(() => assertRecoveryRemediationContractFresh(value, baseNow + 2_000), {
      code: 'DEV_REMEDIATION_PREPARATION_EXPIRED_PRE_BOUNDARY'
    });
    assert.throws(() => verifyRemediationPreparation(
      preparationRecord,
      key,
      value.remediationAttemptId,
      { now: baseNow + 2_000 }
    ), { code: 'DEV_REMEDIATION_PREPARATION_INVALID' });
    const baseExecutor = executorForPreparation(value, preparationRecord);
    await assert.rejects(runDevRecoveryRemediation({
      rootDirectory: root,
      key,
      contract: value,
      now: () => observedNow,
      executor: {
        async run(stage, context) {
          const result = await baseExecutor.run(stage, context);
          if (stage === 'R3_VALIDATED') observedNow = baseNow + 2_000;
          return result;
        }
      }
    }), { code: 'DEV_REMEDIATION_PREPARATION_EXPIRED_PRE_BOUNDARY' });
    const journal = readRemediationJournal(root, key);
    assert.equal(journal.current.state, 'FAILED_PRE_MUTATION');
    assert.equal(journal.marker, null);
    assert.equal(journal.boundary, null);
  } finally {
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('exact frozen preparation survives post-boundary expiry and permits only recovery-required fallback', async () => {
  const baseNow = Date.now();
  const value = contract(undefined, {
    preparedAt: new Date(baseNow - 1_000).toISOString(),
    expiresAt: new Date(baseNow + 60_000).toISOString()
  });
  const key = crypto.randomBytes(32);
  const preparationRecord = remediationPreparationRecord(value, key);
  const root = temporaryRoot('dev-remediation-expiry-postboundary');
  let observedNow = baseNow;
  try {
    const baseExecutor = executorForPreparation(value, preparationRecord, 'AUTH_RUNTIME_VERIFIED');
    await assert.rejects(runDevRecoveryRemediation({
      rootDirectory: root,
      key,
      contract: value,
      now: () => observedNow,
      afterDurableTransition({ state }) {
        if (state === 'DESTRUCTIVE_BOUNDARY') observedNow = baseNow + 120_000;
      },
      executor: baseExecutor
    }), { code: 'DEV_REMEDIATION_RECOVERY_REQUIRED' });
    const frozen = verifyFrozenRemediationPreparation(preparationRecord, key, {
      rootDirectory: root,
      expectedAttemptId: value.remediationAttemptId,
      contractDigest: value.contractDigest,
      operationInventoryDigest: value.operationInventoryDigest,
      stage: 'RECOVERY_CLI'
    });
    assert.equal(frozen, preparationRecord.preparation);
    assert.throws(() => verifyRemediationPreparation(
      preparationRecord,
      key,
      value.remediationAttemptId,
      { now: observedNow }
    ), { code: 'DEV_REMEDIATION_PREPARATION_INVALID' });
    const wrongPreparation = remediationPreparationRecord(value, key, {
      attemptId: 'dev-recovery-remediation-wrong-attempt'
    });
    assert.throws(() => verifyFrozenRemediationPreparation(wrongPreparation, key, {
      rootDirectory: root,
      expectedAttemptId: value.remediationAttemptId,
      contractDigest: value.contractDigest,
      operationInventoryDigest: value.operationInventoryDigest,
      stage: 'RECOVERY_CLI'
    }), { code: 'DEV_REMEDIATION_PREPARATION_INVALID' });
    const recovered = await runDevRecoveryRemediationRecovery({
      rootDirectory: root,
      key,
      contract: value,
      executor: executorForPreparation(value, preparationRecord)
    });
    assert.equal(recovered.classification, 'DEV_RECOVERY_REMEDIATION_R3_RECOVERED');
    assert.equal(readRemediationJournal(root, key).current.state, 'REMEDIATION_RECOVERED');
  } finally {
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('remaining remediation stages complete when the exact frozen preparation expires after boundary', async () => {
  const baseNow = Date.now();
  const value = contract(undefined, {
    preparedAt: new Date(baseNow - 1_000).toISOString(),
    expiresAt: new Date(baseNow + 60_000).toISOString()
  });
  const key = crypto.randomBytes(32);
  const preparationRecord = remediationPreparationRecord(value, key);
  const root = temporaryRoot('dev-remediation-postboundary-continuation');
  let observedNow = baseNow;
  try {
    const result = await runDevRecoveryRemediation({
      rootDirectory: root,
      key,
      contract: value,
      now: () => observedNow,
      afterDurableTransition({ state }) {
        if (state === 'DESTRUCTIVE_BOUNDARY') observedNow = baseNow + 120_000;
      },
      executor: executorForPreparation(value, preparationRecord)
    });
    assert.equal(result.classification, 'DEV_RECOVERY_REMEDIATION_COMPLETE');
    assert.equal(readRemediationJournal(root, key).current.state, 'REMEDIATION_COMPLETE');
  } finally {
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recovery precheck failure leaves recovery-required state without publishing the one-shot marker', async () => {
  const root = temporaryRoot('dev-remediation-recovery-precheck');
  const key = crypto.randomBytes(32);
  const value = contract();
  const preparationRecord = remediationPreparationRecord(value, key);
  try {
    await assert.rejects(runDevRecoveryRemediation({
      rootDirectory: root,
      key,
      contract: value,
      executor: executorForPreparation(value, preparationRecord, 'AUTH_RUNTIME_VERIFIED')
    }), { code: 'DEV_REMEDIATION_RECOVERY_REQUIRED' });
    await assert.rejects(runDevRecoveryRemediationRecovery({
      rootDirectory: root,
      key,
      contract: value,
      executor: executor(value, 'REMEDIATION_RECOVERY_PRECHECK')
    }), { code: 'INJECTED_REMEDIATION_FAILURE' });
    const journal = readRemediationJournal(root, key);
    assert.equal(journal.current.state, 'REMEDIATION_RECOVERY_REQUIRED');
    assert.equal(journal.recovery, null);
  } finally {
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('attempt-bound Auth canary evidence is durable, monotonic, credential-free, and conservative', () => {
  const root = temporaryRoot('dev-remediation-auth-canary-state');
  const key = crypto.randomBytes(32);
  const value = contract();
  try {
    initializeRemediationJournal({
      rootDirectory: root,
      key,
      remediationAttemptId: value.remediationAttemptId,
      contractDigest: value.contractDigest,
      originalBindingDigest: canonicalDigest(value.original)
    });
    const canary = beginRemediationAuthCanary(root, key, 'AUTH_RUNTIME');
    appendRemediationAuthCanaryState(root, key, canary.canaryId, 'LOGIN_STARTED');
    appendRemediationAuthCanaryState(root, key, canary.canaryId, 'LOGIN_SUCCEEDED');
    assert.deepEqual(remediationAuthCanaryDisposition(root, key), {
      canaryCount: 1,
      completedCount: 0,
      sessionRevoked: false,
      boundedEphemeraPossible: true,
      unresolvedCount: 1,
      unresolvedPurposes: ['AUTH_RUNTIME'],
      unboundCanaryCount: 1,
      allowedNativeEphemera: {
        sessions: [], refreshTokens: [], sessionRows: [], refreshTokenRows: []
      }
    });
    assert.throws(() => appendRemediationAuthCanaryState(
      root, key, canary.canaryId, 'CANARY_COMPLETE'
    ), { code: 'DEV_REMEDIATION_AUTH_CANARY_TRANSITION_INVALID' });
    appendRemediationAuthCanaryState(root, key, canary.canaryId, 'LOGOUT_ATTEMPTED');
    appendRemediationAuthCanaryState(root, key, canary.canaryId, 'BOUNDED_EPHEMERA_POSSIBLE');
    appendRemediationAuthCanaryState(root, key, canary.canaryId, 'CANARY_COMPLETE');
    const records = readRemediationAuthCanaries(root, key)[0].records;
    assert.deepEqual(records.map((record) => record.state), [
      'CANARY_NOT_STARTED', 'LOGIN_STARTED', 'LOGIN_SUCCEEDED', 'LOGOUT_ATTEMPTED',
      'BOUNDED_EPHEMERA_POSSIBLE', 'CANARY_COMPLETE'
    ]);
    const serialized = records.map((record) => JSON.stringify(record)).join('\n');
    assert.doesNotMatch(serialized, /access.?token|refresh.?token|password|credential/i);
  } finally {
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('per-purpose Auth canary ceiling blocks accumulation until exact ephemera is reconciled', () => {
  const root = temporaryRoot('dev-remediation-auth-canary-ceiling');
  const key = crypto.randomBytes(32);
  const value = contract();
  try {
    initializeRemediationJournal({
      rootDirectory: root,
      key,
      remediationAttemptId: value.remediationAttemptId,
      contractDigest: value.contractDigest,
      originalBindingDigest: canonicalDigest(value.original)
    });
    const canary = beginRemediationAuthCanary(root, key, 'RECOVERY_VERIFICATION');
    appendRemediationAuthCanaryState(root, key, canary.canaryId, 'LOGIN_STARTED');
    appendRemediationAuthCanaryState(root, key, canary.canaryId, 'LOGIN_SUCCEEDED');
    appendRemediationAuthCanaryState(root, key, canary.canaryId, 'LOGOUT_ATTEMPTED');
    appendRemediationAuthCanaryState(root, key, canary.canaryId, 'BOUNDED_EPHEMERA_POSSIBLE');
    appendRemediationAuthCanaryState(root, key, canary.canaryId, 'CANARY_COMPLETE');
    freezeRemediationAuthCanaryAllowance(root, key, canary.canaryId, {
      sessions: ['attempt-owned-session'],
      refreshTokens: ['attempt-owned-refresh'],
      sessionRows: [{ sessionId: 'attempt-owned-session', digest: digest('session-row') }],
      refreshTokenRows: [{
        refreshTokenId: 'attempt-owned-refresh', sessionId: 'attempt-owned-session',
        digest: digest('refresh-row')
      }]
    });
    assert.throws(
      () => beginRemediationAuthCanary(root, key, 'RECOVERY_VERIFICATION'),
      { code: 'DEV_REMEDIATION_AUTH_CANARY_CEILING_REACHED' }
    );
    reconcileRemediationAuthCanary(root, key, canary.canaryId);
    const next = beginRemediationAuthCanary(root, key, 'RECOVERY_VERIFICATION');
    assert.notEqual(next.canaryId, canary.canaryId);
    assert.equal(remediationAuthCanaryDisposition(root, key).unresolvedCount, 1);
  } finally {
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('completed logout with frozen database rows stays unresolved and recovery verification permits only one continuation', () => {
  const root = temporaryRoot('dev-remediation-auth-canary-database-derived');
  const key = crypto.randomBytes(32);
  const value = contract();
  try {
    initializeRemediationJournal({
      rootDirectory: root,
      key,
      remediationAttemptId: value.remediationAttemptId,
      contractDigest: value.contractDigest,
      originalBindingDigest: canonicalDigest(value.original)
    });
    const orphan = beginRemediationAuthCanary(root, key, 'RECOVERY_VERIFICATION');
    appendRemediationAuthCanaryState(root, key, orphan.canaryId, 'LOGIN_STARTED');
    appendRemediationAuthCanaryState(root, key, orphan.canaryId, 'LOGIN_SUCCEEDED');
    freezeRemediationAuthCanaryAllowance(root, key, orphan.canaryId, {
      sessions: ['attempt-owned-session'],
      refreshTokens: ['attempt-owned-refresh'],
      sessionRows: [{ sessionId: 'attempt-owned-session', digest: digest('session-row') }],
      refreshTokenRows: [{
        refreshTokenId: 'attempt-owned-refresh', sessionId: 'attempt-owned-session',
        digest: digest('refresh-row')
      }]
    });
    appendRemediationAuthCanaryState(root, key, orphan.canaryId, 'LOGOUT_ATTEMPTED');
    appendRemediationAuthCanaryState(root, key, orphan.canaryId, 'LOGOUT_SUCCEEDED');
    appendRemediationAuthCanaryState(root, key, orphan.canaryId, 'CANARY_COMPLETE');
    const unresolved = remediationAuthCanaryDisposition(root, key);
    assert.equal(unresolved.sessionRevoked, false);
    assert.equal(unresolved.unresolvedCount, 1);
    assert.deepEqual(unresolved.allowedNativeEphemera, {
      sessions: ['attempt-owned-session'],
      refreshTokens: ['attempt-owned-refresh'],
      sessionRows: [{ sessionId: 'attempt-owned-session', digest: digest('session-row') }],
      refreshTokenRows: [{
        refreshTokenId: 'attempt-owned-refresh', sessionId: 'attempt-owned-session',
        digest: digest('refresh-row')
      }]
    });
    const continuation = beginRemediationAuthCanary(
      root,
      key,
      'RECOVERY_VERIFICATION',
      new Date().toISOString(),
      { allowRecoveryVerificationContinuation: true }
    );
    assert.notEqual(continuation.canaryId, orphan.canaryId);
    assert.throws(() => beginRemediationAuthCanary(
      root,
      key,
      'RECOVERY_VERIFICATION',
      new Date().toISOString(),
      { allowRecoveryVerificationContinuation: true }
    ), { code: 'DEV_REMEDIATION_AUTH_CANARY_CEILING_REACHED' });
  } finally {
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('authenticated Auth allowances reject tampering and overlap across canaries', () => {
  const tamperedRoot = temporaryRoot('dev-remediation-auth-canary-tamper');
  const overlapRoot = temporaryRoot('dev-remediation-auth-canary-overlap');
  const key = crypto.randomBytes(32);
  const value = contract();
  const initialize = (root) => initializeRemediationJournal({
    rootDirectory: root,
    key,
    remediationAttemptId: value.remediationAttemptId,
    contractDigest: value.contractDigest,
    originalBindingDigest: canonicalDigest(value.original)
  });
  const bind = (root, purpose, session, refreshToken) => {
    const canary = beginRemediationAuthCanary(root, key, purpose);
    appendRemediationAuthCanaryState(root, key, canary.canaryId, 'LOGIN_STARTED');
    appendRemediationAuthCanaryState(root, key, canary.canaryId, 'LOGIN_SUCCEEDED');
    freezeRemediationAuthCanaryAllowance(root, key, canary.canaryId, {
      sessions: [session],
      refreshTokens: [refreshToken],
      sessionRows: [{ sessionId: session, digest: digest(`session:${session}`) }],
      refreshTokenRows: [{
        refreshTokenId: refreshToken, sessionId: session, digest: digest(`refresh:${refreshToken}`)
      }]
    });
    return canary;
  };
  try {
    initialize(tamperedRoot);
    const canary = bind(tamperedRoot, 'AUTH_RUNTIME', 'private-session-a', 'private-refresh-a');
    const allowancePath = path.join(canary.directory, 'ephemera-allowance.private.json');
    const bytes = fs.readFileSync(allowancePath);
    try {
      const changed = Buffer.from(bytes.toString('utf8').replace('private-session-a', 'private-session-b'), 'utf8');
      fs.writeFileSync(allowancePath, changed);
      changed.fill(0);
    } finally {
      bytes.fill(0);
    }
    assert.throws(() => readRemediationAuthCanaries(tamperedRoot, key));

    initialize(overlapRoot);
    bind(overlapRoot, 'AUTH_RUNTIME', 'overlap-session', 'overlap-refresh');
    bind(overlapRoot, 'RECOVERY_VERIFICATION', 'overlap-session', 'overlap-refresh');
    assert.throws(
      () => remediationAuthCanaryDisposition(overlapRoot, key),
      { code: 'DEV_REMEDIATION_AUTH_EPHEMERA_ALLOWANCE_OVERLAP' }
    );
  } finally {
    key.fill(0);
    fs.rmSync(tamperedRoot, { recursive: true, force: true });
    fs.rmSync(overlapRoot, { recursive: true, force: true });
  }
});

test('a real post-login child kill reaches recovery-required and permits stored-package R3 recovery', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-remediation-child-r3-'));
  const root = path.join(temporary, 'state-private');
  const key = crypto.randomBytes(32);
  const value = contract();
  const preparationRecord = remediationPreparationRecord(value, key);
  const userId = crypto.randomUUID();
  const organizationId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const keyPath = path.join(temporary, 'authority.private.bin');
  const inputPath = path.join(temporary, 'input.private.json');
  const childPath = path.join(temporary, 'child.private.mjs');
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url.startsWith('/auth/v1/token')) {
      response.end(JSON.stringify({
        access_token: syntheticAccessToken(userId, sessionId),
        refresh_token: 'synthetic-process-local-refresh',
        user: { id: userId }
      }));
      return;
    }
    response.writeHead(500);
    response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    writePrivateBytesExclusive(keyPath, key);
    writePrivateBytesExclusive(inputPath, Buffer.from(JSON.stringify({
      preparation: {
        mode: 'disposable-managed-local',
        targetSession: {
          smokeUserId: userId,
          smokeOrganizationId: organizationId,
          smokeDefaultWarehouse: ''
        }
      },
      values: {
        SUPABASE_URL: origin,
        EDGE_API_BASE_URL: `${origin}/functions/v1/api`,
        SUPABASE_ANON_KEY: 'synthetic-local-only',
        SMOKE_USER_EMAIL: 'synthetic@example.invalid',
        SMOKE_USER_PASSWORD: 'synthetic-local-only'
      }
    }), 'utf8'));
    writePrivateBytesExclusive(childPath, Buffer.from(`
      import fs from 'node:fs';
      import { runFreshAuthenticationCanary } from ${JSON.stringify(new URL('./dev-recovery-remediation-auth.mjs', import.meta.url).href)};
      import { beginRemediationAuthCanary, appendRemediationAuthCanaryState } from ${JSON.stringify(new URL('./dev-recovery-remediation-state.mjs', import.meta.url).href)};
      const [root, keyPath, inputPath] = process.argv.slice(2);
      const key = fs.readFileSync(keyPath);
      const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
      const canary = beginRemediationAuthCanary(root, key, 'AUTH_RUNTIME');
      await runFreshAuthenticationCanary({ ...input, onLifecycle: async (state) => {
        appendRemediationAuthCanaryState(root, key, canary.canaryId, state);
        if (state === 'LOGIN_SUCCEEDED') {
          process.stdout.write('LOGIN_SUCCEEDED\\n');
          await new Promise(() => {});
        }
      }});
    `, 'utf8'));
    const baseExecutor = executorForPreparation(value, preparationRecord);
    const killedExecutor = {
      async run(stage) {
        if (stage !== 'AUTH_RUNTIME_VERIFIED') return baseExecutor.run(stage);
        const child = spawn(process.execPath, [childPath, root, keyPath, inputPath], {
          shell: false,
          cwd: temporary,
          windowsHide: true,
          env: {
            SystemRoot: process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
            WINDIR: process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows',
            TEMP: temporary,
            TMP: temporary
          },
          stdio: ['ignore', 'pipe', 'pipe']
        });
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('CHILD_LOGIN_SIGNAL_TIMEOUT')), 15_000);
          child.stdout.on('data', (chunk) => {
            if (chunk.toString('utf8').includes('LOGIN_SUCCEEDED')) {
              clearTimeout(timeout);
              child.kill();
              resolve();
            }
          });
          child.once('error', reject);
        });
        await new Promise((resolve) => child.once('exit', resolve));
        assert.equal(remediationAuthCanaryDisposition(root, key).sessionRevoked, false);
        throw Object.assign(new Error('INJECTED_POST_LOGIN_PROCESS_LOSS'), {
          code: 'INJECTED_POST_LOGIN_PROCESS_LOSS',
          transactionOutcome: 'not_started'
        });
      }
    };
    await assert.rejects(runDevRecoveryRemediation({
      rootDirectory: root,
      key,
      contract: value,
      executor: killedExecutor
    }), { code: 'DEV_REMEDIATION_RECOVERY_REQUIRED' });
    assert.equal(readRemediationJournal(root, key).current.state, 'REMEDIATION_RECOVERY_REQUIRED');
    assert.deepEqual(remediationAuthCanaryDisposition(root, key), {
      canaryCount: 1,
      completedCount: 0,
      sessionRevoked: false,
      boundedEphemeraPossible: true,
      unresolvedCount: 1,
      unresolvedPurposes: ['AUTH_RUNTIME'],
      unboundCanaryCount: 1,
      allowedNativeEphemera: {
        sessions: [], refreshTokens: [], sessionRows: [], refreshTokenRows: []
      }
    });
    const recovered = await runDevRecoveryRemediationRecovery({
      rootDirectory: root,
      key,
      contract: value,
      executor: baseExecutor
    });
    assert.equal(recovered.classification, 'DEV_RECOVERY_REMEDIATION_R3_RECOVERED');
    assert.equal(readRemediationJournal(root, key).current.state, 'REMEDIATION_RECOVERED');
  } finally {
    key.fill(0);
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('boundary and recovery-precheck crash windows remain deterministic and recovery-marker publication is one-shot', async () => {
  const root = temporaryRoot('dev-remediation-crash-windows');
  const key = crypto.randomBytes(32);
  const value = contract();
  const preparationRecord = remediationPreparationRecord(value, key);
  try {
    await assert.rejects(runDevRecoveryRemediation({
      rootDirectory: root,
      key,
      contract: value,
      executor: executorForPreparation(value, preparationRecord),
      afterBoundaryPublished() {
        throw Object.assign(new Error('INJECTED_BOUNDARY_PROCESS_CRASH'), {
          code: 'INJECTED_BOUNDARY_PROCESS_CRASH'
        });
      }
    }), { code: 'DEV_REMEDIATION_RECOVERY_REQUIRED' });
    let journal = readRemediationJournal(root, key);
    assert.equal(journal.current.state, 'REMEDIATION_MARKED');
    assert.ok(journal.boundary);
    assert.equal(remediationRestartDisposition(root, key), 'REMEDIATION_RECOVERY_REQUIRED');

    await assert.rejects(runDevRecoveryRemediationRecovery({
      rootDirectory: root,
      key,
      contract: value,
      executor: executorForPreparation(value, preparationRecord),
      afterRecoveryPrecheck() {
        throw Object.assign(new Error('INJECTED_RECOVERY_PRECHECK_PROCESS_CRASH'), {
          code: 'INJECTED_RECOVERY_PRECHECK_PROCESS_CRASH'
        });
      }
    }), { code: 'INJECTED_RECOVERY_PRECHECK_PROCESS_CRASH' });
    journal = readRemediationJournal(root, key);
    assert.equal(journal.current.state, 'REMEDIATION_RECOVERY_REQUIRED');
    assert.equal(journal.recovery, null);

    await assert.rejects(runDevRecoveryRemediationRecovery({
      rootDirectory: root,
      key,
      contract: value,
      executor: executorForPreparation(value, preparationRecord),
      afterRecoveryMarkerPublished() {
        throw Object.assign(new Error('INJECTED_RECOVERY_MARKER_PROCESS_CRASH'), {
          code: 'INJECTED_RECOVERY_MARKER_PROCESS_CRASH'
        });
      }
    }), { code: 'INJECTED_RECOVERY_MARKER_PROCESS_CRASH' });
    journal = readRemediationJournal(root, key);
    assert.equal(journal.current.state, 'REMEDIATION_RECOVERY_REQUIRED');
    assert.ok(journal.recovery);
    assert.equal(remediationRestartDisposition(root, key), 'REMEDIATION_RECOVERY_AUTHORIZED');
    const recovered = await runDevRecoveryRemediationRecovery({
      rootDirectory: root,
      key,
      contract: value,
      executor: executorForPreparation(value, preparationRecord)
    });
    assert.equal(recovered.classification, 'DEV_RECOVERY_REMEDIATION_R3_RECOVERED');
  } finally {
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recovery database boundary uses read-only state reconciliation and never resumes package execution', async () => {
  const root = temporaryRoot('dev-remediation-recovery-db-boundary');
  const key = crypto.randomBytes(32);
  const value = contract();
  let databaseRuns = 0;
  let packageRuns = 0;
  const counted = {
    async run(stage, context) {
      const result = evidence(value, stage);
      if (stage === 'REMEDIATION_RECOVERY_DATABASE') {
        databaseRuns += 1;
        assert.equal(context.recoveryDatabaseMode, 'RECONCILE_ONLY');
        result.details.databaseStateReconciled = true;
        result.details.commitDirectlyObserved = false;
        result.evidenceDigest = canonicalDigest(result.details);
      }
      if (context.recoveryDatabaseMode === 'EXECUTE_ONCE') packageRuns += 1;
      return result;
    }
  };
  try {
    await createRecoveryRequiredState(root, key, value);
    await assert.rejects(runDevRecoveryRemediationRecovery({
      rootDirectory: root,
      key,
      contract: value,
      executor: counted,
      afterRecoveryBoundaryPublished() {
        throw Object.assign(new Error('INJECTED_RECOVERY_BOUNDARY_CRASH'), {
          code: 'INJECTED_RECOVERY_BOUNDARY_CRASH'
        });
      }
    }), { code: 'DEV_REMEDIATION_RECOVERY_DATABASE_OUTCOME_AMBIGUOUS' });
    assert.equal(databaseRuns, 0);
    assert.equal(remediationRestartDisposition(root, key), 'REMEDIATION_RECOVERY_DATABASE_BOUNDARY');
    const recovered = await runDevRecoveryRemediationRecovery({
      rootDirectory: root,
      key,
      contract: value,
      executor: counted
    });
    assert.equal(recovered.classification, 'DEV_RECOVERY_REMEDIATION_R3_RECOVERED');
    assert.equal(databaseRuns, 1);
    assert.equal(packageRuns, 0);
    assert.ok(readRemediationJournal(root, key).records.some((record) =>
      record.state === 'REMEDIATION_RECOVERY_DATABASE_STATE_RECONCILED'));
  } finally {
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('authenticated recovery state mismatch is terminal and cannot replay the package', async () => {
  const root = temporaryRoot('dev-remediation-recovery-db-mismatch');
  const key = crypto.randomBytes(32);
  const value = contract();
  let packageRuns = 0;
  try {
    await createRecoveryRequiredState(root, key, value);
    await assert.rejects(runDevRecoveryRemediationRecovery({
      rootDirectory: root,
      key,
      contract: value,
      executor: executor(value),
      afterRecoveryBoundaryPublished() {
        throw Object.assign(new Error('INJECTED_RECOVERY_BOUNDARY_CRASH'), {
          code: 'INJECTED_RECOVERY_BOUNDARY_CRASH'
        });
      }
    }), { code: 'DEV_REMEDIATION_RECOVERY_DATABASE_OUTCOME_AMBIGUOUS' });
    await assert.rejects(runDevRecoveryRemediationRecovery({
      rootDirectory: root,
      key,
      contract: value,
      executor: {
        async run(stage, context) {
          if (context.recoveryDatabaseMode === 'EXECUTE_ONCE') packageRuns += 1;
          if (stage === 'REMEDIATION_RECOVERY_DATABASE') {
            const error = Object.assign(new Error('DEV_REFRESH_REAL_STAGE_RECONCILIATION_FAILED'), {
              code: 'DEV_REFRESH_REAL_STAGE_RECONCILIATION_FAILED'
            });
            Object.defineProperty(error, 'operationFailure', {
              value: {
                category: 'DEV_REMEDIATION_RECOVERY_DATABASE_STATE_RECONCILIATION_MISMATCH',
                transactionOutcome: 'not_started'
              }
            });
            throw error;
          }
          return evidence(value, stage);
        }
      }
    }), { code: 'DEV_REMEDIATION_RECOVERY_FAILED' });
    assert.equal(readRemediationJournal(root, key).current.state, 'REMEDIATION_RECOVERY_FAILED');
    assert.equal(packageRuns, 0);
  } finally {
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('committed R3 database restoration survives interruption and completes verification without replay', async () => {
  const root = temporaryRoot('dev-remediation-recovery-committed');
  const key = crypto.randomBytes(32);
  const value = contract();
  let databaseRuns = 0;
  let verificationRuns = 0;
  const counted = {
    async run(stage) {
      if (stage === 'REMEDIATION_RECOVERY_DATABASE') databaseRuns += 1;
      if (stage === 'REMEDIATION_RECOVERY_VERIFIED') verificationRuns += 1;
      return evidence(value, stage);
    }
  };
  try {
    await createRecoveryRequiredState(root, key, value);
    await assert.rejects(runDevRecoveryRemediationRecovery({
      rootDirectory: root,
      key,
      contract: value,
      executor: counted,
      afterRecoveryDatabaseCommitted() {
        throw Object.assign(new Error('INJECTED_POST_COMMIT_CRASH'), {
          code: 'INJECTED_POST_COMMIT_CRASH'
        });
      }
    }), { code: 'DEV_REMEDIATION_RECOVERY_FAILED' });
    assert.equal(databaseRuns, 1);
    assert.equal(verificationRuns, 0);
    assert.equal(remediationRestartDisposition(root, key), 'REMEDIATION_RECOVERY_DATABASE_COMMITTED');
    const result = await runDevRecoveryRemediationRecovery({
      rootDirectory: root,
      key,
      contract: value,
      executor: counted
    });
    assert.equal(result.classification, 'DEV_RECOVERY_REMEDIATION_R3_RECOVERED');
    assert.equal(databaseRuns, 1);
    assert.equal(verificationRuns, 1);
  } finally {
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('functional recovery verification remains pending and can complete non-destructively', async () => {
  const root = temporaryRoot('dev-remediation-recovery-verification');
  const key = crypto.randomBytes(32);
  const value = contract();
  let databaseRuns = 0;
  let verificationRuns = 0;
  const first = {
    async run(stage) {
      if (stage === 'REMEDIATION_RECOVERY_DATABASE') databaseRuns += 1;
      if (stage === 'REMEDIATION_RECOVERY_VERIFIED') {
        verificationRuns += 1;
        throw Object.assign(new Error('INJECTED_VERIFICATION_TRANSPORT_FAILURE'), {
          code: 'INJECTED_VERIFICATION_TRANSPORT_FAILURE'
        });
      }
      return evidence(value, stage);
    }
  };
  try {
    await createRecoveryRequiredState(root, key, value);
    await assert.rejects(runDevRecoveryRemediationRecovery({
      rootDirectory: root,
      key,
      contract: value,
      executor: first
    }), { code: 'DEV_REMEDIATION_RECOVERY_VERIFICATION_PENDING' });
    assert.equal(databaseRuns, 1);
    assert.equal(remediationRestartDisposition(root, key), 'REMEDIATION_RECOVERY_VERIFICATION_PENDING');
    const second = {
      async run(stage) {
        if (stage === 'REMEDIATION_RECOVERY_DATABASE') databaseRuns += 1;
        if (stage === 'REMEDIATION_RECOVERY_VERIFIED') verificationRuns += 1;
        return evidence(value, stage);
      }
    };
    const result = await runDevRecoveryRemediationRecovery({
      rootDirectory: root,
      key,
      contract: value,
      executor: second
    });
    assert.equal(result.classification, 'DEV_RECOVERY_REMEDIATION_R3_RECOVERED');
    assert.equal(databaseRuns, 1);
    assert.equal(verificationRuns, 2);
  } finally {
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
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

test('pre-boundary Auth residue is terminal before R3 and marker publication', async () => {
  const root = temporaryRoot('dev-remediation-pre-boundary');
  const key = crypto.randomBytes(32);
  const value = contract();
  try {
    const base = executor(value);
    await assert.rejects(runDevRecoveryRemediation({
      rootDirectory: root,
      key,
      contract: value,
      executor: {
        async run(stage, context) {
          if (stage === 'REMEDIATION_PRECHECK') {
            throw Object.assign(new Error('DEV_REMEDIATION_PREBOUNDARY_AUTH_RESIDUE'), {
              code: 'DEV_REMEDIATION_PREBOUNDARY_AUTH_RESIDUE'
            });
          }
          return base.run(stage, context);
        }
      }
    }), { code: 'DEV_REMEDIATION_PREBOUNDARY_AUTH_RESIDUE' });
    const journal = readRemediationJournal(root, key);
    assert.equal(journal.current.state, 'FAILED_PRE_MUTATION');
    assert.equal(journal.current.failureCategory, 'DEV_REMEDIATION_PREBOUNDARY_AUTH_RESIDUE');
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
  const userId = crypto.randomUUID();
  const organizationId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const server = http.createServer(async (request, response) => {
    const observedUrl = new URL(request.url, 'http://localhost');
    seen.push(`${request.method} ${observedUrl.pathname}${observedUrl.search}`);
    response.setHeader('content-type', 'application/json');
    if (request.url.startsWith('/auth/v1/token')) {
      response.end(JSON.stringify({
        access_token: syntheticAccessToken(userId, sessionId), refresh_token: 'local-refresh', user: { id: userId }
      }));
      return;
    }
    if (request.url === '/auth/v1/logout?scope=local') {
      response.end('{}');
      return;
    }
    if (request.url === '/functions/v1/api?path=%2Fauth%2Fcontext') {
      response.end(JSON.stringify({ data: {
        orgId: organizationId, role: 'owner', defaultWarehouse: 'LOCAL'
      } }));
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
    EDGE_API_BASE_URL: `${origin}/functions/v1/api`,
    SUPABASE_ANON_KEY: 'local-anon',
    SMOKE_USER_EMAIL: 'local@example.invalid',
    SMOKE_USER_PASSWORD: 'local-only'
  });
  try {
    const result = await runFreshAuthentication({ preparation: {
      mode: 'disposable-managed-local',
      targetSession: {
        smokeUserId: userId,
        smokeOrganizationId: organizationId,
        smokeDefaultWarehouse: 'LOCAL'
      }
    } });
    assert.equal(result.freshAuthentication, true);
    assert.equal(result.authContextOwner, true);
    assert.equal(result.smokeUserExact, true);
    assert.equal(result.smokeOrganizationExact, true);
    assert.equal(result.defaultWarehouseExact, true);
    assert.equal(result.filmCatalogReadSucceeded, true);
    assert.equal(result.boxSearchReadSucceeded, true);
    assert.equal(result.jobsReadSucceeded, true);
    assert.equal(result.readOnlyApiSucceeded, true);
    assert.equal(result.logoutSucceeded, true);
    assert.equal(result.sessionRevoked, false);
    assert.deepEqual(seen, [
      'POST /auth/v1/token?grant_type=password', 'GET /functions/v1/api?path=%2Fauth%2Fcontext',
      'GET /functions/v1/api?path=%2Ffilm-data%2Fcatalog',
      'GET /functions/v1/api?path=%2Fboxes%2Fsearch&warehouse=ALL&q=CODEX_REMEDIATION_READ_ONLY_NO_MATCH',
      'GET /functions/v1/api?path=%2Fjobs%2Flist&limit=1', 'POST /auth/v1/logout?scope=local'
    ]);
    process.env.SUPABASE_URL = 'https://example.com';
    await assert.rejects(runFreshAuthentication({ preparation: {
      mode: 'disposable-managed-local',
      targetSession: {
        smokeUserId: userId,
        smokeOrganizationId: organizationId,
        smokeDefaultWarehouse: 'LOCAL'
      }
    } }), {
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
    const missingCertificates = spawnIsolated(PREPARE_ENTRY, [
      '--env', 'unread.env', '--authority-key', 'unread.key',
      '--original-contract', 'unread-contract', '--original-preparation', 'unread-preparation',
      '--failed-state-dir', 'unread-state', '--expected-original-attempt', 'unread-attempt',
      '--expected-original-y2', 'unread-y2', '--output-dir', 'unwritten-output'
    ], root);
    assert.equal(missingCertificates.status, 1);
    assert.match(missingCertificates.stderr, /DEV_REMEDIATION_PREPARATION_ARGUMENT_MISSING/);
    assert.doesNotMatch(missingCertificates.stderr, /unread|unwritten/);
    const prepareSource = fs.readFileSync(PREPARE_ENTRY, 'utf8');
    for (const option of [
      '--env', '--authority-key', '--original-contract', '--original-preparation',
      '--failed-state-dir', '--expected-original-attempt', '--expected-original-y2', '--output-dir',
      '--side-effect-certificate', '--edge-certificate'
    ]) {
      assert.ok(prepareSource.match(new RegExp(option, 'g')).length >= 2, `${option} must appear in validation and usage`);
    }
    assert.deepEqual(fs.readdirSync(root).sort(), ['home', 'temp']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('preparation performs no business or schema mutation and defers R3 creation to execution', () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL('./dev-recovery-remediation-preparation.mjs', import.meta.url)),
    'utf8'
  );
  assert.match(source, /captureRecoveryOwnedState/);
  assert.match(source, /runFreshAuthenticationCanary/);
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
