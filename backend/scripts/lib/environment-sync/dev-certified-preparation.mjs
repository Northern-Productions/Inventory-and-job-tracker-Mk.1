import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { canonicalDigest, canonicalSerialize } from '../readonly-diagnostics.mjs';
import { buildMutationTargetReport, loadEnvFile } from '../target-env-guards.mjs';
import {
  DEV_PROJECT_REF,
  assertGoldenManifestIdentity,
  authenticateCertifiedRefreshContract,
  buildCertifiedRefreshContract,
  sha256Bytes,
  verifyAuthenticatedCertifiedRefreshContract,
  verifyPostGoldenMigrationBytes,
  verifyRepositoryLineage
} from './dev-certified-contract.mjs';
import {
  REQUIRED_OPERATION_STAGES,
  authenticateOperationInventory,
  buildOperationInventory,
  verifyOperationInventory
} from './dev-certified-operation-executor.mjs';
import {
  CANONICAL_APPLICATION_SOURCE_COMMIT,
  CANONICAL_APPLICATION_SOURCE_TREE,
  CERTIFIED_ENVIRONMENT_SYNC_ANCESTOR,
  CURRENT_APPLICATION_MIGRATION,
  GOLDEN_WORKFLOW_CONTRACT,
  POST_GOLDEN_MIGRATIONS,
  SIDE_EFFECT_POLICY_VERSION
} from './constants.mjs';
import {
  runManagedRestoreCompatibilityRehearsal,
  prepareGoldenManagedOverlayForTarget
} from './managed-restore-rehearsal.mjs';
import { materializeRetainedGolden } from './retained-golden.mjs';
import {
  createPrivateDirectory,
  privateArtifactPath,
  verifyPrivateArtifactProtection,
  writePrivateJsonExclusive
} from './private-artifacts.mjs';
import { signPayload } from './dev-certified-state.mjs';

const { Client } = pg;
const PREPARATION_FORMAT = 'dev-certified-preparation-v1';
const REAL_STAGE_WORKER = fileURLToPath(new URL('./dev-certified-real-stage-worker.mjs', import.meta.url));
const SYNTHETIC_STAGE_WORKER = fileURLToPath(new URL('./dev-certified-test-worker.mjs', import.meta.url));
const REAL_STAGE_WORKER_REPO_PATH = 'backend/scripts/lib/environment-sync/dev-certified-real-stage-worker.mjs';
const SYNTHETIC_STAGE_WORKER_REPO_PATH = 'backend/scripts/lib/environment-sync/dev-certified-test-worker.mjs';
const FIXTURE_ENTITY_LIMITS = Object.freeze({
  access_request: 4,
  allocation: 20,
  audit_row: 128,
  box: 16,
  box_alias: 16,
  box_transfer: 4,
  caulk_allocation: 4,
  caulk_checkout: 4,
  caulk_manufacturer: 2,
  caulk_product: 2,
  caulk_stock: 4,
  caulk_transaction: 16,
  dealer: 12,
  film_catalog: 6,
  film_order: 4,
  film_order_event: 16,
  film_order_link: 4,
  film_weight_pending_review: 4,
  film_weight_sample: 4,
  general_permission: 8,
  job: 12,
  job_caulk_requirement: 8,
  job_phase: 12,
  job_requirement: 16,
  membership: 4,
  organization: 1,
  organization_preference: 1,
  organization_preference_restore: 1,
  owner_notification_preference_restore: 1,
  owner_company: 4,
  planner_suppression: 32,
  preference: 4,
  preference_restore: 1,
  roll_history: 32,
  team_audit: 16,
  temporary_auth_identity: 1,
  temporary_auth_user: 1,
  warehouse: 2
});

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

function readAuthorityKey(filePath) {
  verifyPrivateArtifactProtection(filePath);
  const bytes = fs.readFileSync(filePath);
  let key;
  try {
    if (bytes.length === 32) key = Buffer.from(bytes);
    else {
      const text = bytes.toString('utf8').trim();
      if (/^[0-9a-f]{64}$/i.test(text)) key = Buffer.from(text, 'hex');
    }
  } finally {
    bytes.fill(0);
  }
  if (!key || key.length !== 32) throw categoricalError('DEV_REFRESH_AUTHORITY_KEY_INVALID');
  return key;
}

