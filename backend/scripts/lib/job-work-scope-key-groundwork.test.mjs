import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

import {
  BLANK_WORK_SCOPE_KEY,
  normalizeJobWorkScopeKey,
} from '../../../shared/domain/jobWorkScopeNormalization.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0135_job_work_scope_key_groundwork.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260518010000_job_work_scope_key_groundwork.sql'
);
const migrationsPath = path.join(repoRoot, 'backend', 'migrations');
const supabaseMigrationsPath = path.join(repoRoot, 'supabase', 'migrations');
const schemaLatestPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');
const baseSchemaPath = path.join(repoRoot, 'backend', 'migrations', '0001_supabase_inventory_schema.sql');
const duplicateGuardPath = path.join(repoRoot, 'backend', 'migrations', '0117_duplicate_job_creation_guard.sql');

function sqlLikeNormalizeJobWorkScopeKey(value) {
  const display = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!display) {
    return BLANK_WORK_SCOPE_KEY;
  }

  const normalized = display
    .toLowerCase()
    .replace(/\s*,\s*/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
  const sectionCandidate = normalized.replace(/^(sections?|secs?)\.?\s+/, '');
  const tokenSource = sectionCandidate
    .replace(/\band\b/g, ',')
    .replace(/[;&]/g, ',');

  if (/^[0-9,\s]+$/.test(tokenSource)) {
    const tokens = tokenSource
      .split(/[,\s]+/)
      .filter(Boolean)
      .map((token) => token.replace(/^0+/, '') || '0');
    const sectionNumbers = Array.from(new Set(tokens));
    sectionNumbers.sort((left, right) => {
      const leftValue = BigInt(left);
      const rightValue = BigInt(right);
      if (leftValue < rightValue) {
        return -1;
      }
      if (leftValue > rightValue) {
        return 1;
      }
      return 0;
    });

    if (sectionNumbers.length > 0) {
      return `section:${sectionNumbers.join(',')}`;
    }
  }

  return `text:${normalized}`;
}

test('work scope key groundwork migrations stay mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('work scope key groundwork migration order precedes final duplicate enablement', async () => {
  const backendMigrations = (await readdir(migrationsPath)).filter((entry) => /^\d+_/.test(entry)).sort();
  const supabaseMigrations = (await readdir(supabaseMigrationsPath)).filter((entry) => /^\d+_/.test(entry)).sort();

  assert.equal(backendMigrations.at(-19), '0134_caulk_read_jobid_scope_projection.sql');
  assert.equal(backendMigrations.at(-18), '0135_job_work_scope_key_groundwork.sql');
  assert.equal(backendMigrations.at(-17), '0136_enable_job_number_work_scope_uniqueness.sql');
  assert.equal(backendMigrations.at(-16), '0137_repair_box_update_partial_receiving_parity.sql');
  assert.equal(backendMigrations.at(-15), '0138_preserve_partial_box_update_physical_feet.sql');
  assert.equal(backendMigrations.at(-14), '0139_box_status_duplicate_job_checkout_guard.sql');
  assert.equal(backendMigrations.at(-13), '0140_box_checkin_physical_lf_reconciliation_priority.sql');
  assert.equal(backendMigrations.at(-12), '0141_box_checkin_reconcile_same_job_allocations.sql');
  assert.equal(backendMigrations.at(-11), '0142_requirement_actual_usage_state.sql');
  assert.equal(backendMigrations.at(-10), '0143_multi_phase_jobs.sql');
  assert.equal(backendMigrations.at(-9), '0144_phase_edit_modal_work_scope_fix.sql');
  assert.equal(backendMigrations.at(-8), '0145_legacy_checkin_requirement_reconciliation.sql');
  assert.equal(backendMigrations.at(-7), '0146_caulk_requirement_actual_usage_state.sql');
  assert.equal(backendMigrations.at(-6), '0147_phase_calendar_install_end_date.sql');
  assert.equal(backendMigrations.at(-5), '0148_close_checked_in_allocations.sql');
  assert.equal(backendMigrations.at(-4), '0149_film_order_traceability.sql');
  assert.equal(backendMigrations.at(-3), '0150_phase_workflow_status.sql');
  assert.equal(backendMigrations.at(-2), '0151_user_default_warehouse_preferences.sql');
  assert.equal(backendMigrations.at(-1), '0152_fix_planner_suppression_on_conflict.sql');
  assert.equal(supabaseMigrations.at(-19), '20260514030000_caulk_read_jobid_scope_projection.sql');
  assert.equal(supabaseMigrations.at(-18), '20260518010000_job_work_scope_key_groundwork.sql');
  assert.equal(supabaseMigrations.at(-17), '20260518020000_enable_job_number_work_scope_uniqueness.sql');
  assert.equal(supabaseMigrations.at(-16), '20260520010000_repair_box_update_partial_receiving_parity.sql');
  assert.equal(supabaseMigrations.at(-15), '20260520020000_preserve_partial_box_update_physical_feet.sql');
  assert.equal(supabaseMigrations.at(-14), '20260520030000_box_status_duplicate_job_checkout_guard.sql');
  assert.equal(supabaseMigrations.at(-13), '20260520040000_box_checkin_physical_lf_reconciliation_priority.sql');
  assert.equal(supabaseMigrations.at(-12), '20260520050000_box_checkin_reconcile_same_job_allocations.sql');
  assert.equal(supabaseMigrations.at(-11), '20260521010000_requirement_actual_usage_state.sql');
  assert.equal(supabaseMigrations.at(-10), '20260521020000_multi_phase_jobs.sql');
  assert.equal(supabaseMigrations.at(-9), '20260521120000_phase_edit_modal_work_scope_fix.sql');
  assert.equal(supabaseMigrations.at(-8), '20260521150000_legacy_checkin_requirement_reconciliation.sql');
  assert.equal(supabaseMigrations.at(-7), '20260521160000_caulk_requirement_actual_usage_state.sql');
  assert.equal(supabaseMigrations.at(-6), '20260521173000_phase_calendar_install_end_date.sql');
  assert.equal(supabaseMigrations.at(-5), '20260522090000_close_checked_in_allocations.sql');
  assert.equal(supabaseMigrations.at(-4), '20260523100000_film_order_traceability.sql');
  assert.equal(supabaseMigrations.at(-3), '20260523110000_phase_workflow_status.sql');
  assert.equal(supabaseMigrations.at(-2), '20260525120000_user_default_warehouse_preferences.sql');
  assert.equal(supabaseMigrations.at(-1), '20260527100000_fix_planner_suppression_on_conflict.sql');
});

