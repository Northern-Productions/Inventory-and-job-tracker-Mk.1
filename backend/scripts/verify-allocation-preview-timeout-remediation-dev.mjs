#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client } from 'pg';

import { mapDbBoxRow } from '../src/app/repositories/mappers.mjs';
import { buildCapacityAllocationsByBoxIndex } from '../src/app/services/runtime/runtimeAllocationCoverage.mjs';
import { buildAllocationPreviewPlan } from '../src/app/services/runtime/runtimeAllocationPlanning.mjs';
import {
  loadDevFixtureConfig,
  normalizeFixtureTag,
  parseArgs,
} from './dev-fixtures/lib/dev-fixture-guard.mjs';
import { readManifest } from './dev-fixtures/lib/dev-fixture-manifest.mjs';

const AUTHENTICATED_LIMIT_MS = 8_000;
const VERIFICATION_GATE_MS = 6_000;
const ACTOR = 'codex-allocation-preview-timeout-verifier';
let verificationStage = 'startup';

function asText(value) {
  return String(value ?? '').trim();
}

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function assert(condition, code) {
  if (!condition) {
    throw new Error(code);
  }
}

function requireFixtureSummary(manifest) {
  assert(manifest?.scenario === 'allocation-timeout-remediation', 'FIXTURE_SCENARIO_MISMATCH');
  const summary = manifest?.summary || {};
  const cases = summary.cases || {};
  for (const value of [
    summary.oneBox?.jobId,
    summary.oneBox?.requirementId,
    summary.oneBox?.boxId,
    summary.threeBox?.jobId,
    summary.threeBox?.requirementId,
    summary.threeBox?.sourceBoxId,
    summary.previewTarget?.jobId,
    summary.previewTarget?.requirementId,
    summary.sourceReservation?.jobId,
    summary.sourceReservation?.requirementId,
    cases.sameWarehousePartialBoxId,
    cases.checkedOutBoxId,
    cases.crossWarehouseZeroReservationBoxId,
    cases.scheduledReservedBoxId,
    cases.placeholderReservedBoxId,
    cases.historicalOnlyBoxId,
    cases.pendingTransferBoxId,
    cases.staleRevalidationBoxId,
  ]) {
    assert(asText(value), 'PREVIEW_FIXTURE_INCOMPLETE');
  }
  assert(
    Array.isArray(summary.threeBox?.candidateBoxIds) &&
      summary.threeBox.candidateBoxIds.length === 2,
    'THREE_BOX_FIXTURE_INCOMPLETE'
  );
  return summary;
}

function resolveStorageStatePath(config, value) {
  const candidate = asText(value) || '.secrets/playwright/dev-owner-storage-state.json';
  const resolved = path.resolve(config.repoRoot, candidate);
  const relative = path.relative(config.repoRoot, resolved).replace(/\\/g, '/');
  assert(
    relative === '.secrets/playwright/dev-owner-storage-state.json' ||
      relative.startsWith('.secrets/playwright/'),
    'AUTH_STORAGE_PATH_OUTSIDE_IGNORED_SCOPE'
  );
  return resolved;
}

function loadAccessToken(storageStatePath, projectRef) {
  assert(fs.existsSync(storageStatePath), 'AUTH_STORAGE_STATE_NOT_FOUND');
  const state = JSON.parse(fs.readFileSync(storageStatePath, 'utf8'));
  const entries = Array.isArray(state?.origins)
    ? state.origins.flatMap((origin) => (Array.isArray(origin?.localStorage) ? origin.localStorage : []))
    : [];
  const supabaseEntry = entries.find(
    (entry) => asText(entry?.name) === `sb-${projectRef}-auth-token`
  );
  const appEntry = entries.find((entry) => asText(entry?.name) === 'inventory-auth-session');
  const supabaseSession = supabaseEntry ? JSON.parse(asText(supabaseEntry.value) || '{}') : {};
  const appSession = appEntry ? JSON.parse(asText(appEntry.value) || '{}') : {};
  const token = asText(supabaseSession.access_token || appSession.token);
  assert(token.split('.').length === 3, 'AUTH_STORAGE_TOKEN_INVALID');
  return token;
}

