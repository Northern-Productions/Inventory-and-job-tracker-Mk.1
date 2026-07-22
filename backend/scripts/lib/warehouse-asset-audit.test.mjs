import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  UNASSIGNED_OWNER_FILTER,
  WarehouseAssetAuditError,
  buildWarehouseAssetAuditReport,
  derivePhysicalFeetFromWeight,
} from '../../../shared/domain/warehouseAssetAudit.mjs';
import { requiresNoStoreResponse } from '../../../shared/domain/runtimeContract.mjs';
import { buildWarehouseAssetAuditFromDatabase } from '../../src/app/services/runtime/runtimeWarehouseAssetAudit.mjs';
import { shouldUseLocalFallbackRoute } from '../../src/routes/localFallbackRoutes.mjs';

const ORG_ID = '00000000-0000-4000-8000-000000000001';

function box(overrides = {}) {
  return {
    id: overrides.id || '10000000-0000-4000-8000-000000000001',
    org_id: ORG_ID,
    box_id: overrides.box_id || 'IL1-100',
    warehouse: 'IL1',
    owner_company_id: null,
    manufacturer: '3M Solar',
    film_name: 'Prestige 70',
    width_in: 60,
    initial_feet: 100,
    feet_available: 100,
    status: 'IN_STOCK',
    last_roll_weight_lbs: null,
    core_weight_lbs: null,
    lf_weight_lbs_per_ft: null,
    price_per_lf: null,
    purchase_cost: null,
    ...overrides,
  };
}

function baseInput(overrides = {}) {
  return {
    expectedOrgId: ORG_ID,
    organizationName: 'Test Organization',
    generatedAt: '2026-07-21T12:00:00.000Z',
    generatedBy: 'Test User',
    warehouses: [
      { org_id: ORG_ID, code: 'IL1', name: 'Wauconda IL1' },
      { org_id: ORG_ID, code: 'MS1', name: 'Ridgeland MS1' },
    ],
    owners: [
      {
        id: '20000000-0000-4000-8000-000000000001',
        org_id: ORG_ID,
        code: 'ALP',
        display_name: 'Alpha Holdings',
        is_active: true,
      },
    ],
    boxes: [box()],
    pendingTransfers: [],
    allocations: [],
    filters: {},
    ...overrides,
  };
}

test('warehouse asset audit keeps Unassigned visible and treats a zero direct price as known cost', () => {
  const report = buildWarehouseAssetAuditReport(baseInput({
    boxes: [box({ price_per_lf: '0.00' })],
  }));

  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].ownerCompanyLabel, 'Unassigned');
  assert.equal(report.rows[0].ownerCategory, 'UNASSIGNED');
  assert.equal(report.rows[0].costBasis, 'DIRECT_PRICE_PER_LF');
  assert.equal(report.rows[0].onHandAssetCostCents, '0');
  assert.deepEqual(report.filterOptions.owners, [
    { value: UNASSIGNED_OWNER_FILTER, label: 'Unassigned' },
  ]);
  assert.equal(report.totals.boxesMissingCostBasis, 0);
});

test('warehouse asset audit always offers the Unassigned owner filter', () => {
  const report = buildWarehouseAssetAuditReport(baseInput({
    boxes: [box({ owner_company_id: '20000000-0000-4000-8000-000000000001' })],
  }));

  assert(report.filterOptions.owners.some((entry) => (
    entry.value === UNASSIGNED_OWNER_FILTER && entry.label === 'Unassigned'
  )));
  const unassigned = buildWarehouseAssetAuditReport(baseInput({
    boxes: [box({ owner_company_id: '20000000-0000-4000-8000-000000000001' })],
    filters: { ownerCompanyId: UNASSIGNED_OWNER_FILTER },
  }));
  assert.equal(unassigned.rows.length, 0);
});

