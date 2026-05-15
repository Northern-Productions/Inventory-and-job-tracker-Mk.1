import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const backendMigration = readFileSync(new URL('../../migrations/0117_duplicate_job_creation_guard.sql', import.meta.url), 'utf8');
const supabaseMigration = readFileSync(
  new URL('../../../supabase/migrations/20260510190000_duplicate_job_creation_guard.sql', import.meta.url),
  'utf8'
);
const schemaCheck = readFileSync(new URL('../check-schema-latest.mjs', import.meta.url), 'utf8');

test('duplicate job creation guard migration is mirrored for Supabase deploys', () => {
  assert.equal(supabaseMigration, backendMigration);
});

test('duplicate job creation guard migration changes create only and keeps uniqueness intact', () => {
  assert.match(backendMigration, /create or replace function public\.api_jobs_create/);
  assert.doesNotMatch(backendMigration, /create or replace function public\.api_jobs_update/);
  assert.doesNotMatch(backendMigration, /alter table app\.jobs/i);
  assert.doesNotMatch(backendMigration, /unique\s*\(\s*org_id\s*,\s*job_number/i);
  assert.doesNotMatch(backendMigration, /punch/i);
});

test('duplicate job creation guard migration rejects existing job numbers before saving', () => {
  assert.match(
    backendMigration,
    /v_job_number text := app_api\.require_job_number_digits\(p_payload->>'jobNumber', 'Job ID number'\);/
  );
  assert.match(backendMigration, /where j\.org_id = p_org_id\s+and j\.job_number = v_job_number\s+for update;/);
  assert.match(backendMigration, /if found then\s+perform app_api\.raise_http\(409, format\('Job %s already exists\.', v_job_number\)\);\s+end if;/);
  assert.match(backendMigration, /v_job\.id := gen_random_uuid\(\);/);
  assert.doesNotMatch(backendMigration, /if not found then/);
});

test('duplicate job creation guard migration preserves job create payload behavior', () => {
  assert.match(backendMigration, /v_job\.warehouse := app_api\.require_org_warehouse/);
  assert.match(
    backendMigration,
    /case when p_payload \? 'workScope' then p_payload->>'workScope' else p_payload->>'sections' end/
  );
  assert.match(backendMigration, /app_api\.replace_job_requirements/);
  assert.match(backendMigration, /app_api\.replace_job_caulk_requirements/);
  assert.match(backendMigration, /v_has_labor_only_input/);
});

test('schema guard tracks duplicate job creation guard semantics', () => {
  assert.match(schemaCheck, /const LATEST_MIGRATION = '0133_job_cancel_jobid_scope\.sql';/);
  assert.match(schemaCheck, /signature: 'public\.api_jobs_create\(uuid, text, jsonb\)'/);
  assert.match(schemaCheck, /perform app_api\.raise_http\(409, format\('Job %s already exists\.', v_job_number\)\);/);
  assert.match(schemaCheck, /if not found then/);
});
