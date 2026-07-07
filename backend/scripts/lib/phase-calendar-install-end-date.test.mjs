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
  '0147_phase_calendar_install_end_date.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260521173000_phase_calendar_install_end_date.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

test('phase calendar install end date migration is mirrored and schema-guarded', async () => {
  const [backendMigration, supabaseMigration, schemaCheck] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
    readFile(schemaCheckPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);

  assert.match(schemaCheck, /0183_restore_api_list_memberships_execute_grant\.sql/);

  assert.match(schemaCheck, /app\.job_phases\.install_end_date/);
  assert.match(backendMigration, /add column if not exists install_end_date date/);
  assert.match(backendMigration, /job_phases_install_end_date_check/);
});

test('phase install end date validation is enforced in SQL phase replacement', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /installEndDate/);
  assert.match(migration, /Install End Date requires an Install Date\./);
  assert.match(migration, /Install End Date must use yyyy-mm-dd\./);
  assert.match(migration, /Install End Date must be the same day as or later than Install Date\./);
  assert.match(migration, /install_end_date = excluded\.install_end_date/);
});
