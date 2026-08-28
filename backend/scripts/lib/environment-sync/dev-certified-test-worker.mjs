import crypto from 'node:crypto';
import fs from 'node:fs';

import { canonicalDigest } from '../readonly-diagnostics.mjs';
import {
  DEV_CERTIFIED_EVIDENCE_FORMAT,
  DEV_PROJECT_REF,
  buildCertifiedRefreshContract
} from './dev-certified-contract.mjs';
import { runCertifiedDevRefresh } from './dev-certified-orchestrator.mjs';
import { buildOperationFailure } from './dev-certified-operation-failure.mjs';
import { signPayload } from './dev-certified-state.mjs';
import { GOLDEN_WORKFLOW_CONTRACT, POST_GOLDEN_MIGRATIONS } from './constants.mjs';

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex')}`;
}

function contract(attemptId, operationInventoryDigest = digest('operations')) {
  return buildCertifiedRefreshContract({
    attemptId,
    toolingCommit: 'a'.repeat(40),
    toolingTree: 'b'.repeat(40),
    goldenManifestDigest: digest('golden'),
    currentDevProfileDigest: digest('dev-profile'),
    operationInventoryDigest
  });
}

function stageDetails(stage) {
  if (stage === 'Y2_VALIDATED') {
    return {
      y2RecoveryId: 'dev-pre-refresh-recovery-y2-synthetic',
      encrypted: true,
      authenticated: true,
      digestVerified: true,
      restoreTested: true,
      attemptBound: true,
      frozenManifests: [
        'golden-source', 'x-np-transform', 'managed-profile', 'auth-scope',
        'default-acl', 'application-acl', 'migrations', 'workflow-fixture',
        'cleanup-authority', 'runtime-provenance', 'side-effect-policy', 'y2-recovery'
      ].map((name, index) => ({ name, size: index + 1, digest: digest(name) }))
    };
  }
  if (stage === 'DATABASE_CUTOVER') {
    return {
      migrations: POST_GOLDEN_MIGRATIONS.map(({ id, version, digest: migrationDigest }) => ({
        id, version, digest: migrationDigest
      }))
    };
  }
  if (stage === 'WORKFLOW_CERTIFICATION') {
    return { workflows: GOLDEN_WORKFLOW_CONTRACT.map((name) => ({ name, status: 'passed' })) };
  }
  if (stage === 'FIXTURE_CLEANUP') return { fixtureResidue: 0 };
  if (stage === 'FINAL_PARITY') {
    return {
      targetDev: true,
      goldenDerived: true,
      migration0205: true,
      applicationAclExact: true,
      defaultAclPreserved: true,
      managedProfilePreserved: true,
      authQuarantineExact: true,
      smokeOwnerExact: true,
      copiedUsersFrozen: true,
      sideEffectsSafe: true,
      runtimeExact: true,
      workflowsPassed: true,
      fixturesZero: true,
      tenantIsolationExact: true,
      unexplainedStateAbsent: true
    };
  }
  if (stage === 'RECOVERY_VERIFIED') {
    return {
      preCutoverParity: true,
      fixtureResidue: 0,
      y2Exact: true,
      edgeRestored: true,
      sideEffectsRestored: true
    };
  }
  return { categorical: true };
}

function evidence(refreshContract, stage) {
  const details = stageDetails(stage);
  return {
    format: DEV_CERTIFIED_EVIDENCE_FORMAT,
    stage,
    attemptId: refreshContract.attemptId,
    target: 'dev',
    projectRef: DEV_PROJECT_REF,
    status: 'passed',
    contractDigest: refreshContract.contractDigest,
    safeCount: Object.keys(details).length,
    evidenceDigest: canonicalDigest(details),
    details
  };
}

