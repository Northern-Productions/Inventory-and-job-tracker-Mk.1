import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const backendMigrationUrl = new URL(
  '../../migrations/0205_weight_authoritative_box_checkin.sql',
  import.meta.url
);
const supabaseMigrationUrl = new URL(
  '../../../supabase/migrations/20260824100000_weight_authoritative_box_checkin.sql',
  import.meta.url
);
const runtimePlannerUrl = new URL(
  '../../src/app/services/runtime/runtimeBoxCheckin.mjs',
  import.meta.url
);
const statusTransitionsUrl = new URL(
  '../../src/app/services/runtime/boxes/statusTransitions.mjs',
  import.meta.url
);
const receiveOrderedUrl = new URL(
  '../../src/app/services/runtime/boxes/receiveOrdered.mjs',
  import.meta.url
);
const frontendCheckinUrl = new URL(
  '../../../frontend/src/features/inventory/utils/box/boxCheckin.ts',
  import.meta.url
);
const frontendDialogUrl = new URL(
  '../../../frontend/src/features/inventory/components/FilmCheckinDialog.tsx',
  import.meta.url
);

test('0205 migration is byte-identical across canonical mirrors', async () => {
  const [backendBytes, supabaseBytes] = await Promise.all([
    fs.readFile(backendMigrationUrl),
    fs.readFile(supabaseMigrationUrl),
  ]);

  assert.deepEqual(supabaseBytes, backendBytes);
});

test('0205 resolves calibration in the approved precedence and keeps the helper private', async () => {
  const migration = await fs.readFile(backendMigrationUrl, 'utf8');

  const saved = migration.indexOf("'source', 'SAVED_BOX'");
  const initial = migration.indexOf("'source', 'BOX_INITIAL_BASELINE'");
  const catalog = migration.indexOf("'source', 'FILM_CATALOG'");
  const unresolved = migration.indexOf("'source', 'UNRESOLVED'");

  assert.ok(saved >= 0 && saved < initial && initial < catalog && catalog < unresolved);
  assert.match(
    migration,
    /app_api\.try_derive_lf_weight_lbs_per_ft\(\s*p_box\.initial_weight_lbs,\s*v_core_weight,\s*p_box\.width_in,\s*p_box\.initial_feet/s
  );
  assert.match(
    migration,
    /from app\.film_catalog c\s+where c\.org_id = p_org_id\s+and c\.film_key = p_box\.film_key/s
  );
  assert.match(
    migration,
    /revoke execute on function app_api\.resolve_box_weight_calibration\(uuid, app\.boxes\)\s+from public, anon, authenticated, service_role/
  );
  assert.match(migration, /WEIGHT_AUTHORITATIVE_CALIBRATION_HELPER_EXPOSED/);
});

test('0205 makes returned weight authoritative while preserving reconciliation and the 0191 lock wrapper', async () => {
  const migration = await fs.readFile(backendMigrationUrl, 'utf8');

  assert.match(
    migration,
    /v_resolution := app_api\.resolve_box_weight_calibration\(p_org_id, v_existing\)/
  );
  assert.match(
    migration,
    /v_physical_feet_after := app_api\.derive_feet_available_from_roll_weight\(\s*v_last_roll_weight,\s*v_resolved_core_weight,\s*v_resolved_lf_weight,\s*v_existing\.initial_feet/s
  );
  assert.match(
    migration,
    /Legacy currentFeetOnRoll and coreType payload values are intentionally ignored/
  );
  assert.match(
    migration,
    /position\('p_payload->>''currentFeetOnRoll''' in v_def\) > 0/
  );
  assert.match(
    migration,
    /v_reconciliation_result := app_api\.reconcile_box_checkin_allocations/
  );
  assert.match(migration, /app_api\.append_roll_history/);
  assert.match(migration, /app_api\.lock_film_material_flow\(\)/);
  assert.match(migration, /app_api\.api_acl_boxes_set_status_pre_0191/);
  assert.match(
    migration,
    /This box is missing the roll-weight calibration needed to calculate remaining LF/
  );
});

test('0205 persists ordered-receive calibration without replacing receipt behavior', async () => {
  const migration = await fs.readFile(backendMigrationUrl, 'utf8');

  assert.match(
    migration,
    /v_receipt_result := app_api\.resolve_box_weight_calibration\(p_org_id, v_box\)/
  );
  assert.match(
    migration,
    /v_box\.lf_weight_lbs_per_ft := nullif\(v_receipt_result->>'lfWeightLbsPerFt', ''\)::numeric/
  );
  assert.match(
    migration,
    /app_api\.process_linked_box_receipt\(p_org_id, v_box, p_actor\)/
  );
  assert.match(
    migration,
    /app_api\.reconcile_box_checkin_allocations/
  );
});

test('local runtime and shared dialog use the same weight-only contract', async () => {
  const [planner, statusTransitions, receiveOrdered, frontendCheckin, frontendDialog] =
    await Promise.all([
      fs.readFile(runtimePlannerUrl, 'utf8'),
      fs.readFile(statusTransitionsUrl, 'utf8'),
      fs.readFile(receiveOrderedUrl, 'utf8'),
      fs.readFile(frontendCheckinUrl, 'utf8'),
      fs.readFile(frontendDialogUrl, 'utf8'),
    ]);

  assert.doesNotMatch(planner, /payload\.currentFeetOnRoll/);
  assert.doesNotMatch(planner, /payload\.coreType/);
  assert.match(planner, /resolveBoxWeightCalibration/);
  assert.match(statusTransitions, /await findFilmCatalogByFilmKey/);
  assert.match(receiveOrdered, /updatedBox\.lfWeightLbsPerFt = calibration\.lfWeightLbsPerFt/);
  assert.doesNotMatch(frontendCheckin, /payload\.currentFeetOnRoll/);
  assert.doesNotMatch(frontendCheckin, /payload\.coreType/);
  assert.match(frontendDialog, /label="Returned Roll Weight \(lbs\)"/);
  assert.doesNotMatch(frontendDialog, /label=.*Current Linear Feet/);
  assert.doesNotMatch(frontendDialog, /label=.*Core Type/);
});
