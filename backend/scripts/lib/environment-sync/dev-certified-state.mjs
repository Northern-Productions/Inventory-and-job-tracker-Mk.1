import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalDigest, canonicalSerialize } from '../readonly-diagnostics.mjs';
import {
  createPrivateDirectory,
  privateArtifactPath,
  verifyPrivateArtifactProtection,
  verifyPrivateDirectoryProtection,
  writePrivateJsonExclusive
} from './private-artifacts.mjs';
import { DEV_PROJECT_REF, RECOVERY_STAGES, REFRESH_STAGES } from './dev-certified-contract.mjs';

const JOURNAL_FORMAT = 'dev-certified-refresh-journal-record-v1';
const ATTEMPT_MARKER_FORMAT = 'dev-certified-refresh-attempt-v1';
const BOUNDARY_MARKER_FORMAT = 'dev-certified-destructive-boundary-v1';
const RECOVERY_MARKER_FORMAT = 'dev-certified-recovery-attempt-v1';
const FROZEN_MANIFEST_FORMAT = 'dev-certified-frozen-manifest-index-v1';

const INTERNAL_TRANSITIONS = Object.freeze({
  PRECHECK: ['QUIET_WINDOW', 'FAILED_PRE_MUTATION'],
  QUIET_WINDOW: ['Y2_CAPTURE', 'FAILED_PRE_MUTATION'],
  Y2_CAPTURE: ['Y2_VALIDATED', 'FAILED_PRE_MUTATION'],
  Y2_VALIDATED: ['MANIFESTS_FROZEN', 'FAILED_PRE_MUTATION'],
  MANIFESTS_FROZEN: ['ATTEMPT_MARKED', 'FAILED_PRE_MUTATION'],
  ATTEMPT_MARKED: ['DESTRUCTIVE_BOUNDARY', 'FAILED_PRE_MUTATION', 'RECOVERY_REQUIRED'],
  DESTRUCTIVE_BOUNDARY: ['SIDE_EFFECTS_QUARANTINED', 'RECOVERY_REQUIRED'],
  SIDE_EFFECTS_QUARANTINED: ['DATABASE_CUTOVER', 'RECOVERY_REQUIRED'],
  DATABASE_CUTOVER: ['DATABASE_VERIFIED', 'RECOVERY_REQUIRED'],
  DATABASE_VERIFIED: ['AUTH_RUNTIME', 'RECOVERY_REQUIRED'],
  AUTH_RUNTIME: ['EDGE_RUNTIME', 'RECOVERY_REQUIRED'],
  EDGE_RUNTIME: ['WORKFLOW_CERTIFICATION', 'RECOVERY_REQUIRED'],
  WORKFLOW_CERTIFICATION: ['FIXTURE_CLEANUP', 'RECOVERY_REQUIRED'],
  FIXTURE_CLEANUP: ['FINAL_PARITY', 'RECOVERY_REQUIRED'],
  FINAL_PARITY: ['COMPLETE', 'RECOVERY_REQUIRED'],
  COMPLETE: [],
  FAILED_PRE_MUTATION: [],
  RECOVERY_REQUIRED: ['RECOVERY_STARTED'],
  RECOVERY_STARTED: ['RECOVERY_DATABASE', 'RECOVERY_FAILED'],
  RECOVERY_DATABASE: ['RECOVERY_AUTH_RUNTIME', 'RECOVERY_FAILED'],
  RECOVERY_AUTH_RUNTIME: ['RECOVERY_VERIFIED', 'RECOVERY_FAILED'],
  RECOVERY_VERIFIED: ['RECOVERED', 'RECOVERY_FAILED'],
  RECOVERED: [],
  RECOVERY_FAILED: []
});

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length < 32) throw categoricalError('DEV_REFRESH_STATE_KEY_INVALID');
}

function signPayload(payload, key) {
  assertKey(key);
  const bytes = Buffer.from(canonicalSerialize(payload), 'utf8');
  try {
    return `sha256:${crypto.createHmac('sha256', key).update(bytes).digest('hex')}`;
  } finally {
    bytes.fill(0);
  }
}

