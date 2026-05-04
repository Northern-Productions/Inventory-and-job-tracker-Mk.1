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
  '0103_service_role_app_schema_rest_access.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260504120000_service_role_app_schema_rest_access.sql'
);

test('service-role app schema REST access migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('service-role app schema REST access migration keeps direct user roles closed', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /grant usage on schema app to service_role;/);
  assert.match(migration, /grant select, insert, update, delete\s+on all tables in schema app\s+to service_role;/);
  assert.match(migration, /grant usage, select\s+on all sequences in schema app\s+to service_role;/);
  assert.match(
    migration,
    /alter default privileges in schema app\s+grant select, insert, update, delete on tables to service_role;/
  );
  assert.match(
    migration,
    /alter default privileges in schema app\s+grant usage, select on sequences to service_role;/
  );
  assert.doesNotMatch(migration, /\bgrant\b[\s\S]*\bto anon\b/i);
  assert.doesNotMatch(migration, /\bgrant\b[\s\S]*\bto authenticated\b/i);
});
