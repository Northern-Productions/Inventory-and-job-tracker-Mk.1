import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { chromium } from 'playwright-core';

import { canonicalDigest } from '../readonly-diagnostics.mjs';
import {
  appendFixtureId,
  appendFixtureIds,
  cleanupTargetsFromLedger,
  closeFixtureLedger,
  createFixtureLedger,
  readFixtureLedger
} from './dev-certified-fixture-ledger.mjs';
import {
  privateArtifactPath,
  verifyPrivateArtifactProtection,
  writePrivateJsonExclusive
} from './private-artifacts.mjs';
import { DEV_PROJECT_REF } from './dev-certified-contract.mjs';
import { GOLDEN_WORKFLOW_CONTRACT } from './constants.mjs';
import {
  captureApplicationPlane,
  captureAuthParity,
  captureManagedPlaneFingerprint
} from './managed-restore-rehearsal.mjs';
import {
  captureNativeSmokePreservation,
  verifyNativeSmokePreservation
} from './native-smoke-preservation.mjs';
import {
  captureBoxTransferGuard,
  captureOwnerGuard,
  extractBoxTransferGuardFunctionSource,
  extractOwnerGuardFunctionSource,
  OWNER_GUARD_TRIGGER
} from './fixture-recovery.mjs';

const { Client } = pg;
const THIS_FILE = fileURLToPath(import.meta.url);
const CHILD_SESSION_FORMAT = 'dev-certified-workflow-child-session-v1';
const CHILD_RESULT_FORMAT = 'dev-certified-workflow-child-result-v1';
const BOX_TRANSFER_GUARD_TRIGGER = 'trg_0191_guard_box_transfers';

const TRACKED_TABLES = Object.freeze({
  access_request: { table: 'access_requests', keys: ['user_id'] },
  audit_row: { table: 'audit_log', keys: ['id'] },
  allocation: { table: 'allocations', keys: ['allocation_id'] },
  box: { table: 'boxes', keys: ['box_id'] },
  box_alias: { table: 'box_id_aliases', keys: ['old_box_id'] },
  box_transfer: { table: 'box_transfers', keys: ['transfer_id'] },
  caulk_allocation: { table: 'caulk_job_allocations', keys: ['caulk_allocation_id'] },
  caulk_checkout: { table: 'caulk_job_checkouts', keys: ['caulk_checkout_id'] },
  caulk_manufacturer: { table: 'caulk_manufacturers', keys: ['id'] },
  caulk_product: { table: 'caulk_products', keys: ['id'] },
  caulk_stock: { table: 'caulk_stock', keys: ['id'] },
  caulk_transaction: { table: 'caulk_transactions', keys: ['transaction_id'] },
  dealer: { table: 'box_dealers', keys: ['id'] },
  film_catalog: { table: 'film_catalog', keys: ['id'] },
  film_order: { table: 'film_orders', keys: ['film_order_id'] },
  film_order_event: { table: 'film_order_events', keys: ['event_id'] },
  film_order_link: { table: 'film_order_box_links', keys: ['link_id'] },
  film_weight_pending_review: { table: 'film_weight_pending_reviews', keys: ['id'] },
  film_weight_sample: { table: 'film_weight_samples', keys: ['id'] },
  general_permission: { table: 'general_feature_permissions', keys: ['feature_area'] },
  job: { table: 'jobs', keys: ['id'] },
  job_caulk_requirement: { table: 'job_caulk_requirements', keys: ['id'] },
  job_phase: { table: 'job_phases', keys: ['id'] },
  job_requirement: { table: 'job_requirements', keys: ['id'] },
  planner_suppression: { table: 'allocation_planner_suppressions', keys: ['id'] },
  preference: { table: 'user_preferences', keys: ['user_id'] },
  owner_company: { table: 'owner_companies', keys: ['id'] },
  roll_history: { table: 'roll_weight_log', keys: ['id'] },
  team_audit: { table: 'team_user_audit_log', keys: ['event_id'] },
  warehouse: { table: 'warehouses', keys: ['code'] }
});

function categoricalError(code) { const error = new Error(code); error.code = code; return error; }
function text(value) { return String(value ?? '').trim(); }
function integer(value) { return Number.parseInt(String(value ?? '0'), 10) || 0; }
function assert(value, code) { if (!value) throw categoricalError(code); }
function today() { return new Date().toISOString().slice(0, 10); }
function addDays(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function readKeyFromFd() {
  const descriptor = Number(process.env.DEV_REFRESH_WORKFLOW_KEY_FD);
  if (!Number.isInteger(descriptor) || descriptor < 3) throw categoricalError('DEV_REFRESH_WORKFLOW_KEY_FD_INVALID');
  const bytes = fs.readFileSync(descriptor);
  try {
    if (bytes.length !== 32) throw categoricalError('DEV_REFRESH_WORKFLOW_KEY_INVALID');
    return Buffer.from(bytes);
  } finally { bytes.fill(0); }
}

function readPrivateJson(filePath) {
  verifyPrivateArtifactProtection(filePath);
  const bytes = fs.readFileSync(filePath);
  try { return JSON.parse(bytes.toString('utf8')); }
  finally { bytes.fill(0); }
}

function authorityForAttempt(authority, attemptId) {
  return { ...authority, target: 'dev', projectRef: DEV_PROJECT_REF, attemptId };
}

async function withClient(connectionString, callback) {
  const client = new Client({ connectionString, application_name: 'dev-certified-workflow-runner' });
  await client.connect();
  try { return await callback(client); }
  finally { await client.end().catch(() => {}); }
}

async function captureStrictWorkflowState(connectionString, fixtureAuthority) {
  const [application, auth, managed, nativeSmoke] = await Promise.all([
    captureApplicationPlane(connectionString),
    captureAuthParity(connectionString, { excludeNativeSmoke: true }),
    captureManagedPlaneFingerprint(connectionString),
    withClient(connectionString, (client) => captureNativeSmokePreservation(client, {
      userId: fixtureAuthority.smokeActorId,
      organizationId: fixtureAuthority.primaryOrganizationId
    }))
  ]);
  verifyNativeSmokePreservation(nativeSmoke);
  return { application, auth, managed, nativeSmoke: nativeSmoke.evidence };
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function chromeExecutable() {
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const selected = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!selected) throw categoricalError('DEV_REFRESH_WORKFLOW_BROWSER_UNAVAILABLE');
  return selected;
}

async function waitForUrl(url, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw categoricalError('DEV_REFRESH_WORKFLOW_SERVER_EXITED');
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw categoricalError('DEV_REFRESH_WORKFLOW_SERVER_TIMEOUT');
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000))
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function minimalEnvironment(additions = {}) {
  return {
    SystemRoot: process.env.SystemRoot || '', WINDIR: process.env.WINDIR || '',
    PATH: process.env.PATH || '', TEMP: process.env.TEMP || '', TMP: process.env.TMP || '',
    HOME: process.env.HOME || process.env.USERPROFILE || '',
    USERPROFILE: process.env.USERPROFILE || process.env.HOME || '', ...additions
  };
}

function appendId(session, key, workflow, entityType, stableId, organizationId = session.fixtureAuthority.primaryOrganizationId) {
  if (!stableId) throw categoricalError('DEV_REFRESH_WORKFLOW_STABLE_ID_MISSING');
  appendFixtureId(session.ledgerPath, key, {
    workflow, entityType, stableId: String(stableId), organizationId: String(organizationId),
    actorId: session.fixtureAuthority.smokeActorId
  });
}

function ledgerEntry(session, workflow, entityType, stableId, organizationId = session.fixtureAuthority.primaryOrganizationId, restore = null) {
  if (!stableId) throw categoricalError('DEV_REFRESH_WORKFLOW_STABLE_ID_MISSING');
  return {
    workflow,
    entityType,
    stableId: String(stableId),
    organizationId: String(organizationId),
    actorId: session.fixtureAuthority.smokeActorId,
    ...(restore ? { restore } : {})
  };
}

function stableKey(row, keys) {
  const values = keys.map((key) => text(row[key]));
  return values.some((value) => !value || value.includes('|')) ? '' : values.join('|');
}

async function tableExists(client, table) {
  return Boolean((await client.query('select to_regclass($1::text)::text as name', [`app.${table}`])).rows[0]?.name);
}

async function captureTrackedIds(client, organizationIds) {
  const captured = new Map();
  for (const [entityType, definition] of Object.entries(TRACKED_TABLES)) {
    if (!await tableExists(client, definition.table)) continue;
    const columns = await client.query(
      `select column_name from information_schema.columns
        where table_schema='app' and table_name=$1 and column_name=any($2::text[])`,
      [definition.table, ['org_id', ...definition.keys]]
    );
    const names = new Set(columns.rows.map((row) => row.column_name));
    if (definition.keys.some((key) => !names.has(key))) continue;
    const projection = [
      ...(names.has('org_id') ? ['org_id::text as "__organization_id"'] : []),
      ...definition.keys.map((key) => `"${key}"::text as "${key}"`)
    ].join(',');
    const scoped = names.has('org_id') ? ' where org_id=any($1::uuid[])' : '';
    const result = await client.query(`select ${projection} from app."${definition.table}"${scoped}`, names.has('org_id') ? [organizationIds] : []);
    const identities = new Map();
    for (const row of result.rows) {
      const stableId = stableKey(row, definition.keys);
      const organizationId = text(row.__organization_id || organizationIds[0]);
      if (stableId && organizationId) identities.set(`${organizationId}\u0000${stableId}`, { organizationId, stableId });
    }
    captured.set(entityType, identities);
  }
  return captured;
}

