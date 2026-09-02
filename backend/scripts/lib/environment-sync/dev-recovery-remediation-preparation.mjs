import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { canonicalDigest, canonicalSerialize } from '../readonly-diagnostics.mjs';
import { buildMutationTargetReport, loadEnvFile } from '../target-env-guards.mjs';
import {
  DEV_PROJECT_REF,
  sha256Bytes,
  verifyRepositoryLineage
} from './dev-certified-contract.mjs';
import {
  authenticateOperationInventory,
  buildOperationInventory,
  verifyOperationInventory
} from './dev-certified-operation-executor.mjs';
import { edgeSourceCertificate, readAuthorityKey } from './dev-certified-preparation.mjs';
import {
  CURRENT_REMEDIATION_WORKER_REPO_PATH,
  REMEDIATION_OPERATION_STAGES,
  REMEDIATION_PROVENANCE_FIX_BASE_COMMIT,
  REQUIRED_DIAGNOSTIC_TOOLING_COMMIT,
  authenticateRecoveryRemediationContract,
  buildRemediationProvenanceBridge,
  buildRecoveryRemediationContract,
  normalizeRemediationProvenanceBridge,
  remediationStageEnvironmentNames,
  verifyAuthenticatedRecoveryRemediationContract
} from './dev-recovery-remediation-contract.mjs';
import {
  assertRecoveryApplicationStateEqual,
  buildObservedDevCertificate,
  captureRemediationAuthCertificate,
  captureRecoveryOwnedState,
  readOriginalFailedRecovery,
  withReadOnlySnapshot
} from './dev-recovery-remediation-shared.mjs';
import {
  AUTH_EPHEMERA_MODES,
  assertExactRemediationUrls,
  assertRemediationAuthTransition,
  captureQuietWindowFromClient,
  captureRuntimeSideEffectPostureFromClient,
  fetchAuthAuditStoragePosture,
  fetchFreshEdgeIdentity,
  runFreshAuthenticationCanary
} from './dev-recovery-remediation-auth.mjs';
import {
  createPrivateDirectory,
  privateArtifactPath,
  verifyPrivateArtifactProtection,
  writePrivateJsonExclusive
} from './private-artifacts.mjs';
import { signPayload } from './dev-certified-state.mjs';
import { readRemediationJournal } from './dev-recovery-remediation-state.mjs';

const REMEDIATION_PREPARATION_FORMAT = 'dev-recovery-remediation-preparation-v1';
const REMEDIATION_REAL_STAGE_WORKER = fileURLToPath(
  new URL('./dev-recovery-remediation-real-stage-worker.mjs', import.meta.url)
);
const REFRESH_SYNTHETIC_WORKER = fileURLToPath(new URL('./dev-certified-test-worker.mjs', import.meta.url));
const REFRESH_SYNTHETIC_WORKER_REPO_PATH = 'backend/scripts/lib/environment-sync/dev-certified-test-worker.mjs';
const PREPARATION_TTL_MS = 2 * 60 * 60 * 1000;

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function digestFile(filePath) {
  const bytes = fs.readFileSync(filePath);
  try {
    return sha256Bytes(bytes);
  } finally {
    bytes.fill(0);
  }
}