test('warehouse asset audit owner labels cannot change valuation, LF, status, or custody', () => {
  const ownerCompanyId = '20000000-0000-4000-8000-000000000001';
  const assignedBox = box({
    owner_company_id: ownerCompanyId,
    price_per_lf: '1.25',
    feet_available: 80,
  });
  const original = buildWarehouseAssetAuditReport(baseInput({
    boxes: [assignedBox],
    filters: { ownerCompanyId },
  }));
  const renamed = buildWarehouseAssetAuditReport(baseInput({
    owners: [{
      id: ownerCompanyId,
      org_id: ORG_ID,
      code: 'BET',
      display_name: 'Beta Holdings',
      is_active: true,
    }],
    boxes: [assignedBox],
    filters: { ownerCompanyId },
  }));

  assert.equal(original.rows[0].ownerCompanyLabel, 'ALP - Alpha Holdings');
  assert.equal(renamed.rows[0].ownerCompanyLabel, 'BET - Beta Holdings');
  assert.deepEqual(original.totals, renamed.totals);
  assert.deepEqual(
    {
      onHandLf: original.rows[0].onHandLf,
      status: original.rows[0].status,
      custodyBasis: original.rows[0].custodyBasis,
      costBasis: original.rows[0].costBasis,
      onHandAssetCostCents: original.rows[0].onHandAssetCostCents,
    },
    {
      onHandLf: renamed.rows[0].onHandLf,
      status: renamed.rows[0].status,
      custodyBasis: renamed.rows[0].custodyBasis,
      costBasis: renamed.rows[0].costBasis,
      onHandAssetCostCents: renamed.rows[0].onHandAssetCostCents,
    },
  );
});

test('warehouse asset audit sums full-precision derived costs before rounding the total', () => {
  const report = buildWarehouseAssetAuditReport(baseInput({
    boxes: [
      box({
        id: '10000000-0000-4000-8000-000000000001',
        box_id: 'IL1-101',
        initial_feet: 3,
        feet_available: 1,
        purchase_cost: '1.00',
      }),
      box({
        id: '10000000-0000-4000-8000-000000000002',
        box_id: 'IL1-102',
        initial_feet: 3,
        feet_available: 1,
        purchase_cost: '1.00',
      }),
      box({
        id: '10000000-0000-4000-8000-000000000003',
        box_id: 'IL1-103',
        initial_feet: 3,
        feet_available: 1,
      }),
    ],
  }));

  assert.deepEqual(report.rows.map((row) => row.costBasis), [
    'DERIVED_FROM_PURCHASE_COST',
    'DERIVED_FROM_PURCHASE_COST',
    'MISSING',
  ]);
  assert.deepEqual(report.rows.map((row) => row.onHandAssetCostCents), ['33', '33', null]);
  assert.equal(report.totals.totalKnownOnHandAssetCostCents, '67');
  assert.equal(report.totals.boxesMissingCostBasis, 1);
});

test('warehouse asset audit resolves canonical custody and physical LF for every operational state', () => {
  const transferBoxId = '10000000-0000-4000-8000-000000000003';
  const report = buildWarehouseAssetAuditReport(baseInput({
    boxes: [
      box({
        id: '10000000-0000-4000-8000-000000000001',
        box_id: 'IL1-201',
        feet_available: 80,
      }),
      box({
        id: '10000000-0000-4000-8000-000000000002',
        box_id: 'IL1-202',
        status: 'CHECKED_OUT',
        feet_available: 70,
      }),
      box({
        id: transferBoxId,
        box_id: 'IL1-203',
        status: 'TRANSFER',
        feet_available: 40,
      }),
    ],
    pendingTransfers: [{
      org_id: ORG_ID,
      box_record_id: transferBoxId,
      source_warehouse: 'IL1',
      destination_warehouse: 'MS1',
      status: 'PENDING',
    }],
    allocations: [
      {
        org_id: ORG_ID,
        allocation_id: 'A-1',
        box_id: 'IL1-201',
        allocated_feet: 20,
        allocation_kind: 'REQUIREMENT',
        requirement_id: 'R-1',
        job_id: 'J-1',
        status: 'ACTIVE',
      },
      {
        org_id: ORG_ID,
        allocation_id: 'A-2',
        box_id: 'IL1-202',
        allocated_feet: 20,
        allocation_kind: 'REQUIREMENT',
        requirement_id: 'R-2',
        job_id: 'J-2',
        status: 'ACTIVE',
      },
      {
        org_id: ORG_ID,
        allocation_id: 'A-3',
        box_id: 'IL1-203',
        allocated_feet: 10,
        allocation_kind: 'REQUIREMENT',
        requirement_id: 'R-3',
        job_id: 'J-3',
        status: 'ACTIVE',
      },
    ],
  }));

  const byId = new Map(report.rows.map((row) => [row.boxId, row]));
  assert.equal(byId.get('IL1-201').onHandLf, 100);
  assert.equal(byId.get('IL1-201').custodyBasis, 'CURRENT_WAREHOUSE');
  assert.equal(byId.get('IL1-202').onHandLf, 70);
  assert.equal(byId.get('IL1-202').custodyBasis, 'CHECKOUT_SOURCE');
  assert.equal(byId.get('IL1-203').onHandLf, 50);
  assert.equal(byId.get('IL1-203').warehouse, 'IL1');
  assert.equal(byId.get('IL1-203').pendingTransferDestination, 'MS1');
  assert.equal(byId.get('IL1-203').statusLabel, 'Pending Transfer to MS1');
});