async function recordTrackedDelta(session, key, baseline, workflow) {
  await withClient(session.connectionString, async (client) => {
    const current = await captureTrackedIds(client, session.organizationIds);
    const pending = [];
    for (const [entityType, identities] of current) {
      const known = baseline.get(entityType) || new Map();
      for (const [identity, captured] of identities) {
        if (known.has(identity)) continue;
        pending.push({ entityType, identity, known, ...captured });
      }
    }
    if (pending.length) {
      appendFixtureIds(
        session.ledgerPath,
        key,
        pending.map(({ entityType, stableId, organizationId }) =>
          ledgerEntry(session, workflow, entityType, stableId, organizationId))
      );
      for (const { entityType, identity, stableId, organizationId, known } of pending) {
        known.set(identity, { stableId, organizationId });
        baseline.set(entityType, known);
      }
    }
  });
}

async function bootstrapFixtures(session, key) {
  const actor = session.fixtureAuthority.smokeActorId;
  const primary = session.fixtureAuthority.primaryOrganizationId;
  return withClient(session.connectionString, async (client) => {
    await client.query('begin');
    try {
      const owner = await client.query('select id::text from app.owner_companies where org_id=$1::uuid and is_active order by code limit 1', [primary]);
      assert(owner.rows.length === 1, 'DEV_REFRESH_WORKFLOW_OWNER_COMPANY_MISSING');
      const nativeUser = await client.query('select email from auth.users where id=$1::uuid', [actor]);
      assert(nativeUser.rows.length === 1 && text(nativeUser.rows[0].email), 'DEV_REFRESH_WORKFLOW_NATIVE_USER_MISSING');
      const originalPreference = (await client.query(
        `select default_warehouse, updated_at, updated_by
           from app.user_preferences
          where org_id=$1::uuid and user_id=$2::uuid`,
        [primary, actor]
      )).rows[0] || null;
      const originalOrganizationPreference = (await client.query(
        `select selected_org_id::text, updated_at, updated_by_user_id::text
           from app.user_organization_preferences
          where user_id=$1::uuid`,
        [actor]
      )).rows[0] || null;
      const originalOwnerNotificationPreference = (await client.query(
        `select in_app_opt_in, email_opt_in, updated_at, updated_by
           from app.owner_notification_preferences
          where org_id=$1::uuid and owner_user_id=$2::uuid`,
        [primary, actor]
      )).rows[0] || null;
      const films = [
        { manufacturer: 'Certified Film', filmName: `Runtime ${session.runToken}`, width: 60 },
        { manufacturer: 'Certified Order Film', filmName: `Order ${session.runToken}`, width: 72 }
      ];
      const catalog = [];
      for (const film of films) {
        const row = await client.query(
          `insert into app.film_catalog(org_id,film_key,manufacturer,film_name,sq_ft_weight_lbs_per_sq_ft,
             default_core_type,source_width_in,source_initial_feet,source_initial_weight_lbs,notes)
           values($1::uuid,lower($2::text||'|'||$3::text),$2::text,$3::text,0.003,'White plastic',$4::numeric,100,4.8,$5::text) returning id::text`,
          [primary, film.manufacturer, film.filmName, film.width, session.runTag]
        );
        catalog.push({ ...film, id: row.rows[0].id });
      }
      const temporaryUserId = crypto.randomUUID();
      const temporaryIdentityId = crypto.randomUUID();
      const temporaryEmail = `fixture-${crypto.randomBytes(20).toString('hex')}@users.invalid`;
      const temporaryOrganizationId = (await client.query(
        'insert into app.organizations(name) values($1::text) returning id::text',
        [`Certification isolation ${crypto.randomBytes(12).toString('hex')}`]
      )).rows[0].id;
      await client.query(
        `insert into app.organization_members(org_id,user_id,role,status,updated_by_actor)
         values($1::uuid,$2::uuid,'owner','active',$3::text)`,
        [temporaryOrganizationId, temporaryUserId, session.runTag]
      );
      const generatedOrganizationRows = {
        warehouses: (await client.query(
          'select code from app.warehouses where org_id=$1::uuid order by code',
          [temporaryOrganizationId]
        )).rows,
        ownerCompanies: (await client.query(
          'select id::text from app.owner_companies where org_id=$1::uuid order by id',
          [temporaryOrganizationId]
        )).rows,
        permissions: (await client.query(
          'select feature_area from app.general_feature_permissions where org_id=$1::uuid order by feature_area',
          [temporaryOrganizationId]
        )).rows
      };
      await client.query(
        `insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
           confirmation_token,recovery_token,email_change_token_new,email_change,raw_app_meta_data,
           raw_user_meta_data,created_at,updated_at,phone,phone_change,phone_change_token,
           email_change_token_current,email_change_confirm_status,reauthentication_token,banned_until,is_sso_user,is_anonymous)
         values(coalesce((select instance_id from auth.users order by id limit 1),'00000000-0000-0000-0000-000000000000'::uuid),
           $1::uuid,'authenticated','authenticated',$2::text,'!fixture-local-only!',now(),'','','','',
           jsonb_build_object('provider','email','providers',jsonb_build_array('email'),'x_np_fixture',true),
           jsonb_build_object('x_np_fixture',true),now(),now(),null,'','','',0,'',null,false,false)`,
        [temporaryUserId, temporaryEmail]
      );
      await client.query(
        `insert into auth.identities(id,user_id,provider_id,identity_data,provider,created_at,updated_at)
         values($1::uuid,$2::uuid,$3::text,jsonb_build_object('sub',$2::text,'email',$3::text,'email_verified',true,'x_np_fixture',true),'email',now(),now())`,
        [temporaryIdentityId, temporaryUserId, temporaryEmail]
      );
      await client.query(
        `insert into app.user_organization_preferences(user_id,selected_org_id,updated_at,updated_by_user_id)
         values($1::uuid,$2::uuid,now(),$1::uuid)`,
        [temporaryUserId, temporaryOrganizationId]
      );
      const secondaryFilm = { manufacturer: 'Isolation Film', filmName: `Tenant ${session.runToken}`, width: 60 };
      const secondaryCatalogId = (await client.query(
        `insert into app.film_catalog(org_id,film_key,manufacturer,film_name,sq_ft_weight_lbs_per_sq_ft,
           default_core_type,source_width_in,source_initial_feet,source_initial_weight_lbs,notes)
         values($1::uuid,lower($2::text||'|'||$3::text),$2::text,$3::text,0.003,'White plastic',60,100,4.8,$4::text) returning id::text`,
        [temporaryOrganizationId, secondaryFilm.manufacturer, secondaryFilm.filmName, session.runTag]
      )).rows[0].id;
      const bootstrapEntries = [
        ...catalog.map((film) => ledgerEntry(session, GOLDEN_WORKFLOW_CONTRACT[4], 'film_catalog', film.id)),
        ledgerEntry(session, GOLDEN_WORKFLOW_CONTRACT[17], 'organization', temporaryOrganizationId, temporaryOrganizationId),
        ledgerEntry(session, GOLDEN_WORKFLOW_CONTRACT[17], 'membership', temporaryUserId, temporaryOrganizationId),
        ledgerEntry(session, GOLDEN_WORKFLOW_CONTRACT[17], 'organization_preference', temporaryUserId, temporaryOrganizationId),
        ledgerEntry(
          session,
          GOLDEN_WORKFLOW_CONTRACT[17],
          'organization_preference_restore',
          actor,
          primary,
          originalOrganizationPreference
            ? {
                existed: true,
                selectedOrganizationId: originalOrganizationPreference.selected_org_id,
                updatedAt: new Date(originalOrganizationPreference.updated_at).toISOString(),
                updatedByUserId: originalOrganizationPreference.updated_by_user_id
              }
            : { existed: false }
        ),
        ledgerEntry(
          session,
          GOLDEN_WORKFLOW_CONTRACT[1],
          'owner_notification_preference_restore',
          actor,
          primary,
          originalOwnerNotificationPreference
            ? {
                existed: true,
                inAppOptIn: originalOwnerNotificationPreference.in_app_opt_in,
                emailOptIn: originalOwnerNotificationPreference.email_opt_in,
                updatedAt: new Date(originalOwnerNotificationPreference.updated_at).toISOString(),
                updatedBy: String(originalOwnerNotificationPreference.updated_by || '')
              }
            : { existed: false }
        ),
        ledgerEntry(session, GOLDEN_WORKFLOW_CONTRACT[17], 'temporary_auth_user', temporaryUserId, temporaryOrganizationId),
        ledgerEntry(session, GOLDEN_WORKFLOW_CONTRACT[17], 'temporary_auth_identity', temporaryIdentityId, temporaryOrganizationId),
        ledgerEntry(session, GOLDEN_WORKFLOW_CONTRACT[19], 'film_catalog', secondaryCatalogId, temporaryOrganizationId),
        ...generatedOrganizationRows.warehouses.map((row) =>
          ledgerEntry(session, GOLDEN_WORKFLOW_CONTRACT[17], 'warehouse', row.code, temporaryOrganizationId)),
        ...generatedOrganizationRows.ownerCompanies.map((row) =>
          ledgerEntry(session, GOLDEN_WORKFLOW_CONTRACT[17], 'owner_company', row.id, temporaryOrganizationId)),
        ...generatedOrganizationRows.permissions.map((row) =>
          ledgerEntry(session, GOLDEN_WORKFLOW_CONTRACT[17], 'general_permission', row.feature_area, temporaryOrganizationId))
      ];
      if (originalPreference) {
        bootstrapEntries.push(ledgerEntry(
          session,
          GOLDEN_WORKFLOW_CONTRACT[3],
          'preference_restore',
          actor,
          primary,
          {
            existed: true,
            defaultWarehouse: text(originalPreference.default_warehouse),
            updatedAt: new Date(originalPreference.updated_at).toISOString(),
            updatedBy: String(originalPreference.updated_by || '')
          }
        ));
      }
      appendFixtureIds(session.ledgerPath, key, bootstrapEntries);
      await client.query('commit');
      return {
        ownerCompanyId: owner.rows[0].id, catalog, temporaryUserId, temporaryIdentityId,
        nativeEmail: text(nativeUser.rows[0].email), temporaryEmail, temporaryOrganizationId,
        secondaryCatalog: { ...secondaryFilm, id: secondaryCatalogId }
      };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    }
  });
}