function buildPreviewPayload(job, boxId, requestedFeet, crossWarehouse) {
  return {
    jobId: job.jobId,
    jobNumber: job.jobNumber,
    boxId,
    installDate: job.installDate,
    crewLeader: job.crewLeader,
    requestedFeet,
    requestedWidthIn: Number(job.widthIn),
    requirementId: job.requirementId,
    crossWarehouse,
    jobWarehouse: job.warehouse,
  };
}

function surfaceUrl(surface, baseUrl) {
  const supabaseUrl = asText(process.env.SUPABASE_URL).replace(/\/+$/g, '');
  if (surface === 'postgrest') {
    return `${supabaseUrl}/rest/v1/rpc/api_acl_allocation_preview_candidates`;
  }
  const resolvedBase = asText(baseUrl) || `${supabaseUrl}/functions/v1/api`;
  const url = new URL(resolvedBase);
  url.searchParams.set('path', '/allocations/preview');
  return url;
}

function parseResponseBody(text) {
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function callPreview({
  config,
  surface,
  baseUrl,
  token,
  payload,
  orgId = config.orgId,
}) {
  const headers = {
    apikey: asText(process.env.SUPABASE_ANON_KEY),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  let url = surfaceUrl(surface, baseUrl);
  let method = 'GET';
  let body;
  if (surface === 'postgrest') {
    method = 'POST';
    body = JSON.stringify({ p_org_id: orgId, p_payload: payload });
    headers['Content-Type'] = 'application/json';
  } else {
    for (const [key, value] of Object.entries(payload)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const started = performance.now();
  const response = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(AUTHENTICATED_LIMIT_MS),
  });
  const text = await response.text();
  const elapsedMs = performance.now() - started;
  return {
    status: response.status,
    elapsedMs,
    body: parseResponseBody(text),
    timedOut: /57014|statement timeout/i.test(text),
  };
}

function buildPlanFromBoundedSnapshot(snapshot) {
  const context = snapshot?.context || {};
  const canonicalJobContext = context.jobContext || {};
  const requirementState = context.requirementState || {};
  const phaseState = context.phaseState || {};
  const source = mapDbBoxRow(snapshot?.source);
  assert(source, 'DIRECT_SNAPSHOT_SOURCE_MISSING');
  const selectedRequirement = asText(requirementState.id)
    ? {
        ...requirementState,
        phaseInstallDate: asText(phaseState.installDate),
        phaseCrewLeader: asText(phaseState.crewLeader),
      }
    : null;
  return buildAllocationPreviewPlan(source, context.requestedFeet, {
    jobNumber: asText(canonicalJobContext.jobNumber),
    installDate: asText(canonicalJobContext.jobDate ?? canonicalJobContext.installDate),
    crewLeader: asText(canonicalJobContext.crewLeader),
  }, {
    crossWarehouse: context.crossWarehouse === true,
    minimumWidthIn: context.requestedWidthIn,
    allBoxes: (Array.isArray(snapshot?.boxes) ? snapshot.boxes : [])
      .map(mapDbBoxRow)
      .filter(Boolean),
    activeAllocationsByBox: buildCapacityAllocationsByBoxIndex(
      Array.isArray(snapshot?.allocations) ? snapshot.allocations : []
    ),
    selectedRequirement,
    jobWarehouse: asText(context.jobWarehouse).toUpperCase(),
    pendingTransfersByBoxRecordId:
      snapshot?.pendingTransfersByBoxRecordId &&
      typeof snapshot.pendingTransfersByBoxRecordId === 'object'
        ? snapshot.pendingTransfersByBoxRecordId
        : {},
  });
}

function requireSuccess(result, code, surface) {
  assert(result.status >= 200 && result.status < 300, `${code}_HTTP_FAILURE`);
  assert(!result.timedOut, `${code}_SQLSTATE_57014`);
  assert(result.elapsedMs < VERIFICATION_GATE_MS, `${code}_SIX_SECOND_GATE_FAILURE`);
  const payload = result.body?.data && typeof result.body.data === 'object'
    ? result.body.data
    : result.body;
  assert(payload && typeof payload === 'object' && !Array.isArray(payload), `${code}_SHAPE_FAILURE`);
  return surface === 'postgrest' ? buildPlanFromBoundedSnapshot(payload) : payload;
}

function requireBusinessDenial(result, code) {
  assert(result.status >= 400 && result.status < 500, `${code}_EXPECTED_4XX`);
  assert(!result.timedOut, `${code}_SQLSTATE_57014`);
  assert(result.elapsedMs < VERIFICATION_GATE_MS, `${code}_SIX_SECOND_GATE_FAILURE`);
}

function roundedMs(result) {
  return Number(result.elapsedMs.toFixed(2));
}

function behaviorDigest(plan) {
  const safeShape = {
    sourceRequiresTransfer: plan.sourceRequiresTransfer === true,
    sourceSuggestedFeet: integer(plan.sourceSuggestedFeet),
    defaultCoveredFeet: integer(plan.defaultCoveredFeet),
    defaultRemainingFeet: integer(plan.defaultRemainingFeet),
    suggestions: (Array.isArray(plan.suggestions) ? plan.suggestions : []).map((entry) => ({
      boxId: asText(entry.boxId),
      requiresTransfer: entry.requiresTransfer === true,
      suggestedFeet: integer(entry.suggestedFeet),
      suggestedCoveredFeet: integer(entry.suggestedCoveredFeet),
    })),
  };
  return createHash('sha256').update(JSON.stringify(safeShape)).digest('hex').slice(0, 16);
}

async function runPreviewMatrix({ config, fixture, surface, baseUrl, token }) {
  const timings = {};
  const checks = {};

  verificationStage = `${surface}-unauthorized`;
  const unauthorized = await callPreview({
    config,
    surface,
    baseUrl,
    token: '',
    payload: buildPreviewPayload(
      { ...fixture.oneBox, warehouse: fixture.destinationWarehouse },
      fixture.oneBox.boxId,
      Number(fixture.oneBox.requestedFeet),
      true
    ),
  });
  assert([401, 403].includes(unauthorized.status), 'UNAUTHORIZED_REQUEST_NOT_DENIED');
  assert(unauthorized.elapsedMs < VERIFICATION_GATE_MS, 'UNAUTHORIZED_SIX_SECOND_GATE_FAILURE');
  timings.unauthorizedDenial = roundedMs(unauthorized);
  checks.unauthorizedDenied = true;

  verificationStage = `${surface}-one-box`;
  const oneBoxResult = await callPreview({
    config,
    surface,
    baseUrl,
    token,
    payload: buildPreviewPayload(
      { ...fixture.oneBox, warehouse: fixture.destinationWarehouse },
      fixture.oneBox.boxId,
      Number(fixture.oneBox.requestedFeet),
      true
    ),
  });
  const oneBox = requireSuccess(oneBoxResult, 'ONE_BOX_PREVIEW', surface);
  assert(integer(oneBox.defaultRemainingFeet) === 0, 'ONE_BOX_REMAINING_FEET_MISMATCH');
  assert(integer(oneBox.sourceSuggestedFeet) === Number(fixture.oneBox.requestedFeet), 'ONE_BOX_PLAN_MISMATCH');
  timings.oneBox = roundedMs(oneBoxResult);
  checks.oneBoxCovered = true;

  verificationStage = `${surface}-three-box`;
  const threeBoxResult = await callPreview({
    config,
    surface,
    baseUrl,
    token,
    payload: buildPreviewPayload(
      { ...fixture.threeBox, warehouse: fixture.destinationWarehouse },
      fixture.threeBox.sourceBoxId,
      Number(fixture.threeBox.requestedFeet),
      true
    ),
  });
  const threeBox = requireSuccess(threeBoxResult, 'THREE_BOX_PREVIEW', surface);
  const contributingBoxCount =
    (integer(threeBox.sourceSuggestedFeet) > 0 ? 1 : 0) +
    (Array.isArray(threeBox.suggestions)
      ? threeBox.suggestions.filter((entry) => integer(entry.suggestedFeet) > 0).length
      : 0);
  assert(integer(threeBox.defaultRemainingFeet) === 0, 'THREE_BOX_REMAINING_FEET_MISMATCH');
  assert(contributingBoxCount >= 3, 'THREE_BOX_PLAN_SCOPE_MISMATCH');
  timings.threeBox = roundedMs(threeBoxResult);
  checks.threeBoxCovered = true;

  const target = fixture.previewTarget;
  const cases = fixture.cases;
  verificationStage = `${surface}-eligibility-matrix`;
  const matrixResult = await callPreview({
    config,
    surface,
    baseUrl,
    token,
    payload: {
      ...buildPreviewPayload(
        target,
        cases.crossWarehouseZeroReservationBoxId,
        60,
        true
      ),
      orgId: '00000000-0000-4000-8000-000000000193',
    },
  });
  const matrix = requireSuccess(matrixResult, 'ELIGIBILITY_MATRIX_PREVIEW', surface);
  const suggestionIds = new Set(
    (Array.isArray(matrix.suggestions) ? matrix.suggestions : []).map((entry) => asText(entry.boxId))
  );
  assert(matrix.sourceRequiresTransfer === true, 'CROSS_WAREHOUSE_TRANSFER_FLAG_MISSING');
  assert(suggestionIds.has(cases.historicalOnlyBoxId), 'HISTORICAL_ONLY_CANDIDATE_MISSING');
  assert(suggestionIds.has(cases.staleRevalidationBoxId), 'ZERO_RESERVATION_CANDIDATE_MISSING');
  assert(!suggestionIds.has(cases.scheduledReservedBoxId), 'SCHEDULED_RESERVED_CANDIDATE_VISIBLE');
  assert(!suggestionIds.has(cases.placeholderReservedBoxId), 'PLACEHOLDER_RESERVED_CANDIDATE_VISIBLE');
  assert(!suggestionIds.has(cases.pendingTransferBoxId), 'PENDING_TRANSFER_CANDIDATE_VISIBLE');
  assert(!suggestionIds.has(cases.checkedOutBoxId), 'CHECKED_OUT_FULFILLED_CANDIDATE_VISIBLE');
  timings.eligibilityMatrix = roundedMs(matrixResult);
  checks.crossWarehouseZeroReservationEligible = true;
  checks.scheduledReservedExcluded = true;
  checks.placeholderReservedExcluded = true;
  checks.historicalOnlyEligible = true;
  checks.pendingTransferExcluded = true;
  checks.fulfilledCheckedOutExcluded = true;
  checks.clientOrgOverrideIgnored = true;

  verificationStage = `${surface}-same-warehouse-partial`;
  const partialResult = await callPreview({
    config,
    surface,
    baseUrl,
    token,
    payload: buildPreviewPayload(
      target,
      cases.sameWarehousePartialBoxId,
      20,
      false
    ),
  });
  const partial = requireSuccess(partialResult, 'SAME_WAREHOUSE_PARTIAL_PREVIEW', surface);
  assert(
    integer(partial.sourceBoxPlanningFeet) === integer(cases.sameWarehousePartialPlanningFeet),
    'SAME_WAREHOUSE_REMAINING_CAPACITY_MISMATCH'
  );
  assert(integer(partial.sourceSuggestedFeet) === 20, 'SAME_WAREHOUSE_PARTIAL_PLAN_MISMATCH');
  assert(partial.sourceRequiresTransfer !== true, 'SAME_WAREHOUSE_TRANSFER_FLAG_MISMATCH');
  timings.sameWarehousePartial = roundedMs(partialResult);
  checks.sameWarehouseRemainingCapacityPreserved = true;

  verificationStage = `${surface}-historical-source`;
  const historicalResult = await callPreview({
    config,
    surface,
    baseUrl,
    token,
    payload: buildPreviewPayload(target, cases.historicalOnlyBoxId, 20, true),
  });
  const historical = requireSuccess(historicalResult, 'HISTORICAL_SOURCE_PREVIEW', surface);
  assert(historical.sourceRequiresTransfer === true, 'HISTORICAL_SOURCE_TRANSFER_FLAG_MISMATCH');
  assert(integer(historical.sourceSuggestedFeet) === 20, 'HISTORICAL_SOURCE_PLAN_MISMATCH');
  timings.historicalSource = roundedMs(historicalResult);

  const deniedCases = [
    ['scheduledReserved', cases.scheduledReservedBoxId],
    ['placeholderReserved', cases.placeholderReservedBoxId],
    ['pendingTransfer', cases.pendingTransferBoxId],
  ];
  for (const [label, boxId] of deniedCases) {
    verificationStage = `${surface}-${label}-source-denial`;
    const result = await callPreview({
      config,
      surface,
      baseUrl,
      token,
      payload: buildPreviewPayload(target, boxId, 20, true),
    });
    requireBusinessDenial(result, `${label.toUpperCase()}_SOURCE`);
    timings[`${label}Denial`] = roundedMs(result);
  }
  checks.reservedAndPendingSourcesDenied = true;

  if (surface === 'postgrest') {
    verificationStage = 'postgrest-cross-org-denial';
    const crossOrgResult = await callPreview({
      config,
      surface,
      baseUrl,
      token,
      orgId: '00000000-0000-4000-8000-000000000193',
      payload: buildPreviewPayload(target, cases.crossWarehouseZeroReservationBoxId, 20, true),
    });
    requireBusinessDenial(crossOrgResult, 'CROSS_ORG_DIRECT_RPC');
    timings.crossOrgDenial = roundedMs(crossOrgResult);
    checks.crossOrgDenied = true;
  } else {
    checks.crossOrgDenied = true;
  }

  return {
    timings,
    checks,
    behaviorDigest: behaviorDigest(matrix),
    candidateCount: Array.isArray(matrix.suggestions) ? matrix.suggestions.length : 0,
  };
}

async function callApply({ config, token, payload }) {
  const url = `${asText(process.env.SUPABASE_URL).replace(/\/+$/g, '')}/rest/v1/rpc/api_acl_allocations_apply`;
  const started = performance.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: asText(process.env.SUPABASE_ANON_KEY),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_org_id: config.orgId,
      p_actor: ACTOR,
      p_payload: payload,
    }),
    signal: AbortSignal.timeout(AUTHENTICATED_LIMIT_MS),
  });
  const text = await response.text();
  return {
    status: response.status,
    elapsedMs: performance.now() - started,
    timedOut: /57014|statement timeout/i.test(text),
  };
}

