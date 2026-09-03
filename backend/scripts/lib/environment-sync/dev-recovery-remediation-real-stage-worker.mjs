import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { canonicalDigest, canonicalSerialize } from '../readonly-diagnostics.mjs';
import { DEV_PROJECT_REF } from './dev-certified-contract.mjs';
import { buildOperationFailure } from './dev-certified-operation-failure.mjs';
import { readOptionalStageState, readStageState, writeStageState } from './dev-certified-stage-state.mjs';
import { signPayload } from './dev-certified-state.mjs';
import {
  prepareRestoreDatabase,
  removeDisposablePostgres,
  resolvePostgresTools,
  startDisposablePostgres
} from './disposable-postgres.mjs';
import {
  captureEncryptedPgDump,
  decryptBaselineBytes,
  readWrappedBaselineDataKey,
  restoreEncryptedPgDump,
  verifyEncryptedComponent,
  writeWrappedBaselineDataKey
} from './encrypted-baseline.mjs';
import {
  captureApplicationPlane,
  generateCurrentDatabaseRecoveryPackage
} from './managed-restore-rehearsal.mjs';
import {
  buildManagedOverlayTargetGuard,
  executeManagedOverlayPackage,
  verifyManagedOverlayPackageForExecution
} from './managed-restore.mjs';
import {
  createPrivateDirectory,
  privateArtifactPath,
  verifyPrivateArtifactProtection,
  writePrivateBytesExclusive
} from './private-artifacts.mjs';
import {
  REMEDIATION_EVIDENCE_FORMAT,
  assertRecoveryRemediationEvidence
} from './dev-recovery-remediation-contract.mjs';
import {
  verifyFrozenRemediationPreparation,
  verifyRemediationPreparation
} from './dev-recovery-remediation-preparation.mjs';
import {
  assertRecoveryApplicationStateEqual,
  assertOriginalFailedRecoveryUnchanged,
  captureRemediationAuthCertificate,
  captureRecoveryOwnedState,
  captureRecoveryOwnedStateFromClient
} from './dev-recovery-remediation-shared.mjs';
import {
  AUTH_EPHEMERA_MODES,
  assertRemediationAuthTransition,
  captureQuietWindowFromClient,
  captureRemediationAuthCertificateFromClient,
  captureRuntimeSideEffectPostureFromClient,
  fetchAuthAuditStoragePosture,
  fetchFreshEdgeIdentity,
  runFreshAuthenticationCanary
} from './dev-recovery-remediation-auth.mjs';
import {
  appendRemediationAuthCanaryState,
  appendRemediationEvent,
  beginRemediationAuthCanary,
  freezeRemediationAuthCanaryAllowance,
  readRemediationAuthCanaries,
  readRemediationEvents,
  readRemediationJournal,
  reconcileRemediationAuthCanary,
  remediationAuthCanaryDisposition
} from './dev-recovery-remediation-state.mjs';

const { Client } = pg;
const RESULT_FORMAT = 'dev-certified-operation-result-v1';

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--preparation' || !String(argv[1] || '').trim()) {
    throw categoricalError('DEV_REMEDIATION_REAL_STAGE_ARGUMENT_INVALID');
  }
  return { preparationPath: path.resolve(argv[1]) };
}

