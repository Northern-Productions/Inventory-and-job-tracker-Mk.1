import fs from 'node:fs';
import path from 'node:path';

import { canonicalDigest } from '../readonly-diagnostics.mjs';
import { DEV_PROJECT_REF } from './dev-certified-contract.mjs';
import {
  createPrivateDirectory,
  privateArtifactPath,
  verifyPrivateArtifactProtection,
  verifyPrivateDirectoryProtection,
  writePrivateJsonExclusive
} from './private-artifacts.mjs';
import { signPayload, signedRecord, verifySignedRecord } from './dev-certified-state.mjs';

const REMEDIATION_JOURNAL_FORMAT = 'dev-recovery-remediation-journal-v1';
const REMEDIATION_MARKER_FORMAT = 'dev-recovery-remediation-attempt-v1';
const REMEDIATION_BOUNDARY_FORMAT = 'dev-recovery-remediation-boundary-v1';
const REMEDIATION_RECOVERY_MARKER_FORMAT = 'dev-recovery-remediation-recovery-attempt-v1';
const REMEDIATION_RECOVERY_BOUNDARY_FORMAT = 'dev-recovery-remediation-recovery-boundary-v1';
const REMEDIATION_EVENT_FORMAT = 'dev-recovery-remediation-operation-event-v1';
const REMEDIATION_AUTH_CANARY_FORMAT = 'dev-recovery-remediation-auth-canary-v1';
const REMEDIATION_AUTH_EPHEMERA_FORMAT = 'dev-recovery-remediation-auth-ephemera-v1';

const AUTH_CANARY_TRANSITIONS = Object.freeze({
  CANARY_NOT_STARTED: ['LOGIN_STARTED', 'EPHEMERA_RECONCILED'],
  LOGIN_STARTED: ['LOGIN_SUCCEEDED', 'BOUNDED_EPHEMERA_POSSIBLE'],
  LOGIN_SUCCEEDED: ['LOGOUT_ATTEMPTED', 'BOUNDED_EPHEMERA_POSSIBLE'],
  LOGOUT_ATTEMPTED: ['LOGOUT_SUCCEEDED', 'BOUNDED_EPHEMERA_POSSIBLE'],
  LOGOUT_SUCCEEDED: ['CANARY_COMPLETE'],
  BOUNDED_EPHEMERA_POSSIBLE: ['CANARY_COMPLETE'],
  CANARY_COMPLETE: ['EPHEMERA_RECONCILED'],
  EPHEMERA_RECONCILED: []
});

const REMEDIATION_TRANSITIONS = Object.freeze({
  PRECHECK: ['CURRENT_Y2_PARITY', 'FAILED_PRE_MUTATION'],
  CURRENT_Y2_PARITY: ['R3_CAPTURE', 'FAILED_PRE_MUTATION'],
  R3_CAPTURE: ['R3_VALIDATED', 'FAILED_PRE_MUTATION'],
  R3_VALIDATED: ['REMEDIATION_MARKED', 'FAILED_PRE_MUTATION'],
  REMEDIATION_MARKED: ['DESTRUCTIVE_BOUNDARY', 'FAILED_PRE_MUTATION'],
  DESTRUCTIVE_BOUNDARY: ['RESTORE_ORIGINAL_Y2', 'REMEDIATION_RECOVERY_REQUIRED'],
  RESTORE_ORIGINAL_Y2: ['AUTH_RUNTIME_VERIFIED', 'REMEDIATION_RECOVERY_REQUIRED'],
  AUTH_RUNTIME_VERIFIED: ['APPLICATION_RUNTIME_VERIFIED', 'REMEDIATION_RECOVERY_REQUIRED'],
  APPLICATION_RUNTIME_VERIFIED: ['FINAL_Y2_PARITY', 'REMEDIATION_RECOVERY_REQUIRED'],
  FINAL_Y2_PARITY: ['REMEDIATION_COMPLETE', 'REMEDIATION_RECOVERY_REQUIRED'],
  REMEDIATION_COMPLETE: [],
  FAILED_PRE_MUTATION: [],
  REMEDIATION_RECOVERY_REQUIRED: ['REMEDIATION_RECOVERY_AUTHORIZED'],
  REMEDIATION_RECOVERY_AUTHORIZED: ['REMEDIATION_RECOVERY_DATABASE_BOUNDARY'],
  REMEDIATION_RECOVERY_DATABASE_BOUNDARY: [
    'REMEDIATION_RECOVERY_DATABASE_COMMITTED',
    'REMEDIATION_RECOVERY_DATABASE_STATE_RECONCILED',
    'REMEDIATION_RECOVERY_FAILED'
  ],
  REMEDIATION_RECOVERY_DATABASE_COMMITTED: ['REMEDIATION_RECOVERY_VERIFICATION_PENDING'],
  REMEDIATION_RECOVERY_DATABASE_STATE_RECONCILED: ['REMEDIATION_RECOVERY_VERIFICATION_PENDING'],
  REMEDIATION_RECOVERY_VERIFICATION_PENDING: ['REMEDIATION_RECOVERY_VERIFIED'],
  REMEDIATION_RECOVERY_VERIFIED: ['REMEDIATION_RECOVERED'],
  REMEDIATION_RECOVERED: [],
  REMEDIATION_RECOVERY_FAILED: []
});

const TRANSACTION_OUTCOMES = new Set(['not_started', 'committed', 'rolled_back', 'ambiguous']);

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function assertSha256(value, code) {
  if (!/^sha256:[0-9a-f]{64}$/.test(String(value || ''))) throw categoricalError(code);
}

