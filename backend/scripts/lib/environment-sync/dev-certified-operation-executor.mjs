import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { canonicalDigest, canonicalSerialize } from '../readonly-diagnostics.mjs';
import { loadEnvFile } from '../target-env-guards.mjs';
import {
  DEV_PROJECT_REF,
  PROD_PROJECT_REF,
  SANDBOX_PROJECT_REF,
  assertStageEvidence,
  assertSha256,
  sha256Bytes
} from './dev-certified-contract.mjs';
import {
  createPrivateDirectory,
  fsyncDirectory,
  openPrivateFileExclusive,
  verifyPrivateArtifactProtection,
  verifyPrivateDirectoryProtection,
  writePrivateJsonExclusive
} from './private-artifacts.mjs';
import { signPayload } from './dev-certified-state.mjs';
import { verifyOperationFailure } from './dev-certified-operation-failure.mjs';

const OPERATION_INVENTORY_FORMAT = 'dev-certified-operation-inventory-v1';
const OPERATION_RESULT_FORMAT = 'dev-certified-operation-result-v1';
const REQUIRED_OPERATION_STAGES = Object.freeze([
  'PRECHECK',
  'QUIET_WINDOW',
  'Y2_CAPTURE',
  'Y2_VALIDATED',
  'SIDE_EFFECTS_QUARANTINED',
  'DATABASE_CUTOVER',
  'DATABASE_VERIFIED',
  'AUTH_RUNTIME',
  'EDGE_RUNTIME',
  'WORKFLOW_CERTIFICATION',
  'FIXTURE_CLEANUP',
  'FINAL_PARITY',
  'RECOVERY_DATABASE',
  'RECOVERY_AUTH_RUNTIME',
  'RECOVERY_VERIFIED'
]);

const ENV_NAME_PATTERN = /^(?:APP_ENV|BACKEND_MODE|CORS_ALLOWED_ORIGINS|EDGE_API_BASE_URL|DEV_[A-Z0-9_]+|SUPABASE_[A-Z0-9_]+|VITE_[A-Z0-9_]+|SMOKE_[A-Z0-9_]+|PG[A-Z0-9_]+)$/;
const FORBIDDEN_ENV_NAME = /(?:PROD|SANDBOX|VERCEL|DEPLOY|RELEASE)/i;
const SYNTHETIC_WORKER_PATH = fileURLToPath(new URL('./dev-certified-test-worker.mjs', import.meta.url));
const syntheticWorkerBytes = fs.readFileSync(SYNTHETIC_WORKER_PATH);
const SYNTHETIC_WORKER_DIGEST = sha256Bytes(syntheticWorkerBytes);
syntheticWorkerBytes.fill(0);

function categoricalError(code, operationFailure = null) {
  const error = new Error(code);
  error.code = code;
  if (operationFailure) {
    Object.defineProperty(error, 'operationFailure', {
      value: operationFailure,
      enumerable: false,
      configurable: false,
      writable: false
    });
  }
  return error;
}

function assertPrivateKey(key) {
  if (!Buffer.isBuffer(key) || key.length < 32) throw categoricalError('DEV_REFRESH_OPERATION_KEY_INVALID');
}

function normalizeStageList(requiredStages = REQUIRED_OPERATION_STAGES) {
  const normalized = [...requiredStages].map((stage) => String(stage || ''));
  if (
    normalized.length === 0 || new Set(normalized).size !== normalized.length ||
    normalized.some((stage) => !/^[A-Z][A-Z0-9_]{1,63}$/.test(stage))
  ) throw categoricalError('DEV_REFRESH_OPERATION_STAGE_SET_INVALID');
  return normalized;
}

