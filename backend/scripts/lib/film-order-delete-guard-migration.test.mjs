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
  '0089_guard_plain_pending_film_order_delete.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260425140000_guard_plain_pending_film_order_delete.sql'
);

test('film order delete guard migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('film order delete guard migration only allows plain pending orders without downstream fulfillment', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /create or replace function public\.api_film_orders_delete/);
  assert.match(migration, /coalesce\(v_order\.status::text, ''\) <> 'FILM_ORDER'/);
  assert.match(migration, /nullif\(app_api\.trim_text\(v_order\.source_box_id\), ''\) is not null/);
  assert.match(migration, /coalesce\(v_order\.covered_feet, 0\) > 0 or coalesce\(v_order\.ordered_feet, 0\) > 0/);
  assert.match(migration, /from app\.film_order_box_links l/);
  assert.match(migration, /a\.status <> 'CANCELLED'/);
  assert.match(migration, /Film orders with linked ordered boxes cannot be cancelled/);
  assert.match(migration, /Film orders with fulfillment allocations cannot be cancelled/);
});
