#!/usr/bin/env node

import { performance } from 'node:perf_hooks';
import { Client } from 'pg';

import { resolveSmokeAuthToken } from './lib/smoke-auth.mjs';
import {
  loadDevFixtureConfig,
  normalizeFixtureTag,
  parseArgs,
} from './dev-fixtures/lib/dev-fixture-guard.mjs';
import { readManifest } from './dev-fixtures/lib/dev-fixture-manifest.mjs';

const AUTHENTICATED_LIMIT_MS = 8_000;
const VERIFICATION_GATE_MS = 6_000;
const ACTOR = 'codex-allocation-timeout-verifier';
let verificationStage = 'startup';

function asText(value) {
  return String(value ?? '').trim();
}

function assert(condition, code) {
  if (!condition) {
    throw new Error(code);
  }
}

function asObject(value) {
  if (typeof value === 'string') {
    return JSON.parse(value);
  }
  return value && typeof value === 'object' ? value : {};
}

function requireFixtureSummary(manifest) {
  assert(manifest?.scenario === 'allocation-timeout-remediation', 'FIXTURE_SCENARIO_MISMATCH');
  const oneBox = manifest?.summary?.oneBox || {};
  const threeBox = manifest?.summary?.threeBox || {};
  assert(asText(oneBox.jobId) && asText(oneBox.requirementId) && asText(oneBox.boxId), 'ONE_BOX_FIXTURE_INCOMPLETE');
  assert(
    asText(threeBox.jobId) &&
      asText(threeBox.requirementId) &&
      asText(threeBox.sourceBoxId) &&
      Array.isArray(threeBox.candidateBoxIds) &&
      threeBox.candidateBoxIds.length === 2 &&
      asText(threeBox.extraBoxId),
    'THREE_BOX_FIXTURE_INCOMPLETE'
  );
  return { oneBox, threeBox, warehouse: asText(manifest?.summary?.warehouse).toUpperCase() };
}

function allocationPayload(fixture, { includeExtra = false } = {}) {
  return {
    jobId: fixture.jobId,
    jobNumber: fixture.jobNumber,
    boxId: fixture.sourceBoxId || fixture.boxId,
    requestedFeet: Number(fixture.requestedFeet),
    requestedWidthIn: Number(fixture.widthIn),
    requirementId: fixture.requirementId,
    selectedSuggestionBoxIds: Array.isArray(fixture.candidateBoxIds)
      ? [...fixture.candidateBoxIds].reverse()
      : [],
    extraAllocations: includeExtra
      ? [{ boxId: fixture.extraBoxId, allocatedFeet: Number(fixture.extraFeet) }]
      : [],
    crossWarehouse: false,
    jobWarehouse: fixture.warehouse,
    autoAllocate: false,
  };
}

async function configureAuthenticatedSession(client, orgId, smokeUserEmail) {
  const identity = await client.query(
    `
      select u.id::text as user_id
      from auth.users u
      join app.organization_members member
        on member.user_id = u.id
       and member.org_id = $1::uuid
       and member.status = 'active'
      order by
        case when $2::text <> '' and lower(u.email) = lower($2::text) then 0 else 1 end,
        case lower(member.role::text) when 'owner' then 0 when 'admin' then 1 else 2 end,
        u.id
      limit 1
    `,
    [orgId, asText(smokeUserEmail)]
  );
  const userId = asText(identity.rows[0]?.user_id);
  assert(userId, 'AUTHENTICATED_MEMBER_NOT_FOUND');
  const claims = JSON.stringify({ sub: userId, role: 'authenticated' });
  await client.query(
    `
      select
        set_config('request.jwt.claim.sub', $1::text, true),
        set_config('request.jwt.claim.role', 'authenticated', true),
        set_config('request.jwt.claim.email', '', true),
        set_config('request.jwt.claims', $2::text, true),
        set_config('app.actor', $3::text, true)
    `,
    [userId, claims, ACTOR]
  );
}

async function callAllocator(client, signature, orgId, payload) {
  const result = await client.query(
    `select ${signature}($1::uuid, $2::text, $3::jsonb) as result`,
    [orgId, ACTOR, JSON.stringify(payload)]
  );
  return asObject(result.rows[0]?.result);
}

