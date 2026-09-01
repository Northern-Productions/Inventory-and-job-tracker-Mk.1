import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  AUTH_CERTIFICATE_FORMAT,
  LIVE_EDGE_API_BASE,
  LIVE_SUPABASE_ORIGIN,
  assertExactRemediationUrls,
  assertRemediationAuthTransition,
  captureQuietWindowFromClient,
  captureRemediationAuthCertificateFromClient,
  fetchAuthAuditStoragePosture,
  fetchFreshEdgeIdentity,
  runFreshAuthenticationCanary
} from './dev-recovery-remediation-auth.mjs';
import {
  initializeRemediationJournal,
  readRemediationAuthCanaries,
  remediationAuthCanaryDisposition
} from './dev-recovery-remediation-state.mjs';
import { writePrivateBytesExclusive } from './private-artifacts.mjs';

const AUTH_MODULE = fileURLToPath(new URL('./dev-recovery-remediation-auth.mjs', import.meta.url));
const STATE_MODULE = fileURLToPath(new URL('./dev-recovery-remediation-state.mjs', import.meta.url));

test('recovery quiet-window census rejects each live-like activity category independently', async () => {
  const categories = ['active_clients', 'idle_in_transaction', 'lock_waiters', 'write_shaped'];
  for (const category of categories) {
    const row = Object.fromEntries(categories.map((name) => [name, name === category ? 1 : 0]));
    await assert.rejects(
      captureQuietWindowFromClient({ query: async () => ({ rows: [row] }) }),
      { code: 'DEV_REMEDIATION_QUIET_WINDOW_NOT_QUIET' }
    );
  }
  assert.deepEqual(
    await captureQuietWindowFromClient({
      query: async () => ({ rows: [{
        active_clients: 0,
        idle_in_transaction: 0,
        lock_waiters: 0,
        write_shaped: 0
      }] })
    }),
    { quiet: true, activeClients: 0, idleInTransaction: 0, lockWaiters: 0, writeShaped: 0 }
  );
});

function certificate({
  lastSignIn = '2026-08-29T10:00:00.000Z',
  sessions = [],
  refreshTokens = [],
  copiedDigest = 'copied'
} = {}) {
  const stable = {
    copiedUsers: { count: 1, digest: copiedDigest },
    copiedIdentities: { count: 1, digest: 'identities' },
    copiedEphemera: {
      sessions: { count: 0, digest: 'sessions' },
      refreshTokens: { count: 0, digest: 'refresh' }
    },
    auditLog: { count: 0, digest: 'audit' },
    nativeUsers: { count: 1, digest: 'native-user' },
    nativeIdentities: { count: 1, digest: 'native-identity' },
    relationshipDigest: 'relationship',
    defaultWarehouse: 'LOCAL'
  };
  return {
    format: AUTH_CERTIFICATE_FORMAT,
    stable,
    stableDigest: `stable:${copiedDigest}`,
    nativeVolatile: {
      user_last_sign_in_at: lastSignIn,
      user_updated_at: lastSignIn,
      identity_last_sign_in_at: lastSignIn,
      identity_updated_at: lastSignIn
    },
    nativeEphemera: { sessions, refreshTokens }
  };
}

test('exact remediation URL guards reject lookalikes, credentials, paths, ports, queries, and fragments', () => {
  assert.deepEqual(assertExactRemediationUrls({
    SUPABASE_URL: LIVE_SUPABASE_ORIGIN,
    EDGE_API_BASE_URL: LIVE_EDGE_API_BASE
  }), { authUrl: LIVE_SUPABASE_ORIGIN, apiUrl: LIVE_EDGE_API_BASE });
  for (const value of [
    `https://${new URL(LIVE_SUPABASE_ORIGIN).hostname}.example.invalid`,
    LIVE_SUPABASE_ORIGIN.replace('https:', 'http:'),
    `${LIVE_SUPABASE_ORIGIN}:443`,
    `${LIVE_SUPABASE_ORIGIN}/unexpected`,
    `${LIVE_SUPABASE_ORIGIN}?x=1`,
    `${LIVE_SUPABASE_ORIGIN}#x`,
    LIVE_SUPABASE_ORIGIN.replace('https://', 'https://user:password@')
  ]) {
    assert.throws(() => assertExactRemediationUrls({
      SUPABASE_URL: value,
      EDGE_API_BASE_URL: LIVE_EDGE_API_BASE
    }), { code: 'DEV_REMEDIATION_AUTH_NETWORK_TARGET_REJECTED' });
  }
});

