import crypto from 'node:crypto';

import { canonicalDigest, canonicalSerialize } from '../readonly-diagnostics.mjs';
import { DEV_PROJECT_REF } from './dev-certified-contract.mjs';

const LIVE_SUPABASE_ORIGIN = `https://${DEV_PROJECT_REF}.supabase.co`;
const LIVE_EDGE_API_BASE = `${LIVE_SUPABASE_ORIGIN}/functions/v1/api`;
const AUTH_CERTIFICATE_FORMAT = 'dev-recovery-remediation-semantic-auth-v1';

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function asText(value) {
  return String(value ?? '').trim();
}

function assertUuid(value, code) {
  const normalized = asText(value).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw categoricalError(code);
  }
  return normalized;
}

function assertExactUrl(value, { disposable, edge }) {
  const raw = asText(value);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw categoricalError('DEV_REMEDIATION_AUTH_NETWORK_TARGET_REJECTED');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw categoricalError('DEV_REMEDIATION_AUTH_NETWORK_TARGET_REJECTED');
  }
  if (disposable) {
    if (
      url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      !url.port || url.pathname !== (edge ? '/functions/v1/api' : '/')
    ) throw categoricalError('DEV_REMEDIATION_AUTH_NETWORK_TARGET_REJECTED');
  } else {
    const expected = edge ? LIVE_EDGE_API_BASE : LIVE_SUPABASE_ORIGIN;
    if (/:\d+(?:[/?#]|$)/.test(raw.replace(/^[a-z]+:\/\/[^@]*@/i, '')) ||
        url.toString().replace(/\/$/, '') !== expected) {
      throw categoricalError('DEV_REMEDIATION_AUTH_NETWORK_TARGET_REJECTED');
    }
  }
  return url.toString().replace(/\/$/, '');
}

function assertExactRemediationUrls(values = {}, { disposable = false } = {}) {
  return {
    authUrl: assertExactUrl(values.SUPABASE_URL, { disposable, edge: false }),
    apiUrl: assertExactUrl(values.EDGE_API_BASE_URL, { disposable, edge: true })
  };
}

function logicalApiUrl(apiUrl, logicalPath, query = {}) {
  const url = new URL(apiUrl);
  url.searchParams.set('path', logicalPath);
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') url.searchParams.set(name, String(value));
  }
  return url.toString();
}

const USER_SECRET_COLUMNS = Object.freeze([
  'encrypted_password', 'confirmation_token', 'recovery_token', 'email_change_token_new',
  'phone_change_token', 'email_change_token_current', 'reauthentication_token'
]);

function userStableExpression(alias, { native = false } = {}) {
  const removed = [...USER_SECRET_COLUMNS, ...(native ? ['last_sign_in_at', 'updated_at'] : [])]
    .map((name) => `'${name}'`).join(', ');
  const digests = USER_SECRET_COLUMNS.map((name) =>
    `'${name}_digest', 'sha256:' || encode(extensions.digest(convert_to(coalesce(${alias}.${name}, ''), 'UTF8'), 'sha256'), 'hex')`
  ).join(', ');
  return `(to_jsonb(${alias}) - array[${removed}]::text[]) || jsonb_build_object(${digests})`;
}

async function capturedRows(client, sql, values = []) {
  const rows = (await client.query(sql, values)).rows.map((row) => row.value);
  return { count: rows.length, digest: canonicalDigest(rows) };
}

async function nativeEphemera(client, userId) {
  const sessions = (await client.query(
    'select id::text as value from auth.sessions where user_id=$1::uuid order by id::text', [userId]
  )).rows.map((row) => String(row.value));
  const refreshTokens = (await client.query(
    'select id::text as value from auth.refresh_tokens where user_id=$1::text order by id::text', [userId]
  )).rows.map((row) => String(row.value));
  return { sessions, refreshTokens };
}

