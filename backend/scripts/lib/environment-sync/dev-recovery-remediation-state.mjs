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
const REMEDIATION_EVENT_FORMAT = 'dev-recovery-remediation-operation-event-v1';

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
  REMEDIATION_RECOVERY_REQUIRED: ['REMEDIATION_RECOVERY_STARTED'],
  REMEDIATION_RECOVERY_STARTED: ['REMEDIATION_RECOVERY_DATABASE', 'REMEDIATION_RECOVERY_FAILED'],
  REMEDIATION_RECOVERY_DATABASE: ['REMEDIATION_RECOVERY_VERIFIED', 'REMEDIATION_RECOVERY_FAILED'],
  REMEDIATION_RECOVERY_VERIFIED: ['REMEDIATION_RECOVERED', 'REMEDIATION_RECOVERY_FAILED'],
  REMEDIATION_RECOVERED: [],
  REMEDIATION_RECOVERY_FAILED: []
});

const TRANSACTION_OUTCOMES = new Set(['not_started', 'committed', 'rolled_back', 'ambiguous']);

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
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
  for (const sidecar of [marker, boundary, recovery].filter(Boolean)) {
    if (
      sidecar.remediationAttemptId !== records[0].remediationAttemptId ||
      sidecar.contractDigest !== records[0].contractDigest ||
      sidecar.originalBindingDigest !== records[0].originalBindingDigest
    ) throw categoricalError('DEV_REMEDIATION_SIDECAR_BINDING_MISMATCH');
  }
  return { paths, records, current: records.at(-1), marker, boundary, recovery };
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
  r3RecoveryId,
  r3ComponentDigest,
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
    r3RecoveryId,
    r3ComponentDigest,
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
    r3RecoveryId: journal.marker.r3RecoveryId,
    startedAt: recordedAt,
    retryAllowed: false
  };
  writePrivateJsonExclusive(journal.paths.recovery, signedRecord(payload, key));
  return payload;
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
  if (journal.boundary) return 'REMEDIATION_RECOVERY_REQUIRED';
  if (journal.marker) return 'PRE_MUTATION_REMEDIATION_FROZEN';
  return 'PRE_MUTATION_ABORT_ONLY';
}

export {
  REMEDIATION_BOUNDARY_FORMAT,
  REMEDIATION_EVENT_FORMAT,
  REMEDIATION_JOURNAL_FORMAT,
  REMEDIATION_MARKER_FORMAT,
  REMEDIATION_RECOVERY_MARKER_FORMAT,
  REMEDIATION_TRANSITIONS,
  appendRemediationEvent,
  appendRemediationState,
  initializeRemediationJournal,
  publishRemediationBoundary,
  publishRemediationMarker,
  publishRemediationRecoveryMarker,
  readRemediationJournal,
  remediationRestartDisposition
};