test('semantic Auth parity permits only native login volatility and bounded logout-failure ephemera', () => {
  const before = certificate();
  const afterLogout = certificate({ lastSignIn: '2026-08-29T10:01:00.000Z' });
  assert.notDeepEqual(afterLogout, before);
  assert.equal(assertRemediationAuthTransition(before, afterLogout, {
    logoutSucceeded: true
  }).copiedUsersExact, true);
  const afterFailedLogout = certificate({
    lastSignIn: '2026-08-29T10:01:00.000Z',
    sessions: ['private-session'],
    refreshTokens: ['private-refresh']
  });
  assert.notDeepEqual(afterFailedLogout, before);
  assert.equal(assertRemediationAuthTransition(before, afterFailedLogout, {
    logoutSucceeded: false
  }).boundedEphemera, true);
  const allowed = assertRemediationAuthTransition(before, afterFailedLogout, {
    logoutSucceeded: false
  }).allowedNativeEphemera;
  assert.equal(assertRemediationAuthTransition(before, before, {
    logoutSucceeded: true,
    requireFreshLogin: false,
    allowedNativeEphemera: allowed
  }).boundedEphemera, true);
  assert.throws(() => assertRemediationAuthTransition(before, certificate({
    lastSignIn: '2026-08-29T10:02:00.000Z', sessions: ['unexplained']
  }), {
    logoutSucceeded: false,
    requireFreshLogin: false,
    allowedNativeEphemera: allowed
  }), { code: 'DEV_REMEDIATION_AUTH_EPHEMERA_DRIFT' });
  assert.throws(() => assertRemediationAuthTransition(before, certificate({
    lastSignIn: '2026-08-29T10:01:00.000Z', copiedDigest: 'changed'
  }), { logoutSucceeded: true }), { code: 'DEV_REMEDIATION_AUTH_STABLE_STATE_DRIFT' });
  assert.throws(() => assertRemediationAuthTransition(before, certificate({
    lastSignIn: '2026-08-29T10:01:00.000Z', sessions: ['one', 'two']
  }), { logoutSucceeded: false }), { code: 'DEV_REMEDIATION_AUTH_EPHEMERA_DRIFT' });
  for (const mutate of [
    (value) => { value.stable.copiedIdentities.digest = 'changed-identities'; },
    (value) => { value.stable.nativeUsers.digest = 'changed-native-stable'; },
    (value) => { value.stable.relationshipDigest = 'changed-owner-relationship'; }
  ]) {
    const changed = certificate({ lastSignIn: '2026-08-29T10:01:00.000Z' });
    mutate(changed);
    assert.throws(() => assertRemediationAuthTransition(before, changed, {
      logoutSucceeded: true
    }), { code: 'DEV_REMEDIATION_AUTH_STABLE_STATE_DRIFT' });
  }
});