function normalizeOperation(operation = {}, {
  testOnlyAllowSynthetic = false,
  requiredStages = REQUIRED_OPERATION_STAGES
} = {}) {
  const stages = normalizeStageList(requiredStages);
  const stage = String(operation.stage || '');
  if (!stages.includes(stage)) throw categoricalError('DEV_REFRESH_OPERATION_STAGE_INVALID');
  const runtime = String(operation.runtime || '');
  if (!['node', 'native'].includes(runtime)) throw categoricalError('DEV_REFRESH_OPERATION_RUNTIME_INVALID');
  const executable = path.resolve(String(operation.executable || ''));
  const script = runtime === 'node' ? path.resolve(String(operation.script || '')) : '';
  const cwd = path.resolve(String(operation.cwd || ''));
  const args = Array.isArray(operation.args) ? operation.args.map((entry) => String(entry)) : [];
  const environmentNames = Array.isArray(operation.environmentNames)
    ? [...new Set(operation.environmentNames.map((entry) => String(entry)))].sort()
    : [];
  const timeoutMs = Number(operation.timeoutMs);
  if (
    !path.isAbsolute(executable) || !path.isAbsolute(cwd) ||
    (runtime === 'node' && !path.isAbsolute(script)) ||
    !fs.existsSync(executable) || (script && !fs.existsSync(script)) ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 6 * 60 * 60 * 1_000
  ) throw categoricalError('DEV_REFRESH_OPERATION_PATH_INVALID');
  assertSha256(operation.executableDigest, 'DEV_REFRESH_OPERATION_EXECUTABLE_DIGEST_INVALID');
  if (runtime === 'node') assertSha256(operation.scriptDigest, 'DEV_REFRESH_OPERATION_SCRIPT_DIGEST_INVALID');
  if (
    runtime === 'node' && testOnlyAllowSynthetic !== true &&
    (script === path.resolve(SYNTHETIC_WORKER_PATH) || operation.scriptDigest === SYNTHETIC_WORKER_DIGEST)
  ) {
    throw categoricalError('DEV_REFRESH_SYNTHETIC_WORKER_REJECTED');
  }
  if (environmentNames.some((name) => !ENV_NAME_PATTERN.test(name) || FORBIDDEN_ENV_NAME.test(name))) {
    throw categoricalError('DEV_REFRESH_OPERATION_ENVIRONMENT_INVALID');
  }
  const serializedArgs = canonicalSerialize(args);
  if (
    new RegExp(PROD_PROJECT_REF, 'i').test(serializedArgs) ||
    new RegExp(SANDBOX_PROJECT_REF, 'i').test(serializedArgs) ||
    /--linked\b|postgres(?:ql)?:\/\/[^\s]*:[^\s]*@|eyJ[A-Za-z0-9_-]{20,}|(?:password|token|secret|apikey)\s*=/i.test(serializedArgs)
  ) throw categoricalError('DEV_REFRESH_OPERATION_ARGUMENT_REJECTED');
  return {
    stage,
    runtime,
    executable,
    executableDigest: operation.executableDigest,
    script,
    scriptDigest: runtime === 'node' ? operation.scriptDigest : '',
    cwd,
    args,
    environmentNames,
    timeoutMs
  };
}

function buildOperationInventory({
  attemptId,
  envFileDigest,
  operations,
  testOnlyAllowSynthetic = false,
  requiredStages = REQUIRED_OPERATION_STAGES
} = {}) {
  const stages = normalizeStageList(requiredStages);
  assertSha256(envFileDigest, 'DEV_REFRESH_OPERATION_ENV_DIGEST_INVALID');
  const normalized = (operations || []).map((operation) => normalizeOperation(operation, {
    testOnlyAllowSynthetic,
    requiredStages: stages
  })).sort(
    (a, b) => stages.indexOf(a.stage) - stages.indexOf(b.stage)
  );
  if (
    normalized.length !== stages.length ||
    normalized.some((entry, index) => entry.stage !== stages[index])
  ) throw categoricalError('DEV_REFRESH_OPERATION_INVENTORY_INCOMPLETE');
  const payload = {
    format: OPERATION_INVENTORY_FORMAT,
    version: 1,
    attemptId,
    target: 'dev',
    projectRef: DEV_PROJECT_REF,
    envFileDigest,
    operations: normalized,
    shell: false,
    linkedUsage: false,
    resultPolicy: 'private-categorical-counts-only'
  };
  return { ...payload, inventoryDigest: canonicalDigest(payload) };
}

function authenticateOperationInventory(inventory, key) {
  assertPrivateKey(key);
  return {
    inventory,
    authentication: { algorithm: 'hmac-sha256-v1', digest: signPayload(inventory, key) }
  };
}

function verifyOperationInventory(record, key, contract, envFilePath, {
  testOnlyAllowSynthetic = false,
  requiredStages = REQUIRED_OPERATION_STAGES
} = {}) {
  assertPrivateKey(key);
  if (
    record?.authentication?.algorithm !== 'hmac-sha256-v1' ||
    record?.authentication?.digest !== signPayload(record?.inventory, key)
  ) throw categoricalError('DEV_REFRESH_OPERATION_INVENTORY_AUTHENTICATION_FAILED');
  const rebuilt = buildOperationInventory({
    attemptId: record.inventory?.attemptId,
    envFileDigest: record.inventory?.envFileDigest,
    operations: record.inventory?.operations,
    testOnlyAllowSynthetic,
    requiredStages
  });
  if (
    canonicalSerialize(rebuilt) !== canonicalSerialize(record.inventory) ||
    rebuilt.attemptId !== contract.attemptId ||
    rebuilt.inventoryDigest !== contract.operationInventoryDigest
  ) throw categoricalError('DEV_REFRESH_OPERATION_INVENTORY_MISMATCH');
  verifyPrivateArtifactProtection(envFilePath);
  const envBytes = fs.readFileSync(envFilePath);
  try {
    if (sha256Bytes(envBytes) !== rebuilt.envFileDigest) {
      throw categoricalError('DEV_REFRESH_OPERATION_ENV_FILE_CHANGED');
    }
  } finally {
    envBytes.fill(0);
  }
  return rebuilt;
}

