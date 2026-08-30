import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
import { prepareDevRecoveryRemediation } from './dev-recovery-remediation-preparation.mjs';
import { readRemediationJournal } from './dev-recovery-remediation-state.mjs';
import { writePrivateBytesExclusive } from './private-artifacts.mjs';
import { applyManagedAuthPrivilegeProfile } from './managed-restore-rehearsal.mjs';

const { Client } = pg;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

function temporaryRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

async function startLocalApplicationHarness() {
  const seen = [];
  let binding = null;
  let activeSessionId = '';
  let failNextLogout = false;
  const databaseMutation = async (kind) => {
    if (!binding) throw new Error('LOCAL_AUTH_BINDING_MISSING');
    const client = new Client({ connectionString: binding.connectionString });
    await client.connect();
    try {
      if (kind === 'login') {
        const sessionId = crypto.randomUUID();
        activeSessionId = sessionId;
        await client.query("update auth.users set last_sign_in_at=greatest(clock_timestamp(),coalesce(last_sign_in_at,'epoch')+interval '1 second'), updated_at=greatest(clock_timestamp(),updated_at+interval '1 second') where id=$1::uuid", [binding.userId]);
        await client.query("update auth.identities set last_sign_in_at=greatest(clock_timestamp(),coalesce(last_sign_in_at,'epoch')+interval '1 second'), updated_at=greatest(clock_timestamp(),updated_at+interval '1 second') where user_id=$1::uuid", [binding.userId]);
        await client.query('insert into auth.sessions(id,user_id,created_at,updated_at) values ($1::uuid,$2::uuid,clock_timestamp(),clock_timestamp())', [sessionId, binding.userId]);
        await client.query(
          'insert into auth.refresh_tokens(token,user_id,revoked,created_at,updated_at,session_id) values ($3,$1::text,false,clock_timestamp(),clock_timestamp(),$2::uuid)',
          [binding.userId, sessionId, `local-only-${sessionId}`]
        );
      } else {
        await client.query('delete from auth.refresh_tokens where session_id=$1::uuid', [activeSessionId]);
        await client.query('delete from auth.sessions where id=$1::uuid and user_id=$2::uuid', [activeSessionId, binding.userId]);
        activeSessionId = '';
      }
    } finally {
      await client.end();
    }
  };
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, 'http://localhost');
    seen.push(`${request.method} ${requestUrl.pathname}${requestUrl.search}`);
    response.setHeader('content-type', 'application/json');
    if (request.url.startsWith('/auth/v1/token')) {
      await databaseMutation('login');
      response.end(JSON.stringify({
        access_token: 'local-access', refresh_token: 'local-refresh', user: { id: binding.userId }
      }));
      return;
    }
    if (request.url === '/auth/v1/logout') {
      if (failNextLogout) {
        failNextLogout = false;
        response.statusCode = 503;
        response.end('{}');
        return;
      }
      await databaseMutation('logout');
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    seen,
    bind(value) { binding = value; },
    failOneLogout() { failNextLogout = true; },
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
          select $1::uuid,$2::uuid,w.code,'disposable-remediation-e2e'
            from app.warehouses w where w.org_id=$1::uuid order by w.code limit 1
          on conflict (org_id,user_id) do update
            set default_warehouse=excluded.default_warehouse,
                updated_at=clock_timestamp(),
                updated_by=excluded.updated_by
          returning default_warehouse`, [
          preparation.fixtureAuthority.primaryOrganizationId,
          preparation.fixtureAuthority.smokeActorId
        ]);
        assert.equal(preference.rowCount, 1);
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
      return { prepared, contract, executor };
    };

    const successFailure = await createFailedRecovery('success');
    const success = await prepareRemediation('success', successFailure);
    const successState = path.join(root, 'success-remediation-state');
    let completed;
    try {
      completed = await runDevRecoveryRemediation({
        rootDirectory: successState,
        key,
        contract: success.contract,
        executor: success.executor
      });
    } catch (error) {
      throw Object.assign(new Error(
        `DISPOSABLE_SUCCESS_REMEDIATION_${error?.failedStage || 'UNKNOWN'}_${error?.causeCategory || error?.code || 'UNKNOWN'}`
      ), { code: 'DISPOSABLE_SUCCESS_REMEDIATION_FAILED' });
    }
    assert.equal(completed.classification, 'DEV_RECOVERY_REMEDIATION_COMPLETE');
    assert.equal(readRemediationJournal(successState, key).current.state, 'REMEDIATION_COMPLETE');
    assert.equal(directoryByteDigest(successFailure.stateDirectory), successFailure.immutableDigest);

    const recoveryFailure = await createFailedRecovery('r3-recovery');
    harness.failOneLogout();
    const recovery = await prepareRemediation('r3-recovery', recoveryFailure);
    const recoveryState = path.join(root, 'r3-recovery-remediation-state');
    await assert.rejects(runDevRecoveryRemediation({
      rootDirectory: recoveryState,
      key,
      contract: recovery.contract,
      executor: {
        async run(stage, context) {
          const evidence = await recovery.executor.run(stage, context);
          if (stage === 'AUTH_RUNTIME_VERIFIED') {
            throw Object.assign(new Error('DISPOSABLE_POST_COMMIT_FAILURE'), {
              code: 'DISPOSABLE_POST_COMMIT_FAILURE', transactionOutcome: 'not_started'
            });
          }
          return evidence;
        }
      }
    }), (error) => error.code === 'DEV_REMEDIATION_RECOVERY_REQUIRED' &&
      error.transactionOutcome === 'committed');
    assert.equal(readRemediationJournal(recoveryState, key).current.state, 'REMEDIATION_RECOVERY_REQUIRED');
    const recovered = await runDevRecoveryRemediationRecovery({
      rootDirectory: recoveryState,
      key,
      contract: recovery.contract,
      executor: recovery.executor
    });
    assert.equal(recovered.classification, 'DEV_RECOVERY_REMEDIATION_R3_RECOVERED');
    assert.equal(readRemediationJournal(recoveryState, key).current.state, 'REMEDIATION_RECOVERED');
    assert.equal(directoryByteDigest(recoveryFailure.stateDirectory), recoveryFailure.immutableDigest);
    assert.equal(harness.seen.filter((entry) =>
      entry === 'POST /auth/v1/token?grant_type=password').length, 7);
    for (const route of [
      '/functions/v1/api?path=%2Fauth%2Fcontext',
      '/functions/v1/api?path=%2Ffilm-data%2Fcatalog',
      '/functions/v1/api?path=%2Fboxes%2Fsearch&warehouse=ALL&q=CODEX_REMEDIATION_READ_ONLY_NO_MATCH',
      '/functions/v1/api?path=%2Fjobs%2Flist&limit=1'
    ]) assert.equal(harness.seen.filter((entry) => entry === `GET ${route}`).length, 7);
    assert.ok(harness.seen.every((entry) => /^(?:GET|POST) \//.test(entry)));
  } finally {
    await harness.close();
    for (const clusterRoot of clusters) {
      await removeRetainedDisposablePostgres({ rootDirectory: clusterRoot, postgresBin }).catch(() => {});
    }
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
