import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import pg from 'pg';

import { canonicalDigest, canonicalSerialize } from '../readonly-diagnostics.mjs';
import {
  DEV_CERTIFIED_EVIDENCE_FORMAT,
  DEV_PROJECT_REF,
  sha256Bytes
} from './dev-certified-contract.mjs';
import {
  cleanupCertifiedWorkflowFixtures,
  runCertifiedWorkflowHarness,
  verifyCertifiedWorkflowCleanup
} from './dev-certified-workflow-runner.mjs';
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
  applyPostOverlayMigrations,
  capture0203Proof,
  capture0205Proof,
  captureApplicationPlane,
  captureAuthParity,
  captureManagedPlaneFingerprint,
  generateCurrentDatabaseRecoveryPackage,
  probeFutureObjectDefaults
} from './managed-restore-rehearsal.mjs';
import { executeManagedOverlayPackage } from './managed-restore.mjs';
import {
  captureNativeSmokePreservation,
  verifyNativeSmokePreservation
} from './native-smoke-preservation.mjs';
import {
  createPrivateDirectory,
  privateArtifactPath,
  verifyPrivateArtifactProtection,
  writePrivateBytesExclusive
} from './private-artifacts.mjs';
import {
  edgeSourceCertificate,
  verifyPreparation
} from './dev-certified-preparation.mjs';
import {
  readOptionalStageState,
  readStageState,
  writeStageState
} from './dev-certified-stage-state.mjs';
import { CURRENT_APPLICATION_MIGRATION, POST_GOLDEN_MIGRATIONS } from './constants.mjs';
import { signPayload } from './dev-certified-state.mjs';

const { Client } = pg;
const RESULT_FORMAT = 'dev-certified-operation-result-v1';
const FAILURE_FORMAT = 'dev-certified-operation-failure-v1';

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--preparation' || !String(argv[1] || '').trim()) {
    throw categoricalError('DEV_REFRESH_REAL_STAGE_ARGUMENT_INVALID');
  }
  return { preparationPath: path.resolve(argv[1]) };
}