async function captureRemediationAuthCertificateFromClient(client, {
  userId,
  organizationId,
  expectedDefaultWarehouse
} = {}) {
  if (!client || typeof client.query !== 'function') {
    throw categoricalError('DEV_REMEDIATION_AUTH_CERTIFICATE_CLIENT_INVALID');
  }
  const nativeUserId = assertUuid(userId, 'DEV_REMEDIATION_AUTH_CERTIFICATE_USER_INVALID');
  const nativeOrganizationId = assertUuid(
    organizationId, 'DEV_REMEDIATION_AUTH_CERTIFICATE_ORGANIZATION_INVALID'
  );
  const copiedUsers = await capturedRows(client, `
    select ${userStableExpression('u')} as value
      from auth.users u
     where u.id <> $1::uuid
     order by u.id`, [nativeUserId]);
  const nativeUsers = await capturedRows(client, `
    select ${userStableExpression('u', { native: true })} as value
      from auth.users u
     where u.id = $1::uuid
     order by u.id`, [nativeUserId]);
  const copiedIdentities = await capturedRows(client, `
    select to_jsonb(i) as value
      from auth.identities i
     where i.user_id is distinct from $1::uuid
     order by i.id`, [nativeUserId]);
  const nativeIdentities = await capturedRows(client, `
    select to_jsonb(i) - array['last_sign_in_at','updated_at']::text[] as value
      from auth.identities i
     where i.user_id = $1::uuid
     order by i.id`, [nativeUserId]);
  const copiedEphemera = {
    sessions: await capturedRows(client, `
      select to_jsonb(s) as value from auth.sessions s
       where s.user_id is distinct from $1::uuid order by s.id`, [nativeUserId]),
    refreshTokens: await capturedRows(client, `
      select to_jsonb(r) as value from auth.refresh_tokens r
       where r.user_id is distinct from $1::text order by r.id`, [nativeUserId])
  };
  const relationshipRows = (await client.query(`
    select to_jsonb(m) as membership,
           to_jsonb(o) as organization,
           to_jsonb(p) as preference,
           coalesce(p.default_warehouse, '')::text as default_warehouse,
           exists (
             select 1 from app.warehouses w
              where w.org_id=m.org_id and w.code=p.default_warehouse
           ) as warehouse_exists
      from app.organization_members m
      join app.organizations o on o.id=m.org_id
      left join app.user_preferences p on p.org_id=m.org_id and p.user_id=m.user_id
     where m.user_id=$1::uuid and m.org_id=$2::uuid`, [nativeUserId, nativeOrganizationId])).rows;
  const defaultWarehouse = asText(relationshipRows[0]?.default_warehouse);
  const expectedWarehouse = expectedDefaultWarehouse === undefined
    ? undefined
    : asText(expectedDefaultWarehouse);
  if (
    nativeUsers.count !== 1 || nativeIdentities.count !== 1 || relationshipRows.length !== 1 ||
    relationshipRows[0].membership?.role !== 'owner' ||
    relationshipRows[0].membership?.status !== 'active' ||
    (defaultWarehouse !== '' && relationshipRows[0].warehouse_exists !== true) ||
    (expectedWarehouse !== undefined && defaultWarehouse !== expectedWarehouse)
  ) throw categoricalError('DEV_REMEDIATION_AUTH_CERTIFICATE_RELATIONSHIP_INVALID');
  const volatileRows = (await client.query(`
    select u.last_sign_in_at::text as user_last_sign_in_at,
           u.updated_at::text as user_updated_at,
           coalesce((select max(i.last_sign_in_at)::text from auth.identities i where i.user_id=u.id), '') as identity_last_sign_in_at,
           coalesce((select max(i.updated_at)::text from auth.identities i where i.user_id=u.id), '') as identity_updated_at
      from auth.users u where u.id=$1::uuid`, [nativeUserId])).rows;
  if (volatileRows.length !== 1) throw categoricalError('DEV_REMEDIATION_AUTH_CERTIFICATE_VOLATILE_INVALID');
  const ephemera = await nativeEphemera(client, nativeUserId);
  const stable = {
    copiedUsers,
    copiedIdentities,
    copiedEphemera,
    nativeUsers,
    nativeIdentities,
    relationshipDigest: canonicalDigest(relationshipRows.map((row) => ({
      membership: row.membership,
      organization: row.organization,
      preference: row.preference,
      warehouseExists: row.warehouse_exists
    }))),
    defaultWarehouse
  };
  return {
    format: AUTH_CERTIFICATE_FORMAT,
    stable,
    stableDigest: canonicalDigest(stable),
    nativeVolatile: volatileRows[0],
    nativeEphemera: ephemera
  };
}

function timestamp(value) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw categoricalError('DEV_REMEDIATION_AUTH_VOLATILITY_INVALID');
  return parsed;
}

