import pg from 'pg';

import { canonicalDigest, canonicalSerialize } from '../readonly-diagnostics.mjs';
import { verifyAuthenticatedCertifiedRefreshContract } from './dev-certified-contract.mjs';
import { verifyPreparation } from './dev-certified-preparation.mjs';
import { readStageState } from './dev-certified-stage-state.mjs';
import { readJournal } from './dev-certified-state.mjs';
import {
  captureApplicationPlaneFromClient,
  captureAuthParityFromClient,
  captureManagedPlaneFingerprintFromClient
} from './managed-restore-rehearsal.mjs';
import {
  captureNativeSmokePreservation,
  verifyNativeSmokePreservation
} from './native-smoke-preservation.mjs';

const { Client } = pg;

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function withReadOnlySnapshot(connectionString, callback, applicationName = 'dev-recovery-remediation-readonly') {
  const client = new Client({
    connectionString,
    ssl: /(?:127\.0\.0\.1|localhost)/i.test(connectionString) ? undefined : { rejectUnauthorized: false },
    application_name: applicationName
  });
  await client.connect();
  let began = false;
  try {
    await client.query('begin isolation level repeatable read read only');
    began = true;
    const proof = await client.query("select current_setting('transaction_read_only') as value");
    if (proof.rows[0]?.value !== 'on') throw categoricalError('DEV_REMEDIATION_READ_ONLY_UNPROVEN');
    const result = await callback(client);
    await client.query('rollback');
    began = false;
    return result;
  } finally {
    if (began) await client.query('rollback').catch(() => {});
    await client.end().catch(() => {});
  }
}

async function captureRecoveryOwnedStateFromClient(client, { userId, organizationId } = {}) {
  const application = await captureApplicationPlaneFromClient(client);
  const auth = await captureAuthParityFromClient(client, { excludeNativeSmoke: true });
  const managed = await captureManagedPlaneFingerprintFromClient(client);
  const nativeSmoke = await captureNativeSmokePreservation(client, { userId, organizationId });
  verifyNativeSmokePreservation(nativeSmoke);
  const state = { application, auth, managed, nativeSmoke: nativeSmoke.evidence };
  return { ...state, digest: canonicalDigest(state) };
}

async function captureRecoveryOwnedState(connectionString, identity) {
  return withReadOnlySnapshot(
    connectionString,
    (client) => captureRecoveryOwnedStateFromClient(client, identity)
  );
}

function assertRecoveryOwnedStateEqual(observed, expected, code = 'DEV_REMEDIATION_CURRENT_Y2_MISMATCH') {
  if (canonicalSerialize(observed) !== canonicalSerialize(expected)) throw categoricalError(code);
  return true;
}

function readOriginalFailedRecovery({
  failedStateDirectory,
  key,
  originalContractRecord,
  originalPreparationRecord,
  expectedRefreshAttemptId,
  expectedY2RecoveryId
} = {}) {
  const contract = verifyAuthenticatedCertifiedRefreshContract(originalContractRecord, key);
  const preparation = verifyPreparation(originalPreparationRecord, key, expectedRefreshAttemptId);
  if (
    contract.attemptId !== expectedRefreshAttemptId ||
    preparation.attemptId !== expectedRefreshAttemptId ||
    (preparation.contractDigest && contract.contractDigest !== preparation.contractDigest)
  ) throw categoricalError('DEV_REMEDIATION_ORIGINAL_CONTRACT_BINDING_MISMATCH');
  const journal = readJournal(failedStateDirectory, key);
  if (
    journal.current.state !== 'RECOVERY_FAILED' ||
    journal.current.attemptId !== expectedRefreshAttemptId ||
    journal.current.contractDigest !== contract.contractDigest ||
    !journal.marker || !journal.boundary || !journal.recovery ||
    journal.recovery.retryAllowed !== false
  ) throw categoricalError('DEV_REMEDIATION_ORIGINAL_RECOVERY_STATE_INVALID');
  const y2 = readStageState({
    rootDirectory: failedStateDirectory,
    key,
    attemptId: expectedRefreshAttemptId,
    stage: 'Y2_VALIDATED'
  });
  if (
    y2.recoveryId !== expectedY2RecoveryId || y2.validated !== true ||
    !y2.before || !y2.recoveryPackage || !y2.component || !y2.artifactPath || !y2.keyPath
  ) throw categoricalError('DEV_REMEDIATION_ORIGINAL_Y2_STATE_INVALID');
  const recoveryStarted = journal.records.find((record) => record.state === 'RECOVERY_STARTED');
  if (!recoveryStarted) throw categoricalError('DEV_REMEDIATION_ORIGINAL_RECOVERY_INVOCATION_MISSING');
  const binding = {
    refreshAttemptId: expectedRefreshAttemptId,
    y2RecoveryId: expectedY2RecoveryId,
    refreshContractDigest: contract.contractDigest,
    originalPreparationDigest: canonicalDigest(originalPreparationRecord),
    failedJournalDigest: canonicalDigest(journal.records),
    failedStateRecordDigest: canonicalDigest(journal.current),
    failedRecoveryMarkerDigest: canonicalDigest(journal.recovery),
    failedRecoveryInvocationDigest: canonicalDigest({ marker: journal.recovery, started: recoveryStarted }),
    recoveryState: journal.current.state,
    retryAllowed: journal.recovery.retryAllowed
  };
  return { binding, contract, preparation, journal, y2 };
}

function assertOriginalFailedRecoveryUnchanged(options, expectedBinding) {
  const observed = readOriginalFailedRecovery(options);
  if (canonicalSerialize(observed.binding) !== canonicalSerialize(expectedBinding)) {
    throw categoricalError('DEV_REMEDIATION_ORIGINAL_FAILED_RECOVERY_CHANGED');
  }
  return observed;
}

function buildObservedDevCertificate({ core, edge, sideEffects, capturedAt = new Date().toISOString() } = {}) {
  if (!core?.digest || edge?.compatible !== true || edge?.deploymentPolicy !== 'read-only-no-deploy' ||
      sideEffects?.safe !== true || sideEffects?.mutationAllowed !== false) {
    throw categoricalError('DEV_REMEDIATION_OBSERVED_CERTIFICATE_INVALID');
  }
  const certificate = {
    format: 'dev-recovery-remediation-observed-dev-v1',
    capturedAt,
    transactionReadOnly: true,
    core,
    edge,
    sideEffects,
    sharedMutations: 0
  };
  return { ...certificate, certificateDigest: canonicalDigest(certificate) };
}

export {
  assertOriginalFailedRecoveryUnchanged,
  assertRecoveryOwnedStateEqual,
  buildObservedDevCertificate,
  captureRecoveryOwnedState,
  captureRecoveryOwnedStateFromClient,
  readOriginalFailedRecovery,
  withReadOnlySnapshot
};