function edgeSourceCertificate(repoRoot) {
  const paths = execFileSync(
    'git',
    ['ls-tree', '-r', '--name-only', CANONICAL_APPLICATION_SOURCE_COMMIT, '--', 'supabase/functions'],
    { cwd: repoRoot, encoding: 'utf8', shell: false, windowsHide: true }
  ).trim().split(/\r?\n/).filter(Boolean).sort();
  const entries = paths.map((filePath) => {
    const bytes = execFileSync('git', ['show', `${CANONICAL_APPLICATION_SOURCE_COMMIT}:${filePath}`], {
      cwd: repoRoot,
      shell: false,
      windowsHide: true,
      encoding: null,
      maxBuffer: 32 * 1024 * 1024
    });
    try {
      return { path: filePath, size: bytes.length, digest: sha256Bytes(bytes) };
    } finally {
      bytes.fill(0);
    }
  });
  const lock = entries.find((entry) => entry.path === 'supabase/functions/api/deno.lock');
  if (!lock) throw categoricalError('DEV_REFRESH_EDGE_LOCK_MISSING');
  return {
    format: 'dev-certified-edge-source-v1',
    commit: CANONICAL_APPLICATION_SOURCE_COMMIT,
    sourceFileCount: entries.length,
    sourceDigest: canonicalDigest(entries),
    lockDigest: lock.digest,
    deploymentPolicy: 'read-only-no-deploy'
  };
}

function disposableSideEffectCertificate() {
  return {
    format: 'dev-certified-side-effect-observation-v1',
    policyVersion: SIDE_EFFECT_POLICY_VERSION,
    target: 'dev',
    observed: {
      authEmailMode: 'disabled',
      smsMode: 'disabled',
      nonproductionUrls: true,
      forbiddenVendorSecrets: 0,
      cronJobs: 0,
      networkCallers: 0,
      webhooks: 0,
      foreignResources: 0,
      productionStorageOrVaultReferences: 0,
      signupPostureApproved: true
    },
    safe: true,
    mutationAllowed: false
  };
}

function authenticatePreparation(preparation, key) {
  return {
    preparation,
    authentication: { algorithm: 'hmac-sha256-v1', digest: signPayload(preparation, key) }
  };
}

function verifyPreparationEnvelope(record, key, expectedAttemptId = '') {
  const preparation = record?.preparation;
  if (
    record?.authentication?.algorithm !== 'hmac-sha256-v1' ||
    record.authentication.digest !== signPayload(preparation, key) ||
    preparation?.format !== PREPARATION_FORMAT ||
    preparation?.target?.environment !== 'dev' ||
    preparation?.target?.projectRef !== DEV_PROJECT_REF ||
    (expectedAttemptId && preparation.attemptId !== expectedAttemptId) ||
    preparation?.fixtureAuthority?.cleanupAuthority !== 'exact-authenticated-ledger-only' ||
    preparation?.sideEffects?.mutationAllowed !== false ||
    preparation?.edge?.deploymentPolicy !== 'read-only-no-deploy'
  ) throw categoricalError('DEV_REFRESH_PREPARATION_INVALID');
  return preparation;
}

function verifyPreparation(record, key, expectedAttemptId = '') {
  const preparation = verifyPreparationEnvelope(record, key, expectedAttemptId);
  if (
    preparation?.stageWorker?.path !== path.resolve(REAL_STAGE_WORKER) ||
    preparation?.stageWorker?.digest !== digestFile(REAL_STAGE_WORKER) ||
    preparation?.stageWorker?.digest === digestFile(SYNTHETIC_STAGE_WORKER)
  ) throw categoricalError('DEV_REFRESH_PREPARATION_INVALID');
  return preparation;
}

function gitValue(repoRoot, args, code) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    throw categoricalError(code);
  }
}

function gitFileBytes(repoRoot, commit, repoPath) {
  try {
    return execFileSync('git', ['show', `${commit}:${repoPath}`], {
      cwd: repoRoot,
      encoding: null,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch {
    throw categoricalError('DEV_REFRESH_HISTORICAL_WORKER_SOURCE_MISSING');
  }
}

function assertGitAncestor(repoRoot, ancestor, descendant, code) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: repoRoot,
      shell: false,
      windowsHide: true,
      stdio: 'ignore'
    });
  } catch {
    throw categoricalError(code);
  }
}

