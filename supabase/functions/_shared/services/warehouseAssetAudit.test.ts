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

    in(column: string, values: unknown[]) {
      this.filters.push([column, { values }]);
      return this;
    }

    is(column: string, value: null) {
      this.filters.push([column, { is: value }]);
      return this;
    }

    order(column: string) {
      this.orderColumn = column;
      return this;
    }

    filteredRows() {
      return (tableRows[this.table] || [])
        .filter((row) => this.filters.every(([column, value]) => {
          if (
            value &&
            typeof value === 'object' &&
            Array.isArray((value as { values?: unknown[] }).values)
          ) {
            return (value as { values: unknown[] }).values.includes(row[column]);
          }
          if (value && typeof value === 'object' && 'is' in value) {
            return row[column] === (value as { is: unknown }).is;
          }
          return row[column] === value;
        }))
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
const ADAPTER_PARITY_GOLDEN = '63aa2ff8dbbe3584ea23823357aa050e4b119fd4e5a5e23e52494c5a4bb8182f';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

async function canonicalHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (entry) => entry.toString(16).padStart(2, '0')).join('');
}

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

function checkedOutEdgeBox(index: number): Row {
  return {
    ...edgeBox(index),
    status: 'CHECKED_OUT',
    direct_to_job_site: false,
    last_checkout_job_id: 'job-1',
    last_checkout_job: 'IL1-1234',
    feet_available: 50,
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

Deno.test('Edge audit adapter uses a fixed logical read count for one or many checked-out boxes', async () => {
  const run = async (count: number) => {
    const logicalReads: string[] = [];
    const client = createFakeClient({
      organizations: [{ id: ORG_ID, name: 'Test Organization' }],
      warehouses: [{ id: 'warehouse-1', org_id: ORG_ID, code: 'IL1', name: 'Wauconda IL1' }],
      owner_companies: [],
      boxes: Array.from({ length: count }, (_, index) => checkedOutEdgeBox(index)),
      box_transfers: [],
      allocations: [],
      film_order_box_links: [],
      film_orders: [],
      jobs: [{
        id: 'job-1',
        org_id: ORG_ID,
        job_number: 'IL1-1234',
        warehouse: 'IL1',
        crew_leader: '',
      }],
      job_phases: [{
        id: 'phase-1',
        org_id: ORG_ID,
        job_id: 'job-1',
        phase_number: 1,
        install_date: '2026-07-21',
        crew_leader: '',
        labor_status: 'ACTIVE',
        workflow_status: 'ACTIVE',
        is_primary: true,
      }],
      job_requirements: [],
      job_caulk_requirements: [],
    });
    const report = await buildWarehouseAssetAuditFromEdge(
      client,
      ORG_ID,
      {},
      { generatedAt: '2026-07-21T12:00:00.000Z', generatedBy: 'Reader' },
      { onLogicalRead: (name) => logicalReads.push(name) },
    );
    return { logicalReads, report };
  };

  const zero = await run(0);
  const one = await run(1);
  const many = await run(30);
  assertEquals(zero.logicalReads.length, 6, 'Zero checked-out boxes use the base fast path.');
  assertEquals(one.logicalReads.length, 16, 'Checked-out context uses a fixed set of batched reads.');
  assertEquals(many.logicalReads, one.logicalReads, 'Read count and categories cannot grow with checked-out rows.');
  assertEquals(one.report.rows[0].checkedOutCrewLeaderName, null, 'Missing crew remains valid.');
  assertEquals(many.report.rows.length, 30, 'All checked-out boxes remain present.');
});

Deno.test('Edge audit adapter preserves legacy compatible-number crew fallback without per-row reads', async () => {
  const logicalReads: string[] = [];
  const client = createFakeClient({
    organizations: [{ id: ORG_ID, name: 'Test Organization' }],
    warehouses: [{ id: 'warehouse-1', org_id: ORG_ID, code: 'IL1', name: 'Wauconda IL1' }],
    owner_companies: [],
    boxes: [{
      ...checkedOutEdgeBox(1),
      last_checkout_job_id: null,
      last_checkout_job: '1234',
    }],
    box_transfers: [],
    allocations: [{
      id: 'legacy-allocation',
      org_id: ORG_ID,
      allocation_id: 'legacy-allocation',
      box_id: 'IL1-0001',
      allocated_feet: 1,
      allocation_kind: 'EXTRA',
      requirement_id: null,
      job_id: null,
      job_number: '1234',
      warehouse: 'IL1',
      crew_leader: 'Legacy Crew',
      status: 'CANCELLED',
      created_at: '2026-07-01T00:00:00Z',
    }],
    film_order_box_links: [],
    film_orders: [],
    jobs: [{
      id: 'job-1',
      org_id: ORG_ID,
      job_number: 'IL1-1234',
      warehouse: 'IL1',
      crew_leader: '',
    }],
    job_phases: [],
    job_requirements: [],
    job_caulk_requirements: [],
  });

  const report = await buildWarehouseAssetAuditFromEdge(
    client,
    ORG_ID,
    {},
    { generatedAt: '2026-07-21T12:00:00.000Z', generatedBy: 'Reader' },
    { onLogicalRead: (name) => logicalReads.push(name) },
  );

  assertEquals(
    report.rows[0].checkedOutCrewLeaderName,
    'Legacy Crew',
    'Compatible unprefixed legacy evidence must retain crew fallback.',
  );
  assertEquals(logicalReads.length, 16, 'Legacy fallback must use the fixed batched read set.');
});

Deno.test('Edge audit adapter matches the exact cross-runtime version-2 public golden', async () => {
  const client = createFakeClient({
    organizations: [{ id: ORG_ID, name: 'Test Organization' }],
    warehouses: [{ id: 'warehouse-1', org_id: ORG_ID, code: 'IL1', name: 'Wauconda IL1' }],
    owner_companies: [],
    boxes: [{
      id: '10000000-0000-4000-8000-000000000001',
      org_id: ORG_ID,
      box_id: 'IL1-100',
      warehouse: 'IL1',
      owner_company_id: null,
      manufacturer: '3M Solar',
      film_name: 'Prestige 70',
      width_in: 60,
      initial_feet: 100,
      feet_available: 50,
      status: 'CHECKED_OUT',
      direct_to_job_site: false,
      last_checkout_job_id: 'job-1',
      last_checkout_job: 'IL1-1234',
      last_roll_weight_lbs: null,
      core_weight_lbs: null,
      lf_weight_lbs_per_ft: null,
      price_per_lf: null,
      purchase_cost: null,
    }],
    box_transfers: [],
    allocations: [],
    film_order_box_links: [],
    film_orders: [],
    jobs: [{
      id: 'job-1',
      org_id: ORG_ID,
      job_number: 'IL1-1234',
      warehouse: 'IL1',
      crew_leader: 'Header Crew',
    }],
    job_phases: [{
      id: '40000000-0000-4000-8000-000000000001',
      org_id: ORG_ID,
      job_id: 'job-1',
      phase_number: 1,
      install_date: '2026-07-21',
      crew_leader: 'Phase Crew',
      labor_status: 'ACTIVE',
      workflow_status: 'ACTIVE',
      is_primary: true,
    }],
    job_requirements: [],
    job_caulk_requirements: [],
  });

  const report = await buildWarehouseAssetAuditFromEdge(
    client,
    ORG_ID,
    {},
    { generatedAt: '2026-07-21T12:00:00.000Z', generatedBy: 'Reader' },
  );

  assertEquals(
    await canonicalHash(report),
    ADAPTER_PARITY_GOLDEN,
    'Edge and local adapters must return the exact same canonical public response.',
  );
});

Deno.test('Edge generic pager terminates only after a short page', async () => {
  const client = createFakeClient({
    boxes: Array.from({ length: 4 }, (_, index) => edgeBox(index)),
  });
  const rows = await fetchAllRows(client, 'boxes', 'id, org_id', ORG_ID, { pageSize: 2 });
  assertEquals(rows.length, 4, 'Expected all rows.');
  assertEquals(client.calls.length, 3, 'An exact full final page requires one terminal empty read.');
});
