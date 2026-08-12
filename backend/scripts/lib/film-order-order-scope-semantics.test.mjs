import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { mapDbFilmOrderRow, toPublicFilmOrder } from '../../src/app/repositories/mappers.mjs';
import {
  buildCurrentFilmRequirementContext,
  getFilmOnTheWayFeetForRequirement,
} from '../../src/app/services/runtime/runtimeAllocationCoverage.mjs';

const backendMigrationUrl = new URL(
  '../../migrations/0197_film_order_order_scope_semantics.sql',
  import.meta.url,
);
const supabaseMigrationUrl = new URL(
  '../../../supabase/migrations/20260811100000_film_order_order_scope_semantics.sql',
  import.meta.url,
);

function buildLedgerRow(overrides = {}) {
  return {
    film_order_id: 'FO-1',
    requirement_id: 'requirement-1',
    job_number: '1001',
    warehouse: 'IL1',
    manufacturer: '3M',
    film_name: 'Example Film',
    width_in: 60,
    requested_feet: 12,
    linked_feet: 12,
    ordered_feet: 12,
    received_feet: 0,
    on_the_way_feet: 12,
    covered_feet: 0,
    remaining_to_order_feet: 0,
    order_overage_feet: 0,
    completed_feet: 0,
    status: 'FILM_ON_THE_WAY',
    stored_status: 'FILM_ON_THE_WAY',
    display_status: 'FILM_ON_THE_WAY',
    need_source: 'ORDER_REQUEST',
    needed_feet: 12,
    fulfilled_feet: 0,
    remaining_feet: 0,
    overage_feet: 0,
    order_ledger_version: 'film-order-ledger-v1',
    ...overrides,
  };
}

function mapLedger(overrides = {}, linkedBoxes = []) {
  return toPublicFilmOrder(mapDbFilmOrderRow(buildLedgerRow(overrides)), linkedBoxes);
}

test('0197 Film Order semantics migration mirrors stay byte-identical', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationUrl),
    readFile(supabaseMigrationUrl),
  ]);

  assert.deepEqual(supabaseMigration, backendMigration);
});