function verifyHistoricalPreparation({
  preparationRecord,
  contractRecord,
  inventoryRecord,
  key,
  repoRoot,
  currentToolingCommit,
  expectedAttemptId = ''
} = {}) {
  const root = path.resolve(repoRoot || '.');
  const preparation = verifyPreparationEnvelope(preparationRecord, key, expectedAttemptId);
  const contract = verifyAuthenticatedCertifiedRefreshContract(contractRecord, key);
  const inventory = inventoryRecord?.inventory;
  const historicalCommit = String(preparation?.candidate?.toolingCommit || '');
  const historicalTree = String(preparation?.candidate?.toolingTree || '');
  const currentCommit = String(currentToolingCommit || '');
  if (
    !/^[0-9a-f]{40}$/.test(historicalCommit) || !/^[0-9a-f]{40}$/.test(historicalTree) ||
    !/^[0-9a-f]{40}$/.test(currentCommit) ||
    preparation.stageWorker?.path !== path.resolve(root, REAL_STAGE_WORKER_REPO_PATH) ||
    canonicalSerialize(preparation.candidate) !== canonicalSerialize(contract.candidate) ||
    contract.attemptId !== preparation.attemptId ||
    (preparation.contractDigest && preparation.contractDigest !== contract.contractDigest)
  ) throw categoricalError('DEV_REFRESH_HISTORICAL_LINEAGE_INVALID');

  const resolvedHistoricalCommit = gitValue(
    root, ['rev-parse', `${historicalCommit}^{commit}`], 'DEV_REFRESH_HISTORICAL_COMMIT_MISSING'
  );
  const resolvedHistoricalTree = gitValue(
    root, ['rev-parse', `${historicalCommit}^{tree}`], 'DEV_REFRESH_HISTORICAL_TREE_MISSING'
  );
  const resolvedCurrentCommit = gitValue(
    root, ['rev-parse', `${currentCommit}^{commit}`], 'DEV_REFRESH_CURRENT_TOOLING_COMMIT_MISSING'
  );
  if (
    resolvedHistoricalCommit !== historicalCommit || resolvedHistoricalTree !== historicalTree ||
    preparation.candidate?.canonicalMainCommit !== CANONICAL_APPLICATION_SOURCE_COMMIT ||
    preparation.candidate?.canonicalMainTree !== CANONICAL_APPLICATION_SOURCE_TREE ||
    preparation.candidate?.certifiedToolingAncestor !== CERTIFIED_ENVIRONMENT_SYNC_ANCESTOR
  ) throw categoricalError('DEV_REFRESH_HISTORICAL_LINEAGE_INVALID');
  assertGitAncestor(root, CANONICAL_APPLICATION_SOURCE_COMMIT, historicalCommit, 'DEV_REFRESH_HISTORICAL_ANCESTOR_INVALID');
  assertGitAncestor(root, CERTIFIED_ENVIRONMENT_SYNC_ANCESTOR, historicalCommit, 'DEV_REFRESH_HISTORICAL_ANCESTOR_INVALID');
  assertGitAncestor(root, historicalCommit, resolvedCurrentCommit, 'DEV_REFRESH_HISTORICAL_SUCCESSOR_INVALID');

  const historicalWorkerBytes = gitFileBytes(root, historicalCommit, REAL_STAGE_WORKER_REPO_PATH);
  const historicalSyntheticBytes = gitFileBytes(root, historicalCommit, SYNTHETIC_STAGE_WORKER_REPO_PATH);
  try {
    const historicalWorkerDigest = sha256Bytes(historicalWorkerBytes);
    const historicalSyntheticDigest = sha256Bytes(historicalSyntheticBytes);
    if (
      preparation.stageWorker?.digest !== historicalWorkerDigest ||
      preparation.stageWorker?.syntheticWorkerDigest !== historicalSyntheticDigest ||
      historicalWorkerDigest === historicalSyntheticDigest ||
      inventoryRecord?.authentication?.algorithm !== 'hmac-sha256-v1' ||
      inventoryRecord.authentication.digest !== signPayload(inventory, key)
    ) throw categoricalError('DEV_REFRESH_HISTORICAL_WORKER_INVALID');
    const rebuiltInventory = buildOperationInventory({
      attemptId: inventory?.attemptId,
      envFileDigest: inventory?.envFileDigest,
      operations: inventory?.operations
    });
    if (
      canonicalSerialize(rebuiltInventory) !== canonicalSerialize(inventory) ||
      rebuiltInventory.attemptId !== contract.attemptId ||
      rebuiltInventory.inventoryDigest !== contract.operationInventoryDigest ||
      rebuiltInventory.operations.some((operation) =>
        operation.runtime !== 'node' ||
        operation.script !== preparation.stageWorker.path ||
        operation.scriptDigest !== historicalWorkerDigest)
    ) throw categoricalError('DEV_REFRESH_HISTORICAL_INVENTORY_INVALID');
    const provenance = {
      format: 'dev-refresh-historical-provenance-v1',
      digestScope: 'exact-git-blob-sha256-v1',
      toolingCommit: historicalCommit,
      toolingTree: historicalTree,
      canonicalMainCommit: CANONICAL_APPLICATION_SOURCE_COMMIT,
      canonicalMainTree: CANONICAL_APPLICATION_SOURCE_TREE,
      certifiedToolingAncestor: CERTIFIED_ENVIRONMENT_SYNC_ANCESTOR,
      workerRepoPath: REAL_STAGE_WORKER_REPO_PATH,
      workerDigest: historicalWorkerDigest,
      syntheticWorkerDigest: historicalSyntheticDigest,
      operationInventoryDigest: rebuiltInventory.inventoryDigest,
      refreshContractDigest: contract.contractDigest,
      originalPreparationDigest: canonicalDigest(preparationRecord)
    };
    return {
      preparation,
      contract,
      inventory: rebuiltInventory,
      provenance: { ...provenance, provenanceDigest: canonicalDigest(provenance) }
    };
  } finally {
    historicalWorkerBytes.fill(0);
    historicalSyntheticBytes.fill(0);
  }
}

