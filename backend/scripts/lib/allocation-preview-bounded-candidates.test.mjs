import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadAllocationPreviewCandidateSnapshot } from '../../src/app/repositories/boxesRepository.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0193_allocation_preview_bounded_candidates.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260723100000_allocation_preview_bounded_candidates.sql'
);
const backend0191Path = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0191_atomic_cross_warehouse_transfer_assisted_allocation.sql'
);
const supabase0191Path = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260721100000_atomic_cross_warehouse_transfer_assisted_allocation.sql'
);
const backend0192Path = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0192_atomic_cross_warehouse_affected_box_scan.sql'
);
const supabase0192Path = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260721101000_atomic_cross_warehouse_affected_box_scan.sql'
);
const localRuntimePath = path.join(
  repoRoot,
  'backend',
  'src',
  'app',
  'services',
  'runtime',
  'runtimeAllocationApply.mjs'
);
const edgeReadHandlersPath = path.join(
  repoRoot,
  'supabase',
  'functions',
  '_shared',
  'routes',
  'readHandlers.ts'
);
const schemaLatestPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');
const fixtureScenarioPath = path.join(
  repoRoot,
  'backend',
  'scripts',
  'dev-fixtures',
  'lib',
  'dev-fixture-scenarios.mjs'
);
const liveVerifierPath = path.join(
  repoRoot,
  'backend',
  'scripts',
  'verify-allocation-preview-timeout-remediation-dev.mjs'
);
const browserVerifierPath = path.join(
  repoRoot,
  'backend',
  'scripts',
  'verify-allocation-preview-browser-dev.mjs'
);

const accepted0191Hash = '723177cd488d3110aa29d5246a6b961540e77557a5403cd20046ace7541dd8a0';
const accepted0192Hash = '3776c9b38230fe46bc12b788af200771b1beb3b4ab46342a8a08d5d829eb6f21';

function sha256(source) {
  return createHash('sha256').update(source).digest('hex');
}

function stripDollarQuotedBlocks(sql) {
  return sql.replace(/\$\$[\s\S]*?\$\$/g, '$$BLOCK$$');
}

function extractBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Expected marker ${startMarker}.`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `Expected marker ${endMarker}.`);
  return source.slice(start, end);
}

test('0193 is mirrored exactly while migrations 0191 and 0192 remain immutable', async () => {
  const [backend0193, supabase0193, backend0191, supabase0191, backend0192, supabase0192] =
    await Promise.all([
      readFile(backendMigrationPath, 'utf8'),
      readFile(supabaseMigrationPath, 'utf8'),
      readFile(backend0191Path, 'utf8'),
      readFile(supabase0191Path, 'utf8'),
      readFile(backend0192Path, 'utf8'),
      readFile(supabase0192Path, 'utf8')
    ]);

  assert.equal(supabase0193, backend0193);
  assert.equal(sha256(backend0191), accepted0191Hash);
  assert.equal(sha256(supabase0191), accepted0191Hash);
  assert.equal(sha256(backend0192), accepted0192Hash);
  assert.equal(sha256(supabase0192), accepted0192Hash);
});

test('0193 is forward-only read-function DDL with no business DML, index, or timeout change', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const topLevelSql = stripDollarQuotedBlocks(migration);

  assert.doesNotMatch(topLevelSql, /^\s*(?:insert\s+into|update|delete\s+from|truncate)\s+app\./im);
  assert.doesNotMatch(migration, /\b(?:insert\s+into|update|delete\s+from|truncate)\s+app\./i);
  assert.doesNotMatch(migration, /\bcreate\s+(?:unique\s+)?index\b/i);
  assert.doesNotMatch(migration, /\balter\s+table\b/i);
  assert.doesNotMatch(migration, /\b(?:statement|lock)_timeout\b/i);
  assert.doesNotMatch(migration, /\bset_config\s*\(/i);
  assert.doesNotMatch(migration, /\bapi_acl_list_boxes\b/i);
});

test('0193 reuses the canonical 0192 planner and batches bounded candidate state', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const plannerCalls = migration.match(/app_api\.build_allocation_apply_plan_0192\(/g) || [];

  assert.equal(plannerCalls.length, 2, 'Expected one runtime planner call plus one contract assertion reference.');
  assert.match(migration, /v_plan := app_api\.build_allocation_apply_plan_0192\(/);
  assert.match(migration, /from app_api\.allocation_apply_box_states_0192\(p_org_id, array\[v_source\.box_id\]\)/);
  assert.match(migration, /from app_api\.allocation_apply_box_states_0192\(\s*p_org_id,\s*coalesce\(/s);
  assert.match(migration, /where b\.org_id = p_org_id\s+and b\.box_id <> v_source\.box_id/s);
  assert.match(migration, /and b\.width_in >= v_requested_width_in/);
  assert.match(migration, /app_api\.requirement_film_is_compatible\(/);
  assert.match(migration, /app_api\.normalize_requirement_film_key\(/);
  assert.match(migration, /and \(v_cross_warehouse or b\.warehouse = v_source\.warehouse\)/);
  assert.match(migration, /and a\.box_id in \(select r\.box_id from relevant_box_ids r\)/);
  assert.match(migration, /and a\.status in \('ACTIVE', 'FULFILLED'\)/);
  assert.match(migration, /and t\.status = 'PENDING'/);
  assert.doesNotMatch(migration, /for\s+\w+\s+in\s+select[\s\S]*?app_api\.allocation_apply_box_states_0192/i);
});

test('0193 preserves whole-box transfer guards, historical capacity semantics, and deterministic output', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /Transfer-assisted allocation can start only from an in-stock box\./);
  assert.match(migration, /Transfer-assisted allocation requires a box with zero prior reservations\./);
  assert.match(migration, /not s\.pending_transfer/);
  assert.match(migration, /s\.status = 'IN_STOCK'\s+and s\.reservation_count = 0/s);
  assert.match(migration, /s\.status in \('IN_STOCK', 'ORDERED', 'CHECKED_OUT'\)/);
  assert.match(migration, /a\.status in \('ACTIVE', 'FULFILLED'\)/);
  assert.doesNotMatch(migration, /a\.status in \('CANCELLED'|'REMOVED'\)/);
  assert.match(migration, /order by a\.box_id, a\.created_at, a\.allocation_id, a\.id/);
  assert.match(migration, /coalesce\(e\.received_date, e\.order_date, '9999-12-31'::date\)/);
  assert.match(migration, /'requiresTransfer'/);
  assert.match(migration, /'candidateMetadata'/);
});

test('0193 public ACL wrapper keeps ownership, security, search path, and narrow grants', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(
    migration,
    /create or replace function public\.api_acl_allocation_preview_candidates\(\s*p_org_id uuid,\s*p_payload jsonb\s*\)/s
  );
  assert.match(migration, /perform app_api\.require_effective_feature_access\(p_org_id, 'allocations', 'read'\)/);
  assert.match(migration, /language plpgsql\s+security definer\s+set search_path = public, app, app_api/s);
  assert.match(migration, /alter function public\.api_acl_allocation_preview_candidates\(uuid, jsonb\) owner to postgres/);
  assert.match(
    migration,
    /revoke execute on function public\.api_acl_allocation_preview_candidates\(uuid, jsonb\)\s+from public, anon, service_role/s
  );
  assert.match(
    migration,
    /grant execute on function public\.api_acl_allocation_preview_candidates\(uuid, jsonb\)\s+to authenticated/s
  );
  assert.match(migration, /v_private_count <> 1\s+or v_public_count <> 1/s);
});

test('local and Edge preview callers use only the bounded snapshot path', async () => {
  const [localRuntime, edgeReadHandlers] = await Promise.all([
    readFile(localRuntimePath, 'utf8'),
    readFile(edgeReadHandlersPath, 'utf8')
  ]);
  const localPreview = extractBetween(
    localRuntime,
    'async function previewAllocationPlan',
    'function resolveSelectedRequirement'
  );
  const edgePreview = extractBetween(
    edgeReadHandlers,
    '"/allocations/preview": async',
    '"/jobs/list": async'
  );

  for (const body of [localPreview, edgePreview]) {
    assert.match(body, /loadAllocationPreviewCandidateSnapshot/);
    assert.match(body, /buildCapacityAllocationsByBoxIndex/);
    assert.doesNotMatch(body, /\blistBoxes\s*\(/);
    assert.doesNotMatch(body, /\blistBoxesByWarehouses\s*\(/);
    assert.doesNotMatch(body, /\blistActiveAllocations\s*\(/);
  }
});

test('local preview repository performs one parameterized bounded ACL query', async () => {
  const calls = [];
  const payload = {
    boxId: 'IL1-SOURCE',
    jobId: '11111111-1111-4111-8111-111111111111',
    requestedFeet: 70,
    crossWarehouse: true
  };
  const client = {
    async query(text, params) {
      calls.push({ text, params });
      return {
        rows: [{
          result: {
            source: {
              id: 'source-record',
              orgId: 'org-1',
              boxId: 'IL1-SOURCE',
              warehouse: 'IL1',
              manufacturer: 'Llumar',
              filmName: 'RN 07',
              widthIn: 48,
              status: 'IN_STOCK',
              feetAvailable: 20,
              physicalFeetAvailable: 20,
              allocatableNowFeet: 20
            },
            boxes: [],
            allocations: [],
            pendingTransfersByBoxRecordId: {},
            candidateMetadata: [],
            context: { requestedFeet: 70, crossWarehouse: true },
            scope: { candidateCount: 0 }
          }
        }]
      };
    }
  };

  const snapshot = await loadAllocationPreviewCandidateSnapshot(client, 'org-1', payload);

  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /public\.api_acl_allocation_preview_candidates\(\s*\$1::uuid,\s*\$2::jsonb/s);
  assert.deepEqual(calls[0].params, ['org-1', payload]);
  assert.equal(snapshot.source.boxId, 'IL1-SOURCE');
  assert.deepEqual(snapshot.scope, { candidateCount: 0 });
});

test('schema latest requires the 0193 bounded preview contracts', async () => {
  const schemaLatest = await readFile(schemaLatestPath, 'utf8');

  assert.match(schemaLatest, /const LATEST_MIGRATION = '0195_residual_efficiency_scoped_reads\.sql';/);
  assert.match(schemaLatest, /app_api\.allocation_preview_candidates_0193\(uuid, jsonb\)/);
  assert.match(schemaLatest, /public\.api_acl_allocation_preview_candidates\(uuid, jsonb\)/);
  assert.match(schemaLatest, /v_plan := app_api\.build_allocation_apply_plan_0192/);
  assert.match(schemaLatest, /and a\.status in \('ACTIVE', 'FULFILLED'\)/);
});

test('guarded DEV fixtures cover the complete preview eligibility and stale-state matrix', async () => {
  const fixtureSource = await readFile(fixtureScenarioPath, 'utf8');

  assert.match(fixtureSource, /sameWarehousePartialBoxId/);
  assert.match(fixtureSource, /crossWarehouseZeroReservationBoxId/);
  assert.match(fixtureSource, /scheduledReservedBoxId/);
  assert.match(fixtureSource, /placeholderReservedBoxId/);
  assert.match(fixtureSource, /historicalOnlyBoxId/);
  assert.match(fixtureSource, /pendingTransferBoxId/);
  assert.match(fixtureSource, /checkedOutBoxId/);
  assert.match(fixtureSource, /staleRevalidationBoxId/);
  assert.match(fixtureSource, /allocation_apply_box_states_0192\(\$1::uuid, \$2::text\[\]\)/);
  assert.match(fixtureSource, /removeAllocationFromJob/);
  assert.match(fixtureSource, /startBoxTransfer/);
});

test('live DEV verifier keeps the unchanged timeout and checks every required surface safely', async () => {
  const verifier = await readFile(liveVerifierPath, 'utf8');

  assert.match(verifier, /const AUTHENTICATED_LIMIT_MS = 8_000/);
  assert.match(verifier, /const VERIFICATION_GATE_MS = 6_000/);
  assert.match(verifier, /api_acl_allocation_preview_candidates/);
  assert.match(verifier, /\/allocations\/preview/);
  assert.match(verifier, /sameWarehouseRemainingCapacityPreserved/);
  assert.match(verifier, /scheduledReservedExcluded/);
  assert.match(verifier, /placeholderReservedExcluded/);
  assert.match(verifier, /historicalOnlyEligible/);
  assert.match(verifier, /pendingTransferExcluded/);
  assert.match(verifier, /fulfilledCheckedOutExcluded/);
  assert.match(verifier, /REVALIDATION_PARTIAL_ALLOCATION_PERSISTED/);
  assert.match(verifier, /REVALIDATION_PARTIAL_TRANSFER_PERSISTED/);
  assert.doesNotMatch(verifier, /\bapi_acl_list_boxes\b/);
  assert.doesNotMatch(verifier, /\bretry\b/i);
});

test('browser verifier retains no screenshots or traces and covers allocation plus report preservation', async () => {
  const verifier = await readFile(browserVerifierPath, 'utf8');

  assert.match(verifier, /EXPECTED_DEV_BUILD_REQUIRED/);
  assert.match(verifier, /\/api\?path=\/health/);
  assert.match(verifier, /BROWSER_DEV_BUILD_MISMATCH/);
  assert.match(verifier, /BROWSER_ALLOCATION_JOB_ACTION_NOT_VISIBLE/);
  assert.match(
    verifier,
    /const tableLayout = computedTable\?\.tableLayout[\s\S]*classList\.remove\('warehouse-asset-audit-printing'\)/
  );
  assert.match(verifier, /BROWSER_PREVIEW_SIX_SECOND_GATE_FAILURE/);
  assert.match(verifier, /BROWSER_DIRECT_SUBMIT_NOT_DENIED/);
  assert.match(verifier, /APPROVED_AUDIT_HEADERS/);
  assert.match(verifier, /WAREHOUSE_AUDIT_SCREEN_PRINT_TOTAL_MISMATCH/);
  assert.match(verifier, /WAREHOUSE_AUDIT_PRINT_ROW_SET_MISMATCH/);
  assert.match(verifier, /warehouse-asset-audit-pagination/);
  assert.match(verifier, /page\.waitForTimeout\(250\)/);
  assert.match(verifier, /WAREHOUSE_AUDIT_DARK_THEME_TOKEN_MISMATCH/);
  assert.match(verifier, /WAREHOUSE_AUDIT_DARK_FOCUS_INDICATOR_FAILURE/);
  assert.match(verifier, /WAREHOUSE_AUDIT_DARK_CONTROL_CONTRAST_FAILURE/);
  assert.doesNotMatch(verifier, /\.screenshot\s*\(/);
  assert.doesNotMatch(verifier, /tracing\.start/);
  assert.doesNotMatch(verifier, /\.pdf\s*\(/);
});
