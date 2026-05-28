import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../../migrations/0112_preserve_job_requirement_ids.sql', import.meta.url), 'utf8');
const supabaseMigration = readFileSync(
  new URL('../../../supabase/migrations/20260509120000_preserve_job_requirement_ids.sql', import.meta.url),
  'utf8'
);
const schemaGuard = readFileSync(new URL('../check-schema-latest.mjs', import.meta.url), 'utf8');

test('job requirement id preservation migration keeps valid submitted requirement ids', () => {
  assert.match(
    migration,
    /requirement_rows_from_payload_with_ids/,
    'Expected the migration to add a requirement payload helper that carries requirement IDs.'
  );
  assert.match(
    migration,
    /and r\.id = v_requirement\.requirement_id/,
    'Expected replace_job_requirements to prefer valid existing IDs from the submitted payload.'
  );
  assert.match(
    migration,
    /delete from app\.job_requirements[\s\S]*and not \(id = any\(v_retained_ids\)\)/,
    'Expected stale requirements to be deleted only after retained IDs are known.'
  );
  assert.doesNotMatch(
    migration,
    /delete from app\.job_requirements[\s\S]*for v_requirement in/,
    'Expected replace_job_requirements not to delete all requirements before matching existing rows.'
  );
});

test('backend and Supabase job requirement id preservation migrations stay mirrored', () => {
  assert.equal(
    supabaseMigration,
    migration,
    'Expected backend guard and Supabase release migration copies to be identical.'
  );
});

test('latest schema guard requires job requirement id preservation release objects', () => {
  assert.match(
    schemaGuard,
    /const LATEST_MIGRATION = '0153_manual_only_auto_allocation_job_warehouse\.sql';/,
    'Expected the schema guard to name the new latest backend migration.'
  );
  assert.match(
    schemaGuard,
    /app_api\.requirement_rows_from_payload_with_ids\(jsonb\)/,
    'Expected the schema guard to require the new payload helper.'
  );
  assert.match(
    schemaGuard,
    /app_api\.replace_job_requirements\(uuid, app\.jobs, jsonb, text, timestamp with time zone\)/,
    'Expected the schema guard to verify the updated replacement function.'
  );
});