function verifyExecutable(operation) {
  const executableBytes = fs.readFileSync(operation.executable);
  try {
    if (sha256Bytes(executableBytes) !== operation.executableDigest) {
      throw categoricalError('DEV_REFRESH_OPERATION_EXECUTABLE_CHANGED');
    }
  } finally {
    executableBytes.fill(0);
  }
  if (operation.runtime === 'node') {
    const scriptBytes = fs.readFileSync(operation.script);
    try {
      if (sha256Bytes(scriptBytes) !== operation.scriptDigest) {
        throw categoricalError('DEV_REFRESH_OPERATION_SCRIPT_CHANGED');
      }
    } finally {
      scriptBytes.fill(0);
    }
  }
}

function minimalEnvironment(envValues, names, safeValues) {
  const env = {
    SystemRoot: process.env.SystemRoot || '',
    WINDIR: process.env.WINDIR || '',
    TEMP: process.env.TEMP || '',
    TMP: process.env.TMP || '',
    PATH: process.env.PATH || '',
    ...safeValues
  };
  for (const name of names) {
    if (!Object.hasOwn(envValues, name)) throw categoricalError('DEV_REFRESH_OPERATION_ENV_VALUE_MISSING');
    env[name] = envValues[name];
  }
  return env;
}

function readOperationResult(resultPath, contract, stage, assertStageEvidenceFn = assertStageEvidence) {
  verifyPrivateArtifactProtection(resultPath);
  const bytes = fs.readFileSync(resultPath);
  try {
    const record = JSON.parse(bytes.toString('utf8'));
    if (record?.format !== OPERATION_RESULT_FORMAT) {
      throw categoricalError('DEV_REFRESH_OPERATION_RESULT_FORMAT_INVALID');
    }
    assertStageEvidenceFn(record.evidence, { contract, stage });
    return record.evidence;
  } finally {
    bytes.fill(0);
  }
}

function readOperationFailure(resultPath, key, contract, stage) {
  verifyPrivateArtifactProtection(resultPath);
  const bytes = fs.readFileSync(resultPath);
  try {
    if (bytes.length === 0) return null;
    const record = JSON.parse(bytes.toString('utf8'));
    const failure = verifyOperationFailure(record?.failure, {
      stage,
      attemptId: contract.attemptId,
      target: 'dev',
      projectRef: DEV_PROJECT_REF,
      contractDigest: contract.contractDigest
    });
    if (record?.format !== OPERATION_RESULT_FORMAT || !failure ||
        record?.authentication?.algorithm !== 'hmac-sha256-v1') return null;
    const expected = Buffer.from(signPayload(failure, key), 'utf8');
    const observed = Buffer.from(String(record.authentication.digest || ''), 'utf8');
    try {
      if (expected.length !== observed.length || !crypto.timingSafeEqual(expected, observed)) return null;
    } finally {
      expected.fill(0);
      observed.fill(0);
    }
    return failure;
  } catch {
    return null;
  } finally {
    bytes.fill(0);
  }
}

function runOperationChild(operation, args, env, resultDescriptor, key) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const child = spawn(operation.executable, args, {
      cwd: operation.cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', resultDescriptor, 'pipe']
    });
    const keyBytes = Buffer.from(key);
    child.stdio[4].on('error', () => {});
    child.stdio[4].end(keyBytes, () => keyBytes.fill(0));
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeAllListeners();
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, operation.timeoutMs);
    timeout.unref();
    child.once('error', () => finish(categoricalError(
      timedOut ? 'DEV_REFRESH_OPERATION_TIMEOUT' : 'DEV_REFRESH_OPERATION_SPAWN_FAILED'
    )));
    child.once('exit', (code, signal) => {
      if (timedOut) {
        finish(categoricalError('DEV_REFRESH_OPERATION_TIMEOUT'));
        return;
      }
      if (code !== 0 || signal) {
        finish(categoricalError('DEV_REFRESH_OPERATION_CHILD_FAILED'));
        return;
      }
      finish();
    });
  });
}

