import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { canonicalDigest, canonicalSerialize } from '../readonly-diagnostics.mjs';
import {
  CANONICAL_APPLICATION_SOURCE_COMMIT,
  CANONICAL_APPLICATION_SOURCE_TREE,
  CERTIFIED_ENVIRONMENT_SYNC_ANCESTOR,
  CURRENT_APPLICATION_MIGRATION,
  GOLDEN_APPLICATION_SOURCE_COMMIT,
  GOLDEN_BASELINE_ID,
  GOLDEN_BASELINE_MIGRATION,
  GOLDEN_WORKFLOW_CONTRACT,
  POST_GOLDEN_MIGRATIONS
} from './constants.mjs';

const DEV_CERTIFIED_CONTRACT_FORMAT = 'dev-certified-refresh-contract-v1';
const DEV_CERTIFIED_EVIDENCE_FORMAT = 'dev-certified-stage-evidence-v1';
const DEV_PROJECT_REF = 'uxiltcpbhthhinonttrc';
const PROD_PROJECT_REF = 'tiwpulgvxtwlmqdnyuzd';
const SANDBOX_PROJECT_REF = 'xwpjtelnusojykunkjig';

const REFRESH_STAGES = Object.freeze([
  'PRECHECK',
  'QUIET_WINDOW',
  'Y2_CAPTURE',
  'Y2_VALIDATED',
  'MANIFESTS_FROZEN',
  'ATTEMPT_MARKED',
  'DESTRUCTIVE_BOUNDARY',
  'SIDE_EFFECTS_QUARANTINED',
  'DATABASE_CUTOVER',
  'DATABASE_VERIFIED',
  'AUTH_RUNTIME',
  'EDGE_RUNTIME',
  'WORKFLOW_CERTIFICATION',
  'FIXTURE_CLEANUP',
  'FINAL_PARITY',
  'COMPLETE'
]);

const RECOVERY_STAGES = Object.freeze([
  'RECOVERY_REQUIRED',
  'RECOVERY_STARTED',
  'RECOVERY_DATABASE',
  'RECOVERY_AUTH_RUNTIME',
  'RECOVERY_VERIFIED',
  'RECOVERED'
]);

