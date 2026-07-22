import { buildWarehouseAssetAuditFromEdge, fetchAllRows } from './warehouseAssetAudit.ts';
import { HttpError } from '../http.ts';

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`);
  }
}

type Row = Record<string, unknown>;

function createFakeClient(tableRows: Record<string, Row[]>, failTable = '') {
  const calls: Array<{ table: string; filters: Array<[string, unknown]>; from?: number; to?: number }> = [];
  class Query {
    table: string;
    filters: Array<[string, unknown]> = [];
    orderColumn = 'id';

    constructor(table: string) {
      this.table = table;
    }

    select(_columns: string) {
      return this;
    }

    eq(column: string, value: unknown) {
      this.filters.push([column, value]);
      return this;
    }

    order(column: string) {
      this.orderColumn = column;
      return this;
    }

    filteredRows() {
      return (tableRows[this.table] || [])
        .filter((row) => this.filters.every(([column, value]) => row[column] === value))
        .slice()
        .sort((left, right) => String(left[this.orderColumn] || '').localeCompare(String(right[this.orderColumn] || '')));
    }

    async range(from: number, to: number) {
      calls.push({ table: this.table, filters: [...this.filters], from, to });
      if (this.table === failTable) return { data: null, error: { message: 'sensitive failure' } };
      return { data: this.filteredRows().slice(from, to + 1), error: null };
    }

    async maybeSingle() {
      calls.push({ table: this.table, filters: [...this.filters] });
      if (this.table === failTable) return { data: null, error: { message: 'sensitive failure' } };
      const rows = this.filteredRows();
      return { data: rows.length === 1 ? rows[0] : null, error: rows.length > 1 ? {} : null };
    }
  }

  return {
    calls,
    schema(schema: string) {
      if (schema !== 'app') throw new Error('Expected app schema');
      return {
        from(table: string) {
          return new Query(table);
        },
      };
    },
  };
}

const ORG_ID = 'org-1';

function edgeBox(index: number): Row {
  return {
    id: `box-${String(index).padStart(4, '0')}`,
    org_id: ORG_ID,
    box_id: `IL1-${String(index).padStart(4, '0')}`,
    warehouse: 'IL1',
    owner_company_id: null,
    manufacturer: 'Maker',
    film_name: 'Film',
    width_in: 60,
    initial_feet: 100,
    feet_available: 100,
    status: 'IN_STOCK',
    last_roll_weight_lbs: null,
    core_weight_lbs: null,
    lf_weight_lbs_per_ft: null,
    price_per_lf: '1.00',
    purchase_cost: null,
  };
}

Deno.test('Edge warehouse asset audit pages all tenant rows without a silent cap', async () => {
  const client = createFakeClient({
    organizations: [{ id: ORG_ID, name: 'Test Organization' }],
    warehouses: [{ id: 'warehouse-1', org_id: ORG_ID, code: 'IL1', name: 'Wauconda IL1' }],
    owner_companies: [],
    boxes: Array.from({ length: 1005 }, (_, index) => edgeBox(index)),
    box_transfers: [],
    allocations: [],
  });

  const report = await buildWarehouseAssetAuditFromEdge(
    client,
    ORG_ID,
    {},
    { generatedAt: '2026-07-21T12:00:00.000Z', generatedBy: 'Reader' },
    { pageSize: 100 },
  );

  assertEquals(report.rows.length, 1005, 'Expected every box after the first PostgREST page.');
  assertEquals(report.totals.matchingBoxes, 1005, 'Totals must use the same complete row set.');
  assertEquals(new Set(report.rows.map((row: Row) => row.boxId)).size, 1005, 'Rows must be unique.');
  const boxCalls = client.calls.filter((call) => call.table === 'boxes');
  assertEquals(boxCalls.length, 11, 'Expected ten full pages and one terminal page.');
  assert(
    client.calls
      .filter((call) => call.table !== 'organizations')
      .every((call) => call.filters.some(([column, value]) => column === 'org_id' && value === ORG_ID)),
    'Every business-table read must be tenant scoped.',
  );
});

Deno.test('Edge warehouse asset audit mirrors stored allocation physical LF semantics', async () => {
  const rows = {
    organizations: [{ id: ORG_ID, name: 'Test Organization' }],
    warehouses: [{ id: 'warehouse-1', org_id: ORG_ID, code: 'IL1', name: 'Wauconda IL1' }],
    owner_companies: [],
    boxes: [{ ...edgeBox(1), feet_available: 75 }],
    box_transfers: [],
    allocations: [{
      id: 'allocation-1',
      org_id: ORG_ID,
      allocation_id: 'A-1',
      box_id: 'IL1-0001',
      allocated_feet: 25,
      allocation_kind: 'REQUIREMENT',
      requirement_id: 'requirement-1',
      job_id: 'job-1',
      job_number: '1',
      status: 'ACTIVE',
    }],
  };
  const report = await buildWarehouseAssetAuditFromEdge(createFakeClient(rows), ORG_ID);
  assertEquals(report.rows[0].onHandLf, 100, 'Stored allocation footprint should restore physical LF.');
});

Deno.test('Edge warehouse asset audit converts read failures to a generic safe error', async () => {
  const client = createFakeClient({
    organizations: [{ id: ORG_ID, name: 'Test Organization' }],
    warehouses: [],
    owner_companies: [],
    boxes: [],
    box_transfers: [],
    allocations: [],
  }, 'boxes');
  try {
    await buildWarehouseAssetAuditFromEdge(client, ORG_ID);
  } catch (error) {
    if (!(error instanceof HttpError)) {
      throw new Error('Expected a safe HTTP error.');
    }
    assertEquals(error.message, 'Unable to load warehouse asset audit data.', 'Expected generic read error.');
    assert(!error.message.includes('sensitive'), 'Database details must not escape.');
    return;
  }
  throw new Error('Expected Edge report read to fail.');
});

Deno.test('Edge generic pager terminates only after a short page', async () => {
  const client = createFakeClient({
    boxes: Array.from({ length: 4 }, (_, index) => edgeBox(index)),
  });
  const rows = await fetchAllRows(client, 'boxes', 'id, org_id', ORG_ID, { pageSize: 2 });
  assertEquals(rows.length, 4, 'Expected all rows.');
  assertEquals(client.calls.length, 3, 'An exact full final page requires one terminal empty read.');
});
