import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const backendMigrationUrl = new URL('../../migrations/0199_film_order_receipt_history.sql', import.meta.url);
const supabaseMigrationUrl = new URL(
  '../../../supabase/migrations/20260813100000_film_order_receipt_history.sql',
  import.meta.url
);
const schemaCheckUrl = new URL('../check-schema-latest.mjs', import.meta.url);

test('migration 0199 remains byte-identical across backend and Supabase mirrors', async () => {
  const [backend, supabase] = await Promise.all([
    readFile(backendMigrationUrl, 'utf8'),
    readFile(supabaseMigrationUrl, 'utf8'),
  ]);
  assert.equal(supabase, backend);
});

test('migration 0199 adds one complete immutable receipt snapshot per Film Order link', async () => {
  const migration = await readFile(backendMigrationUrl, 'utf8');

  for (const field of [
    'receipt_contribution_feet',
    'receipt_source_width_in',
    'receipt_finalized_at',
    'receipt_finalized_by',
    'receipt_capture_source',
  ]) {
    assert.match(migration, new RegExp(`add column if not exists ${field}`));
  }
  assert.match(migration, /film_order_box_links_receipt_history_complete/);
  assert.match(migration, /guard_film_order_receipt_history_update/);
  assert.match(migration, /v_mode = 'FINALIZE'/);
  assert.match(migration, /v_mode = 'CORRECT'/);
  assert.match(migration, /may change only the historical receipt LF/);
  assert.match(migration, /receipt history cannot be supplied during link creation/);
});

test('migration 0199 backfills only one exact receipt transition and leaves ambiguity unresolved', async () => {
  const migration = await readFile(backendMigrationUrl, 'utf8');

  assert.match(migration, /audit_candidates as materialized/);
  assert.match(migration, /count\(\*\) over \(partition by l\.id\) as evidence_count/);
  assert.match(migration, /a\.evidence_count = 1/);
  assert.match(migration, /e\.receipt_feet is distinct from a\.receipt_feet/);
  assert.doesNotMatch(migration, /set\s+receipt_contribution_feet\s*=\s*(?:b\.)?initial_feet/i);
  assert.match(migration, /receipt_capture_source = evidence\.receipt_capture_source/);
});

test('migration 0199 ledger reads finalized snapshots and never live physical LF', async () => {
  const migration = await readFile(backendMigrationUrl, 'utf8');
  const ledger = migration.slice(
    migration.indexOf('create or replace function app_api.film_order_ledger_projection'),
    migration.indexOf('create or replace function app_api.recalculate_film_order')
  );

  assert.match(ledger, /film_order_link_covered_feet/);
  assert.match(ledger, /film_order_link_received_feet/);
  assert.match(ledger, /film-order-receipt-v1/);
  assert.match(ledger, /film-order-ledger-v2/);
  assert.doesNotMatch(ledger, /box_physical_feet_available/);
  assert.match(
    migration,
    /if position\('film_order_link_covered_feet' in v_ledger_def\) = 0\s+or position\('film_order_link_received_feet' in v_ledger_def\) = 0/
  );
});

test('migration 0199 finalizes from receipt-time Initial LF and preserves width', async () => {
  const migration = await readFile(backendMigrationUrl, 'utf8');
  const finalizer = migration.slice(
    migration.indexOf('create or replace function app_api.finalize_film_order_link_receipt'),
    migration.indexOf('create or replace function app_api.trg_film_order_events_for_links')
  );

  assert.match(finalizer, /receipt_contribution_feet = greatest\(coalesce\(v_box\.initial_feet, 0\), 0\)::integer/);
  assert.match(finalizer, /receipt_source_width_in = v_box\.width_in/);
  assert.match(finalizer, /FILM_ORDER_RECEIPT_FINALIZED/);
  assert.match(finalizer, /receipt_finalized_at = coalesce\(p_finalized_at, now\(\)\)/);
  assert.match(finalizer, /current_setting\('request\.jwt\.claim\.email', true\)/);
});

test('migration 0199 correction is feature-authorized, audited, tenant-scoped, and does not edit box LF', async () => {
  const migration = await readFile(backendMigrationUrl, 'utf8');
  const correction = migration.slice(
    migration.indexOf('create or replace function public.api_film_orders_correct_received_lf'),
    migration.indexOf('do $$\ndeclare\n  v_order record;')
  );

  assert.match(correction, /require_effective_feature_access\(p_org_id, 'film_orders', 'write'\)/);
  assert.match(correction, /l\.org_id = p_org_id/);
  assert.match(correction, /FILM_ORDER_RECEIPT_CORRECTED/);
  assert.match(correction, /receipt_contribution_feet = v_corrected_feet/);
  assert.match(correction, /v_reason/);
  assert.match(correction, /current_setting\('request\.jwt\.claim\.email', true\)/);
  assert.doesNotMatch(correction, /set\s+(?:initial_feet|feet_available)\s*=/i);
  assert.match(
    migration,
    /revoke execute on function public\.api_acl_film_orders_get\(uuid, text\) from public, anon;/
  );
});

test('migration 0199 preserves multiple correction history and fails closed on missing history', async () => {
  const migration = await readFile(backendMigrationUrl, 'utf8');

  assert.match(migration, /append_film_order_event/);
  assert.match(migration, /'FILM_ORDER_RECEIPT_CORRECTED'/);
  assert.match(migration, /v_before\.receipt_contribution_feet/);
  assert.match(migration, /v_after\.receipt_contribution_feet/);
  assert.match(migration, /if v_missing_receipt_history_count > 0 then\s+return v_existing;/);
});

test('latest schema guard verifies the receipt wrapper and its preserved pre-0199 detail contract separately', async () => {
  const schemaCheck = await readFile(schemaCheckUrl, 'utf8');

  assert.match(schemaCheck, /signature: 'public\.api_acl_film_orders_get\(uuid, text\)'[\s\S]*app_api\.api_acl_film_orders_get_pre_0199\(/);
  assert.match(schemaCheck, /signature: 'public\.api_acl_film_orders_get\(uuid, text\)'[\s\S]*'receiptContributionFeet', l\.receipt_contribution_feet/);
  assert.match(schemaCheck, /signature: 'app_api\.api_acl_film_orders_get_pre_0199\(uuid, text\)'[\s\S]*'sourceBoxId', v_order\.source_box_id/);
  assert.doesNotMatch(
    schemaCheck,
    /signature: 'app_api\.film_order_ledger_projection\(uuid, text\[\]\)'[\s\S]*?includes: \[[\s\S]*?'receipt_contribution_feet'/
  );
});