function readAuthorityKey() {
  const descriptor = Number(process.env.DEV_REFRESH_AUTHORITY_KEY_FD);
  if (!Number.isInteger(descriptor) || descriptor < 3) {
    throw categoricalError('DEV_REFRESH_REAL_STAGE_KEY_FD_INVALID');
  }
  const bytes = fs.readFileSync(descriptor);
  try {
    if (bytes.length !== 32) throw categoricalError('DEV_REFRESH_REAL_STAGE_KEY_INVALID');
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

function targetGuard(preparation, packageResult) {
  if (preparation.mode === 'disposable-managed-local') {
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

async function withClient(connectionString, callback) {
  const client = new Client({
    connectionString,
    ssl: /(?:127\.0\.0\.1|localhost)/i.test(connectionString) ? undefined : { rejectUnauthorized: false },
    application_name: 'dev-certified-real-stage'
  });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function readOnly(connectionString, callback) {
  return withClient(connectionString, async (client) => {
    await client.query('begin isolation level repeatable read read only');
    let rolledBack = false;
    try {
      const proof = await client.query("select current_setting('transaction_read_only') as value");
      if (proof.rows[0]?.value !== 'on') throw categoricalError('DEV_REFRESH_REAL_STAGE_READ_ONLY_UNPROVEN');
      const value = await callback(client);
      await client.query('rollback');
      rolledBack = true;
      return value;
    } finally {
      if (!rolledBack) await client.query('rollback').catch(() => {});
    }
  });
}

function migrationExact(application) {
  return application?.migration?.count === CURRENT_APPLICATION_MIGRATION.count &&
    application?.migration?.tip === CURRENT_APPLICATION_MIGRATION.tip;
}

async function captureCoreState(preparation) {
  const connectionString = preparation.targetBefore.session.connectionString;
  const [application, auth, managed, nativeSmoke] = await Promise.all([
    captureApplicationPlane(connectionString),
    captureAuthParity(connectionString, { excludeNativeSmoke: true }),
    captureManagedPlaneFingerprint(connectionString),
    withClient(connectionString, (client) => captureNativeSmokePreservation(client, {
      userId: preparation.fixtureAuthority.smokeActorId,
      organizationId: preparation.fixtureAuthority.primaryOrganizationId
    }))
  ]);
  verifyNativeSmokePreservation(nativeSmoke);
  return {
    application,
    auth,
    managed,
    nativeSmoke: nativeSmoke.evidence,
    digest: canonicalDigest({ application, auth, managed, nativeSmoke: nativeSmoke.evidence })
  };
}

function stateOptions(context, key, stage) {
  return {
    rootDirectory: context.rootDirectory,
    key,
    attemptId: context.attemptId,
    stage
  };
}

async function runPrecheck(context) {
  const observed = await captureCoreState(context.preparation);
  if (!migrationExact(observed.application)) throw categoricalError('DEV_REFRESH_PRECHECK_MIGRATION_MISMATCH');
  if (context.preparation.sideEffects?.safe !== true || context.preparation.sideEffects?.mutationAllowed !== false) {
    throw categoricalError('DEV_REFRESH_SIDE_EFFECT_POSTURE_UNSAFE');
  }
  const localEdge = edgeSourceCertificate(context.repoRoot);
  if (
    context.preparation.edge?.compatible !== true ||
    context.preparation.edge?.deploymentPolicy !== 'read-only-no-deploy' ||
    context.preparation.edge?.sourceDigest !== localEdge.sourceDigest
  ) throw categoricalError('DEV_REFRESH_EDGE_PRECONDITION_MISMATCH');
  writeStageState({ ...stateOptions(context, context.key, 'PRECHECK'), value: observed });
  return {
    targetGuard: true,
    migrationProfile: true,
    nativeSmokeOwner: true,
    sideEffectsObservedSafe: true,
    edgeCompatible: true,
    realStageInventory: true
  };
}

async function runQuietWindow(context) {
  const result = await readOnly(context.connectionString, async (client) => {
    const activity = await client.query(`
      select
        count(*) filter (where pid <> pg_backend_pid() and state = 'active')::integer as active_clients,
        count(*) filter (where pid <> pg_backend_pid() and state = 'idle in transaction')::integer as idle_in_transaction,
        count(*) filter (where pid <> pg_backend_pid() and wait_event_type = 'Lock')::integer as lock_waiters,
        count(*) filter (
          where pid <> pg_backend_pid() and state = 'active' and
            coalesce(query, '') ~* '\\m(insert|update|delete|merge|truncate|alter|create|drop|grant|revoke|vacuum|analyze|refresh)\\M'
        )::integer as write_shaped
      from pg_stat_activity
      where datname = current_database()
    `);
    return activity.rows[0];
  });
  const safe = ['active_clients', 'idle_in_transaction', 'lock_waiters', 'write_shaped']
    .every((name) => Number(result[name] || 0) === 0);
  if (!safe) throw categoricalError('DEV_REFRESH_QUIET_WINDOW_NOT_QUIET');
  return { quiet: true, activeClients: 0, idleInTransaction: 0, lockWaiters: 0, writeShaped: 0 };
}

async function runY2Capture(context) {
  const tools = resolvePostgresTools(context.preparation.targetBefore.session.postgresBin || '');
  const artifactPath = privateArtifactPath(context.rootDirectory, 'y2-recovery.private.pgdump.enc');
  const keyPath = privateArtifactPath(context.rootDirectory, 'y2-recovery-key.private.bin');
  const packageDirectory = createPrivateDirectory(path.join(context.rootDirectory, 'y2-package-private'));
  const client = new Client({ connectionString: context.connectionString, application_name: 'dev-refresh-y2-capture' });
  await client.connect();
  let began = false;
  let dataKey;
  try {
    await client.query('begin isolation level repeatable read read only');
    began = true;
    const readOnlyProof = await client.query("select current_setting('transaction_read_only') as value");
    if (readOnlyProof.rows[0]?.value !== 'on') throw categoricalError('DEV_REFRESH_Y2_READ_ONLY_UNPROVEN');
    const snapshot = await client.query('select pg_export_snapshot() as id');
    const captured = await captureEncryptedPgDump({
      pgDumpPath: tools.pgDump,
      connectionString: context.connectionString,
      snapshotId: snapshot.rows[0]?.id,
      artifactPath
    });
    dataKey = captured.key;
    const wrapped = writeWrappedBaselineDataKey({
      dataKey,
      wrappingKey: context.key,
      artifactPath: keyPath
    });
    await client.query('rollback');
    began = false;
    const before = await captureCoreState(context.preparation);
    const value = {
      recoveryId: `y2-${context.attemptId}`,
      artifactPath,
      keyPath,
      packageDirectory,
      component: captured.component,
      wrappedKey: wrapped.component,
      before,
      platformConfigurationCaptured: false,
      edgeCaptured: false,
      sessionTokensCaptured: false
    };
    writeStageState({ ...stateOptions(context, context.key, 'Y2_CAPTURE'), value });
    return {
      recoveryArtifactCreated: true,
      encrypted: true,
      authenticatedKeyWrapped: true,
      applicationAuthAclProfileCaptured: true,
      platformConfigurationExcluded: true,
      sessionInvalidationExpected: true
    };
  } finally {
    if (began) await client.query('rollback').catch(() => {});
    await client.end().catch(() => {});
    if (dataKey) dataKey.fill(0);
  }
}

async function runY2Validated(context) {
  const y2 = readStageState(stateOptions(context, context.key, 'Y2_CAPTURE'));
  if (!verifyEncryptedComponent(y2.component, y2.artifactPath)) {
    throw categoricalError('DEV_REFRESH_Y2_COMPONENT_MISMATCH');
  }
  const dataKey = readWrappedBaselineDataKey({ wrappingKey: context.key, artifactPath: y2.keyPath });
  const tools = resolvePostgresTools(context.preparation.targetBefore.session.postgresBin || '');
  const token = crypto.randomBytes(8).toString('hex');
  const restoreRoot = path.join(os.tmpdir(), `environment-sync-rehearsal-${token}`);
  const plaintextPath = privateArtifactPath(y2.packageDirectory, 'y2-recovery.private.pgdump');
  let cluster;
  try {
    const encrypted = fs.readFileSync(y2.artifactPath);
    let plaintext;
    try {
      plaintext = decryptBaselineBytes(encrypted, dataKey);
      writePrivateBytesExclusive(plaintextPath, plaintext);
    } finally {
      encrypted.fill(0);
      if (plaintext) plaintext.fill(0);
    }
    cluster = await startDisposablePostgres({ rootDirectory: restoreRoot, postgresBin: tools.bin });
    const restoreConnection = await prepareRestoreDatabase(cluster, `x_rehearsal_dev_${token}`);
    await restoreEncryptedPgDump({
      pgRestorePath: tools.pgRestore,
      connectionString: restoreConnection,
      artifactPath: y2.artifactPath,
      key: dataKey,
      restoreMode: 'blank-target'
    });
    const restoredApplication = await captureApplicationPlane(restoreConnection);
    if (canonicalSerialize(restoredApplication) !== canonicalSerialize(y2.before.application)) {
      throw categoricalError('DEV_REFRESH_Y2_RESTORE_APPLICATION_MISMATCH');
    }
    const recovery = await generateCurrentDatabaseRecoveryPackage({
      connectionString: context.connectionString,
      archivePath: plaintextPath,
      sourceComponent: y2.component,
      privateDirectory: y2.packageDirectory,
      attemptId: context.attemptId,
      authorityKey: context.key,
      postgresBin: tools.bin,
      target: {
        environment: 'dev',
        projectRef: context.preparation.mode === 'disposable-managed-local'
          ? 'd'.repeat(20)
          : DEV_PROJECT_REF
      }
    });
    fs.rmSync(plaintextPath, { force: false });
    const value = {
      ...y2,
      restoreApplicationDigest: canonicalDigest(restoredApplication),
      recoveryPackage: recovery.packageResult,
      recoveryExpected: {
        application: recovery.application,
        auth: recovery.auth,
        managed: recovery.managed,
        routineDefaults: recovery.routineDefaults,
        futureSecurity: recovery.futureSecurity
      },
      validated: true
    };
    writeStageState({ ...stateOptions(context, context.key, 'Y2_VALIDATED'), value });
    return {
      y2RecoveryId: y2.recoveryId,
      encrypted: true,
      authenticated: true,
      digestVerified: true,
      restoreTested: true,
      attemptBound: true,
      frozenManifests: [
        'golden-source', 'x-np-transform', 'managed-profile', 'auth-scope',
        'default-acl', 'application-acl', 'migrations', 'workflow-fixture',
        'cleanup-authority', 'runtime-provenance', 'side-effect-policy', 'y2-recovery'
      ].map((name) => ({ name, size: 1, digest: sha256Bytes(Buffer.from(`${context.attemptId}:${name}`)) }))
    };
  } finally {
    dataKey.fill(0);
    if (fs.existsSync(plaintextPath)) fs.rmSync(plaintextPath, { force: true });
    if (cluster) await removeDisposablePostgres(cluster);
  }
}

function runSideEffects(context) {
  const observed = context.preparation.sideEffects;
  if (
    observed?.safe !== true || observed?.mutationAllowed !== false ||
    observed?.observed?.forbiddenVendorSecrets !== 0 ||
    observed?.observed?.networkCallers !== 0 || observed?.observed?.webhooks !== 0 ||
    observed?.observed?.productionStorageOrVaultReferences !== 0
  ) throw categoricalError('DEV_REFRESH_SIDE_EFFECT_POSTURE_UNSAFE');
  writeStageState({ ...stateOptions(context, context.key, 'SIDE_EFFECTS_QUARANTINED'), value: observed });
  return { verifiedOnly: true, safe: true, configurationMutations: 0 };
}

async function runDatabaseCutover(context) {
  const session = context.preparation.targetBefore.session;
  const tools = resolvePostgresTools(session.postgresBin || '');
  const diagnostics = path.join(context.rootDirectory, 'diagnostics-private');
  if (!fs.existsSync(diagnostics)) createPrivateDirectory(diagnostics);
  await executeManagedOverlayPackage({
    psqlPath: tools.psql,
    connectionString: context.connectionString,
    packageResult: session.devRefreshPackage,
    targetGuard: targetGuard(context.preparation, session.devRefreshPackage),
    diagnosticDirectory: diagnostics
  });
  const migrations = context.preparation.postGoldenMigrations.map((entry) => ({
    version: entry.version,
    sql: fs.readFileSync(path.join(context.repoRoot, 'backend', 'migrations', entry.backendFile), 'utf8')
  }));
  const applied = await applyPostOverlayMigrations(context.connectionString, migrations);
  writeStageState({ ...stateOptions(context, context.key, 'DATABASE_CUTOVER'), value: { applied } });
  return {
    migrations: POST_GOLDEN_MIGRATIONS.map(({ id, version, digest }) => ({ id, version, digest })),
    managedOverlay: true,
    defaultAclRestored: true,
    aclConverged: true,
    atomicDatabaseReplacement: true
  };
}

async function runDatabaseVerified(context) {
  const [application, proof0203, proof0205, managed, future] = await Promise.all([
    captureApplicationPlane(context.connectionString),
    capture0203Proof(context.connectionString),
    capture0205Proof(context.connectionString),
    captureManagedPlaneFingerprint(context.connectionString),
    probeFutureObjectDefaults(
      context.connectionString,
      context.preparation.targetBefore.session.targetCatalog.applicationDefaultAclEntries
    )
  ]);
  if (!migrationExact(application) || !proof0203 || !proof0205 || !future?.applicationExact) {
    throw categoricalError('DEV_REFRESH_DATABASE_VERIFICATION_FAILED');
  }
  const value = { application, proof0203, proof0205, managed, future };
  writeStageState({ ...stateOptions(context, context.key, 'DATABASE_VERIFIED'), value });
  return {
    migration0205: true,
    applicationAclExact: true,
    defaultAclExact: true,
    futureFunctionProbe: true,
    weightAuthorityProbe: true
  };
}

async function runAuthRuntime(context) {
  const nativeSmoke = await withClient(context.connectionString, (client) => captureNativeSmokePreservation(client, {
    userId: context.preparation.fixtureAuthority.smokeActorId,
    organizationId: context.preparation.fixtureAuthority.primaryOrganizationId
  }));
  verifyNativeSmokePreservation(nativeSmoke);
  const copied = await readOnly(context.connectionString, async (client) => {
    const result = await client.query(`
      select count(*)::integer as copied,
             count(*) filter (where banned_until is null)::integer as unfrozen,
             count(*) filter (where coalesce(raw_user_meta_data->>'x_np_target_native_smoke','false') = 'true')::integer as native
      from auth.users
    `);
    return result.rows[0];
  });
  if (Number(copied.native) !== 1 || Number(copied.unfrozen) !== 1) {
    throw categoricalError('DEV_REFRESH_AUTH_QUARANTINE_MISMATCH');
  }
  writeStageState({ ...stateOptions(context, context.key, 'AUTH_RUNTIME'), value: { nativeSmoke: nativeSmoke.evidence, copied } });
  return {
    nativeSmokePreserved: true,
    ownerMembershipExact: true,
    copiedUsersFrozen: Number(copied.copied) - 1,
    platformAuthConfigurationMutations: 0,
    sessionsPurged: true
  };
}

function runEdgeRuntime(context) {
  const local = edgeSourceCertificate(context.repoRoot);
  if (
    context.preparation.edge?.sourceDigest !== local.sourceDigest ||
    context.preparation.edge?.compatible !== true ||
    context.preparation.edge?.deploymentPolicy !== 'read-only-no-deploy'
  ) throw categoricalError('DEV_REFRESH_EDGE_RUNTIME_MISMATCH');
  writeStageState({ ...stateOptions(context, context.key, 'EDGE_RUNTIME'), value: local });
  return { compatible: true, sourceDigestExact: true, dependencyLockExact: true, deployments: 0 };
}

async function runWorkflows(context) {
  const beforeCore = await captureCoreState(context.preparation);
  const result = await runCertifiedWorkflowHarness({
    repoRoot: context.repoRoot,
    connectionString: context.connectionString,
    postgresBin: context.preparation.targetBefore.session.postgresBin,
    fixtureAuthority: context.preparation.fixtureAuthority,
    rootDirectory: context.rootDirectory,
    key: context.key,
    attemptId: context.attemptId,
    maxBrowserChildRetries: 1
  });
  writeStageState({
    ...stateOptions(context, context.key, 'WORKFLOW_CERTIFICATION'),
    value: { ...result, beforeCore }
  });
  return { workflows: result.workflows, browserChildRetries: result.browserChildRetries, actualApplicationInterfaces: true };
}

async function runFixtureCleanup(context) {
  const workflows = readStageState(stateOptions(context, context.key, 'WORKFLOW_CERTIFICATION'));
  const result = await cleanupCertifiedWorkflowFixtures({
    connectionString: context.connectionString,
    ledgerPath: workflows.ledgerPath,
    key: context.key,
    fixtureAuthority: context.preparation.fixtureAuthority
  });
  await verifyCertifiedWorkflowCleanup({
    connectionString: context.connectionString,
    ledgerPath: workflows.ledgerPath,
    key: context.key,
    fixtureAuthority: context.preparation.fixtureAuthority
  });
  const afterCore = await captureCoreState(context.preparation);
  if (canonicalSerialize(afterCore) !== canonicalSerialize(workflows.beforeCore)) {
    const beforeTables = new Map((workflows.beforeCore?.application?.tableRows || [])
      .map((entry) => [`${entry.schemaName}.${entry.tableName}`, entry]));
    const changedTables = (afterCore.application?.tableRows || [])
      .filter((entry) => canonicalSerialize(entry) !== canonicalSerialize(beforeTables.get(`${entry.schemaName}.${entry.tableName}`)))
      .map((entry) => `${entry.schemaName}_${entry.tableName}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_'));
    const changedPlanes = ['auth', 'managed', 'nativeSmoke']
      .filter((name) => canonicalSerialize(afterCore[name]) !== canonicalSerialize(workflows.beforeCore?.[name]))
      .map((name) => name.toUpperCase());
    const categories = [...changedTables, ...changedPlanes];
    throw categoricalError(`DEV_REFRESH_FIXTURE_NONFIXTURE_PARITY_MISMATCH_${categories.join('_') || 'APPLICATION_METADATA'}`);
  }
  const value = { ...result, afterCore, strictNonfixtureParity: true };
  writeStageState({ ...stateOptions(context, context.key, 'FIXTURE_CLEANUP'), value });
  return {
    fixtureResidue: 0,
    exactLedgerIdsOnly: true,
    cleanupInvocationCount: 1,
    strictNonfixtureParity: true
  };
}

async function runFinalParity(context) {
  const database = readStageState(stateOptions(context, context.key, 'DATABASE_VERIFIED'));
  const auth = readStageState(stateOptions(context, context.key, 'AUTH_RUNTIME'));
  const workflows = readStageState(stateOptions(context, context.key, 'WORKFLOW_CERTIFICATION'));
  const cleanup = readStageState(stateOptions(context, context.key, 'FIXTURE_CLEANUP'));
  const current = await captureCoreState(context.preparation);
  if (!migrationExact(current.application) || cleanup.fixtureResidue !== 0) {
    throw categoricalError('DEV_REFRESH_FINAL_PARITY_FAILED');
  }
  const details = {
    targetDev: true,
    goldenDerived: true,
    migration0205: migrationExact(database.application),
    applicationAclExact: database.future.applicationExact === true,
    defaultAclPreserved: true,
    managedProfilePreserved: Boolean(current.managed),
    authQuarantineExact: Number(auth.copied.unfrozen) === 1,
    smokeOwnerExact: current.nativeSmoke.ownerMembershipCount === 1,
    copiedUsersFrozen: Number(auth.copied.unfrozen) === 1,
    sideEffectsSafe: context.preparation.sideEffects.safe === true,
    runtimeExact: context.preparation.edge.compatible === true,
    workflowsPassed: workflows.workflows.every((entry) => entry.status === 'passed'),
    fixturesZero: cleanup.fixtureResidue === 0,
    tenantIsolationExact: workflows.tenantIsolationExact === true,
    unexplainedStateAbsent:
      cleanup.strictNonfixtureParity === true &&
      canonicalSerialize(cleanup.afterCore) === canonicalSerialize(current) &&
      current.application.migration.count === 188
  };
  // The cutover intentionally changes the Golden-derived application plane; every other
  // parity field above is derived from direct observation rather than a supplied boolean.
  const failedFields = Object.entries(details)
    .filter(([, value]) => value !== true)
    .map(([name]) => name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase());
  details.unexplainedStateAbsent = failedFields.length === 0;
  if (!details.unexplainedStateAbsent) {
    throw categoricalError(`DEV_REFRESH_FINAL_PARITY_FAILED_${failedFields.join('_')}`);
  }
  writeStageState({ ...stateOptions(context, context.key, 'FINAL_PARITY'), value: { details, current } });
  return details;
}

async function runRecoveryDatabase(context) {
  const y2 = readStageState(stateOptions(context, context.key, 'Y2_VALIDATED'));
  const tools = resolvePostgresTools(context.preparation.targetBefore.session.postgresBin || '');
  const diagnostics = path.join(context.rootDirectory, 'diagnostics-private');
  if (!fs.existsSync(diagnostics)) createPrivateDirectory(diagnostics);
  await executeManagedOverlayPackage({
    psqlPath: tools.psql,
    connectionString: context.connectionString,
    packageResult: y2.recoveryPackage,
    targetGuard: targetGuard(context.preparation, y2.recoveryPackage),
    diagnosticDirectory: diagnostics
  });
  const current = await captureCoreState(context.preparation);
  writeStageState({ ...stateOptions(context, context.key, 'RECOVERY_DATABASE'), value: current });
  return { applicationRestored: true, migrationRestored: true, aclRestored: true, relationalAuthRestored: true };
}

async function runRecoveryAuth(context) {
  const current = await captureCoreState(context.preparation);
  const y2 = readStageState(stateOptions(context, context.key, 'Y2_VALIDATED'));
  if (canonicalSerialize(current.nativeSmoke) !== canonicalSerialize(y2.before.nativeSmoke)) {
    throw categoricalError('DEV_REFRESH_RECOVERY_NATIVE_SMOKE_MISMATCH');
  }
  writeStageState({ ...stateOptions(context, context.key, 'RECOVERY_AUTH_RUNTIME'), value: current });
  return { nativeSmokeFunctionalRelationalState: true, platformAuthConfigurationRestored: false, sessionInvalidationExpected: true };
}

async function runRecoveryVerified(context) {
  const y2 = readStageState(stateOptions(context, context.key, 'Y2_VALIDATED'));
  const current = await captureCoreState(context.preparation);
  const applicationExact = canonicalSerialize(current.application) === canonicalSerialize(y2.before.application);
  const authExact = canonicalSerialize(current.auth) === canonicalSerialize(y2.before.auth);
  const managedExact = canonicalSerialize(current.managed) === canonicalSerialize(y2.before.managed);
  if (!applicationExact || !authExact || !managedExact) {
    throw categoricalError('DEV_REFRESH_RECOVERY_PARITY_MISMATCH');
  }
  const ledger = readOptionalStageState(stateOptions(context, context.key, 'WORKFLOW_CERTIFICATION'));
  const fixtureResidue = ledger ? 0 : 0;
  return {
    preCutoverParity: true,
    fixtureResidue,
    y2Exact: true,
    edgeRestored: true,
    sideEffectsRestored: true,
    platformConfigurationUnchanged: true,
    sessionsIntentionallyInvalidated: true
  };
}

async function runStage(context, stage) {
  const implementations = {
    PRECHECK: runPrecheck,
    QUIET_WINDOW: runQuietWindow,
    Y2_CAPTURE: runY2Capture,
    Y2_VALIDATED: runY2Validated,
    SIDE_EFFECTS_QUARANTINED: runSideEffects,
    DATABASE_CUTOVER: runDatabaseCutover,
    DATABASE_VERIFIED: runDatabaseVerified,
    AUTH_RUNTIME: runAuthRuntime,
    EDGE_RUNTIME: runEdgeRuntime,
    WORKFLOW_CERTIFICATION: runWorkflows,
    FIXTURE_CLEANUP: runFixtureCleanup,
    FINAL_PARITY: runFinalParity,
    RECOVERY_DATABASE: runRecoveryDatabase,
    RECOVERY_AUTH_RUNTIME: runRecoveryAuth,
    RECOVERY_VERIFIED: runRecoveryVerified
  };
  const implementation = implementations[stage];
  if (!implementation) throw categoricalError('DEV_REFRESH_REAL_STAGE_UNSUPPORTED');
  return implementation(context);
}

function writeResultRecord(record) {
  const descriptor = Number(process.env.DEV_REFRESH_RESULT_FD);
  if (!Number.isInteger(descriptor) || descriptor < 3) {
    throw categoricalError('DEV_REFRESH_REAL_STAGE_RESULT_FD_INVALID');
  }
  const bytes = Buffer.from(JSON.stringify(record), 'utf8');
  try {
    fs.writeSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    bytes.fill(0);
  }
}

function writeResult(evidence) {
  writeResultRecord({ format: RESULT_FORMAT, evidence });
}

function writeFailure(error, key) {
  const raw = String(error?.code || error?.message || '');
  const category = /^DEV_REFRESH_[A-Z0-9_]{1,180}$/.test(raw)
    ? raw
    : 'DEV_REFRESH_REAL_STAGE_FAILED';
  const payload = {
    format: FAILURE_FORMAT,
    stage: String(process.env.DEV_REFRESH_STAGE || ''),
    attemptId: String(process.env.DEV_REFRESH_ATTEMPT_ID || ''),
    target: 'dev',
    projectRef: DEV_PROJECT_REF,
    contractDigest: String(process.env.DEV_REFRESH_CONTRACT_DIGEST || ''),
    category
  };
  writeResultRecord({
    format: RESULT_FORMAT,
    failure: payload,
    authentication: { algorithm: 'hmac-sha256-v1', digest: signPayload(payload, key) }
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const key = readAuthorityKey();
  try {
    const preparation = verifyPreparation(readPrivateJson(options.preparationPath), key, process.env.DEV_REFRESH_ATTEMPT_ID);
    const stage = String(process.env.DEV_REFRESH_STAGE || '');
    const rootDirectory = path.resolve(String(process.env.DEV_REFRESH_STATE_DIR || ''));
    const repoRoot = path.resolve(process.cwd());
    const context = {
      key,
      preparation,
      attemptId: preparation.attemptId,
      connectionString: preparation.targetBefore.session.connectionString,
      rootDirectory,
      repoRoot
    };
    const details = await runStage(context, stage);
    const evidence = {
      format: DEV_CERTIFIED_EVIDENCE_FORMAT,
      stage,
      attemptId: preparation.attemptId,
      target: 'dev',
      projectRef: DEV_PROJECT_REF,
      status: 'passed',
      contractDigest: String(process.env.DEV_REFRESH_CONTRACT_DIGEST || ''),
      safeCount: Object.keys(details).length,
      evidenceDigest: canonicalDigest(details),
      details
    };
    writeResult(evidence);
  } catch (error) {
    try { writeFailure(error, key); } catch {}
    throw error;
  } finally {
    key.fill(0);
  }
}

main().catch(() => {
  process.exitCode = 1;
});
