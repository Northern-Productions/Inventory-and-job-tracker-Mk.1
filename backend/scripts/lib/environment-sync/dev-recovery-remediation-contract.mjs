import crypto from 'node:crypto';

import { canonicalDigest, canonicalSerialize } from '../readonly-diagnostics.mjs';
import {
  DEV_PROJECT_REF,
  PROD_PROJECT_REF,
  SANDBOX_PROJECT_REF,
  assertSha256
} from './dev-certified-contract.mjs';
import {
  CANONICAL_APPLICATION_SOURCE_COMMIT,
  CANONICAL_APPLICATION_SOURCE_TREE
} from './constants.mjs';

const REMEDIATION_CONTRACT_FORMAT = 'dev-recovery-remediation-contract-v1';
const REMEDIATION_EVIDENCE_FORMAT = 'dev-recovery-remediation-stage-evidence-v1';
const REQUIRED_DIAGNOSTIC_TOOLING_COMMIT = '84a6b7391e72646fc81289942ec3d615e6e8fe98';

const REMEDIATION_OPERATION_STAGES = Object.freeze([
  'REMEDIATION_PRECHECK',
  'CURRENT_Y2_PARITY',
  'R3_CAPTURE',
  'R3_VALIDATED',
  'RESTORE_ORIGINAL_Y2',
  'AUTH_RUNTIME_VERIFIED',
  'APPLICATION_RUNTIME_VERIFIED',
  'FINAL_Y2_PARITY',
  'REMEDIATION_RECOVERY_DATABASE',
  'REMEDIATION_RECOVERY_VERIFIED'
]);

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function assertAttemptId(value, code) {
  if (!/^[a-z0-9][a-z0-9-]{15,127}$/.test(String(value || ''))) throw categoricalError(code);
  return value;
}

function assertGitIdentity(value, code) {
  if (!/^[0-9a-f]{40}$/.test(String(value || ''))) throw categoricalError(code);
  return value;
}

function normalizeOriginalBinding(value = {}) {
  const normalized = {
    refreshAttemptId: String(value.refreshAttemptId || ''),
    y2RecoveryId: String(value.y2RecoveryId || ''),
    refreshContractDigest: String(value.refreshContractDigest || ''),
    originalPreparationDigest: String(value.originalPreparationDigest || ''),
    failedJournalDigest: String(value.failedJournalDigest || ''),
    failedStateRecordDigest: String(value.failedStateRecordDigest || ''),
    failedRecoveryMarkerDigest: String(value.failedRecoveryMarkerDigest || ''),
    failedRecoveryInvocationDigest: String(value.failedRecoveryInvocationDigest || ''),
    recoveryState: String(value.recoveryState || ''),
    retryAllowed: value.retryAllowed
  };
  assertAttemptId(normalized.refreshAttemptId, 'DEV_REMEDIATION_ORIGINAL_ATTEMPT_INVALID');
  if (!/^[a-z0-9][a-z0-9._-]{7,159}$/.test(normalized.y2RecoveryId)) {
    throw categoricalError('DEV_REMEDIATION_ORIGINAL_Y2_INVALID');
  }
  for (const digest of [
    normalized.refreshContractDigest,
    normalized.originalPreparationDigest,
    normalized.failedJournalDigest,
    normalized.failedStateRecordDigest,
    normalized.failedRecoveryMarkerDigest,
    normalized.failedRecoveryInvocationDigest
  ]) assertSha256(digest, 'DEV_REMEDIATION_ORIGINAL_BINDING_DIGEST_INVALID');
  if (normalized.recoveryState !== 'RECOVERY_FAILED' || normalized.retryAllowed !== false) {
    throw categoricalError('DEV_REMEDIATION_ORIGINAL_RECOVERY_NOT_PERMANENTLY_FAILED');
  }
  return normalized;
}