test('Auth audit posture requires the exact disabled provider prerequisite', async () => {
  assert.equal((await fetchAuthAuditStoragePosture({
    preparation: { mode: 'disposable-managed-local' },
    values: {}
  })).postgresStorage, 'disabled');
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ audit_log_disable_postgres: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    const posture = await fetchAuthAuditStoragePosture({
      preparation: { mode: 'managed-dev' },
      values: { SUPABASE_ACCESS_TOKEN: 'synthetic-management-token' }
    });
    assert.equal(posture.postgresStorage, 'disabled');
    globalThis.fetch = async () => new Response(JSON.stringify({ audit_log_disable_postgres: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    await assert.rejects(fetchAuthAuditStoragePosture({
      preparation: { mode: 'managed-dev' },
      values: { SUPABASE_ACCESS_TOKEN: 'synthetic-management-token' }
    }), { code: 'DEV_REMEDIATION_AUTH_AUDIT_POSTURE_UNSAFE' });
    globalThis.fetch = async () => new Response(JSON.stringify({
      security_audit_log_disable_postgres: true
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    await assert.rejects(fetchAuthAuditStoragePosture({
      preparation: { mode: 'managed-dev' },
      values: { SUPABASE_ACCESS_TOKEN: 'synthetic-management-token' }
    }), { code: 'DEV_REMEDIATION_AUTH_AUDIT_POSTURE_UNSAFE' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('semantic Auth certificate preserves an absent warehouse preference as the exact empty default', async () => {
  const responses = [
    [],
    [{ value: { id: 'native' } }],
    [],
    [{ value: { id: 'identity' } }],
    [],
    [],
    [],
    [{
      membership: { role: 'owner', status: 'active' },
      organization: { status: 'active' },
      preference: null,
      default_warehouse: '',
      warehouse_exists: false
    }],
    [{
      user_last_sign_in_at: '2026-08-29T10:00:00.000Z',
      user_updated_at: '2026-08-29T10:00:00.000Z',
      identity_last_sign_in_at: '2026-08-29T10:00:00.000Z',
      identity_updated_at: '2026-08-29T10:00:00.000Z'
    }],
    [],
    []
  ];
  const client = {
    async query() {
      return { rows: responses.shift() };
    }
  };
  const result = await captureRemediationAuthCertificateFromClient(client, {
    userId: crypto.randomUUID(),
    organizationId: crypto.randomUUID(),
    expectedDefaultWarehouse: ''
  });
  assert.equal(responses.length, 0);
  assert.equal(result.stable.defaultWarehouse, '');
  assert.equal(result.stable.nativeUsers.count, 1);
  assert.equal(result.stable.nativeIdentities.count, 1);
});

test('credential-bearing canary accepts the exact empty warehouse preference without weakening identity checks', async () => {
  const userId = crypto.randomUUID();
  const organizationId = crypto.randomUUID();
  const requests = [];
  const lifecycle = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader('Content-Type', 'application/json');
    if (request.url.startsWith('/auth/v1/token')) {
      response.end(JSON.stringify({ access_token: 'local-access', refresh_token: 'local-refresh', user: { id: userId } }));
    } else if (request.url === '/functions/v1/api?path=%2Fauth%2Fcontext') {
      response.end(JSON.stringify({ data: { orgId: organizationId, role: 'owner', defaultWarehouse: '' } }));
    } else if (request.url === '/functions/v1/api?path=%2Ffilm-data%2Fcatalog') {
      response.end(JSON.stringify({ data: { entries: [] } }));
    } else if (request.url === '/functions/v1/api?path=%2Fboxes%2Fsearch&warehouse=ALL&q=CODEX_REMEDIATION_READ_ONLY_NO_MATCH') {
      response.end(JSON.stringify({ data: [] }));
    } else if (request.url === '/functions/v1/api?path=%2Fjobs%2Flist&limit=1') {
      response.end(JSON.stringify({ data: [] }));
    } else if (request.url === '/auth/v1/logout') {
      response.end('{}');
    } else {
      response.writeHead(404);
      response.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await runFreshAuthenticationCanary({
      preparation: {
        mode: 'disposable-managed-local',
        targetSession: {
          smokeUserId: userId,
          smokeOrganizationId: organizationId,
          smokeDefaultWarehouse: ''
        }
      },
      values: {
        SUPABASE_URL: origin,
        EDGE_API_BASE_URL: `${origin}/functions/v1/api`,
        SUPABASE_ANON_KEY: 'local-only',
        SMOKE_USER_EMAIL: 'local@example.invalid',
        SMOKE_USER_PASSWORD: 'local-only'
      },
      onLifecycle: async (state) => { lifecycle.push(state); }
    });
    assert.equal(result.defaultWarehouseExact, true);
    assert.equal(result.filmCatalogReadSucceeded, true);
    assert.equal(result.boxSearchReadSucceeded, true);
    assert.equal(result.jobsReadSucceeded, true);
    assert.deepEqual(requests, [
      'POST /auth/v1/token?grant_type=password',
      'GET /functions/v1/api?path=%2Fauth%2Fcontext',
      'GET /functions/v1/api?path=%2Ffilm-data%2Fcatalog',
      'GET /functions/v1/api?path=%2Fboxes%2Fsearch&warehouse=ALL&q=CODEX_REMEDIATION_READ_ONLY_NO_MATCH',
      'GET /functions/v1/api?path=%2Fjobs%2Flist&limit=1',
      'POST /auth/v1/logout'
    ]);
    assert.deepEqual(lifecycle, [
      'LOGIN_STARTED', 'LOGIN_SUCCEEDED', 'LOGOUT_ATTEMPTED', 'LOGOUT_SUCCEEDED', 'CANARY_COMPLETE'
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('credential-bearing canary rejects redirects without following them', async () => {
  let redirected = false;
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/auth/v1/token')) {
      response.writeHead(302, { location: '/unexpected' });
      response.end();
      return;
    }
    redirected = true;
    response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const previous = { ...process.env };
  Object.assign(process.env, {
    SUPABASE_URL: origin,
    EDGE_API_BASE_URL: `${origin}/functions/v1/api`,
    SUPABASE_ANON_KEY: 'local-only',
    SMOKE_USER_EMAIL: 'local@example.invalid',
    SMOKE_USER_PASSWORD: 'local-only'
  });
  try {
    await assert.rejects(runFreshAuthenticationCanary({ preparation: {
      mode: 'disposable-managed-local',
      targetSession: {
        smokeUserId: crypto.randomUUID(),
        smokeOrganizationId: crypto.randomUUID(),
        smokeDefaultWarehouse: 'LOCAL'
      }
    } }), { code: 'DEV_REMEDIATION_FRESH_AUTHENTICATION_FAILED' });
    assert.equal(redirected, false);
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, previous);
    await new Promise((resolve) => server.close(resolve));
  }
});

test('credential-bearing canary attempts logout after a read failure', async () => {
  const userId = crypto.randomUUID();
  const organizationId = crypto.randomUUID();
  const requests = [];
  const lifecycle = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader('Content-Type', 'application/json');
    if (request.url.startsWith('/auth/v1/token')) {
      response.end(JSON.stringify({ access_token: 'local-access', refresh_token: 'local-refresh', user: { id: userId } }));
    } else if (request.url === '/functions/v1/api?path=%2Fauth%2Fcontext') {
      response.writeHead(503);
      response.end('{}');
    } else if (request.url === '/auth/v1/logout') {
      response.end('{}');
    } else {
      response.writeHead(404);
      response.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(runFreshAuthenticationCanary({
      preparation: {
        mode: 'disposable-managed-local',
        targetSession: {
          smokeUserId: userId,
          smokeOrganizationId: organizationId,
          smokeDefaultWarehouse: ''
        }
      },
      values: {
        SUPABASE_URL: origin,
        EDGE_API_BASE_URL: `${origin}/functions/v1/api`,
        SUPABASE_ANON_KEY: 'local-only',
        SMOKE_USER_EMAIL: 'local@example.invalid',
        SMOKE_USER_PASSWORD: 'local-only'
      },
      onLifecycle: async (state) => { lifecycle.push(state); }
    }), { code: 'DEV_REMEDIATION_AUTH_CONTEXT_READ_FAILED' });
    assert.deepEqual(requests, [
      'POST /auth/v1/token?grant_type=password',
      'GET /functions/v1/api?path=%2Fauth%2Fcontext',
      'POST /auth/v1/logout'
    ]);
    assert.deepEqual(lifecycle, [
      'LOGIN_STARTED', 'LOGIN_SUCCEEDED', 'LOGOUT_ATTEMPTED', 'LOGOUT_SUCCEEDED', 'CANARY_COMPLETE'
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('credential-bearing canary records bounded ephemera when logout fails', async () => {
  const userId = crypto.randomUUID();
  const organizationId = crypto.randomUUID();
  const lifecycle = [];
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url.startsWith('/auth/v1/token')) {
      response.end(JSON.stringify({
        access_token: 'local-access', refresh_token: 'local-refresh', user: { id: userId }
      }));
    } else if (request.url === '/functions/v1/api?path=%2Fauth%2Fcontext') {
      response.end(JSON.stringify({ data: {
        orgId: organizationId, role: 'owner', defaultWarehouse: ''
      } }));
    } else if (
      request.url === '/functions/v1/api?path=%2Ffilm-data%2Fcatalog' ||
      request.url === '/functions/v1/api?path=%2Fboxes%2Fsearch&warehouse=ALL&q=CODEX_REMEDIATION_READ_ONLY_NO_MATCH' ||
      request.url === '/functions/v1/api?path=%2Fjobs%2Flist&limit=1'
    ) {
      response.end(JSON.stringify({ data: [] }));
    } else if (request.url === '/auth/v1/logout') {
      response.writeHead(503);
      response.end('{}');
    } else {
      response.writeHead(404);
      response.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await runFreshAuthenticationCanary({
      preparation: {
        mode: 'disposable-managed-local',
        targetSession: {
          smokeUserId: userId,
          smokeOrganizationId: organizationId,
          smokeDefaultWarehouse: ''
        }
      },
      values: {
        SUPABASE_URL: origin,
        EDGE_API_BASE_URL: `${origin}/functions/v1/api`,
        SUPABASE_ANON_KEY: 'local-only',
        SMOKE_USER_EMAIL: 'local@example.invalid',
        SMOKE_USER_PASSWORD: 'local-only'
      },
      onLifecycle: async (state) => { lifecycle.push(state); }
    });
    assert.equal(result.sessionRevoked, false);
    assert.equal(result.ephemeralSessionException, true);
    assert.deepEqual(lifecycle, [
      'LOGIN_STARTED', 'LOGIN_SUCCEEDED', 'LOGOUT_ATTEMPTED',
      'BOUNDED_EPHEMERA_POSSIBLE', 'CANARY_COMPLETE'
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a real child killed after token issuance leaves durable bounded-ephemera evidence', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-remediation-canary-kill-'));
  const stateRoot = path.join(temporary, 'state-private');
  const key = crypto.randomBytes(32);
  const attemptId = 'dev-recovery-remediation-child-kill';
  const contractDigest = `sha256:${'1'.repeat(64)}`;
  const originalBindingDigest = `sha256:${'2'.repeat(64)}`;
  const userId = crypto.randomUUID();
  const organizationId = crypto.randomUUID();
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url.startsWith('/auth/v1/token')) {
      response.end(JSON.stringify({
        access_token: 'synthetic-process-local-access',
        refresh_token: 'synthetic-process-local-refresh',
        user: { id: userId }
      }));
      return;
    }
    response.writeHead(500);
    response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const keyPath = path.join(temporary, 'authority.private.bin');
  const inputPath = path.join(temporary, 'input.private.json');
  const childPath = path.join(temporary, 'child.private.mjs');
  try {
    initializeRemediationJournal({
      rootDirectory: stateRoot,
      key,
      remediationAttemptId: attemptId,
      contractDigest,
      originalBindingDigest
    });
    writePrivateBytesExclusive(keyPath, key);
    writePrivateBytesExclusive(inputPath, Buffer.from(JSON.stringify({
      preparation: {
        mode: 'disposable-managed-local',
        targetSession: {
          smokeUserId: userId,
          smokeOrganizationId: organizationId,
          smokeDefaultWarehouse: ''
        }
      },
      values: {
        SUPABASE_URL: origin,
        EDGE_API_BASE_URL: `${origin}/functions/v1/api`,
        SUPABASE_ANON_KEY: 'synthetic-local-only',
        SMOKE_USER_EMAIL: 'synthetic@example.invalid',
        SMOKE_USER_PASSWORD: 'synthetic-local-only'
      }
    }), 'utf8'));
    const childSource = `
      import fs from 'node:fs';
      import { runFreshAuthenticationCanary } from ${JSON.stringify(pathToFileURL(AUTH_MODULE).href)};
      import { beginRemediationAuthCanary, appendRemediationAuthCanaryState } from ${JSON.stringify(pathToFileURL(STATE_MODULE).href)};
      const [root, keyPath, inputPath] = process.argv.slice(2);
      const key = fs.readFileSync(keyPath);
      const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
      const canary = beginRemediationAuthCanary(root, key, 'AUTH_RUNTIME');
      await runFreshAuthenticationCanary({ ...input, onLifecycle: async (state) => {
        appendRemediationAuthCanaryState(root, key, canary.canaryId, state);
        if (state === 'LOGIN_SUCCEEDED') {
          process.stdout.write('LOGIN_SUCCEEDED\\n');
          await new Promise(() => {});
        }
      }});
    `;
    writePrivateBytesExclusive(childPath, Buffer.from(childSource, 'utf8'));
    const child = spawn(process.execPath, [childPath, stateRoot, keyPath, inputPath], {
      shell: false,
      cwd: temporary,
      windowsHide: true,
      env: {
        SystemRoot: process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
        WINDIR: process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows',
        TEMP: temporary,
        TMP: temporary
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('CHILD_LOGIN_SIGNAL_TIMEOUT')), 15_000);
      child.stdout.on('data', (chunk) => {
        if (chunk.toString('utf8').includes('LOGIN_SUCCEEDED')) {
          clearTimeout(timeout);
          child.kill();
          resolve();
        }
      });
      child.once('error', reject);
    });
    await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(readRemediationAuthCanaries(stateRoot, key)[0].current.state, 'LOGIN_SUCCEEDED');
    assert.deepEqual(remediationAuthCanaryDisposition(stateRoot, key), {
      canaryCount: 1,
      completedCount: 0,
      sessionRevoked: false,
      boundedEphemeraPossible: true
    });
  } finally {
    key.fill(0);
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('fresh managed Edge identity is bound to exact metadata and private body bytes', async () => {
  const deployedBody = Buffer.from('exact-deployed-body', 'utf8');
  const preparation = {
    mode: 'managed-dev',
    edge: {
      commit: 'a'.repeat(40),
      observed: {
        deploymentVersion: 162,
        deploymentStatus: 'ACTIVE',
        verifyJwt: false,
        bodySize: deployedBody.length,
        bodyDigest: `sha256:${crypto.createHash('sha256').update(deployedBody).digest('hex')}`
      }
    }
  };
  const values = {
    SUPABASE_URL: LIVE_SUPABASE_ORIGIN,
    EDGE_API_BASE_URL: LIVE_EDGE_API_BASE,
    SUPABASE_ACCESS_TOKEN: 'local-management-token'
  };
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  const responses = (bodyBytes) => [
    new Response(JSON.stringify({ data: { status: 'OK', apiBuildSha: 'b'.repeat(40) } })),
    new Response(JSON.stringify([{ slug: 'api', version: 162, status: 'ACTIVE', verify_jwt: false }])),
    new Response(bodyBytes)
  ];
  try {
    let queue = responses(deployedBody);
    globalThis.fetch = async (url) => {
      requestedUrls.push(String(url));
      return queue.shift();
    };
    const result = await fetchFreshEdgeIdentity({ preparation, values });
    assert.equal(result.sourceIdentityExact, true);
    assert.equal(result.managementMetadataExact, true);
    assert.equal(result.deployedBodyExact, true);
    assert.equal(queue.length, 0);
    assert.equal(requestedUrls[0], `${LIVE_EDGE_API_BASE}?path=%2Fhealth`);

    queue = responses(Buffer.from('changed-deployed-body', 'utf8'));
    await assert.rejects(fetchFreshEdgeIdentity({ preparation, values }), {
      code: 'DEV_REMEDIATION_EDGE_IDENTITY_DRIFT'
    });
    assert.equal(queue.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    deployedBody.fill(0);
  }
});
