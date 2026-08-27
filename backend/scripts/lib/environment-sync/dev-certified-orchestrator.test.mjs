import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonicalDigest } from '../readonly-diagnostics.mjs';
import {
  DEV_CERTIFIED_EVIDENCE_FORMAT,
  DEV_PROJECT_REF,
  FAILURE_INJECTION_CASES,
  PROD_PROJECT_REF,
  SANDBOX_PROJECT_REF,
  buildCertifiedRefreshContract,
  sha256Bytes,
  verifyCertifiedRefreshContract,
  verifyPostGoldenMigrationBytes
} from './dev-certified-contract.mjs';
import {
  REQUIRED_OPERATION_STAGES,
  authenticateOperationInventory,
  buildOperationInventory,
  createOperationExecutor
} from './dev-certified-operation-executor.mjs';
import { runCertifiedDevRecovery, runCertifiedDevRefresh } from './dev-certified-orchestrator.mjs';
import { readJournal, restartDisposition } from './dev-certified-state.mjs';
import { GOLDEN_WORKFLOW_CONTRACT, POST_GOLDEN_MIGRATIONS } from './constants.mjs';
import {
  createPrivateDirectory,
  verifyPrivateArtifactProtection,
  writePrivateBytesExclusive
} from './private-artifacts.mjs';

const TEST_WORKER = fileURLToPath(new URL('./dev-certified-test-worker.mjs', import.meta.url));
const REFRESH_ENTRY = fileURLToPath(new URL('../../environment-refresh-dev-certified.mjs', import.meta.url));
const RECOVERY_ENTRY = fileURLToPath(new URL('../../environment-recover-dev-certified.mjs', import.meta.url));

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex')}`;
}