function digestGitFile(repoRoot, commit, repoPath) {
  let bytes;
  try {
    bytes = execFileSync('git', ['show', `${commit}:${repoPath}`], {
      cwd: repoRoot,
      encoding: null,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return sha256Bytes(bytes);
  } catch {
    throw categoricalError('DEV_REMEDIATION_CURRENT_WORKER_SOURCE_MISSING');
  } finally {
    if (bytes) bytes.fill(0);
  }
}

function readPrivateJson(filePath) {
  verifyPrivateArtifactProtection(filePath);
  const bytes = fs.readFileSync(filePath);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } finally {
    bytes.fill(0);
  }
}

function exactDatabaseUrl(values) {
  const candidates = ['DEV_DATABASE_URL', 'DATABASE_URL', 'SUPABASE_DB_URL']
    .map((name) => String(values[name] || '').trim()).filter(Boolean);
  if (candidates.length === 0 || new Set(candidates).size !== 1) {
    throw categoricalError('DEV_REMEDIATION_DATABASE_URL_AMBIGUOUS');
  }
  return candidates[0];
}

function assertFreshAuthConfiguration(values, { disposable = false } = {}) {
  for (const name of [
    'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'EDGE_API_BASE_URL', 'SMOKE_USER_EMAIL', 'SMOKE_USER_PASSWORD'
  ]) {
    if (!String(values[name] || '').trim()) throw categoricalError('DEV_REMEDIATION_FRESH_AUTH_CONFIGURATION_MISSING');
  }
  if (!disposable && !String(values.SUPABASE_ACCESS_TOKEN || '').trim()) {
    throw categoricalError('DEV_REMEDIATION_MANAGEMENT_TOKEN_MISSING');
  }
  const urls = [values.SUPABASE_URL, values.EDGE_API_BASE_URL].map((value) => new URL(value));
  if (disposable) {
    if (urls.some((url) => !['127.0.0.1', 'localhost'].includes(url.hostname))) {
      throw categoricalError('DEV_REMEDIATION_DISPOSABLE_AUTH_NOT_LOOPBACK');
    }
  } else if (urls.some((url) => !url.hostname.includes(DEV_PROJECT_REF))) {
    throw categoricalError('DEV_REMEDIATION_AUTH_TARGET_MISMATCH');
  }
}

function assertDiagnosticAncestor(repoRoot, toolingCommit) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', REQUIRED_DIAGNOSTIC_TOOLING_COMMIT, toolingCommit], {
      cwd: repoRoot,
      shell: false,
      windowsHide: true,
      stdio: 'ignore'
    });
  } catch {
    throw categoricalError('DEV_REMEDIATION_REQUIRED_DIAGNOSTIC_COMMIT_MISSING');
  }
}

function assertCompatibilityBase(repoRoot, toolingCommit) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', REMEDIATION_PROVENANCE_FIX_BASE_COMMIT, toolingCommit], {
      cwd: repoRoot,
      shell: false,
      windowsHide: true,
      stdio: 'ignore'
    });
  } catch {
    throw categoricalError('DEV_REMEDIATION_COMPATIBILITY_BASE_MISSING');
  }
}

function authenticateRemediationPreparation(preparation, key) {
  return {
    preparation,
    authentication: { algorithm: 'hmac-sha256-v1', digest: signPayload(preparation, key) }
  };
}