test('warehouse asset audit fails closed for ambiguous or conflicting custody', () => {
  const transferBox = box({ status: 'TRANSFER' });
  const oneTransfer = {
    org_id: ORG_ID,
    box_record_id: transferBox.id,
    source_warehouse: 'IL1',
    destination_warehouse: 'MS1',
    status: 'PENDING',
  };

  assert.throws(
    () => buildWarehouseAssetAuditReport(baseInput({ boxes: [transferBox] })),
    /exactly one pending transfer/,
  );
  assert.throws(
    () => buildWarehouseAssetAuditReport(baseInput({
      boxes: [transferBox],
      pendingTransfers: [oneTransfer, { ...oneTransfer }],
    })),
    /multiple pending transfers/,
  );
  assert.throws(
    () => buildWarehouseAssetAuditReport(baseInput({
      boxes: [box({ status: 'CHECKED_OUT' })],
      pendingTransfers: [oneTransfer],
    })),
    /conflicting transfer and custody state/,
  );
  assert.throws(
    () => buildWarehouseAssetAuditReport(baseInput({
      boxes: [transferBox],
      pendingTransfers: [{ ...oneTransfer, source_warehouse: 'MS1' }],
    })),
    /ambiguous custody/,
  );
});

test('warehouse asset audit distinguishes legitimate missing owners from invalid owner references', () => {
  assert.doesNotThrow(() => buildWarehouseAssetAuditReport(baseInput({ boxes: [box({ owner_company_id: null })] })));
  assert.throws(
    () => buildWarehouseAssetAuditReport(baseInput({ boxes: [box({ owner_company_id: 'missing-owner' })] })),
    /dangling or outside the organization/,
  );
  assert.throws(
    () => buildWarehouseAssetAuditReport(baseInput({
      owners: [{
        id: 'other-owner',
        org_id: '00000000-0000-4000-8000-000000000099',
        code: 'OUT',
        display_name: 'Other Org',
      }],
      boxes: [box({ owner_company_id: 'other-owner' })],
    })),
    /organization scope is inconsistent/,
  );
});

test('warehouse asset audit fails closed when checked-out canonical LF is missing', () => {
  assert.throws(
    () => buildWarehouseAssetAuditReport(baseInput({
      boxes: [box({ status: 'CHECKED_OUT', feet_available: null })],
    })),
    /missing canonical on-hand LF/,
  );
});

test('weight-derived physical LF mirrors the canonical rounded and capped rule', () => {
  assert.equal(derivePhysicalFeetFromWeight({
    last_roll_weight_lbs: '12.345',
    core_weight_lbs: '2.00',
    lf_weight_lbs_per_ft: '0.10',
  }, 200), 103);
  assert.equal(derivePhysicalFeetFromWeight({
    last_roll_weight_lbs: '100.00',
    core_weight_lbs: '2.00',
    lf_weight_lbs_per_ft: '0.10',
  }, 100), 100);
  assert.equal(derivePhysicalFeetFromWeight({
    last_roll_weight_lbs: '1.00',
    core_weight_lbs: '2.00',
    lf_weight_lbs_per_ft: '0.10',
  }, 100), 0);
});

test('warehouse asset audit returns every matching row without a silent cap and filters Unassigned', () => {
  const boxes = Array.from({ length: 2505 }, (_, index) => box({
    id: `box-record-${String(index).padStart(4, '0')}`,
    box_id: `IL1-${String(index).padStart(4, '0')}`,
    owner_company_id: index % 2 === 0 ? null : '20000000-0000-4000-8000-000000000001',
    price_per_lf: '1.00',
  }));
  const allRows = buildWarehouseAssetAuditReport(baseInput({ boxes }));
  const unassignedRows = buildWarehouseAssetAuditReport(baseInput({
    boxes,
    filters: { ownerCompanyId: UNASSIGNED_OWNER_FILTER, warehouse: 'IL1' },
  }));

  assert.equal(allRows.rows.length, 2505);
  assert.equal(allRows.totals.matchingBoxes, 2505);
  assert.equal(new Set(allRows.rows.map((row) => row.boxId)).size, 2505);
  assert.equal(unassignedRows.rows.length, 1253);
  assert(unassignedRows.rows.every((row) => row.ownerCompanyLabel === 'Unassigned'));
});

