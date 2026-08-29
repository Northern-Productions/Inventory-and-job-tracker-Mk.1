import fs from 'node:fs';
import path from 'node:path';

import { buildMutationTargetReport, loadEnvFile } from '../target-env-guards.mjs';
import { DEV_PROJECT_REF, verifyRepositoryLineage } from './dev-certified-contract.mjs';
import { createOperationExecutor } from './dev-certified-operation-executor.mjs';
import { readAuthorityKey } from './dev-certified-preparation.mjs';
import {
  REMEDIATION_OPERATION_STAGES,
  assertRecoveryRemediationEvidence,
  verifyAuthenticatedRecoveryRemediationContract
} from './dev-recovery-remediation-contract.mjs';
import {
  runDevRecoveryRemediation,
  runDevRecoveryRemediationRecovery
} from './dev-recovery-remediation-orchestrator.mjs';
import { verifyRemediationPreparation } from './dev-recovery-remediation-preparation.mjs';
import { verifyPrivateArtifactProtection } from './private-artifacts.mjs';

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function parseRemediationArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw categoricalError('DEV_REMEDIATION_ARGUMENT_INVALID');
    const key = token.slice(2);
    if (Object.hasOwn(result, key)) throw categoricalError('DEV_REMEDIATION_ARGUMENT_DUPLICATE');
    const next = argv[index + 1];
    result[key] = !next || next.startsWith('--') ? true : next;
    if (result[key] !== true) index += 1;
  }
  return result;
}

function requiredPath(options, name) {
  const value = String(options[name] || '').trim();
  if (!value) throw categoricalError(`DEV_REMEDIATION_${name.toUpperCase().replaceAll('-', '_')}_REQUIRED`);
  return path.resolve(value);
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

function assertRemediationCliGuards(options, envFilePath) {
  if (options.linked || options['linked-ref']) throw categoricalError('DEV_REMEDIATION_LINKED_USAGE_REJECTED');
  if (options.apply !== true || options['quiet-window-active'] !== true) {
    throw categoricalError('DEV_REMEDIATION_EXPLICIT_MUTATION_GUARD_REQUIRED');
  }
  const loaded = loadEnvFile(envFilePath);
  const report = buildMutationTargetReport({
    envPath: loaded.path,
    envValues: loaded.values,
    requestedTarget: 'dev',
    allowProd: false,
    linked: false,
    linkedRef: ''
  });
  if (!report.ok || report.expected.target !== 'dev' || report.expected.ref !== DEV_PROJECT_REF) {
    throw categoricalError('DEV_REMEDIATION_TARGET_GUARD_FAILED');
  }
  return report;
}

async function runDevRecoveryRemediationCli(mode, argv, repoRoot, testOnlyRuntime = {}) {
  const {
    assertCliGuardsFn = assertRemediationCliGuards,
    createOperationExecutorFn = createOperationExecutor,
    readAuthorityKeyFn = readAuthorityKey,
    runRecoveryFn = runDevRecoveryRemediationRecovery,
    runRemediationFn = runDevRecoveryRemediation,
    verifyRepositoryLineageFn = verifyRepositoryLineage
  } = testOnlyRuntime;
  const options = parseRemediationArgs(argv);
  if (options.help || options.h) return { help: true };
  const allowed = new Set([
    'apply', 'quiet-window-active', 'env', 'authority-key', 'preparation', 'contract',
    'operation-inventory', 'state-dir', 'evidence-dir',
    ...(mode === 'recover' ? ['remediation-recovery-authorized'] : ['remediation-authorized'])
  ]);
  if (Object.keys(options).some((name) => !allowed.has(name))) {
    throw categoricalError('DEV_REMEDIATION_ARGUMENT_UNKNOWN');
  }
  if (mode === 'remediate' && options['remediation-authorized'] !== true) {
    throw categoricalError('DEV_REMEDIATION_AUTHORIZATION_FLAG_REQUIRED');
  }
  if (mode === 'recover' && options['remediation-recovery-authorized'] !== true) {
    throw categoricalError('DEV_REMEDIATION_RECOVERY_AUTHORIZATION_FLAG_REQUIRED');
  }
  const root = path.resolve(repoRoot);
  const envFilePath = requiredPath(options, 'env');
  const keyPath = requiredPath(options, 'authority-key');
  const preparationPath = requiredPath(options, 'preparation');
  const contractPath = requiredPath(options, 'contract');
  const inventoryPath = requiredPath(options, 'operation-inventory');
  const stateDirectory = requiredPath(options, 'state-dir');
  const evidenceDirectory = requiredPath(options, 'evidence-dir');
  assertCliGuardsFn(options, envFilePath);
  const key = readAuthorityKeyFn(keyPath);
  try {
    const contract = verifyAuthenticatedRecoveryRemediationContract(readPrivateJson(contractPath), key);
    const preparation = verifyRemediationPreparation(
      readPrivateJson(preparationPath), key, contract.remediationAttemptId
    );
    if (
      preparation.currentObserved.certificateDigest !== contract.observedDevCertificateDigest ||
      preparation.original.binding.failedJournalDigest !== contract.original.failedJournalDigest
    ) throw categoricalError('DEV_REMEDIATION_PREPARATION_CONTRACT_MISMATCH');
    const lineage = verifyRepositoryLineageFn({ repoRoot: root });
    if (
      lineage.toolingCommit !== contract.candidate.toolingCommit ||
      lineage.toolingTree !== contract.candidate.toolingTree
    ) throw categoricalError('DEV_REMEDIATION_TOOLING_CANDIDATE_MISMATCH');
    const executor = createOperationExecutorFn({
      inventory: readPrivateJson(inventoryPath),
      key,
      contract,
      envFilePath,
      evidenceDirectory,
      requiredStages: REMEDIATION_OPERATION_STAGES,
      assertStageEvidenceFn: assertRecoveryRemediationEvidence
    });
    if (mode === 'remediate') {
      if (fs.existsSync(stateDirectory)) throw categoricalError('DEV_REMEDIATION_STATE_DIRECTORY_COLLISION');
      return await runRemediationFn({ rootDirectory: stateDirectory, key, contract, executor });
    }
    if (mode === 'recover') {
      if (!fs.existsSync(stateDirectory)) throw categoricalError('DEV_REMEDIATION_STATE_DIRECTORY_MISSING');
      return await runRecoveryFn({ rootDirectory: stateDirectory, key, contract, executor });
    }
    throw categoricalError('DEV_REMEDIATION_MODE_INVALID');
  } finally {
    key.fill(0);
  }
}

export { assertRemediationCliGuards, parseRemediationArgs, runDevRecoveryRemediationCli };
