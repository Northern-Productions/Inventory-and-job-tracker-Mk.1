import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const backendMigration = readFileSync(
  new URL('../../migrations/0114_job_id_read_route.sql', import.meta.url),
  'utf8'
);
const supabaseMigration = readFileSync(
  new URL('../../../supabase/migrations/20260510160000_job_id_read_route.sql', import.meta.url),
  'utf8'
);

test('job id read-route migration copies stay aligned', () => {
  assert.equal(backendMigration, supabaseMigration);
});

test('job id read-route migration adds read-only ACL lookup without changing job uniqueness', () => {
  const migration = backendMigration;

  assert.match(migration, /create or replace function public\.api_find_job_by_id\(/);
  assert.match(migration, /create or replace function public\.api_acl_find_job_by_id\(/);
  assert.match(migration, /where j\.org_id = p_org_id\s+and j\.id = p_job_id;/);
  assert.match(migration, /require_effective_feature_access\(p_org_id, 'jobs', 'read'\)/);
  assert.match(migration, /grant_execute_if_exists\('public\.api_acl_find_job_by_id\(uuid, uuid\)', 'authenticated'\)/);
  assert.doesNotMatch(migration, /alter table app\.jobs/i);
  assert.doesNotMatch(migration, /unique\s*\(\s*org_id\s*,\s*job_number/i);
});
