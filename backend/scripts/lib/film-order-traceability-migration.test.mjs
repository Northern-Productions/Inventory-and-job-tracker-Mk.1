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
  '0149_film_order_traceability.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260523100000_film_order_traceability.sql'
);

test('film order traceability migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('film order traceability migration adds scoped detail, origin, events, and delete correction', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /create table if not exists app\.film_order_events/);
  assert.match(migration, /create or replace function public\.api_acl_film_orders_get/);
  assert.match(migration, /create or replace function public\.api_acl_box_film_order_origins/);
  assert.match(migration, /LINKED_BOX_INITIAL_FEET_CHANGED/);
  assert.match(migration, /LINKED_BOX_DELETED/);
  assert.match(migration, /delete from app\.film_order_box_links l/);
  assert.doesNotMatch(migration, /Boxes linked to film orders cannot be deleted/);
});
