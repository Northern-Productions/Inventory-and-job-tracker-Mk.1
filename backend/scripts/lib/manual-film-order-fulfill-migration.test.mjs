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
  '0165_manual_film_order_fulfill_override.sql'
);
const backendPermissionFixMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0166_manual_film_order_fulfill_permission_fix.sql'
);
const backendPublicPermissionFixMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0167_manual_film_order_fulfill_public_permission_fix.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260618101000_manual_film_order_fulfill_override.sql'
);
const supabasePermissionFixMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260618102000_manual_film_order_fulfill_permission_fix.sql'
);
const supabasePublicPermissionFixMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260618103000_manual_film_order_fulfill_public_permission_fix.sql'
);
const schemaLatestPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

test('manual film-order fulfill migrations stay mirrored between backend and Supabase', async () => {
  const [
    backendMigration,
    supabaseMigration,
    backendPermissionFix,
    supabasePermissionFix,
    backendPublicPermissionFix,
    supabasePublicPermissionFix,
  ] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
    readFile(backendPermissionFixMigrationPath, 'utf8'),
    readFile(supabasePermissionFixMigrationPath, 'utf8'),
    readFile(backendPublicPermissionFixMigrationPath, 'utf8'),
    readFile(supabasePublicPermissionFixMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
  assert.equal(supabasePermissionFix, backendPermissionFix);
  assert.equal(supabasePublicPermissionFix, backendPublicPermissionFix);
});

test('manual film-order fulfill migration adds explicit override without fake material', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /api_acl_film_orders_manual_fulfill/);
  assert.match(migration, /FILM_ORDER_MANUALLY_FULFILLED/);
  assert.match(migration, /MANUALLY_FULFILLED/);
  assert.match(migration, /manualFulfilledAt/);
  assert.match(migration, /v_manually_fulfilled/);
  assert.match(migration, /Linked boxes and physical LF were not changed/);
  assert.match(
    migration,
    /revoke_execute_if_exists\('public\.api_film_orders_manual_fulfill\(uuid, text, jsonb\)', 'authenticated'\)/
  );
  assert.match(
    migration,
    /revoke_execute_if_exists\('public\.api_film_orders_manual_fulfill\(uuid, text, jsonb\)', 'public'\)/
  );
  assert.doesNotMatch(
    migration,
    /grant_execute_if_exists\('public\.api_film_orders_manual_fulfill\(uuid, text, jsonb\)', 'authenticated'\)/
  );
  assert.doesNotMatch(migration, /insert\s+into\s+app\.boxes/i);
  assert.doesNotMatch(migration, /update\s+app\.boxes/i);
});

test('manual film-order fulfill permission fix keeps direct RPC behind the server surface', async () => {
  const migration = await readFile(backendPublicPermissionFixMigrationPath, 'utf8');

  assert.match(
    migration,
    /revoke_execute_if_exists\('public\.api_film_orders_manual_fulfill\(uuid, text, jsonb\)', 'public'\)/
  );
  assert.match(
    migration,
    /revoke_execute_if_exists\('public\.api_film_orders_manual_fulfill\(uuid, text, jsonb\)', 'authenticated'\)/
  );
  assert.match(
    migration,
    /grant_execute_if_exists\('public\.api_film_orders_manual_fulfill\(uuid, text, jsonb\)', 'service_role'\)/
  );
  assert.match(
    migration,
    /grant_execute_if_exists\('public\.api_acl_film_orders_manual_fulfill\(uuid, text, jsonb\)', 'authenticated'\)/
  );
});

test('schema latest guards manual film-order fulfill functions and display status', async () => {
  const schemaLatest = await readFile(schemaLatestPath, 'utf8');

  assert.match(schemaLatest, /public\.api_film_orders_manual_fulfill\(uuid, text, jsonb\)/);
  assert.match(schemaLatest, /public\.api_acl_film_orders_manual_fulfill\(uuid, text, jsonb\)/);
  assert.match(schemaLatest, /FILM_ORDER_MANUALLY_FULFILLED/);
  assert.match(schemaLatest, /MANUALLY_FULFILLED/);
});