function signedRecord(payload, key) {
  return { payload, authentication: { algorithm: 'hmac-sha256-v1', digest: signPayload(payload, key) } };
}

function verifySignedRecord(record, key, expectedFormat) {
  if (
    record?.payload?.format !== expectedFormat ||
    record?.authentication?.algorithm !== 'hmac-sha256-v1' ||
    !/^sha256:[0-9a-f]{64}$/.test(String(record?.authentication?.digest || ''))
  ) throw categoricalError('DEV_REFRESH_STATE_RECORD_INVALID');
  const expected = Buffer.from(signPayload(record.payload, key));
  const actual = Buffer.from(record.authentication.digest);
  try {
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      throw categoricalError('DEV_REFRESH_STATE_AUTHENTICATION_FAILED');
    }
  } finally {
    expected.fill(0);
    actual.fill(0);
  }
  return record.payload;
}

function journalPaths(rootDirectory) {
  const root = path.resolve(rootDirectory);
  return {
    root,
    attempt: privateArtifactPath(root, 'attempt.private.json'),
    boundary: privateArtifactPath(root, 'destructive-boundary.private.json'),
    recovery: privateArtifactPath(root, 'recovery-attempt.private.json'),
    frozen: privateArtifactPath(root, 'frozen-manifests.private.json')
  };
}

function stateFileName(index, state) {
  if (!Object.hasOwn(INTERNAL_TRANSITIONS, state)) throw categoricalError('DEV_REFRESH_STATE_UNKNOWN');
  return `${String(index).padStart(3, '0')}-${state.toLowerCase().replaceAll('_', '-')}.private.json`;
}

function stateFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d{3}-[a-z0-9-]+\.private\.json$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
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

function assertStateVocabulary(state) {
  const known = new Set([...REFRESH_STAGES, ...RECOVERY_STAGES, 'FAILED_PRE_MUTATION', 'RECOVERY_FAILED']);
  if (!known.has(state)) throw categoricalError('DEV_REFRESH_STATE_UNKNOWN');
}

function readJournal(rootDirectory, key, { verifyProtection = true } = {}) {
  assertKey(key);
  const paths = journalPaths(rootDirectory);
  if (verifyProtection) verifyPrivateDirectoryProtection(paths.root);
  const files = stateFiles(paths.root);
  if (files.length === 0) throw categoricalError('DEV_REFRESH_STATE_JOURNAL_EMPTY');
  const records = [];
  let previousDigest = '';
  for (let index = 0; index < files.length; index += 1) {
    if (!files[index].startsWith(String(index).padStart(3, '0'))) {
      throw categoricalError('DEV_REFRESH_STATE_SEQUENCE_INVALID');
    }
    const payload = verifySignedRecord(
      readPrivateJson(privateArtifactPath(paths.root, files[index]), verifyProtection),
      key,
      JOURNAL_FORMAT
    );
    assertStateVocabulary(payload.state);
    if (
      payload.sequence !== index ||
      payload.previousDigest !== previousDigest ||
      payload.target !== 'dev' ||
      payload.projectRef !== DEV_PROJECT_REF ||
      !/^[a-z0-9][a-z0-9-]{15,95}$/.test(String(payload.attemptId || ''))
    ) throw categoricalError('DEV_REFRESH_STATE_CHAIN_INVALID');
    if (index > 0) {
      const prior = records[index - 1];
      if (!(INTERNAL_TRANSITIONS[prior.state] || []).includes(payload.state)) {
        throw categoricalError('DEV_REFRESH_STATE_TRANSITION_INVALID');
      }
      if (payload.attemptId !== prior.attemptId || payload.contractDigest !== prior.contractDigest) {
        throw categoricalError('DEV_REFRESH_STATE_ATTEMPT_MISMATCH');
      }
    } else if (payload.state !== 'PRECHECK') {
      throw categoricalError('DEV_REFRESH_INITIAL_STATE_INVALID');
    }
    records.push(payload);
    previousDigest = canonicalDigest(payload);
  }
  const marker = fs.existsSync(paths.attempt)
    ? verifySignedRecord(readPrivateJson(paths.attempt, verifyProtection), key, ATTEMPT_MARKER_FORMAT)
    : null;
  const boundary = fs.existsSync(paths.boundary)
    ? verifySignedRecord(readPrivateJson(paths.boundary, verifyProtection), key, BOUNDARY_MARKER_FORMAT)
    : null;
  const recovery = fs.existsSync(paths.recovery)
    ? verifySignedRecord(readPrivateJson(paths.recovery, verifyProtection), key, RECOVERY_MARKER_FORMAT)
    : null;
  const frozen = fs.existsSync(paths.frozen)
    ? verifySignedRecord(readPrivateJson(paths.frozen, verifyProtection), key, FROZEN_MANIFEST_FORMAT)
    : null;
  for (const sidecar of [marker, boundary, recovery, frozen].filter(Boolean)) {
    if (sidecar.attemptId !== records[0].attemptId || sidecar.contractDigest !== records[0].contractDigest) {
      throw categoricalError('DEV_REFRESH_SIDECAR_ATTEMPT_MISMATCH');
    }
  }
  return { paths, records, current: records.at(-1), marker, boundary, recovery, frozen };
}