function createOperationExecutor({
  inventory,
  key,
  contract,
  envFilePath,
  evidenceDirectory,
  testOnlyAllowSynthetic = false,
  requiredStages = REQUIRED_OPERATION_STAGES,
  assertStageEvidenceFn = assertStageEvidence
} = {}) {
  const verified = verifyOperationInventory(
    inventory,
    key,
    contract,
    envFilePath,
    { testOnlyAllowSynthetic, requiredStages }
  );
  verifyPrivateArtifactProtection(envFilePath);
  const loaded = loadEnvFile(envFilePath);
  let evidenceRoot = '';
  const operations = new Map(verified.operations.map((operation) => [operation.stage, operation]));
  const runCounts = new Map();
  return {
    async run(stage, context = {}) {
      if (!evidenceRoot) {
        evidenceRoot = createPrivateDirectory(evidenceDirectory);
        verifyPrivateDirectoryProtection(evidenceRoot);
      }
      const operation = operations.get(stage);
      if (!operation) throw categoricalError('DEV_REFRESH_OPERATION_STAGE_UNAVAILABLE');
      verifyExecutable(operation);
      const runCount = (runCounts.get(stage) || 0) + 1;
      if (runCount > (stage === 'WORKFLOW_CERTIFICATION' ? 2 : 1)) {
        throw categoricalError('DEV_REFRESH_OPERATION_RETRY_REJECTED');
      }
      runCounts.set(stage, runCount);
      const stem = `${stage.toLowerCase().replaceAll('_', '-')}-${runCount}`;
      const resultPath = path.join(evidenceRoot, `${stem}.raw.private.json`);
      const acceptedPath = path.join(evidenceRoot, `${stem}.accepted.private.json`);
      if (fs.existsSync(resultPath) || fs.existsSync(acceptedPath)) {
        throw categoricalError('DEV_REFRESH_OPERATION_RESULT_COLLISION');
      }
      const args = operation.runtime === 'node'
        ? [operation.script, ...operation.args]
        : operation.args;
      const recoveryDatabaseMode = String(context.recoveryDatabaseMode || '');
      const environmentNames = stage === 'REMEDIATION_RECOVERY_DATABASE' &&
        recoveryDatabaseMode === 'EXECUTE_ONCE'
        ? []
        : operation.environmentNames;
      const env = minimalEnvironment(loaded.values, environmentNames, {
        DEV_REFRESH_TARGET: 'dev',
        DEV_REFRESH_PROJECT_REF: DEV_PROJECT_REF,
        DEV_REFRESH_ATTEMPT_ID: contract.attemptId,
        DEV_REFRESH_STAGE: stage,
        DEV_REFRESH_CONTRACT_DIGEST: contract.contractDigest,
        DEV_REFRESH_OPERATION_INVENTORY_DIGEST: verified.inventoryDigest,
        DEV_REFRESH_RESULT_FD: '3',
        DEV_REFRESH_AUTHORITY_KEY_FD: '4',
        DEV_REFRESH_STATE_DIR: path.resolve(String(context.rootDirectory || '')),
        ...(recoveryDatabaseMode
          ? { DEV_REFRESH_RECOVERY_DATABASE_MODE: recoveryDatabaseMode }
          : {})
      });
      const { descriptor } = openPrivateFileExclusive(resultPath);
      let operationFailed = false;
      try {
        await runOperationChild(operation, args, env, descriptor, key);
      } catch {
        operationFailed = true;
      } finally {
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
      }
      if (fsyncDirectory(path.dirname(resultPath)) === 'failed') {
        throw categoricalError('DEV_REFRESH_OPERATION_DIRECTORY_FSYNC_FAILED');
      }
      if (operationFailed) {
        const failure = readOperationFailure(resultPath, key, contract, stage);
        throw categoricalError(
          failure?.category || `DEV_REFRESH_${stage}_OPERATION_FAILED`,
          failure?.cause || null
        );
      }
      const evidence = readOperationResult(resultPath, contract, stage, assertStageEvidenceFn);
      writePrivateJsonExclusive(acceptedPath, {
        format: OPERATION_RESULT_FORMAT,
        evidence,
        authentication: { algorithm: 'hmac-sha256-v1', digest: signPayload(evidence, key) }
      });
      return evidence;
    }
  };
}

export {
  OPERATION_INVENTORY_FORMAT,
  OPERATION_RESULT_FORMAT,
  REQUIRED_OPERATION_STAGES,
  authenticateOperationInventory,
  buildOperationInventory,
  createOperationExecutor,
  normalizeOperation,
  verifyOperationInventory
};