function readWorkerAuthorityKey() {
  const descriptor = Number(process.env.DEV_REFRESH_AUTHORITY_KEY_FD);
  if (!Number.isInteger(descriptor) || descriptor < 3) {
    throw categoricalError('DEV_REMEDIATION_REAL_STAGE_KEY_FD_INVALID');
  }
  const bytes = fs.readFileSync(descriptor);
  try {
    if (bytes.length !== 32) throw categoricalError('DEV_REMEDIATION_REAL_STAGE_KEY_INVALID');
    return Buffer.from(bytes);
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

function stateOptions(context, stage) {
  return {
    rootDirectory: context.rootDirectory,
    key: context.key,
    attemptId: context.attemptId,
    stage
  };
}

function originalOptions(context) {
  return {
    failedStateDirectory: context.preparation.original.failedStateDirectory,
    key: context.key,
    repoRoot: context.repoRoot,
    currentToolingCommit: context.preparation.candidate.toolingCommit,
    originalContractRecord: readPrivateJson(context.preparation.original.originalContractPath),
    originalPreparationRecord: readPrivateJson(context.preparation.original.originalPreparationPath),
    originalInventoryRecord: readPrivateJson(context.preparation.original.originalInventoryPath),
    expectedRefreshAttemptId: context.preparation.original.binding.refreshAttemptId,
    expectedY2RecoveryId: context.preparation.original.binding.y2RecoveryId
  };
}

function originalState(context) {
  return assertOriginalFailedRecoveryUnchanged(
    originalOptions(context),
    context.preparation.original.binding
  );
}

function identity(context) {
  return {
    userId: context.preparation.targetSession.smokeUserId,
    organizationId: context.preparation.targetSession.smokeOrganizationId
  };
}

function remediationPreparationDigest(context) {
  return canonicalDigest(context.preparation);
}

function r3StageBinding(value) {
  return {
    recoveryId: value?.recoveryId,
    componentDigest: value?.component?.digest,
    wrappedKeyDigest: value?.wrappedKey?.digest,
    beforeDigest: value?.before?.digest,
    recoveryPackageDigest: canonicalDigest(value?.recoveryPackage),
    originalY2RecoveryPackageDigest: canonicalDigest(value?.originalY2RecoveryPackage),
    recoveryAuthMode: value?.recoveryPackage?.authMode,
    originalY2AuthMode: value?.originalY2RecoveryPackage?.authMode,
    recoveryTargetCompatibilityDigest: canonicalDigest(value?.recoveryPackageAuthentication),
    originalY2TargetCompatibilityDigest: canonicalDigest(value?.originalY2PackageAuthentication),
    validated: value?.validated === true
  };
}

function assertR3StageBinding(value, marker = null) {
  const binding = r3StageBinding(value);
  const bindingDigest = canonicalDigest(binding);
  if (
    value?.validated !== true || value?.r3StageBindingDigest !== bindingDigest ||
    value?.r3RecoveryPackageDigest !== binding.recoveryPackageDigest ||
    value?.originalY2RecoveryPackageDigest !== binding.originalY2RecoveryPackageDigest ||
    value?.recoveryPackage?.authMode !== 'preserve-target-native-auth' ||
    value?.originalY2RecoveryPackage?.authMode !== 'preserve-target-native-auth' ||
    (marker && (
      marker.r3RecoveryId !== value.recoveryId ||
      marker.r3ComponentDigest !== value.component?.digest ||
      marker.r3RecoveryPackageDigest !== binding.recoveryPackageDigest ||
      marker.originalY2RecoveryPackageDigest !== binding.originalY2RecoveryPackageDigest ||
      marker.r3StageBindingDigest !== bindingDigest
    ))
  ) throw categoricalError('DEV_REMEDIATION_R3_FROZEN_BINDING_MISMATCH');
  return { binding, bindingDigest };
}

function authRuntimeDisposition(context) {
  const disposition = remediationAuthCanaryDisposition(context.rootDirectory, context.key);
  const state = readOptionalStageState(stateOptions(context, 'AUTH_RUNTIME_VERIFIED'));
  if (state && (
    typeof state.sessionRevoked !== 'boolean' ||
    state.ephemeralSessionException !== !state.sessionRevoked ||
    state.boundedEphemera !== true
  )) throw categoricalError('DEV_REMEDIATION_AUTH_RUNTIME_DISPOSITION_INVALID');
  return {
    sessionRevoked: disposition.sessionRevoked,
    ephemeralSessionException: disposition.boundedEphemeraPossible,
    canaryCount: disposition.canaryCount,
    completedCanaryCount: disposition.completedCount,
    unresolvedCanaryCount: disposition.unresolvedCount,
    allowedNativeEphemera: disposition.allowedNativeEphemera
  };
}

function mergeEphemeraAllowances(...allowances) {
  const merged = { sessions: [], refreshTokens: [] };
  for (const allowance of allowances) {
    for (const name of ['sessions', 'refreshTokens']) {
      for (const identifier of allowance?.[name] || []) {
        if (merged[name].includes(identifier)) {
          throw categoricalError('DEV_REMEDIATION_AUTH_EPHEMERA_ALLOWANCE_OVERLAP');
        }
        merged[name].push(identifier);
      }
    }
  }
  return merged;
}

function finishInterruptedCanary(context, canary) {
  let current = canary.current.state;
  if (current === 'CANARY_NOT_STARTED') {
    reconcileRemediationAuthCanary(
      context.rootDirectory, context.key, canary.current.canaryId
    );
    return;
  }
  if (['LOGIN_STARTED', 'LOGIN_SUCCEEDED', 'LOGOUT_ATTEMPTED'].includes(current)) {
    appendRemediationAuthCanaryState(
      context.rootDirectory, context.key, canary.current.canaryId, 'BOUNDED_EPHEMERA_POSSIBLE'
    );
    current = 'BOUNDED_EPHEMERA_POSSIBLE';
  }
  if (['LOGOUT_SUCCEEDED', 'BOUNDED_EPHEMERA_POSSIBLE'].includes(current)) {
    appendRemediationAuthCanaryState(
      context.rootDirectory, context.key, canary.current.canaryId, 'CANARY_COMPLETE'
    );
  }
}

async function reconcileAuthCanaryState(context) {
  let canaries = readRemediationAuthCanaries(context.rootDirectory, context.key);
  const unbound = canaries.filter((entry) =>
    entry.current.state !== 'EPHEMERA_RECONCILED' && !entry.allowance
  );
  if (unbound.length > 1) throw categoricalError('DEV_REMEDIATION_AUTH_CANARY_ATTRIBUTION_AMBIGUOUS');
  const boundAllowance = mergeEphemeraAllowances(...canaries
    .filter((entry) => entry.current.state !== 'EPHEMERA_RECONCILED')
    .map((entry) => entry.allowance));
  const current = await captureRemediationAuthCertificate(context.connectionString, {
    ...identity(context),
    expectedDefaultWarehouse: context.preparation.targetSession.smokeDefaultWarehouse
  });
  let parity;
  if (unbound.length === 1) {
    parity = assertRemediationAuthTransition(context.preparation.authHardening.baseline, current, {
      mode: AUTH_EPHEMERA_MODES.IMMEDIATE_CANARY_DISCOVERY,
      logoutSucceeded: false,
      requireFreshLogin: false,
      allowedNativeEphemera: boundAllowance
    });
    const discovered = parity.allowedNativeEphemera;
    if (discovered.sessions.length > 0 || discovered.refreshTokens.length > 0) {
      if (discovered.sessions.length !== 1 || discovered.refreshTokens.length !== 1) {
        throw categoricalError('DEV_REMEDIATION_AUTH_CANARY_ATTRIBUTION_AMBIGUOUS');
      }
      assertRemediationAuthTransition(context.preparation.authHardening.baseline, current, {
        mode: AUTH_EPHEMERA_MODES.IMMEDIATE_CANARY_DISCOVERY,
        logoutSucceeded: false,
        requireFreshLogin: false,
        allowedNativeEphemera: boundAllowance,
        expectedCanarySessionId: discovered.sessions[0]
      });
    }
    freezeRemediationAuthCanaryAllowance(
      context.rootDirectory,
      context.key,
      unbound[0].current.canaryId,
      discovered
    );
  }
  canaries = readRemediationAuthCanaries(context.rootDirectory, context.key);
  let frozenAllowance = mergeEphemeraAllowances(...canaries
    .filter((entry) => entry.current.state !== 'EPHEMERA_RECONCILED')
    .map((entry) => entry.allowance));
  parity = assertRemediationAuthTransition(context.preparation.authHardening.baseline, current, {
    mode: AUTH_EPHEMERA_MODES.FROZEN_ATTEMPT_PARITY,
    logoutSucceeded: frozenAllowance.sessions.length === 0 && frozenAllowance.refreshTokens.length === 0,
    requireFreshLogin: false,
    allowedNativeEphemera: frozenAllowance
  });
  for (const canary of canaries) {
    if (canary.current.state === 'EPHEMERA_RECONCILED' || !canary.allowance) continue;
    const present = ['sessions', 'refreshTokens'].some((name) =>
      canary.allowance[name].some((identifier) => parity.presentAttemptEphemera[name].includes(identifier))
    );
    if (!present) {
      finishInterruptedCanary(context, canary);
      reconcileRemediationAuthCanary(context.rootDirectory, context.key, canary.current.canaryId);
    }
  }
  const finalDisposition = remediationAuthCanaryDisposition(context.rootDirectory, context.key);
  frozenAllowance = finalDisposition.allowedNativeEphemera;
  const finalParity = assertRemediationAuthTransition(
    context.preparation.authHardening.baseline,
    current,
    {
      mode: AUTH_EPHEMERA_MODES.FROZEN_ATTEMPT_PARITY,
      logoutSucceeded: finalDisposition.sessionRevoked,
      requireFreshLogin: false,
      allowedNativeEphemera: frozenAllowance
    }
  );
  return { certificate: current, parity: finalParity, disposition: finalDisposition, frozenAllowance };
}

function disposableLoopbackOverlayGuard() {
  return { mode: 'disposable-managed-local', loopback: true };
}

function managedDevOverlayGuard(packageResult) {
  return buildManagedOverlayTargetGuard({
    packageResult,
    target: 'dev',
    projectRef: DEV_PROJECT_REF,
    mutationGuardPassed: true,
    projectRefMatched: true
  });
}

function remediationDatabaseOverlayGuard(context, packageResult) {
  return context.preparation.mode === 'disposable-managed-local'
    ? disposableLoopbackOverlayGuard()
    : managedDevOverlayGuard(packageResult);
}

function diagnosticsDirectory(context, name) {
  const root = path.join(context.rootDirectory, name);
  if (!fs.existsSync(root)) createPrivateDirectory(root);
  return root;
}

function runSubstep(substep, action, { transactionOutcome = 'not_started' } = {}) {
  return Promise.resolve().then(action).catch((error) => {
    const category = String(error?.code || error?.message || '');
    if (!/^[A-Z][A-Z0-9_]{0,159}$/.test(category)) {
      const wrapped = categoricalError(`DEV_REMEDIATION_${substep}_FAILED`);
      wrapped.failureSubstep = substep;
      wrapped.transactionOutcome = transactionOutcome;
      throw wrapped;
    }
    try {
      if (!error.failureSubstep) error.failureSubstep = substep;
      if (!error.transactionOutcome) error.transactionOutcome = transactionOutcome;
    } catch {}
    throw error;
  });
}

async function assertCurrentEqualsY2(context) {
  const original = originalState(context);
  const current = await captureRecoveryOwnedState(context.connectionString, identity(context));
  assertRecoveryApplicationStateEqual(current, original.y2.before);
  const auth = await captureRemediationAuthCertificate(context.connectionString, {
    ...identity(context),
    expectedDefaultWarehouse: context.preparation.targetSession.smokeDefaultWarehouse
  });
  assertRemediationAuthTransition(context.preparation.authHardening.baseline, auth, {
    mode: AUTH_EPHEMERA_MODES.STRICT_CLEAN,
    logoutSucceeded: true,
    requireFreshLogin: false
  });
  return { original, current, auth };
}

async function freshPreBoundaryPosture(context) {
  const client = new Client({
    connectionString: context.connectionString,
    ssl: /(?:127\.0\.0\.1|localhost)/i.test(context.connectionString) ? undefined : { rejectUnauthorized: false },
    application_name: 'dev-recovery-remediation-fresh-posture'
  });
  await client.connect();
  let began = false;
  try {
    await client.query('begin isolation level repeatable read read only');
    began = true;
    const proof = await client.query("select current_setting('transaction_read_only') as value");
    if (proof.rows[0]?.value !== 'on') throw categoricalError('DEV_REMEDIATION_FRESH_POSTURE_READ_ONLY_UNPROVEN');
    const quietWindow = await captureQuietWindowFromClient(client);
    const sideEffects = await captureRuntimeSideEffectPostureFromClient(client);
    if (['cronJobs', 'networkCallers', 'webhooks', 'foreignResources'].some((name) =>
      Number(sideEffects[name]) !== Number(context.preparation.sideEffects.observed?.[name] || 0))) {
      throw categoricalError('DEV_REMEDIATION_FRESH_SIDE_EFFECT_CERTIFICATE_MISMATCH');
    }
    await client.query('rollback');
    began = false;
    const edge = await fetchFreshEdgeIdentity({ preparation: context.preparation });
    const auditPosture = await fetchAuthAuditStoragePosture({ preparation: context.preparation });
    if (canonicalSerialize(auditPosture) !== canonicalSerialize(context.preparation.authHardening.auditPosture)) {
      throw categoricalError('DEV_REMEDIATION_AUTH_AUDIT_POSTURE_DRIFT');
    }
    return { quietWindow, sideEffects, edge, auditPosture };
  } finally {
    if (began) await client.query('rollback').catch(() => {});
    await client.end().catch(() => {});
  }
}

async function runCertifiedAuthCanary(context, {
  purpose = 'AUTH_RUNTIME_VERIFIED',
  requireClean = false
} = {}) {
  const auditPosture = await fetchAuthAuditStoragePosture({ preparation: context.preparation });
  if (canonicalSerialize(auditPosture) !== canonicalSerialize(context.preparation.authHardening.auditPosture)) {
    throw categoricalError('DEV_REMEDIATION_AUTH_AUDIT_POSTURE_DRIFT');
  }
  const reconciled = await reconcileAuthCanaryState(context);
  const before = reconciled.certificate;
  assertRemediationAuthTransition(context.preparation.authHardening.baseline, before, {
    mode: AUTH_EPHEMERA_MODES.FROZEN_ATTEMPT_PARITY,
    logoutSucceeded: reconciled.disposition.sessionRevoked,
    requireFreshLogin: false,
    allowedNativeEphemera: reconciled.frozenAllowance
  });
  const unresolvedBefore = readRemediationAuthCanaries(context.rootDirectory, context.key)
    .filter((entry) => entry.current.state !== 'EPHEMERA_RECONCILED');
  if (requireClean && unresolvedBefore.length > 0) {
    throw categoricalError('DEV_REMEDIATION_PREBOUNDARY_AUTH_RESIDUE');
  }
  const recoveryVerificationContinuation = purpose === 'RECOVERY_VERIFICATION' &&
    unresolvedBefore.length === 1 &&
    Boolean(unresolvedBefore[0].allowance) &&
    (unresolvedBefore[0].allowance.sessions.length > 0 ||
      unresolvedBefore[0].allowance.refreshTokens.length > 0);
  if (unresolvedBefore.length > 0 && !recoveryVerificationContinuation) {
    throw categoricalError('DEV_REMEDIATION_AUTH_CANARY_CEILING_REACHED');
  }
  const originalAllowance = reconciled.frozenAllowance;
  const canary = beginRemediationAuthCanary(
    context.rootDirectory,
    context.key,
    purpose,
    new Date().toISOString(),
    { allowRecoveryVerificationContinuation: recoveryVerificationContinuation }
  );
  let loginAllowance = null;
  const functional = await runFreshAuthenticationCanary({
    preparation: context.preparation,
    onLifecycle: async (state, details) => {
      appendRemediationAuthCanaryState(context.rootDirectory, context.key, canary.canaryId, state);
      if (state === 'LOGIN_SUCCEEDED') {
        const afterLogin = await captureRemediationAuthCertificate(context.connectionString, {
          ...identity(context),
          expectedDefaultWarehouse: context.preparation.targetSession.smokeDefaultWarehouse
        });
        const discovery = assertRemediationAuthTransition(before, afterLogin, {
          mode: AUTH_EPHEMERA_MODES.IMMEDIATE_CANARY_DISCOVERY,
          logoutSucceeded: false,
          requireFreshLogin: true,
          expectedCanarySessionId: details?.sessionId
        });
        loginAllowance = discovery.allowedNativeEphemera;
        freezeRemediationAuthCanaryAllowance(
          context.rootDirectory,
          context.key,
          canary.canaryId,
          loginAllowance
        );
        maybeCrashDisposableWorker(context, 'AFTER_CANARY_LOGIN_SUCCEEDED');
      }
      if (state === 'LOGOUT_ATTEMPTED') {
        maybeCrashDisposableWorker(context, 'DURING_CANARY_LOGOUT');
      }
      if (state === 'LOGOUT_SUCCEEDED') {
        maybeCrashDisposableWorker(context, 'AFTER_CANARY_LOGOUT_BEFORE_COMPLETE');
      }
    },
    onCheckpoint: async (checkpoint) => {
      if (checkpoint === 'APPLICATION_READ_STARTED') {
        maybeCrashDisposableWorker(context, 'DURING_CANARY_APPLICATION_READ');
      }
    }
  });
  const after = await captureRemediationAuthCertificate(context.connectionString, {
    ...identity(context),
    expectedDefaultWarehouse: context.preparation.targetSession.smokeDefaultWarehouse
  });
  const parity = assertRemediationAuthTransition(before, after, {
    mode: AUTH_EPHEMERA_MODES.IMMEDIATE_CANARY_DISCOVERY,
    logoutSucceeded: functional.logoutSucceeded,
    requireFreshLogin: true,
    allowedNativeEphemera: loginAllowance || { sessions: [], refreshTokens: [] }
  });
  if (loginAllowance && (
    parity.allowedNativeEphemera.sessions.length > 0 ||
    parity.allowedNativeEphemera.refreshTokens.length > 0
  )) throw categoricalError('DEV_REMEDIATION_AUTH_CANARY_UNRELATED_ADDITION');
  const canaryAllowance = loginAllowance || parity.allowedNativeEphemera;
  if (!loginAllowance) freezeRemediationAuthCanaryAllowance(
    context.rootDirectory, context.key, canary.canaryId, canaryAllowance
  );
  const allowedNativeEphemera = mergeEphemeraAllowances(
    reconciled.frozenAllowance,
    canaryAllowance
  );
  const finalParity = assertRemediationAuthTransition(
    context.preparation.authHardening.baseline,
    after,
    {
      mode: AUTH_EPHEMERA_MODES.FROZEN_ATTEMPT_PARITY,
      logoutSucceeded: functional.logoutSucceeded &&
        allowedNativeEphemera.sessions.length === 0 && allowedNativeEphemera.refreshTokens.length === 0,
      requireFreshLogin: false,
      allowedNativeEphemera
    }
  );
  const settled = await reconcileAuthCanaryState(context);
  const finalAllowance = settled.frozenAllowance;
  const settledCanary = readRemediationAuthCanaries(context.rootDirectory, context.key)
    .find((entry) => entry.current.canaryId === canary.canaryId);
  const currentCanaryReconciled = settledCanary?.current.state === 'EPHEMERA_RECONCILED';
  if (!currentCanaryReconciled) {
    throw categoricalError('DEV_REMEDIATION_AUTH_CANARY_RESIDUE_REMAINS');
  }
  if (recoveryVerificationContinuation &&
      canonicalSerialize(finalAllowance) !== canonicalSerialize(originalAllowance)) {
    throw categoricalError('DEV_REMEDIATION_AUTH_CANARY_ALLOWANCE_DRIFT');
  }
  if (requireClean && (
    !currentCanaryReconciled || finalAllowance.sessions.length !== 0 ||
    finalAllowance.refreshTokens.length !== 0
  )) throw categoricalError('DEV_REMEDIATION_PREBOUNDARY_AUTH_RESIDUE');
  return {
    functional: {
      ...functional,
      sessionRevoked: settled.disposition.sessionRevoked,
      ephemeralSessionException: settled.disposition.boundedEphemeraPossible
    },
    parity: {
      ...finalParity,
      sessionRevoked: settled.disposition.sessionRevoked,
      allowedNativeEphemera: finalAllowance
    },
    certificate: after,
    allowedNativeEphemera: finalAllowance,
    auditPosture
  };
}

async function runRemediationPrecheck(context) {
  const { current } = await assertCurrentEqualsY2(context);
  if (
    context.preparation.currentObserved.core.digest !== current.digest ||
    context.preparation.edge.compatible !== true ||
    context.preparation.edge.deploymentPolicy !== 'read-only-no-deploy' ||
    context.preparation.sideEffects.safe !== true ||
    context.preparation.sideEffects.mutationAllowed !== false
  ) throw categoricalError('DEV_REMEDIATION_PRECHECK_CERTIFICATE_MISMATCH');
  const posture = await freshPreBoundaryPosture(context);
  const auth = await runCertifiedAuthCanary(context, {
    purpose: 'REMEDIATION_PRECHECK',
    requireClean: true
  });
  return {
    oldRecoveryFailedImmutable: true,
    currentEqualsOriginalY2: true,
    sharedMutations: 0,
    realQuietWindow: posture.quietWindow.quiet,
    freshEdgeExact: posture.edge.compatible,
    freshSideEffectsSafe: posture.sideEffects.safe,
    freshAuthentication: auth.functional.freshAuthentication,
    smokeUserExact: auth.functional.smokeUserExact,
    smokeOrganizationExact: auth.functional.smokeOrganizationExact,
    defaultWarehouseExact: auth.functional.defaultWarehouseExact,
    filmCatalogReadSucceeded: auth.functional.filmCatalogReadSucceeded,
    boxSearchReadSucceeded: auth.functional.boxSearchReadSucceeded,
    jobsReadSucceeded: auth.functional.jobsReadSucceeded,
    authSemanticParity: auth.parity.stableStateExact
  };
}

async function runCurrentY2Parity(context) {
  await assertCurrentEqualsY2(context);
  return { oldRecoveryFailedImmutable: true, currentEqualsOriginalY2: true, parityPlanes: 4 };
}

async function runR3Capture(context) {
  const original = originalState(context);
  const tools = resolvePostgresTools(context.preparation.targetSession.postgresBin || '');
  const artifactPath = privateArtifactPath(context.rootDirectory, 'r3-remediation-prestate.private.pgdump.enc');
  const keyPath = privateArtifactPath(context.rootDirectory, 'r3-remediation-prestate-key.private.bin');
  const packageDirectory = createPrivateDirectory(path.join(context.rootDirectory, 'r3-package-private'));
  const client = new Client({
    connectionString: context.connectionString,
    ssl: /(?:127\.0\.0\.1|localhost)/i.test(context.connectionString) ? undefined : { rejectUnauthorized: false },
    application_name: 'dev-recovery-remediation-r3-capture'
  });
  await client.connect();
  let began = false;
  let dataKey;
  try {
    await client.query('begin isolation level repeatable read read only');
    began = true;
    const proof = await client.query("select current_setting('transaction_read_only') as value");
    if (proof.rows[0]?.value !== 'on') throw categoricalError('DEV_REMEDIATION_R3_READ_ONLY_UNPROVEN');
    const snapshot = await client.query('select pg_export_snapshot() as id');
    const captured = await captureEncryptedPgDump({
      pgDumpPath: tools.pgDump,
      connectionString: context.connectionString,
      snapshotId: snapshot.rows[0]?.id,
      artifactPath
    });
    dataKey = captured.key;
    const wrapped = writeWrappedBaselineDataKey({ dataKey, wrappingKey: context.key, artifactPath: keyPath });
    const before = await captureRecoveryOwnedStateFromClient(client, identity(context));
    assertRecoveryApplicationStateEqual(before, original.y2.before);
    await client.query('rollback');
    began = false;
    const value = {
      recoveryId: `r3-${context.attemptId}`,
      artifactPath,
      keyPath,
      packageDirectory,
      component: captured.component,
      wrappedKey: wrapped.component,
      before,
      originalY2Digest: original.y2.before.digest,
      coherentSnapshot: true,
      fallbackOnly: true
    };
    writeStageState({ ...stateOptions(context, 'R3_CAPTURE'), value });
    return { coherentSnapshot: true, encrypted: true, authenticatedKeyWrapped: true, componentCount: 2 };
  } finally {
    if (began) await client.query('rollback').catch(() => {});
    await client.end().catch(() => {});
    if (dataKey) dataKey.fill(0);
  }
}

async function runR3Validated(context) {
  const original = originalState(context);
  const r3 = readStageState(stateOptions(context, 'R3_CAPTURE'));
  if (!verifyEncryptedComponent(r3.component, r3.artifactPath)) {
    throw categoricalError('DEV_REMEDIATION_R3_COMPONENT_MISMATCH');
  }
  const tools = resolvePostgresTools(context.preparation.targetSession.postgresBin || '');
  const dataKey = readWrappedBaselineDataKey({ wrappingKey: context.key, artifactPath: r3.keyPath });
  const originalDataKey = readWrappedBaselineDataKey({
    wrappingKey: context.key,
    artifactPath: original.y2.keyPath
  });
  const token = crypto.randomBytes(8).toString('hex');
  const restoreRoot = path.join(os.tmpdir(), `environment-sync-rehearsal-${token}`);
  const r3PackageDirectory = createPrivateDirectory(path.join(r3.packageDirectory, 'r3-preserve-auth'));
  const originalPackageDirectory = createPrivateDirectory(path.join(r3.packageDirectory, 'original-y2-preserve-auth'));
  const plaintextPath = privateArtifactPath(r3PackageDirectory, 'r3-remediation-prestate.private.pgdump');
  const originalPlaintextPath = privateArtifactPath(
    originalPackageDirectory, 'original-y2-remediation.private.pgdump'
  );
  let cluster;
  try {
    if (!verifyEncryptedComponent(original.y2.component, original.y2.artifactPath)) {
      throw categoricalError('DEV_REMEDIATION_ORIGINAL_Y2_COMPONENT_MISMATCH');
    }
    const encrypted = fs.readFileSync(r3.artifactPath);
    let plaintext;
    try {
      plaintext = decryptBaselineBytes(encrypted, dataKey);
      writePrivateBytesExclusive(plaintextPath, plaintext);
    } finally {
      encrypted.fill(0);
      if (plaintext) plaintext.fill(0);
    }
    const originalEncrypted = fs.readFileSync(original.y2.artifactPath);
    let originalPlaintext;
    try {
      originalPlaintext = decryptBaselineBytes(originalEncrypted, originalDataKey);
      writePrivateBytesExclusive(originalPlaintextPath, originalPlaintext);
    } finally {
      originalEncrypted.fill(0);
      if (originalPlaintext) originalPlaintext.fill(0);
    }
    cluster = await startDisposablePostgres({ rootDirectory: restoreRoot, postgresBin: tools.bin });
    const restoreConnection = await prepareRestoreDatabase(cluster, `x_rehearsal_dev_r3_${token}`);
    await restoreEncryptedPgDump({
      pgRestorePath: tools.pgRestore,
      connectionString: restoreConnection,
      artifactPath: r3.artifactPath,
      key: dataKey,
      restoreMode: 'blank-target',
      diagnosticDirectory: diagnosticsDirectory(context, 'r3-restore-test-diagnostics-private')
    });
    const directlyRestoredApplication = await captureApplicationPlane(restoreConnection);
    if (canonicalSerialize(directlyRestoredApplication) !== canonicalSerialize(r3.before.application)) {
      throw categoricalError('DEV_REMEDIATION_R3_DIRECT_RESTORE_MISMATCH');
    }
    const recovery = await generateCurrentDatabaseRecoveryPackage({
      connectionString: context.connectionString,
      archivePath: plaintextPath,
      sourceComponent: r3.component,
      privateDirectory: r3PackageDirectory,
      attemptId: context.attemptId,
      authorityKey: context.key,
      postgresBin: tools.bin,
      preserveTargetAuth: true,
      target: {
        environment: 'dev',
        projectRef: context.preparation.mode === 'disposable-managed-local'
          ? 'd'.repeat(20)
          : DEV_PROJECT_REF
      }
    });
    const canonicalResult = await executeManagedOverlayPackage({
      psqlPath: tools.psql,
      connectionString: restoreConnection,
      packageResult: recovery.packageResult,
      targetGuard: disposableLoopbackOverlayGuard(),
      diagnosticDirectory: diagnosticsDirectory(context, 'r3-canonical-test-diagnostics-private')
    });
    const canonicallyRestoredApplication = await captureApplicationPlane(restoreConnection);
    if (
      canonicalResult.applied !== true || canonicalResult.atomic !== true ||
      canonicalSerialize(canonicallyRestoredApplication) !== canonicalSerialize(r3.before.application)
    ) throw categoricalError('DEV_REMEDIATION_R3_CANONICAL_RESTORE_MISMATCH');
    const originalRecovery = await generateCurrentDatabaseRecoveryPackage({
      connectionString: context.connectionString,
      archivePath: originalPlaintextPath,
      sourceComponent: original.y2.component,
      privateDirectory: originalPackageDirectory,
      attemptId: context.attemptId,
      authorityKey: context.key,
      postgresBin: tools.bin,
      preserveTargetAuth: true,
      target: {
        environment: 'dev',
        projectRef: context.preparation.mode === 'disposable-managed-local'
          ? 'd'.repeat(20)
          : DEV_PROJECT_REF
      }
    });
    const originalCanonicalResult = await executeManagedOverlayPackage({
      psqlPath: tools.psql,
      connectionString: restoreConnection,
      packageResult: originalRecovery.packageResult,
      targetGuard: disposableLoopbackOverlayGuard(),
      diagnosticDirectory: diagnosticsDirectory(context, 'original-y2-canonical-test-diagnostics-private')
    });
    const originalCanonicalApplication = await captureApplicationPlane(restoreConnection);
    if (
      originalCanonicalResult.applied !== true || originalCanonicalResult.atomic !== true ||
      canonicalSerialize(originalCanonicalApplication) !== canonicalSerialize(original.y2.before.application)
    ) throw categoricalError('DEV_REMEDIATION_ORIGINAL_Y2_CANONICAL_RESTORE_MISMATCH');
    const current = await captureRecoveryOwnedState(context.connectionString, identity(context));
    assertRecoveryApplicationStateEqual(current, r3.before, 'DEV_REMEDIATION_CURRENT_R3_MISMATCH');
    assertRecoveryApplicationStateEqual(r3.before, original.y2.before, 'DEV_REMEDIATION_R3_Y2_MISMATCH');
    const posture = await freshPreBoundaryPosture(context);
    const packageAuthentication = verifyManagedOverlayPackageForExecution({
      connectionString: context.connectionString,
      packageResult: recovery.packageResult,
      targetGuard: remediationDatabaseOverlayGuard(context, recovery.packageResult)
    });
    const originalY2PackageAuthentication = verifyManagedOverlayPackageForExecution({
      connectionString: context.connectionString,
      packageResult: originalRecovery.packageResult,
      targetGuard: remediationDatabaseOverlayGuard(context, originalRecovery.packageResult)
    });
    const preMarkerAuth = await captureRemediationAuthCertificate(context.connectionString, {
      ...identity(context),
      expectedDefaultWarehouse: context.preparation.targetSession.smokeDefaultWarehouse
    });
    const preMarkerParity = assertRemediationAuthTransition(
      context.preparation.authHardening.baseline,
      preMarkerAuth,
      {
        mode: AUTH_EPHEMERA_MODES.STRICT_CLEAN,
        logoutSucceeded: true,
        requireFreshLogin: false
      }
    );
    if (
      current.nativeSmoke.ownerMembershipCount !== 1 ||
      preMarkerAuth.stable.defaultWarehouse !== context.preparation.targetSession.smokeDefaultWarehouse
    ) throw categoricalError('DEV_REMEDIATION_PREMARKER_AUTH_CONTRACT_INVALID');
    const valueWithoutBinding = {
      ...r3,
      recoveryPackage: recovery.packageResult,
      originalY2RecoveryPackage: originalRecovery.packageResult,
      recoveryPackageAuthentication: packageAuthentication,
      originalY2PackageAuthentication,
      recoveryExpected: {
        application: recovery.application,
        auth: recovery.auth,
        managed: recovery.managed,
        routineDefaults: recovery.routineDefaults,
        futureSecurity: recovery.futureSecurity
      },
      restoreTest: {
        direct: true,
        canonicalPrimitive: true,
        transactionOutcome: 'committed',
        applicationExact: true
      },
      preMarkerAuthCertificateDigest: canonicalDigest(preMarkerAuth),
      validated: true
    };
    const binding = r3StageBinding(valueWithoutBinding);
    const value = {
      ...valueWithoutBinding,
      r3RecoveryPackageDigest: binding.recoveryPackageDigest,
      originalY2RecoveryPackageDigest: binding.originalY2RecoveryPackageDigest,
      r3StageBindingDigest: canonicalDigest(binding)
    };
    assertR3StageBinding(value);
    writeStageState({ ...stateOptions(context, 'R3_VALIDATED'), value });
    return {
      preparationDigest: remediationPreparationDigest(context),
      operationInventoryDigest: context.preparation.operationInventoryDigest,
      stageWorkerDigest: context.preparation.stageWorker.digest,
      r3RecoveryId: r3.recoveryId,
      r3ComponentDigest: r3.component.digest,
      r3RecoveryPackageDigest: value.r3RecoveryPackageDigest,
      originalY2RecoveryPackageDigest: value.originalY2RecoveryPackageDigest,
      r3StageBindingDigest: value.r3StageBindingDigest,
      digestVerified: true,
      canonicalRestoreTested: true,
      currentEqualsR3: true,
      r3EqualsOriginalY2: true,
      authMutationScope: 'preserve-target-native-auth',
      realQuietWindowRechecked: posture.quietWindow.quiet,
      freshEdgeRechecked: posture.edge.compatible,
      freshSideEffectsRechecked: posture.sideEffects.safe,
      recoveryPackageAuthenticated: packageAuthentication.authenticated,
      originalY2PackageAuthenticated: originalY2PackageAuthentication.authenticated,
      finalSemanticAuthExact: preMarkerParity.stableStateExact,
      nativeSmokeActiveOwner: current.nativeSmoke.ownerMembershipCount === 1,
      rawMetadataMarker: true,
      identityMetadataMarker: true,
      providerCredentialDigestsExact: preMarkerParity.nativeStableExact,
      selectedOrganizationExact: preMarkerParity.ownerRelationshipExact,
      signedDefaultWarehouseExact:
        preMarkerAuth.stable.defaultWarehouse === context.preparation.targetSession.smokeDefaultWarehouse,
      copiedUsersExact: preMarkerParity.copiedUsersExact,
      copiedIdentitiesExact: preMarkerParity.copiedIdentitiesExact
    };
  } finally {
    dataKey.fill(0);
    originalDataKey.fill(0);
    if (fs.existsSync(plaintextPath)) fs.rmSync(plaintextPath, { force: true });
    if (fs.existsSync(originalPlaintextPath)) fs.rmSync(originalPlaintextPath, { force: true });
    if (cluster) await removeDisposablePostgres(cluster);
  }
}

async function databaseSessionEvidence(context, stage) {
  const client = new Client({
    connectionString: context.connectionString,
    ssl: /(?:127\.0\.0\.1|localhost)/i.test(context.connectionString) ? undefined : { rejectUnauthorized: false },
    application_name: 'dev-recovery-remediation-session-proof'
  });
  await client.connect();
  try {
    const result = await client.query(
      `select current_database()::text as database_name,
              current_user::text as role_name,
              current_setting('server_version_num')::text as server_version`
    );
    return appendRemediationEvent(context.rootDirectory, context.key, {
      stage,
      substep: 'DATABASE_SESSION_VERIFIED',
      details: { identityDigest: canonicalDigest(result.rows[0] || {}) }
    });
  } finally {
    await client.end().catch(() => {});
  }
}

async function executeKnownRestore(context, {
  stage,
  packageResult,
  expectedPackageAuthentication,
  expected,
  expectedLabel,
  diagnosticName
} = {}) {
  const overlayGuard = remediationDatabaseOverlayGuard(context, packageResult);
  const packageAuthentication = verifyManagedOverlayPackageForExecution({
    connectionString: context.connectionString,
    packageResult,
    targetGuard: overlayGuard
  });
  if (
    !expectedPackageAuthentication ||
    canonicalDigest(packageAuthentication) !== canonicalDigest(expectedPackageAuthentication)
  ) throw categoricalError('DEV_REMEDIATION_PACKAGE_PREVALIDATION_DRIFT');
  const authBefore = await captureRemediationAuthCertificate(context.connectionString, {
    ...identity(context),
    expectedDefaultWarehouse: context.preparation.targetSession.smokeDefaultWarehouse
  });
  appendRemediationEvent(context.rootDirectory, context.key, {
    stage,
    substep: 'RESTORE_START',
    details: { desiredState: expectedLabel }
  });
  await databaseSessionEvidence(context, stage);
  appendRemediationEvent(context.rootDirectory, context.key, {
    stage,
    substep: 'TRANSACTION_START',
    details: { serializable: true, singleTransaction: true }
  });
  appendRemediationEvent(context.rootDirectory, context.key, {
    stage,
    substep: 'MUTATION_APPLICATION',
    transactionOutcome: 'ambiguous',
    details: { packageDigest: canonicalDigest(packageResult.manifest) }
  });
  let result;
  try {
    result = await executeManagedOverlayPackage({
      psqlPath: resolvePostgresTools(context.preparation.targetSession.postgresBin || '').psql,
      connectionString: context.connectionString,
      packageResult,
      targetGuard: overlayGuard,
      diagnosticDirectory: diagnosticsDirectory(context, diagnosticName)
    });
  } catch (error) {
    appendRemediationEvent(context.rootDirectory, context.key, {
      stage,
      substep: 'TRANSACTION_OUTCOME_AMBIGUOUS',
      transactionOutcome: 'ambiguous',
      details: { category: String(error?.code || 'RESTORE_FAILED') }
    });
    error.transactionOutcome = 'ambiguous';
    error.failureSubstep = error.failureSubstep || 'MANAGED_OVERLAY_EXECUTION';
    throw error;
  }
  if (result.applied !== true || result.atomic !== true || result.diagnostic?.exitCode !== 0) {
    const error = categoricalError('DEV_REMEDIATION_RESTORE_COMMIT_UNPROVEN');
    error.transactionOutcome = 'ambiguous';
    error.failureSubstep = 'TRANSACTION_COMMIT';
    throw error;
  }
  appendRemediationEvent(context.rootDirectory, context.key, {
    stage,
    substep: 'TRANSACTION_COMMITTED',
    transactionOutcome: 'committed',
    details: { exitCode: 0, atomic: true }
  });
  const current = await captureRecoveryOwnedState(context.connectionString, identity(context));
  assertRecoveryApplicationStateEqual(
    current, expected, `DEV_REMEDIATION_${expectedLabel}_POST_COMMIT_MISMATCH`
  );
  const authAfter = await captureRemediationAuthCertificate(context.connectionString, {
    ...identity(context),
    expectedDefaultWarehouse: context.preparation.targetSession.smokeDefaultWarehouse
  });
  assertRemediationAuthTransition(authBefore, authAfter, {
    mode: AUTH_EPHEMERA_MODES.STRICT_CLEAN,
    logoutSucceeded: true,
    requireFreshLogin: false
  });
  appendRemediationEvent(context.rootDirectory, context.key, {
    stage,
    substep: 'POST_COMMIT_STATE_VERIFIED',
    transactionOutcome: 'committed',
    details: { stateDigest: current.digest }
  });
  appendRemediationEvent(context.rootDirectory, context.key, {
    stage,
    substep: 'CLEANUP_COMPLETE',
    transactionOutcome: 'committed',
    details: { privateDiagnosticRetained: false }
  });
  return { result, current };
}

async function runRestoreOriginalY2(context) {
  const original = originalState(context);
  const r3 = readStageState(stateOptions(context, 'R3_VALIDATED'));
  const journal = readRemediationJournal(context.rootDirectory, context.key);
  assertR3StageBinding(r3, journal.marker);
  const packageAuthentication = verifyManagedOverlayPackageForExecution({
    connectionString: context.connectionString,
    packageResult: r3.originalY2RecoveryPackage,
    targetGuard: remediationDatabaseOverlayGuard(context, r3.originalY2RecoveryPackage)
  });
  if (
    packageAuthentication.authenticated !== true ||
    canonicalDigest(packageAuthentication) !== canonicalDigest(r3.originalY2PackageAuthentication)
  ) throw categoricalError('DEV_REMEDIATION_ORIGINAL_Y2_PACKAGE_PREVALIDATION_DRIFT');
  const current = await captureRecoveryOwnedState(context.connectionString, identity(context));
  assertRecoveryApplicationStateEqual(current, r3.before, 'DEV_REMEDIATION_PRE_BOUNDARY_R3_MISMATCH');
  assertRecoveryApplicationStateEqual(current, original.y2.before, 'DEV_REMEDIATION_PRE_BOUNDARY_Y2_MISMATCH');
  const restored = await runSubstep('ORIGINAL_Y2_MANAGED_OVERLAY', () => executeKnownRestore(context, {
    stage: 'RESTORE_ORIGINAL_Y2',
    packageResult: r3.originalY2RecoveryPackage,
    expectedPackageAuthentication: r3.originalY2PackageAuthentication,
    expected: original.y2.before,
    expectedLabel: 'ORIGINAL_Y2',
    diagnosticName: 'original-y2-restore-diagnostics-private'
  }), { transactionOutcome: 'ambiguous' });
  writeStageState({ ...stateOptions(context, 'RESTORE_ORIGINAL_Y2'), value: {
    transactionOutcome: 'committed',
    current: restored.current,
    restoreObjectCount: Number(original.y2.recoveryPackage?.manifest?.entries?.length || 0)
  } });
  return {
    originalY2Restored: true,
    transactionOutcome: 'committed',
    restoreObjectCount: Number(original.y2.recoveryPackage?.manifest?.entries?.length || 0),
    oldRecoveryStateChanged: false
  };
}

async function runFreshAuthentication(context) {
  return runFreshAuthenticationCanary({ preparation: context.preparation });
}

async function runAuthRuntimeVerified(context) {
  const original = originalState(context);
  const current = await captureRecoveryOwnedState(context.connectionString, identity(context));
  assertRecoveryApplicationStateEqual(current, original.y2.before);
  const auth = await runCertifiedAuthCanary(context, { purpose: 'AUTH_RUNTIME_VERIFIED' });
  const value = {
    nativeSmokeActiveOwner: current.nativeSmoke.ownerMembershipCount === 1,
    rawMetadataMarker: true,
    identityMetadataMarker: true,
    copiedUsersFrozen: true,
    authSemanticParity: auth.parity.stableStateExact,
    boundedEphemera: auth.parity.boundedEphemera,
    copiedUsersExact: auth.parity.copiedUsersExact,
    copiedIdentitiesExact: auth.parity.copiedIdentitiesExact,
    allowedNativeEphemera: auth.allowedNativeEphemera,
    certificate: auth.certificate,
    ...auth.functional
  };
  writeStageState({ ...stateOptions(context, 'AUTH_RUNTIME_VERIFIED'), value });
  return value;
}

function runApplicationRuntimeVerified(context) {
  const auth = readStageState(stateOptions(context, 'AUTH_RUNTIME_VERIFIED'));
  if (
    !auth.freshAuthentication || !auth.readOnlyApiSucceeded ||
    !auth.filmCatalogReadSucceeded || !auth.boxSearchReadSucceeded || !auth.jobsReadSucceeded
  ) {
    throw categoricalError('DEV_REMEDIATION_APPLICATION_RUNTIME_EVIDENCE_MISSING');
  }
  const value = {
    readOnlyApiSucceeded: true,
    filmCatalogReadSucceeded: true,
    boxSearchReadSucceeded: true,
    jobsReadSucceeded: true,
    businessMutations: 0,
    sessionRevoked: auth.sessionRevoked,
    ephemeralSessionException: auth.ephemeralSessionException
  };
  writeStageState({ ...stateOptions(context, 'APPLICATION_RUNTIME_VERIFIED'), value });
  return value;
}

async function runFinalY2Parity(context) {
  const original = originalState(context);
  const current = await captureRecoveryOwnedState(context.connectionString, identity(context));
  assertRecoveryApplicationStateEqual(current, original.y2.before, 'DEV_REMEDIATION_FINAL_Y2_MISMATCH');
  const reconciled = await reconcileAuthCanaryState(context);
  const authCurrent = reconciled.certificate;
  const auth = readStageState(stateOptions(context, 'AUTH_RUNTIME_VERIFIED'));
  const parity = assertRemediationAuthTransition(context.preparation.authHardening.baseline, authCurrent, {
    mode: AUTH_EPHEMERA_MODES.FROZEN_ATTEMPT_PARITY,
    logoutSucceeded: reconciled.disposition.sessionRevoked,
    requireFreshLogin: false,
    allowedNativeEphemera: reconciled.frozenAllowance
  });
  const value = {
    current,
    originalY2Exact: true,
    unexplainedDifferences: 0,
    ephemeralSessionException: auth.ephemeralSessionException === true,
    sessionRevoked: auth.sessionRevoked,
    boundedEphemera: parity.boundedEphemera,
    authSemanticParity: parity.stableStateExact,
    oldRecoveryStateChanged: false
  };
  writeStageState({ ...stateOptions(context, 'FINAL_Y2_PARITY'), value });
  return {
    originalY2Exact: true,
    unexplainedDifferences: 0,
    sessionTokenExceptionOnly: auth.ephemeralSessionException === true,
    sessionRevoked: auth.sessionRevoked,
    boundedEphemera: parity.boundedEphemera,
    authSemanticParity: parity.stableStateExact,
    oldRecoveryFailedImmutable: true
  };
}

async function recoveryPrecheckSnapshot(context, r3, disposition) {
  const client = new Client({
    connectionString: context.connectionString,
    ssl: /(?:127\.0\.0\.1|localhost)/i.test(context.connectionString) ? undefined : { rejectUnauthorized: false },
    application_name: 'dev-recovery-remediation-recovery-precheck'
  });
  await runSubstep('RECOVERY_PRECHECK_DB_CONNECT', () => client.connect());
  let began = false;
  try {
    await runSubstep('RECOVERY_PRECHECK_DB_BEGIN', () =>
      client.query('begin isolation level repeatable read read only'));
    began = true;
    const proof = await runSubstep('RECOVERY_PRECHECK_READ_ONLY_PROOF', () =>
      client.query("select current_setting('transaction_read_only') as value"));
    if (proof.rows[0]?.value !== 'on') {
      throw categoricalError('DEV_REMEDIATION_RECOVERY_PRECHECK_READ_ONLY_UNPROVEN');
    }
    const quietWindow = await runSubstep('RECOVERY_PRECHECK_QUIET_WINDOW', () =>
      captureQuietWindowFromClient(client));
    const sideEffects = await runSubstep('RECOVERY_PRECHECK_SIDE_EFFECTS', () =>
      captureRuntimeSideEffectPostureFromClient(client));
    if (['cronJobs', 'networkCallers', 'webhooks', 'foreignResources'].some((name) =>
      Number(sideEffects[name]) !== Number(context.preparation.sideEffects.observed?.[name] || 0))) {
      throw categoricalError('DEV_REMEDIATION_RECOVERY_SIDE_EFFECT_CERTIFICATE_MISMATCH');
    }
    const current = await runSubstep('RECOVERY_PRECHECK_APPLICATION_CAPTURE', () =>
      captureRecoveryOwnedStateFromClient(client, identity(context)));
    await runSubstep('RECOVERY_PRECHECK_APPLICATION_PARITY', () =>
      assertRecoveryApplicationStateEqual(
        current, r3.before, 'DEV_REMEDIATION_RECOVERY_PRECHECK_PLANE_DRIFT'
      ));
    const auth = await runSubstep('RECOVERY_PRECHECK_AUTH_CAPTURE', () =>
      captureRemediationAuthCertificateFromClient(client, {
        ...identity(context),
        expectedDefaultWarehouse: context.preparation.targetSession.smokeDefaultWarehouse
      }));
    const authParity = await runSubstep('RECOVERY_PRECHECK_AUTH_PARITY', () =>
      assertRemediationAuthTransition(
        context.preparation.authHardening.baseline,
        auth,
        {
          mode: AUTH_EPHEMERA_MODES.FROZEN_ATTEMPT_PARITY,
          logoutSucceeded: disposition.sessionRevoked,
          requireFreshLogin: false,
          allowedNativeEphemera: disposition.allowedNativeEphemera
        }
      ));
    await runSubstep('RECOVERY_PRECHECK_DB_ROLLBACK', () => client.query('rollback'));
    began = false;
    const edge = await runSubstep('RECOVERY_PRECHECK_EDGE', () =>
      fetchFreshEdgeIdentity({ preparation: context.preparation }));
    const auditPosture = await runSubstep('RECOVERY_PRECHECK_AUDIT', () =>
      fetchAuthAuditStoragePosture({ preparation: context.preparation }));
    if (canonicalSerialize(auditPosture) !== canonicalSerialize(context.preparation.authHardening.auditPosture)) {
      throw categoricalError('DEV_REMEDIATION_AUTH_AUDIT_POSTURE_DRIFT');
    }
    return { quietWindow, sideEffects, current, authParity, edge, auditPosture };
  } finally {
    if (began) await client.query('rollback').catch(() => {});
    await client.end().catch(() => {});
  }
}

async function runRemediationRecoveryPrecheck(context) {
  await runSubstep('RECOVERY_PRECHECK_ORIGINAL_STATE', () => originalState(context));
  const journal = await runSubstep('RECOVERY_PRECHECK_JOURNAL', () =>
    readRemediationJournal(context.rootDirectory, context.key));
  const initial = journal.current.state === 'REMEDIATION_RECOVERY_REQUIRED' && !journal.recovery;
  const continuing = journal.current.state === 'REMEDIATION_RECOVERY_AUTHORIZED' &&
    journal.recovery && !journal.recoveryBoundary;
  if (
    (!initial && !continuing) || !journal.marker || !journal.boundary
  ) throw categoricalError('DEV_REMEDIATION_RECOVERY_PRECHECK_STATE_INVALID');
  const r3 = await runSubstep('RECOVERY_PRECHECK_R3_STATE', () =>
    readStageState(stateOptions(context, 'R3_VALIDATED')));
  await runSubstep('RECOVERY_PRECHECK_R3_BINDING', () => assertR3StageBinding(r3, journal.marker));
  const packageAuthentication = await runSubstep('RECOVERY_PRECHECK_PACKAGE', () =>
    verifyManagedOverlayPackageForExecution({
      connectionString: context.connectionString,
      packageResult: r3.recoveryPackage,
      targetGuard: remediationDatabaseOverlayGuard(context, r3.recoveryPackage)
    }));
  if (canonicalDigest(packageAuthentication) !== canonicalDigest(r3.recoveryPackageAuthentication)) {
    throw categoricalError('DEV_REMEDIATION_R3_PACKAGE_PREVALIDATION_DRIFT');
  }
  await runSubstep('RECOVERY_PRECHECK_AUTH_RECONCILIATION', () => reconcileAuthCanaryState(context));
  const disposition = await runSubstep('RECOVERY_PRECHECK_AUTH_DISPOSITION', () =>
    authRuntimeDisposition(context));
  const snapshot = await runSubstep('RECOVERY_PRECHECK_SNAPSHOT', () =>
    recoveryPrecheckSnapshot(context, r3, disposition));
  return {
    targetExact: packageAuthentication.authenticated,
    exactAttemptAndR3Binding: true,
    recoveryRequiredStateExact: initial || continuing,
    noExistingRecoveryInvocation: true,
    sameAttemptPreBoundaryContinuation: continuing,
    retainedRecoveryPackageAuthenticated: true,
    realQuietWindow: snapshot.quietWindow.quiet,
    activeClients: snapshot.quietWindow.activeClients,
    idleInTransaction: snapshot.quietWindow.idleInTransaction,
    lockWaiters: snapshot.quietWindow.lockWaiters,
    writeShaped: snapshot.quietWindow.writeShaped,
    freshEdgeExact: snapshot.edge.compatible,
    freshSideEffectsSafe: snapshot.sideEffects.safe,
    recoverablePlaneExact: true,
    authSemanticParity: snapshot.authParity.stableStateExact,
    sharedMutations: 0
  };
}

function maybeCrashDisposableWorker(context, point) {
  if (context.preparation.mode !== 'disposable-managed-local') return;
  const crashPath = privateArtifactPath(
    context.rootDirectory,
    'disposable-test-crash-point.private.txt'
  );
  if (!fs.existsSync(crashPath)) return;
  verifyPrivateArtifactProtection(crashPath);
  const bytes = fs.readFileSync(crashPath);
  try {
    if (bytes.toString('utf8').trim() === point) process.kill(process.pid, 'SIGKILL');
  } finally {
    bytes.fill(0);
  }
}

async function reconcileRecoveryDatabaseState(context, r3) {
  const current = await captureRecoveryOwnedState(context.connectionString, identity(context));
  assertRecoveryApplicationStateEqual(
    current,
    r3.before,
    'DEV_REMEDIATION_RECOVERY_DATABASE_STATE_RECONCILIATION_MISMATCH'
  );
  const auth = await reconcileAuthCanaryState(context);
  assertRemediationAuthTransition(context.preparation.authHardening.baseline, auth.certificate, {
    mode: AUTH_EPHEMERA_MODES.FROZEN_ATTEMPT_PARITY,
    logoutSucceeded: auth.disposition.sessionRevoked,
    requireFreshLogin: false,
    allowedNativeEphemera: auth.frozenAllowance
  });
  const posture = await freshPreBoundaryPosture(context);
  appendRemediationEvent(context.rootDirectory, context.key, {
    stage: 'REMEDIATION_RECOVERY_DATABASE',
    substep: 'DATABASE_STATE_RECONCILED',
    transactionOutcome: 'committed',
    details: {
      stateDigest: current.digest,
      commitDirectlyObserved: false,
      edgeExact: posture.edge.compatible,
      auditPostureExact: true
    }
  });
  const value = {
    transactionOutcome: 'committed',
    current,
    authMutationScope: 'preserve-target-native-auth',
    retainedPackageDigest: r3.r3RecoveryPackageDigest,
    commitEvidenceMode: 'state_reconciled',
    commitDirectlyObserved: false,
    databaseStateReconciled: true
  };
  writeStageState({ ...stateOptions(context, 'REMEDIATION_RECOVERY_DATABASE'), value });
  return value;
}

async function runRemediationRecoveryDatabase(context) {
  originalState(context);
  const journal = readRemediationJournal(context.rootDirectory, context.key);
  const r3 = readStageState(stateOptions(context, 'R3_VALIDATED'));
  assertR3StageBinding(r3, journal.marker);
  if (
    journal.current.state !== 'REMEDIATION_RECOVERY_DATABASE_BOUNDARY' ||
    !journal.recovery || !journal.recoveryBoundary
  ) throw categoricalError('DEV_REMEDIATION_RECOVERY_DATABASE_BOUNDARY_INVALID');
  const packageAuthentication = verifyManagedOverlayPackageForExecution({
    connectionString: context.connectionString,
    packageResult: r3.recoveryPackage,
    targetGuard: remediationDatabaseOverlayGuard(context, r3.recoveryPackage)
  });
  if (canonicalDigest(packageAuthentication) !== canonicalDigest(r3.recoveryPackageAuthentication)) {
    throw categoricalError('DEV_REMEDIATION_R3_PACKAGE_PREVALIDATION_DRIFT');
  }
  const committed = readOptionalStageState(stateOptions(context, 'REMEDIATION_RECOVERY_DATABASE'));
  if (committed) {
    if (
      committed.transactionOutcome !== 'committed' ||
      committed.retainedPackageDigest !== r3.r3RecoveryPackageDigest
    ) throw categoricalError('DEV_REMEDIATION_RECOVERY_COMMIT_EVIDENCE_INVALID');
    const current = await captureRecoveryOwnedState(context.connectionString, identity(context));
    assertRecoveryApplicationStateEqual(current, r3.before, 'DEV_REMEDIATION_RECOVERY_COMMIT_RECONCILIATION_FAILED');
    return {
      r3Restored: true,
      transactionOutcome: 'committed',
      retainedPackageUsed: true,
      commitEvidenceReconciled: true,
      databaseStateReconciled: committed.commitEvidenceMode === 'state_reconciled',
      commitDirectlyObserved: committed.commitEvidenceMode !== 'state_reconciled',
      oldRecoveryStateChanged: false
    };
  }
  const mode = String(process.env.DEV_REFRESH_RECOVERY_DATABASE_MODE || '');
  if (!['EXECUTE_ONCE', 'RECONCILE_ONLY'].includes(mode)) {
    throw categoricalError('DEV_REMEDIATION_RECOVERY_DATABASE_MODE_INVALID');
  }
  const reconciliationEnvironmentNames = context.preparation.mode === 'disposable-managed-local'
    ? ['EDGE_API_BASE_URL', 'SUPABASE_URL']
    : ['EDGE_API_BASE_URL', 'SUPABASE_ACCESS_TOKEN', 'SUPABASE_URL'];
  if (mode === 'EXECUTE_ONCE' && reconciliationEnvironmentNames.some((name) => process.env[name])) {
    throw categoricalError('DEV_REMEDIATION_RECOVERY_DATABASE_EXCESS_AUTHORITY');
  }
  if (mode === 'RECONCILE_ONLY' && reconciliationEnvironmentNames.some((name) => !process.env[name])) {
    throw categoricalError('DEV_REMEDIATION_RECOVERY_RECONCILIATION_AUTHORITY_UNAVAILABLE');
  }
  const executionStarted = readRemediationEvents(context.rootDirectory, context.key).some((event) =>
    event.stage === 'REMEDIATION_RECOVERY_DATABASE' &&
    event.substep === 'RECOVERY_PACKAGE_EXECUTION_STARTED'
  );
  if (mode === 'RECONCILE_ONLY') {
    const reconciled = await reconcileRecoveryDatabaseState(context, r3);
    return {
      r3Restored: true,
      transactionOutcome: 'committed',
      retainedPackageUsed: true,
      databaseStateReconciled: true,
      commitDirectlyObserved: false,
      reconciliationReadOnly: true,
      oldRecoveryStateChanged: false,
      stateDigest: reconciled.current.digest
    };
  }
  if (executionStarted) throw categoricalError('DEV_REMEDIATION_RECOVERY_PACKAGE_REPLAY_REJECTED');
  appendRemediationEvent(context.rootDirectory, context.key, {
    stage: 'REMEDIATION_RECOVERY_DATABASE',
    substep: 'RECOVERY_PACKAGE_EXECUTION_STARTED',
    transactionOutcome: 'ambiguous',
    details: { retainedPackageDigest: r3.r3RecoveryPackageDigest, executionOnce: true }
  });
  maybeCrashDisposableWorker(context, 'BEFORE_RECOVERY_DATABASE_COMMIT');
  const restored = await runSubstep('R3_MANAGED_OVERLAY', () => executeKnownRestore(context, {
      stage: 'REMEDIATION_RECOVERY_DATABASE',
      packageResult: r3.recoveryPackage,
      expectedPackageAuthentication: r3.recoveryPackageAuthentication,
      expected: r3.before,
      expectedLabel: 'R3',
      diagnosticName: 'r3-recovery-diagnostics-private'
  }), { transactionOutcome: 'ambiguous' });
  maybeCrashDisposableWorker(context, 'AFTER_RECOVERY_DATABASE_COMMIT_BEFORE_STATE');
  writeStageState({ ...stateOptions(context, 'REMEDIATION_RECOVERY_DATABASE'), value: {
    transactionOutcome: 'committed', current: restored.current,
    authMutationScope: 'preserve-target-native-auth',
    retainedPackageDigest: r3.r3RecoveryPackageDigest,
    commitEvidenceMode: 'directly_observed',
    commitDirectlyObserved: true,
    databaseStateReconciled: false
  } });
  return {
    r3Restored: true,
    transactionOutcome: 'committed',
    retainedPackageUsed: true,
    databaseStateReconciled: false,
    commitDirectlyObserved: true,
    oldRecoveryStateChanged: false
  };
}

async function runRemediationRecoveryVerified(context) {
  originalState(context);
  const journal = readRemediationJournal(context.rootDirectory, context.key);
  if (
    journal.current.state !== 'REMEDIATION_RECOVERY_VERIFICATION_PENDING' ||
    !journal.recovery || !journal.recoveryBoundary
  ) throw categoricalError('DEV_REMEDIATION_RECOVERY_VERIFICATION_STATE_INVALID');
  const r3 = readStageState(stateOptions(context, 'R3_VALIDATED'));
  assertR3StageBinding(r3, journal.marker);
  const current = await captureRecoveryOwnedState(context.connectionString, identity(context));
  assertRecoveryApplicationStateEqual(current, r3.before, 'DEV_REMEDIATION_RECOVERY_R3_MISMATCH');
  const auth = await runCertifiedAuthCanary(context, {
    purpose: 'RECOVERY_VERIFICATION'
  });
  const finalParity = auth.parity;
  const sessionRevoked = auth.parity.sessionRevoked;
  return {
    r3Exact: true,
    unexplainedDifferences: 0,
    oldRecoveryFailedImmutable: true,
    freshAuthentication: auth.functional.freshAuthentication,
    smokeUserExact: auth.functional.smokeUserExact,
    smokeOrganizationExact: auth.functional.smokeOrganizationExact,
    defaultWarehouseExact: auth.functional.defaultWarehouseExact,
    filmCatalogReadSucceeded: auth.functional.filmCatalogReadSucceeded,
    boxSearchReadSucceeded: auth.functional.boxSearchReadSucceeded,
    jobsReadSucceeded: auth.functional.jobsReadSucceeded,
    readOnlyApiSucceeded: auth.functional.readOnlyApiSucceeded,
    authSemanticParity: finalParity.stableStateExact,
    boundedEphemera: finalParity.boundedEphemera,
    sessionRevoked,
    ephemeralSessionException: auth.functional.ephemeralSessionException
  };
}

async function runRemediationStage(context, stage) {
  const implementations = {
    REMEDIATION_PRECHECK: runRemediationPrecheck,
    CURRENT_Y2_PARITY: runCurrentY2Parity,
    R3_CAPTURE: runR3Capture,
    R3_VALIDATED: runR3Validated,
    RESTORE_ORIGINAL_Y2: runRestoreOriginalY2,
    AUTH_RUNTIME_VERIFIED: runAuthRuntimeVerified,
    APPLICATION_RUNTIME_VERIFIED: runApplicationRuntimeVerified,
    FINAL_Y2_PARITY: runFinalY2Parity,
    REMEDIATION_RECOVERY_PRECHECK: runRemediationRecoveryPrecheck,
    REMEDIATION_RECOVERY_DATABASE: runRemediationRecoveryDatabase,
    REMEDIATION_RECOVERY_VERIFIED: runRemediationRecoveryVerified
  };
  const implementation = implementations[stage];
  if (!implementation) throw categoricalError('DEV_REMEDIATION_REAL_STAGE_UNSUPPORTED');
  return implementation(context);
}

function writeResultRecord(record) {
  const descriptor = Number(process.env.DEV_REFRESH_RESULT_FD);
  if (!Number.isInteger(descriptor) || descriptor < 3) {
    throw categoricalError('DEV_REMEDIATION_REAL_STAGE_RESULT_FD_INVALID');
  }
  const bytes = Buffer.from(JSON.stringify(record), 'utf8');
  try {
    fs.writeSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    bytes.fill(0);
  }
}

function writeFailure(error, key) {
  const payload = buildOperationFailure({
    stage: String(process.env.DEV_REFRESH_STAGE || ''),
    attemptId: String(process.env.DEV_REFRESH_ATTEMPT_ID || ''),
    target: 'dev',
    projectRef: DEV_PROJECT_REF,
    contractDigest: String(process.env.DEV_REFRESH_CONTRACT_DIGEST || ''),
    error
  });
  writeResultRecord({
    format: RESULT_FORMAT,
    failure: payload,
    authentication: { algorithm: 'hmac-sha256-v1', digest: signPayload(payload, key) }
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const key = readWorkerAuthorityKey();
  try {
    const stage = String(process.env.DEV_REFRESH_STAGE || '');
    const rootDirectory = path.resolve(String(process.env.DEV_REFRESH_STATE_DIR || ''));
    const preparationRecord = readPrivateJson(options.preparationPath);
    const frozenStages = new Set([
      'RESTORE_ORIGINAL_Y2',
      'AUTH_RUNTIME_VERIFIED',
      'APPLICATION_RUNTIME_VERIFIED',
      'FINAL_Y2_PARITY',
      'REMEDIATION_RECOVERY_PRECHECK',
      'REMEDIATION_RECOVERY_DATABASE',
      'REMEDIATION_RECOVERY_VERIFIED'
    ]);
    const preparation = frozenStages.has(stage)
      ? verifyFrozenRemediationPreparation(preparationRecord, key, {
          rootDirectory,
          expectedAttemptId: process.env.DEV_REFRESH_ATTEMPT_ID,
          contractDigest: String(process.env.DEV_REFRESH_CONTRACT_DIGEST || ''),
          operationInventoryDigest: String(process.env.DEV_REFRESH_OPERATION_INVENTORY_DIGEST || ''),
          stage
        })
      : verifyRemediationPreparation(
          preparationRecord,
          key,
          process.env.DEV_REFRESH_ATTEMPT_ID
        );
    const context = {
      key,
      preparation,
      attemptId: preparation.remediationAttemptId,
      connectionString: preparation.targetSession.connectionString,
      rootDirectory,
      repoRoot: path.resolve(process.cwd())
    };
    const details = await runRemediationStage(context, stage);
    const evidence = {
      format: REMEDIATION_EVIDENCE_FORMAT,
      stage,
      attemptId: preparation.remediationAttemptId,
      target: 'dev',
      projectRef: DEV_PROJECT_REF,
      status: 'passed',
      contractDigest: String(process.env.DEV_REFRESH_CONTRACT_DIGEST || ''),
      safeCount: Object.keys(details).length,
      evidenceDigest: canonicalDigest(details),
      details
    };
    assertRecoveryRemediationEvidence(evidence, {
      contract: {
        remediationAttemptId: preparation.remediationAttemptId,
        contractDigest: String(process.env.DEV_REFRESH_CONTRACT_DIGEST || ''),
        operationInventoryDigest: String(process.env.DEV_REFRESH_OPERATION_INVENTORY_DIGEST || '')
      },
      stage
    });
    writeResultRecord({ format: RESULT_FORMAT, evidence });
  } catch (error) {
    try { writeFailure(error, key); } catch {}
    throw error;
  } finally {
    key.fill(0);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(() => { process.exitCode = 1; });
}

export {
  disposableLoopbackOverlayGuard,
  managedDevOverlayGuard,
  remediationDatabaseOverlayGuard,
  runFreshAuthentication,
  runRemediationStage
};