function verifyRemediationPreparationStructure(record, key, expectedAttemptId = '') {
  const preparation = record?.preparation;
  const version = preparation?.version;
  if (
    record?.authentication?.algorithm !== 'hmac-sha256-v1' ||
    record.authentication.digest !== signPayload(preparation, key) ||
    preparation?.format !== REMEDIATION_PREPARATION_FORMAT || ![1, 2, 3].includes(version) ||
    preparation?.target?.environment !== 'dev' || preparation?.target?.projectRef !== DEV_PROJECT_REF ||
    (expectedAttemptId && preparation.remediationAttemptId !== expectedAttemptId) ||
    preparation?.stageWorker?.path !== path.resolve(REMEDIATION_REAL_STAGE_WORKER) ||
    preparation?.stageWorker?.digest !== digestFile(REMEDIATION_REAL_STAGE_WORKER) ||
    preparation?.stageWorker?.digest === digestFile(REFRESH_SYNTHETIC_WORKER) ||
    preparation?.original?.binding?.recoveryState !== 'RECOVERY_FAILED' ||
    preparation?.original?.binding?.retryAllowed !== false ||
    preparation?.currentObserved?.certificateDigest !== canonicalDigest(
      Object.fromEntries(Object.entries(preparation.currentObserved || {}).filter(([name]) => name !== 'certificateDigest'))
    )
  ) throw categoricalError('DEV_REMEDIATION_PREPARATION_INVALID');
  if (version >= 2) {
    const bridge = normalizeRemediationProvenanceBridge(preparation.provenanceBridge);
    if (
      canonicalSerialize(bridge.historical) !== canonicalSerialize(preparation.original?.provenance) ||
      bridge.historical.provenanceDigest !== preparation.original?.binding?.historicalProvenanceDigest ||
      bridge.historical.operationInventoryDigest !== preparation.original?.binding?.originalOperationInventoryDigest ||
      bridge.currentExecution.compatibilityBaseCommit !== REMEDIATION_PROVENANCE_FIX_BASE_COMMIT ||
      bridge.currentExecution.toolingCommit !== preparation.candidate?.toolingCommit ||
      bridge.currentExecution.toolingTree !== preparation.candidate?.toolingTree ||
      bridge.currentExecution.workerRepoPath !== CURRENT_REMEDIATION_WORKER_REPO_PATH ||
      bridge.currentExecution.workerDigest !== preparation.stageWorker.digest ||
      bridge.currentExecution.rejectedSyntheticWorkerDigest !== preparation.stageWorker.rejectedSyntheticWorkerDigest ||
      bridge.currentExecution.operationInventoryDigest !== preparation.operationInventoryDigest ||
      !/^sha256:[0-9a-f]{64}$/.test(String(preparation.contractDigest || '')) ||
      !String(preparation.original?.originalInventoryPath || '').trim()
    ) throw categoricalError('DEV_REMEDIATION_PREPARATION_PROVENANCE_INVALID');
  }
  if (version === 3 && (
    preparation.authHardening?.format !== 'dev-recovery-remediation-auth-hardening-v1' ||
    preparation.authHardening?.baseline?.format !== 'dev-recovery-remediation-semantic-auth-v1' ||
    preparation.authHardening?.canary?.freshAuthentication !== true ||
    preparation.authHardening?.canary?.stableStateExact !== true ||
    preparation.authHardening?.canary?.sessionRevoked !== true ||
    preparation.authHardening?.canary?.ephemeralSessionException !== false ||
    preparation.authHardening?.canary?.ephemeraMode !== AUTH_EPHEMERA_MODES.IMMEDIATE_CANARY_DISCOVERY ||
    preparation.authHardening?.canary?.allowedNativeEphemera?.sessions?.length !== 0 ||
    preparation.authHardening?.canary?.allowedNativeEphemera?.refreshTokens?.length !== 0 ||
    preparation.authHardening?.auditPosture?.format !== 'dev-recovery-remediation-auth-audit-posture-v1' ||
    preparation.authHardening?.auditPosture?.postgresStorage !== 'disabled' ||
    preparation.authHardening?.auditPosture?.prerequisiteExact !== true ||
    preparation.authHardening?.readiness?.realQuietWindow !== true ||
    preparation.authHardening?.readiness?.freshSideEffectsSafe !== true ||
    preparation.authHardening?.readiness?.freshEdgeExact !== true ||
    canonicalSerialize(preparation.currentObserved?.authHardening) !==
      canonicalSerialize(preparation.authHardening) ||
    !Object.hasOwn(preparation.targetSession || {}, 'smokeDefaultWarehouse') ||
    typeof preparation.targetSession.smokeDefaultWarehouse !== 'string'
  )) throw categoricalError('DEV_REMEDIATION_PREPARATION_AUTH_HARDENING_INVALID');
  return preparation;
}

function verifyRemediationPreparation(record, key, expectedAttemptId = '', { now = Date.now() } = {}) {
  const preparation = verifyRemediationPreparationStructure(record, key, expectedAttemptId);
  if (!Number.isFinite(now) || now > Date.parse(preparation.expiresAt)) {
    throw categoricalError('DEV_REMEDIATION_PREPARATION_INVALID');
  }
  return preparation;
}

const FROZEN_STAGE_STATES = Object.freeze({
  RECOVERY_CLI: Object.freeze([
    'REMEDIATION_RECOVERY_REQUIRED',
    'REMEDIATION_RECOVERY_AUTHORIZED',
    'REMEDIATION_RECOVERY_DATABASE_BOUNDARY',
    'REMEDIATION_RECOVERY_DATABASE_COMMITTED',
    'REMEDIATION_RECOVERY_DATABASE_STATE_RECONCILED',
    'REMEDIATION_RECOVERY_VERIFICATION_PENDING',
    'REMEDIATION_RECOVERY_VERIFIED'
  ]),
  RESTORE_ORIGINAL_Y2: Object.freeze(['RESTORE_ORIGINAL_Y2']),
  AUTH_RUNTIME_VERIFIED: Object.freeze(['AUTH_RUNTIME_VERIFIED']),
  APPLICATION_RUNTIME_VERIFIED: Object.freeze(['APPLICATION_RUNTIME_VERIFIED']),
  FINAL_Y2_PARITY: Object.freeze(['FINAL_Y2_PARITY']),
  REMEDIATION_RECOVERY_PRECHECK: Object.freeze([
    'REMEDIATION_RECOVERY_REQUIRED', 'REMEDIATION_RECOVERY_AUTHORIZED'
  ]),
  REMEDIATION_RECOVERY_DATABASE: Object.freeze(['REMEDIATION_RECOVERY_DATABASE_BOUNDARY']),
  REMEDIATION_RECOVERY_VERIFIED: Object.freeze(['REMEDIATION_RECOVERY_VERIFICATION_PENDING'])
});