function loadMigrations(repoRoot) {
  return POST_GOLDEN_MIGRATIONS.map((migration) => ({
    version: migration.version,
    sql: fs.readFileSync(path.join(repoRoot, 'backend', 'migrations', migration.backendFile), 'utf8')
  }));
}

async function captureLiveNativeSmoke(connectionString, email) {
  const client = new Client({ connectionString, application_name: 'dev-refresh-preparation-readonly' });
  await client.connect();
  let began = false;
  try {
    await client.query('begin isolation level repeatable read read only');
    began = true;
    const proof = await client.query("select current_setting('transaction_read_only') as read_only");
    if (proof.rows[0]?.read_only !== 'on') throw categoricalError('DEV_REFRESH_PREPARATION_READ_ONLY_UNPROVEN');
    const result = await client.query(
      `select u.id::text as user_id, m.org_id::text as organization_id
         from auth.users u
         join app.organization_members m on m.user_id = u.id
        where lower(u.email) = lower($1::text) and m.role = 'owner' and m.status = 'active'
        order by m.org_id`,
      [email]
    );
    if (result.rows.length !== 1) throw categoricalError('DEV_REFRESH_NATIVE_SMOKE_OWNER_AMBIGUOUS');
    await client.query('rollback');
    began = false;
    return result.rows[0];
  } finally {
    if (began) await client.query('rollback').catch(() => {});
    await client.end().catch(() => {});
  }
}

function exactDatabaseUrl(values) {
  const candidates = ['DEV_DATABASE_URL', 'DATABASE_URL', 'SUPABASE_DB_URL']
    .map((name) => String(values[name] || '').trim()).filter(Boolean);
  if (candidates.length === 0 || new Set(candidates).size !== 1) {
    throw categoricalError('DEV_REFRESH_DATABASE_URL_AMBIGUOUS');
  }
  return candidates[0];
}