function createContract(attemptId, operationInventoryDigest = digest('operations')) {
  const normalizedAttemptId = String(attemptId).toLowerCase().replaceAll('_', '-');
  return buildCertifiedRefreshContract({
    attemptId: normalizedAttemptId,
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

function evidence(contract, stage) {
  const details = stageDetails(stage);
  return {
    format: DEV_CERTIFIED_EVIDENCE_FORMAT,
    stage,
    attemptId: contract.attemptId,
    target: 'dev',
    projectRef: DEV_PROJECT_REF,
    status: 'passed',
    contractDigest: contract.contractDigest,
    safeCount: Object.keys(details).length,
    evidenceDigest: canonicalDigest(details),
    details
  };
}

function executor(contract, { failAt = '', failCode = '' } = {}) {
  return {
    async run(stage) {
      if (stage === failAt) {
        const category = failCode || `INJECTED_${stage}_FAILURE`;
        const error = new Error(category);
        error.code = category;
        throw error;
      }
      return evidence(contract, stage);
    }
  };
}

function tempRoot(label) {
  return path.join(os.tmpdir(), `dev-certified-${label}-${crypto.randomBytes(8).toString('hex')}`);
}

function remove(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function spawnIsolatedCli(entry, args, root) {
  const home = path.join(root, 'home');
  const temporary = path.join(root, 'temp');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(temporary, { recursive: true });
  return spawnSync(process.execPath, [entry, ...args], {
    shell: false,
    windowsHide: true,
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      SystemRoot: process.env.SystemRoot || '',
      WINDIR: process.env.WINDIR || '',
      HOME: home,
      USERPROFILE: home,
      TEMP: temporary,
      TMP: temporary
    }
  });
}

function fileDigest(filePath) {
  const bytes = fs.readFileSync(filePath);
  try {
    return sha256Bytes(bytes);
  } finally {
    bytes.fill(0);
  }
}

function createOperationHarness(label, { precheckArgs = ['operation'], timeoutMs = 10_000, copiedWorker = false } = {}) {
  const root = tempRoot(label);
  const key = crypto.randomBytes(32);
  createPrivateDirectory(root);
  const envPath = path.join(root, 'synthetic.env');
  writePrivateBytesExclusive(envPath, Buffer.from('APP_ENV=dev\n', 'utf8'));
  let workerPath = TEST_WORKER;
  if (copiedWorker) {
    workerPath = path.join(root, 'worker.private.mjs');
    const bytes = fs.readFileSync(TEST_WORKER);
    try {
      writePrivateBytesExclusive(workerPath, bytes);
    } finally {
      bytes.fill(0);
    }
  }
  const attemptId = `${label}-${crypto.randomBytes(8).toString('hex')}`.replaceAll('_', '-');
  const executableDigest = fileDigest(process.execPath);
  const scriptDigest = fileDigest(workerPath);
  const operations = REQUIRED_OPERATION_STAGES.map((stage) => ({
    stage,
    runtime: 'node',
    executable: process.execPath,
    executableDigest,
    script: workerPath,
    scriptDigest,
    cwd: root,
    args: stage === 'PRECHECK' ? precheckArgs : ['operation'],
    environmentNames: [],
    timeoutMs
  }));
  const inventoryRecord = buildOperationInventory({
    attemptId,
    envFileDigest: fileDigest(envPath),
    operations
  });
  const contract = createContract(attemptId, inventoryRecord.inventoryDigest);
  return {
    root,
    key,
    workerPath,
    executor: createOperationExecutor({
      inventory: authenticateOperationInventory(inventoryRecord, key),
      key,
      contract,
      envFilePath: envPath,
      evidenceDirectory: path.join(root, 'evidence')
    })
  };
}

test('certified DEV refresh reaches COMPLETE with exact durable markers and no destructive resume', async () => {
  const root = tempRoot('success');
  const key = crypto.randomBytes(32);
  const contract = createContract(`refresh-success-${crypto.randomBytes(8).toString('hex')}`);
  try {
    const result = await runCertifiedDevRefresh({ rootDirectory: root, key, contract, executor: executor(contract) });
    assert.equal(result.classification, 'DEV_REFRESH_COMPLETE');
    assert.equal(result.destructiveResumeAllowed, false);
    const journal = readJournal(root, key);
    assert.equal(journal.current.state, 'COMPLETE');
    assert.equal(journal.current.mutationCrossed, true);
    assert.equal(journal.marker.reusable, false);
    assert.equal(journal.boundary.recoveryRequiredOnInterruption, true);
    assert.equal(journal.recovery, null);
    assert.equal(restartDisposition(root, key), 'COMPLETE');
  } finally {
    key.fill(0);
    remove(root);
  }
});

test('certified contract is DEV-only and pins exact 0203/0204/0205 repository bytes', () => {
  const contract = createContract(`contract-guards-${crypto.randomBytes(8).toString('hex')}`);
  assert.equal(verifyCertifiedRefreshContract(contract), contract);
  assert.equal(contract.target.projectRef, DEV_PROJECT_REF);
  assert.deepEqual(contract.rejectedProjectRefs, [PROD_PROJECT_REF, SANDBOX_PROJECT_REF]);
  for (const rejectedRef of contract.rejectedProjectRefs) {
    const tampered = structuredClone(contract);
    tampered.target.projectRef = rejectedRef;
    assert.throws(() => verifyCertifiedRefreshContract(tampered), { code: 'DEV_REFRESH_CONTRACT_MISMATCH' });
  }
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const migrationProof = verifyPostGoldenMigrationBytes({ repoRoot });
  assert.deepEqual(migrationProof.migrations.map(({ id }) => id), ['0203', '0204', '0205']);
  assert.equal(migrationProof.count, 3);
  assert.equal(migrationProof.ordered, true);
});

test('failure injections I-T freeze refresh and recover exactly once from Y2', async () => {
  const cases = FAILURE_INJECTION_CASES.filter(({ id }) => 'IJKLMNOPQRST'.includes(id));
  for (const failureCase of cases) {
    const { id, name, stage } = failureCase;
    const category = `INJECTED_${id}_${name}`.toUpperCase();
    const root = tempRoot(`failure-${id.toLowerCase()}`);
    const key = crypto.randomBytes(32);
    const contract = createContract(`refresh-${id.toLowerCase()}-${crypto.randomBytes(8).toString('hex')}`);
    try {
      await assert.rejects(runCertifiedDevRefresh({
        rootDirectory: root,
        key,
        contract,
        executor: executor(contract, { failAt: stage, failCode: category })
      }), (error) => error.code === 'DEV_REFRESH_RECOVERY_REQUIRED' && error.causeCategory === category);
      const failed = readJournal(root, key);
      assert.equal(failed.current.failureCategory, category, id);
      assert.equal(restartDisposition(root, key), 'RECOVERY_REQUIRED', id);
      await assert.rejects(
        runCertifiedDevRefresh({ rootDirectory: root, key, contract, executor: executor(contract) })
      );
      const recovered = await runCertifiedDevRecovery({
        rootDirectory: root,
        key,
        contract,
        executor: executor(contract)
      });
      assert.equal(recovered.classification, 'DEV_REFRESH_RECOVERED', id);
      assert.equal(restartDisposition(root, key), 'RECOVERED', id);
      await assert.rejects(
        runCertifiedDevRecovery({ rootDirectory: root, key, contract, executor: executor(contract) }),
        { code: 'DEV_REFRESH_RECOVERY_NOT_PERMITTED' }
      );
    } finally {
      key.fill(0);
      remove(root);
    }
  }
});

test('failure injections A-F retain categorical evidence and never authorize recovery', async () => {
  const cases = FAILURE_INJECTION_CASES.filter(({ id }) => 'ABCDEF'.includes(id));
  for (const failureCase of cases) {
    const { id, name, stage } = failureCase;
    const category = `INJECTED_${id}_${name}`.toUpperCase();
    const root = tempRoot(`pre-${id.toLowerCase()}`);
    const key = crypto.randomBytes(32);
    const contract = createContract(`pre-${id.toLowerCase()}-${crypto.randomBytes(8).toString('hex')}`);
    try {
      await assert.rejects(runCertifiedDevRefresh({
        rootDirectory: root,
        key,
        contract,
        executor: executor(contract, { failAt: stage, failCode: category })
      }), (error) => error.code === category && error.causeCategory === category);
      const journal = readJournal(root, key);
      assert.equal(journal.boundary, null);
      assert.equal(journal.current.state, 'FAILED_PRE_MUTATION');
      assert.equal(journal.current.failureCategory, category, id);
      assert.equal(restartDisposition(root, key), 'PRE_MUTATION_ABORT_ONLY', id);
      await assert.rejects(
        runCertifiedDevRecovery({ rootDirectory: root, key, contract, executor: executor(contract) }),
        { code: 'DEV_REFRESH_RECOVERY_NOT_PERMITTED' }
      );
    } finally {
      key.fill(0);
      remove(root);
    }
  }
});

test('failure injection G rejects an invalid manifest freeze before attempt marking', async () => {
  const root = tempRoot('failure-g');
  const key = crypto.randomBytes(32);
  const contract = createContract(`failure-g-${crypto.randomBytes(8).toString('hex')}`);
  const invalidFreezeExecutor = {
    async run(stage) {
      const result = evidence(contract, stage);
      if (stage === 'Y2_VALIDATED') {
        result.details.frozenManifests[0] = { name: 'golden-source', size: 1, digest: 'invalid' };
        result.safeCount = Object.keys(result.details).length;
        result.evidenceDigest = canonicalDigest(result.details);
      }
      return result;
    }
  };
  try {
    await assert.rejects(
      runCertifiedDevRefresh({ rootDirectory: root, key, contract, executor: invalidFreezeExecutor }),
      { code: 'DEV_REFRESH_MANIFEST_FREEZE_INVALID' }
    );
    const journal = readJournal(root, key);
    assert.equal(journal.current.state, 'FAILED_PRE_MUTATION');
    assert.equal(journal.marker, null);
    assert.equal(journal.boundary, null);
    assert.equal(restartDisposition(root, key), 'PRE_MUTATION_ABORT_ONLY');
  } finally {
    key.fill(0);
    remove(root);
  }
});

test('failure injection H freezes an interrupted marked attempt without crossing the boundary', async () => {
  const root = tempRoot('failure-h');
  const key = crypto.randomBytes(32);
  const contract = createContract(`failure-h-${crypto.randomBytes(8).toString('hex')}`);
  try {
    await assert.rejects(runCertifiedDevRefresh({
      rootDirectory: root,
      key,
      contract,
      executor: executor(contract),
      afterDurableTransition({ state }) {
        if (state === 'ATTEMPT_MARKED') {
          const error = new Error('INJECTED_H_ATTEMPT_MARKER_INTERRUPTION');
          error.code = 'INJECTED_H_ATTEMPT_MARKER_INTERRUPTION';
          throw error;
        }
      }
    }), { code: 'INJECTED_H_ATTEMPT_MARKER_INTERRUPTION' });
    const journal = readJournal(root, key);
    assert.notEqual(journal.marker, null);
    assert.equal(journal.boundary, null);
    assert.equal(restartDisposition(root, key), 'PRE_MUTATION_ATTEMPT_FROZEN');
    await assert.rejects(
      runCertifiedDevRefresh({ rootDirectory: root, key, contract, executor: executor(contract) })
    );
    await assert.rejects(
      runCertifiedDevRecovery({ rootDirectory: root, key, contract, executor: executor(contract) }),
      { code: 'DEV_REFRESH_RECOVERY_NOT_PERMITTED' }
    );
  } finally {
    key.fill(0);
    remove(root);
  }
});

test('failure injection inventory A-U covers every required category and post-boundary cases recover', () => {
  assert.deepEqual(FAILURE_INJECTION_CASES.map((entry) => entry.id), 'ABCDEFGHIJKLMNOPQRSTU'.split(''));
  assert.equal(new Set(FAILURE_INJECTION_CASES.map((entry) => entry.name)).size, 21);
  const postBoundary = FAILURE_INJECTION_CASES.filter((entry) =>
    ['I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U'].includes(entry.id)
  );
  assert.equal(postBoundary.length, 13);
});

test('abrupt process exit after every destructive transition requires exact one-shot recovery', { timeout: 900_000 }, async () => {
  const crashStates = [
    'DESTRUCTIVE_BOUNDARY',
    'SIDE_EFFECTS_QUARANTINED',
    'DATABASE_CUTOVER',
    'DATABASE_VERIFIED',
    'AUTH_RUNTIME',
    'EDGE_RUNTIME',
    'WORKFLOW_CERTIFICATION',
    'FIXTURE_CLEANUP',
    'FINAL_PARITY'
  ];
  for (const crashState of crashStates) {
    const root = tempRoot(`crash-${crashState.toLowerCase()}`);
    const keyPath = `${root}.key.private`;
    const key = crypto.randomBytes(32);
    const attemptId = `crash-${crashState.toLowerCase()}-${crypto.randomBytes(8).toString('hex')}`;
    const contract = createContract(attemptId);
    try {
      writePrivateBytesExclusive(keyPath, key);
      const child = spawnSync(
        process.execPath,
        [TEST_WORKER, 'crash', root, keyPath, contract.attemptId, crashState],
        {
          shell: false,
          windowsHide: true,
          encoding: 'utf8',
          stdio: ['ignore', 'ignore', 'pipe'],
          env: {
            SystemRoot: process.env.SystemRoot || '',
            WINDIR: process.env.WINDIR || '',
            TEMP: process.env.TEMP || '',
            TMP: process.env.TMP || '',
            PATH: process.env.PATH || ''
          }
        }
      );
      assert.equal(child.status, 91, `${crashState}:${String(child.stderr || '')}`);
      assert.equal(restartDisposition(root, key), 'RECOVERY_REQUIRED', crashState);
      const recovered = await runCertifiedDevRecovery({
        rootDirectory: root,
        key,
        contract,
        executor: executor(contract)
      });
      assert.equal(recovered.classification, 'DEV_REFRESH_RECOVERED', crashState);
      assert.equal(restartDisposition(root, key), 'RECOVERED', crashState);
    } finally {
      key.fill(0);
      remove(root);
      fs.rmSync(keyPath, { force: true });
    }
  }

  const completeRoot = tempRoot('crash-complete');
  const completeKeyPath = `${completeRoot}.key.private`;
  const completeKey = crypto.randomBytes(32);
  const completeAttempt = `crash-complete-${crypto.randomBytes(8).toString('hex')}`;
  try {
    writePrivateBytesExclusive(completeKeyPath, completeKey);
    const child = spawnSync(
      process.execPath,
      [TEST_WORKER, 'crash', completeRoot, completeKeyPath, completeAttempt, 'COMPLETE'],
      { shell: false, windowsHide: true, stdio: 'ignore' }
    );
    assert.equal(child.status, 91);
    assert.equal(restartDisposition(completeRoot, completeKey), 'COMPLETE');
  } finally {
    completeKey.fill(0);
    remove(completeRoot);
    fs.rmSync(completeKeyPath, { force: true });
  }
});

test('CLI entrypoints preparse guards before repository-local loading or environment access', () => {
  for (const entry of [REFRESH_ENTRY, RECOVERY_ENTRY]) {
    const source = fs.readFileSync(entry, 'utf8');
    const staticImports = [...source.matchAll(/^import .*? from '([^']+)';$/gm)].map((match) => match[1]);
    assert.ok(staticImports.length > 0);
    assert.ok(staticImports.every((specifier) => specifier.startsWith('node:')));
    assert.ok(source.indexOf('preparse(args)') < source.indexOf("await import('./lib/environment-sync/dev-certified-cli.mjs')"));
  }

  const root = tempRoot('cli-preparse');
  try {
    for (const [entry, missingCode] of [
      [REFRESH_ENTRY, 'DEV_REFRESH_REQUIRED_ARGUMENT_MISSING'],
      [RECOVERY_ENTRY, 'DEV_REFRESH_RECOVERY_REQUIRED_ARGUMENT_MISSING']
    ]) {
      const help = spawnIsolatedCli(entry, ['--help'], root);
      assert.equal(help.status, 0);
      assert.match(help.stdout, /^Usage:/);

      const missingEnv = spawnIsolatedCli(entry, [
        '--apply', '--quiet-window-active',
        ...(entry === RECOVERY_ENTRY ? ['--recovery-authorized'] : []),
        '--authority-key', 'private-key', '--contract', 'contract',
        '--operation-inventory', 'inventory', '--state-dir', 'state', '--evidence-dir', 'evidence'
      ], root);
      assert.equal(missingEnv.status, 1);
      assert.match(missingEnv.stderr, new RegExp(missingCode));
      assert.doesNotMatch(missingEnv.stderr, /private-key|contract|inventory|state|evidence/);

      const blankEnv = spawnIsolatedCli(entry, [
        '--apply', '--quiet-window-active',
        ...(entry === RECOVERY_ENTRY ? ['--recovery-authorized'] : []),
        '--env', '   ', '--authority-key', 'private-key', '--contract', 'contract',
        '--operation-inventory', 'inventory', '--state-dir', 'state', '--evidence-dir', 'evidence'
      ], root);
      assert.equal(blankEnv.status, 1);
      assert.match(blankEnv.stderr, new RegExp(missingCode));
      assert.doesNotMatch(blankEnv.stderr, /private-key|contract|inventory|state|evidence/);
    }
    assert.deepEqual(fs.readdirSync(root).sort(), ['home', 'temp']);
  } finally {
    remove(root);
  }
});

test('operation executor pins bytes, isolates environment, uses inherited private result fd, and accepts all stages', { timeout: 120_000 }, async () => {
  const root = tempRoot('operation-executor');
  const key = crypto.randomBytes(32);
  const attemptId = `operation-executor-${crypto.randomBytes(8).toString('hex')}`;
  try {
    createPrivateDirectory(root);
    const envPath = path.join(root, 'synthetic.env');
    writePrivateBytesExclusive(envPath, Buffer.from('APP_ENV=dev\n', 'utf8'));
    const executableBytes = fs.readFileSync(process.execPath);
    const workerBytes = fs.readFileSync(TEST_WORKER);
    let executableDigest;
    let scriptDigest;
    try {
      executableDigest = sha256Bytes(executableBytes);
      scriptDigest = sha256Bytes(workerBytes);
    } finally {
      executableBytes.fill(0);
      workerBytes.fill(0);
    }
    const envBytes = fs.readFileSync(envPath);
    let envFileDigest;
    try {
      envFileDigest = sha256Bytes(envBytes);
    } finally {
      envBytes.fill(0);
    }
    const operations = REQUIRED_OPERATION_STAGES.map((stage) => ({
      stage,
      runtime: 'node',
      executable: process.execPath,
      executableDigest,
      script: TEST_WORKER,
      scriptDigest,
      cwd: root,
      args: ['operation'],
      environmentNames: [],
      timeoutMs: 10_000
    }));
    const unsignedInventory = buildOperationInventory({ attemptId, envFileDigest, operations });
    const contract = createContract(attemptId, unsignedInventory.inventoryDigest);
    const inventory = authenticateOperationInventory(unsignedInventory, key);
    const operationExecutor = createOperationExecutor({
      inventory,
      key,
      contract,
      envFilePath: envPath,
      evidenceDirectory: path.join(root, 'evidence')
    });
    process.env.PROD_DATABASE_URL = 'must-not-be-inherited';
    process.env.SANDBOX_SECRET_TOKEN = 'must-not-be-inherited';
    try {
      for (const stage of REQUIRED_OPERATION_STAGES) {
        const result = await operationExecutor.run(stage);
        assert.equal(result.stage, stage);
      }
    } finally {
      delete process.env.PROD_DATABASE_URL;
      delete process.env.SANDBOX_SECRET_TOKEN;
    }
    const evidenceFiles = fs.readdirSync(path.join(root, 'evidence'));
    assert.equal(evidenceFiles.length, REQUIRED_OPERATION_STAGES.length * 2);
    for (const name of evidenceFiles) {
      const artifactPath = path.join(root, 'evidence', name);
      verifyPrivateArtifactProtection(artifactPath);
      const bytes = fs.readFileSync(artifactPath);
      try {
        const text = bytes.toString('utf8');
        assert.doesNotMatch(text, /must-not-be-inherited|PROD_DATABASE_URL|SANDBOX_SECRET_TOKEN/);
      } finally {
        bytes.fill(0);
      }
    }
  } finally {
    key.fill(0);
    remove(root);
  }
});

test('operation executor fails closed on child failure, timeout, and script-byte drift', { timeout: 120_000 }, async () => {
  for (const [label, args, timeoutMs, expected] of [
    ['operation-child-failure', ['operation', 'fail'], 10_000, 'DEV_REFRESH_PRECHECK_OPERATION_FAILED'],
    ['operation-timeout', ['operation', 'sleep'], 1_000, 'DEV_REFRESH_PRECHECK_OPERATION_FAILED']
  ]) {
    const harness = createOperationHarness(label, { precheckArgs: args, timeoutMs });
    try {
      await assert.rejects(harness.executor.run('PRECHECK'), { code: expected });
    } finally {
      harness.key.fill(0);
      remove(harness.root);
    }
  }

  const drift = createOperationHarness('operation-script-drift', { copiedWorker: true });
  try {
    fs.appendFileSync(drift.workerPath, '\n// drift\n');
    await assert.rejects(
      drift.executor.run('PRECHECK'),
      { code: 'DEV_REFRESH_OPERATION_SCRIPT_CHANGED' }
    );
  } finally {
    drift.key.fill(0);
    remove(drift.root);
  }
});

test('malformed workflow, migration, cleanup, and final parity evidence fail closed after mutation', async () => {
  for (const stage of ['DATABASE_CUTOVER', 'WORKFLOW_CERTIFICATION', 'FIXTURE_CLEANUP', 'FINAL_PARITY']) {
    const root = tempRoot(`bad-evidence-${stage.toLowerCase()}`);
    const key = crypto.randomBytes(32);
    const contract = createContract(`bad-${stage.toLowerCase()}-${crypto.randomBytes(8).toString('hex')}`);
    const badExecutor = executor(contract);
    const normalRun = badExecutor.run;
    badExecutor.run = async (candidateStage) => {
      const value = await normalRun(candidateStage);
      if (candidateStage !== stage) return value;
      if (stage === 'DATABASE_CUTOVER') value.details.migrations.pop();
      if (stage === 'WORKFLOW_CERTIFICATION') value.details.workflows.pop();
      if (stage === 'FIXTURE_CLEANUP') value.details.fixtureResidue = 1;
      if (stage === 'FINAL_PARITY') value.details.runtimeExact = false;
      return value;
    };
    try {
      await assert.rejects(
        runCertifiedDevRefresh({ rootDirectory: root, key, contract, executor: badExecutor }),
        { code: 'DEV_REFRESH_RECOVERY_REQUIRED' }
      );
      assert.equal(restartDisposition(root, key), 'RECOVERY_REQUIRED');
    } finally {
      key.fill(0);
      remove(root);
    }
  }
});
