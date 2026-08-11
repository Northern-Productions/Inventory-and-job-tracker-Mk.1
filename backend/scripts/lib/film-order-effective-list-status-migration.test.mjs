import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const backendMigrationUrl = new URL(
  '../../migrations/0196_film_order_effective_list_status.sql',
  import.meta.url,
);
const supabaseMigrationUrl = new URL(
  '../../../supabase/migrations/20260807100000_film_order_effective_list_status.sql',
  import.meta.url,
);
const schemaGuardUrl = new URL('../check-schema-latest.mjs', import.meta.url);

test('effective Film Order list migration stays byte-aligned between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationUrl),
    readFile(supabaseMigrationUrl),
  ]);

  assert.deepEqual(supabaseMigration, backendMigration);
});

test('effective Film Order list projection matches canonical detail status and coverage rules', async () => {
  const migration = await readFile(backendMigrationUrl, 'utf8');

  assert.equal(
    migration.match(/create or replace function public\.api_list_film_orders\(/g)?.length,
    1,
  );
  assert.match(migration, /with scoped_orders as materialized/);
  assert.match(migration, /where f\.org_id = p_org_id/);
  assert.match(migration, /linked_box_coverage as materialized/);
  assert.match(migration, /coalesce\(sum\(greatest\(coalesce\(b\.initial_feet, 0\), 0\)\), 0\)::integer as fulfilled_feet/);
  assert.match(migration, /latest_manual_fulfill as materialized/);
  assert.match(migration, /removed_requirement_events as materialized/);
  assert.match(
    migration,
    /app_api\.film_order_matches_requirement\(\s*p_org_id,\s*r\.id,\s*r\.manufacturer,\s*r\.film_name,\s*r\.width_in,\s*so\.requirement_id,\s*so\.manufacturer,\s*so\.film_name,\s*so\.width_in\s*\)/s,
  );
  for (const displayStatus of [
    'CANCELLED',
    'MANUALLY_FULFILLED',
    'NO_LONGER_NEEDED',
    'FILM_ORDER',
    'INCOMPLETE',
    'FULFILLED_COVERED',
  ]) {
    assert.ok(migration.includes(`'${displayStatus}'`));
  }
  for (const field of [
    'stored_status',
    'display_status',
    'need_source',
    'needed_feet',
    'fulfilled_feet',
    'remaining_feet',
    'overage_feet',
  ]) {
    assert.ok(migration.includes(`'${field}'`));
  }
});

test('effective Film Order list remains a scoped batched read behind the existing ACL wrapper', async () => {
  const migration = await readFile(backendMigrationUrl, 'utf8');

  assert.match(migration, /perform app_api\.require_org_member\(p_org_id\);/);
  assert.match(migration, /app_api\.require_org_warehouse\(p_org_id, v_warehouse, 'Warehouse'\)/);
  assert.match(
    migration,
    /revoke execute on function public\.api_list_film_orders\(uuid, text\) from public, anon, authenticated, service_role;/,
  );
  assert.doesNotMatch(migration, /create or replace function public\.api_acl_list_film_orders/);
  assert.doesNotMatch(migration, /\b(?:insert into|update app\.|delete from|truncate|execute format)\b/i);
});

test('latest schema guard preserves the 0196 contract beneath the 0197 successor', async () => {
  const schemaGuard = await readFile(schemaGuardUrl, 'utf8');

  assert.match(
    schemaGuard,
    /const LATEST_MIGRATION = '0197_film_order_order_scope_semantics\.sql';/,
  );
  assert.match(schemaGuard, /signature: 'public\.api_list_film_orders\(uuid, text\)'/);
  assert.match(schemaGuard, /signature: 'app_api\.film_order_ledger_projection\(uuid, text\[\]\)'/);
  assert.match(schemaGuard, /'remaining_to_order_feet'/);
});
