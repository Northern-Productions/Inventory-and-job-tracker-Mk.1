import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0161_linked_film_order_shortage_reconcile_guard.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260613103000_linked_film_order_shortage_reconcile_guard.sql'
);
const schemaLatestPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

test('linked film-order shortage reconcile guard migration is mirrored to Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('generic shortage reconciliation skips film orders that already have linked boxes', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /create or replace function app_api\.reconcile_existing_film_order_need_for_requirement/);
  assert.match(migration, /not exists \(\s*select 1\s*from app\.film_order_box_links l/s);
  assert.match(migration, /l\.film_order_id = fo\.film_order_id/);
  assert.match(migration, /v_primary_order\.requested_feet := v_needed_order_feet/);
  assert.match(migration, /linked film-order shortage reconcile guard failed/);
});

test('schema latest guards linked film-order shortage reconciliation semantics', async () => {
  const schemaLatest = await readFile(schemaLatestPath, 'utf8');

  assert.match(schemaLatest, /const LATEST_MIGRATION = '0168_film_weight_pending_review_resolution\.sql';/);
  assert.match(schemaLatest, /app_api\.reconcile_existing_film_order_need_for_requirement\(uuid, text, uuid\)/);
  assert.match(schemaLatest, /from app\.film_order_box_links l/);
  assert.match(schemaLatest, /l\.film_order_id = fo\.film_order_id/);
});