function fakeAuthServer(session, bootstrap) {
  return http.createServer(async (request, response) => {
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-allow-headers', 'authorization, content-type, apikey, x-client-info');
    response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return;
    }
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const token = text(request.headers.authorization).replace(/^Bearer\s+/i, '');
    const owner = { id: session.fixtureAuthority.smokeActorId, email: bootstrap.nativeEmail, user_metadata: { name: 'Native certification owner' } };
    const temporary = { id: bootstrap.temporaryUserId, email: bootstrap.temporaryEmail, user_metadata: { name: 'Temporary certification member' } };
    let payload;
    if (request.method === 'GET' && url.pathname === '/auth/v1/user') {
      payload = token === 'temporary-token' ? temporary : token === 'owner-token' ? owner : null;
      response.statusCode = payload ? 200 : 401;
    } else if (request.method === 'POST' && url.pathname === '/auth/v1/token') {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      chunks.forEach((chunk) => chunk.fill(0));
      const selected = text(body.email) === bootstrap.temporaryEmail ? temporary : owner;
      payload = { access_token: selected === temporary ? 'temporary-token' : 'owner-token', refresh_token: 'local-refresh', user: selected };
      response.statusCode = 200;
    } else if (request.method === 'POST' && url.pathname === '/auth/v1/invite') {
      payload = temporary; response.statusCode = 200;
    } else if (url.pathname.startsWith('/rest/v1/rpc/')) {
      payload = { message: 'denied' }; response.statusCode = 403;
    } else { payload = { ok: false }; response.statusCode = 404; }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(payload));
  });
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  });
}

function boxPayload({ boxId, ownerCompanyId, dealer, film, initialFeet = 40, warehouse = 'IL1', received = true, runTag, filmOrderId = '' }) {
  return {
    boxId, warehouse, ownerCompanyId, dealer, manufacturer: film.manufacturer, filmName: film.filmName,
    widthIn: film.width, initialFeet, feetAvailable: received ? initialFeet : 0,
    initialWeightLbs: Number((1.8 + initialFeet * 0.003 * film.width / 12).toFixed(2)),
    coreType: 'White plastic', lotRun: runTag, orderDate: today(), receivedDate: received ? today() : '',
    notes: runTag, auditNote: runTag, ...(filmOrderId ? { filmOrderId } : {})
  };
}

function jobPayload({ jobNumber, film, feet = 0, runTag, caulkRequirements = [], laborOnly = false }) {
  return {
    jobNumber, warehouse: 'IL1', installDate: addDays(today(), 14), crewLeader: 'Certification',
    lifecycleStatus: 'ACTIVE', isLaborOnly: laborOnly, notes: runTag,
    requirements: feet ? [{ manufacturer: film.manufacturer, filmName: film.filmName, widthIn: film.width, requiredFeet: feet }] : [],
    caulkRequirements
  };
}

function jobIdentity(job) {
  const jobId = text(job?.summary?.jobId); const jobNumber = text(job?.summary?.jobNumber);
  assert(jobId && jobNumber, 'DEV_REFRESH_WORKFLOW_JOB_IDENTITY_MISSING');
  return { jobId, jobNumber };
}
function filmRequirement(job) {
  const entries = Array.isArray(job?.requirements) ? job.requirements : [];
  assert(entries.length === 1 && text(entries[0]?.requirementId), 'DEV_REFRESH_WORKFLOW_REQUIREMENT_INVALID');
  return entries[0];
}
function activeAllocations(job) {
  return (Array.isArray(job?.allocations) ? job.allocations : []).filter((entry) => text(entry.status).toUpperCase() === 'ACTIVE');
}

