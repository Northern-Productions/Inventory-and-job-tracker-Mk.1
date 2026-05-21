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
const backendPermissionMigration = readFileSync(
  new URL('../../migrations/0115_job_id_read_route_permissions.sql', import.meta.url),
  'utf8'
);
const supabasePermissionMigration = readFileSync(
  new URL('../../../supabase/migrations/20260510170000_job_id_read_route_permissions.sql', import.meta.url),
  'utf8'
);
const schemaCheck = readFileSync(new URL('../check-schema-latest.mjs', import.meta.url), 'utf8');

test('job id read-route migration copies stay aligned', () => {
  assert.equal(backendMigration, supabaseMigration);
});

test('job id read-route permission migration copies stay aligned', () => {
  assert.equal(backendPermissionMigration, supabasePermissionMigration);
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

test('job id read-route permission migration restricts direct helper execution', () => {
  const migration = backendPermissionMigration;

  assert.match(migration, /revoke execute on function %s from public/);
  assert.match(migration, /revoke execute on function %s from anon/);
  assert.match(migration, /revoke execute on function %s from authenticated/);
  assert.match(migration, /revoke execute on function %s from service_role/);
  assert.match(migration, /grant execute on function %s to authenticated/);
  assert.match(migration, /grant execute on function %s to service_role/);
  assert.match(migration, /public\.api_find_job_by_id\(uuid, uuid\)/);
  assert.match(migration, /public\.api_acl_find_job_by_id\(uuid, uuid\)/);
  assert.doesNotMatch(migration, /alter table app\.jobs/i);
  assert.doesNotMatch(migration, /unique\s*\(\s*org_id\s*,\s*job_number/i);
});

test('schema guard expects the job id read-route permission migration and RPC permissions', () => {
  assert.match(schemaCheck, /const LATEST_MIGRATION = '0144_phase_edit_modal_work_scope_fix\.sql';/);
  assert.match(schemaCheck, /signature: 'public\.api_find_job_by_id\(uuid, uuid\)'/);
  assert.match(schemaCheck, /signature: 'public\.api_acl_find_job_by_id\(uuid, uuid\)'/);
  assert.match(schemaCheck, /public_find_job_by_id_execute/);
  assert.match(schemaCheck, /anon_find_job_by_id_execute/);
  assert.match(schemaCheck, /authenticated_find_job_by_id_execute/);
  assert.match(schemaCheck, /service_role_find_job_by_id_execute/);
  assert.match(schemaCheck, /public_acl_find_job_by_id_execute/);
  assert.match(schemaCheck, /anon_acl_find_job_by_id_execute/);
  assert.match(schemaCheck, /authenticated_acl_find_job_by_id_execute/);
  assert.match(schemaCheck, /service_role_acl_find_job_by_id_execute/);
});
