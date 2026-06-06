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
  '0109_revoke_authenticated_app_schema_usage.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260506143000_revoke_authenticated_app_schema_usage.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

test('authenticated app schema usage revoke migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('authenticated app schema usage revoke migration only closes authenticated app schema access', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /revoke usage on schema app from authenticated;/);
  assert.doesNotMatch(migration, /revoke usage on schema app from service_role;/);
  assert.doesNotMatch(migration, /revoke usage on schema app from postgres;/);
  assert.doesNotMatch(migration, /\bgrant\b[\s\S]*\bto authenticated\b/i);
});

test('latest schema check points to the authenticated app schema usage revoke', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');

  assert.match(schemaCheck, /0156_film_weight_profiles_foundation\.sql/);
  assert.match(schemaCheck, /authenticated_app_schema_usage/);
  assert.match(schemaCheck, /service_role_app_schema_usage/);
});