async function captureOutcome(client, orgId, response, expectedJobId, affectedBoxIds) {
  const allocationIds = Array.isArray(response?.allocationIds) ? response.allocationIds.map(asText) : [];
  const allocations = await client.query(
    `
      select
        requested.ordinality::integer as ordinal,
        a.box_id::text as box_id,
        (a.job_id = $3::uuid) as expected_job,
        a.warehouse::text as warehouse,
        coalesce(to_char(a.job_date, 'YYYY-MM-DD'), '') as job_date,
        a.allocated_feet::integer as allocated_feet,
        a.covered_feet::integer as covered_feet,
        a.status::text as status,
        a.crew_leader::text as crew_leader,
        a.film_order_id::text as film_order_id,
        a.allocation_kind::text as allocation_kind,
        (a.requirement_id is not null) as requirement_bound,
        a.allocation_source::text as allocation_source
      from unnest($2::text[]) with ordinality requested(allocation_id, ordinality)
      join app.allocations a
        on a.org_id = $1::uuid
       and a.allocation_id = requested.allocation_id
      order by requested.ordinality
    `,
    [orgId, allocationIds, expectedJobId]
  );
  const boxes = await client.query(
    `
      select
        b.box_id::text as box_id,
        b.status::text as status,
        b.warehouse::text as warehouse,
        b.feet_available::integer as feet_available,
        app_api.box_physical_feet_available(b)::integer as physical_feet,
        app_api.box_allocatable_now_feet(b)::integer as allocatable_feet
      from app.boxes b
      where b.org_id = $1::uuid
        and b.box_id = any($2::text[])
      order by b.box_id
    `,
    [orgId, affectedBoxIds]
  );
  return {
    responseShape: [...Object.keys(response || {}), ...(Object.hasOwn(response || {}, 'transferIds') ? [] : ['transferIds'])].sort(),
    filmOrderId: asText(response?.filmOrderId),
    remainingUncoveredFeet: Number(response?.remainingUncoveredFeet || 0),
    warnings: Array.isArray(response?.warnings) ? response.warnings : [],
    transferCount: Array.isArray(response?.transferIds) ? response.transferIds.length : 0,
    allocations: allocations.rows,
    boxes: boxes.rows,
  };
}

async function verifyGoldenParity(config, fixture) {
  const client = new Client({
    connectionString: config.databaseUrl,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  const payload = allocationPayload({ ...fixture.threeBox, warehouse: fixture.warehouse }, { includeExtra: true });
  const affectedBoxIds = [
    fixture.threeBox.sourceBoxId,
    ...fixture.threeBox.candidateBoxIds,
    fixture.threeBox.extraBoxId,
  ];
  try {
    verificationStage = 'golden-session';
    await client.query('begin');
    await client.query(`set local statement_timeout = '30s'`);
    await configureAuthenticatedSession(client, config.orgId, config.smokeUserEmail);

    verificationStage = 'golden-preserved-allocator';
    await client.query('savepoint pre_0191_allocator');
    const preservedResponse = await callAllocator(
      client,
      'app_api.api_allocations_apply_pre_0191',
      config.orgId,
      payload
    );
    const preserved = await captureOutcome(
      client,
      config.orgId,
      preservedResponse,
      fixture.threeBox.jobId,
      affectedBoxIds
    );
    await client.query('rollback to savepoint pre_0191_allocator');

    verificationStage = 'golden-remediated-allocator';
    await client.query('savepoint allocator_0192');
    const remediatedResponse = await callAllocator(
      client,
      'public.api_allocations_apply',
      config.orgId,
      payload
    );
    const remediated = await captureOutcome(
      client,
      config.orgId,
      remediatedResponse,
      fixture.threeBox.jobId,
      affectedBoxIds
    );
    await client.query('rollback to savepoint allocator_0192');

    verificationStage = 'golden-comparison';
    assert(JSON.stringify(remediated) === JSON.stringify(preserved), 'GOLDEN_PARITY_MISMATCH');
    assert(remediated.allocations.length === 4, 'GOLDEN_ALLOCATION_COUNT_MISMATCH');
    assert(
      remediated.allocations.map((row) => row.box_id).join('|') ===
        [
          fixture.threeBox.sourceBoxId,
          ...[...fixture.threeBox.candidateBoxIds].sort(),
          fixture.threeBox.extraBoxId,
        ].join('|'),
      'GOLDEN_CANDIDATE_ORDER_MISMATCH'
    );
    assert(remediated.transferCount === 0, 'GOLDEN_UNEXPECTED_TRANSFER');
    await client.query('rollback');
    return { ran: true, passed: true, allocationCount: remediated.allocations.length };
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {}
    throw error;
  } finally {
    await client.end();
  }
}

function resolveSurfaceUrl(config, surface, baseUrl) {
  if (surface === 'postgrest') {
    return `${asText(process.env.SUPABASE_URL).replace(/\/+$/g, '')}/rest/v1/rpc/api_acl_allocations_apply`;
  }
  const resolved = asText(baseUrl) || `${asText(process.env.SUPABASE_URL).replace(/\/+$/g, '')}/functions/v1/api`;
  const url = new URL(resolved);
  url.searchParams.set('path', '/allocations/apply');
  return url.toString();
}

async function timedSurfaceCall({ config, surface, baseUrl, token, payload }) {
  const url = resolveSurfaceUrl(config, surface, baseUrl);
  const body = surface === 'postgrest'
    ? { p_org_id: config.orgId, p_actor: ACTOR, p_payload: payload }
    : payload;
  const started = performance.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: asText(process.env.SUPABASE_ANON_KEY),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AUTHENTICATED_LIMIT_MS),
  });
  const elapsedMs = performance.now() - started;
  await response.arrayBuffer();
  assert(response.ok, `${surface.toUpperCase()}_HTTP_FAILURE`);
  assert(elapsedMs < VERIFICATION_GATE_MS, `${surface.toUpperCase()}_SIX_SECOND_GATE_FAILURE`);
  return Number(elapsedMs.toFixed(2));
}