test('work scope key migration adds only the helper, generated column, and non-unique support index', async () => {
  const [migration, baseSchema, duplicateGuard] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(baseSchemaPath, 'utf8'),
    readFile(duplicateGuardPath, 'utf8'),
  ]);

  assert.match(migration, /create or replace function app_api\.normalize_job_work_scope_key\(p_value text\)/);
  assert.match(migration, /returns text\s+language plpgsql\s+immutable/is);
  assert.match(migration, /return 'blank:'/);
  assert.match(migration, /return 'section:' \|\| array_to_string\(v_section_numbers, ','\);/);
  assert.match(migration, /return 'text:' \|\| v_normalized;/);
  assert.match(
    migration,
    /add column if not exists work_scope_key text\s+generated always as \(app_api\.normalize_job_work_scope_key\(sections\)\) stored/is
  );
  assert.match(
    migration,
    /create index if not exists idx_jobs_org_job_number_work_scope_key\s+on app\.jobs \(org_id, job_number, work_scope_key\);/is
  );
  assert.doesNotMatch(migration, /create unique index/i);
  assert.doesNotMatch(migration, /unique\s*\(\s*org_id\s*,\s*job_number\s*,\s*work_scope_key\s*\)/i);
  assert.doesNotMatch(migration, /drop constraint/i);
  assert.doesNotMatch(migration, /update\s+app\.jobs/i);
  assert.doesNotMatch(migration, /api_jobs_create|api_jobs_check_duplicate|jobs\/create|jobs\/check-duplicate/i);
  assert.match(baseSchema, /unique\s*\(\s*org_id\s*,\s*job_number\s*\)/i);
  assert.match(duplicateGuard, /Job %s already exists/);
});

test('SQL work scope key normalization mirrors shared JS normalization for representative cases', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const cases = [
    [null, 'blank:'],
    ['', 'blank:'],
    ['   \t  \n ', 'blank:'],
    ['Section 1', 'section:1'],
    ['Sections 01', 'section:1'],
    ['sec. 001', 'section:1'],
    ['secs 1', 'section:1'],
    ['1, 2', 'section:1,2'],
    ['2,1', 'section:1,2'],
    ['section 1 and 2', 'section:1,2'],
    ['section 2; 1 & 02', 'section:1,2'],
    ['Sections 1, 01, 2, 2', 'section:1,2'],
    ['  Lobby   Phase,   North  ', 'text:lobby phase,north'],
    ['LOBBY ,  North', 'text:lobby,north'],
    ['Section 1 Lobby', 'text:section 1 lobby'],
    ['Phase 2, Section 1', 'text:phase 2,section 1'],
  ];

  for (const [input, expected] of cases) {
    assert.equal(normalizeJobWorkScopeKey(input), expected, `JS helper case ${String(input)}`);
    assert.equal(sqlLikeNormalizeJobWorkScopeKey(input), expected, `SQL-like helper case ${String(input)}`);
  }

  assert.match(migration, /regexp_replace\(btrim\(coalesce\(p_value, ''\)\), '\[\[:space:\]\]\+', ' ', 'g'\)/);
  assert.match(migration, /regexp_replace\(v_normalized, '\[\[:space:\]\]\*,\[\[:space:\]\]\*', ',', 'g'\)/);
  assert.match(migration, /regexp_replace\(v_section_candidate, '\\mand\\M', ',', 'g'\)/);
  assert.match(migration, /regexp_split_to_table\(v_token_source, '\[,\[:space:\]\]\+'\) as parts\(token\)/);
  assert.match(migration, /array_agg\(token order by length\(token\), token\)/);
});

test('schema latest guard keeps work scope key generated column checks after duplicate enablement', async () => {
  const schemaLatest = await readFile(schemaLatestPath, 'utf8');

  assert.match(schemaLatest, /const LATEST_MIGRATION = '0152_fix_planner_suppression_on_conflict\.sql';/);
  assert.match(schemaLatest, /signature: 'app\.jobs\.work_scope_key'/);
  assert.match(schemaLatest, /signature: 'app_api\.normalize_job_work_scope_key\(text\)'/);
  assert.match(schemaLatest, /a\.attgenerated = 's' as is_generated_stored/);
  assert.match(schemaLatest, /app_api\.normalize_job_work_scope_key\(sections\)/);
  assert.match(schemaLatest, /unique\(org_id, job_number, work_scope_key\)/);
  assert.match(schemaLatest, /must not retain unique\(org_id, job_number\)/);
});