function buildRecoveryRemediationContract({
  remediationAttemptId,
  toolingCommit,
  toolingTree,
  originalBinding,
  observedDevCertificateDigest,
  operationInventoryDigest,
  preparedAt,
  expiresAt
} = {}) {
  assertAttemptId(remediationAttemptId, 'DEV_REMEDIATION_ATTEMPT_ID_INVALID');
  assertGitIdentity(toolingCommit, 'DEV_REMEDIATION_TOOLING_COMMIT_INVALID');
  assertGitIdentity(toolingTree, 'DEV_REMEDIATION_TOOLING_TREE_INVALID');
  assertSha256(observedDevCertificateDigest, 'DEV_REMEDIATION_OBSERVED_CERTIFICATE_INVALID');
  assertSha256(operationInventoryDigest, 'DEV_REMEDIATION_OPERATION_INVENTORY_INVALID');
  const preparedTime = Date.parse(preparedAt);
  const expiryTime = Date.parse(expiresAt);
  if (!Number.isFinite(preparedTime) || !Number.isFinite(expiryTime) || expiryTime <= preparedTime) {
    throw categoricalError('DEV_REMEDIATION_PREPARATION_WINDOW_INVALID');
  }
  const contract = {
    format: REMEDIATION_CONTRACT_FORMAT,
    version: 1,
    attemptId: remediationAttemptId,
    remediationAttemptId,
    target: { environment: 'dev', projectRef: DEV_PROJECT_REF },
    rejectedProjectRefs: [PROD_PROJECT_REF, SANDBOX_PROJECT_REF],
    original: normalizeOriginalBinding(originalBinding),
    candidate: {
      canonicalMainCommit: CANONICAL_APPLICATION_SOURCE_COMMIT,
      canonicalMainTree: CANONICAL_APPLICATION_SOURCE_TREE,
      requiredDiagnosticToolingCommit: REQUIRED_DIAGNOSTIC_TOOLING_COMMIT,
      toolingCommit,
      toolingTree
    },
    observedDevCertificateDigest,
    operationInventoryDigest,
    preparedAt,
    expiresAt,
    r3Policy: {
      captureImmediatelyBeforeBoundary: true,
      coherentSnapshot: true,
      encrypted: true,
      authenticated: true,
      componentDigests: true,
      canonicalRestoreTest: true,
      mustEqualCurrentDev: true,
      mustEqualOriginalY2: true,
      fallbackOnly: true
    },
    restorePolicy: {
      desiredState: 'original-y2',
      knownCommitRequired: true,
      automaticRetry: false,
      oldRecoveryStateMutable: false,
      platformAuthConfigurationMutable: false,
      edgeMutable: false,
      sideEffectConfigurationMutable: false
    },
    functionalVerification: {
      freshAuthenticationRequired: true,
      role: 'owner',
      readOnlyRoutes: ['/auth/context', '/jobs/list', '/boxes/search'],
      businessMutations: false,
      ephemeralSessionExceptionOnly: true
    },
    operationStages: REMEDIATION_OPERATION_STAGES
  };
  return { ...contract, contractDigest: canonicalDigest(contract) };
}

function authenticateRecoveryRemediationContract(contract, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw categoricalError('DEV_REMEDIATION_CONTRACT_KEY_INVALID');
  }
  const bytes = Buffer.from(canonicalSerialize(contract), 'utf8');
  try {
    return {
      contract,
      authentication: {
        algorithm: 'hmac-sha256-v1',
        digest: `sha256:${crypto.createHmac('sha256', key).update(bytes).digest('hex')}`
      }
    };
  } finally {
    bytes.fill(0);
  }
}

function verifyRecoveryRemediationContract(contract = {}) {
  if (contract.format !== REMEDIATION_CONTRACT_FORMAT || contract.version !== 1) {
    throw categoricalError('DEV_REMEDIATION_CONTRACT_FORMAT_INVALID');
  }
  const rebuilt = buildRecoveryRemediationContract({
    remediationAttemptId: contract.remediationAttemptId,
    toolingCommit: contract.candidate?.toolingCommit,
    toolingTree: contract.candidate?.toolingTree,
    originalBinding: contract.original,
    observedDevCertificateDigest: contract.observedDevCertificateDigest,
    operationInventoryDigest: contract.operationInventoryDigest,
    preparedAt: contract.preparedAt,
    expiresAt: contract.expiresAt
  });
  if (canonicalSerialize(rebuilt) !== canonicalSerialize(contract)) {
    throw categoricalError('DEV_REMEDIATION_CONTRACT_MISMATCH');
  }
  return contract;
}

