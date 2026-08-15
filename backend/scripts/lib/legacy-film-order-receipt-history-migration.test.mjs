import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { mapDbFilmOrderRow, toPublicFilmOrder } from '../../src/app/repositories/mappers.mjs';

const backendMigrationUrl = new URL('../../migrations/0200_legacy_film_order_receipt_history.sql', import.meta.url);
const supabaseMigrationUrl = new URL(
  '../../../supabase/migrations/20260814100000_legacy_film_order_receipt_history.sql',
  import.meta.url
);
const schemaCheckUrl = new URL('../check-schema-latest.mjs', import.meta.url);
const receiptMigrationUrl = new URL('../../migrations/0199_film_order_receipt_history.sql', import.meta.url);
const runtimePlanningUrl = new URL('../../src/app/services/runtime/runtimeAllocationPlanning.mjs', import.meta.url);
const edgeHandlerUrl = new URL('../../../supabase/functions/_shared/api-handler.ts', import.meta.url);

test('migration 0200 remains byte-identical across backend and Supabase mirrors', async () => {
  const [backend, supabase] = await Promise.all([
    readFile(backendMigrationUrl, 'utf8'),
    readFile(supabaseMigrationUrl, 'utf8'),
  ]);
  assert.equal(supabase, backend);
});

test('migration 0200 keeps missing receipt values unknown and never substitutes current box LF', async () => {
  const migration = await readFile(backendMigrationUrl, 'utf8');
  const linkedHelper = migration.slice(
    migration.indexOf('create or replace function app_api.film_order_link_covered_feet'),
    migration.indexOf('create or replace function app_api.film_order_link_received_feet')
  );
  const receivedHelper = migration.slice(
    migration.indexOf('create or replace function app_api.film_order_link_received_feet'),
    migration.indexOf('create or replace function app_api.film_order_ledger_projection')
  );

  assert.match(linkedHelper, /when 'PENDING'/);
  assert.match(linkedHelper, /else null/);
  assert.match(receivedHelper, /when 'PENDING' then 0/);
  assert.match(receivedHelper, /else null/);
  assert.doesNotMatch(`${linkedHelper}\n${receivedHelper}`, /box_physical_feet_available/);
});

test('migration 0200 preserves the stored legacy aggregate while receipt history is incomplete', async () => {
  const migration = await readFile(backendMigrationUrl, 'utf8');
  const ledger = migration.slice(
    migration.indexOf('create or replace function app_api.film_order_ledger_projection'),
    migration.indexOf('create or replace function public.api_acl_film_orders_get')
  );

  assert.match(ledger, /when raw_metrics\.missing_receipt_history_count > 0/);
  assert.match(ledger, /coalesce\(\(raw_metrics\.order_row\)\.ordered_feet, 0\)/);
  assert.match(ledger, /coalesce\(\(raw_metrics\.order_row\)\.remaining_to_order_feet, 0\)/);
  assert.match(ledger, /'STORED_LEGACY_AGGREGATE'/);
  assert.match(ledger, /'film-order-receipt-v2'/);
  assert.doesNotMatch(ledger, /box_physical_feet_available/);
});

