import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0087_allocation_reserved_availability.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260425130000_allocation_reserved_availability.sql'
);

test('allocation reserved availability migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8')
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('allocation reserved availability migration counts only qualifying capacity reservations', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /film_allocation_reserves_capacity/);
  assert.match(migration, /\(p_allocation\)\.requirement_id is not null/);
  assert.match(migration, /\(p_allocation\)\.job_id is not null/);
  assert.match(migration, /coalesce\(\(p_allocation\)\.allocation_kind::text, 'REQUIREMENT'\) = 'REQUIREMENT'/);
  assert.match(migration, /\(p_allocation\)\.status = 'ACTIVE'/);
  assert.match(migration, /\(p_allocation\)\.status = 'FULFILLED'/);
  assert.match(migration, /upper\(coalesce\(p_box_status, ''\)\) = 'CHECKED_OUT'/);
  assert.doesNotMatch(migration, /p_allocation\.job_date is not null\s+or/);
  assert.match(migration, /coalesce\(\(p_allocation\)\.allocation_source::text, 'MANUAL'\) <> 'AUTO_PLANNED'/);
  assert.match(migration, /app_api\.film_allocation_reserves_capacity\(a, bx\.status\)/);
});