function verifyFrozenRemediationPreparation(record, key, {
  rootDirectory,
  expectedAttemptId = '',
  contractDigest = '',
  operationInventoryDigest = '',
  stage
} = {}) {
  const preparation = verifyRemediationPreparationStructure(record, key, expectedAttemptId);
  const expectedStates = FROZEN_STAGE_STATES[stage];
  if (!expectedStates) throw categoricalError('DEV_REMEDIATION_FROZEN_STAGE_INVALID');
  const journal = readRemediationJournal(rootDirectory, key);
  const marker = journal.marker;
  const boundary = journal.boundary;
  const initialRecoveryPrecheck = stage === 'REMEDIATION_RECOVERY_PRECHECK' &&
    journal.current.state === 'REMEDIATION_RECOVERY_REQUIRED' && !journal.recovery &&
    !journal.recoveryBoundary;
  const continuingRecoveryPrecheck = stage === 'REMEDIATION_RECOVERY_PRECHECK' &&
    journal.current.state === 'REMEDIATION_RECOVERY_AUTHORIZED' && Boolean(journal.recovery) &&
    !journal.recoveryBoundary;
  const recoveryDatabase = stage === 'REMEDIATION_RECOVERY_DATABASE' &&
    Boolean(journal.recovery) && Boolean(journal.recoveryBoundary);
  const recoveryVerification = stage === 'REMEDIATION_RECOVERY_VERIFIED' &&
    Boolean(journal.recovery) && Boolean(journal.recoveryBoundary);
  const recoveryCli = stage === 'RECOVERY_CLI' && (
    (journal.current.state === 'REMEDIATION_RECOVERY_REQUIRED' && !journal.recoveryBoundary) ||
    (journal.current.state === 'REMEDIATION_RECOVERY_AUTHORIZED' && Boolean(journal.recovery)) ||
    ([
      'REMEDIATION_RECOVERY_DATABASE_BOUNDARY',
      'REMEDIATION_RECOVERY_DATABASE_COMMITTED',
      'REMEDIATION_RECOVERY_DATABASE_STATE_RECONCILED',
      'REMEDIATION_RECOVERY_VERIFICATION_PENDING',
      'REMEDIATION_RECOVERY_VERIFIED'
    ].includes(journal.current.state) && Boolean(journal.recovery) && Boolean(journal.recoveryBoundary))
  );
  if (
    !expectedStates.includes(journal.current.state) || !marker || !boundary ||
    marker.preparationDigest !== canonicalDigest(preparation) ||
    marker.contractDigest !== contractDigest ||
    marker.operationInventoryDigest !== operationInventoryDigest ||
    marker.operationInventoryDigest !== preparation.operationInventoryDigest ||
    marker.stageWorkerDigest !== preparation.stageWorker.digest ||
    marker.toolingCommit !== preparation.candidate.toolingCommit ||
    marker.toolingTree !== preparation.candidate.toolingTree ||
    marker.remediationAttemptId !== preparation.remediationAttemptId ||
    (stage === 'RECOVERY_CLI' && !recoveryCli) ||
    (stage === 'REMEDIATION_RECOVERY_PRECHECK' &&
      !initialRecoveryPrecheck && !continuingRecoveryPrecheck) ||
    (stage === 'REMEDIATION_RECOVERY_DATABASE' && !recoveryDatabase) ||
    (stage === 'REMEDIATION_RECOVERY_VERIFIED' && !recoveryVerification)
  ) throw categoricalError('DEV_REMEDIATION_FROZEN_PREPARATION_MISMATCH');
  return preparation;
}