async function prepareCertifiedDevRefresh({
  repoRoot,
  envFilePath,
  authorityKeyPath,
  retainedRoot,
  outputDirectory,
  disposable = false,
  sideEffectCertificatePath = '',
  edgeCertificatePath = '',
  postgresBin = ''
} = {}) {
  const root = path.resolve(repoRoot);
  const output = createPrivateDirectory(path.resolve(outputDirectory));
  const materializedDirectory = createPrivateDirectory(path.join(output, 'materialized-private'));
  const packageDirectory = createPrivateDirectory(path.join(output, 'managed-package-private'));
  const key = readAuthorityKey(authorityKeyPath);
  let retained;
  try {
    const lineage = verifyRepositoryLineage({ repoRoot: root });
    verifyPostGoldenMigrationBytes({ repoRoot: root });
    const envBytes = fs.readFileSync(envFilePath);
    let envFileDigest;
    try {
      envFileDigest = sha256Bytes(envBytes);
    } finally {
      envBytes.fill(0);
    }
    const attemptId = `dev-refresh-${new Date().toISOString().replace(/\D/g, '').slice(0, 17)}-${crypto.randomBytes(8).toString('hex')}`;
    retained = materializeRetainedGolden({ retainedRoot, privateDirectory: materializedDirectory });
    const goldenIdentity = assertGoldenManifestIdentity(retained.manifest);
    const migrations = loadMigrations(root);
    let targetSession;
    let sideEffects;
    let edge;
    if (disposable) {
      const rehearsal = await runManagedRestoreCompatibilityRehearsal({
        archivePath: retained.archivePath,
        sourceComponent: retained.components.encryptedArchive,
        postOverlayMigrations: migrations,
        preserveNativeSmokeRelationalState: true,
        retainDisposableTarget: true,
        postgresBin,
        temporaryParent: os.tmpdir()
      });
      targetSession = rehearsal.disposableSession;
      if (!targetSession) throw categoricalError('DEV_REFRESH_DISPOSABLE_SESSION_MISSING');
      sideEffects = disposableSideEffectCertificate();
      edge = { ...edgeSourceCertificate(root), compatible: true, observedReadOnly: true };
    } else {
      const loaded = loadEnvFile(envFilePath);
      const guard = buildMutationTargetReport({
        envPath: loaded.path,
        envValues: loaded.values,
        requestedTarget: 'dev',
        allowProd: false,
        linked: false,
        linkedRef: ''
      });
      if (!guard.ok || guard.expected.ref !== DEV_PROJECT_REF) {
        throw categoricalError('DEV_REFRESH_TARGET_GUARD_FAILED');
      }
      const connectionString = exactDatabaseUrl(loaded.values);
      const email = String(loaded.values.SMOKE_USER_EMAIL || '').trim();
      if (!email) throw categoricalError('DEV_REFRESH_NATIVE_SMOKE_EMAIL_MISSING');
      const nativeSmoke = await captureLiveNativeSmoke(connectionString, email);
      const prepared = await prepareGoldenManagedOverlayForTarget({
        archivePath: retained.archivePath,
        sourceComponent: retained.components.encryptedArchive,
        targetConnectionString: connectionString,
        target: { environment: 'dev', projectRef: DEV_PROJECT_REF },
        authorityKey: key,
        privateDirectory: packageDirectory,
        nativeSmoke: { userId: nativeSmoke.user_id, organizationId: nativeSmoke.organization_id },
        postgresBin
      });
      targetSession = {
        connectionString,
        postgresBin,
        smokeUserId: nativeSmoke.user_id,
        smokeOrganizationId: nativeSmoke.organization_id,
        devRefreshPackage: prepared.packageResult,
        nativePreservation: prepared.nativePreservation,
        targetCatalog: prepared.targetCatalog,
        sourceAuth: prepared.sourceAuth,
        currentApplication: null
      };
      sideEffects = readPrivateJson(path.resolve(sideEffectCertificatePath));
      edge = readPrivateJson(path.resolve(edgeCertificatePath));
      if (sideEffects?.safe !== true || sideEffects?.mutationAllowed !== false) {
        throw categoricalError('DEV_REFRESH_SIDE_EFFECT_CERTIFICATE_INVALID');
      }
      if (
        edge?.compatible !== true || edge?.deploymentPolicy !== 'read-only-no-deploy' ||
        edge?.sourceDigest !== edgeSourceCertificate(root).sourceDigest
      ) throw categoricalError('DEV_REFRESH_EDGE_CERTIFICATE_INVALID');
    }
    fs.rmSync(retained.archivePath, { force: false });
    retained.archivePath = '';
    const stageWorker = {
      path: path.resolve(REAL_STAGE_WORKER),
      digest: digestFile(REAL_STAGE_WORKER),
      syntheticWorkerDigest: digestFile(SYNTHETIC_STAGE_WORKER),
      syntheticWorkerAllowed: false
    };
    const fixtureAuthority = {
      target: 'dev',
      projectRef: DEV_PROJECT_REF,
      attemptId,
      smokeActorId: targetSession.smokeUserId,
      primaryOrganizationId: targetSession.smokeOrganizationId,
      temporaryCrossOrganizationAllowed: true,
      workflows: [...GOLDEN_WORKFLOW_CONTRACT],
      entityLimits: FIXTURE_ENTITY_LIMITS,
      cleanupAuthority: 'exact-authenticated-ledger-only',
      discoveryAddedTargets: false,
      candidateCommit: lineage.canonicalMainCommit
    };
    const preparation = {
      format: PREPARATION_FORMAT,
      version: 1,
      attemptId,
      mode: disposable ? 'disposable-managed-local' : 'managed-dev',
      target: { environment: 'dev', projectRef: DEV_PROJECT_REF },
      candidate: lineage,
      golden: {
        identity: goldenIdentity,
        components: retained.components
      },
      targetBefore: {
        migration: CURRENT_APPLICATION_MIGRATION,
        session: targetSession
      },
      postGoldenMigrations: POST_GOLDEN_MIGRATIONS,
      sideEffects,
      edge,
      fixtureAuthority,
      stageWorker,
      platformMutationPolicy: {
        edgeDeploy: false,
        sideEffectConfiguration: false,
        authConfiguration: false
      },
      sessionInvalidationExpectedOnRecovery: true
    };
    const preparationPath = privateArtifactPath(output, 'preparation.private.json');
    writePrivateJsonExclusive(preparationPath, authenticatePreparation(preparation, key));
    verifyPreparation(readPrivateJson(preparationPath), key, attemptId);

    const operations = REQUIRED_OPERATION_STAGES.map((stage) => ({
      stage,
      runtime: 'node',
      executable: process.execPath,
      executableDigest: digestFile(process.execPath),
      script: stageWorker.path,
      scriptDigest: stageWorker.digest,
      cwd: root,
      args: ['--preparation', preparationPath],
      environmentNames: [],
      timeoutMs: stage === 'WORKFLOW_CERTIFICATION' ? 45 * 60 * 1000 : 30 * 60 * 1000
    }));
    const unsignedInventory = buildOperationInventory({ attemptId, envFileDigest, operations });
    const contract = buildCertifiedRefreshContract({
      attemptId,
      toolingCommit: lineage.toolingCommit,
      toolingTree: lineage.toolingTree,
      goldenManifestDigest: goldenIdentity.manifestDigest,
      currentDevProfileDigest: canonicalDigest({
        targetCatalog: targetSession.targetCatalog,
        nativePreservation: targetSession.nativePreservation,
        sideEffects,
        edge
      }),
      operationInventoryDigest: unsignedInventory.inventoryDigest
    });
    const contractPath = privateArtifactPath(output, 'contract.private.json');
    const inventoryPath = privateArtifactPath(output, 'operation-inventory.private.json');
    writePrivateJsonExclusive(contractPath, authenticateCertifiedRefreshContract(contract, key));
    writePrivateJsonExclusive(inventoryPath, authenticateOperationInventory(unsignedInventory, key));
    verifyAuthenticatedCertifiedRefreshContract(readPrivateJson(contractPath), key);
    verifyOperationInventory(readPrivateJson(inventoryPath), key, contract, envFilePath);
    return {
      classification: 'DEV_REFRESH_PREPARATION_COMPLETE',
      attemptId,
      target: 'dev',
      realStageCount: operations.length,
      syntheticWorkerAbsent: operations.every((entry) => entry.scriptDigest !== stageWorker.syntheticWorkerDigest),
      output: { preparationPath, contractPath, inventoryPath },
      disposable
    };
  } catch (error) {
    if (retained?.archivePath && fs.existsSync(retained.archivePath)) {
      fs.rmSync(retained.archivePath, { force: true });
    }
    throw error;
  } finally {
    key.fill(0);
  }
}

export {
  FIXTURE_ENTITY_LIMITS,
  PREPARATION_FORMAT,
  REAL_STAGE_WORKER,
  REAL_STAGE_WORKER_REPO_PATH,
  authenticatePreparation,
  edgeSourceCertificate,
  prepareCertifiedDevRefresh,
  readAuthorityKey,
  verifyHistoricalPreparation,
  verifyPreparation
};