const FAILURE_INJECTION_CASES = Object.freeze([
  ['A', 'target_guard_failure', 'PRECHECK'],
  ['B', 'golden_auth_digest_failure', 'PRECHECK'],
  ['C', 'quiet_window_failure', 'QUIET_WINDOW'],
  ['D', 'y2_capture_failure', 'Y2_CAPTURE'],
  ['E', 'y2_authentication_failure', 'Y2_VALIDATED'],
  ['F', 'y2_restore_test_failure', 'Y2_VALIDATED'],
  ['G', 'manifest_freeze_failure', 'MANIFESTS_FROZEN'],
  ['H', 'attempt_marker_interruption', 'ATTEMPT_MARKED'],
  ['I', 'side_effect_quarantine_failure', 'SIDE_EFFECTS_QUARANTINED'],
  ['J', 'database_replacement_precommit_failure', 'DATABASE_CUTOVER'],
  ['K', 'database_replacement_postcommit_failure', 'DATABASE_CUTOVER'],
  ['L', 'auth_runtime_failure', 'AUTH_RUNTIME'],
  ['M', 'migration_0203_failure', 'DATABASE_CUTOVER'],
  ['N', 'migration_0204_failure', 'DATABASE_CUTOVER'],
  ['O', 'migration_0205_failure', 'DATABASE_CUTOVER'],
  ['P', 'acl_verification_failure', 'DATABASE_VERIFIED'],
  ['Q', 'edge_runtime_failure', 'EDGE_RUNTIME'],
  ['R', 'workflow_certification_failure', 'WORKFLOW_CERTIFICATION'],
  ['S', 'fixture_cleanup_failure', 'FIXTURE_CLEANUP'],
  ['T', 'final_parity_failure', 'FINAL_PARITY'],
  ['U', 'process_crash_after_destructive_transition', 'DESTRUCTIVE_BOUNDARY']
].map(([id, name, stage]) => Object.freeze({ id, name, stage })));

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function sha256Bytes(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function assertSha256(value, code = 'DEV_REFRESH_DIGEST_INVALID') {
  if (!/^sha256:[0-9a-f]{64}$/.test(String(value || ''))) throw categoricalError(code);
  return value;
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim();
}

function verifyRepositoryLineage({ repoRoot, toolingCommit = 'HEAD' } = {}) {
  const root = path.resolve(repoRoot || '.');
  const resolvedToolingCommit = git(['rev-parse', `${toolingCommit}^{commit}`], root);
  const tree = git(['rev-parse', `${resolvedToolingCommit}^{tree}`], root);
  const canonicalTree = git(['rev-parse', `${CANONICAL_APPLICATION_SOURCE_COMMIT}^{tree}`], root);
  if (canonicalTree !== CANONICAL_APPLICATION_SOURCE_TREE) {
    throw categoricalError('DEV_REFRESH_CANONICAL_MAIN_TREE_MISMATCH');
  }
  for (const ancestor of [CERTIFIED_ENVIRONMENT_SYNC_ANCESTOR, CANONICAL_APPLICATION_SOURCE_COMMIT]) {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', ancestor, resolvedToolingCommit], {
        cwd: root,
        shell: false,
        windowsHide: true,
        stdio: 'ignore'
      });
    } catch {
      throw categoricalError('DEV_REFRESH_REQUIRED_ANCESTOR_MISSING');
    }
  }
  if (git(['status', '--short'], root)) throw categoricalError('DEV_REFRESH_WORKTREE_NOT_CLEAN');
  return {
    toolingCommit: resolvedToolingCommit,
    toolingTree: tree,
    canonicalMainCommit: CANONICAL_APPLICATION_SOURCE_COMMIT,
    canonicalMainTree: canonicalTree,
    certifiedToolingAncestor: CERTIFIED_ENVIRONMENT_SYNC_ANCESTOR
  };
}

function verifyPostGoldenMigrationBytes({ repoRoot } = {}) {
  const root = path.resolve(repoRoot || '.');
  const migrations = POST_GOLDEN_MIGRATIONS.map((migration) => {
    const backendPath = path.join(root, 'backend', 'migrations', migration.backendFile);
    const supabasePath = path.join(root, 'supabase', 'migrations', migration.supabaseFile);
    const backendBytes = fs.readFileSync(backendPath);
    const supabaseBytes = fs.readFileSync(supabasePath);
    try {
      const backendDigest = sha256Bytes(backendBytes);
      const supabaseDigest = sha256Bytes(supabaseBytes);
      if (
        backendDigest !== migration.digest ||
        supabaseDigest !== migration.digest ||
        !backendBytes.equals(supabaseBytes)
      ) {
        throw categoricalError('DEV_REFRESH_MIGRATION_BYTES_MISMATCH');
      }
      return { ...migration, bytes: backendBytes.length };
    } finally {
      backendBytes.fill(0);
      supabaseBytes.fill(0);
    }
  });
  return { migrations, count: migrations.length, ordered: true };
}

function assertGoldenManifestIdentity(manifest = {}) {
  if (
    manifest.format !== 'golden-prod-baseline-manifest-v1' ||
    manifest.baselineId !== GOLDEN_BASELINE_ID ||
    manifest.sourceCommit !== GOLDEN_APPLICATION_SOURCE_COMMIT ||
    manifest.migration?.count !== GOLDEN_BASELINE_MIGRATION.count ||
    manifest.migration?.tip !== GOLDEN_BASELINE_MIGRATION.tip ||
    manifest.authentication?.algorithm !== 'hmac-sha256-v1'
  ) {
    throw categoricalError('DEV_REFRESH_GOLDEN_IDENTITY_MISMATCH');
  }
  return {
    baselineId: manifest.baselineId,
    sourceCommit: manifest.sourceCommit,
    migration: manifest.migration,
    manifestDigest: canonicalDigest(manifest)
  };
}