function assertGitIdentity(value, code) {
  if (!/^[0-9a-f]{40}$/.test(String(value || ''))) throw categoricalError(code);
}

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw categoricalError('DEV_REMEDIATION_STATE_KEY_INVALID');
}

function statePaths(rootDirectory) {
  const root = path.resolve(rootDirectory);
  return {
    root,
    marker: privateArtifactPath(root, 'remediation-attempt.private.json'),
    boundary: privateArtifactPath(root, 'remediation-boundary.private.json'),
    recovery: privateArtifactPath(root, 'remediation-recovery-attempt.private.json'),
    recoveryBoundary: privateArtifactPath(root, 'remediation-recovery-boundary.private.json'),
    authCanaries: path.join(root, 'auth-canaries-private'),
    events: path.join(root, 'operation-events-private')
  };
}

function readPrivateJson(filePath, verifyProtection = true) {
  if (verifyProtection) verifyPrivateArtifactProtection(filePath);
  const bytes = fs.readFileSync(filePath);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } finally {
    bytes.fill(0);
  }
}

function stateFileName(sequence, state) {
  if (!Object.hasOwn(REMEDIATION_TRANSITIONS, state)) throw categoricalError('DEV_REMEDIATION_STATE_UNKNOWN');
  return `${String(sequence).padStart(3, '0')}-${state.toLowerCase().replaceAll('_', '-')}.private.json`;
}

function journalFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d{3}-[a-z0-9-]+\.private\.json$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function readRemediationJournal(rootDirectory, key, { verifyProtection = true } = {}) {
  assertKey(key);
  const paths = statePaths(rootDirectory);
  if (verifyProtection) verifyPrivateDirectoryProtection(paths.root);
  const files = journalFiles(paths.root);
  if (files.length === 0) throw categoricalError('DEV_REMEDIATION_JOURNAL_EMPTY');
  const records = [];
  let previousDigest = '';
  for (let sequence = 0; sequence < files.length; sequence += 1) {
    if (!files[sequence].startsWith(String(sequence).padStart(3, '0'))) {
      throw categoricalError('DEV_REMEDIATION_STATE_SEQUENCE_INVALID');
    }
    const payload = verifySignedRecord(
      readPrivateJson(privateArtifactPath(paths.root, files[sequence]), verifyProtection),
      key,
      REMEDIATION_JOURNAL_FORMAT
    );
    if (
      payload.sequence !== sequence || payload.previousDigest !== previousDigest ||
      payload.target !== 'dev' || payload.projectRef !== DEV_PROJECT_REF ||
      !Object.hasOwn(REMEDIATION_TRANSITIONS, payload.state) ||
      !/^[a-z0-9][a-z0-9-]{15,127}$/.test(String(payload.remediationAttemptId || '')) ||
      !/^sha256:[0-9a-f]{64}$/.test(String(payload.contractDigest || '')) ||
      !/^sha256:[0-9a-f]{64}$/.test(String(payload.originalBindingDigest || '')) ||
      !TRANSACTION_OUTCOMES.has(payload.transactionOutcome)
    ) throw categoricalError('DEV_REMEDIATION_STATE_CHAIN_INVALID');
    if (sequence === 0) {
      if (payload.state !== 'PRECHECK') throw categoricalError('DEV_REMEDIATION_INITIAL_STATE_INVALID');
    } else {
      const prior = records[sequence - 1];
      if (!(REMEDIATION_TRANSITIONS[prior.state] || []).includes(payload.state)) {
        throw categoricalError('DEV_REMEDIATION_STATE_TRANSITION_INVALID');
      }
      if (
        payload.remediationAttemptId !== prior.remediationAttemptId ||
        payload.contractDigest !== prior.contractDigest ||
        payload.originalBindingDigest !== prior.originalBindingDigest
      ) throw categoricalError('DEV_REMEDIATION_STATE_BINDING_MISMATCH');
    }
    records.push(payload);
    previousDigest = canonicalDigest(payload);
  }
  const marker = fs.existsSync(paths.marker)
    ? verifySignedRecord(readPrivateJson(paths.marker, verifyProtection), key, REMEDIATION_MARKER_FORMAT)
    : null;
  const boundary = fs.existsSync(paths.boundary)
    ? verifySignedRecord(readPrivateJson(paths.boundary, verifyProtection), key, REMEDIATION_BOUNDARY_FORMAT)
    : null;
  const recovery = fs.existsSync(paths.recovery)
    ? verifySignedRecord(readPrivateJson(paths.recovery, verifyProtection), key, REMEDIATION_RECOVERY_MARKER_FORMAT)
    : null;
  const recoveryBoundary = fs.existsSync(paths.recoveryBoundary)
    ? verifySignedRecord(
      readPrivateJson(paths.recoveryBoundary, verifyProtection), key, REMEDIATION_RECOVERY_BOUNDARY_FORMAT
    )
    : null;
  for (const sidecar of [marker, boundary, recovery, recoveryBoundary].filter(Boolean)) {
    if (
      sidecar.remediationAttemptId !== records[0].remediationAttemptId ||
      sidecar.contractDigest !== records[0].contractDigest ||
      sidecar.originalBindingDigest !== records[0].originalBindingDigest
    ) throw categoricalError('DEV_REMEDIATION_SIDECAR_BINDING_MISMATCH');
  }
  if (marker) {
    for (const value of [
      marker.preparationDigest,
      marker.operationInventoryDigest,
      marker.stageWorkerDigest,
      marker.r3ComponentDigest,
      marker.r3RecoveryPackageDigest,
      marker.originalY2RecoveryPackageDigest,
      marker.r3StageBindingDigest
    ]) assertSha256(value, 'DEV_REMEDIATION_MARKER_FROZEN_BINDING_INVALID');
    assertGitIdentity(marker.toolingCommit, 'DEV_REMEDIATION_MARKER_TOOLING_INVALID');
    assertGitIdentity(marker.toolingTree, 'DEV_REMEDIATION_MARKER_TOOLING_INVALID');
  }
  if (boundary && (
    !marker || boundary.markerDigest !== canonicalDigest(marker) ||
    boundary.preparationDigest !== marker.preparationDigest ||
    boundary.operationInventoryDigest !== marker.operationInventoryDigest ||
    boundary.stageWorkerDigest !== marker.stageWorkerDigest ||
    boundary.r3RecoveryPackageDigest !== marker.r3RecoveryPackageDigest ||
    boundary.originalY2RecoveryPackageDigest !== marker.originalY2RecoveryPackageDigest ||
    boundary.r3StageBindingDigest !== marker.r3StageBindingDigest
  )) throw categoricalError('DEV_REMEDIATION_BOUNDARY_FROZEN_BINDING_INVALID');
  if (recovery && (
    !marker || !boundary || recovery.markerDigest !== canonicalDigest(marker) ||
    recovery.boundaryDigest !== canonicalDigest(boundary) ||
    recovery.r3RecoveryId !== marker.r3RecoveryId ||
    recovery.r3RecoveryPackageDigest !== marker.r3RecoveryPackageDigest ||
    recovery.originalY2RecoveryPackageDigest !== marker.originalY2RecoveryPackageDigest ||
    recovery.r3StageBindingDigest !== marker.r3StageBindingDigest
  )) throw categoricalError('DEV_REMEDIATION_RECOVERY_FROZEN_BINDING_INVALID');
  if (recoveryBoundary && (
    !recovery || recoveryBoundary.recoveryMarkerDigest !== canonicalDigest(recovery) ||
    recoveryBoundary.markerDigest !== canonicalDigest(marker) ||
    recoveryBoundary.r3RecoveryPackageDigest !== marker.r3RecoveryPackageDigest ||
    recoveryBoundary.originalY2RecoveryPackageDigest !== marker.originalY2RecoveryPackageDigest ||
    recoveryBoundary.r3StageBindingDigest !== marker.r3StageBindingDigest
  )) throw categoricalError('DEV_REMEDIATION_RECOVERY_BOUNDARY_FROZEN_BINDING_INVALID');
  return { paths, records, current: records.at(-1), marker, boundary, recovery, recoveryBoundary };
}

