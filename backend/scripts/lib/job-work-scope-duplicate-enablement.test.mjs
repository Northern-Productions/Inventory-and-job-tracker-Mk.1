import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0136_enable_job_number_work_scope_uniqueness.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260518020000_enable_job_number_work_scope_uniqueness.sql'
);
const migrationsPath = path.join(repoRoot, 'backend', 'migrations');
const supabaseMigrationsPath = path.join(repoRoot, 'supabase', 'migrations');
const schemaLatestPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');
const repositoryPath = path.join(repoRoot, 'backend', 'src', 'app', 'repositories', 'jobsRepository.mjs');
const runtimeMutationsPath = path.join(repoRoot, 'backend', 'src', 'app', 'services', 'runtime', 'runtimeJobsMutations.mjs');
const edgeMutationHandlersPath = path.join(repoRoot, 'supabase', 'functions', '_shared', 'routes', 'mutationHandlers.ts');

function assertContainsContiguousSequence(entries, expectedSequence) {
  const startIndex = entries.indexOf(expectedSequence[0]);
  assert.notEqual(startIndex, -1, `${expectedSequence[0]} should be present`);
  assert.deepEqual(entries.slice(startIndex, startIndex + expectedSequence.length), expectedSequence);
}

test('final work scope duplicate enablement migrations stay mirrored', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('final work scope duplicate enablement migration precedes box workflow follow-ups', async () => {
  const backendMigrations = (await readdir(migrationsPath)).filter((entry) => /^\d+_/.test(entry)).sort();
  const supabaseMigrations = (await readdir(supabaseMigrationsPath)).filter((entry) => /^\d+_/.test(entry)).sort();


  const expectedBackendTail = [
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
    '0163_phase_specific_allocation_schedule.sql',
  ];
  assertContainsContiguousSequence(backendMigrations, expectedBackendTail);
  const expectedSupabaseTail = [
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
    '20260617101000_phase_specific_allocation_schedule.sql',
  ];
  assertContainsContiguousSequence(supabaseMigrations, expectedSupabaseTail);

});

test('final uniqueness migration replaces only job-number uniqueness with work-scope uniqueness', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /group by org_id, job_number, work_scope_key\s+having count\(\*\) > 1/is);
  assert.match(migration, /work_scope_key is distinct from app_api\.normalize_job_work_scope_key\(sections\)/i);
  assert.match(migration, /array_agg\(a\.attname::text order by cols\.ordinality\)/);
  assert.match(migration, /\)\s*=\s*array\['org_id', 'job_number'\]::text\[\]/);
  assert.match(migration, /\)\s*=\s*array\['org_id', 'job_number', 'work_scope_key'\]::text\[\]/);
  assert.doesNotMatch(migration, /array_agg\(a\.attname order by cols\.ordinality\)/);
  assert.match(migration, /alter table app\.jobs drop constraint %I/i);
  assert.match(migration, /add constraint jobs_org_job_number_work_scope_key_unique\s+unique \(org_id, job_number, work_scope_key\)/i);
  assert.match(migration, /drop index if exists app\.idx_jobs_org_job_number_work_scope_key/i);
  assert.doesNotMatch(migration, /update\s+app\.jobs/i);
  assert.doesNotMatch(migration, /generated always as/i);
});

test('SQL create path allows different scopes and returns jobId for unambiguous reloads', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /v_work_scope_key text := app_api\.normalize_job_work_scope_key\(v_sections\);/);
  assert.match(migration, /and j\.work_scope_key = v_work_scope_key/);
  assert.match(migration, /when unique_violation then/);
  assert.match(migration, /jobs_org_job_number_work_scope_key_unique/);
  assert.match(migration, /'jobId', v_job\.id::text/);
  assert.match(migration, /jsonb_build_object\('jobIds', jsonb_build_array\(v_job_id\)\)/);
  assert.doesNotMatch(migration, /where j\.org_id = p_org_id\s+and j\.job_number = v_job_number\s+for update/is);
});