async function runCrashWorker() {
  const [rootDirectory, keyPath, attemptId, crashState] = process.argv.slice(3);
  const key = fs.readFileSync(keyPath);
  const refreshContract = contract(attemptId);
  try {
    await runCertifiedDevRefresh({
      rootDirectory,
      key,
      contract: refreshContract,
      executor: { run: async (stage) => evidence(refreshContract, stage) },
      afterDurableTransition({ state }) {
        if (state === crashState) process.exit(91);
      }
    });
    process.exitCode = crashState === 'COMPLETE' ? 0 : 92;
  } finally {
    key.fill(0);
  }
}

function runOperationWorker() {
  if (process.argv[3] === 'fail') process.exit(96);
  if (process.argv[3] === 'sleep') {
    setTimeout(() => process.exit(97), 10_000);
    return;
  }
  const forbidden = Object.keys(process.env).filter((name) =>
    name !== 'DEV_REFRESH_AUTHORITY_KEY_FD' &&
    /(?:PROD|SANDBOX|VERCEL|DEPLOY|RELEASE|TOKEN|SECRET|PASSWORD|AUTH)/i.test(name));
  if (forbidden.length > 0 || process.env.DEV_REFRESH_TARGET !== 'dev') process.exit(93);
  const refreshContract = contract(
    process.env.DEV_REFRESH_ATTEMPT_ID,
    process.env.DEV_REFRESH_OPERATION_INVENTORY_DIGEST
  );
  if (refreshContract.contractDigest !== process.env.DEV_REFRESH_CONTRACT_DIGEST) process.exit(94);
  const stage = process.env.DEV_REFRESH_STAGE;
  if (process.argv[3] === 'authenticated-fail') {
    const key = fs.readFileSync(Number(process.env.DEV_REFRESH_AUTHORITY_KEY_FD));
    try {
      const failureError = new Error('MANAGED_OVERLAY_EXECUTION_FAILED');
      failureError.code = 'MANAGED_OVERLAY_EXECUTION_FAILED';
      failureError.failureSubstep = 'MANAGED_OVERLAY_EXECUTION';
      failureError.safeDiagnostic = {
        classification: 'POSTGRES_MANAGED_OWNERSHIP_REJECTED',
        sqlState: '42501',
        statementCategory: 'DDL',
        exitCode: 3,
        signal: '',
        overflow: false,
        excerpt: 'ERROR: must be owner of table users'
      };
      const failure = buildOperationFailure({
        stage,
        attemptId: process.env.DEV_REFRESH_ATTEMPT_ID,
        target: 'dev',
        projectRef: DEV_PROJECT_REF,
        contractDigest: process.env.DEV_REFRESH_CONTRACT_DIGEST,
        error: failureError
      });
      const bytes = Buffer.from(JSON.stringify({
        format: 'dev-certified-operation-result-v1',
        failure,
        authentication: { algorithm: 'hmac-sha256-v1', digest: signPayload(failure, key) }
      }), 'utf8');
      try {
        fs.writeSync(Number(process.env.DEV_REFRESH_RESULT_FD), bytes);
        fs.fsyncSync(Number(process.env.DEV_REFRESH_RESULT_FD));
      } finally {
        bytes.fill(0);
      }
    } finally {
      key.fill(0);
    }
    process.exitCode = 96;
    return;
  }
  const record = {
    format: 'dev-certified-operation-result-v1',
    evidence: evidence(refreshContract, stage)
  };
  const bytes = Buffer.from(JSON.stringify(record), 'utf8');
  try {
    fs.writeSync(Number(process.env.DEV_REFRESH_RESULT_FD), bytes);
    fs.fsyncSync(Number(process.env.DEV_REFRESH_RESULT_FD));
  } finally {
    bytes.fill(0);
  }
}

if (process.argv[2] === 'crash') {
  try {
    await runCrashWorker();
  } catch (error) {
    process.stderr.write(String(error?.code || 'CRASH_WORKER_FAILED').replace(/[^A-Z0-9_]/g, '_'));
    process.exit(98);
  }
} else if (process.argv[2] === 'operation') runOperationWorker();
else process.exit(95);