function initializeRemediationJournal({
  rootDirectory,
  key,
  remediationAttemptId,
  contractDigest,
  originalBindingDigest,
  recordedAt = new Date().toISOString()
} = {}) {
  assertKey(key);
  const root = createPrivateDirectory(rootDirectory);
  const payload = {
    format: REMEDIATION_JOURNAL_FORMAT,
    sequence: 0,
    state: 'PRECHECK',
    previousDigest: '',
    remediationAttemptId,
    contractDigest,
    originalBindingDigest,
    target: 'dev',
    projectRef: DEV_PROJECT_REF,
    mutationCrossed: false,
    transactionOutcome: 'not_started',
    failureCategory: '',
    evidenceDigest: '',
    recordedAt
  };
  writePrivateJsonExclusive(privateArtifactPath(root, stateFileName(0, 'PRECHECK')), signedRecord(payload, key));
  return readRemediationJournal(root, key, { verifyProtection: false });
}

function appendRemediationState(rootDirectory, key, state, {
  evidenceDigest = '',
  failureCategory = '',
  transactionOutcome,
  recordedAt = new Date().toISOString()
} = {}) {
  const journal = readRemediationJournal(rootDirectory, key, { verifyProtection: false });
  if (!(REMEDIATION_TRANSITIONS[journal.current.state] || []).includes(state)) {
    throw categoricalError('DEV_REMEDIATION_STATE_TRANSITION_INVALID');
  }
  const nextOutcome = transactionOutcome || journal.current.transactionOutcome;
  if (!TRANSACTION_OUTCOMES.has(nextOutcome)) throw categoricalError('DEV_REMEDIATION_TRANSACTION_OUTCOME_INVALID');
  const payload = {
    format: REMEDIATION_JOURNAL_FORMAT,
    sequence: journal.current.sequence + 1,
    state,
    previousDigest: canonicalDigest(journal.current),
    remediationAttemptId: journal.current.remediationAttemptId,
    contractDigest: journal.current.contractDigest,
    originalBindingDigest: journal.current.originalBindingDigest,
    target: 'dev',
    projectRef: DEV_PROJECT_REF,
    mutationCrossed: journal.current.mutationCrossed || state === 'DESTRUCTIVE_BOUNDARY',
    transactionOutcome: nextOutcome,
    failureCategory,
    evidenceDigest,
    recordedAt
  };
  writePrivateJsonExclusive(
    privateArtifactPath(journal.paths.root, stateFileName(payload.sequence, state)),
    signedRecord(payload, key)
  );
  return readRemediationJournal(rootDirectory, key, { verifyProtection: false });
}