function verifyAuthenticatedRecoveryRemediationContract(record, key) {
  const expected = authenticateRecoveryRemediationContract(record?.contract, key);
  const left = Buffer.from(String(expected.authentication.digest || ''));
  const right = Buffer.from(String(record?.authentication?.digest || ''));
  try {
    if (
      record?.authentication?.algorithm !== 'hmac-sha256-v1' ||
      left.length !== right.length || !crypto.timingSafeEqual(left, right)
    ) throw categoricalError('DEV_REMEDIATION_CONTRACT_AUTHENTICATION_FAILED');
  } finally {
    left.fill(0);
    right.fill(0);
  }
  return verifyRecoveryRemediationContract(record.contract);
}

function assertRecoveryRemediationEvidence(evidence = {}, { contract, stage } = {}) {
  if (
    evidence.format !== REMEDIATION_EVIDENCE_FORMAT ||
    evidence.stage !== stage ||
    evidence.attemptId !== contract?.remediationAttemptId ||
    evidence.target !== 'dev' || evidence.projectRef !== DEV_PROJECT_REF ||
    evidence.status !== 'passed' || evidence.contractDigest !== contract?.contractDigest ||
    !Number.isSafeInteger(evidence.safeCount) || evidence.safeCount < 0 ||
    !/^sha256:[0-9a-f]{64}$/.test(String(evidence.evidenceDigest || ''))
  ) throw categoricalError(`DEV_REMEDIATION_${String(stage || 'UNKNOWN')}_EVIDENCE_INVALID`);
  const details = evidence.details || {};
  if (['REMEDIATION_PRECHECK', 'CURRENT_Y2_PARITY'].includes(stage) && (
    details.oldRecoveryFailedImmutable !== true || details.currentEqualsOriginalY2 !== true
  )) throw categoricalError('DEV_REMEDIATION_PRECONDITION_INCOMPLETE');
  if (stage === 'R3_CAPTURE' && (
    details.coherentSnapshot !== true || details.encrypted !== true || details.authenticatedKeyWrapped !== true
  )) throw categoricalError('DEV_REMEDIATION_R3_CAPTURE_INCOMPLETE');
  if (stage === 'R3_VALIDATED' && (
    details.digestVerified !== true || details.canonicalRestoreTested !== true ||
    details.currentEqualsR3 !== true || details.r3EqualsOriginalY2 !== true
  )) throw categoricalError('DEV_REMEDIATION_R3_VALIDATION_INCOMPLETE');
  if (stage === 'RESTORE_ORIGINAL_Y2' && (
    details.originalY2Restored !== true || details.transactionOutcome !== 'committed'
  )) throw categoricalError('DEV_REMEDIATION_RESTORE_OUTCOME_INCOMPLETE');
  if (stage === 'AUTH_RUNTIME_VERIFIED' && (
    details.nativeSmokeActiveOwner !== true || details.freshAuthentication !== true ||
    details.authContextOwner !== true
  )) throw categoricalError('DEV_REMEDIATION_AUTH_RUNTIME_INCOMPLETE');
  if (stage === 'APPLICATION_RUNTIME_VERIFIED' && (
    details.inventoryRead !== true || details.jobRead !== true || details.boxRead !== true ||
    details.businessMutations !== 0
  )) throw categoricalError('DEV_REMEDIATION_APPLICATION_RUNTIME_INCOMPLETE');
  if (stage === 'FINAL_Y2_PARITY' && (
    details.originalY2Exact !== true || details.unexplainedDifferences !== 0
  )) throw categoricalError('DEV_REMEDIATION_FINAL_PARITY_INCOMPLETE');
  if (stage === 'REMEDIATION_RECOVERY_DATABASE' && (
    details.r3Restored !== true || details.transactionOutcome !== 'committed'
  )) throw categoricalError('DEV_REMEDIATION_RECOVERY_DATABASE_INCOMPLETE');
  if (stage === 'REMEDIATION_RECOVERY_VERIFIED' && (
    details.r3Exact !== true || details.unexplainedDifferences !== 0
  )) throw categoricalError('DEV_REMEDIATION_RECOVERY_PARITY_INCOMPLETE');
  return evidence;
}

export {
  REMEDIATION_CONTRACT_FORMAT,
  REMEDIATION_EVIDENCE_FORMAT,
  REMEDIATION_OPERATION_STAGES,
  REQUIRED_DIAGNOSTIC_TOOLING_COMMIT,
  assertRecoveryRemediationEvidence,
  authenticateRecoveryRemediationContract,
  buildRecoveryRemediationContract,
  normalizeOriginalBinding,
  verifyAuthenticatedRecoveryRemediationContract,
  verifyRecoveryRemediationContract
};
