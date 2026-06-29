import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0138_preserve_partial_box_update_physical_feet.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260520020000_preserve_partial_box_update_physical_feet.sql'
);
const migrationsPath = path.join(repoRoot, 'backend', 'migrations');
const supabaseMigrationsPath = path.join(repoRoot, 'supabase', 'migrations');
const schemaLatestPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');
const edgeMutationHandlersPath = path.join(repoRoot, 'supabase', 'functions', '_shared', 'routes', 'mutationHandlers.ts');
const runtimeCollectionsAndBoxesPath = path.join(
  repoRoot,
  'backend',
  'src',
  'app',
  'services',
  'runtime',
  'runtimeCollectionsAndBoxes.mjs'
);

function assertContainsContiguousSequence(entries, expectedSequence) {
  const startIndex = entries.indexOf(expectedSequence[0]);
  assert.notEqual(startIndex, -1, `${expectedSequence[0]} should be present`);
  assert.deepEqual(entries.slice(startIndex, startIndex + expectedSequence.length), expectedSequence);
}

test('box update partial receiving parity repair migrations stay mirrored', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('box update partial receiving parity repair precedes checkout and check-in follow-ups', async () => {
  const backendMigrations = (await readdir(migrationsPath)).filter((entry) => /^\d+_/.test(entry)).sort();
  const supabaseMigrations = (await readdir(supabaseMigrationsPath)).filter((entry) => /^\d+_/.test(entry)).sort();


  const expectedBackendTail = [
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

test('repair migration reasserts existing-box partial receiving metrics without app data updates', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const functionBody = migration.slice(
    migration.indexOf('create or replace function app_api.build_box_from_payload('),
    migration.indexOf('\nDO $$')
  );

  assert.match(migration, /create or replace function app_api\.build_box_from_payload\(/);
  assert.match(functionBody, /v_use_partial_receiving_metrics boolean := false;/);
  assert.match(functionBody, /if not v_has_full_receiving_metrics and p_existing_box_id is not null then/);
  assert.match(functionBody, /v_use_partial_receiving_metrics := true;/);
  assert.match(functionBody, /app_api\.physical_film_commitment_feet_for_box\(/);
  assert.match(functionBody, /coalesce\(v_existing\.feet_available, v_feet_available\)/);
  assert.doesNotMatch(functionBody, /if v_initial_weight_input is null and v_existing\.initial_weight_lbs is null then/);
  assert.doesNotMatch(
    functionBody,
    /v_feet_available := app_api\.clamp_feet_to_initial_range\(v_feet_available, v_initial_feet\);/
  );
  assert.match(migration, /missing existing-box partial receiving metrics branch/);
  assert.match(migration, /stale first-save InitialWeightLbs guard/);
  assert.match(migration, /does not preserve existing physical feet for partial receiving updates/);
  assert.match(migration, /still overwrites partial receiving physical feet from payload feetAvailable/);
  assert.doesNotMatch(migration, /\bupdate\s+app\./i);
  assert.doesNotMatch(migration, /\binsert\s+into\s+app\./i);
  assert.doesNotMatch(migration, /\bdelete\s+from\s+app\./i);
});

test('schema latest guard catches stale box update partial receiving function drift', async () => {
  const schemaLatest = await readFile(schemaLatestPath, 'utf8');
  const requiredFunctionSemantics = schemaLatest.slice(
    schemaLatest.indexOf('const REQUIRED_FUNCTION_SEMANTICS = ['),
    schemaLatest.indexOf('const AUTHENTICATED_PUBLIC_RPC_ALLOWLIST = [')
  );


  assert.match(schemaLatest, /const LATEST_MIGRATION = '0175_caulk_cancel_return_owner_resolution\.sql';/);

  assert.match(requiredFunctionSemantics, /signature: 'app_api\.build_box_from_payload\(uuid, jsonb, text\)'/);
  assert.match(requiredFunctionSemantics, /v_use_partial_receiving_metrics boolean := false;/);
  assert.match(
    requiredFunctionSemantics,
    /if not v_has_full_receiving_metrics and p_existing_box_id is not null then/
  );
  assert.match(requiredFunctionSemantics, /v_use_partial_receiving_metrics := true;/);
  assert.match(requiredFunctionSemantics, /v_active_allocated_feet := app_api\.physical_film_commitment_feet_for_box\(/);
  assert.match(requiredFunctionSemantics, /coalesce\(v_existing\.feet_available, v_feet_available\)/);
  assert.match(
    requiredFunctionSemantics,
    /'if v_initial_weight_input is null and v_existing\.initial_weight_lbs is null then'/
  );
  assert.match(
    requiredFunctionSemantics,
    /'v_feet_available := app_api\.clamp_feet_to_initial_range\(v_feet_available, v_initial_feet\);'/
  );
});

test('Edge boxes update route still targets the SQL ACL wrapper', async () => {
  const edgeMutationHandlers = await readFile(edgeMutationHandlersPath, 'utf8');

  assert.match(edgeMutationHandlers, /"\/boxes\/update": async/);
  assert.match(edgeMutationHandlers, /callMutationRpc\(client, "api_acl_boxes_update", orgId, actor, normalizedPayload\)/);
});

test('local runtime partial receiving update preserves stored physical feet without explicit current feet', async () => {
  const runtimeCollectionsAndBoxes = await readFile(runtimeCollectionsAndBoxesPath, 'utf8');

  assert.match(
    runtimeCollectionsAndBoxes,
    /feetAvailable = clampFeetToInitialRange\(existingBox\?\.feetAvailable \?\? feetAvailable, initialFeet\);/
  );
  assert.doesNotMatch(
    runtimeCollectionsAndBoxes,
    /feetAvailable = clampFeetToInitialRange\(feetAvailable, initialFeet\);/
  );
});
