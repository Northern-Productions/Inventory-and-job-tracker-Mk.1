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


  const expectedBackendTail = [
    '0134_caulk_read_jobid_scope_projection.sql',
    '0135_job_work_scope_key_groundwork.sql',
    '0136_enable_job_number_work_scope_uniqueness.sql',
    '0137_repair_box_update_partial_receiving_parity.sql',
    '0138_preserve_partial_box_update_physical_feet.sql',
    '0139_box_status_duplicate_job_checkout_guard.sql',
    '0140_box_checkin_physical_lf_reconciliation_priority.sql',
    '0141_box_checkin_reconcile_same_job_allocations.sql',
    '0142_requirement_actual_usage_state.sql',
    '0143_multi_phase_jobs.sql',
    '0144_phase_edit_modal_work_scope_fix.sql',
    '0145_legacy_checkin_requirement_reconciliation.sql',
    '0146_caulk_requirement_actual_usage_state.sql',
    '0147_phase_calendar_install_end_date.sql',
    '0148_close_checked_in_allocations.sql',
    '0149_film_order_traceability.sql',
    '0150_phase_workflow_status.sql',
    '0151_user_default_warehouse_preferences.sql',
    '0152_fix_planner_suppression_on_conflict.sql',
    '0153_manual_only_auto_allocation_job_warehouse.sql',
    '0154_manual_allocation_explicit_selection.sql',
    '0155_film_order_detail_origin_compat.sql',
    '0156_film_weight_profiles_foundation.sql',
    '0157_service_role_staged_pickup_acl.sql',
    '0158_material_flow_reconciliation_rules.sql',
    '0159_box_lf_correction_reconciles_allocations.sql',
    '0160_linked_film_order_physical_lf_recalc.sql',
    '0161_linked_film_order_shortage_reconcile_guard.sql',
    '0162_prevent_box_id_alias_collisions.sql',
  ];
  assert.deepEqual(backendMigrations.slice(-expectedBackendTail.length), expectedBackendTail);
  const expectedSupabaseTail = [
    '20260514030000_caulk_read_jobid_scope_projection.sql',
    '20260518010000_job_work_scope_key_groundwork.sql',
    '20260518020000_enable_job_number_work_scope_uniqueness.sql',
    '20260520010000_repair_box_update_partial_receiving_parity.sql',
    '20260520020000_preserve_partial_box_update_physical_feet.sql',
    '20260520030000_box_status_duplicate_job_checkout_guard.sql',
    '20260520040000_box_checkin_physical_lf_reconciliation_priority.sql',
    '20260520050000_box_checkin_reconcile_same_job_allocations.sql',
    '20260521010000_requirement_actual_usage_state.sql',
    '20260521020000_multi_phase_jobs.sql',
    '20260521120000_phase_edit_modal_work_scope_fix.sql',
    '20260521150000_legacy_checkin_requirement_reconciliation.sql',
    '20260521160000_caulk_requirement_actual_usage_state.sql',
    '20260521173000_phase_calendar_install_end_date.sql',
    '20260522090000_close_checked_in_allocations.sql',
    '20260523100000_film_order_traceability.sql',
    '20260523110000_phase_workflow_status.sql',
    '20260525120000_user_default_warehouse_preferences.sql',
    '20260527100000_fix_planner_suppression_on_conflict.sql',
    '20260528100000_manual_only_auto_allocation_job_warehouse.sql',
    '20260529100000_manual_allocation_explicit_selection.sql',
    '20260529101000_film_order_detail_origin_compat.sql',
    '20260603100000_film_weight_profiles_foundation.sql',
    '20260608120000_service_role_staged_pickup_acl.sql',
    '20260608130000_material_flow_reconciliation_rules.sql',
    '20260613100000_box_lf_correction_reconciles_allocations.sql',
    '20260613102000_linked_film_order_physical_lf_recalc.sql',
    '20260613103000_linked_film_order_shortage_reconcile_guard.sql',
    '20260617100000_prevent_box_id_alias_collisions.sql',
  ];
  assert.deepEqual(supabaseMigrations.slice(-expectedSupabaseTail.length), expectedSupabaseTail);

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


  assert.match(schemaLatest, /const LATEST_MIGRATION = '0162_prevent_box_id_alias_collisions\.sql';/);

  assert.match(schemaLatest, /signature: 'app\.jobs\.work_scope_key'/);
  assert.match(schemaLatest, /signature: 'app_api\.normalize_job_work_scope_key\(text\)'/);
  assert.match(schemaLatest, /a\.attgenerated = 's' as is_generated_stored/);
  assert.match(schemaLatest, /app_api\.normalize_job_work_scope_key\(sections\)/);
  assert.match(schemaLatest, /unique\(org_id, job_number, work_scope_key\)/);
  assert.match(schemaLatest, /must not retain unique\(org_id, job_number\)/);
});
