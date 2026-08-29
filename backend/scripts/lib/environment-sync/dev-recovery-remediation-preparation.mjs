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
  REMEDIATION_OPERATION_STAGES,
  REQUIRED_DIAGNOSTIC_TOOLING_COMMIT,
  authenticateRecoveryRemediationContract,
  buildRecoveryRemediationContract,
  verifyAuthenticatedRecoveryRemediationContract
} from './dev-recovery-remediation-contract.mjs';
import {
  assertRecoveryOwnedStateEqual,
  buildObservedDevCertificate,
  captureRecoveryOwnedState,
  readOriginalFailedRecovery
} from './dev-recovery-remediation-shared.mjs';
import {
  createPrivateDirectory,
  privateArtifactPath,
  verifyPrivateArtifactProtection,
  writePrivateJsonExclusive
} from './private-artifacts.mjs';
import { signPayload } from './dev-certified-state.mjs';

const REMEDIATION_PREPARATION_FORMAT = 'dev-recovery-remediation-preparation-v1';
const REMEDIATION_REAL_STAGE_WORKER = fileURLToPath(
  new URL('./dev-recovery-remediation-real-stage-worker.mjs', import.meta.url)
);
const REFRESH_SYNTHETIC_WORKER = fileURLToPath(new URL('./dev-certified-test-worker.mjs', import.meta.url));
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

function authenticateRemediationPreparation(preparation, key) {
  return {
    preparation,
    authentication: { algorithm: 'hmac-sha256-v1', digest: signPayload(preparation, key) }
  };
}

function verifyRemediationPreparation(record, key, expectedAttemptId = '') {
  const preparation = record?.preparation;
  if (
    record?.authentication?.algorithm !== 'hmac-sha256-v1' ||
    record.authentication.digest !== signPayload(preparation, key) ||
    preparation?.format !== REMEDIATION_PREPARATION_FORMAT || preparation?.version !== 1 ||
    preparation?.target?.environment !== 'dev' || preparation?.target?.projectRef !== DEV_PROJECT_REF ||
    (expectedAttemptId && preparation.remediationAttemptId !== expectedAttemptId) ||
    preparation?.stageWorker?.path !== path.resolve(REMEDIATION_REAL_STAGE_WORKER) ||
    preparation?.stageWorker?.digest !== digestFile(REMEDIATION_REAL_STAGE_WORKER) ||
    preparation?.stageWorker?.digest === digestFile(REFRESH_SYNTHETIC_WORKER) ||
    preparation?.original?.binding?.recoveryState !== 'RECOVERY_FAILED' ||
    preparation?.original?.binding?.retryAllowed !== false ||
    preparation?.currentObserved?.certificateDigest !== canonicalDigest(
      Object.fromEntries(Object.entries(preparation.currentObserved || {}).filter(([name]) => name !== 'certificateDigest'))
    ) ||
    Date.now() > Date.parse(preparation.expiresAt)
  ) throw categoricalError('DEV_REMEDIATION_PREPARATION_INVALID');
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
    const originalContractRecord = readPrivateJson(path.resolve(originalContractPath));
    const originalPreparationRecord = readPrivateJson(path.resolve(originalPreparationPath));
    const original = readOriginalFailedRecovery({
      failedStateDirectory: path.resolve(failedStateDirectory),
      key,
      originalContractRecord,
      originalPreparationRecord,
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
    const currentCore = await captureRecoveryOwnedState(connectionString, identity);
    assertRecoveryOwnedStateEqual(currentCore, original.y2.before);
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
    const currentObserved = buildObservedDevCertificate({ core: currentCore, edge, sideEffects });
    const remediationAttemptId = `dev-recovery-remediation-${new Date().toISOString().replace(/\D/g, '').slice(0, 17)}-${crypto.randomBytes(8).toString('hex')}`;
    const preparedAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(preparedAt) + PREPARATION_TTL_MS).toISOString();
    const preparation = {
      format: REMEDIATION_PREPARATION_FORMAT,
      version: 1,
      remediationAttemptId,
      mode: disposable ? 'disposable-managed-local' : 'managed-dev',
      target: { environment: 'dev', projectRef: DEV_PROJECT_REF },
      candidate: lineage,
      original: {
        binding: original.binding,
        failedStateDirectory: path.resolve(failedStateDirectory),
        originalContractPath: path.resolve(originalContractPath),
        originalPreparationPath: path.resolve(originalPreparationPath)
      },
      currentObserved,
      targetSession: {
        connectionString,
        postgresBin: postgresBin || original.preparation.targetBefore.session.postgresBin || '',
        smokeUserId: identity.userId,
        smokeOrganizationId: identity.organizationId
      },
      edge,
      sideEffects,
      stageWorker: {
        path: path.resolve(REMEDIATION_REAL_STAGE_WORKER),
        digest: digestFile(REMEDIATION_REAL_STAGE_WORKER),
        rejectedSyntheticWorkerDigest: digestFile(REFRESH_SYNTHETIC_WORKER),
        syntheticWorkerAllowed: false
      },
      r3Policy: { captureAtExecution: true, fallbackOnly: true },
      preparedAt,
      expiresAt,
      sharedMutationsDuringPreparation: 0
    };
    const preparationPath = privateArtifactPath(output, 'remediation-preparation.private.json');
    writePrivateJsonExclusive(preparationPath, authenticateRemediationPreparation(preparation, key));
    verifyRemediationPreparation(readPrivateJson(preparationPath), key, remediationAttemptId);

    const authStages = new Set(['AUTH_RUNTIME_VERIFIED', 'APPLICATION_RUNTIME_VERIFIED']);
    const operations = REMEDIATION_OPERATION_STAGES.map((stage) => ({
      stage,
      runtime: 'node',
      executable: process.execPath,
      executableDigest: digestFile(process.execPath),
      script: preparation.stageWorker.path,
      scriptDigest: preparation.stageWorker.digest,
      cwd: root,
      args: ['--preparation', preparationPath],
      environmentNames: authStages.has(stage)
        ? ['EDGE_API_BASE_URL', 'SMOKE_USER_EMAIL', 'SMOKE_USER_PASSWORD', 'SUPABASE_ANON_KEY', 'SUPABASE_URL']
        : [],
      timeoutMs: 30 * 60 * 1000
    }));
    const unsignedInventory = buildOperationInventory({
      attemptId: remediationAttemptId,
      envFileDigest,
      operations,
      requiredStages: REMEDIATION_OPERATION_STAGES
    });
    const contract = buildRecoveryRemediationContract({
      remediationAttemptId,
      toolingCommit: lineage.toolingCommit,
      toolingTree: lineage.toolingTree,
      originalBinding: original.binding,
      observedDevCertificateDigest: currentObserved.certificateDigest,
      operationInventoryDigest: unsignedInventory.inventoryDigest,
      preparedAt,
      expiresAt
    });
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
  authenticateRemediationPreparation,
  prepareDevRecoveryRemediation,
  verifyRemediationPreparation
};