function initializeJournal({ rootDirectory, key, attemptId, contractDigest, createdAt = new Date().toISOString() } = {}) {
  assertKey(key);
  const root = createPrivateDirectory(rootDirectory);
  const paths = journalPaths(root);
  const payload = {
    format: JOURNAL_FORMAT,
    sequence: 0,
    state: 'PRECHECK',
    previousDigest: '',
    attemptId,
    contractDigest,
    target: 'dev',
    projectRef: DEV_PROJECT_REF,
    mutationCrossed: false,
    recordedAt: createdAt,
    evidenceDigest: ''
  };
  writePrivateJsonExclusive(privateArtifactPath(root, stateFileName(0, 'PRECHECK')), signedRecord(payload, key));
  return readJournal(root, key, { verifyProtection: false });
}

function appendState(rootDirectory, key, state, {
  evidenceDigest = '',
  recordedAt = new Date().toISOString(),
  failureCategory = ''
} = {}) {
  const journal = readJournal(rootDirectory, key, { verifyProtection: false });
  const current = journal.current;
  if (!(INTERNAL_TRANSITIONS[current.state] || []).includes(state)) {
    throw categoricalError('DEV_REFRESH_STATE_TRANSITION_INVALID');
  }
  const mutationCrossed = current.mutationCrossed || state === 'DESTRUCTIVE_BOUNDARY';
  const payload = {
    format: JOURNAL_FORMAT,
    sequence: current.sequence + 1,
    state,
    previousDigest: canonicalDigest(current),
    attemptId: current.attemptId,
    contractDigest: current.contractDigest,
    target: 'dev',
    projectRef: DEV_PROJECT_REF,
    mutationCrossed,
    recordedAt,
    evidenceDigest,
    failureCategory
  };
  writePrivateJsonExclusive(
    privateArtifactPath(journal.paths.root, stateFileName(payload.sequence, state)),
    signedRecord(payload, key)
  );
  return readJournal(rootDirectory, key, { verifyProtection: false });
}

function freezeManifests(rootDirectory, key, entries, recordedAt = new Date().toISOString()) {
  const journal = readJournal(rootDirectory, key, { verifyProtection: false });
  if (journal.current.state !== 'Y2_VALIDATED' || journal.frozen) {
    throw categoricalError('DEV_REFRESH_MANIFEST_FREEZE_STATE_INVALID');
  }
  const normalized = (entries || []).map((entry) => ({
    name: String(entry.name || ''),
    size: Number(entry.size),
    digest: String(entry.digest || '')
  })).sort((a, b) => a.name.localeCompare(b.name));
  if (
    normalized.length < 8 ||
    new Set(normalized.map((entry) => entry.name)).size !== normalized.length ||
    normalized.some((entry) => !/^[a-z][a-z0-9._-]{2,95}$/.test(entry.name) ||
      !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^sha256:[0-9a-f]{64}$/.test(entry.digest))
  ) throw categoricalError('DEV_REFRESH_MANIFEST_FREEZE_INVALID');
  const payload = {
    format: FROZEN_MANIFEST_FORMAT,
    attemptId: journal.current.attemptId,
    contractDigest: journal.current.contractDigest,
    target: 'dev',
    projectRef: DEV_PROJECT_REF,
    entries: normalized,
    frozenAt: recordedAt
  };
  writePrivateJsonExclusive(journal.paths.frozen, signedRecord(payload, key));
  return payload;
}