function publishRemediationMarker(rootDirectory, key, {
  originalBinding,
  preparationDigest,
  operationInventoryDigest,
  stageWorkerDigest,
  r3RecoveryId,
  r3ComponentDigest,
  r3RecoveryPackageDigest,
  originalY2RecoveryPackageDigest,
  r3StageBindingDigest,
  toolingCommit,
  toolingTree,
  recordedAt = new Date().toISOString()
} = {}) {
  const journal = readRemediationJournal(rootDirectory, key, { verifyProtection: false });
  if (journal.current.state !== 'R3_VALIDATED' || journal.marker) {
    throw categoricalError('DEV_REMEDIATION_MARKER_STATE_INVALID');
  }
  const payload = {
    format: REMEDIATION_MARKER_FORMAT,
    remediationAttemptId: journal.current.remediationAttemptId,
    contractDigest: journal.current.contractDigest,
    originalBindingDigest: journal.current.originalBindingDigest,
    target: 'dev',
    projectRef: DEV_PROJECT_REF,
    originalRefreshAttemptId: originalBinding.refreshAttemptId,
    originalY2RecoveryId: originalBinding.y2RecoveryId,
    originalFailedRecoveryMarkerDigest: originalBinding.failedRecoveryMarkerDigest,
    preparationDigest,
    operationInventoryDigest,
    stageWorkerDigest,
    r3RecoveryId,
    r3ComponentDigest,
    r3RecoveryPackageDigest,
    originalY2RecoveryPackageDigest,
    r3StageBindingDigest,
    toolingCommit,
    toolingTree,
    markedAt: recordedAt,
    reusable: false,
    oldRecoveryMutable: false
  };
  writePrivateJsonExclusive(journal.paths.marker, signedRecord(payload, key));
  return payload;
}

function publishRemediationBoundary(rootDirectory, key, recordedAt = new Date().toISOString()) {
  const journal = readRemediationJournal(rootDirectory, key, { verifyProtection: false });
  if (journal.current.state !== 'REMEDIATION_MARKED' || !journal.marker || journal.boundary) {
    throw categoricalError('DEV_REMEDIATION_BOUNDARY_STATE_INVALID');
  }
  const payload = {
    format: REMEDIATION_BOUNDARY_FORMAT,
    remediationAttemptId: journal.current.remediationAttemptId,
    contractDigest: journal.current.contractDigest,
    originalBindingDigest: journal.current.originalBindingDigest,
    target: 'dev',
    projectRef: DEV_PROJECT_REF,
    markerDigest: canonicalDigest(journal.marker),
    preparationDigest: journal.marker.preparationDigest,
    operationInventoryDigest: journal.marker.operationInventoryDigest,
    stageWorkerDigest: journal.marker.stageWorkerDigest,
    r3RecoveryPackageDigest: journal.marker.r3RecoveryPackageDigest,
    originalY2RecoveryPackageDigest: journal.marker.originalY2RecoveryPackageDigest,
    r3StageBindingDigest: journal.marker.r3StageBindingDigest,
    crossedAt: recordedAt,
    recoveryRequiredOnInterruption: true
  };
  writePrivateJsonExclusive(journal.paths.boundary, signedRecord(payload, key));
  return payload;
}

function publishRemediationRecoveryMarker(rootDirectory, key, recordedAt = new Date().toISOString()) {
  const journal = readRemediationJournal(rootDirectory, key, { verifyProtection: false });
  if (
    journal.current.state !== 'REMEDIATION_RECOVERY_REQUIRED' || !journal.boundary ||
    !journal.marker || journal.recovery
  ) throw categoricalError('DEV_REMEDIATION_RECOVERY_MARKER_STATE_INVALID');
  const payload = {
    format: REMEDIATION_RECOVERY_MARKER_FORMAT,
    remediationAttemptId: journal.current.remediationAttemptId,
    contractDigest: journal.current.contractDigest,
    originalBindingDigest: journal.current.originalBindingDigest,
    target: 'dev',
    projectRef: DEV_PROJECT_REF,
    markerDigest: canonicalDigest(journal.marker),
    boundaryDigest: canonicalDigest(journal.boundary),
    r3RecoveryId: journal.marker.r3RecoveryId,
    r3RecoveryPackageDigest: journal.marker.r3RecoveryPackageDigest,
    originalY2RecoveryPackageDigest: journal.marker.originalY2RecoveryPackageDigest,
    r3StageBindingDigest: journal.marker.r3StageBindingDigest,
    startedAt: recordedAt,
    retryAllowed: false
  };
  writePrivateJsonExclusive(journal.paths.recovery, signedRecord(payload, key));
  return payload;
}

function publishRemediationRecoveryBoundary(rootDirectory, key, recordedAt = new Date().toISOString()) {
  const journal = readRemediationJournal(rootDirectory, key, { verifyProtection: false });
  if (
    journal.current.state !== 'REMEDIATION_RECOVERY_AUTHORIZED' || !journal.recovery ||
    !journal.marker || journal.recoveryBoundary
  ) throw categoricalError('DEV_REMEDIATION_RECOVERY_BOUNDARY_STATE_INVALID');
  const payload = {
    format: REMEDIATION_RECOVERY_BOUNDARY_FORMAT,
    remediationAttemptId: journal.current.remediationAttemptId,
    contractDigest: journal.current.contractDigest,
    originalBindingDigest: journal.current.originalBindingDigest,
    target: 'dev',
    projectRef: DEV_PROJECT_REF,
    markerDigest: canonicalDigest(journal.marker),
    recoveryMarkerDigest: canonicalDigest(journal.recovery),
    r3RecoveryPackageDigest: journal.marker.r3RecoveryPackageDigest,
    originalY2RecoveryPackageDigest: journal.marker.originalY2RecoveryPackageDigest,
    r3StageBindingDigest: journal.marker.r3StageBindingDigest,
    crossedAt: recordedAt,
    resumeDestructiveExecution: false
  };
  writePrivateJsonExclusive(journal.paths.recoveryBoundary, signedRecord(payload, key));
  return payload;
}