function assertSetPreserved(beforeValues, afterValues, maxAdditions) {
  const before = new Set(beforeValues);
  const after = new Set(afterValues);
  if ([...before].some((value) => !after.has(value)) || after.size - before.size > maxAdditions) {
    throw categoricalError('DEV_REMEDIATION_AUTH_EPHEMERA_DRIFT');
  }
}

function assertRemediationAuthTransition(before, after, {
  logoutSucceeded,
  requireFreshLogin = true
} = {}) {
  if (
    before?.format !== AUTH_CERTIFICATE_FORMAT || after?.format !== AUTH_CERTIFICATE_FORMAT ||
    canonicalSerialize(before.stable) !== canonicalSerialize(after.stable) ||
    before.stableDigest !== after.stableDigest
  ) throw categoricalError('DEV_REMEDIATION_AUTH_STABLE_STATE_DRIFT');
  const fields = ['user_last_sign_in_at', 'user_updated_at', 'identity_last_sign_in_at', 'identity_updated_at'];
  const advanced = fields.filter((name) => timestamp(after.nativeVolatile?.[name]) > timestamp(before.nativeVolatile?.[name]));
  if (fields.some((name) => timestamp(after.nativeVolatile?.[name]) < timestamp(before.nativeVolatile?.[name])) ||
      (requireFreshLogin && advanced.length === 0)) {
    throw categoricalError('DEV_REMEDIATION_AUTH_VOLATILITY_INVALID');
  }
  const maxAdditions = logoutSucceeded === true ? 0 : 1;
  assertSetPreserved(before.nativeEphemera.sessions, after.nativeEphemera.sessions, maxAdditions);
  assertSetPreserved(before.nativeEphemera.refreshTokens, after.nativeEphemera.refreshTokens, maxAdditions);
  if (logoutSucceeded === true && (
    before.nativeEphemera.sessions.length !== after.nativeEphemera.sessions.length ||
    before.nativeEphemera.refreshTokens.length !== after.nativeEphemera.refreshTokens.length
  )) throw categoricalError('DEV_REMEDIATION_AUTH_LOGOUT_NOT_CLEAN');
  return {
    stableStateExact: true,
    copiedUsersExact: true,
    copiedIdentitiesExact: true,
    nativeStableExact: true,
    ownerRelationshipExact: true,
    approvedVolatileFieldCount: advanced.length,
    boundedEphemera: true,
    sessionRevoked: logoutSucceeded === true
  };
}

