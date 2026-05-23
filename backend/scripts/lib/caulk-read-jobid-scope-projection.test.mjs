import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

import {
  mapCaulkTransactionRow,
  mapDbCaulkTransferRow,
} from '../../src/app/repositories/mappers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0134_caulk_read_jobid_scope_projection.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260514030000_caulk_read_jobid_scope_projection.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');
const baseSchemaMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0001_supabase_inventory_schema.sql');
const duplicateGuardMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0117_duplicate_job_creation_guard.sql');
const localCaulkServicePath = path.join(repoRoot, 'backend', 'src', 'app', 'services', 'caulk.mjs');
const localReadHandlersPath = path.join(repoRoot, 'backend', 'src', 'app', 'handlers', 'readHandlers.mjs');
const edgeReadHandlersPath = path.join(
  repoRoot,
  'supabase',
  'functions',
  '_shared',
  'routes',
  'readHandlers.ts'
);
const frontendCaulkDomainPath = path.join(repoRoot, 'frontend', 'src', 'domain', 'inventory', 'caulk.ts');
const frontendSharedClientPath = path.join(repoRoot, 'frontend', 'src', 'api', 'features', 'sharedClient.ts');

function extractBody(sql, functionName) {
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = sql.match(
    new RegExp(`create or replace function ${escapedName}[\\s\\S]*?as \\$\\$\\r?\\n(?<body>[\\s\\S]*?)\\r?\\n\\$\\$;`)
  );
  assert.ok(match?.groups?.body, `Expected ${functionName} body.`);
  return match.groups.body;
}

function extractRoute(source, route, nextRoute) {
  const normalizedSource = source.replace(/\r\n/g, '\n');
  const start = normalizedSource.indexOf(`'${route}': async`);
  const doubleQuoteStart = normalizedSource.indexOf(`"${route}": async`);
  const routeStart = start === -1 ? doubleQuoteStart : start;
  assert.notEqual(routeStart, -1, `Expected route ${route}.`);
  const endMarker = nextRoute ? [`'${nextRoute}': async`, `"${nextRoute}": async`] : ['\n};'];
  const end = endMarker
    .map((marker) => normalizedSource.indexOf(marker, routeStart + 1))
    .filter((index) => index !== -1)
    .sort((a, b) => a - b)[0];
  assert.notEqual(end, undefined, `Expected route ${nextRoute || 'end of routes'}.`);
  return normalizedSource.slice(routeStart, end);
}

test('caulk read jobId scope projection migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('caulk transfer read RPC projects row-derived job identity without changing transfer behavior', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractBody(migration, 'public.api_acl_list_caulk_transfers');

  assert.match(migration, /drop function if exists public\.api_acl_list_caulk_transfers\(uuid, text, uuid\);/);
  assert.match(migration, /job_id uuid/);
  assert.match(body, /coalesce\(t\.job_id, a\.job_id\)/);
  assert.match(body, /left join app\.jobs job_by_id\s+on job_by_id\.org_id = t\.org_id\s+and job_by_id\.id = coalesce\(t\.job_id, a\.job_id\)/s);
  assert.match(body, /left join app\.jobs legacy_job\s+on legacy_job\.org_id = a\.org_id\s+and coalesce\(t\.job_id, a\.job_id\) is null\s+and upper\(trim\(legacy_job\.job_number\)\) = upper\(trim\(a\.job_number\)\)/s);
  assert.match(body, /and t\.status = 'PENDING'/);
  assert.match(body, /and t\.destination_warehouse = v_warehouse/);
  assert.match(body, /order by t\.created_at desc, t\.id desc/);
  assert.doesNotMatch(body, /api_acl_caulk_transfer_receive/);
  assert.doesNotMatch(body, /api_acl_caulk_transfer_cancel/);
  assert.doesNotMatch(body, /caulk_apply_stock_delta/);
});

test('caulk transaction read RPC projects only safely row-derived job identity', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractBody(migration, 'public.api_acl_list_caulk_transactions');

  assert.match(migration, /drop function if exists public\.api_acl_list_caulk_transactions\(uuid, text, uuid, integer\);/);
  assert.match(migration, /job_id uuid/);
  assert.match(migration, /job_number text/);
  assert.match(migration, /job_warehouse text/);
  assert.match(body, /left join app\.caulk_job_allocations source_allocation\s+on source_allocation\.org_id = t\.org_id\s+and source_allocation\.caulk_allocation_id = t\.source_box_id/s);
  assert.match(body, /left join app\.caulk_transfers source_transfer\s+on source_transfer\.org_id = t\.org_id\s+and source_transfer\.transfer_id = t\.transfer_id\s+and btrim\(coalesce\(t\.transfer_id, ''\)\) <> ''/s);
  assert.match(body, /left join app\.caulk_job_allocations transfer_allocation\s+on transfer_allocation\.org_id = source_transfer\.org_id\s+and transfer_allocation\.id = source_transfer\.caulk_allocation_id/s);
  assert.match(body, /resolved_job\.id = coalesce\(source_allocation\.job_id, source_transfer\.job_id, transfer_allocation\.job_id\)/);
  assert.match(body, /resolved_job\.job_number/);
  assert.match(body, /resolved_job\.warehouse/);
  assert.match(body, /format\('Checked in unused caulk from job %s\.', source_allocation\.job_number\)/);
  assert.doesNotMatch(body, /regexp/i);
  assert.doesNotMatch(body, /split_part/i);
  assert.doesNotMatch(body, /upper\(trim\(.*job_number.*\)\) = upper\(trim\(/is);
  assert.doesNotMatch(body, /caulk_apply_stock_delta/);
});

test('caulk read projection keeps duplicate guards and latest schema guard aligned', async () => {
  const [migration, baseSchemaMigration, duplicateGuardMigration, schemaCheck] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(baseSchemaMigrationPath, 'utf8'),
    readFile(duplicateGuardMigrationPath, 'utf8'),
    readFile(schemaCheckPath, 'utf8'),
  ]);

  assert.doesNotMatch(migration, /api_jobs_create/);
  assert.doesNotMatch(migration, /api_jobs_check_duplicate/);
  assert.doesNotMatch(migration, /alter table app\.jobs/i);
  assert.doesNotMatch(migration, /drop constraint/i);
  assert.doesNotMatch(migration, /unique\s*\(\s*org_id\s*,\s*job_number\s*\)/i);
  assert.match(baseSchemaMigration, /unique\s*\(\s*org_id\s*,\s*job_number\s*\)/i);
  assert.match(duplicateGuardMigration, /Job %s already exists/);
  assert.match(schemaCheck, /const LATEST_MIGRATION = '0149_film_order_traceability\.sql';/);
  assert.match(schemaCheck, /public\.api_acl_list_caulk_transfers\(uuid, text, uuid\)/);
  assert.match(schemaCheck, /public\.api_acl_list_caulk_transactions\(uuid, text, uuid, integer\)/);
});

