import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const backendMigration = readFileSync(new URL('../../migrations/0116_job_work_scope.sql', import.meta.url), 'utf8');
const supabaseMigration = readFileSync(
  new URL('../../../supabase/migrations/20260510180000_job_work_scope.sql', import.meta.url),
  'utf8'
);
const schemaCheck = readFileSync(new URL('../check-schema-latest.mjs', import.meta.url), 'utf8');

test('job work scope migration is mirrored for Supabase deploys', () => {
  assert.equal(supabaseMigration, backendMigration);
});

test('job work scope migration keeps sections storage and job-number uniqueness intact', () => {
  assert.doesNotMatch(backendMigration, /add column/i);
  assert.doesNotMatch(backendMigration, /drop column/i);
  assert.doesNotMatch(backendMigration, /alter table app\.jobs/i);
  assert.doesNotMatch(backendMigration, /unique\s*\(\s*org_id\s*,\s*job_number/i);
  assert.match(backendMigration, /v_job\.sections :=/);
});

test('job work scope migration relaxes numeric-only sections into flexible work scope text', () => {
  assert.match(backendMigration, /create or replace function app_api\.normalize_job_work_scope\(p_value text\)/);
  assert.match(backendMigration, /regexp_replace\(v_trimmed, '\[\[:space:\]\]\+', ' ', 'g'\)/);
  assert.match(backendMigration, /select app_api\.normalize_job_work_scope\(p_value\);/);
  assert.doesNotMatch(backendMigration, /Sections must contain numbers separated by commas\./);
});

test('job work scope migration makes workScope win over legacy sections in create and update', () => {
  assert.match(backendMigration, /create or replace function public\.api_jobs_create/);
  assert.match(backendMigration, /create or replace function public\.api_jobs_update/);
  assert.match(
    backendMigration,
    /case when p_payload \? 'workScope' then p_payload->>'workScope' else p_payload->>'sections' end/
  );
  assert.match(backendMigration, /if p_payload \? 'workScope' or p_payload \? 'sections' then/);
  assert.doesNotMatch(backendMigration, /app_api\.normalize_job_sections\(p_payload->>'sections'\)/);
});

test('schema guard tracks the job work scope migration and semantics', () => {
  assert.match(schemaCheck, /const LATEST_MIGRATION = '0140_box_checkin_physical_lf_reconciliation_priority\.sql';/);
  assert.match(schemaCheck, /signature: 'app_api\.normalize_job_work_scope\(text\)'/);
  assert.match(schemaCheck, /signature: 'app_api\.normalize_job_sections\(text\)'/);
  assert.match(schemaCheck, /signature: 'public\.api_jobs_create\(uuid, text, jsonb\)'/);
  assert.match(schemaCheck, /signature: 'public\.api_jobs_update\(uuid, text, jsonb\)'/);
  assert.match(schemaCheck, /app_api\.normalize_job_work_scope\(p_value\)/);
  assert.match(schemaCheck, /p_payload \? 'workScope'/);
});
