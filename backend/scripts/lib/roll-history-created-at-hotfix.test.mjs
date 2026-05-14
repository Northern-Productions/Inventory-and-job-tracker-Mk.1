import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0097_fix_append_roll_history_without_timezone_overload.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260428203000_fix_append_roll_history_without_timezone_overload.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

function countMatches(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

test('roll history overload hotfix migration stays mirrored', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('roll history overload hotfix uses explicit insert columns for both overloads', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /p_checked_in_at timestamp with time zone/);
  assert.match(migration, /p_checked_in_at timestamp without time zone/);
  assert.equal(countMatches(migration, /create or replace function app_api\.append_roll_history/g), 2);
  assert.equal(countMatches(migration, /insert into app\.roll_weight_log\s*\(/g), 2);
  assert.equal(countMatches(migration, /created_at\s*\)\s*values/gs), 2);
  assert.equal(countMatches(migration, /return v_log_id;/g), 2);
  assert.doesNotMatch(migration, /::app\.roll_weight_log/);
  assert.doesNotMatch(migration, /::app\.warehouse/);
  assert.doesNotMatch(migration, /app_api\.append_roll_history_entry\(/);
});

test('latest schema check still validates the roll history overload hotfix semantics', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');

  assert.match(schemaCheck, /0124_film_order_create_jobid_scope\.sql/);
  assert.match(schemaCheck, /insert into app\.roll_weight_log \(/);
  assert.match(schemaCheck, /created_at\\n  \)/);
  assert.match(schemaCheck, /timestamp with time zone/);
  assert.match(schemaCheck, /timestamp without time zone/);
  assert.match(schemaCheck, /::app\.roll_weight_log/);
  assert.match(schemaCheck, /::app\.warehouse/);
  assert.match(schemaCheck, /app_api\.append_roll_history_entry\(/);
});