function authCanaryDirectories(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{3}-[a-z0-9-]+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function readAuthCanaryDirectory(directory, key, journal) {
  verifyPrivateDirectoryProtection(directory);
  const files = fs.readdirSync(directory)
    .filter((name) => /^\d{3}-[a-z0-9-]+\.private\.json$/.test(name))
    .sort();
  if (files.length === 0) throw categoricalError('DEV_REMEDIATION_AUTH_CANARY_EMPTY');
  const records = [];
  let previousDigest = '';
  for (let sequence = 0; sequence < files.length; sequence += 1) {
    const payload = verifySignedRecord(
      readPrivateJson(privateArtifactPath(directory, files[sequence])), key, REMEDIATION_AUTH_CANARY_FORMAT
    );
    if (
      payload.sequence !== sequence || payload.previousDigest !== previousDigest ||
      payload.remediationAttemptId !== journal.current.remediationAttemptId ||
      payload.contractDigest !== journal.current.contractDigest ||
      !Object.hasOwn(AUTH_CANARY_TRANSITIONS, payload.state) ||
      !/^[A-Z][A-Z0-9_]{2,63}$/.test(String(payload.purpose || '')) ||
      !/^sha256:[0-9a-f]{64}$/.test(String(payload.canaryId || ''))
    ) throw categoricalError('DEV_REMEDIATION_AUTH_CANARY_INVALID');
    if (sequence === 0) {
      if (payload.state !== 'CANARY_NOT_STARTED') throw categoricalError('DEV_REMEDIATION_AUTH_CANARY_INVALID');
    } else {
      const prior = records.at(-1);
      if (!(AUTH_CANARY_TRANSITIONS[prior.state] || []).includes(payload.state) ||
          payload.canaryId !== prior.canaryId || payload.purpose !== prior.purpose) {
        throw categoricalError('DEV_REMEDIATION_AUTH_CANARY_TRANSITION_INVALID');
      }
    }
    records.push(payload);
    previousDigest = canonicalDigest(payload);
  }
  const allowancePath = privateArtifactPath(directory, 'ephemera-allowance.private.json');
  const allowance = fs.existsSync(allowancePath)
    ? verifySignedRecord(readPrivateJson(allowancePath), key, REMEDIATION_AUTH_EPHEMERA_FORMAT)
    : null;
  if (allowance && (
    allowance.remediationAttemptId !== journal.current.remediationAttemptId ||
    allowance.contractDigest !== journal.current.contractDigest ||
    allowance.canaryId !== records[0].canaryId || allowance.purpose !== records[0].purpose ||
    allowance.source !== 'immediate-canary-discovery' ||
    !Array.isArray(allowance.sessions) || !Array.isArray(allowance.refreshTokens) ||
    !Array.isArray(allowance.sessionRows) || !Array.isArray(allowance.refreshTokenRows) ||
    new Set(allowance.sessions).size !== allowance.sessions.length ||
    new Set(allowance.refreshTokens).size !== allowance.refreshTokens.length ||
    allowance.sessions.length > 1 || allowance.refreshTokens.length > 1 ||
    allowance.sessionRows.length !== allowance.sessions.length ||
    allowance.refreshTokenRows.length !== allowance.refreshTokens.length ||
    allowance.sessionRows.some((row, index) =>
      row?.sessionId !== allowance.sessions[index] || !/^sha256:[0-9a-f]{64}$/.test(row?.digest)) ||
    allowance.refreshTokenRows.some((row, index) =>
      row?.refreshTokenId !== allowance.refreshTokens[index] ||
      typeof row?.sessionId !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(row?.digest)) ||
    [...allowance.sessions, ...allowance.refreshTokens].some((value) =>
      typeof value !== 'string' || value.length < 1 || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)
    ) || allowance.allowanceDigest !== canonicalDigest({
      sessions: allowance.sessions,
      refreshTokens: allowance.refreshTokens,
      sessionRows: allowance.sessionRows,
      refreshTokenRows: allowance.refreshTokenRows
    })
  )) throw categoricalError('DEV_REMEDIATION_AUTH_EPHEMERA_ALLOWANCE_INVALID');
  return { directory, records, current: records.at(-1), initial: records[0], allowance };
}

function readRemediationAuthCanaries(rootDirectory, key) {
  const journal = readRemediationJournal(rootDirectory, key);
  const canaries = authCanaryDirectories(journal.paths.authCanaries)
    .map((name) => readAuthCanaryDirectory(path.join(journal.paths.authCanaries, name), key, journal));
  const seen = { sessions: new Set(), refreshTokens: new Set() };
  for (const canary of canaries) {
    for (const name of ['sessions', 'refreshTokens']) {
      for (const identifier of canary.allowance?.[name] || []) {
        if (seen[name].has(identifier)) {
          throw categoricalError('DEV_REMEDIATION_AUTH_EPHEMERA_ALLOWANCE_OVERLAP');
        }
        seen[name].add(identifier);
      }
    }
  }
  return canaries;
}

function authCanaryUnresolved(canary) {
  return canary.current.state !== 'EPHEMERA_RECONCILED';
}

