import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0093_ordered_receipt_allocation_canonicalization.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260427123000_ordered_receipt_allocation_canonicalization.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

test('ordered receipt canonicalization migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8')
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('ordered receipt canonicalization migration guards every targeted replacement', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /pg_get_functiondef\('app_api\.build_box_from_payload\(uuid, jsonb, text\)'::regprocedure\)/);
  assert.match(migration, /pg_get_functiondef\('public\.api_boxes_set_status\(uuid, text, jsonb\)'::regprocedure\)/);
  assert.match(
    migration,
    /pg_get_functiondef\('public\.api_acl_boxes_receive_ordered\(uuid, text, jsonb\)'::regprocedure\)/
  );
  assert.match(migration, /build_box_from_payload physical commitment patch did not match expected snippets/);
  assert.match(migration, /api_boxes_set_status physical commitment patch did not match expected snippets/);
  assert.match(migration, /api_acl_boxes_receive_ordered physical receipt patch did not match expected snippets/);
});

test('ordered receipt canonicalization resolves placeholders before creating receipt allocations', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /create or replace function app_api\.physical_film_commitment_feet_for_box/);
  assert.match(migration, /create or replace function app_api\.find_order_receipt_requirement_id/);
  assert.match(migration, /v_existing_allocation\.film_order_id := v_order\.film_order_id/);
  assert.match(migration, /v_existing_allocation\.allocation_source := 'FILM_ORDER_RECEIPT'::app\.allocation_source/);
  assert.match(migration, /join app\.job_requirements r/);
  assert.match(migration, /v_existing_allocation\.allocated_feet := greatest\(v_existing_allocation\.allocated_feet - v_reused_feet, 0\)/);
  assert.match(migration, /Split from ordered-box placeholder %s on receipt for Film Order %s\./);
  assert.match(migration, /Resolved ordered-box placeholder on receipt for Film Order %s\./);
  assert.match(
    migration,
    /v_locked_allocated_feet := app_api\.physical_film_commitment_feet_for_box\(p_org_id, v_lookup_box_id\);/
  );
});

test('ordered receipt canonicalization narrows physical LF edit guards', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /v_active_allocated_feet := app_api\.physical_film_commitment_feet_for_box\(/);
  assert.match(migration, /and coalesce\(a\.allocation_kind::text, 'REQUIREMENT'\) = 'REQUIREMENT'/);
  assert.match(migration, /and a\.requirement_id is not null/);
  assert.match(migration, /and a\.job_date is not null/);
});

test('latest schema check tracks ordered receipt canonicalization semantics', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');

  assert.match(schemaCheck, /0093_ordered_receipt_allocation_canonicalization\.sql/);
  assert.match(schemaCheck, /app_api\.physical_film_commitment_feet_for_box\(uuid, text, text\)/);
  assert.match(schemaCheck, /app_api\.find_order_receipt_requirement_id\(uuid, text, text, text, numeric\)/);
  assert.match(schemaCheck, /app_api\.process_linked_box_receipt\(uuid, app\.boxes, text\)/);
  assert.match(schemaCheck, /public\.api_acl_boxes_receive_ordered\(uuid, text, jsonb\)/);
  assert.match(schemaCheck, /app_api\.build_box_from_payload\(uuid, jsonb, text\)/);
});
