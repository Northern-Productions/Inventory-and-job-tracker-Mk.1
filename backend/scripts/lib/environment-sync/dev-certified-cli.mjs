import fs from 'node:fs';
import path from 'node:path';

import { buildMutationTargetReport, loadEnvFile } from '../target-env-guards.mjs';
import {
  verifyAuthenticatedCertifiedRefreshContract,
  verifyPostGoldenMigrationBytes,
  verifyRepositoryLineage
} from './dev-certified-contract.mjs';
import { createOperationExecutor } from './dev-certified-operation-executor.mjs';
import { runCertifiedDevRecovery, runCertifiedDevRefresh } from './dev-certified-orchestrator.mjs';
import { verifyPrivateArtifactProtection } from './private-artifacts.mjs';

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw categoricalError('DEV_REFRESH_ARGUMENT_INVALID');
    const key = token.slice(2);
    if (Object.hasOwn(result, key)) throw categoricalError('DEV_REFRESH_ARGUMENT_DUPLICATE');
    const next = argv[index + 1];
    result[key] = !next || next.startsWith('--') ? true : next;
    if (result[key] !== true) index += 1;
  }
  return result;
}

function requiredPath(options, name) {
  const value = String(options[name] || '').trim();
  if (!value) throw categoricalError(`DEV_REFRESH_${name.toUpperCase().replaceAll('-', '_')}_REQUIRED`);
  return path.resolve(value);
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
      else if (/^[A-Za-z0-9+/]{43}=$/.test(text)) key = Buffer.from(text, 'base64');
    }
  } finally {
    bytes.fill(0);
  }
  if (!key || key.length !== 32) throw categoricalError('DEV_REFRESH_AUTHORITY_KEY_INVALID');
  return key;
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

function assertCliGuards(options, envFilePath) {
  if (options.linked || options['linked-ref']) throw categoricalError('DEV_REFRESH_LINKED_USAGE_REJECTED');
  if (options.apply !== true || options['quiet-window-active'] !== true) {
    throw categoricalError('DEV_REFRESH_EXPLICIT_MUTATION_GUARD_REQUIRED');
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
  if (!report.ok || report.expected.target !== 'dev') {
    throw categoricalError('DEV_REFRESH_TARGET_GUARD_FAILED');
  }
  return report;
}

async function runDevCertifiedCli(mode, argv, repoRoot, testOnlyRuntime = {}) {
  const {
    createOperationExecutorFn = createOperationExecutor,
    readAuthorityKeyFn = readAuthorityKey,
    runRecoveryFn = runCertifiedDevRecovery,
    runRefreshFn = runCertifiedDevRefresh,
    verifyMigrationBytesFn = verifyPostGoldenMigrationBytes,
    verifyRepositoryLineageFn = verifyRepositoryLineage
  } = testOnlyRuntime;
  const options = parseArgs(argv);
  if (options.help || options.h) return { help: true };
  const allowed = new Set([
    'apply', 'quiet-window-active', 'env', 'authority-key', 'contract',
    'operation-inventory', 'state-dir', 'evidence-dir',
    ...(mode === 'recover' ? ['recovery-authorized'] : [])
  ]);
  if (Object.keys(options).some((name) => !allowed.has(name))) {
    throw categoricalError('DEV_REFRESH_ARGUMENT_UNKNOWN');
  }
  const root = path.resolve(repoRoot);
  const envFilePath = requiredPath(options, 'env');
  const keyPath = requiredPath(options, 'authority-key');
  const contractPath = requiredPath(options, 'contract');
  const inventoryPath = requiredPath(options, 'operation-inventory');
  const stateDirectory = requiredPath(options, 'state-dir');
  const evidenceDirectory = requiredPath(options, 'evidence-dir');
  assertCliGuards(options, envFilePath);
  const key = readAuthorityKeyFn(keyPath);
  try {
    const contract = verifyAuthenticatedCertifiedRefreshContract(readPrivateJson(contractPath), key);
    const lineage = verifyRepositoryLineageFn({ repoRoot: root });
    if (
      contract.candidate.toolingCommit !== lineage.toolingCommit ||
      contract.candidate.toolingTree !== lineage.toolingTree
    ) throw categoricalError('DEV_REFRESH_TOOLING_CANDIDATE_MISMATCH');
    verifyMigrationBytesFn({ repoRoot: root });
    const executor = createOperationExecutorFn({
      inventory: readPrivateJson(inventoryPath),
      key,
      contract,
      envFilePath,
      evidenceDirectory
    });
    if (mode === 'refresh') {
      if (fs.existsSync(stateDirectory)) throw categoricalError('DEV_REFRESH_STATE_DIRECTORY_COLLISION');
      return await runRefreshFn({ rootDirectory: stateDirectory, key, contract, executor });
    }
    if (mode === 'recover') {
      if (options['recovery-authorized'] !== true) {
        throw categoricalError('DEV_REFRESH_RECOVERY_AUTHORIZATION_FLAG_REQUIRED');
      }
      if (!fs.existsSync(stateDirectory)) throw categoricalError('DEV_REFRESH_STATE_DIRECTORY_MISSING');
      return await runRecoveryFn({ rootDirectory: stateDirectory, key, contract, executor });
    }
    throw categoricalError('DEV_REFRESH_MODE_INVALID');
  } finally {
    key.fill(0);
  }
}

export { parseArgs, runDevCertifiedCli };