test('local caulk read mappers expose optional additive identity and scope fields', () => {
  const transfer = mapDbCaulkTransferRow({
    id: 'row-1',
    org_id: 'org-1',
    caulk_allocation_id: 'allocation-row',
    transfer_id: 'TR-1',
    caulk_allocation_public_id: 'CA-1',
    job_number: '4953',
    resolved_job_id: '11111111-1111-4111-8111-111111111111',
    job_warehouse: 'il1',
    work_scope: 'Sections 4, 5',
    sections: 'Sections 4, 5',
    product_id: 'product-1',
    manufacturer_id: 'manufacturer-1',
    manufacturer: 'OSI',
    product_name: 'Quad',
    product_code: 'Q',
    tubes_per_case: 12,
    source_warehouse: 'il1',
    destination_warehouse: 'ms1',
    pending_tubes: 3,
    status: 'PENDING',
  });

  assert.equal(transfer.jobId, '11111111-1111-4111-8111-111111111111');
  assert.equal(transfer.workScope, 'Sections 4, 5');
  assert.equal(transfer.sections, 'Sections 4, 5');
  assert.equal(transfer.jobNumber, '4953');
  assert.equal(transfer.jobWarehouse, 'IL1');

  const transaction = mapCaulkTransactionRow({
    transaction_id: 'TX-1',
    product_id: 'product-1',
    warehouse: 'ms1',
    manufacturer: 'OSI',
    product_name: 'Quad',
    product_code: 'Q',
    action: 'TRANSFER_IN',
    delta_tubes: 3,
    resulting_tubes_on_hand: 10,
    tubes_per_case: 12,
    reason: 'Transfer',
    transfer_id: 'TR-1',
    source_box_id: '',
    job_id: '22222222-2222-4222-8222-222222222222',
    job_number: '16242',
    job_warehouse: 'il1',
    work_scope: 'Lobby',
    sections: 'Lobby',
  });

  assert.equal(transaction.jobId, '22222222-2222-4222-8222-222222222222');
  assert.equal(transaction.jobNumber, '16242');
  assert.equal(transaction.jobWarehouse, 'IL1');
  assert.equal(transaction.workScope, 'Lobby');
  assert.equal(transaction.sections, 'Lobby');
});

test('local and Edge caulk read routes enrich by jobId only and keep UI/cache out of scope', async () => {
  const [localService, localReadHandlers, edgeReadHandlers, domainTypes, sharedClient] = await Promise.all([
    readFile(localCaulkServicePath, 'utf8'),
    readFile(localReadHandlersPath, 'utf8'),
    readFile(edgeReadHandlersPath, 'utf8'),
    readFile(frontendCaulkDomainPath, 'utf8'),
    readFile(frontendSharedClientPath, 'utf8'),
  ]);

  assert.match(localService, /resolved_job\.id as job_id/);
  assert.match(localService, /coalesce\(t\.job_id, a\.job_id\) as resolved_job_id/);
  assert.match(localService, /resolved_job\.id = coalesce\(source_allocation\.job_id, source_transfer\.job_id, transfer_allocation\.job_id\)/);

  for (const source of [localReadHandlers, edgeReadHandlers]) {
    const transactionsRoute = extractRoute(source, '/caulk/transactions/list', '/caulk/transfers/list');
    const transfersRoute = extractRoute(source, '/caulk/transfers/list', source === localReadHandlers ? null : '/boxes/search');
    assert.match(transactionsRoute, /buildJobScopeFieldsByJobId\(/);
    assert.match(transactionsRoute, /jobId/);
    assert.doesNotMatch(transactionsRoute, /jobNumber.*findJob/i);
    assert.match(transfersRoute, /buildJobScopeFieldsByJobId\(/);
    assert.match(transfersRoute, /jobId/);
    assert.doesNotMatch(transfersRoute, /jobNumber.*findJob/i);
  }

  assert.match(domainTypes, /jobId\?: string;/);
  assert.match(domainTypes, /workScope\?: string \| null;/);
  assert.match(domainTypes, /sections\?: string \| null;/);
  assert.match(sharedClient, /jobId: String\(source\.jobId/);
  assert.match(sharedClient, /workScope: String\(source\.workScope/);
  assert.doesNotMatch(sharedClient, /formatJobDisplayLabel/);
});