test('local and Edge create paths use exact-scope checks and jobId reloads', async () => {
  const [repository, runtimeMutations, edgeMutationHandlers] = await Promise.all([
    readFile(repositoryPath, 'utf8'),
    readFile(runtimeMutationsPath, 'utf8'),
    readFile(edgeMutationHandlersPath, 'utf8'),
  ]);

  assert.match(repository, /on conflict \(id\) do update set/);
  assert.doesNotMatch(repository, /on conflict \(org_id, job_number\)/);
  assert.match(runtimeMutations, /listJobsByNumber\(client, orgId, jobNumber\)/);
  assert.match(runtimeMutations, /duplicateResult\.exactScopeDuplicateExists/);
  assert.match(runtimeMutations, /buildJobDetailById\(client, orgId, nextHeader\.id\)/);
  assert.match(runtimeMutations, /error\.code === '23505'/);
  assert.match(edgeMutationHandlers, /duplicateResult\.exactScopeDuplicateExists/);
  assert.match(edgeMutationHandlers, /deps\.buildJobDetailById\(client, orgId, jobId\)/);
});

test('schema latest guard advances to final duplicate enablement', async () => {
  const schemaLatest = await readFile(schemaLatestPath, 'utf8');
  const requiredFunctionSemantics = schemaLatest.slice(
    schemaLatest.indexOf('const REQUIRED_FUNCTION_SEMANTICS = ['),
    schemaLatest.indexOf('const AUTHENTICATED_PUBLIC_RPC_ALLOWLIST = [')
  );



  assert.match(schemaLatest, /array_to_string\(array_agg\(a\.attname::text order by cols\.ordinality\), ','\)/);
  assert.doesNotMatch(schemaLatest, /array_agg\(a\.attname order by cols\.ordinality\)/);
  assert.match(schemaLatest, /columns: String\(row\.columns \|\| ''\)/);
  assert.doesNotMatch(schemaLatest, /Array\.isArray\(row\.columns\)/);
  assert.match(
    schemaLatest,
    /const hasTripletUnique = uniqueColumnSets\.some\(\(row\) => row\.columns === 'org_id,job_number,work_scope_key'\);/
  );
  assert.match(
    schemaLatest,
    /const hasLegacyJobNumberUnique = uniqueColumnSets\.some\(\(row\) => row\.columns === 'org_id,job_number'\);/
  );
  assert.match(schemaLatest, /unique\(org_id, job_number, work_scope_key\)/);
  assert.match(schemaLatest, /must not retain unique\(org_id, job_number\)/);
  assert.match(schemaLatest, /to_regclass\('app\.idx_jobs_org_job_number_work_scope_key'\) is not null as exists/);
  assert.match(schemaLatest, /idx_jobs_org_job_number_work_scope_key must be dropped after duplicate enablement/);
  assert.match(requiredFunctionSemantics, /on conflict \(id\) do update set/);
  assert.equal([...requiredFunctionSemantics.matchAll(/signature: 'app_api\.save_job\(app\.jobs\)'/g)].length, 1);
  assert.match(requiredFunctionSemantics, /coalesce\(p_job\.id, gen_random_uuid\(\)\)/);
  assert.match(requiredFunctionSemantics, /updated_by = excluded\.updated_by\\n  returning \* into v_row;/);
  assert.match(requiredFunctionSemantics, /'on conflict \(org_id, job_number\)'/);
  assert.match(
    requiredFunctionSemantics,
    /'where app\.jobs\.org_id = excluded\.org_id\\n    and app\.jobs\.job_number = excluded\.job_number'/
  );
  assert.doesNotMatch(requiredFunctionSemantics, /on conflict \(org_id, job_number\) do update set/);
  assert.doesNotMatch(schemaLatest, /idx_jobs_org_job_number_work_scope_key must remain non-unique/);
});