function beginRemediationAuthCanary(rootDirectory, key, purpose, recordedAt = new Date().toISOString(), {
  allowRecoveryVerificationContinuation = false
} = {}) {
  const journal = readRemediationJournal(rootDirectory, key);
  const normalizedPurpose = String(purpose || '');
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(normalizedPurpose)) {
    throw categoricalError('DEV_REMEDIATION_AUTH_CANARY_PURPOSE_INVALID');
  }
  const existing = readRemediationAuthCanaries(rootDirectory, key);
  const samePurpose = existing.filter((entry) => entry.current.purpose === normalizedPurpose);
  const unresolved = samePurpose.filter(authCanaryUnresolved);
  if (unresolved.length > 0) {
    const lockedContinuation = allowRecoveryVerificationContinuation &&
      normalizedPurpose === 'RECOVERY_VERIFICATION' && unresolved.length === 1 &&
      unresolved[0].allowance &&
      unresolved[0].allowance.sessions.length <= 1 && unresolved[0].allowance.refreshTokens.length <= 1 &&
      samePurpose.at(-1)?.current.canaryId === unresolved[0].current.canaryId;
    if (!lockedContinuation) {
      throw categoricalError('DEV_REMEDIATION_AUTH_CANARY_CEILING_REACHED');
    }
  }
  let canaryRoot = journal.paths.authCanaries;
  if (!fs.existsSync(canaryRoot)) canaryRoot = createPrivateDirectory(canaryRoot);
  else verifyPrivateDirectoryProtection(canaryRoot);
  const ordinal = authCanaryDirectories(canaryRoot).length;
  const directory = createPrivateDirectory(path.join(
    canaryRoot, `${String(ordinal).padStart(3, '0')}-${normalizedPurpose.toLowerCase().replaceAll('_', '-')}`
  ));
  const canaryId = canonicalDigest({
    remediationAttemptId: journal.current.remediationAttemptId,
    contractDigest: journal.current.contractDigest,
    purpose: normalizedPurpose,
    ordinal
  });
  const payload = {
    format: REMEDIATION_AUTH_CANARY_FORMAT,
    sequence: 0,
    previousDigest: '',
    remediationAttemptId: journal.current.remediationAttemptId,
    contractDigest: journal.current.contractDigest,
    canaryId,
    purpose: normalizedPurpose,
    state: 'CANARY_NOT_STARTED',
    recordedAt
  };
  writePrivateJsonExclusive(
    privateArtifactPath(directory, '000-canary-not-started.private.json'), signedRecord(payload, key)
  );
  return { directory, canaryId, purpose: normalizedPurpose };
}

function freezeRemediationAuthCanaryAllowance(rootDirectory, key, canaryId, {
  sessions = [],
  refreshTokens = [],
  sessionRows = [],
  refreshTokenRows = []
} = {}, recordedAt = new Date().toISOString()) {
  const canary = readRemediationAuthCanaries(rootDirectory, key)
    .find((entry) => entry.current.canaryId === canaryId);
  if (!canary || canary.allowance) {
    throw categoricalError('DEV_REMEDIATION_AUTH_EPHEMERA_ALLOWANCE_STATE_INVALID');
  }
  for (const values of [sessions, refreshTokens]) {
    if (!Array.isArray(values) || values.length > 1 || new Set(values).size !== values.length ||
        values.some((value) => typeof value !== 'string' || value.length < 1 || value.length > 256 ||
          /[\x00-\x1f\x7f]/.test(value))) {
      throw categoricalError('DEV_REMEDIATION_AUTH_EPHEMERA_ALLOWANCE_INVALID');
    }
  }
  if (
    !Array.isArray(sessionRows) || !Array.isArray(refreshTokenRows) ||
    sessionRows.length !== sessions.length || refreshTokenRows.length !== refreshTokens.length ||
    sessionRows.some((row, index) =>
      row?.sessionId !== sessions[index] || !/^sha256:[0-9a-f]{64}$/.test(row?.digest)) ||
    refreshTokenRows.some((row, index) =>
      row?.refreshTokenId !== refreshTokens[index] || typeof row?.sessionId !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(row?.digest))
  ) throw categoricalError('DEV_REMEDIATION_AUTH_EPHEMERA_ALLOWANCE_INVALID');
  const payload = {
    format: REMEDIATION_AUTH_EPHEMERA_FORMAT,
    remediationAttemptId: canary.current.remediationAttemptId,
    contractDigest: canary.current.contractDigest,
    canaryId,
    purpose: canary.current.purpose,
    source: 'immediate-canary-discovery',
    sessions: [...sessions],
    refreshTokens: [...refreshTokens],
    sessionRows: [...sessionRows],
    refreshTokenRows: [...refreshTokenRows],
    allowanceDigest: canonicalDigest({ sessions, refreshTokens, sessionRows, refreshTokenRows }),
    recordedAt
  };
  writePrivateJsonExclusive(
    privateArtifactPath(canary.directory, 'ephemera-allowance.private.json'),
    signedRecord(payload, key)
  );
  return payload;
}

function reconcileRemediationAuthCanary(rootDirectory, key, canaryId, recordedAt = new Date().toISOString()) {
  const canary = readRemediationAuthCanaries(rootDirectory, key)
    .find((entry) => entry.current.canaryId === canaryId);
  if (!canary || !['CANARY_COMPLETE', 'CANARY_NOT_STARTED'].includes(canary.current.state) || !canary.allowance) {
    throw categoricalError('DEV_REMEDIATION_AUTH_CANARY_RECONCILIATION_INVALID');
  }
  return appendRemediationAuthCanaryState(rootDirectory, key, canaryId, 'EPHEMERA_RECONCILED', recordedAt);
}

