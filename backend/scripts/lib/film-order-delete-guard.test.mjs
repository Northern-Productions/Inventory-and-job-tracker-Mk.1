import test from 'node:test';
import assert from 'node:assert/strict';

import { cancelFilmOrderAndReleaseAllocations } from '../../src/app/services/runtime/runtimeAllocationCleanup.mjs';

function buildFilmOrderRow(overrides = {}) {
  return {
    id: 'film-order-row-1',
    org_id: 'org-1',
    film_order_id: 'FO-1',
    job_id: 'job-1',
    job_number: '19413',
    warehouse: 'IL1',
    manufacturer: '3M Solar',
    film_name: 'Prestige 40',
    width_in: 48,
    requested_feet: 40,
    covered_feet: 0,
    ordered_feet: 0,
    remaining_to_order_feet: 40,
    job_date: '2026-04-24',
    crew_leader: 'Crew',
    status: 'FILM_ORDER',
    source_box_id: '',
    resolved_at: null,
    resolved_by: '',
    notes: '',
    created_at: '2026-04-20T10:00:00Z',
    created_by: 'tester',
    ...overrides,
  };
}

function buildAllocationRow(overrides = {}) {
  return {
    id: 'allocation-row-1',
    org_id: 'org-1',
    allocation_id: 'alloc-1',
    box_id: 'IL1-BOX',
    job_id: 'job-1',
    job_number: '19413',
    warehouse: 'IL1',
    job_date: null,
    allocated_feet: 10,
    covered_feet: 10,
    requirement_id: 'req-1',
    allocation_kind: 'REQUIREMENT',
    allocation_source: 'FILM_ORDER_RECEIPT',
    status: 'ACTIVE',
    created_at: '2026-04-20T10:00:00Z',
    created_by: 'tester',
    resolved_at: null,
    resolved_by: '',
    notes: '',
    crew_leader: '',
    film_order_id: 'FO-1',
    ...overrides,
  };
}

function buildFilmOrderLinkRow(overrides = {}) {
  return {
    id: 'film-order-link-row-1',
    org_id: 'org-1',
    link_id: 'link-1',
    film_order_id: 'FO-1',
    box_id: 'IL1-ORDERED',
    ordered_feet: 40,
    auto_allocated_feet: 0,
    created_at: '2026-04-20T10:00:00Z',
    created_by: 'tester',
    ...overrides,
  };
}

function createFilmOrderDeleteClient({
  filmOrder = buildFilmOrderRow(),
  allocations = [],
  links = [],
} = {}) {
  const state = {
    deletedFilmOrderIds: [],
    deletedLinkFilmOrderIds: [],
    calls: [],
  };

  return {
    state,
    async query(text, params = []) {
      const sql = String(text).replace(/\s+/g, ' ').trim().toLowerCase();
      state.calls.push({ sql, params });

      if (sql.includes('select * from app.film_orders') && sql.includes('film_order_id = $2')) {
        return {
          rows: filmOrder && filmOrder.film_order_id === params[1] ? [{ ...filmOrder }] : [],
        };
      }

      if (sql.includes('select * from app.allocations') && sql.includes('film_order_id = $2')) {
        return {
          rows: allocations
            .filter((entry) => entry.film_order_id === params[1])
            .map((entry) => ({ ...entry })),
        };
      }

      if (sql.includes('select * from app.film_order_box_links') && sql.includes('film_order_id = $2')) {
        return {
          rows: links
            .filter((entry) => entry.film_order_id === params[1])
            .map((entry) => ({ ...entry })),
        };
      }

      if (sql.startsWith('delete from app.film_order_box_links')) {
        state.deletedLinkFilmOrderIds.push(params[1]);
        return { rows: [] };
      }

      if (sql.startsWith('delete from app.film_orders')) {
        state.deletedFilmOrderIds.push(params[1]);
        return { rows: [] };
      }

      throw new Error(`Unexpected query in film-order delete guard test: ${sql}`);
    },
  };
}

test('cancelFilmOrderAndReleaseAllocations deletes a plain pending manual film order', async () => {
  const client = createFilmOrderDeleteClient();

  const result = await cancelFilmOrderAndReleaseAllocations(
    client,
    'org-1',
    'FO-1',
    'tester',
    'Cancelled after requirements were fulfilled.'
  );

  assert.equal(result.filmOrder.filmOrderId, 'FO-1');
  assert.equal(result.releasedAllocationCount, 0);
  assert.deepEqual(client.state.deletedLinkFilmOrderIds, ['FO-1']);
  assert.deepEqual(client.state.deletedFilmOrderIds, ['FO-1']);
});

test('cancelFilmOrderAndReleaseAllocations rejects non-pending film order statuses', async () => {
  for (const status of ['FILM_ON_THE_WAY', 'FULFILLED', 'CANCELLED']) {
    const client = createFilmOrderDeleteClient({
      filmOrder: buildFilmOrderRow({ status }),
    });

    await assert.rejects(
      () => cancelFilmOrderAndReleaseAllocations(client, 'org-1', 'FO-1', 'tester', ''),
      /Only open pending film orders can be cancelled/
    );
    assert.deepEqual(client.state.deletedFilmOrderIds, []);
  }
});

test('cancelFilmOrderAndReleaseAllocations rejects film orders with downstream fulfillment state', async () => {
  const cases = [
    {
      name: 'ordered feet',
      options: { filmOrder: buildFilmOrderRow({ ordered_feet: 10 }) },
      message: /fulfillment activity/,
    },
    {
      name: 'covered feet',
      options: { filmOrder: buildFilmOrderRow({ covered_feet: 10 }) },
      message: /fulfillment activity/,
    },
    {
      name: 'linked ordered boxes',
      options: { links: [buildFilmOrderLinkRow()] },
      message: /linked ordered boxes/,
    },
    {
      name: 'active allocations',
      options: { allocations: [buildAllocationRow()] },
      message: /fulfillment allocations/,
    },
    {
      name: 'automated shortage source',
      options: { filmOrder: buildFilmOrderRow({ source_box_id: 'IL1-1234' }) },
      message: /Automated shortage film orders/,
    },
  ];

  for (const testCase of cases) {
    const client = createFilmOrderDeleteClient(testCase.options);

    await assert.rejects(
      () => cancelFilmOrderAndReleaseAllocations(client, 'org-1', 'FO-1', 'tester', ''),
      testCase.message,
      testCase.name
    );
    assert.deepEqual(client.state.deletedFilmOrderIds, [], testCase.name);
  }
});