function buildCertifiedRefreshContract({
  attemptId,
  toolingCommit,
  toolingTree,
  goldenManifestDigest,
  currentDevProfileDigest,
  operationInventoryDigest
} = {}) {
  if (!/^[a-z0-9][a-z0-9-]{15,95}$/.test(String(attemptId || ''))) {
    throw categoricalError('DEV_REFRESH_ATTEMPT_ID_INVALID');
  }
  for (const [value, code] of [
    [goldenManifestDigest, 'DEV_REFRESH_GOLDEN_DIGEST_INVALID'],
    [currentDevProfileDigest, 'DEV_REFRESH_DEV_PROFILE_DIGEST_INVALID'],
    [operationInventoryDigest, 'DEV_REFRESH_OPERATION_INVENTORY_DIGEST_INVALID']
  ]) assertSha256(value, code);
  if (!/^[0-9a-f]{40}$/.test(String(toolingCommit || '')) || !/^[0-9a-f]{40}$/.test(String(toolingTree || ''))) {
    throw categoricalError('DEV_REFRESH_TOOLING_IDENTITY_INVALID');
  }
  const contract = {
    format: DEV_CERTIFIED_CONTRACT_FORMAT,
    version: 1,
    attemptId,
    target: { environment: 'dev', projectRef: DEV_PROJECT_REF },
    rejectedProjectRefs: [PROD_PROJECT_REF, SANDBOX_PROJECT_REF],
    source: {
      goldenBaselineId: GOLDEN_BASELINE_ID,
      goldenSourceCommit: GOLDEN_APPLICATION_SOURCE_COMMIT,
      goldenMigration: GOLDEN_BASELINE_MIGRATION,
      goldenManifestDigest
    },
    candidate: {
      canonicalMainCommit: CANONICAL_APPLICATION_SOURCE_COMMIT,
      canonicalMainTree: CANONICAL_APPLICATION_SOURCE_TREE,
      certifiedToolingAncestor: CERTIFIED_ENVIRONMENT_SYNC_ANCESTOR,
      toolingCommit,
      toolingTree
    },
    targetBefore: {
      migration: CURRENT_APPLICATION_MIGRATION,
      profileDigest: currentDevProfileDigest,
      permanentSmokeRole: 'owner'
    },
    postGoldenMigrations: POST_GOLDEN_MIGRATIONS,
    operationInventoryDigest,
    refreshStages: REFRESH_STAGES,
    recoveryStages: RECOVERY_STAGES,
    workflows: GOLDEN_WORKFLOW_CONTRACT.map((name, index) => ({ order: index + 1, name })),
    fixtureAuthority: {
      target: 'dev',
      exactManifestOnly: true,
      exactIdsOnly: true,
      oneShotCleanup: true,
      discoveryAddedTargets: false
    },
    destructiveResumeAllowed: false
  };
  return { ...contract, contractDigest: canonicalDigest(contract) };
}