function publishAttemptMarker(rootDirectory, key, {
  goldenBaselineId,
  y2RecoveryId,
  canonicalMainCommit,
  toolingCommit,
  migrationVersions,
  recordedAt = new Date().toISOString()
} = {}) {
  const journal = readJournal(rootDirectory, key, { verifyProtection: false });
  if (journal.current.state !== 'MANIFESTS_FROZEN' || !journal.frozen || journal.marker) {
    throw categoricalError('DEV_REFRESH_ATTEMPT_MARKER_STATE_INVALID');
  }
  const payload = {
    format: ATTEMPT_MARKER_FORMAT,
    attemptId: journal.current.attemptId,
    contractDigest: journal.current.contractDigest,
    target: 'dev',
    projectRef: DEV_PROJECT_REF,
    goldenBaselineId,
    y2RecoveryId,
    canonicalMainCommit,
    toolingCommit,
    migrationVersions,
    markedAt: recordedAt,
    reusable: false
  };
  writePrivateJsonExclusive(journal.paths.attempt, signedRecord(payload, key));
  return payload;
}

function publishDestructiveBoundary(rootDirectory, key, recordedAt = new Date().toISOString()) {
  const journal = readJournal(rootDirectory, key, { verifyProtection: false });
  if (journal.current.state !== 'ATTEMPT_MARKED' || !journal.marker || journal.boundary) {
    throw categoricalError('DEV_REFRESH_DESTRUCTIVE_BOUNDARY_STATE_INVALID');
  }
  const payload = {
    format: BOUNDARY_MARKER_FORMAT,
    attemptId: journal.current.attemptId,
    contractDigest: journal.current.contractDigest,
    target: 'dev',
    projectRef: DEV_PROJECT_REF,
    crossedAt: recordedAt,
    recoveryRequiredOnInterruption: true
  };
  writePrivateJsonExclusive(journal.paths.boundary, signedRecord(payload, key));
  return payload;
}

function publishRecoveryMarker(rootDirectory, key, recordedAt = new Date().toISOString()) {
  const journal = readJournal(rootDirectory, key, { verifyProtection: false });
  if (journal.current.state !== 'RECOVERY_REQUIRED' || !journal.boundary || journal.recovery) {
    throw categoricalError('DEV_REFRESH_RECOVERY_MARKER_STATE_INVALID');
  }
  const payload = {
    format: RECOVERY_MARKER_FORMAT,
    attemptId: journal.current.attemptId,
    contractDigest: journal.current.contractDigest,
    target: 'dev',
    projectRef: DEV_PROJECT_REF,
    y2Bound: true,
    startedAt: recordedAt,
    retryAllowed: false
  };
  writePrivateJsonExclusive(journal.paths.recovery, signedRecord(payload, key));
  return payload;
}

function restartDisposition(rootDirectory, key) {
  const journal = readJournal(rootDirectory, key);
  if (journal.current.state === 'COMPLETE') return 'COMPLETE';
  if (journal.current.state === 'RECOVERED') return 'RECOVERED';
  if (journal.boundary) return 'RECOVERY_REQUIRED';
  if (journal.marker) return 'PRE_MUTATION_ATTEMPT_FROZEN';
  return 'PRE_MUTATION_ABORT_ONLY';
}

export {
  ATTEMPT_MARKER_FORMAT,
  BOUNDARY_MARKER_FORMAT,
  FROZEN_MANIFEST_FORMAT,
  INTERNAL_TRANSITIONS,
  JOURNAL_FORMAT,
  RECOVERY_MARKER_FORMAT,
  appendState,
  freezeManifests,
  initializeJournal,
  publishAttemptMarker,
  publishDestructiveBoundary,
  publishRecoveryMarker,
  readJournal,
  restartDisposition,
  signPayload,
  signedRecord,
  verifySignedRecord
};