async function verifyPersistedResults(config, fixture) {
  const client = new Client({
    connectionString: config.databaseUrl,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const result = await client.query(
      `
        select
          count(*) filter (where a.job_id = $2::uuid)::integer as one_box_allocations,
          count(*) filter (where a.job_id = $3::uuid)::integer as three_box_allocations,
          count(distinct a.box_id) filter (where a.job_id = $3::uuid)::integer as three_box_count,
          count(t.id)::integer as pending_transfer_count
        from app.allocations a
        left join app.boxes b
          on b.org_id = a.org_id
         and b.box_id = a.box_id
        left join app.box_transfers t
          on t.org_id = b.org_id
         and t.box_record_id = b.id
         and t.status = 'PENDING'
        where a.org_id = $1::uuid
          and a.status = 'ACTIVE'
          and a.job_id in ($2::uuid, $3::uuid)
      `,
      [config.orgId, fixture.oneBox.jobId, fixture.threeBox.jobId]
    );
    const row = result.rows[0] || {};
    assert(Number(row.one_box_allocations) === 1, 'ONE_BOX_PERSISTED_COUNT_MISMATCH');
    assert(Number(row.three_box_allocations) === 3, 'THREE_BOX_PERSISTED_COUNT_MISMATCH');
    assert(Number(row.three_box_count) === 3, 'THREE_BOX_DISTINCT_COUNT_MISMATCH');
    assert(Number(row.pending_transfer_count) === 0, 'SAME_WAREHOUSE_TRANSFER_CREATED');
    return { oneBoxAllocationCount: 1, threeBoxAllocationCount: 3 };
  } finally {
    await client.end();
  }
}

async function main() {
  verificationStage = 'fixture-load';
  const args = parseArgs(process.argv.slice(2));
  const surface = asText(args.surface || 'postgrest').toLowerCase();
  assert(['postgrest', 'edge'].includes(surface), 'INVALID_SURFACE');
  const tag = normalizeFixtureTag(args.tag);
  const config = loadDevFixtureConfig({ ...args, env: args.env || '.env' });
  const { manifest } = readManifest(config, tag);
  assert(manifest, 'FIXTURE_MANIFEST_NOT_FOUND');
  const fixture = requireFixtureSummary(manifest);
  fixture.oneBox.warehouse = fixture.warehouse;
  fixture.threeBox.warehouse = fixture.warehouse;

  const golden = args.golden === true || asText(args.golden).toLowerCase() === 'true'
    ? await verifyGoldenParity(config, fixture)
    : { ran: false };
  verificationStage = 'authentication';
  const { token, source } = await resolveSmokeAuthToken({
    env: process.env,
    required: true,
    requiredFor: 'DEV allocation timeout verification',
  });
  verificationStage = 'one-box-call';
  const oneBoxMs = await timedSurfaceCall({
    config,
    surface,
    baseUrl: args['base-url'],
    token,
    payload: allocationPayload(fixture.oneBox),
  });
  verificationStage = 'three-box-call';
  const threeBoxMs = await timedSurfaceCall({
    config,
    surface,
    baseUrl: args['base-url'],
    token,
    payload: allocationPayload(fixture.threeBox),
  });
  verificationStage = 'persisted-result-check';
  const persisted = await verifyPersistedResults(config, fixture);

  console.log(JSON.stringify({
    ok: true,
    target: 'dev',
    projectRef: config.projectRef,
    surface,
    authSource: source,
    authenticatedLimitMs: AUTHENTICATED_LIMIT_MS,
    gateMs: VERIFICATION_GATE_MS,
    timingsMs: { oneBox: oneBoxMs, threeBox: threeBoxMs },
    golden,
    persisted,
  }, null, 2));
}

main().catch((error) => {
  const assertionCode = /^[A-Z][A-Z0-9_]+$/.test(asText(error?.message))
    ? asText(error.message)
    : '';
  const sqlState = /^[0-9A-Z]{5}$/.test(asText(error?.code)) ? asText(error.code) : '';
  console.error(JSON.stringify({
    ok: false,
    stage: verificationStage,
    assertionCode: assertionCode || undefined,
    sqlState: sqlState || undefined,
  }));
  process.exit(1);
});