function authenticateCertifiedRefreshContract(contract, key) {
  if (!Buffer.isBuffer(key) || key.length < 32) throw categoricalError('DEV_REFRESH_CONTRACT_KEY_INVALID');
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

function verifyAuthenticatedCertifiedRefreshContract(record, key) {
  const expected = authenticateCertifiedRefreshContract(record?.contract, key);
  const left = Buffer.from(String(expected.authentication.digest));
  const right = Buffer.from(String(record?.authentication?.digest || ''));
  try {
    if (
      record?.authentication?.algorithm !== 'hmac-sha256-v1' ||
      left.length !== right.length || !crypto.timingSafeEqual(left, right)
    ) throw categoricalError('DEV_REFRESH_CONTRACT_AUTHENTICATION_FAILED');
  } finally {
    left.fill(0);
    right.fill(0);
  }
  return verifyCertifiedRefreshContract(record.contract);
}

function verifyCertifiedRefreshContract(contract = {}) {
  if (contract.format !== DEV_CERTIFIED_CONTRACT_FORMAT || contract.version !== 1) {
    throw categoricalError('DEV_REFRESH_CONTRACT_FORMAT_INVALID');
  }
  const rebuilt = buildCertifiedRefreshContract({
    attemptId: contract.attemptId,
    toolingCommit: contract.candidate?.toolingCommit,
    toolingTree: contract.candidate?.toolingTree,
    goldenManifestDigest: contract.source?.goldenManifestDigest,
    currentDevProfileDigest: contract.targetBefore?.profileDigest,
    operationInventoryDigest: contract.operationInventoryDigest
  });
  if (canonicalSerialize(rebuilt) !== canonicalSerialize(contract)) {
    throw categoricalError('DEV_REFRESH_CONTRACT_MISMATCH');
  }
  return contract;
}

function assertStageEvidence(evidence = {}, { contract, stage } = {}) {
  if (
    evidence.format !== DEV_CERTIFIED_EVIDENCE_FORMAT ||
    evidence.stage !== stage ||
    evidence.attemptId !== contract?.attemptId ||
    evidence.target !== 'dev' ||
    evidence.projectRef !== DEV_PROJECT_REF ||
    evidence.status !== 'passed' ||
    evidence.contractDigest !== contract?.contractDigest ||
    !Number.isSafeInteger(evidence.safeCount) || evidence.safeCount < 0 ||
    !/^sha256:[0-9a-f]{64}$/.test(String(evidence.evidenceDigest || ''))
  ) {
    throw categoricalError(`DEV_REFRESH_${String(stage || 'UNKNOWN')}_EVIDENCE_INVALID`);
  }
  if (stage === 'DATABASE_CUTOVER') {
    const observed = evidence.details?.migrations || [];
    if (canonicalSerialize(observed) !== canonicalSerialize(POST_GOLDEN_MIGRATIONS.map(({ id, version, digest }) => ({ id, version, digest })))) {
      throw categoricalError('DEV_REFRESH_DATABASE_CUTOVER_MIGRATION_SEQUENCE_INVALID');
    }
  }
  if (stage === 'WORKFLOW_CERTIFICATION') {
    const workflows = evidence.details?.workflows || [];
    if (
      workflows.length !== GOLDEN_WORKFLOW_CONTRACT.length ||
      workflows.some((entry, index) => entry.name !== GOLDEN_WORKFLOW_CONTRACT[index] || entry.status !== 'passed')
    ) {
      throw categoricalError('DEV_REFRESH_WORKFLOW_CERTIFICATION_INCOMPLETE');
    }
  }
  if (stage === 'FIXTURE_CLEANUP' && evidence.details?.fixtureResidue !== 0) {
    throw categoricalError('DEV_REFRESH_FIXTURE_RESIDUE_NONZERO');
  }
  if (stage === 'FINAL_PARITY') {
    const required = [
      'targetDev', 'goldenDerived', 'migration0205', 'applicationAclExact',
      'defaultAclPreserved', 'managedProfilePreserved', 'authQuarantineExact',
      'smokeOwnerExact', 'copiedUsersFrozen', 'sideEffectsSafe', 'runtimeExact',
      'workflowsPassed', 'fixturesZero', 'tenantIsolationExact', 'unexplainedStateAbsent'
    ];
    if (required.some((name) => evidence.details?.[name] !== true)) {
      throw categoricalError('DEV_REFRESH_FINAL_PARITY_INCOMPLETE');
    }
  }
  return evidence;
}

export {
  DEV_CERTIFIED_CONTRACT_FORMAT,
  DEV_CERTIFIED_EVIDENCE_FORMAT,
  DEV_PROJECT_REF,
  FAILURE_INJECTION_CASES,
  PROD_PROJECT_REF,
  RECOVERY_STAGES,
  REFRESH_STAGES,
  SANDBOX_PROJECT_REF,
  assertGoldenManifestIdentity,
  assertSha256,
  assertStageEvidence,
  authenticateCertifiedRefreshContract,
  buildCertifiedRefreshContract,
  sha256Bytes,
  verifyCertifiedRefreshContract,
  verifyAuthenticatedCertifiedRefreshContract,
  verifyPostGoldenMigrationBytes,
  verifyRepositoryLineage
};