function appendRemediationAuthCanaryState(rootDirectory, key, canaryId, state, recordedAt = new Date().toISOString()) {
  if (!Object.hasOwn(AUTH_CANARY_TRANSITIONS, state)) {
    throw categoricalError('DEV_REMEDIATION_AUTH_CANARY_STATE_INVALID');
  }
  const canary = readRemediationAuthCanaries(rootDirectory, key)
    .find((entry) => entry.current.canaryId === canaryId);
  if (!canary || !(AUTH_CANARY_TRANSITIONS[canary.current.state] || []).includes(state)) {
    throw categoricalError('DEV_REMEDIATION_AUTH_CANARY_TRANSITION_INVALID');
  }
  const sequence = canary.current.sequence + 1;
  const payload = {
    format: REMEDIATION_AUTH_CANARY_FORMAT,
    sequence,
    previousDigest: canonicalDigest(canary.current),
    remediationAttemptId: canary.current.remediationAttemptId,
    contractDigest: canary.current.contractDigest,
    canaryId,
    purpose: canary.current.purpose,
    state,
    recordedAt
  };
  writePrivateJsonExclusive(
    privateArtifactPath(
      canary.directory,
      `${String(sequence).padStart(3, '0')}-${state.toLowerCase().replaceAll('_', '-')}.private.json`
    ),
    signedRecord(payload, key)
  );
  return payload;
}

function remediationAuthCanaryDisposition(rootDirectory, key) {
  const canaries = readRemediationAuthCanaries(rootDirectory, key);
  const unresolved = canaries.filter(authCanaryUnresolved);
  const bounded = unresolved.length > 0;
  const completed = canaries.filter((entry) =>
    entry.records.some((record) => record.state === 'CANARY_COMPLETE'));
  const allowances = {
    sessions: unresolved.flatMap((entry) => entry.allowance?.sessions || []),
    refreshTokens: unresolved.flatMap((entry) => entry.allowance?.refreshTokens || []),
    sessionRows: unresolved.flatMap((entry) => entry.allowance?.sessionRows || []),
    refreshTokenRows: unresolved.flatMap((entry) => entry.allowance?.refreshTokenRows || [])
  };
  return {
    canaryCount: canaries.length,
    completedCount: completed.length,
    sessionRevoked: canaries.length > 0 && !bounded &&
      canaries.every((entry) => entry.current.state === 'EPHEMERA_RECONCILED'),
    boundedEphemeraPossible: bounded,
    unresolvedCount: unresolved.length,
    unresolvedPurposes: [...new Set(unresolved.map((entry) => entry.current.purpose))].sort(),
    unboundCanaryCount: unresolved.filter((entry) => !entry.allowance).length,
    allowedNativeEphemera: allowances
  };
}

function readRemediationEvents(rootDirectory, key) {
  const journal = readRemediationJournal(rootDirectory, key);
  if (!fs.existsSync(journal.paths.events)) return [];
  verifyPrivateDirectoryProtection(journal.paths.events);
  const files = fs.readdirSync(journal.paths.events)
    .filter((name) => /^\d{3}-[a-z0-9-]+\.private\.json$/.test(name)).sort();
  const records = [];
  let previousDigest = '';
  for (let sequence = 0; sequence < files.length; sequence += 1) {
    const payload = verifySignedRecord(
      readPrivateJson(privateArtifactPath(journal.paths.events, files[sequence])),
      key,
      REMEDIATION_EVENT_FORMAT
    );
    if (
      payload.sequence !== sequence || payload.previousDigest !== previousDigest ||
      payload.remediationAttemptId !== journal.current.remediationAttemptId ||
      payload.contractDigest !== journal.current.contractDigest ||
      !/^[A-Z][A-Z0-9_]{1,63}$/.test(String(payload.stage || '')) ||
      !/^[A-Z][A-Z0-9_]{1,95}$/.test(String(payload.substep || '')) ||
      !TRANSACTION_OUTCOMES.has(payload.transactionOutcome) ||
      !/^sha256:[0-9a-f]{64}$/.test(String(payload.detailsDigest || ''))
    ) throw categoricalError('DEV_REMEDIATION_EVENT_INVALID');
    records.push(payload);
    previousDigest = canonicalDigest(payload);
  }
  return records;
}

function appendRemediationEvent(rootDirectory, key, {
  stage,
  substep,
  transactionOutcome = 'not_started',
  details = {},
  recordedAt = new Date().toISOString()
} = {}) {
  const journal = readRemediationJournal(rootDirectory, key, { verifyProtection: false });
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(String(stage || '')) ||
      !/^[A-Z][A-Z0-9_]{1,95}$/.test(String(substep || '')) ||
      !TRANSACTION_OUTCOMES.has(transactionOutcome)) {
    throw categoricalError('DEV_REMEDIATION_EVENT_INVALID');
  }
  let eventRoot = journal.paths.events;
  if (!fs.existsSync(eventRoot)) eventRoot = createPrivateDirectory(eventRoot);
  else verifyPrivateDirectoryProtection(eventRoot);
  const files = fs.readdirSync(eventRoot).filter((name) => /^\d{3}-[a-z0-9-]+\.private\.json$/.test(name)).sort();
  const sequence = files.length;
  const previous = sequence === 0
    ? ''
    : canonicalDigest(verifySignedRecord(
      readPrivateJson(privateArtifactPath(eventRoot, files.at(-1)), false),
      key,
      REMEDIATION_EVENT_FORMAT
    ));
  const payload = {
    format: REMEDIATION_EVENT_FORMAT,
    sequence,
    previousDigest: previous,
    remediationAttemptId: journal.current.remediationAttemptId,
    contractDigest: journal.current.contractDigest,
    stage,
    substep,
    transactionOutcome,
    detailsDigest: canonicalDigest(details),
    recordedAt
  };
  const name = `${String(sequence).padStart(3, '0')}-${substep.toLowerCase().replaceAll('_', '-')}.private.json`;
  writePrivateJsonExclusive(privateArtifactPath(eventRoot, name), signedRecord(payload, key));
  return payload;
}