test('0197 centralizes order-scoped, width-adjusted ledger reads without requirement demand', async () => {
  const migration = await readFile(backendMigrationUrl, 'utf8');

  assert.match(migration, /create or replace function app_api\.film_order_ledger_projection\(/);
  assert.match(migration, /app_api\.compute_covered_feet_from_allocation\(/);
  assert.match(migration, /app_api\.box_physical_feet_available\(b\)/);
  assert.match(migration, /group by l\.film_order_id, \(so\.f\)\.width_in/);
  assert.match(migration, /greatest\(metrics\.requested_feet - metrics\.linked_feet, 0\)::integer as remaining_to_order_feet/);
  assert.match(migration, /greatest\(metrics\.linked_feet - metrics\.requested_feet, 0\)::integer as order_overage_feet/);
  assert.match(migration, /greatest\(metrics\.linked_feet - metrics\.received_feet, 0\)::integer as on_the_way_feet/);
  assert.match(migration, /'need_source', 'ORDER_REQUEST'/);
  assert.doesNotMatch(
    migration.match(/create or replace function app_api\.film_order_ledger_projection[\s\S]*?\$\$;/)?.[0] || '',
    /job_requirements|CURRENT_REQUIREMENT/,
  );
});

test('0197 shares the ledger across list, job, find, and detail reads', async () => {
  const migration = await readFile(backendMigrationUrl, 'utf8');

  for (const signature of [
    'public.api_list_film_orders',
    'public.api_list_film_orders_by_job',
    'public.api_list_film_orders_by_job_id',
    'public.api_find_film_order_by_id',
    'public.api_acl_film_orders_get',
  ]) {
    const definition = migration.match(
      new RegExp(`create or replace function ${signature.replaceAll('.', '\\.')}[\\s\\S]*?\\$\\$;`),
    )?.[0];
    assert.ok(definition, `${signature} definition is present`);
    assert.match(definition, /app_api\.film_order_ledger_projection\(/);
  }

  assert.match(migration, /'initialCost', b\.purchase_cost/);
  assert.match(migration, /'requirementContextStatus', v_requirement_context_status/);
});

test('0197 is forward-only projection DDL with narrow execute grants', async () => {
  const migration = await readFile(backendMigrationUrl, 'utf8');

  assert.doesNotMatch(migration, /\b(?:insert\s+into|update\s+app\.|delete\s+from|alter\s+table|create\s+(?:unique\s+)?index)\b/i);
  assert.match(
    migration,
    /revoke execute on function app_api\.film_order_ledger_projection\(uuid, text\[\]\) from public, anon, authenticated, service_role;/,
  );
  assert.match(
    migration,
    /revoke execute on function public\.api_acl_list_film_orders_by_job_id\(uuid, uuid\) from public, anon, service_role;/,
  );
  assert.match(
    migration,
    /grant execute on function public\.api_acl_list_film_orders_by_job_id\(uuid, uuid\) to authenticated;/,
  );
});

test('order ledger covers partial shortage, partial ordering, overage, and receipt transition', () => {
  const partialShortage = mapLedger();
  assert.deepEqual(
    {
      requested: partialShortage.requestedFeet,
      linked: partialShortage.linkedFeet,
      received: partialShortage.receivedFeet,
      covered: partialShortage.coveredFeet,
      remaining: partialShortage.remainingToOrderFeet,
      overage: partialShortage.orderOverageFeet,
      displayStatus: partialShortage.displayStatus,
    },
    {
      requested: 12,
      linked: 12,
      received: 0,
      covered: 0,
      remaining: 0,
      overage: 0,
      displayStatus: 'FILM_ON_THE_WAY',
    },
  );

  const partialOrder = mapLedger({
    linked_feet: 6,
    ordered_feet: 6,
    on_the_way_feet: 6,
    remaining_to_order_feet: 6,
    remaining_feet: 6,
    status: 'FILM_ORDER',
    stored_status: 'FILM_ORDER',
    display_status: 'FILM_ORDER',
  });
  assert.equal(partialOrder.remainingToOrderFeet, 6);
  assert.equal(partialOrder.displayStatus, 'FILM_ORDER');

  const overage = mapLedger({
    linked_feet: 15,
    ordered_feet: 15,
    on_the_way_feet: 15,
    order_overage_feet: 3,
    overage_feet: 3,
  });
  assert.equal(overage.remainingToOrderFeet, 0);
  assert.equal(overage.orderOverageFeet, 3);

  const received = mapLedger({
    received_feet: 12,
    on_the_way_feet: 0,
    completed_feet: 12,
    fulfilled_feet: 12,
    status: 'FULFILLED',
    stored_status: 'FULFILLED',
    display_status: 'FULFILLED_COVERED',
  });
  assert.equal(received.receivedFeet, 12);
  assert.equal(received.onTheWayFeet, 0);
  assert.equal(received.displayStatus, 'FULFILLED_COVERED');
});

test('legacy payloads derive multi-box received and on-way quantities without duplicating links', () => {
  const raw = mapDbFilmOrderRow(buildLedgerRow({
    linked_feet: undefined,
    received_feet: undefined,
    on_the_way_feet: undefined,
    order_overage_feet: undefined,
    completed_feet: undefined,
    order_ledger_version: undefined,
    ordered_feet: 12,
  }));
  const publicOrder = toPublicFilmOrder(raw, [
    { boxId: 'A', orderedFeet: 5, isReceived: true },
    { boxId: 'B', orderedFeet: 7, isReceived: false },
  ]);

  assert.equal(publicOrder.linkedFeet, 12);
  assert.equal(publicOrder.receivedFeet, 5);
  assert.equal(publicOrder.onTheWayFeet, 7);
  assert.equal(publicOrder.remainingToOrderFeet, 0);
});

test('manual fulfillment and cancellation retain explicit precedence', () => {
  const manual = mapLedger({
    linked_feet: 0,
    ordered_feet: 0,
    on_the_way_feet: 0,
    remaining_to_order_feet: 12,
    remaining_feet: 12,
    status: 'FULFILLED',
    stored_status: 'FULFILLED',
    display_status: 'MANUALLY_FULFILLED',
    manual_fulfilled_at: '2026-08-11T12:00:00Z',
  });
  assert.equal(manual.displayStatus, 'MANUALLY_FULFILLED');
  assert.equal(manual.requestedFeet, 12);

  const cancelled = mapLedger({
    status: 'CANCELLED',
    stored_status: 'CANCELLED',
    display_status: 'CANCELLED',
  });
  assert.equal(cancelled.displayStatus, 'CANCELLED');
});

test('current requirement context stays separate across edits and sequential orders', () => {
  const firstOrder = mapLedger();
  const secondOrder = mapLedger({
    film_order_id: 'FO-2',
    requested_feet: 8,
    linked_feet: 8,
    ordered_feet: 8,
    on_the_way_feet: 8,
    needed_feet: 8,
  });
  const requirement = {
    requirementId: 'requirement-1',
    manufacturer: '3M',
    filmName: 'Example Film',
    widthIn: 60,
    requiredFeet: 36,
    allocatedFeet: 24,
    remainingFeet: 12,
    status: 'ACTIVE',
  };

  assert.deepEqual(buildCurrentFilmRequirementContext(requirement, [firstOrder]), {
    requirementId: 'requirement-1',
    requiredFeet: 36,
    allocatedFeet: 24,
    onTheWayFeet: 12,
    stillShortFeet: 0,
    status: 'ACTIVE',
  });
  assert.equal(firstOrder.requestedFeet, 12);
  assert.equal(secondOrder.requestedFeet, 8);

  assert.equal(
    buildCurrentFilmRequirementContext(
      { ...requirement, requiredFeet: 50, remainingFeet: 26 },
      [firstOrder],
    ).stillShortFeet,
    14,
  );
  assert.equal(
    buildCurrentFilmRequirementContext(
      { ...requirement, requiredFeet: 30, remainingFeet: 6 },
      [firstOrder],
    ).stillShortFeet,
    0,
  );
});

test('on-way requirement coverage honors explicit partial orders and canonical width conversion', () => {
  const requirement = {
    requirementId: 'requirement-1',
    manufacturer: '3M',
    filmName: 'Example Film',
    widthIn: 60,
  };
  const partialOrder = mapLedger({
    width_in: 120,
    linked_feet: 6,
    ordered_feet: 6,
    on_the_way_feet: 6,
    remaining_to_order_feet: 6,
    status: 'FILM_ORDER',
    stored_status: 'FILM_ORDER',
    display_status: 'FILM_ORDER',
  });

  assert.equal(getFilmOnTheWayFeetForRequirement([partialOrder], requirement), 12);
  assert.equal(
    getFilmOnTheWayFeetForRequirement(
      [{ ...partialOrder, widthIn: 30, onTheWayFeet: 6 }],
      requirement,
    ),
    0,
  );
});