async function browserApi(page, baseUrl, token, method, route, body = null, query = {}, expectStatus = 200) {
  const result = await page.evaluate(async (args) => {
    const url = new URL(args.route, args.baseUrl);
    Object.entries(args.query || {}).forEach(([name, value]) => { if (value !== '' && value != null) url.searchParams.set(name, String(value)); });
    const response = await fetch(url, {
      method: args.method,
      headers: { Authorization: `Bearer ${args.token}`, ...(args.method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      ...(args.method === 'POST' ? { body: JSON.stringify(args.body || {}) } : {})
    });
    let value = null; try { value = await response.json(); } catch {}
    return { status: response.status, value };
  }, { baseUrl, token, method, route, body, query });
  const routeCategory = String(route).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  const publicError = text(result.value?.error);
  const errorCategory = /^Box not found\.$/i.test(publicError)
    ? 'BOX_NOT_FOUND'
    : /^Job .*not found\.$/i.test(publicError)
      ? 'JOB_NOT_FOUND'
      : /^Film Order not found\.$/i.test(publicError)
        ? 'FILM_ORDER_NOT_FOUND'
        : 'OTHER';
  assert(result.status === expectStatus, `DEV_REFRESH_WORKFLOW_API_${routeCategory}_STATUS_${expectStatus}_OBSERVED_${result.status}_${errorCategory}`);
  if (expectStatus === 200) assert(result.value?.ok === true, 'DEV_REFRESH_WORKFLOW_API_ENVELOPE_INVALID');
  return result.value;
}

async function runTwentyWorkflows(session, key, bootstrap, page, apiBaseUrl, baseline) {
  const evidence = [];
  const pass = (index, details = {}) => {
    session.completedWorkflowIndex = index;
    evidence.push({ name: GOLDEN_WORKFLOW_CONTRACT[index - 1], status: 'passed', ...details });
  };
  const ownerToken = 'owner-token'; const temporaryToken = 'temporary-token';
  const get = (route, query = {}, status = 200, token = ownerToken) => browserApi(page, apiBaseUrl, token, 'GET', route, null, query, status);
  const post = async (index, route, body = {}, status = 200, token = ownerToken) => {
    const result = await browserApi(page, apiBaseUrl, token, 'POST', route, body, {}, status);
    if (status === 200) await recordTrackedDelta(session, key, baseline, GOLDEN_WORKFLOW_CONTRACT[index - 1]);
    return result;
  };
  const signIn = await page.evaluate(async ({ authUrl, email }) => {
    const response = await fetch(`${authUrl}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'local-only' }) });
    return response.json();
  }, { authUrl: session.authUrl, email: bootstrap.nativeEmail });
  assert(text(signIn.access_token) === ownerToken, 'DEV_REFRESH_WORKFLOW_SIGN_IN_FAILED'); pass(1, { freshAuthentication: true });
  let context = (await get('/auth/context')).data;
  assert(context.role === 'owner' && context.accessStatus === 'approved', 'DEV_REFRESH_WORKFLOW_CONTEXT_INVALID'); pass(2, { organizationContext: true });
  for (const feature of ['inventory', 'jobs', 'allocations', 'film_orders', 'team_management']) assert(context.permissions?.[feature]?.read && context.permissions?.[feature]?.write, 'DEV_REFRESH_WORKFLOW_PERMISSION_INVALID');
  pass(3, { ownerPermissions: 5 });
  await post(4, '/profile/default-warehouse', { defaultWarehouse: 'IL1' });
  context = (await get('/auth/context')).data; assert(text(context.defaultWarehouse) === 'IL1', 'DEV_REFRESH_WORKFLOW_DEFAULT_WAREHOUSE_INVALID'); pass(4, { defaultWarehouse: true });

  const film = bootstrap.catalog[0]; const orderFilm = bootstrap.catalog[1];
  const dealer = (await post(5, '/box-dealers/upsert', { name: `Certification ${session.runToken}` })).data;
  const boxes = Array.from(
    { length: 10 },
    (_, index) => `IL1-CERT-${session.runToken.toUpperCase()}-${String(index + 1).padStart(2, '0')}`
  );
  const addBox = (index, options = {}) => post(5, '/boxes/add', boxPayload({
    boxId: boxes[index], ownerCompanyId: bootstrap.ownerCompanyId, dealer: dealer.name,
    film: options.film || film, initialFeet: options.initialFeet || 40,
    received: options.received !== false, runTag: session.runTag, filmOrderId: options.filmOrderId || ''
  }));
  for (let index = 0; index < 7; index += 1) await addBox(index, { initialFeet: index === 0 ? 120 : 40 });
  assert((await get('/boxes/search', { warehouse: 'IL1', q: boxes[0] })).data.some((entry) => text(entry.boxId) === boxes[0]), 'DEV_REFRESH_WORKFLOW_SEARCH_FAILED'); pass(5, { inventorySearch: true });

  const jobSeed = BigInt(`0x${session.runToken}`).toString(10);
  const jobs = Array.from({ length: 8 }, (_, index) => `${jobSeed}${index + 1}`);
  let job1 = (await post(6, '/jobs/create', jobPayload({ jobNumber: jobs[0], film, feet: 50, runTag: session.runTag }))).data;
  const job1Id = jobIdentity(job1); const req1 = filmRequirement(job1); pass(6, { jobCreated: true });
  await post(7, '/allocations/apply', { ...job1Id, boxId: boxes[0], requestedFeet: 20, requestedWidthIn: 60, requirementId: req1.requirementId, selectedSuggestionBoxIds: [], extraAllocations: [], crossWarehouse: false, jobWarehouse: 'IL1' });
  job1 = (await get('/jobs/get-by-id', { jobId: job1Id.jobId })).data; const allocation = activeAllocations(job1)[0]; assert(allocation, 'DEV_REFRESH_WORKFLOW_ALLOCATION_CREATE_FAILED');
  await post(7, '/allocations/remove-box', { ...job1Id, allocationId: allocation.allocationId, reason: session.runTag }); pass(7, { allocationAddedRemoved: true });
  await post(8, '/allocations/apply', { ...job1Id, boxId: boxes[0], requestedFeet: 30, requestedWidthIn: 60, requirementId: req1.requirementId, allocationKind: 'REQUIREMENT', selectedSuggestionBoxIds: [], extraAllocations: [], crossWarehouse: false, jobWarehouse: 'IL1' });
  await post(8, '/allocations/apply', { ...job1Id, boxId: boxes[0], requestedFeet: 5, requestedWidthIn: 60, requirementId: req1.requirementId, allocationKind: 'EXTRA', selectedSuggestionBoxIds: [], extraAllocations: [], crossWarehouse: false, jobWarehouse: 'IL1' });
  job1 = (await get('/jobs/get-by-id', { jobId: job1Id.jobId })).data;
  assert(activeAllocations(job1).some((row) => row.allocationKind === 'REQUIREMENT') && activeAllocations(job1).some((row) => row.allocationKind === 'EXTRA'), 'DEV_REFRESH_WORKFLOW_REQUIREMENT_EXTRA_FAILED'); pass(8, { requirementAndExtra: true });
  let job2 = (await post(9, '/jobs/create', jobPayload({ jobNumber: jobs[1], film, feet: 30, runTag: session.runTag }))).data;
  const job2Id = jobIdentity(job2); const req2 = filmRequirement(job2);
  await post(9, '/allocations/apply', { ...job2Id, boxId: boxes[1], requestedFeet: 30, requestedWidthIn: 60, requirementId: req2.requirementId, selectedSuggestionBoxIds: [], extraAllocations: [], crossWarehouse: false, jobWarehouse: 'IL1', autoAllocate: true });
  job2 = (await get('/jobs/get-by-id', { jobId: job2Id.jobId })).data; assert(activeAllocations(job2).length, 'DEV_REFRESH_WORKFLOW_AUTO_ALLOCATE_FAILED'); pass(9, { autoAllocated: true });

  const job3 = (await post(10, '/jobs/create', jobPayload({ jobNumber: jobs[2], film: orderFilm, feet: 40, runTag: session.runTag }))).data;
  const job3Id = jobIdentity(job3); const req3 = filmRequirement(job3);
  const order = (await post(10, '/film-orders/create', { ...job3Id, requirementId: req3.requirementId, warehouse: 'IL1', manufacturer: orderFilm.manufacturer, filmName: orderFilm.filmName, widthIn: 72, requestedFeet: 40 })).data;
  assert(text(order.filmOrderId), 'DEV_REFRESH_WORKFLOW_FILM_ORDER_FAILED'); pass(10, { filmOrderCreated: true });
  const orderedBox = (await post(11, '/boxes/add', boxPayload({ boxId: boxes[7], ownerCompanyId: bootstrap.ownerCompanyId, dealer: dealer.name, film: orderFilm, initialFeet: 40, received: false, runTag: session.runTag, filmOrderId: order.filmOrderId }))).data.box;
  assert(text(orderedBox?.boxId), 'DEV_REFRESH_WORKFLOW_ORDERED_BOX_ID_MISSING');
  const orderedBoxState = await withClient(session.connectionString, async (client) => {
    const exact = (await client.query(
      'select status from app.boxes where org_id=$1::uuid and box_id=$2::text',
      [session.fixtureAuthority.primaryOrganizationId, orderedBox.boxId]
    )).rows[0] || null;
    const resolved = (await client.query(
      'select app_api.resolve_box_id_alias($1::uuid, $2::text) as box_id',
      [session.fixtureAuthority.primaryOrganizationId, orderedBox.boxId]
    )).rows[0] || null;
    return { exact, aliasMatches: text(resolved?.box_id) === text(orderedBox.boxId) };
  });
  assert(orderedBoxState.exact, 'DEV_REFRESH_WORKFLOW_ORDERED_BOX_NOT_PERSISTED');
  assert(text(orderedBoxState.exact.status) === 'ORDERED', 'DEV_REFRESH_WORKFLOW_ORDERED_BOX_STATUS_INVALID');
  assert(orderedBoxState.aliasMatches, 'DEV_REFRESH_WORKFLOW_ORDERED_BOX_ALIAS_RESOLUTION_INVALID');
  const receiveContext = (await get('/auth/context')).data;
  assert(receiveContext.orgId === session.fixtureAuthority.primaryOrganizationId, 'DEV_REFRESH_WORKFLOW_RECEIVE_CONTEXT_INVALID');
  await get('/boxes/get', { boxId: orderedBox.boxId });
  await post(11, '/boxes/receive', { boxId: orderedBox.boxId, currentFeetOnRoll: 40, lotRun: session.runTag });
  assert((await get('/film-orders/get', { filmOrderId: order.filmOrderId })).data.status === 'FULFILLED', 'DEV_REFRESH_WORKFLOW_RECEIPT_FAILED'); pass(11, { receiptHistoryImmutable: true });
  await addBox(8, { initialFeet: 80 }); assert((await get('/boxes/get', { boxId: boxes[8] })).data.status === 'IN_STOCK', 'DEV_REFRESH_WORKFLOW_RECEIVE_BOX_FAILED'); pass(12, { boxReceived: true });
  const transfer1 = (await post(13, '/boxes/transfer/start', { boxId: boxes[2], toWarehouse: 'MS1', notes: session.runTag })).data.transfer;
  assert(text(transfer1?.transferId), 'DEV_REFRESH_WORKFLOW_TRANSFER_ID_MISSING');
  await post(13, '/boxes/transfer/receive', { transferId: transfer1.transferId });
  const transfer2 = (await post(13, '/boxes/transfer/start', { boxId: boxes[3], toWarehouse: 'MS1', notes: session.runTag })).data.transfer;
  assert(text(transfer2?.transferId), 'DEV_REFRESH_WORKFLOW_TRANSFER_ID_MISSING');
  await post(13, '/boxes/transfer/cancel', { transferId: transfer2.transferId, reason: session.runTag }); pass(13, { transferReceived: true, transferCancelled: true });

  const job4 = (await post(14, '/jobs/create', jobPayload({ jobNumber: jobs[3], film, feet: 10, runTag: session.runTag }))).data;
  const job4Id = jobIdentity(job4); const req4 = filmRequirement(job4);
  await post(14, '/allocations/apply', { ...job4Id, boxId: boxes[4], requestedFeet: 10, requestedWidthIn: 60, requirementId: req4.requirementId, selectedSuggestionBoxIds: [], extraAllocations: [], crossWarehouse: false, jobWarehouse: 'IL1' });
  await post(14, '/boxes/set-status', { boxId: boxes[4], status: 'CHECKED_OUT', ...job4Id, auditNote: session.runTag });
  const checkedOut = (await get('/boxes/get', { boxId: boxes[4] })).data;
  const returnedWeight = Number((Number(checkedOut.coreWeightLbs) + 25 * Number(checkedOut.lfWeightLbsPerFt)).toFixed(2));
  await post(14, '/boxes/set-status', { boxId: boxes[4], status: 'IN_STOCK', ...job4Id, lastRollWeightLbs: returnedWeight, currentFeetOnRoll: 1, auditNote: session.runTag });
  const checkedIn = (await get('/boxes/get', { boxId: boxes[4] })).data;
  assert(checkedIn.status === 'IN_STOCK' && integer(checkedIn.physicalFeetAvailable) === 25, 'DEV_REFRESH_WORKFLOW_WEIGHT_CHECKIN_FAILED'); pass(14, { returnedWeightAuthoritative: true });

  const manufacturer = (await post(15, '/owner/caulk/manufacturers/upsert', { name: `Certified Caulk ${session.runToken}`, isActive: true })).data;
  const product = (await post(15, '/caulk/products/upsert', { manufacturerId: manufacturer.manufacturerId, productName: `Sealant ${session.runToken}`, productCode: `C-${session.runToken}`, warehouse: 'IL1', ownerCompanyId: bootstrap.ownerCompanyId, tubesPerCase: 12, isActive: true, notes: session.runTag })).data;
  await post(15, '/caulk/mutate', { action: 'RECEIVE', productId: product.productId, warehouse: 'IL1', ownerCompanyId: bootstrap.ownerCompanyId, deltaTubes: 12, reason: session.runTag, notes: session.runTag });
  const job5 = (await post(15, '/jobs/create', jobPayload({ jobNumber: jobs[4], film, runTag: session.runTag, caulkRequirements: [{ productId: product.productId, requiredTubes: 4 }] }))).data;
  const job5Id = jobIdentity(job5); const caulkReq = job5.caulkRequirements[0];
  const caulkAllocation = (await post(15, '/allocations/caulk/add', { ...job5Id, requirementId: caulkReq.requirementId, productId: product.productId, ownerCompanyId: bootstrap.ownerCompanyId, warehouse: 'IL1', allocatedTubes: 4, notes: session.runTag })).data;
  const caulkCheckout = (await post(15, '/allocations/caulk/checkout', { caulkAllocationId: caulkAllocation.caulkAllocationId, checkoutTubes: 4, notes: session.runTag })).data;
  await post(15, '/allocations/caulk/checkin', { caulkCheckoutId: caulkCheckout.caulkCheckoutId, unusedTubes: 1, notes: session.runTag }); pass(15, { caulkLifecycle: true });
  await post(16, '/boxes/labels/mark-printed', { boxIds: [boxes[6]] }); pass(16, { labelFlow: true });
  const job6 = (await post(17, '/jobs/create', jobPayload({ jobNumber: jobs[5], film, feet: 10, runTag: session.runTag }))).data;
  const job6Id = jobIdentity(job6); const req6 = filmRequirement(job6);
  await post(17, '/allocations/apply', { ...job6Id, boxId: boxes[5], requestedFeet: 10, requestedWidthIn: 60, requirementId: req6.requirementId, selectedSuggestionBoxIds: [], extraAllocations: [], crossWarehouse: false, jobWarehouse: 'IL1' });
  await post(17, '/jobs/checkout-all', job6Id);
  assert((await post(17, '/jobs/set-staged-pickup', { ...job6Id, isStagedForPickup: true })).data.summary?.isStagedForPickup, 'DEV_REFRESH_WORKFLOW_STAGED_PICKUP_FAILED'); pass(17, { stagedPickup: true });

  const invited = (await post(18, '/owner/team/invite', { email: bootstrap.temporaryEmail, name: 'Temporary Member', role: 'member' })).data;
  assert(['added_existing', 'already_active'].includes(text(invited.outcome)), 'DEV_REFRESH_WORKFLOW_TEAM_INVITE_FAILED');
  appendId(session, key, GOLDEN_WORKFLOW_CONTRACT[17], 'membership', bootstrap.temporaryUserId);
  await post(18, '/owner/team/change-role', { userId: bootstrap.temporaryUserId, role: 'admin' });
  await post(18, '/owner/team/change-role', { userId: bootstrap.temporaryUserId, role: 'member' });
  await post(18, '/owner/team/disable', { userId: bootstrap.temporaryUserId });
  await post(18, '/owner/team/reenable', { userId: bootstrap.temporaryUserId, role: 'member' });
  const nativeMembership = (await post(18, '/owner/team/invite', {
    email: bootstrap.nativeEmail, name: 'Native certification owner', role: 'member'
  }, 200, temporaryToken)).data;
  assert(['added_existing', 'already_active'].includes(text(nativeMembership.outcome)), 'DEV_REFRESH_WORKFLOW_NATIVE_MEMBERSHIP_FAILED');
  appendId(session, key, GOLDEN_WORKFLOW_CONTRACT[17], 'membership', session.fixtureAuthority.smokeActorId, bootstrap.temporaryOrganizationId);
  await post(18, '/auth/organization', { orgId: bootstrap.temporaryOrganizationId });
  await post(18, '/auth/organization', { orgId: session.fixtureAuthority.primaryOrganizationId }); pass(18, { teamLifecycle: true, multiOrganizationSwitch: true });
  const job7 = (await post(19, '/jobs/create', jobPayload({ jobNumber: jobs[6], film, runTag: session.runTag, laborOnly: true }))).data;
  const job7Id = jobIdentity(job7); await post(19, '/jobs/delete', { ...job7Id, reason: session.runTag }); await get('/jobs/get-by-id', { jobId: job7Id.jobId }, 404); pass(19, { jobDeleted: true });
  await post(20, '/auth/organization', { orgId: bootstrap.temporaryOrganizationId }, 200, temporaryToken);
  const secondaryWarehouse = (await post(20, '/owner/warehouses/add', {
    code: 'TX1', name: 'Certification isolation warehouse', boxIdPrefix: 'TX1'
  }, 200, temporaryToken)).data;
  const secondaryOwnerCompany = (await post(20, '/owner/owner-companies/upsert', {
    code: 'CERT', displayName: 'Certification isolation owner'
  }, 200, temporaryToken)).data;
  const secondaryDealer = (await post(20, '/box-dealers/upsert', { name: `Isolation ${session.runToken}` }, 200, temporaryToken)).data;
  const secondaryBoxId = `TX1-CERT-${session.runToken.toUpperCase()}-10`;
  await post(20, '/boxes/add', boxPayload({
    boxId: secondaryBoxId,
    warehouse: secondaryWarehouse.code,
    ownerCompanyId: secondaryOwnerCompany.ownerCompanyId,
    dealer: secondaryDealer.name,
    film: bootstrap.secondaryCatalog,
    initialFeet: 20,
    runTag: session.runTag
  }), 200, temporaryToken);
  await browserApi(page, apiBaseUrl, temporaryToken, 'GET', '/boxes/get', null, { boxId: boxes[0] }, 404);
  await browserApi(page, apiBaseUrl, temporaryToken, 'POST', '/auth/organization', { orgId: session.fixtureAuthority.primaryOrganizationId });
  await browserApi(page, apiBaseUrl, temporaryToken, 'GET', '/boxes/get', null, { boxId: secondaryBoxId }, 404);
  await browserApi(page, apiBaseUrl, temporaryToken, 'GET', '/owner/team/users', null, {}, 403); pass(20, { tenantIsolation: true });
  assert(evidence.length === 20 && evidence.every((entry, index) => entry.name === GOLDEN_WORKFLOW_CONTRACT[index]), 'DEV_REFRESH_WORKFLOW_SET_INCOMPLETE');
  return evidence;
}

async function runWorkflowChild(sessionPath, key) {
  const session = readPrivateJson(sessionPath);
  if (session?.format !== CHILD_SESSION_FORMAT || session.projectRef !== DEV_PROJECT_REF) throw categoricalError('DEV_REFRESH_WORKFLOW_CHILD_SESSION_INVALID');
  createFixtureLedger(session.ledgerPath, key, authorityForAttempt(session.fixtureAuthority, session.attemptId));
  let authServer; let backend; let frontend; let browser;
  let phase = 'BOOTSTRAP';
  session.completedWorkflowIndex = 0;
  try {
    const bootstrap = await bootstrapFixtures(session, key);
    if (session.testOnlyFailureInjection === 'browser_child_first_run_after_bootstrap') {
      throw categoricalError('DEV_REFRESH_WORKFLOW_CERTIFIED_CHILD_INJECTION');
    }
    session.organizationIds = [session.fixtureAuthority.primaryOrganizationId, bootstrap.temporaryOrganizationId];
    const baseline = await withClient(session.connectionString, (client) => captureTrackedIds(client, session.organizationIds));
    phase = 'AUTH_SERVER';
    const authPort = await availablePort(); const backendPort = await availablePort(); const frontendPort = await availablePort();
    session.authUrl = `http://127.0.0.1:${authPort}`;
    authServer = fakeAuthServer(session, bootstrap); await listen(authServer, authPort);
    phase = 'BACKEND_SERVER';
    backend = spawn(process.execPath, ['server.mjs'], {
      cwd: path.join(session.repoRoot, 'backend'), shell: false, windowsHide: true, stdio: 'ignore',
      env: minimalEnvironment({ BACKEND_MODE: 'supabase', PORT: String(backendPort), DATABASE_URL: session.connectionString,
        SUPABASE_URL: session.authUrl, SUPABASE_ANON_KEY: 'local-anon', SUPABASE_SERVICE_ROLE_KEY: 'local-service',
        EDGE_API_BASE_URL: `${session.authUrl}/functions/v1/api`, CORS_ALLOWED_ORIGINS: `http://127.0.0.1:${frontendPort}`,
        API_BUILD_SHA: session.candidateCommit, DEFAULT_ORG_ID: session.fixtureAuthority.primaryOrganizationId })
    });
    await waitForUrl(`http://127.0.0.1:${backendPort}/health`, backend);
    phase = 'FRONTEND_SERVER';
    frontend = spawn(process.execPath, [path.join(session.repoRoot, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', String(frontendPort), '--strictPort'], {
      cwd: path.join(session.repoRoot, 'frontend'), shell: false, windowsHide: true, stdio: 'ignore',
      env: minimalEnvironment({ VITE_API_BASE_URL: `http://127.0.0.1:${backendPort}`, VITE_SUPABASE_URL: session.authUrl, VITE_SUPABASE_ANON_KEY: 'local-anon' })
    });
    await waitForUrl(`http://127.0.0.1:${frontendPort}/`, frontend);
    phase = 'BROWSER';
    browser = await chromium.launch({ executablePath: chromeExecutable(), headless: true });
    const browserContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const networkViolations = []; const pageErrors = [];
    await browserContext.route('**/*', async (route) => {
      const hostname = new URL(route.request().url()).hostname;
      if (!['127.0.0.1', 'localhost'].includes(hostname)) { networkViolations.push(hostname); await route.abort(); return; }
      await route.continue();
    });
    const page = await browserContext.newPage(); page.on('pageerror', () => pageErrors.push('pageerror'));
    await page.goto(`http://127.0.0.1:${frontendPort}/`, { waitUntil: 'domcontentloaded' });
    phase = 'CERTIFIED_WORKFLOWS';
    const workflows = await runTwentyWorkflows(session, key, bootstrap, page, `http://127.0.0.1:${backendPort}`, baseline);
    if (session.testOnlyFailureInjection === 'browser_child_first_run_after_workflows') {
      throw categoricalError('DEV_REFRESH_WORKFLOW_CERTIFIED_CHILD_INJECTION');
    }
    assert(networkViolations.length === 0, 'DEV_REFRESH_WORKFLOW_NETWORK_ISOLATION_FAILED');
    assert(pageErrors.length === 0, 'DEV_REFRESH_WORKFLOW_FRONTEND_RUNTIME_FAILED');
    phase = 'RESULT';
    await recordTrackedDelta(session, key, baseline, GOLDEN_WORKFLOW_CONTRACT[19]);
    const ledger = readFixtureLedger(session.ledgerPath, key, { attemptId: session.attemptId, projectRef: DEV_PROJECT_REF });
    writePrivateJsonExclusive(session.resultPath, {
      format: CHILD_RESULT_FORMAT, workflows, ledgerEntries: ledger.entries.length, ledgerDigest: ledger.byteDigest,
      tenantIsolationExact: true, browserViewport: '390x844', browserNetworkLoopbackOnly: true, frontendLoaded: true
    });
  } catch (error) {
    const category = String(error?.code || error?.message || '');
    if (phase === 'CERTIFIED_WORKFLOWS' && /^DEV_REFRESH_WORKFLOW_API_[A-Z0-9_]+_STATUS_[A-Z0-9_]+$/.test(category)) {
      const nextIndex = Math.min(GOLDEN_WORKFLOW_CONTRACT.length, Number(session.completedWorkflowIndex || 0) + 1);
      throw categoricalError(`DEV_REFRESH_WORKFLOW_STEP_${nextIndex}_${category.replace(/^DEV_REFRESH_WORKFLOW_/, '')}`);
    }
    if (/^DEV_REFRESH_[A-Z0-9_]+$/.test(category)) throw error;
    const sqlState = String(error?.code || '').toUpperCase();
    if (/^[0-9A-Z]{5}$/.test(sqlState)) {
      throw categoricalError(`DEV_REFRESH_WORKFLOW_${phase}_SQLSTATE_${sqlState}`);
    }
    if (phase === 'CERTIFIED_WORKFLOWS') {
      const nextIndex = Math.min(GOLDEN_WORKFLOW_CONTRACT.length, Number(session.completedWorkflowIndex || 0) + 1);
      throw categoricalError(`DEV_REFRESH_WORKFLOW_STEP_${nextIndex}_FAILED`);
    }
    if (error?.name === 'TypeError') throw categoricalError(`DEV_REFRESH_WORKFLOW_${phase}_TYPE_ERROR`);
    throw categoricalError(`DEV_REFRESH_WORKFLOW_${phase}_FAILED`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopChild(frontend); await stopChild(backend);
    if (authServer?.listening) await new Promise((resolve) => authServer.close(resolve));
  }
}

function spawnWorkflowChild(sessionPath, failurePath, key, timeoutMs = 30 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [THIS_FILE, '--child', sessionPath], {
      cwd: path.resolve(path.dirname(THIS_FILE), '..', '..', '..', '..'), shell: false, windowsHide: true,
      env: minimalEnvironment({ DEV_REFRESH_WORKFLOW_KEY_FD: '4', DEV_REFRESH_WORKFLOW_ERROR_FD: '5' }),
      stdio: ['ignore', 'ignore', 'ignore', 'ignore', 'pipe', 'pipe']
    });
    const keyBytes = Buffer.from(key); child.stdio[4].on('error', () => {}); child.stdio[4].end(keyBytes, () => keyBytes.fill(0));
    const failureChunks = [];
    let failureBytes = 0;
    child.stdio[5].on('data', (chunk) => {
      failureBytes += chunk.length;
      if (failureBytes <= 256) failureChunks.push(Buffer.from(chunk));
    });
    let settled = false; const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const clearFailureChunks = () => {
      failureChunks.forEach((chunk) => chunk.fill(0));
      failureChunks.length = 0;
      failureBytes = 0;
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      child.stdio[5].removeAllListeners();
      clearFailureChunks();
      error ? reject(error) : resolve();
    };
    child.once('error', () => finish(categoricalError('DEV_REFRESH_WORKFLOW_CHILD_SPAWN_FAILED')));
    child.once('exit', (code, signal) => {
      if (code === 0 && !signal) { finish(); return; }
      let category = 'DEV_REFRESH_WORKFLOW_CHILD_FAILED';
      if (failureChunks.length && failureBytes <= 256) {
        const bytes = Buffer.concat(failureChunks);
        try {
          const observed = bytes.toString('utf8');
          if (/^DEV_REFRESH_[A-Z0-9_]{1,100}$/.test(observed)) category = observed;
        } finally {
          bytes.fill(0);
        }
      }
      if (fs.existsSync(failurePath)) {
        try {
          const failure = readPrivateJson(failurePath);
          if (/^DEV_REFRESH_[A-Z0-9_]{1,100}$/.test(String(failure?.category || ''))) {
            category = String(failure.category);
          }
        } catch {}
      }
      finish(categoricalError(category));
    });
  });
}

function runSessionPaths(rootDirectory, runNumber) {
  return {
    sessionPath: privateArtifactPath(rootDirectory, `workflow-${runNumber}-session.private.json`),
    ledgerPath: privateArtifactPath(rootDirectory, `workflow-${runNumber}-ledger.private.jsonl`),
    resultPath: privateArtifactPath(rootDirectory, `workflow-${runNumber}-result.private.json`),
    failurePath: privateArtifactPath(rootDirectory, `workflow-${runNumber}-failure.private.json`)
  };
}

async function runCertifiedWorkflowHarness({
  repoRoot,
  connectionString,
  fixtureAuthority,
  rootDirectory,
  key,
  attemptId,
  maxBrowserChildRetries = 1,
  testOnlyFailureInjection = ''
} = {}) {
  if (![
    '',
    'browser_child_first_run_after_bootstrap',
    'browser_child_first_run_after_workflows'
  ].includes(testOnlyFailureInjection)) {
    throw categoricalError('DEV_REFRESH_WORKFLOW_FAILURE_INJECTION_INVALID');
  }
  const strictBefore = await captureStrictWorkflowState(connectionString, fixtureAuthority);
  let retries = 0;
  for (let runNumber = 1; runNumber <= maxBrowserChildRetries + 1; runNumber += 1) {
    const files = runSessionPaths(rootDirectory, runNumber);
    const session = {
      format: CHILD_SESSION_FORMAT, projectRef: DEV_PROJECT_REF, attemptId, runNumber,
      runToken: crypto.randomBytes(6).toString('hex'), runTag: `dev-certified-${attemptId}-workflow-${runNumber}`,
      candidateCommit: fixtureAuthority.candidateCommit || '', repoRoot: path.resolve(repoRoot), connectionString,
      fixtureAuthority: authorityForAttempt(fixtureAuthority, attemptId), ledgerPath: files.ledgerPath,
      resultPath: files.resultPath, failurePath: files.failurePath,
      testOnlyFailureInjection: runNumber === 1 ? testOnlyFailureInjection : ''
    };
    writePrivateJsonExclusive(files.sessionPath, session);
    try {
      await spawnWorkflowChild(files.sessionPath, files.failurePath, key);
      const result = readPrivateJson(files.resultPath);
      if (result?.format !== CHILD_RESULT_FORMAT || result.workflows?.length !== 20) throw categoricalError('DEV_REFRESH_WORKFLOW_CHILD_RESULT_INVALID');
      return { ...result, ledgerPath: files.ledgerPath, browserChildRetries: retries };
    } catch (error) {
      if (!fs.existsSync(files.ledgerPath) || runNumber > maxBrowserChildRetries) throw error;
      await cleanupCertifiedWorkflowFixtures({ connectionString, ledgerPath: files.ledgerPath, key, fixtureAuthority });
      await verifyCertifiedWorkflowCleanup({ connectionString, ledgerPath: files.ledgerPath, key });
      const strictAfterCleanup = await captureStrictWorkflowState(connectionString, fixtureAuthority);
      if (canonicalDigest(strictAfterCleanup) !== canonicalDigest(strictBefore)) {
        throw categoricalError('DEV_REFRESH_WORKFLOW_RETRY_PARITY_FAILED');
      }
      retries += 1;
    }
  }
  throw categoricalError('DEV_REFRESH_WORKFLOW_RETRY_EXHAUSTED');
}

function splitStableId(target, count) {
  const values = String(target.stableId).split('|');
  if (values.length !== count || values.some((value) => !value)) throw categoricalError('DEV_REFRESH_FIXTURE_CLEANUP_ID_INVALID');
  return values;
}

function ownerGuardContractDigest(guard) {
  const { enabled: _enabled, ...contract } = guard;
  return canonicalDigest(contract);
}

function expectedOwnerGuardSource() {
  const repoRoot = path.resolve(path.dirname(THIS_FILE), '..', '..', '..', '..');
  const migration = fs.readFileSync(
    path.join(repoRoot, 'backend', 'migrations', '0184_team_user_invite_management.sql'),
    'utf8'
  );
  return extractOwnerGuardFunctionSource(migration);
}

function expectedBoxTransferGuardSource() {
  const repoRoot = path.resolve(path.dirname(THIS_FILE), '..', '..', '..', '..');
  const migration = fs.readFileSync(
    path.join(repoRoot, 'backend', 'migrations', '0191_atomic_cross_warehouse_transfer_assisted_allocation.sql'),
    'utf8'
  );
  return extractBoxTransferGuardFunctionSource(migration);
}

async function countLedgerResidue(connectionString, targets) {
  return withClient(connectionString, async (client) => {
    let residue = 0;
    for (const target of targets) {
      if (target.entityType === 'organization') residue += Number((await client.query('select count(*)::integer count from app.organizations where id=$1::uuid', [target.stableId])).rows[0].count);
      else if (target.entityType === 'temporary_auth_user') residue += Number((await client.query('select count(*)::integer count from auth.users where id=$1::uuid', [target.stableId])).rows[0].count);
      else if (target.entityType === 'temporary_auth_identity') residue += Number((await client.query('select count(*)::integer count from auth.identities where id=$1::uuid', [target.stableId])).rows[0].count);
      else if (target.entityType === 'membership') residue += Number((await client.query('select count(*)::integer count from app.organization_members where org_id=$1::uuid and user_id=$2::uuid', [target.organizationId, target.stableId])).rows[0].count);
      else if (target.entityType === 'preference_restore') {
        const observed = (await client.query(
          `select default_warehouse, updated_at, updated_by
             from app.user_preferences
            where org_id=$1::uuid and user_id=$2::uuid`,
          [target.organizationId, target.stableId]
        )).rows[0];
        if (
          !observed || text(observed.default_warehouse) !== target.restore.defaultWarehouse ||
          new Date(observed.updated_at).toISOString() !== target.restore.updatedAt ||
          String(observed.updated_by || '') !== target.restore.updatedBy
        ) residue += 1;
      }
      else if (target.entityType === 'organization_preference') {
        residue += Number((await client.query(
          'select count(*)::integer count from app.user_organization_preferences where user_id=$1::uuid',
          [target.stableId]
        )).rows[0].count);
      }
      else if (target.entityType === 'organization_preference_restore') {
        const observed = (await client.query(
          'select selected_org_id::text, updated_at, updated_by_user_id::text from app.user_organization_preferences where user_id=$1::uuid',
          [target.stableId]
        )).rows[0] || null;
        if (target.restore.existed === false) {
          if (observed) residue += 1;
        } else if (
          !observed || observed.selected_org_id !== target.restore.selectedOrganizationId ||
          new Date(observed.updated_at).toISOString() !== target.restore.updatedAt ||
          observed.updated_by_user_id !== target.restore.updatedByUserId
        ) residue += 1;
      }
      else if (target.entityType === 'owner_notification_preference_restore') {
        const observed = (await client.query(
          `select in_app_opt_in, email_opt_in, updated_at, updated_by
             from app.owner_notification_preferences
            where org_id=$1::uuid and owner_user_id=$2::uuid`,
          [target.organizationId, target.stableId]
        )).rows[0] || null;
        if (target.restore.existed === false) {
          if (observed) residue += 1;
        } else if (
          !observed || observed.in_app_opt_in !== target.restore.inAppOptIn ||
          observed.email_opt_in !== target.restore.emailOptIn ||
          new Date(observed.updated_at).toISOString() !== target.restore.updatedAt ||
          String(observed.updated_by || '') !== target.restore.updatedBy
        ) residue += 1;
      }
      else if (TRACKED_TABLES[target.entityType]) {
        const definition = TRACKED_TABLES[target.entityType]; const values = splitStableId(target, definition.keys.length);
        const predicates = definition.keys.map((column, index) => `"${column}"::text=$${index + 2}`).join(' and ');
        residue += Number((await client.query(`select count(*)::integer count from app."${definition.table}" where org_id=$1::uuid and ${predicates}`, [target.organizationId, ...values])).rows[0].count);
      }
    }
    return residue;
  });
}

async function cleanupCertifiedWorkflowFixtures({ connectionString, ledgerPath, key } = {}) {
  const ledger = readFixtureLedger(ledgerPath, key);
  const targets = cleanupTargetsFromLedger(ledgerPath, key); let removed = 0;
  await withClient(connectionString, async (client) => {
    await client.query('begin isolation level serializable');
    try {
      const groups = new Map();
      for (const target of targets) { if (!groups.has(target.entityType)) groups.set(target.entityType, []); groups.get(target.entityType).push(target); }
      const organizationEntries = groups.get('organization') || [];
      const boxTransferEntries = groups.get('box_transfer') || [];
      let ownerGuardBefore = null;
      let boxTransferGuardBefore = null;
      const ownerGuardSource = organizationEntries.length ? expectedOwnerGuardSource() : '';
      const boxTransferGuardSource = boxTransferEntries.length ? expectedBoxTransferGuardSource() : '';
      if (organizationEntries.length) {
        ownerGuardBefore = await captureOwnerGuard(client, ownerGuardSource);
        await client.query(`ALTER TABLE app.organization_members DISABLE TRIGGER ${OWNER_GUARD_TRIGGER}`);
        const ownerGuardDisabled = await captureOwnerGuard(client, ownerGuardSource, { expectedEnabled: 'D' });
        if (ownerGuardContractDigest(ownerGuardDisabled) !== ownerGuardContractDigest(ownerGuardBefore)) {
          throw categoricalError('DEV_REFRESH_FIXTURE_OWNER_GUARD_DISABLE_DRIFT');
        }
      }
      if (boxTransferEntries.length) {
        boxTransferGuardBefore = await captureBoxTransferGuard(client, boxTransferGuardSource);
        await client.query(`ALTER TABLE app.box_transfers DISABLE TRIGGER ${BOX_TRANSFER_GUARD_TRIGGER}`);
        const boxTransferGuardDisabled = await captureBoxTransferGuard(client, boxTransferGuardSource, { expectedEnabled: 'D' });
        if (ownerGuardContractDigest(boxTransferGuardDisabled) !== ownerGuardContractDigest(boxTransferGuardBefore)) {
          throw categoricalError('DEV_REFRESH_FIXTURE_BOX_TRANSFER_GUARD_DISABLE_DRIFT');
        }
      }
      const order = ['team_audit','audit_row','access_request','film_weight_pending_review','film_weight_sample','roll_history','planner_suppression','caulk_checkout','caulk_transaction','caulk_allocation','caulk_stock','box_transfer','allocation','job_caulk_requirement','film_order_link','film_order','film_order_event','job_requirement','job_phase','job','box_alias','box','dealer','caulk_product','caulk_manufacturer','film_catalog','preference_restore','preference','owner_notification_preference_restore','organization_preference_restore','organization_preference','general_permission','owner_company','warehouse','organization','membership','temporary_auth_identity','temporary_auth_user'];
      for (const entityType of order) {
        const entries = groups.get(entityType) || [];
        if (entityType === 'film_order_event') {
          const known = new Set(entries.map((entry) => `${entry.organizationId}\u0000${entry.stableId}`));
          const generated = [];
          for (const filmOrder of groups.get('film_order') || []) {
            const rows = (await client.query(
              `select event_id::text
                 from app.film_order_events
                where org_id=$1::uuid and film_order_id=$2::text
                order by event_id`,
              [filmOrder.organizationId, filmOrder.stableId]
            )).rows;
            for (const row of rows) {
              const identity = `${filmOrder.organizationId}\u0000${row.event_id}`;
              if (known.has(identity)) continue;
              known.add(identity);
              generated.push({
                workflow: GOLDEN_WORKFLOW_CONTRACT[10],
                entityType: 'film_order_event',
                stableId: String(row.event_id),
                organizationId: filmOrder.organizationId,
                actorId: ledger.authority.smokeActorId
              });
            }
          }
          if (generated.length) {
            appendFixtureIds(ledgerPath, key, generated);
            entries.push(...generated);
            targets.push(...generated);
          }
        }
        for (const entry of entries) {
          if (entityType === 'organization') removed += (await client.query('delete from app.organizations where id=$1::uuid', [entry.stableId])).rowCount;
          else if (entityType === 'temporary_auth_identity') removed += (await client.query('delete from auth.identities where id=$1::uuid', [entry.stableId])).rowCount;
          else if (entityType === 'temporary_auth_user') removed += (await client.query('delete from auth.users where id=$1::uuid', [entry.stableId])).rowCount;
          else if (entityType === 'membership') removed += (await client.query('delete from app.organization_members where org_id=$1::uuid and user_id=$2::uuid', [entry.organizationId, entry.stableId])).rowCount;
          else if (entityType === 'preference_restore') {
            removed += (await client.query(
              `insert into app.user_preferences(org_id,user_id,default_warehouse,updated_at,updated_by)
               values($1::uuid,$2::uuid,$3,$4::timestamptz,$5)
               on conflict(org_id,user_id) do update set
                 default_warehouse=excluded.default_warehouse,
                 updated_at=excluded.updated_at,
                 updated_by=excluded.updated_by`,
              [entry.organizationId, entry.stableId, entry.restore.defaultWarehouse, entry.restore.updatedAt, entry.restore.updatedBy]
            )).rowCount;
          }
          else if (entityType === 'organization_preference_restore') {
            if (entry.restore.existed === false) {
              removed += (await client.query(
                'delete from app.user_organization_preferences where user_id=$1::uuid',
                [entry.stableId]
              )).rowCount;
            } else {
              removed += (await client.query(
                `insert into app.user_organization_preferences(user_id,selected_org_id,updated_at,updated_by_user_id)
                 values($1::uuid,$2::uuid,$3::timestamptz,$4::uuid)
                 on conflict(user_id) do update set selected_org_id=excluded.selected_org_id,
                   updated_at=excluded.updated_at, updated_by_user_id=excluded.updated_by_user_id`,
                [entry.stableId, entry.restore.selectedOrganizationId, entry.restore.updatedAt, entry.restore.updatedByUserId]
              )).rowCount;
            }
          }
          else if (entityType === 'owner_notification_preference_restore') {
            if (entry.restore.existed === false) {
              removed += (await client.query(
                'delete from app.owner_notification_preferences where org_id=$1::uuid and owner_user_id=$2::uuid',
                [entry.organizationId, entry.stableId]
              )).rowCount;
            } else {
              removed += (await client.query(
                `insert into app.owner_notification_preferences(
                   org_id,owner_user_id,in_app_opt_in,email_opt_in,updated_at,updated_by
                 ) values($1::uuid,$2::uuid,$3::boolean,$4::boolean,$5::timestamptz,$6::text)
                 on conflict(org_id,owner_user_id) do update set
                   in_app_opt_in=excluded.in_app_opt_in,
                   email_opt_in=excluded.email_opt_in,
                   updated_at=excluded.updated_at,
                   updated_by=excluded.updated_by`,
                [entry.organizationId, entry.stableId, entry.restore.inAppOptIn,
                  entry.restore.emailOptIn, entry.restore.updatedAt, entry.restore.updatedBy]
              )).rowCount;
            }
          }
          else if (entityType === 'organization_preference') {
            removed += (await client.query(
              'delete from app.user_organization_preferences where user_id=$1::uuid',
              [entry.stableId]
            )).rowCount;
          }
          else {
            const definition = TRACKED_TABLES[entityType]; if (!definition) throw categoricalError('DEV_REFRESH_FIXTURE_CLEANUP_ENTITY_UNSUPPORTED');
            const values = splitStableId(entry, definition.keys.length);
            const predicates = definition.keys.map((column, index) => `"${column}"::text=$${index + 2}`).join(' and ');
            removed += (await client.query(`delete from app."${definition.table}" where org_id=$1::uuid and ${predicates}`, [entry.organizationId, ...values])).rowCount;
          }
        }
        if (entityType === 'organization' && ownerGuardBefore) {
          await client.query(`ALTER TABLE app.organization_members ENABLE TRIGGER ${OWNER_GUARD_TRIGGER}`);
          const ownerGuardRestored = await captureOwnerGuard(client, ownerGuardSource);
          if (canonicalDigest(ownerGuardRestored) !== canonicalDigest(ownerGuardBefore)) {
            throw categoricalError('DEV_REFRESH_FIXTURE_OWNER_GUARD_RESTORE_DRIFT');
          }
        }
        if (entityType === 'box_transfer' && boxTransferGuardBefore) {
          await client.query('SET CONSTRAINTS ALL IMMEDIATE');
          await client.query(`ALTER TABLE app.box_transfers ENABLE TRIGGER ${BOX_TRANSFER_GUARD_TRIGGER}`);
          const boxTransferGuardRestored = await captureBoxTransferGuard(client, boxTransferGuardSource);
          if (canonicalDigest(boxTransferGuardRestored) !== canonicalDigest(boxTransferGuardBefore)) {
            throw categoricalError('DEV_REFRESH_FIXTURE_BOX_TRANSFER_GUARD_RESTORE_DRIFT');
          }
        }
      }
      await client.query('commit');
    } catch (error) { await client.query('rollback').catch(() => {}); throw error; }
  });
  const residue = await countLedgerResidue(connectionString, targets);
  if (residue !== 0) throw categoricalError('DEV_REFRESH_FIXTURE_CLEANUP_RESIDUE');
  closeFixtureLedger(ledgerPath, key, { removedCount: removed, residueCount: 0, parityDigest: canonicalDigest({ residue: 0, targets: targets.length }) });
  return { fixtureResidue: 0, removedCount: removed, targetCount: targets.length, exactLedgerIdsOnly: true };
}

async function verifyCertifiedWorkflowCleanup({ connectionString, ledgerPath, key } = {}) {
  const ledger = readFixtureLedger(ledgerPath, key);
  if (ledger.terminal?.status !== 'cleanup_verified') throw categoricalError('DEV_REFRESH_FIXTURE_LEDGER_NOT_CLOSED');
  if (await countLedgerResidue(connectionString, ledger.entries) !== 0) throw categoricalError('DEV_REFRESH_FIXTURE_CLEANUP_RESIDUE');
  return { fixtureResidue: 0, ledgerClosed: true, exactTargets: ledger.entries.length };
}

async function childMain() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--child') throw categoricalError('DEV_REFRESH_WORKFLOW_CHILD_ARGUMENT_INVALID');
  const key = readKeyFromFd();
  const sessionPath = path.resolve(args[1]);
  try {
    await runWorkflowChild(sessionPath, key);
  } catch (error) {
    try {
      const session = readPrivateJson(sessionPath);
      const category = String(error?.code || error?.message || 'DEV_REFRESH_WORKFLOW_CHILD_FAILED')
        .replace(/[^A-Z0-9_]/gi, '_').slice(0, 110);
      writePrivateJsonExclusive(session.failurePath, {
        format: 'dev-certified-workflow-child-failure-v1',
        category: /^DEV_REFRESH_[A-Z0-9_]+$/.test(category)
          ? category
          : 'DEV_REFRESH_WORKFLOW_CHILD_FAILED'
      });
    } catch {}
    throw error;
  } finally {
    key.fill(0);
  }
}

function writeCategoricalChildFailure(error) {
  const descriptor = Number(process.env.DEV_REFRESH_WORKFLOW_ERROR_FD);
  if (!Number.isInteger(descriptor) || descriptor < 3) return;
  const category = String(error?.code || error?.message || 'DEV_REFRESH_WORKFLOW_CHILD_FAILED')
    .replace(/[^A-Z0-9_]/gi, '_').slice(0, 110);
  const bytes = Buffer.from(
    /^DEV_REFRESH_[A-Z0-9_]+$/.test(category) ? category : 'DEV_REFRESH_WORKFLOW_CHILD_FAILED',
    'utf8'
  );
  try { fs.writeSync(descriptor, bytes); }
  catch {}
  finally { bytes.fill(0); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(THIS_FILE) && process.argv[2] === '--child') {
  childMain().catch((error) => { writeCategoricalChildFailure(error); process.exitCode = 1; });
}

export {
  CHILD_RESULT_FORMAT,
  CHILD_SESSION_FORMAT,
  TRACKED_TABLES,
  cleanupCertifiedWorkflowFixtures,
  runCertifiedWorkflowHarness,
  verifyCertifiedWorkflowCleanup
};
