import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0160_linked_film_order_physical_lf_recalc.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260613102000_linked_film_order_physical_lf_recalc.sql'
);
const schemaLatestPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

test('linked film-order physical LF recalculation migration is mirrored to Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('linked film-order recalculation uses corrected physical LF for received boxes', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /create or replace function app_api\.recalculate_film_order/);
  assert.match(migration, /update app\.film_order_box_links l/);
  assert.match(migration, /a\.status in \('ACTIVE', 'FULFILLED'\)/);
  assert.match(migration, /upper\(coalesce\(b\.status::text, ''\)\) = 'ORDERED'/);
  assert.match(migration, /app_api\.box_physical_feet_available\(b\)/);
  assert.match(migration, /upper\(coalesce\(b\.status::text, ''\)\) in \('IN_STOCK', 'TRANSFER'\)/);
  assert.match(migration, /linked film-order physical LF recalculation guard failed/);
});

test('schema latest guards linked film-order physical LF recalculation semantics', async () => {
  const schemaLatest = await readFile(schemaLatestPath, 'utf8');

  assert.match(schemaLatest, /const LATEST_MIGRATION = '0188_member_permission_mirror_remediation\.sql';/);
  assert.match(schemaLatest, /update app\.film_order_box_links l/);
  assert.match(schemaLatest, /a\.status in \('ACTIVE', 'FULFILLED'\)/);
  assert.match(schemaLatest, /app_api\.box_physical_feet_available\(b\)/);
});