async function prepareDevRecoveryRemediation({
  repoRoot,
  envFilePath,
  authorityKeyPath,
  originalContractPath,
  originalPreparationPath,
  failedStateDirectory,
  expectedRefreshAttemptId,
  expectedY2RecoveryId,
  outputDirectory,
  sideEffectCertificatePath = '',
  edgeCertificatePath = '',
  postgresBin = '',
  disposable = false
} = {}) {
  const root = path.resolve(repoRoot);
  const output = createPrivateDirectory(path.resolve(outputDirectory));
  const key = readAuthorityKey(authorityKeyPath);
  try {
    const lineage = verifyRepositoryLineage({ repoRoot: root });
    assertDiagnosticAncestor(root, lineage.toolingCommit);
    assertCompatibilityBase(root, lineage.toolingCommit);
    verifyPrivateArtifactProtection(envFilePath);
    const envBytes = fs.readFileSync(envFilePath);
    let envFileDigest;
    try {
      envFileDigest = sha256Bytes(envBytes);
    } finally {
      envBytes.fill(0);
    }
    const loaded = loadEnvFile(envFilePath);
    if (!disposable) {
      const guard = buildMutationTargetReport({
        envPath: loaded.path,
        envValues: loaded.values,
        requestedTarget: 'dev',
        allowProd: false,
        linked: false,
        linkedRef: ''
      });
      if (!guard.ok || guard.expected.ref !== DEV_PROJECT_REF) {
        throw categoricalError('DEV_REMEDIATION_TARGET_GUARD_FAILED');
      }
    }
    assertFreshAuthConfiguration(loaded.values, { disposable });
    assertExactRemediationUrls(loaded.values, { disposable });
    const originalContractRecord = readPrivateJson(path.resolve(originalContractPath));
    const originalPreparationRecord = readPrivateJson(path.resolve(originalPreparationPath));
    const originalInventoryPath = path.resolve(
      path.dirname(path.resolve(originalPreparationPath)),
      'operation-inventory.private.json'
    );
    const originalInventoryRecord = readPrivateJson(originalInventoryPath);
    const original = readOriginalFailedRecovery({
      failedStateDirectory: path.resolve(failedStateDirectory),
      key,
      repoRoot: root,
      currentToolingCommit: lineage.toolingCommit,
      originalContractRecord,
      originalPreparationRecord,
      originalInventoryRecord,
      expectedRefreshAttemptId,
      expectedY2RecoveryId
    });
    const connectionString = disposable
      ? String(original.preparation.targetBefore.session.connectionString || '')
      : exactDatabaseUrl(loaded.values);
    if (!connectionString || (
      !disposable && connectionString !== original.preparation.targetBefore.session.connectionString
    )) throw categoricalError('DEV_REMEDIATION_DATABASE_SESSION_BINDING_MISMATCH');
    const identity = {
      userId: original.preparation.fixtureAuthority.smokeActorId,
      organizationId: original.preparation.fixtureAuthority.primaryOrganizationId
    };
    const beforeCanary = await captureRemediationAuthCertificate(connectionString, identity);
    const auditPosture = await fetchAuthAuditStoragePosture({
      preparation: { mode: disposable ? 'disposable-managed-local' : 'managed-dev' },
      values: loaded.values
    });
    const smokeDefaultWarehouse = beforeCanary.stable.defaultWarehouse;
    const canaryPreparation = {
      mode: disposable ? 'disposable-managed-local' : 'managed-dev',
      targetSession: {
        smokeUserId: identity.userId,
        smokeOrganizationId: identity.organizationId,
        smokeDefaultWarehouse
      }
    };
    const canary = await runFreshAuthenticationCanary({ preparation: canaryPreparation, values: loaded.values });
    const afterCanary = await captureRemediationAuthCertificate(connectionString, {
      ...identity, expectedDefaultWarehouse: smokeDefaultWarehouse
    });
    const authTransition = assertRemediationAuthTransition(beforeCanary, afterCanary, {
      mode: AUTH_EPHEMERA_MODES.IMMEDIATE_CANARY_DISCOVERY,
      logoutSucceeded: canary.sessionRevoked,
      requireFreshLogin: true
    });
    if (
      canary.sessionRevoked !== true ||
      authTransition.allowedNativeEphemera.sessions.length !== 0 ||
      authTransition.allowedNativeEphemera.refreshTokens.length !== 0
    ) throw categoricalError('DEV_REMEDIATION_PREPARATION_AUTH_RESIDUE');
    assertRemediationAuthTransition(beforeCanary, afterCanary, {
      mode: AUTH_EPHEMERA_MODES.STRICT_CLEAN,
      logoutSucceeded: true,
      requireFreshLogin: false
    });
    const currentCore = await captureRecoveryOwnedState(connectionString, identity);
    assertRecoveryApplicationStateEqual(currentCore, original.y2.before);
    const sideEffects = disposable
      ? original.preparation.sideEffects
      : readPrivateJson(path.resolve(sideEffectCertificatePath));
    const edge = disposable
      ? original.preparation.edge
      : readPrivateJson(path.resolve(edgeCertificatePath));
    if (
      canonicalSerialize(sideEffects) !== canonicalSerialize(original.preparation.sideEffects) ||
      canonicalSerialize(edge) !== canonicalSerialize(original.preparation.edge) ||
      edge?.sourceDigest !== edgeSourceCertificate(root).sourceDigest
    ) throw categoricalError('DEV_REMEDIATION_PLATFORM_CERTIFICATE_MISMATCH');
    const freshDatabasePosture = await withReadOnlySnapshot(connectionString, async (client) => ({
      quietWindow: await captureQuietWindowFromClient(client),
      sideEffects: await captureRuntimeSideEffectPostureFromClient(client)
    }), 'dev-recovery-remediation-preparation-readiness');
    if (['cronJobs', 'networkCallers', 'webhooks', 'foreignResources'].some((name) =>
      Number(freshDatabasePosture.sideEffects[name]) !== Number(sideEffects.observed?.[name] || 0))) {
      throw categoricalError('DEV_REMEDIATION_FRESH_SIDE_EFFECT_CERTIFICATE_MISMATCH');
    }
    const freshEdge = await fetchFreshEdgeIdentity({
      preparation: {
        mode: disposable ? 'disposable-managed-local' : 'managed-dev',
        edge
      },
      values: loaded.values
    });
    const authHardening = {
      format: 'dev-recovery-remediation-auth-hardening-v1',
      baseline: afterCanary,
      canary: { ...canary, ...authTransition },
      auditPosture,
      readiness: {
        realQuietWindow: freshDatabasePosture.quietWindow.quiet,
        freshSideEffectsSafe: freshDatabasePosture.sideEffects.safe,
        freshEdgeExact: freshEdge.compatible
      }
    };
    const currentObserved = buildObservedDevCertificate({ core: currentCore, edge, sideEffects, authHardening });
    const remediationAttemptId = `dev-recovery-remediation-${new Date().toISOString().replace(/\D/g, '').slice(0, 17)}-${crypto.randomBytes(8).toString('hex')}`;
    const preparedAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(preparedAt) + PREPARATION_TTL_MS).toISOString();
    const preparationPath = privateArtifactPath(output, 'remediation-preparation.private.json');
    const stageWorker = {
      path: path.resolve(REMEDIATION_REAL_STAGE_WORKER),
      digest: digestFile(REMEDIATION_REAL_STAGE_WORKER),
      rejectedSyntheticWorkerDigest: digestFile(REFRESH_SYNTHETIC_WORKER),
      syntheticWorkerAllowed: false
    };
    if (
      stageWorker.path !== path.resolve(root, CURRENT_REMEDIATION_WORKER_REPO_PATH) ||
      stageWorker.digest !== digestGitFile(root, lineage.toolingCommit, CURRENT_REMEDIATION_WORKER_REPO_PATH) ||
      stageWorker.rejectedSyntheticWorkerDigest !== digestGitFile(
        root, lineage.toolingCommit, REFRESH_SYNTHETIC_WORKER_REPO_PATH
      )
    ) throw categoricalError('DEV_REMEDIATION_CURRENT_WORKER_PROVENANCE_INVALID');
    const operations = REMEDIATION_OPERATION_STAGES.map((stage) => ({
      stage,
      runtime: 'node',
      executable: process.execPath,
      executableDigest: digestFile(process.execPath),
      script: stageWorker.path,
      scriptDigest: stageWorker.digest,
      cwd: root,
      args: ['--preparation', preparationPath],
      environmentNames: remediationStageEnvironmentNames(stage, { disposable }),
      timeoutMs: 30 * 60 * 1000
    }));
    const unsignedInventory = buildOperationInventory({
      attemptId: remediationAttemptId,
      envFileDigest,
      operations,
      requiredStages: REMEDIATION_OPERATION_STAGES
    });
    const provenanceBridge = buildRemediationProvenanceBridge({
      historical: original.provenance,
      currentExecution: {
        format: 'dev-recovery-current-execution-provenance-v1',
        digestScope: 'exact-committed-file-sha256-v1',
        compatibilityBaseCommit: REMEDIATION_PROVENANCE_FIX_BASE_COMMIT,
        toolingCommit: lineage.toolingCommit,
        toolingTree: lineage.toolingTree,
        workerRepoPath: CURRENT_REMEDIATION_WORKER_REPO_PATH,
        workerDigest: stageWorker.digest,
        rejectedSyntheticWorkerDigest: stageWorker.rejectedSyntheticWorkerDigest,
        operationInventoryDigest: unsignedInventory.inventoryDigest
      }
    });
    const contract = buildRecoveryRemediationContract({
      remediationAttemptId,
      toolingCommit: lineage.toolingCommit,
      toolingTree: lineage.toolingTree,
      originalBinding: original.binding,
      provenanceBridge,
      observedDevCertificateDigest: currentObserved.certificateDigest,
      operationInventoryDigest: unsignedInventory.inventoryDigest,
      preparedAt,
      expiresAt
    });
    const preparation = {
      format: REMEDIATION_PREPARATION_FORMAT,
      version: 3,
      remediationAttemptId,
      mode: disposable ? 'disposable-managed-local' : 'managed-dev',
      target: { environment: 'dev', projectRef: DEV_PROJECT_REF },
      candidate: lineage,
      original: {
        binding: original.binding,
        provenance: original.provenance,
        failedStateDirectory: path.resolve(failedStateDirectory),
        originalContractPath: path.resolve(originalContractPath),
        originalPreparationPath: path.resolve(originalPreparationPath),
        originalInventoryPath
      },
      provenanceBridge,
      contractDigest: contract.contractDigest,
      operationInventoryDigest: unsignedInventory.inventoryDigest,
      currentObserved,
      targetSession: {
        connectionString,
        postgresBin: postgresBin || original.preparation.targetBefore.session.postgresBin || '',
        smokeUserId: identity.userId,
        smokeOrganizationId: identity.organizationId,
        smokeDefaultWarehouse
      },
      authHardening,
      edge,
      sideEffects,
      stageWorker,
      r3Policy: { captureAtExecution: true, fallbackOnly: true },
      preparedAt,
      expiresAt,
      sharedMutationsDuringPreparation: 0
    };
    writePrivateJsonExclusive(preparationPath, authenticateRemediationPreparation(preparation, key));
    verifyRemediationPreparation(readPrivateJson(preparationPath), key, remediationAttemptId);
    const contractPath = privateArtifactPath(output, 'remediation-contract.private.json');
    const inventoryPath = privateArtifactPath(output, 'remediation-operation-inventory.private.json');
    writePrivateJsonExclusive(contractPath, authenticateRecoveryRemediationContract(contract, key));
    writePrivateJsonExclusive(inventoryPath, authenticateOperationInventory(unsignedInventory, key));
    verifyAuthenticatedRecoveryRemediationContract(readPrivateJson(contractPath), key);
    verifyOperationInventory(readPrivateJson(inventoryPath), key, {
      attemptId: contract.remediationAttemptId,
      operationInventoryDigest: contract.operationInventoryDigest
    }, envFilePath, { requiredStages: REMEDIATION_OPERATION_STAGES });
    return {
      classification: 'DEV_RECOVERY_REMEDIATION_PREPARATION_COMPLETE',
      target: 'dev',
      realStageCount: operations.length,
      syntheticWorkerAbsent: operations.every((operation) =>
        operation.scriptDigest !== preparation.stageWorker.rejectedSyntheticWorkerDigest),
      r3Created: false,
      sharedMutations: 0,
      output: { preparationPath, contractPath, inventoryPath },
      disposable
    };
  } finally {
    key.fill(0);
  }
}

export {
  PREPARATION_TTL_MS,
  REMEDIATION_PREPARATION_FORMAT,
  REMEDIATION_REAL_STAGE_WORKER,
  assertFreshAuthConfiguration,
  authenticateRemediationPreparation,
  prepareDevRecoveryRemediation,
  verifyFrozenRemediationPreparation,
  verifyRemediationPreparation
};