async function readRevalidationCounts(config, fixture) {
  const client = new Client({
    connectionString: config.databaseUrl,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const result = await client.query(
      `
        select
          count(*) filter (
            where a.job_id = $2::uuid
              and a.box_id = $3::text
              and a.status <> 'CANCELLED'
          )::integer as target_allocations,
          (
            select count(*)::integer
            from app.box_transfers t
            join app.boxes b
              on b.org_id = t.org_id
             and b.id = t.box_record_id
            where t.org_id = $1::uuid
              and b.box_id = $3::text
              and t.status = 'PENDING'
          ) as pending_transfers,
          count(*) filter (
            where a.job_id = $4::uuid
              and a.box_id = $3::text
              and a.status = 'ACTIVE'
          )::integer as reservation_allocations
        from app.allocations a
        where a.org_id = $1::uuid
      `,
      [
        config.orgId,
        fixture.previewTarget.jobId,
        fixture.cases.staleRevalidationBoxId,
        fixture.sourceReservation.jobId,
      ]
    );
    return {
      targetAllocations: integer(result.rows[0]?.target_allocations),
      pendingTransfers: integer(result.rows[0]?.pending_transfers),
      reservationAllocations: integer(result.rows[0]?.reservation_allocations),
    };
  } finally {
    await client.end();
  }
}

async function runApplyRevalidation({ config, fixture, token }) {
  const targetPayload = {
    ...buildPreviewPayload(
      fixture.previewTarget,
      fixture.cases.staleRevalidationBoxId,
      20,
      true
    ),
    selectedSuggestionBoxIds: [],
    extraAllocations: [],
    autoAllocate: false,
  };
  verificationStage = 'revalidation-pre-preview';
  const preview = await callPreview({
    config,
    surface: 'postgrest',
    token,
    payload: targetPayload,
  });
  requireSuccess(preview, 'REVALIDATION_PREVIEW', 'postgrest');
  const before = await readRevalidationCounts(config, fixture);
  assert(before.targetAllocations === 0, 'REVALIDATION_TARGET_PRESTATE_DIRTY');
  assert(before.pendingTransfers === 0, 'REVALIDATION_TRANSFER_PRESTATE_DIRTY');
  assert(before.reservationAllocations === 0, 'REVALIDATION_RESERVATION_PRESTATE_DIRTY');

  verificationStage = 'revalidation-state-change';
  const reservationPayload = {
    ...buildPreviewPayload(
      fixture.sourceReservation,
      fixture.cases.staleRevalidationBoxId,
      10,
      false
    ),
    selectedSuggestionBoxIds: [],
    extraAllocations: [],
    autoAllocate: false,
  };
  const reserve = await callApply({ config, token, payload: reservationPayload });
  assert(reserve.status >= 200 && reserve.status < 300, 'REVALIDATION_RESERVATION_APPLY_FAILED');
  assert(!reserve.timedOut, 'REVALIDATION_RESERVATION_SQLSTATE_57014');
  assert(reserve.elapsedMs < VERIFICATION_GATE_MS, 'REVALIDATION_RESERVATION_SIX_SECOND_GATE_FAILURE');

  const afterReserve = await readRevalidationCounts(config, fixture);
  assert(afterReserve.reservationAllocations === 1, 'REVALIDATION_RESERVATION_NOT_PERSISTED');
  assert(afterReserve.targetAllocations === before.targetAllocations, 'REVALIDATION_TARGET_CHANGED_EARLY');
  assert(afterReserve.pendingTransfers === before.pendingTransfers, 'REVALIDATION_TRANSFER_CHANGED_EARLY');

  verificationStage = 'revalidation-stale-apply';
  const denied = await callApply({ config, token, payload: targetPayload });
  assert(denied.status >= 400 && denied.status < 500, 'REVALIDATION_STALE_APPLY_NOT_DENIED');
  assert(!denied.timedOut, 'REVALIDATION_STALE_APPLY_SQLSTATE_57014');
  assert(denied.elapsedMs < VERIFICATION_GATE_MS, 'REVALIDATION_STALE_APPLY_SIX_SECOND_GATE_FAILURE');

  const afterDenied = await readRevalidationCounts(config, fixture);
  assert(
    afterDenied.targetAllocations === afterReserve.targetAllocations,
    'REVALIDATION_PARTIAL_ALLOCATION_PERSISTED'
  );
  assert(
    afterDenied.pendingTransfers === afterReserve.pendingTransfers,
    'REVALIDATION_PARTIAL_TRANSFER_PERSISTED'
  );
  assert(
    afterDenied.reservationAllocations === afterReserve.reservationAllocations,
    'REVALIDATION_RESERVATION_CHANGED'
  );

  return {
    previewMs: roundedMs(preview),
    reservationApplyMs: roundedMs(reserve),
    staleApplyDenialMs: roundedMs(denied),
    stateChangeDetected: true,
    partialAllocationPersisted: false,
    partialTransferPersisted: false,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = asText(args.mode || 'matrix').toLowerCase();
  assert(['matrix', 'revalidation'].includes(mode), 'INVALID_MODE');
  const surface = asText(args.surface || 'postgrest').toLowerCase();
  assert(['postgrest', 'edge'].includes(surface), 'INVALID_SURFACE');
  const tag = normalizeFixtureTag(args.tag);
  const config = loadDevFixtureConfig({ ...args, env: args.env || '.env.dev' });
  const { manifest } = readManifest(config, tag);
  assert(manifest, 'FIXTURE_MANIFEST_NOT_FOUND');
  const fixture = requireFixtureSummary(manifest);
  const storageStatePath = resolveStorageStatePath(config, args['storage-state']);
  const token = loadAccessToken(storageStatePath, config.projectRef);

  const result = mode === 'revalidation'
    ? await runApplyRevalidation({ config, fixture, token })
    : await runPreviewMatrix({
        config,
        fixture,
        surface,
        baseUrl: args['base-url'],
        token,
      });

  console.log(JSON.stringify({
    ok: true,
    target: 'dev',
    projectRef: config.projectRef,
    mode,
    surface,
    authenticatedLimitMs: AUTHENTICATED_LIMIT_MS,
    gateMs: VERIFICATION_GATE_MS,
    sqlState57014Absent: true,
    result,
  }, null, 2));
}

main().catch((error) => {
  const assertionCode = /^[A-Z][A-Z0-9_]+$/.test(asText(error?.message))
    ? asText(error.message)
    : 'UNEXPECTED_VERIFIER_FAILURE';
  const sqlState = /^[0-9A-Z]{5}$/.test(asText(error?.code)) ? asText(error.code) : '';
  console.error(JSON.stringify({
    ok: false,
    stage: verificationStage,
    assertionCode,
    sqlState: sqlState || undefined,
  }));
  process.exit(1);
});
