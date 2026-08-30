import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { canonicalDigest, canonicalSerialize } from '../readonly-diagnostics.mjs';
import { DEV_PROJECT_REF } from './dev-certified-contract.mjs';
import { buildOperationFailure } from './dev-certified-operation-failure.mjs';
import { readStageState, writeStageState } from './dev-certified-stage-state.mjs';
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
import { executeManagedOverlayPackage } from './managed-restore.mjs';
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
import { verifyRemediationPreparation } from './dev-recovery-remediation-preparation.mjs';
import {
  assertRecoveryApplicationStateEqual,
  assertOriginalFailedRecoveryUnchanged,
  captureRemediationAuthCertificate,
  captureRecoveryOwnedState,
  captureRecoveryOwnedStateFromClient
} from './dev-recovery-remediation-shared.mjs';
import {
  assertRemediationAuthTransition,
  captureQuietWindowFromClient,
  captureRuntimeSideEffectPostureFromClient,
  fetchFreshEdgeIdentity,
  runFreshAuthenticationCanary
} from './dev-recovery-remediation-auth.mjs';
import { appendRemediationEvent } from './dev-recovery-remediation-state.mjs';

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

function targetGuard(context, packageResult) {
  if (context.preparation.mode === 'disposable-managed-local') {
    return { mode: 'disposable-managed-local', loopback: true };
  }
  return {
    target: 'dev',
    projectRef: DEV_PROJECT_REF,
    mutationGuardPassed: true,
    projectRefMatched: true,
    ...packageResult.targetCompatibility
  };
}

function diagnosticsDirectory(context, name) {
  const root = path.join(context.rootDirectory, name);
  if (!fs.existsSync(root)) createPrivateDirectory(root);
  return root;
}