function remediationRestartDisposition(rootDirectory, key) {
  const journal = readRemediationJournal(rootDirectory, key);
  if (journal.current.state === 'REMEDIATION_COMPLETE') return 'REMEDIATION_COMPLETE';
  if (journal.current.state === 'REMEDIATION_RECOVERED') return 'REMEDIATION_RECOVERED';
  if (journal.current.state === 'REMEDIATION_RECOVERY_FAILED') return 'REMEDIATION_RECOVERY_FAILED';
  if (journal.current.state === 'REMEDIATION_RECOVERY_VERIFICATION_PENDING') {
    return 'REMEDIATION_RECOVERY_VERIFICATION_PENDING';
  }
  if (journal.current.state === 'REMEDIATION_RECOVERY_DATABASE_COMMITTED') {
    return 'REMEDIATION_RECOVERY_DATABASE_COMMITTED';
  }
  if (journal.current.state === 'REMEDIATION_RECOVERY_DATABASE_STATE_RECONCILED') {
    return 'REMEDIATION_RECOVERY_DATABASE_STATE_RECONCILED';
  }
  if (journal.current.state === 'REMEDIATION_RECOVERY_VERIFIED') {
    return 'REMEDIATION_RECOVERY_VERIFIED';
  }
  if (journal.current.state === 'REMEDIATION_RECOVERY_AUTHORIZED' && !journal.recoveryBoundary) {
    return 'REMEDIATION_RECOVERY_AUTHORIZED';
  }
  if (journal.recoveryBoundary) return 'REMEDIATION_RECOVERY_DATABASE_BOUNDARY';
  if (journal.recovery) return 'REMEDIATION_RECOVERY_AUTHORIZED';
  if (journal.boundary) return 'REMEDIATION_RECOVERY_REQUIRED';
  if (journal.marker) return 'PRE_MUTATION_REMEDIATION_FROZEN';
  return 'PRE_MUTATION_ABORT_ONLY';
}

function reconcileRemediationBoundaryInterruption(rootDirectory, key, {
  contractDigest,
  operationInventoryDigest,
  toolingCommit,
  toolingTree
} = {}) {
  let journal = readRemediationJournal(rootDirectory, key);
  if (!journal.boundary || !journal.marker || journal.recovery) return journal;
  if (
    journal.current.contractDigest !== contractDigest ||
    journal.marker.operationInventoryDigest !== operationInventoryDigest ||
    journal.marker.toolingCommit !== toolingCommit ||
    journal.marker.toolingTree !== toolingTree
  ) throw categoricalError('DEV_REMEDIATION_BOUNDARY_RECONCILIATION_BINDING_INVALID');
  if (journal.current.state === 'REMEDIATION_MARKED') {
    journal = appendRemediationState(rootDirectory, key, 'DESTRUCTIVE_BOUNDARY', {
      evidenceDigest: canonicalDigest(journal.boundary),
      failureCategory: 'PROCESS_INTERRUPTION_AFTER_BOUNDARY_PUBLICATION',
      transactionOutcome: 'not_started'
    });
  }
  if (
    journal.current.state !== 'REMEDIATION_RECOVERY_REQUIRED' &&
    REMEDIATION_TRANSITIONS[journal.current.state]?.includes('REMEDIATION_RECOVERY_REQUIRED')
  ) {
    journal = appendRemediationState(rootDirectory, key, 'REMEDIATION_RECOVERY_REQUIRED', {
      failureCategory: 'PROCESS_INTERRUPTION_AFTER_DESTRUCTIVE_BOUNDARY',
      transactionOutcome: journal.current.transactionOutcome === 'committed' ? 'committed' : 'ambiguous'
    });
  }
  return journal;
}

export {
  REMEDIATION_AUTH_CANARY_FORMAT,
  REMEDIATION_AUTH_EPHEMERA_FORMAT,
  REMEDIATION_BOUNDARY_FORMAT,
  REMEDIATION_EVENT_FORMAT,
  REMEDIATION_JOURNAL_FORMAT,
  REMEDIATION_MARKER_FORMAT,
  REMEDIATION_RECOVERY_MARKER_FORMAT,
  REMEDIATION_RECOVERY_BOUNDARY_FORMAT,
  REMEDIATION_TRANSITIONS,
  appendRemediationAuthCanaryState,
  appendRemediationEvent,
  appendRemediationState,
  beginRemediationAuthCanary,
  authCanaryUnresolved,
  freezeRemediationAuthCanaryAllowance,
  initializeRemediationJournal,
  publishRemediationBoundary,
  publishRemediationMarker,
  publishRemediationRecoveryMarker,
  publishRemediationRecoveryBoundary,
  readRemediationAuthCanaries,
  readRemediationEvents,
  readRemediationJournal,
  reconcileRemediationBoundaryInterruption,
  reconcileRemediationAuthCanary,
  remediationAuthCanaryDisposition,
  remediationRestartDisposition
};
