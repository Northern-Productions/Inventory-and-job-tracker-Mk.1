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
  '0101_roll_weight_feet_rounding_parity.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260503110000_roll_weight_feet_rounding_parity.sql'
);

test('roll-weight rounding parity migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('roll-weight rounding parity migration rounds raw feet before flooring', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /create or replace function app_api\.derive_feet_available_from_roll_weight/);
  assert.match(
    migration,
    /round\(\(\(p_last_roll_weight - p_core_weight\) \/ p_lf_weight\)::numeric, 2\)/
  );
  assert.match(migration, /v_floored := floor\(v_raw_feet\);/);
});