async function fetchJson(url, options, code) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  timeout.unref();
  try {
    const response = await fetch(url, { ...options, redirect: 'error', signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw categoricalError(code);
    return { body, status: response.status };
  } catch (error) {
    if (error?.code) throw error;
    throw categoricalError(code);
  } finally {
    clearTimeout(timeout);
  }
}

async function runFreshAuthenticationCanary({ preparation, values = process.env } = {}) {
  const disposable = preparation?.mode === 'disposable-managed-local';
  const { authUrl, apiUrl } = assertExactRemediationUrls(values, { disposable });
  const anonKey = asText(values.SUPABASE_ANON_KEY);
  const email = asText(values.SMOKE_USER_EMAIL);
  const password = asText(values.SMOKE_USER_PASSWORD);
  const expectedUserId = assertUuid(
    preparation?.targetSession?.smokeUserId, 'DEV_REMEDIATION_EXPECTED_SMOKE_USER_INVALID'
  );
  const expectedOrganizationId = assertUuid(
    preparation?.targetSession?.smokeOrganizationId, 'DEV_REMEDIATION_EXPECTED_SMOKE_ORG_INVALID'
  );
  const expectedWarehouse = asText(preparation?.targetSession?.smokeDefaultWarehouse);
  if (!anonKey || !email || !password) {
    throw categoricalError('DEV_REMEDIATION_FRESH_AUTH_INPUT_MISSING');
  }
  let accessToken = '';
  let refreshToken = '';
  let sessionRevoked = false;
  let logoutAttempted = false;
  const revokeSession = async () => {
    if (!accessToken || logoutAttempted) return sessionRevoked;
    logoutAttempted = true;
    try {
      await fetchJson(`${authUrl}/auth/v1/logout`, {
        method: 'POST',
        headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` }
      }, 'DEV_REMEDIATION_LOGOUT_FAILED');
      sessionRevoked = true;
    } catch {
      sessionRevoked = false;
    }
    return sessionRevoked;
  };
  try {
    const signedIn = (await fetchJson(`${authUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    }, 'DEV_REMEDIATION_FRESH_AUTHENTICATION_FAILED')).body;
    accessToken = asText(signedIn.access_token);
    refreshToken = asText(signedIn.refresh_token);
    if (!accessToken || asText(signedIn.user?.id).toLowerCase() !== expectedUserId) {
      throw categoricalError('DEV_REMEDIATION_SMOKE_USER_ID_MISMATCH');
    }
    const read = async (route, query, code) => (await fetchJson(logicalApiUrl(apiUrl, route, query), {
      method: 'GET',
      headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` }
    }, code)).body;
    const authContext = await read(
      '/auth/context', {}, 'DEV_REMEDIATION_AUTH_CONTEXT_READ_FAILED'
    );
    const context = authContext.data || authContext;
    if (
      asText(context.orgId || context.organizationId).toLowerCase() !== expectedOrganizationId ||
      asText(context.role).toLowerCase() !== 'owner' ||
      asText(context.defaultWarehouse) !== expectedWarehouse
    ) throw categoricalError('DEV_REMEDIATION_AUTH_CONTEXT_INVALID');
    await read('/jobs/list', { limit: 1 }, 'DEV_REMEDIATION_APPLICATION_READ_FAILED');
    await revokeSession();
    return {
      freshAuthentication: true,
      smokeUserExact: true,
      smokeOrganizationExact: true,
      authContextOwner: true,
      defaultWarehouseExact: true,
      readOnlyApiSucceeded: true,
      sessionRevoked,
      ephemeralSessionException: !sessionRevoked
    };
  } finally {
    await revokeSession();
    accessToken = '';
    refreshToken = '';
  }
}

async function captureQuietWindowFromClient(client) {
  const row = (await client.query(`
    select
      count(*) filter (where pid <> pg_backend_pid() and state='active')::integer as active_clients,
      count(*) filter (where pid <> pg_backend_pid() and state='idle in transaction')::integer as idle_in_transaction,
      count(*) filter (where pid <> pg_backend_pid() and wait_event_type='Lock')::integer as lock_waiters,
      count(*) filter (
        where pid <> pg_backend_pid() and state='active' and
          coalesce(query, '') ~* '\\m(insert|update|delete|merge|truncate|alter|create|drop|grant|revoke|vacuum|analyze|refresh)\\M'
      )::integer as write_shaped
    from pg_stat_activity where datname=current_database()`)).rows[0] || {};
  const result = Object.fromEntries(Object.entries(row).map(([name, value]) => [name, Number(value || 0)]));
  if (Object.values(result).some((value) => value !== 0)) {
    throw categoricalError('DEV_REMEDIATION_QUIET_WINDOW_NOT_QUIET');
  }
  return { quiet: true, activeClients: 0, idleInTransaction: 0, lockWaiters: 0, writeShaped: 0 };
}

async function captureRuntimeSideEffectPostureFromClient(client) {
  const cronPresent = (await client.query("select to_regclass('cron.job') is not null as present")).rows[0]?.present === true;
  const cronJobs = cronPresent
    ? Number((await client.query('select count(*)::integer as count from cron.job')).rows[0]?.count || 0)
    : 0;
  const row = (await client.query(`
    select
      (select count(*) from pg_catalog.pg_class where relkind='f')::integer as foreign_tables,
      (select count(*) from pg_catalog.pg_trigger t join pg_catalog.pg_proc p on p.oid=t.tgfoid
        where not t.tgisinternal and lower(pg_catalog.pg_get_functiondef(p.oid)) ~ '(net\\.|http_request|https?://|webhook)')::integer as webhooks,
      (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
        where n.nspname=any(array['app','app_api','public']) and p.prokind in ('f','p')
          and lower(pg_catalog.pg_get_functiondef(p.oid)) ~ '(net\\.|http_request|https?://|resend|webhook)')::integer as external_references`)).rows[0] || {};
  const posture = {
    cronJobs,
    foreignResources: Number(row.foreign_tables || 0),
    webhooks: Number(row.webhooks || 0),
    networkCallers: Number(row.external_references || 0)
  };
  if (Object.values(posture).some((value) => value !== 0)) {
    throw categoricalError('DEV_REMEDIATION_FRESH_SIDE_EFFECT_POSTURE_UNSAFE');
  }
  return { safe: true, ...posture };
}

async function fetchFreshEdgeIdentity({ preparation, values = process.env } = {}) {
  const disposable = preparation?.mode === 'disposable-managed-local';
  const { apiUrl } = assertExactRemediationUrls(values, { disposable });
  const body = (await fetchJson(
    logicalApiUrl(apiUrl, '/health'), { method: 'GET' }, 'DEV_REMEDIATION_EDGE_HEALTH_FAILED'
  )).body;
  const data = body.data || body;
  const expectedVersion = Number(preparation?.edge?.observed?.deploymentVersion || 0);
  const observedStatus = asText(data.status).toUpperCase();
  const observedBuild = asText(data.apiBuildSha || data.buildSha);
  if (disposable) {
    if (observedStatus !== 'ACTIVE') throw categoricalError('DEV_REMEDIATION_EDGE_IDENTITY_DRIFT');
    return {
      compatible: true,
      deploymentVersion: expectedVersion,
      deploymentStatus: 'ACTIVE',
      verifyJwt: false,
      healthStatus: observedStatus,
      sourceIdentityExact: true,
      managementMetadataExact: true,
      deployedBodyExact: true
    };
  }
  const accessToken = asText(values.SUPABASE_ACCESS_TOKEN);
  const expectedDigest = asText(preparation?.edge?.observed?.bodyDigest).toLowerCase();
  const expectedSize = Number(preparation?.edge?.observed?.bodySize || 0);
  if (
    expectedVersion < 1 || preparation?.edge?.observed?.deploymentStatus !== 'ACTIVE' ||
    preparation?.edge?.observed?.verifyJwt !== false || observedStatus !== 'OK' ||
    !/^[0-9a-f]{40}$/.test(observedBuild) || !accessToken ||
    !/^sha256:[0-9a-f]{64}$/.test(expectedDigest) || !Number.isSafeInteger(expectedSize) || expectedSize < 1
  ) {
    throw categoricalError('DEV_REMEDIATION_EDGE_IDENTITY_DRIFT');
  }
  const managementBase = `https://api.supabase.com/v1/projects/${DEV_PROJECT_REF}/functions`;
  const headers = { Authorization: `Bearer ${accessToken}` };
  const functions = (await fetchJson(managementBase, { headers }, 'DEV_REMEDIATION_EDGE_MANAGEMENT_FAILED')).body;
  const api = (Array.isArray(functions) ? functions : []).filter((entry) =>
    asText(entry.slug || entry.name) === 'api'
  );
  if (
    api.length !== 1 || Number(api[0].version || 0) !== expectedVersion ||
    asText(api[0].status) !== 'ACTIVE' || (api[0].verify_jwt === true) !== false
  ) throw categoricalError('DEV_REMEDIATION_EDGE_IDENTITY_DRIFT');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  timeout.unref();
  let deployedBody;
  try {
    const response = await fetch(`${managementBase}/api/body`, {
      headers,
      redirect: 'error',
      signal: controller.signal
    });
    if (!response.ok) throw categoricalError('DEV_REMEDIATION_EDGE_BODY_CAPTURE_FAILED');
    deployedBody = Buffer.from(await response.arrayBuffer());
    if (
      deployedBody.length !== expectedSize ||
      `sha256:${crypto.createHash('sha256').update(deployedBody).digest('hex')}` !== expectedDigest
    ) throw categoricalError('DEV_REMEDIATION_EDGE_IDENTITY_DRIFT');
  } catch (error) {
    if (error?.code) throw error;
    throw categoricalError('DEV_REMEDIATION_EDGE_BODY_CAPTURE_FAILED');
  } finally {
    clearTimeout(timeout);
    deployedBody?.fill(0);
  }
  return {
    compatible: true,
    deploymentVersion: expectedVersion,
    deploymentStatus: preparation.edge.observed.deploymentStatus,
    verifyJwt: preparation.edge.observed.verifyJwt,
    healthStatus: observedStatus,
    sourceIdentityExact: true,
    managementMetadataExact: true,
    deployedBodyExact: true
  };
}

export {
  AUTH_CERTIFICATE_FORMAT,
  LIVE_EDGE_API_BASE,
  LIVE_SUPABASE_ORIGIN,
  assertExactRemediationUrls,
  assertRemediationAuthTransition,
  captureQuietWindowFromClient,
  captureRemediationAuthCertificateFromClient,
  captureRuntimeSideEffectPostureFromClient,
  fetchFreshEdgeIdentity,
  runFreshAuthenticationCanary
};