test('local report reader uses read-only projections and PostgreSQL canonical physical LF', async () => {
  const statements = [];
  const report = await buildWarehouseAssetAuditFromDatabase(
    {},
    ORG_ID,
    { ownerCompanyId: UNASSIGNED_OWNER_FILTER },
    { generatedAt: '2026-07-21T12:00:00.000Z', generatedBy: 'Reader' },
    {
      queryRow: async (_client, sql) => {
        statements.push(sql);
        return { org_id: ORG_ID, name: 'Test Organization' };
      },
      queryRows: async (_client, sql) => {
        statements.push(sql);
        if (sql.includes('from app.warehouses')) {
          return [{ org_id: ORG_ID, code: 'IL1', name: 'Wauconda IL1' }];
        }
        if (sql.includes('from app.owner_companies')) return [];
        if (sql.includes('from app.boxes')) {
          return [box({ physical_feet_available: 44, feet_available: 1 })];
        }
        if (sql.includes('from app.box_transfers')) return [];
        throw new Error('Unexpected read');
      },
    },
  );

  assert.equal(report.rows[0].onHandLf, 44);
  assert(statements.some((sql) => sql.includes('app_api.box_physical_feet_available')));
  assert(statements.every((sql) => /^\s*select\b/i.test(sql)));
});

test('warehouse asset audit route is reports-read, local parity, and no-store', () => {
  assert.equal(shouldUseLocalFallbackRoute('GET', '/reports/warehouse-asset-audit'), true);
  assert.equal(requiresNoStoreResponse('GET', '/reports/warehouse-asset-audit'), true);
  assert.equal(requiresNoStoreResponse('POST', '/reports/warehouse-asset-audit'), false);
  assert.equal(requiresNoStoreResponse('GET', '/reports/summary'), false);
});

test('warehouse asset audit reports stable deterministic ordering', () => {
  const report = buildWarehouseAssetAuditReport(baseInput({
    boxes: [
      box({ id: '3', box_id: 'IL1-3', manufacturer: 'Zeta' }),
      box({ id: '2', box_id: 'IL1-2', manufacturer: 'Alpha', owner_company_id: '20000000-0000-4000-8000-000000000001' }),
      box({ id: '1', box_id: 'IL1-1', manufacturer: 'Alpha' }),
    ],
  }));
  assert.deepEqual(report.rows.map((row) => row.boxId), ['IL1-2', 'IL1-1', 'IL1-3']);
});

test('warehouse asset audit integrity errors carry safe status and category metadata', () => {
  assert.throws(
    () => buildWarehouseAssetAuditReport(baseInput({ filters: { warehouse: 'XX9' } })),
    (error) => {
      assert(error instanceof WarehouseAssetAuditError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'INVALID_FILTER');
      return true;
    },
  );
});

test('warehouse asset audit rejects missing tenant scope, duplicate box IDs, and dangling allocations', () => {
  assert.throws(
    () => buildWarehouseAssetAuditReport(baseInput({
      boxes: [box({ org_id: undefined })],
    })),
    /organization scope is inconsistent/,
  );
  assert.throws(
    () => buildWarehouseAssetAuditReport(baseInput({
      boxes: [
        box({ id: 'box-record-1', box_id: 'IL1-100' }),
        box({ id: 'box-record-2', box_id: 'il1-100' }),
      ],
    })),
    /business box identity is duplicated/,
  );
  assert.throws(
    () => buildWarehouseAssetAuditReport(baseInput({
      allocations: [{
        org_id: ORG_ID,
        allocation_id: 'allocation-1',
        box_id: 'IL1-MISSING',
        allocated_feet: 10,
        allocation_kind: 'REQUIREMENT',
        status: 'ACTIVE',
      }],
    })),
    /active allocation has a dangling box reference/,
  );
});

test('warehouse asset audit and label printing use isolated roots and named pages', async () => {
  const [styles, labelMaker] = await Promise.all([
    readFile(new URL('../../../frontend/src/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../../../frontend/src/features/inventory/pages/LabelMakerPage.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(styles, /@page label-page\s*\{[\s\S]*?size:\s*letter landscape;/);
  assert.match(styles, /@page warehouse-asset-audit-page\s*\{[\s\S]*?size:\s*letter landscape;/);
  assert.match(styles, /body\.label-printing \*/);
  assert.match(styles, /body\.warehouse-asset-audit-printing \.warehouse-asset-audit-worksheet/);
  assert.match(styles, /body\.warehouse-asset-audit-printing > \.label-print-only-root/);
  assert.match(labelMaker, /classList\.add\('label-printing'\)/);
  assert.match(labelMaker, /classList\.remove\('label-printing'\)/);
});