test('migration 0200 permits only an authorized audited correction to establish missing history', async () => {
  const migration = await readFile(backendMigrationUrl, 'utf8');
  const correction = migration.slice(
    migration.indexOf('create or replace function public.api_film_orders_correct_received_lf'),
    migration.indexOf('do $$\ndeclare\n  v_linked_def text;')
  );

  assert.match(migration, /receipt_capture_source in \('LIVE_RECEIPT', 'AUDIT_BACKFILL', 'MANUAL_CORRECTION'\)/);
  assert.match(migration, /new\.receipt_capture_source <> 'MANUAL_CORRECTION'/);
  assert.match(correction, /v_establishing_legacy_snapshot/);
  assert.match(correction, /receipt_contribution_feet = v_corrected_feet/);
  assert.match(correction, /receipt_source_width_in = v_box\.width_in/);
  assert.match(correction, /receipt_capture_source = 'MANUAL_CORRECTION'/);
  assert.match(correction, /'FILM_ORDER_RECEIPT_CORRECTED'/);
  assert.match(correction, /v_reason/);
  assert.doesNotMatch(correction, /receipt_contribution_feet\s*=\s*(?:coalesce\()?v_box\.initial_feet/);
  assert.doesNotMatch(correction, /set\s+(?:initial_feet|feet_available)\s*=/i);
  assert.match(
    migration,
    /revoke execute on function public\.api_film_orders_correct_received_lf\(uuid, text, jsonb\) from public, anon, authenticated;/
  );
  assert.doesNotMatch(
    migration,
    /grant_execute_if_exists\('public\.api_film_orders_correct_received_lf\(uuid, text, jsonb\)', 'authenticated'\)/
  );
});

test('migration 0200 changes no ambiguous receipt row during migration and keeps box edits outside receipt authority', async () => {
  const migration = await readFile(backendMigrationUrl, 'utf8');
  const beforeCorrection = migration.slice(0, migration.indexOf('create or replace function public.api_film_orders_correct_received_lf'));

  assert.doesNotMatch(beforeCorrection, /update\s+app\.film_order_box_links/i);
  assert.doesNotMatch(beforeCorrection, /update\s+app\.film_orders/i);
  assert.match(migration, /v_mode = 'FINALIZE'/);
  assert.match(migration, /v_mode = 'CORRECT'/);
  assert.match(migration, /Film Order receipt history can change only through finalization or audited correction/);
});

test('latest schema guard requires the v2 legacy aggregate and manual-correction contracts', async () => {
  const schemaCheck = await readFile(schemaCheckUrl, 'utf8');

  assert.match(schemaCheck, /const LATEST_MIGRATION = '0202_extra_allocation_capacity\.sql'/);
  assert.match(schemaCheck, /signature: 'app_api\.film_order_link_received_feet[\s\S]*?'else null'/);
  assert.match(schemaCheck, /signature: 'app_api\.film_order_ledger_projection[\s\S]*?'STORED_LEGACY_AGGREGATE'/);
  assert.match(schemaCheck, /signature: 'public\.api_film_orders_correct_received_lf[\s\S]*?'MANUAL_CORRECTION'/);
});

test('incomplete history preserves canonical stored totals and never derives a zero from the missing link', () => {
  const entry = mapDbFilmOrderRow({
    film_order_id: 'legacy-order',
    job_number: 'legacy-job',
    warehouse: 'IL1',
    manufacturer: 'Example',
    film_name: 'Legacy Film',
    width_in: 60,
    requested_feet: 80,
    linked_feet: 85,
    ordered_feet: 85,
    received_feet: 85,
    on_the_way_feet: 0,
    covered_feet: 25,
    remaining_to_order_feet: 0,
    order_overage_feet: 5,
    completed_feet: 85,
    status: 'FULFILLED',
    stored_status: 'FULFILLED',
    display_status: 'FULFILLED_COVERED',
    order_ledger_version: 'film-order-ledger-v2',
    receipt_ledger_version: 'film-order-receipt-v2',
    receipt_history_complete: false,
    receipt_history_missing_count: 1,
    receipt_totals_source: 'STORED_LEGACY_AGGREGATE',
  });
  const publicOrder = toPublicFilmOrder(entry, [
    {
      boxId: 'legacy-box',
      orderedFeet: 5,
      linkedFeet: null,
      receivedFeet: null,
      onTheWayFeet: null,
      receiptHistoryStatus: 'MISSING',
      isReceived: false,
    },
  ]);

  assert.deepEqual(
    {
      linkedFeet: publicOrder.linkedFeet,
      receivedFeet: publicOrder.receivedFeet,
      onTheWayFeet: publicOrder.onTheWayFeet,
      remainingToOrderFeet: publicOrder.remainingToOrderFeet,
      orderOverageFeet: publicOrder.orderOverageFeet,
      completedFeet: publicOrder.completedFeet,
      displayStatus: publicOrder.displayStatus,
      receiptHistoryComplete: publicOrder.receiptHistoryComplete,
      receiptTotalsSource: publicOrder.receiptTotalsSource,
    },
    {
      linkedFeet: 85,
      receivedFeet: 85,
      onTheWayFeet: 0,
      remainingToOrderFeet: 0,
      orderOverageFeet: 5,
      completedFeet: 85,
      displayStatus: 'FULFILLED_COVERED',
      receiptHistoryComplete: false,
      receiptTotalsSource: 'STORED_LEGACY_AGGREGATE',
    }
  );
});

test('an incomplete nonfulfilled aggregate remains unknown rather than becoming numeric zero', () => {
  const entry = mapDbFilmOrderRow({
    film_order_id: 'legacy-open-order',
    job_number: 'legacy-job',
    warehouse: 'IL1',
    manufacturer: 'Example',
    film_name: 'Legacy Film',
    width_in: 60,
    requested_feet: 80,
    linked_feet: 80,
    ordered_feet: 80,
    received_feet: null,
    on_the_way_feet: null,
    covered_feet: 0,
    remaining_to_order_feet: 0,
    order_overage_feet: 0,
    completed_feet: 0,
    status: 'FILM_ON_THE_WAY',
    stored_status: 'FILM_ON_THE_WAY',
    display_status: 'FILM_ON_THE_WAY',
    order_ledger_version: 'film-order-ledger-v2',
    receipt_ledger_version: 'film-order-receipt-v2',
    receipt_history_complete: false,
    receipt_history_missing_count: 1,
    receipt_totals_source: 'STORED_LEGACY_AGGREGATE',
  });
  const publicOrder = toPublicFilmOrder(entry, []);

  assert.equal(publicOrder.receivedFeet, null);
  assert.equal(publicOrder.onTheWayFeet, null);
  assert.equal(publicOrder.status, 'FILM_ON_THE_WAY');
  assert.equal(publicOrder.displayStatus, 'FILM_ON_THE_WAY');
});

test('all recalculation paths preserve an incomplete historical order before status persistence', async () => {
  const [receiptMigration, runtimePlanning, edgeHandler] = await Promise.all([
    readFile(receiptMigrationUrl, 'utf8'),
    readFile(runtimePlanningUrl, 'utf8'),
    readFile(edgeHandlerUrl, 'utf8'),
  ]);
  const sqlRecalculation = receiptMigration.slice(
    receiptMigration.indexOf('create or replace function app_api.recalculate_film_order'),
    receiptMigration.indexOf('do $$\nbegin\n  if to_regprocedure')
  );
  const runtimeRecalculation = runtimePlanning.slice(
    runtimePlanning.indexOf('async function recalculateFilmOrder('),
    runtimePlanning.indexOf('async function createFilmOrderForShortage(')
  );
  const edgeRecalculation = edgeHandler.slice(
    edgeHandler.indexOf('async function recalculateFilmOrderAfterAllocationMutation('),
    edgeHandler.indexOf('async function removeJobBoxAllocation(')
  );

  const sqlGuard = sqlRecalculation.indexOf('if v_missing_receipt_history_count > 0 then');
  const sqlSave = sqlRecalculation.indexOf('return app_api.save_film_order(v_existing)');
  assert.ok(sqlGuard >= 0 && sqlSave > sqlGuard, 'SQL status persistence must remain after the missing-history guard.');

  const runtimeGuard = runtimeRecalculation.indexOf('if (!linkedBoxSummary.receiptHistoryComplete)');
  const runtimeSave = runtimeRecalculation.indexOf('return saveFilmOrderRecord(');
  assert.ok(runtimeGuard >= 0 && runtimeSave > runtimeGuard, 'Backend status persistence must remain after the guard.');

  const edgeGuard = edgeRecalculation.indexOf('if (!linkedBoxSummary.receiptHistoryComplete)');
  const edgeSave = edgeRecalculation.indexOf('.update({');
  assert.ok(edgeGuard >= 0 && edgeSave > edgeGuard, 'Edge status persistence must remain after the guard.');
});

test('ordinary post-receipt box edits cannot populate or overwrite an ambiguous snapshot', async () => {
  const receiptMigration = await readFile(receiptMigrationUrl, 'utf8');
  const linkedBoxTrigger = receiptMigration.slice(
    receiptMigration.indexOf('create or replace function app_api.trg_film_order_events_for_linked_boxes'),
    receiptMigration.indexOf('create or replace function app_api.film_order_ledger_projection')
  );
  const initialEditBlock = linkedBoxTrigger.slice(
    linkedBoxTrigger.indexOf('if old.initial_feet is distinct from new.initial_feet'),
    linkedBoxTrigger.indexOf('if (old.received_date is distinct from new.received_date')
  );
  const guard = await readFile(backendMigrationUrl, 'utf8');

  assert.match(linkedBoxTrigger, /old\.initial_feet is distinct from new\.initial_feet[\s\S]*?LINKED_BOX_INITIAL_FEET_CHANGED/);
  assert.match(
    linkedBoxTrigger,
    /old\.received_date is null or upper\(coalesce\(old\.status::text, ''\)\) = 'ORDERED'/
  );
  assert.doesNotMatch(initialEditBlock, /finalize_film_order_link_receipt/);
  assert.match(guard, /Film Order receipt history can change only through finalization or audited correction/);
});
