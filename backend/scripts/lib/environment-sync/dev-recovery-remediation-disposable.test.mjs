import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

import pg from 'pg';

import {
  DEV_PROJECT_REF,
  verifyAuthenticatedCertifiedRefreshContract
} from './dev-certified-contract.mjs';
import { createOperationExecutor } from './dev-certified-operation-executor.mjs';
import { runCertifiedDevRecovery, runCertifiedDevRefresh } from './dev-certified-orchestrator.mjs';
import { prepareCertifiedDevRefresh } from './dev-certified-preparation.mjs';
import { readStageState } from './dev-certified-stage-state.mjs';
import { readJournal } from './dev-certified-state.mjs';
import { removeRetainedDisposablePostgres } from './disposable-postgres.mjs';
import {
  REMEDIATION_OPERATION_STAGES,
  assertRecoveryRemediationEvidence,
  remediationStageEnvironmentNames,
  verifyAuthenticatedRecoveryRemediationContract
} from './dev-recovery-remediation-contract.mjs';
import {
  runDevRecoveryRemediation,
  runDevRecoveryRemediationRecovery
} from './dev-recovery-remediation-orchestrator.mjs';
import {
  prepareDevRecoveryRemediation,
  readPreparationAuthCanary
} from './dev-recovery-remediation-preparation.mjs';
import {
  readRemediationAuthCanaries,
  readRemediationEvents,
  readRemediationJournal,
  remediationAuthCanaryDisposition
} from './dev-recovery-remediation-state.mjs';
import {
  createPrivateDirectory,
  writePrivateBytesExclusive
} from './private-artifacts.mjs';
import { applyManagedAuthPrivilegeProfile } from './managed-restore-rehearsal.mjs';
import { verifyManagedOverlayPackageForExecution } from './managed-restore.mjs';

const { Client } = pg;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const PREPARE_ENTRY = path.join(REPO_ROOT, 'backend', 'scripts', 'environment-prepare-dev-recovery-remediation-certified.mjs');
const RECOVERY_ENTRY = path.join(REPO_ROOT, 'backend', 'scripts', 'environment-recover-dev-recovery-remediation-certified.mjs');

function temporaryRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function syntheticAccessToken(userId, sessionId) {
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, session_id: sessionId })}.synthetic`;
}

function readPrivateJson(filePath) {
  const bytes = fs.readFileSync(filePath);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } finally {
    bytes.fill(0);
  }
}

function directoryByteDigest(root) {
  const hash = crypto.createHash('sha256');
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      Buffer.from(a.name, 'utf8').compare(Buffer.from(b.name, 'utf8')))) {
      const relative = path.relative(root, path.join(directory, entry.name)).replaceAll('\\', '/');
      hash.update(Buffer.from(relative, 'utf8'));
      if (entry.isDirectory()) visit(path.join(directory, entry.name));
      else {
        const bytes = fs.readFileSync(path.join(directory, entry.name));
        try { hash.update(bytes); } finally { bytes.fill(0); }
      }
    }
  };
  visit(root);
  return `sha256:${hash.digest('hex')}`;
}

function copyPrivateDirectory(sourceRoot, targetRoot) {
  createPrivateDirectory(targetRoot);
  const copyEntries = (sourceDirectory, targetDirectory) => {
    for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
      const sourcePath = path.join(sourceDirectory, entry.name);
      const targetPath = path.join(targetDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        throw Object.assign(new Error('PRIVATE_ARTIFACT_LINK_UNSUPPORTED'), {
          code: 'PRIVATE_ARTIFACT_LINK_UNSUPPORTED'
        });
      }
      if (entry.isDirectory()) {
        createPrivateDirectory(targetPath);
        copyEntries(sourcePath, targetPath);
        continue;
      }
      if (!entry.isFile()) {
        throw Object.assign(new Error('PRIVATE_ARTIFACT_TYPE_UNSUPPORTED'), {
          code: 'PRIVATE_ARTIFACT_TYPE_UNSUPPORTED'
        });
      }
      const bytes = fs.readFileSync(sourcePath);
      try {
        writePrivateBytesExclusive(targetPath, bytes);
      } finally {
        bytes.fill(0);
      }
    }
  };
  copyEntries(sourceRoot, targetRoot);
}

function replacePrivateBytesDurably(filePath, bytes) {
  const descriptor = fs.openSync(filePath, 'r+');
  try {
    fs.ftruncateSync(descriptor, 0);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(filePath, 0o600);
}

function childFailureCategory(result) {
  const diagnostic = `${String(result?.stderr || '')}\n${String(result?.stdout || '')}`;
  const category = diagnostic.match(/\b(?:DEV|MANAGED|PRIVATE|AUTH|R3)_[A-Z0-9_]{2,156}\b/)?.[0];
  if (category) return category;
  if (result?.signal) {
    return `SIGNAL_${String(result.signal).replace(/[^A-Z0-9_]/gi, '_').toUpperCase()}`;
  }
  return `EXIT_${Number.isInteger(result?.status) ? result.status : 'UNKNOWN'}`;
}

async function startLocalApplicationHarness() {
  const seen = [];
  let binding = null;
  const canarySessionIds = new Set();
  let preexistingSessionId = '';
  let failNextLogout = false;
  let retainLogoutRows = 0;
  const databaseMutation = async (kind, exactSessionId = '') => {
    if (!binding) throw new Error('LOCAL_AUTH_BINDING_MISSING');
    const client = new Client({ connectionString: binding.connectionString });
    await client.connect();
    try {
      if (kind === 'login') {
        const sessionId = crypto.randomUUID();
        canarySessionIds.add(sessionId);
        await client.query("update auth.users set last_sign_in_at=greatest(clock_timestamp(),coalesce(last_sign_in_at,'epoch')+interval '1 second'), updated_at=greatest(clock_timestamp(),updated_at+interval '1 second') where id=$1::uuid", [binding.userId]);
        await client.query("update auth.identities set last_sign_in_at=greatest(clock_timestamp(),coalesce(last_sign_in_at,'epoch')+interval '1 second'), updated_at=greatest(clock_timestamp(),updated_at+interval '1 second') where user_id=$1::uuid", [binding.userId]);
        await client.query('insert into auth.sessions(id,user_id,created_at,updated_at) values ($1::uuid,$2::uuid,clock_timestamp(),clock_timestamp())', [sessionId, binding.userId]);
        await client.query(
          'insert into auth.refresh_tokens(token,user_id,revoked,created_at,updated_at,session_id) values ($3,$1::text,false,clock_timestamp(),clock_timestamp(),$2::uuid)',
          [binding.userId, sessionId, `local-only-${sessionId}`]
        );
        return sessionId;
      } else {
        if (!canarySessionIds.has(exactSessionId)) throw new Error('LOCAL_AUTH_SESSION_TARGET_INVALID');
        await client.query('delete from auth.refresh_tokens where session_id=$1::uuid', [exactSessionId]);
        await client.query('delete from auth.sessions where id=$1::uuid and user_id=$2::uuid', [exactSessionId, binding.userId]);
        canarySessionIds.delete(exactSessionId);
      }
    } finally {
      await client.end();
    }
  };
  const server = http.createServer(async (request, response) => {
    request.on('error', () => {});
    response.on('error', () => {});
    const requestUrl = new URL(request.url, 'http://localhost');
    seen.push(`${request.method} ${requestUrl.pathname}${requestUrl.search}`);
    response.setHeader('content-type', 'application/json');
    response.setHeader('connection', 'close');
    if (request.url.startsWith('/auth/v1/token')) {
      const sessionId = await databaseMutation('login');
      response.end(JSON.stringify({
        access_token: syntheticAccessToken(binding.userId, sessionId),
        refresh_token: 'local-refresh',
        user: { id: binding.userId }
      }));
      return;
    }
    if (request.url === '/auth/v1/logout?scope=local') {
      if (failNextLogout) {
        failNextLogout = false;
        response.statusCode = 503;
        response.end('{}');
        return;
      }
      const token = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const payload = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8'));
      if (retainLogoutRows > 0) retainLogoutRows -= 1;
      else await databaseMutation('logout', String(payload.session_id || ''));
      response.end('{}');
      return;
    }
    if (request.url === '/functions/v1/api?path=%2Fhealth') {
      response.end(JSON.stringify({ data: { version: 'v1', status: 'ACTIVE' } }));
      return;
    }
    if (request.url === '/functions/v1/api?path=%2Fauth%2Fcontext') {
      response.end(JSON.stringify({ data: {
        orgId: binding.organizationId, role: 'owner', defaultWarehouse: binding.defaultWarehouse
      } }));
      return;
    }
    response.end(JSON.stringify({ data: [] }));
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    seen,
    bind(value) {
      binding = value;
      canarySessionIds.clear();
      preexistingSessionId = '';
      failNextLogout = false;
      retainLogoutRows = 0;
    },
    async createPreexistingSession() {
      if (!binding || preexistingSessionId) throw new Error('LOCAL_PREEXISTING_SESSION_STATE_INVALID');
      preexistingSessionId = crypto.randomUUID();
      const client = new Client({ connectionString: binding.connectionString });
      await client.connect();
      try {
        await client.query(
          'insert into auth.sessions(id,user_id,created_at,updated_at) values ($1::uuid,$2::uuid,clock_timestamp(),clock_timestamp())',
          [preexistingSessionId, binding.userId]
        );
        await client.query(
          'insert into auth.refresh_tokens(token,user_id,revoked,created_at,updated_at,session_id) values ($3,$1::text,false,clock_timestamp(),clock_timestamp(),$2::uuid)',
          [binding.userId, preexistingSessionId, `local-preexisting-${preexistingSessionId}`]
        );
      } finally {
        await client.end();
      }
    },
    async preexistingSessionIntact() {
      const client = new Client({ connectionString: binding.connectionString });
      await client.connect();
      try {
        const row = (await client.query(
          `select
             count(*) filter (where s.id=$1::uuid)::integer as sessions,
             count(r.*) filter (where s.id=$1::uuid)::integer as refresh_tokens
           from auth.sessions s
           left join auth.refresh_tokens r on r.session_id=s.id
          where s.user_id=$2::uuid`,
          [preexistingSessionId, binding.userId]
        )).rows[0];
        return Number(row?.sessions || 0) === 1 && Number(row?.refresh_tokens || 0) === 1;
      } finally {
        await client.end();
      }
    },
    async taskOwnedEphemeraCounts() {
      const client = new Client({ connectionString: binding.connectionString });
      await client.connect();
      try {
        const row = (await client.query(
          `select
             count(*) filter (where s.id<>$1::uuid)::integer as sessions,
             count(r.*) filter (where s.id<>$1::uuid)::integer as refresh_tokens
           from auth.sessions s
           left join auth.refresh_tokens r on r.session_id=s.id
          where s.user_id=$2::uuid`,
          [preexistingSessionId, binding.userId]
        )).rows[0];
        return {
          sessions: Number(row?.sessions || 0),
          refreshTokens: Number(row?.refresh_tokens || 0)
        };
      } finally {
        await client.end();
      }
    },
    async cleanupCurrentCanarySession() {
      for (const sessionId of [...canarySessionIds]) await databaseMutation('logout', sessionId);
    },
    safeTrafficSummary() {
      return Object.fromEntries([...new Set(seen)].sort().map((route) => [
        route,
        seen.filter((entry) => entry === route).length
      ]));
    },
    failOneLogout() { failNextLogout = true; },
    retainNextLogoutRows(count = 1) { retainLogoutRows = count; },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test('real disposable failed recovery is remediated from original Y2 with R3 fallback', {
  skip: process.env.RUN_ENV_SYNC_REMEDIATION_E2E !== '1'
}, async () => {
  const retainedRoot = String(process.env.ENV_SYNC_RETAINED_ROOT || '');
  const postgresBin = String(process.env.POSTGRES_BIN || '');
  assert.ok(path.isAbsolute(retainedRoot) && path.isAbsolute(postgresBin));
  const root = temporaryRoot('dev-recovery-remediation-e2e-');
  const key = crypto.randomBytes(32);
  const clusters = [];
  const timings = { r3Capture: [], r3Validated: [], remediation: [], recovery: [] };
  const harness = await startLocalApplicationHarness();
  try {
    const keyPath = path.join(root, 'authority.private.bin');
    const refreshEnvPath = path.join(root, 'refresh.private.env');
    const remediationEnvPath = path.join(root, 'remediation.private.env');
    writePrivateBytesExclusive(keyPath, key);
    writePrivateBytesExclusive(refreshEnvPath, Buffer.from(
      `APP_ENV=dev\nSUPABASE_URL=https://${DEV_PROJECT_REF}.supabase.co\n` +
      `DATABASE_URL=postgresql://postgres:synthetic@db.${DEV_PROJECT_REF}.supabase.co:5432/postgres\n`,
      'utf8'
    ));
    writePrivateBytesExclusive(remediationEnvPath, Buffer.from(
      `APP_ENV=dev\nSUPABASE_URL=${harness.origin}\nEDGE_API_BASE_URL=${harness.origin}/functions/v1/api\n` +
      'SUPABASE_ANON_KEY=local-anon\nSMOKE_USER_EMAIL=local@example.invalid\n' +
      'SMOKE_USER_PASSWORD=local-only\n',
      'utf8'
    ));

    const createFailedRecovery = async (label) => {
      const prepared = await prepareCertifiedDevRefresh({
        repoRoot: REPO_ROOT,
        envFilePath: refreshEnvPath,
        authorityKeyPath: keyPath,
        retainedRoot,
        outputDirectory: path.join(root, `${label}-refresh-preparation`),
        disposable: true,
        postgresBin
      });
      const preparationRecord = readPrivateJson(prepared.output.preparationPath);
      const preparation = preparationRecord.preparation;
      clusters.push(preparation.targetBefore.session.root);
      const nativePreferenceClient = new Client({
        connectionString: preparation.targetBefore.session.connectionString
      });
      await nativePreferenceClient.connect();
      try {
        const preference = await nativePreferenceClient.query(`
          insert into app.user_preferences(org_id,user_id,default_warehouse,updated_by)
          values ($1::uuid,$2::uuid,'','disposable-remediation-e2e')
          on conflict (org_id,user_id) do update
            set default_warehouse='',
                updated_at=clock_timestamp(),
                updated_by=excluded.updated_by
          returning default_warehouse`, [
          preparation.fixtureAuthority.primaryOrganizationId,
          preparation.fixtureAuthority.smokeActorId
        ]);
        assert.equal(preference.rowCount, 1);
        assert.equal(preference.rows[0].default_warehouse, '');
      } finally {
        await nativePreferenceClient.end();
      }
      const contract = verifyAuthenticatedCertifiedRefreshContract(
        readPrivateJson(prepared.output.contractPath), key
      );
      const baseExecutor = createOperationExecutor({
        inventory: readPrivateJson(prepared.output.inventoryPath),
        key,
        contract,
        envFilePath: refreshEnvPath,
        evidenceDirectory: path.join(root, `${label}-refresh-evidence`)
      });
      const stateDirectory = path.join(root, `${label}-failed-recovery-state`);
      await assert.rejects(runCertifiedDevRefresh({
        rootDirectory: stateDirectory,
        key,
        contract,
        executor: {
          async run(stage, context) {
            const evidence = await baseExecutor.run(stage, context);
            if (stage === 'DATABASE_CUTOVER') {
              throw Object.assign(new Error('DISPOSABLE_POST_CUTOVER_FAILURE'), {
                code: 'DISPOSABLE_POST_CUTOVER_FAILURE'
              });
            }
            return evidence;
          }
        }
      }), { code: 'DEV_REFRESH_RECOVERY_REQUIRED' });
      await assert.rejects(runCertifiedDevRecovery({
        rootDirectory: stateDirectory,
        key,
        contract,
        executor: {
          async run(stage, context) {
            const evidence = await baseExecutor.run(stage, context);
            if (stage === 'RECOVERY_DATABASE') {
              throw Object.assign(new Error('DISPOSABLE_UNKNOWN_RECOVERY_OUTCOME'), {
                code: 'DISPOSABLE_UNKNOWN_RECOVERY_OUTCOME'
              });
            }
            return evidence;
          }
        }
      }), { code: 'DEV_REFRESH_RECOVERY_FAILED' });
      const journal = readJournal(stateDirectory, key);
      assert.equal(journal.current.state, 'RECOVERY_FAILED');
      assert.equal(journal.recovery.retryAllowed, false);
      const y2 = readStageState({
        rootDirectory: stateDirectory,
        key,
        attemptId: contract.attemptId,
        stage: 'Y2_VALIDATED'
      });
      const privilegeConnection = new URL(preparation.targetBefore.session.connectionString);
      privilegeConnection.username = 'cluster_admin';
      await applyManagedAuthPrivilegeProfile(privilegeConnection.toString(), 'live-like-remediation');
      const client = new Client({ connectionString: preparation.targetBefore.session.connectionString });
      await client.connect();
      try {
        const privileges = (await client.query(`select
          has_table_privilege(current_user,'auth.schema_migrations','select') as can_select,
          has_table_privilege(current_user,'auth.schema_migrations','insert') as can_insert,
          has_table_privilege(current_user,'auth.schema_migrations','update') as can_update,
          has_table_privilege(current_user,'auth.schema_migrations','delete') as can_delete`)).rows[0];
        assert.deepEqual(privileges, {
          can_select: true, can_insert: false, can_update: false, can_delete: false
        });
        const preference = (await client.query(
          'select default_warehouse from app.user_preferences where org_id=$1::uuid and user_id=$2::uuid',
          [preparation.fixtureAuthority.primaryOrganizationId, preparation.fixtureAuthority.smokeActorId]
        )).rows[0];
        harness.bind({
          connectionString: preparation.targetBefore.session.connectionString,
          userId: preparation.fixtureAuthority.smokeActorId,
          organizationId: preparation.fixtureAuthority.primaryOrganizationId,
          defaultWarehouse: String(preference?.default_warehouse || '')
        });
        await harness.createPreexistingSession();
      } finally {
        await client.end();
      }
      return {
        contract,
        preparation,
        preparationPath: prepared.output.preparationPath,
        contractPath: prepared.output.contractPath,
        stateDirectory,
        y2,
        immutableDigest: directoryByteDigest(stateDirectory)
      };
    };

    const prepareRemediation = async (label, failed) => {
      const prepared = await prepareDevRecoveryRemediation({
        repoRoot: REPO_ROOT,
        envFilePath: remediationEnvPath,
        authorityKeyPath: keyPath,
        originalContractPath: failed.contractPath,
        originalPreparationPath: failed.preparationPath,
        failedStateDirectory: failed.stateDirectory,
        expectedRefreshAttemptId: failed.contract.attemptId,
        expectedY2RecoveryId: failed.y2.recoveryId,
        outputDirectory: path.join(root, `${label}-remediation-preparation`),
        postgresBin,
        disposable: true
      });
      assert.equal(prepared.r3Created, false);
      assert.equal(prepared.sharedMutations, 0);
      const contract = verifyAuthenticatedRecoveryRemediationContract(
        readPrivateJson(prepared.output.contractPath), key
      );
      const inventoryRecord = readPrivateJson(prepared.output.inventoryPath);
      assert.deepEqual(
        inventoryRecord.inventory.operations.map(({ stage, environmentNames }) => ({ stage, environmentNames })),
        REMEDIATION_OPERATION_STAGES.map((stage) => ({
          stage,
          environmentNames: remediationStageEnvironmentNames(stage, { disposable: true })
        }))
      );
      const executor = createOperationExecutor({
        inventory: inventoryRecord,
        key,
        contract,
        envFilePath: remediationEnvPath,
        evidenceDirectory: path.join(root, `${label}-remediation-evidence`),
        requiredStages: REMEDIATION_OPERATION_STAGES,
        assertStageEvidenceFn: assertRecoveryRemediationEvidence
      });
      return { prepared, contract, executor, inventoryRecord };
    };

    let preparationCliOrdinal = 0;
    const runPreparationCli = ({ failed, outputDirectory, crashPoint = '' }) => {
      preparationCliOrdinal += 1;
      const processRoot = path.join(root, `preparation-cli-${preparationCliOrdinal}`);
      const home = path.join(processRoot, 'home');
      const temp = path.join(processRoot, 'temp');
      fs.mkdirSync(home, { recursive: true });
      fs.mkdirSync(temp, { recursive: true });
      const args = [
        PREPARE_ENTRY,
        '--env', remediationEnvPath,
        '--authority-key', keyPath,
        '--original-contract', failed.contractPath,
        '--original-preparation', failed.preparationPath,
        '--failed-state-dir', failed.stateDirectory,
        '--expected-original-attempt', failed.contract.attemptId,
        '--expected-original-y2', failed.y2.recoveryId,
        '--output-dir', outputDirectory,
        '--side-effect-certificate', failed.preparationPath,
        '--edge-certificate', failed.preparationPath,
        '--postgres-bin', postgresBin,
        '--disposable-local'
      ];
      if (crashPoint) args.push('--disposable-canary-crash-point', crashPoint);
      const child = spawn(process.execPath, args, {
        cwd: REPO_ROOT,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: {
          SystemRoot: process.env.SystemRoot || '',
          WINDIR: process.env.WINDIR || '',
          PATH: process.env.PATH || '',
          HOME: home,
          USERPROFILE: home,
          TEMP: temp,
          TMP: temp,
          RUN_ENV_SYNC_REMEDIATION_E2E: '1',
          ...(crashPoint
            ? { RUN_ENV_SYNC_REMEDIATION_PREPARATION_CRASH_POINT: crashPoint }
            : {})
        }
      });
      return new Promise((resolve) => {
        let terminationRequested = false;
        let barrierObserved = false;
        let finished = false;
        const terminateChild = () => {
          if (terminationRequested || finished) return;
          try {
            if (process.platform === 'win32') {
              execFileSync('taskkill.exe', ['/PID', String(child.pid), '/F'], {
                shell: false,
                windowsHide: true,
                stdio: 'ignore'
              });
              terminationRequested = true;
            } else {
              terminationRequested = child.kill('SIGKILL');
            }
          } catch {
            terminationRequested = child.kill('SIGKILL');
          }
        };
        const crashWatchdog = crashPoint ? setTimeout(terminateChild, 300_000) : null;
        const limit = 8 * 1024;
        let stdout = '';
        let stderr = '';
        const append = (current, chunk) => `${current}${chunk.toString('utf8')}`.slice(-limit);
        child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
        child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
        child.on('message', (message) => {
          if (
            message?.type === 'DEV_REMEDIATION_PREPARATION_CRASH_BARRIER' &&
            message.point === crashPoint
          ) {
            barrierObserved = true;
            terminateChild();
          }
        });
        const finish = (status, signal) => {
          if (finished) return;
          finished = true;
          if (crashWatchdog) clearTimeout(crashWatchdog);
          resolve({ status, signal, stdout, stderr, barrierObserved });
        };
        child.once('error', () => finish(1, null));
        child.once('close', finish);
      });
    };

    let recoveryCliOrdinal = 0;
    const runRecoveryCli = ({ recovery, stateDirectory, crashPoint = '' }) => {
      recoveryCliOrdinal += 1;
      const processRoot = path.join(root, `recovery-cli-${recoveryCliOrdinal}`);
      const home = path.join(processRoot, 'home');
      const temp = path.join(processRoot, 'temp');
      fs.mkdirSync(home, { recursive: true });
      fs.mkdirSync(temp, { recursive: true });
      const child = spawn(process.execPath, [
        RECOVERY_ENTRY,
        '--apply',
        '--quiet-window-active',
        '--remediation-recovery-authorized',
        '--disposable-local',
        '--env', remediationEnvPath,
        '--authority-key', keyPath,
        '--preparation', recovery.prepared.output.preparationPath,
        '--contract', recovery.prepared.output.contractPath,
        '--operation-inventory', recovery.prepared.output.inventoryPath,
        '--state-dir', stateDirectory,
        '--evidence-dir', path.join(processRoot, 'evidence-private')
      ], {
        cwd: REPO_ROOT,
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
        env: {
          SystemRoot: process.env.SystemRoot || '',
          WINDIR: process.env.WINDIR || '',
          PATH: process.env.PATH || '',
          HOME: home,
          USERPROFILE: home,
          TEMP: temp,
          TMP: temp,
          RUN_ENV_SYNC_REMEDIATION_E2E: '1',
          ...(crashPoint ? { DEV_REMEDIATION_DISPOSABLE_CLI_CRASH_POINT: crashPoint } : {})
        }
      });
      return new Promise((resolve) => {
        const limit = 8 * 1024;
        let stdout = '';
        let stderr = '';
        const append = (current, chunk) => `${current}${chunk.toString('utf8')}`.slice(-limit);
        child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
        child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
        child.once('error', () => resolve({ status: 1, signal: null, stdout, stderr }));
        child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
      });
    };

    const successFailure = await createFailedRecovery('success');
    const preparationCrashCases = [
      ['AFTER_CANARY_LOGIN_SUCCEEDED', 'LOGIN_SUCCEEDED', { sessions: 1, refreshTokens: 1 }],
      ['DURING_CANARY_APPLICATION_READ', 'LOGIN_SUCCEEDED', { sessions: 1, refreshTokens: 1 }],
      ['DURING_CANARY_LOGOUT', 'LOGOUT_ATTEMPTED', { sessions: 1, refreshTokens: 1 }],
      ['AFTER_CANARY_LOGOUT_BEFORE_COMPLETE', 'LOGOUT_SUCCEEDED', { sessions: 0, refreshTokens: 0 }]
    ];
    for (const [point, expectedState, expectedResidue] of preparationCrashCases) {
      const outputDirectory = path.join(root, `preparation-kill-${point.toLowerCase()}`);
      const beforeLogins = harness.seen.filter((entry) =>
        entry === 'POST /auth/v1/token?grant_type=password').length;
      const killed = await runPreparationCli({
        failed: successFailure,
        outputDirectory,
        crashPoint: point
      });
      assert.equal(killed.barrierObserved, true, `${point}:PREPARATION_BARRIER_NOT_OBSERVED`);
      assert.ok(killed.status !== 0 || killed.signal, `${point}:PREPARATION_CHILD_DID_NOT_STOP`);
      const durable = readPreparationAuthCanary(outputDirectory, key);
      assert.equal(durable.current.state, expectedState, point);
      assert.ok(durable.allowance);
      assert.deepEqual(await harness.taskOwnedEphemeraCounts(), expectedResidue);
      const blocked = await runPreparationCli({ failed: successFailure, outputDirectory });
      assert.ok(blocked.status !== 0 || blocked.signal, `${point}:PREPARATION_REUSE_NOT_BLOCKED`);
      assert.equal(harness.seen.filter((entry) =>
        entry === 'POST /auth/v1/token?grant_type=password').length, beforeLogins + 1);
      await harness.cleanupCurrentCanarySession();
      assert.deepEqual(await harness.taskOwnedEphemeraCounts(), { sessions: 0, refreshTokens: 0 });
    }
      const providerLag = await prepareRemediation('provider-lag', successFailure);
      const providerLagState = path.join(root, 'provider-lag-preboundary-state');
      const providerLagExecutor = createOperationExecutor({
        inventory: providerLag.inventoryRecord,
        key,
        contract: providerLag.contract,
        envFilePath: remediationEnvPath,
        evidenceDirectory: path.join(root, 'provider-lag-preboundary-evidence'),
        requiredStages: REMEDIATION_OPERATION_STAGES,
        assertStageEvidenceFn: assertRecoveryRemediationEvidence
      });
      harness.retainNextLogoutRows(1);
      await assert.rejects(runDevRecoveryRemediation({
        rootDirectory: providerLagState,
        key,
        contract: providerLag.contract,
        executor: providerLagExecutor
      }));
      const providerLagJournal = readRemediationJournal(providerLagState, key);
      assert.equal(providerLagJournal.current.state, 'FAILED_PRE_MUTATION');
      assert.equal(providerLagJournal.marker, null);
      const providerLagDisposition = remediationAuthCanaryDisposition(providerLagState, key);
      assert.equal(
        providerLagDisposition.canaryCount,
        1,
        providerLagJournal.current.failureCategory
      );
      assert.equal(providerLagDisposition.completedCount, 1);
      assert.equal(providerLagDisposition.sessionRevoked, false);
      assert.equal(providerLagDisposition.boundedEphemeraPossible, true);
      assert.equal(providerLagDisposition.unresolvedCount, 1);
      assert.deepEqual(providerLagDisposition.unresolvedPurposes, ['REMEDIATION_PRECHECK']);
      assert.equal(providerLagDisposition.unboundCanaryCount, 0);
      assert.equal(providerLagDisposition.allowedNativeEphemera.sessions.length, 1);
      assert.equal(providerLagDisposition.allowedNativeEphemera.refreshTokens.length, 1);
      await harness.cleanupCurrentCanarySession();
      assert.deepEqual(await harness.taskOwnedEphemeraCounts(), { sessions: 0, refreshTokens: 0 });

      const success = await prepareRemediation('success', successFailure);
      const successState = path.join(root, 'success-remediation-state');
      let completed;
      const remediationStarted = performance.now();
      try {
        completed = await runDevRecoveryRemediation({
          rootDirectory: successState,
          key,
          contract: success.contract,
          executor: {
            async run(stage, context) {
              const started = performance.now();
              try {
                return await success.executor.run(stage, context);
              } finally {
                if (stage === 'R3_CAPTURE') timings.r3Capture.push(performance.now() - started);
                if (stage === 'R3_VALIDATED') timings.r3Validated.push(performance.now() - started);
              }
            }
          }
        });
      } catch (error) {
        throw Object.assign(new Error(
          `DISPOSABLE_SUCCESS_REMEDIATION_${error?.failedStage || 'UNKNOWN'}_${error?.causeCategory || error?.code || 'UNKNOWN'}_TRAFFIC_${JSON.stringify(harness.safeTrafficSummary())}`
        ), { code: 'DISPOSABLE_SUCCESS_REMEDIATION_FAILED' });
      }
      timings.remediation.push(performance.now() - remediationStarted);
      assert.equal(completed.classification, 'DEV_RECOVERY_REMEDIATION_COMPLETE');
      assert.equal(readRemediationJournal(successState, key).current.state, 'REMEDIATION_COMPLETE');
      assert.equal(readStageState({
        rootDirectory: successState,
        key,
        attemptId: success.contract.remediationAttemptId,
        stage: 'FINAL_Y2_PARITY'
      }).ephemeralSessionException, false);
      assert.equal(directoryByteDigest(successFailure.stateDirectory), successFailure.immutableDigest);

    const recoveryFailure = await createFailedRecovery('r3-recovery');
    const recovery = await prepareRemediation('r3-recovery', recoveryFailure);
    const recoveryState = path.join(root, 'r3-recovery-remediation-state');
    const authCrashPath = path.join(recoveryState, 'disposable-test-crash-point.private.txt');
    let authKillVariantsComplete = false;
    let authKillVariantPoint = 'NOT_STARTED';
    const runAuthKillVariant = async (point, expectedState, expectedResidue) => {
      authKillVariantPoint = point;
      const clone = path.join(root, `auth-kill-${point.toLowerCase()}-state`);
      copyPrivateDirectory(recoveryState, clone);
      const crashPath = path.join(clone, 'disposable-test-crash-point.private.txt');
      writePrivateBytesExclusive(crashPath, Buffer.from(`${point}\n`, 'utf8'));
      const variantExecutor = createOperationExecutor({
        inventory: recovery.inventoryRecord,
        key,
        contract: recovery.contract,
        envFilePath: remediationEnvPath,
        evidenceDirectory: path.join(root, `auth-kill-${point.toLowerCase()}-evidence`),
        requiredStages: REMEDIATION_OPERATION_STAGES,
        assertStageEvidenceFn: assertRecoveryRemediationEvidence
      });
      await assert.rejects(variantExecutor.run('AUTH_RUNTIME_VERIFIED', {
        rootDirectory: clone,
        contract: recovery.contract
      }));
      fs.rmSync(crashPath, { force: true });
      const canary = readRemediationAuthCanaries(clone, key).at(-1);
      assert.equal(canary.current.state, expectedState);
      assert.ok(canary.allowance);
      assert.deepEqual(await harness.taskOwnedEphemeraCounts(), expectedResidue);
      await harness.cleanupCurrentCanarySession();
      assert.deepEqual(await harness.taskOwnedEphemeraCounts(), { sessions: 0, refreshTokens: 0 });
    };
    let interruptedRemediationError;
    await assert.rejects(runDevRecoveryRemediation({
      rootDirectory: recoveryState,
      key,
      contract: recovery.contract,
        executor: {
          async run(stage, context) {
            if (stage === 'AUTH_RUNTIME_VERIFIED') {
              if (!authKillVariantsComplete) {
                await runAuthKillVariant(
                  'DURING_CANARY_APPLICATION_READ',
                  'LOGIN_SUCCEEDED',
                  { sessions: 1, refreshTokens: 1 }
                );
                await runAuthKillVariant(
                  'DURING_CANARY_LOGOUT',
                  'LOGOUT_ATTEMPTED',
                  { sessions: 1, refreshTokens: 1 }
                );
                await runAuthKillVariant(
                  'AFTER_CANARY_LOGOUT_BEFORE_COMPLETE',
                  'LOGOUT_SUCCEEDED',
                  { sessions: 0, refreshTokens: 0 }
                );
                authKillVariantsComplete = true;
                authKillVariantPoint = 'COMPLETE';
              }
              writePrivateBytesExclusive(
                authCrashPath,
                Buffer.from('AFTER_CANARY_LOGOUT_BEFORE_COMPLETE\n', 'utf8')
              );
            }
            const started = performance.now();
            try {
              return await recovery.executor.run(stage, context);
            } finally {
              if (stage === 'AUTH_RUNTIME_VERIFIED' && fs.existsSync(authCrashPath)) {
                fs.rmSync(authCrashPath, { force: true });
              }
              if (stage === 'R3_CAPTURE') timings.r3Capture.push(performance.now() - started);
              if (stage === 'R3_VALIDATED') timings.r3Validated.push(performance.now() - started);
            }
          }
      }
    }), (error) => {
      interruptedRemediationError = error;
      return error.code === 'DEV_REMEDIATION_RECOVERY_REQUIRED' &&
        error.transactionOutcome === 'committed';
    });
    assert.equal(
      interruptedRemediationError.failedStage,
      'AUTH_RUNTIME_VERIFIED',
      `${interruptedRemediationError.failedStage}:${interruptedRemediationError.causeCategory}`
    );
    assert.equal(readRemediationJournal(recoveryState, key).current.state, 'REMEDIATION_RECOVERY_REQUIRED');
    const interruptedCanaries = readRemediationAuthCanaries(recoveryState, key);
    assert.equal(
      authKillVariantsComplete,
      true,
      `${authKillVariantPoint}:${interruptedRemediationError.causeCategory}`
    );
    assert.ok(interruptedCanaries.some((canary) =>
      canary.current.purpose === 'REMEDIATION_PRECHECK' &&
      canary.current.state === 'EPHEMERA_RECONCILED'
    ));
    const directRecoveryState = path.join(root, 'r3-direct-recovery-remediation-state');
    copyPrivateDirectory(recoveryState, directRecoveryState);
    const mismatchRecoveryState = path.join(root, 'r3-mismatch-recovery-remediation-state');
    copyPrivateDirectory(recoveryState, mismatchRecoveryState);
    const tamperedRecoveryState = path.join(root, 'r3-tampered-recovery-remediation-state');
    copyPrivateDirectory(recoveryState, tamperedRecoveryState);
    const tamperedJournalPath = path.join(
      tamperedRecoveryState,
      fs.readdirSync(tamperedRecoveryState).filter((name) => /^\d{3}-/.test(name)).sort()[0]
    );
    const tamperedJournalBytes = fs.readFileSync(tamperedJournalPath);
    try {
      const changed = Buffer.from(
        tamperedJournalBytes.toString('utf8').replace('"target": "dev"', '"target": "bad"'),
        'utf8'
      );
      assert.notEqual(changed.compare(tamperedJournalBytes), 0);
      replacePrivateBytesDurably(tamperedJournalPath, changed);
      changed.fill(0);
    } finally {
      tamperedJournalBytes.fill(0);
    }
    assert.notEqual((await runRecoveryCli({
      recovery,
      stateDirectory: tamperedRecoveryState
    })).status, 0);
    const r3 = readStageState({
      rootDirectory: recoveryState,
      key,
      attemptId: recovery.contract.remediationAttemptId,
      stage: 'R3_VALIDATED'
    });
    const packageVerification = {
      connectionString: recoveryFailure.preparation.targetBefore.session.connectionString,
      packageResult: r3.recoveryPackage,
      targetGuard: { mode: 'disposable-managed-local', loopback: true }
    };
    assert.equal(verifyManagedOverlayPackageForExecution(packageVerification).authenticated, true);
    const scriptPath = r3.recoveryPackage.paths.scriptPath;
    const scriptBytes = fs.readFileSync(scriptPath);
    try {
      const script = scriptBytes.toString('utf8');
      const authStage = script
        .split('\\echo MANAGED_OVERLAY_STAGE_AUTH_PURGE\n')[1]
        ?.split('\\echo MANAGED_OVERLAY_STAGE_AUTH_PRESERVED')[0];
      assert.ok(authStage);
      assert.equal(r3.recoveryPackage.authMode, 'preserve-target-native-auth');
      const hasAuthTableDml = /^\s*(?:insert\s+into|update|delete\s+from|truncate(?:\s+table)?)\s+auth\./im
        .test(authStage);
      assert.equal(hasAuthTableDml, false);
      replacePrivateBytesDurably(scriptPath, Buffer.concat([scriptBytes, Buffer.from('\n-- tamper\n')]));
      assert.throws(
        () => verifyManagedOverlayPackageForExecution(packageVerification),
        { code: 'MANAGED_OVERLAY_ARTIFACT_MISMATCH' }
      );
      replacePrivateBytesDurably(scriptPath, scriptBytes);
    } finally {
      scriptBytes.fill(0);
    }
    const manifestPath = r3.recoveryPackage.paths.manifestPath;
    const heldManifestPath = path.join(path.dirname(manifestPath), 'held-package-artifact.private');
    fs.renameSync(manifestPath, heldManifestPath);
    try {
      assert.throws(() => verifyManagedOverlayPackageForExecution(packageVerification));
    } finally {
      fs.renameSync(heldManifestPath, manifestPath);
    }
    assert.equal(verifyManagedOverlayPackageForExecution(packageVerification).authenticated, true);
    const recoveryStarted = performance.now();
    const markerCrash = await runRecoveryCli({
      recovery,
      stateDirectory: recoveryState,
      crashPoint: 'AFTER_RECOVERY_MARKER'
    });
    assert.notEqual(markerCrash.status, 0);
    const markerCrashJournal = readRemediationJournal(recoveryState, key);
    assert.ok(
      markerCrashJournal.recovery,
      `${childFailureCategory(markerCrash)}:${markerCrashJournal.current.state}`
    );
    assert.equal(markerCrashJournal.recoveryBoundary, null);

    const databaseCrashPath = path.join(
      recoveryState,
      'disposable-test-crash-point.private.txt'
    );
    writePrivateBytesExclusive(
      databaseCrashPath,
      Buffer.from('AFTER_RECOVERY_DATABASE_COMMIT_BEFORE_STATE\n', 'utf8')
    );
    const commitWindowCrash = await runRecoveryCli({
      recovery,
      stateDirectory: recoveryState
    });
    fs.rmSync(databaseCrashPath, { force: true });
    assert.notEqual(commitWindowCrash.status, 0);
    assert.equal(
      readRemediationJournal(recoveryState, key).current.state,
      'REMEDIATION_RECOVERY_DATABASE_BOUNDARY'
    );

    const reconciledCrash = await runRecoveryCli({
      recovery,
      stateDirectory: recoveryState,
      crashPoint: 'AFTER_DATABASE_COMMITTED'
    });
    assert.notEqual(reconciledCrash.status, 0);
    assert.equal(
      readRemediationJournal(recoveryState, key).current.state,
      'REMEDIATION_RECOVERY_DATABASE_STATE_RECONCILED'
    );

    for (const [point, expectedState, expectedResidueAfterKill, expectedResidueAfterContinuation] of [
      ['DURING_CANARY_APPLICATION_READ', 'LOGIN_SUCCEEDED', 1, 1],
      ['DURING_CANARY_LOGOUT', 'LOGOUT_ATTEMPTED', 1, 1],
      ['AFTER_CANARY_LOGOUT_BEFORE_COMPLETE', 'LOGOUT_SUCCEEDED', 0, 0]
    ]) {
      const clone = path.join(root, `recovery-verification-${point.toLowerCase()}-state`);
      copyPrivateDirectory(recoveryState, clone);
      const crashPath = path.join(clone, 'disposable-test-crash-point.private.txt');
      writePrivateBytesExclusive(crashPath, Buffer.from(`${point}\n`, 'utf8'));
      const packageExecutionsBefore = readRemediationEvents(clone, key).filter((event) =>
        event.stage === 'REMEDIATION_RECOVERY_DATABASE' &&
        event.substep === 'RECOVERY_PACKAGE_EXECUTION_STARTED').length;
      const killed = await runRecoveryCli({ recovery, stateDirectory: clone });
      fs.rmSync(crashPath, { force: true });
      assert.ok(killed.status !== 0 || killed.signal, `${point}:RECOVERY_CHILD_DID_NOT_STOP`);
      assert.equal(readRemediationJournal(clone, key).current.state, 'REMEDIATION_RECOVERY_VERIFICATION_PENDING');
      const interrupted = readRemediationAuthCanaries(clone, key).at(-1);
      assert.equal(interrupted.current.purpose, 'RECOVERY_VERIFICATION');
      assert.equal(interrupted.current.state, expectedState);
      assert.ok(interrupted.allowance);
      assert.deepEqual(await harness.taskOwnedEphemeraCounts(), {
        sessions: expectedResidueAfterKill,
        refreshTokens: expectedResidueAfterKill
      });
      const continued = await runRecoveryCli({ recovery, stateDirectory: clone });
      assert.equal(continued.status, 0, childFailureCategory(continued));
      assert.equal(readRemediationJournal(clone, key).current.state, 'REMEDIATION_RECOVERED');
      assert.equal(readRemediationEvents(clone, key).filter((event) =>
        event.stage === 'REMEDIATION_RECOVERY_DATABASE' &&
        event.substep === 'RECOVERY_PACKAGE_EXECUTION_STARTED').length, packageExecutionsBefore);
      assert.deepEqual(await harness.taskOwnedEphemeraCounts(), {
        sessions: expectedResidueAfterContinuation,
        refreshTokens: expectedResidueAfterContinuation
      });
      assert.equal(await harness.preexistingSessionIntact(), true);
      await harness.cleanupCurrentCanarySession();
    }

    const noThirdLoginState = path.join(root, 'recovery-verification-no-third-login-state');
    copyPrivateDirectory(recoveryState, noThirdLoginState);
    const noThirdCrashPath = path.join(
      noThirdLoginState,
      'disposable-test-crash-point.private.txt'
    );
    writePrivateBytesExclusive(
      noThirdCrashPath,
      Buffer.from('DURING_CANARY_APPLICATION_READ\n', 'utf8')
    );
    const firstOrphan = await runRecoveryCli({
      recovery,
      stateDirectory: noThirdLoginState
    });
    fs.rmSync(noThirdCrashPath, { force: true });
    assert.ok(firstOrphan.status !== 0 || firstOrphan.signal);
    harness.retainNextLogoutRows(1);
    const secondResidue = await runRecoveryCli({
      recovery,
      stateDirectory: noThirdLoginState
    });
    assert.notEqual(secondResidue.status, 0);
    assert.equal(readRemediationJournal(noThirdLoginState, key).current.state, 'REMEDIATION_RECOVERY_VERIFICATION_PENDING');
    assert.equal(remediationAuthCanaryDisposition(noThirdLoginState, key).unresolvedCount, 2);
    const loginsBeforeThird = harness.seen.filter((entry) =>
      entry === 'POST /auth/v1/token?grant_type=password').length;
    const thirdBlocked = await runRecoveryCli({
      recovery,
      stateDirectory: noThirdLoginState
    });
    assert.notEqual(thirdBlocked.status, 0);
    assert.equal(harness.seen.filter((entry) =>
      entry === 'POST /auth/v1/token?grant_type=password').length, loginsBeforeThird);
    assert.equal(remediationAuthCanaryDisposition(noThirdLoginState, key).unresolvedCount, 2);
    await harness.cleanupCurrentCanarySession();

    const verificationCrash = await runRecoveryCli({
      recovery,
      stateDirectory: recoveryState,
      crashPoint: 'AFTER_VERIFICATION_COMPLETED'
    });
    assert.notEqual(verificationCrash.status, 0);
    assert.equal(
      readRemediationJournal(recoveryState, key).current.state,
      'REMEDIATION_RECOVERY_VERIFICATION_PENDING'
    );

    const verifiedCrash = await runRecoveryCli({
      recovery,
      stateDirectory: recoveryState,
      crashPoint: 'AFTER_VERIFIED_PUBLISHED'
    });
    assert.notEqual(verifiedCrash.status, 0);
    assert.equal(
      readRemediationJournal(recoveryState, key).current.state,
      'REMEDIATION_RECOVERY_VERIFIED'
    );

    const completedRecovery = await runRecoveryCli({ recovery, stateDirectory: recoveryState });
    assert.equal(completedRecovery.status, 0, completedRecovery.stderr);
    const recovered = JSON.parse(completedRecovery.stdout.trim());
    timings.recovery.push(performance.now() - recoveryStarted);
    assert.equal(recovered.classification, 'DEV_RECOVERY_REMEDIATION_R3_RECOVERED');
    assert.equal(readRemediationJournal(recoveryState, key).current.state, 'REMEDIATION_RECOVERED');
    assert.equal(readRemediationEvents(recoveryState, key).filter((event) =>
      event.stage === 'REMEDIATION_RECOVERY_DATABASE' &&
      event.substep === 'RECOVERY_PACKAGE_EXECUTION_STARTED').length, 1);
    const terminalReplay = await runRecoveryCli({ recovery, stateDirectory: recoveryState });
    assert.notEqual(terminalReplay.status, 0);

    const directCommitCrash = await runRecoveryCli({
      recovery,
      stateDirectory: directRecoveryState,
      crashPoint: 'AFTER_DATABASE_COMMITTED'
    });
    assert.notEqual(directCommitCrash.status, 0);
    assert.equal(
      readRemediationJournal(directRecoveryState, key).current.state,
      'REMEDIATION_RECOVERY_DATABASE_COMMITTED'
    );
    assert.equal(readRemediationEvents(directRecoveryState, key).filter((event) =>
      event.stage === 'REMEDIATION_RECOVERY_DATABASE' &&
      event.substep === 'RECOVERY_PACKAGE_EXECUTION_STARTED').length, 1);
    const directRecovery = await runRecoveryCli({ recovery, stateDirectory: directRecoveryState });
    assert.equal(directRecovery.status, 0, directRecovery.stderr);
    assert.equal(JSON.parse(directRecovery.stdout.trim()).classification, 'DEV_RECOVERY_REMEDIATION_R3_RECOVERED');
    assert.equal(readStageState({
      rootDirectory: directRecoveryState,
      key,
      attemptId: recovery.contract.remediationAttemptId,
      stage: 'REMEDIATION_RECOVERY_DATABASE'
    }).commitEvidenceMode, 'directly_observed');
    assert.equal(readRemediationEvents(directRecoveryState, key).filter((event) =>
      event.stage === 'REMEDIATION_RECOVERY_DATABASE' &&
      event.substep === 'RECOVERY_PACKAGE_EXECUTION_STARTED').length, 1);
    assert.equal(await harness.preexistingSessionIntact(), true);
    assert.equal(directoryByteDigest(recoveryFailure.stateDirectory), recoveryFailure.immutableDigest);
    assert.equal(harness.seen.filter((entry) =>
      entry === 'POST /auth/v1/token?grant_type=password').length, 26);
    for (const [route, count] of [
      ['/functions/v1/api?path=%2Fauth%2Fcontext', 25],
      ['/functions/v1/api?path=%2Ffilm-data%2Fcatalog', 21],
      ['/functions/v1/api?path=%2Fboxes%2Fsearch&warehouse=ALL&q=CODEX_REMEDIATION_READ_ONLY_NO_MATCH', 21],
      ['/functions/v1/api?path=%2Fjobs%2Flist&limit=1', 21]
    ]) assert.equal(harness.seen.filter((entry) => entry === `GET ${route}`).length, count);
    assert.ok(harness.seen.every((entry) => /^(?:GET|POST) \//.test(entry)));

    const mismatchCrashPath = path.join(
      mismatchRecoveryState,
      'disposable-test-crash-point.private.txt'
    );
    writePrivateBytesExclusive(
      mismatchCrashPath,
      Buffer.from('BEFORE_RECOVERY_DATABASE_COMMIT\n', 'utf8')
    );
    const precommitCrash = await runRecoveryCli({
      recovery,
      stateDirectory: mismatchRecoveryState
    });
    fs.rmSync(mismatchCrashPath, { force: true });
    assert.notEqual(precommitCrash.status, 0);
    assert.equal(
      readRemediationJournal(mismatchRecoveryState, key).current.state,
      'REMEDIATION_RECOVERY_DATABASE_BOUNDARY'
    );
    const mismatchClient = new Client({
      connectionString: recoveryFailure.preparation.targetBefore.session.connectionString
    });
    await mismatchClient.connect();
    try {
      await mismatchClient.query(
        "update app.organizations set name=name || ' local-negative-test' where id=$1::uuid",
        [recoveryFailure.preparation.fixtureAuthority.primaryOrganizationId]
      );
    } finally {
      await mismatchClient.end();
    }
    const mismatchResult = await runRecoveryCli({
      recovery,
      stateDirectory: mismatchRecoveryState
    });
    assert.notEqual(mismatchResult.status, 0);
    assert.equal(
      readRemediationJournal(mismatchRecoveryState, key).current.state,
      'REMEDIATION_RECOVERY_FAILED'
    );
    assert.equal(readRemediationEvents(mismatchRecoveryState, key).filter((event) =>
      event.stage === 'REMEDIATION_RECOVERY_DATABASE' &&
      event.substep === 'RECOVERY_PACKAGE_EXECUTION_STARTED').length, 1);
    const measured = {
      r3CaptureMs: Math.max(...timings.r3Capture),
      r3ValidatedMs: Math.max(...timings.r3Validated),
      remediationMs: Math.max(...timings.remediation),
      recoveryMs: Math.max(...timings.recovery)
    };
    assert.ok(measured.r3CaptureMs < 30 * 60_000);
    assert.ok(measured.r3ValidatedMs < 30 * 60_000);
    assert.ok(measured.remediationMs < 2 * 60 * 60_000);
    assert.ok(measured.recoveryMs < 2 * 60 * 60_000);
    console.log(`recovery remediation safe timings ${JSON.stringify(measured)}`);
  } finally {
    await harness.close();
    for (const clusterRoot of clusters) {
      await removeRetainedDisposablePostgres({ rootDirectory: clusterRoot, postgresBin }).catch(() => {});
    }
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