function runSubstep(substep, action, { transactionOutcome = 'not_started' } = {}) {
  return Promise.resolve().then(action).catch((error) => {
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
    return { quietWindow, sideEffects, edge };
  } finally {
    if (began) await client.query('rollback').catch(() => {});
    await client.end().catch(() => {});
  }
}

async function runCertifiedAuthCanary(context) {
  const before = await captureRemediationAuthCertificate(context.connectionString, {
    ...identity(context),
    expectedDefaultWarehouse: context.preparation.targetSession.smokeDefaultWarehouse
  });
  assertRemediationAuthTransition(context.preparation.authHardening.baseline, before, {
    logoutSucceeded: true,
    requireFreshLogin: false
  });
  const functional = await runFreshAuthenticationCanary({ preparation: context.preparation });
  const after = await captureRemediationAuthCertificate(context.connectionString, {
    ...identity(context),
    expectedDefaultWarehouse: context.preparation.targetSession.smokeDefaultWarehouse
  });
  const parity = assertRemediationAuthTransition(before, after, {
    logoutSucceeded: functional.sessionRevoked,
    requireFreshLogin: true
  });
  return { functional, parity, certificate: after };
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
  const auth = await runCertifiedAuthCanary(context);
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
      targetGuard: targetGuard(context, recovery.packageResult),
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
      targetGuard: targetGuard(context, originalRecovery.packageResult),
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
    const value = {
      ...r3,
      recoveryPackage: recovery.packageResult,
      originalY2RecoveryPackage: originalRecovery.packageResult,
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
      validated: true
    };
    writeStageState({ ...stateOptions(context, 'R3_VALIDATED'), value });
    return {
      r3RecoveryId: r3.recoveryId,
      r3ComponentDigest: r3.component.digest,
      digestVerified: true,
      canonicalRestoreTested: true,
      currentEqualsR3: true,
      r3EqualsOriginalY2: true,
      authMutationScope: 'preserve-target-native-auth',
      realQuietWindowRechecked: posture.quietWindow.quiet,
      freshEdgeRechecked: posture.edge.compatible,
      freshSideEffectsRechecked: posture.sideEffects.safe
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
  expected,
  expectedLabel,
  diagnosticName
} = {}) {
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
      targetGuard: targetGuard(context, packageResult),
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
  const current = await captureRecoveryOwnedState(context.connectionString, identity(context));
  assertRecoveryApplicationStateEqual(current, r3.before, 'DEV_REMEDIATION_PRE_BOUNDARY_R3_MISMATCH');
  assertRecoveryApplicationStateEqual(current, original.y2.before, 'DEV_REMEDIATION_PRE_BOUNDARY_Y2_MISMATCH');
  const restored = await runSubstep('ORIGINAL_Y2_MANAGED_OVERLAY', () => executeKnownRestore(context, {
    stage: 'RESTORE_ORIGINAL_Y2',
    packageResult: r3.originalY2RecoveryPackage,
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
  const auth = await runCertifiedAuthCanary(context);
  const value = {
    nativeSmokeActiveOwner: current.nativeSmoke.ownerMembershipCount === 1,
    rawMetadataMarker: true,
    identityMetadataMarker: true,
    copiedUsersFrozen: true,
    authSemanticParity: auth.parity.stableStateExact,
    ...auth.functional
  };
  writeStageState({ ...stateOptions(context, 'AUTH_RUNTIME_VERIFIED'), value });
  return value;
}

function runApplicationRuntimeVerified(context) {
  const auth = readStageState(stateOptions(context, 'AUTH_RUNTIME_VERIFIED'));
  if (!auth.freshAuthentication || !auth.readOnlyApiSucceeded) {
    throw categoricalError('DEV_REMEDIATION_APPLICATION_RUNTIME_EVIDENCE_MISSING');
  }
  const value = {
    readOnlyApiSucceeded: true,
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
  const authCurrent = await captureRemediationAuthCertificate(context.connectionString, {
    ...identity(context),
    expectedDefaultWarehouse: context.preparation.targetSession.smokeDefaultWarehouse
  });
  assertRemediationAuthTransition(context.preparation.authHardening.baseline, authCurrent, {
    logoutSucceeded: true,
    requireFreshLogin: false
  });
  const auth = readStageState(stateOptions(context, 'AUTH_RUNTIME_VERIFIED'));
  const value = {
    current,
    originalY2Exact: true,
    unexplainedDifferences: 0,
    ephemeralSessionException: auth.ephemeralSessionException === true,
    oldRecoveryStateChanged: false
  };
  writeStageState({ ...stateOptions(context, 'FINAL_Y2_PARITY'), value });
  return {
    originalY2Exact: true,
    unexplainedDifferences: 0,
    sessionTokenExceptionOnly: auth.ephemeralSessionException === true,
    oldRecoveryFailedImmutable: true
  };
}

async function runRemediationRecoveryDatabase(context) {
  originalState(context);
  const r3 = readStageState(stateOptions(context, 'R3_VALIDATED'));
  const tools = resolvePostgresTools(context.preparation.targetSession.postgresBin || '');
  const key = readWrappedBaselineDataKey({ wrappingKey: context.key, artifactPath: r3.keyPath });
  const packageDirectory = createPrivateDirectory(path.join(context.rootDirectory, 'r3-recovery-apply-package'));
  const plaintextPath = privateArtifactPath(packageDirectory, 'r3-recovery-apply.private.pgdump');
  try {
    const encrypted = fs.readFileSync(r3.artifactPath);
    let plaintext;
    try {
      plaintext = decryptBaselineBytes(encrypted, key);
      writePrivateBytesExclusive(plaintextPath, plaintext);
    } finally {
      encrypted.fill(0);
      if (plaintext) plaintext.fill(0);
    }
    const recovery = await generateCurrentDatabaseRecoveryPackage({
      connectionString: context.connectionString,
      archivePath: plaintextPath,
      sourceComponent: r3.component,
      privateDirectory: packageDirectory,
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
    const restored = await runSubstep('R3_MANAGED_OVERLAY', () => executeKnownRestore(context, {
      stage: 'REMEDIATION_RECOVERY_DATABASE',
      packageResult: recovery.packageResult,
      expected: r3.before,
      expectedLabel: 'R3',
      diagnosticName: 'r3-recovery-diagnostics-private'
    }), { transactionOutcome: 'ambiguous' });
    writeStageState({ ...stateOptions(context, 'REMEDIATION_RECOVERY_DATABASE'), value: {
      transactionOutcome: 'committed', current: restored.current,
      authMutationScope: 'preserve-target-native-auth'
    } });
    return { r3Restored: true, transactionOutcome: 'committed', oldRecoveryStateChanged: false };
  } finally {
    key.fill(0);
    if (fs.existsSync(plaintextPath)) fs.rmSync(plaintextPath, { force: true });
  }
}

async function runRemediationRecoveryVerified(context) {
  originalState(context);
  const r3 = readStageState(stateOptions(context, 'R3_VALIDATED'));
  const current = await captureRecoveryOwnedState(context.connectionString, identity(context));
  assertRecoveryApplicationStateEqual(current, r3.before, 'DEV_REMEDIATION_RECOVERY_R3_MISMATCH');
  const auth = await runCertifiedAuthCanary(context);
  return {
    r3Exact: true,
    unexplainedDifferences: 0,
    oldRecoveryFailedImmutable: true,
    freshAuthentication: auth.functional.freshAuthentication,
    smokeUserExact: auth.functional.smokeUserExact,
    smokeOrganizationExact: auth.functional.smokeOrganizationExact,
    defaultWarehouseExact: auth.functional.defaultWarehouseExact,
    readOnlyApiSucceeded: auth.functional.readOnlyApiSucceeded,
    authSemanticParity: auth.parity.stableStateExact
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
    const preparation = verifyRemediationPreparation(
      readPrivateJson(options.preparationPath),
      key,
      process.env.DEV_REFRESH_ATTEMPT_ID
    );
    const stage = String(process.env.DEV_REFRESH_STAGE || '');
    const context = {
      key,
      preparation,
      attemptId: preparation.remediationAttemptId,
      connectionString: preparation.targetSession.connectionString,
      rootDirectory: path.resolve(String(process.env.DEV_REFRESH_STATE_DIR || '')),
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
        contractDigest: String(process.env.DEV_REFRESH_CONTRACT_DIGEST || '')
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

export { runFreshAuthentication, runRemediationStage };
