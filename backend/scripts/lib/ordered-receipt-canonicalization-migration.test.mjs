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
  '0094_ordered_receipt_requirement_compatibility.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260427170000_ordered_receipt_requirement_compatibility.sql'
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

  assert.match(
    migration,
    /pg_get_functiondef\('app_api\.physical_film_commitment_feet_for_box\(uuid, text, text\)'::regprocedure\)/
  );
  assert.match(
    migration,
    /pg_get_functiondef\('app_api\.film_allocation_consumes_stored_capacity\(app\.allocations, text\)'::regprocedure\)/
  );
  assert.match(
    migration,
    /pg_get_functiondef\('app_api\.find_order_receipt_requirement_id\(uuid, text, text, text, numeric\)'::regprocedure\)/
  );
  assert.match(
    migration,
    /pg_get_functiondef\('app_api\.process_linked_box_receipt\(uuid, app\.boxes, text\)'::regprocedure\)/
  );
  assert.match(migration, /physical_film_commitment_feet_for_box guard did not find expected old or new receipt commitment snippets/);
  assert.match(migration, /film_allocation_consumes_stored_capacity guard did not find expected old or new stored commitment snippets/);
  assert.match(migration, /find_order_receipt_requirement_id guard did not find expected old or new requirement matching snippets/);
  assert.match(migration, /process_linked_box_receipt guard did not find expected old or new requirement matching snippets/);
});

test('ordered receipt canonicalization resolves placeholders before creating receipt allocations', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /create or replace function app_api\.physical_film_commitment_feet_for_box/);
  assert.match(migration, /create or replace function app_api\.find_order_receipt_requirement_id/);
  assert.match(migration, /app_api\.requirement_film_is_compatible\(/);
  assert.match(
    migration,
    /round\(coalesce\(r\.width_in, 0\)::numeric, 4\) = round\(coalesce\(v_order\.width_in, 0\)::numeric, 4\)/
  );
  assert.match(migration, /v_existing_allocation\.film_order_id := v_order\.film_order_id/);
  assert.match(migration, /v_existing_allocation\.allocation_source := 'FILM_ORDER_RECEIPT'::app\.allocation_source/);
  assert.match(migration, /join app\.job_requirements r/);
  assert.match(migration, /v_existing_allocation\.allocated_feet := greatest\(v_existing_allocation\.allocated_feet - v_reused_feet, 0\)/);
  assert.match(migration, /v_box\.feet_available := greatest\(v_box\.feet_available - v_reused_feet, 0\)/);
  assert.match(migration, /Split from ordered-box placeholder %s on receipt for Film Order %s\./);
  assert.match(migration, /Resolved ordered-box placeholder on receipt for Film Order %s\./);
});

test('ordered receipt canonicalization narrows physical LF edit guards', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /create or replace function app_api\.physical_film_commitment_feet_for_box/);
  assert.match(migration, /create or replace function app_api\.film_allocation_consumes_stored_capacity/);
  assert.match(migration, /and coalesce\(a\.allocation_kind::text, 'REQUIREMENT'\) = 'REQUIREMENT'/);
  assert.match(migration, /and a\.requirement_id is not null/);
  assert.match(migration, /or app_api\.trim_text\(a\.film_order_id\) <> ''/);
  assert.match(migration, /or coalesce\(a\.allocation_source::text, 'MANUAL'\) = 'FILM_ORDER_RECEIPT'/);
  assert.match(migration, /or coalesce\(\(p_allocation\)\.allocation_source::text, 'MANUAL'\) = 'FILM_ORDER_RECEIPT'/);
});

test('latest schema check tracks ordered receipt canonicalization semantics', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');


  assert.match(schemaCheck, /0177_edit_box_add_preserve_owner_company\.sql/);

  assert.match(schemaCheck, /app_api\.physical_film_commitment_feet_for_box\(uuid, text, text\)/);
  assert.match(schemaCheck, /app_api\.find_order_receipt_requirement_id\(uuid, text, text, text, numeric\)/);
  assert.match(schemaCheck, /app_api\.process_linked_box_receipt\(uuid, app\.boxes, text\)/);
  assert.match(schemaCheck, /app_api\.requirement_film_is_compatible\(/);
  assert.match(schemaCheck, /v_box\.feet_available := greatest\(v_box\.feet_available - v_reused_feet, 0\);/);
});
