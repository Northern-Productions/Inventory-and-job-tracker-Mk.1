import test from 'node:test';
import assert from 'node:assert/strict';

import { receiveOrderedBox } from '../../src/app/services/runtime/boxes/receiveOrdered.mjs';

function createBoxRow(overrides = {}) {
  return {
    id: 'box-row-1',
    org_id: 'org-1',
    box_id: 'IL1-ORDERED-1',
    warehouse: 'IL1',
    dealer: '',
    manufacturer: 'Solar Gard',
    film_name: 'Slate 20',
    width_in: 36,
    initial_feet: 100,
    feet_available: 100,
    lot_run: '',
    status: 'ORDERED',
    order_date: '2026-04-23',
    received_date: null,
    initial_weight_lbs: null,
    last_roll_weight_lbs: null,
    last_weighed_date: null,
    film_key: 'SOLAR_GARD|SLATE_20',
    core_type: '',
    core_weight_lbs: null,
    lf_weight_lbs_per_ft: null,
    price_per_lf: null,
    purchase_cost: null,
    notes: '',
    direct_to_job_site: false,
    has_ever_been_checked_out: false,
    last_checkout_job: '',
    last_checkout_date: null,
    zeroed_date: null,
    zeroed_reason: '',
    zeroed_by: '',
    created_at: '2026-04-23T09:00:00Z',
    updated_at: '2026-04-23T09:00:00Z',
    active_allocated_feet: 0,
    allocation_planning_feet: 100,
    ...overrides,
  };
}

function createFilmOrderRow(overrides = {}) {
  return {
    id: 'film-order-row-1',
    org_id: 'org-1',
    film_order_id: 'FO-RECEIVE-1',
    job_id: null,
    job_number: '5555',
    warehouse: 'IL1',
    manufacturer: 'Solar Gard',
    film_name: 'Slate 20',
    width_in: 36,
    requested_feet: 100,
    covered_feet: 0,
    ordered_feet: 100,
    remaining_to_order_feet: 0,
    job_date: '2026-04-24',
    crew_leader: 'Crew',
    status: 'FILM_ON_THE_WAY',
    source_box_id: '',
    resolved_at: null,
    resolved_by: '',
    notes: '',
    created_at: '2026-04-23T09:05:00Z',
    created_by: 'tester',
    ...overrides,
  };
}

function createFilmOrderLinkRow(overrides = {}) {
  return {
    id: 'film-order-link-row-1',
    org_id: 'org-1',
    link_id: 'link-1',
    film_order_id: 'FO-RECEIVE-1',
    box_id: 'IL1-ORDERED-1',
    ordered_feet: 100,
    auto_allocated_feet: 0,
    created_at: '2026-04-23T09:05:00Z',
    created_by: 'tester',
    ...overrides,
  };
}

function createJobRequirementRow(overrides = {}) {
  return {
    id: 'req-row-1',
    org_id: 'org-1',
    job_id: 'job-row-1',
    job_number: '5555',
    manufacturer: 'Solar Gard',
    film_name: 'Slate 20',
    width_in: 36,
    required_feet: 100,
    notes: '',
    created_at: '2026-04-23T09:00:00Z',
    created_by: 'tester',
    updated_at: '2026-04-23T09:00:00Z',
    updated_by: 'tester',
    ...overrides,
  };
}

function createAllocationRow(overrides = {}) {
  return {
    id: 'allocation-row-1',
    org_id: 'org-1',
    allocation_id: 'ALLOC-PLACEHOLDER-1',
    box_id: 'IL1-ORDERED-1',
    job_id: 'job-row-1',
    job_number: '5555',
    warehouse: 'IL1',
    job_date: '2026-04-24',
    allocated_feet: 100,
    covered_feet: 100,
    requirement_id: 'req-row-1',
    status: 'ACTIVE',
    created_at: '2026-04-23T09:10:00Z',
    created_by: 'tester',
    resolved_at: null,
    resolved_by: '',
    notes: '',
    crew_leader: 'Crew',
    film_order_id: '',
    allocation_kind: 'REQUIREMENT',
    allocation_source: 'MANUAL',
    ...overrides,
  };
}

function createRecordingClient() {
  const state = {
    box: createBoxRow(),
    filmOrder: createFilmOrderRow(),
    filmOrderLink: createFilmOrderLinkRow(),
    jobRequirements: [createJobRequirementRow()],
    allocations: [],
    auditEntries: [],
    filmCatalogSeeds: [],
    calls: [],
  };

  const getActiveAllocatedFeet = (boxId) =>
    state.allocations
      .filter((entry) => entry.box_id === boxId && String(entry.status || '').toUpperCase() === 'ACTIVE')
      .reduce((total, entry) => total + Number(entry.allocated_feet || 0), 0);

  const withBoxMetrics = (row) =>
    row
      ? {
          ...row,
          active_allocated_feet: getActiveAllocatedFeet(row.box_id),
        }
      : null;

  return {
    state,
    async query(text, params = []) {
      const sql = String(text).replace(/\s+/g, ' ').trim().toLowerCase();
      state.calls.push({ sql, params });

      if (sql.includes('select app_api.resolve_box_id_alias')) {
        return { rows: [{ box_id: params[1] }] };
      }

      if (sql.includes('select') && sql.includes('from app.boxes b') && sql.includes('and b.box_id = $2')) {
        return { rows: state.box && state.box.box_id === params[1] ? [withBoxMetrics(state.box)] : [] };
      }

      if (sql.includes('select * from app.allocations') && sql.includes('and box_id = $2')) {
        return {
          rows: state.allocations
            .filter((entry) => entry.box_id === params[1])
            .slice()
            .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at))),
        };
      }

      if (sql.includes('select * from app.film_order_box_links') && sql.includes('and box_id = $2')) {
        return {
          rows:
            state.filmOrderLink && state.filmOrderLink.box_id === params[1]
              ? [{ ...state.filmOrderLink }]
              : [],
        };
      }

      if (sql.includes('select * from app.film_order_box_links') && sql.includes('and film_order_id = $2')) {
        return {
          rows:
            state.filmOrderLink && state.filmOrderLink.film_order_id === params[1]
              ? [{ ...state.filmOrderLink }]
              : [],
        };
      }

      if (sql.includes('select * from app.film_orders') && sql.includes('and film_order_id = $2')) {
        return {
          rows:
            state.filmOrder && state.filmOrder.film_order_id === params[1]
              ? [{ ...state.filmOrder }]
              : [],
        };
      }

      if (sql.includes('select * from app.allocations') && sql.includes('film_order_id = $2')) {
        return {
          rows: state.allocations
            .filter((entry) => entry.film_order_id === params[1])
            .slice()
            .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at))),
        };
      }

      if (sql.includes('from app.job_requirements r') && sql.includes('upper(trim(j.job_number)) = upper(trim($2))')) {
        return {
          rows: state.jobRequirements
            .filter((entry) => String(entry.job_number).toUpperCase() === String(params[1]).toUpperCase())
            .slice(),
        };
      }

      if (sql.includes('select * from app.jobs') && sql.includes('upper(trim(job_number)) = upper(trim($2))')) {
        return { rows: [] };
      }

      if (sql.includes('insert into app.allocations') && sql.includes('on conflict (org_id, allocation_id) do update set')) {
        const row = {
          id: `allocation-row-${state.allocations.length + 1}`,
          org_id: params[0],
          allocation_id: params[1],
          box_id: params[2],
          job_id: params[3],
          job_number: params[4],
          warehouse: params[5],
          job_date: params[6] || null,
          allocated_feet: params[7],
          covered_feet: params[8],
          requirement_id: params[9] || null,
          status: params[10],
          created_at: params[11] || '2026-04-23T10:00:00Z',
          created_by: params[12],
          resolved_at: params[13] || null,
          resolved_by: params[14],
          notes: params[15],
          crew_leader: params[16],
          film_order_id: params[17],
          allocation_kind: params[18],
          allocation_source: params[19],
        };
        const existingIndex = state.allocations.findIndex((entry) => entry.allocation_id === row.allocation_id);
        if (existingIndex >= 0) {
          state.allocations.splice(existingIndex, 1, { ...state.allocations[existingIndex], ...row });
        } else {
          state.allocations.push(row);
        }
        return { rows: [{ ...row }] };
      }

      if (sql.includes('app_api.assert_film_box_allocation_capacity')) {
        return { rows: [{ ok: null }] };
      }

      if (sql.includes('insert into app.film_order_box_links') && sql.includes('on conflict (org_id, link_id) do update set')) {
        state.filmOrderLink = {
          id: state.filmOrderLink?.id || 'film-order-link-row-1',
          org_id: params[0],
          link_id: params[1],
          film_order_id: params[2],
          box_id: params[3],
          ordered_feet: params[4],
          auto_allocated_feet: params[5],
          created_at: params[6] || state.filmOrderLink?.created_at || '2026-04-23T09:05:00Z',
          created_by: params[7],
        };
        return { rows: [{ ...state.filmOrderLink }] };
      }

      if (sql.includes('insert into app.film_orders') && sql.includes('on conflict (org_id, film_order_id) do update set')) {
        state.filmOrder = {
          id: state.filmOrder?.id || 'film-order-row-1',
          org_id: params[0],
          film_order_id: params[1],
          job_id: params[2],
          job_number: params[3],
          warehouse: params[4],
          manufacturer: params[5],
          film_name: params[6],
          width_in: params[7],
          requested_feet: params[8],
          covered_feet: params[9],
          ordered_feet: params[10],
          remaining_to_order_feet: params[11],
          job_date: params[12] || null,
          crew_leader: params[13],
          status: params[14],
          source_box_id: params[15],
          resolved_at: params[16] || null,
          resolved_by: params[17],
          notes: params[18],
          created_at: params[19] || state.filmOrder?.created_at || '2026-04-23T09:05:00Z',
          created_by: params[20],
        };
        return { rows: [{ ...state.filmOrder }] };
      }

      if (sql.includes('insert into app.boxes') && sql.includes('on conflict (org_id, box_id) do update set')) {
        state.box = {
          id: state.box?.id || 'box-row-1',
          org_id: params[0],
          box_id: params[1],
          warehouse: params[2],
          dealer: params[3],
          manufacturer: params[4],
          film_name: params[5],
          width_in: params[6],
          initial_feet: params[7],
          feet_available: params[8],
          lot_run: params[9],
          status: params[10],
          order_date: params[11],
          received_date: params[12] || null,
          initial_weight_lbs: params[13],
          last_roll_weight_lbs: params[14],
          last_weighed_date: params[15] || null,
          film_key: params[16],
          core_type: params[17],
          core_weight_lbs: params[18],
          lf_weight_lbs_per_ft: params[19],
          price_per_lf: params[20],
          purchase_cost: params[21],
          notes: params[22],
          direct_to_job_site: params[23] === true,
          has_ever_been_checked_out: params[24] === true,
          last_checkout_job: params[25],
          last_checkout_date: params[26] || null,
          zeroed_date: params[27] || null,
          zeroed_reason: params[28],
          zeroed_by: params[29],
          created_at: state.box?.created_at || '2026-04-23T09:00:00Z',
          updated_at: '2026-04-23T10:00:00Z',
        };
        return { rows: [withBoxMetrics(state.box)] };
      }

      if (sql.includes('insert into app.audit_log')) {
        state.auditEntries.push({
          org_id: params[0],
          log_id: params[1],
          action: params[2],
          box_id: params[3],
          before_state: params[4],
          after_state: params[5],
          actor: params[6],
          notes: params[7],
          created_at: params[8],
        });
        return { rows: [] };
      }

      if (sql.includes('insert into app.film_catalog') && sql.includes('on conflict (org_id, film_key) do nothing')) {
        state.filmCatalogSeeds.push({
          org_id: params[0],
          film_key: params[1],
          manufacturer: params[2],
          film_name: params[3],
          source_box_id: params[4],
        });
        return { rows: [] };
      }

      throw new Error(`Unexpected query during receive regression test: ${sql}`);
    },
  };
}

test('receiveOrderedBox receives a linked ordered box and recalculates film-order coverage without missing helper errors', async () => {
  const client = createRecordingClient();

  const response = await receiveOrderedBox(
    client,
    'org-1',
    {
      boxId: 'IL1-ORDERED-1',
      receivedWeightLbs: '12.5',
      lotRun: 'LOT-42',
    },
    'warehouse-user'
  );

  assert.equal(response.ok, true);
  assert.equal(response.data.box.boxId, 'IL1-ORDERED-1');
  assert.equal(response.data.box.status, 'IN_STOCK');
  assert.match(response.data.box.receivedDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(response.data.box.lastRollWeightLbs, 12.5);
  assert.equal(response.data.box.initialWeightLbs, 12.5);
  assert.equal(response.data.box.lastWeighedDate, response.data.box.receivedDate);
  assert.equal(response.data.box.lotRun, 'LOT-42');
  assert.match(
    response.warnings.join(' '),
    /automatically allocated to job 5555 for Film Order FO-RECEIVE-1/i
  );

  assert.equal(client.state.allocations.length, 1);
  assert.equal(client.state.allocations[0].film_order_id, 'FO-RECEIVE-1');
  assert.equal(client.state.allocations[0].covered_feet, 100);

  assert.equal(client.state.filmOrder.covered_feet, 100);
  assert.equal(client.state.filmOrder.ordered_feet, 100);
  assert.equal(client.state.filmOrder.remaining_to_order_feet, 0);
  assert.equal(client.state.filmOrder.status, 'FULFILLED');
  assert.equal(client.state.filmOrderLink.auto_allocated_feet, 100);

  assert.equal(client.state.auditEntries.length, 1);
  assert.match(client.state.auditEntries[0].notes, /Received ordered box IL1-ORDERED-1 at 12.5 lbs with lot run LOT-42/);
});

test('receiveOrderedBox resolves an existing ordered placeholder allocation instead of creating a duplicate row', async () => {
  const client = createRecordingClient();
  client.state.allocations = [createAllocationRow()];

  const response = await receiveOrderedBox(
    client,
    'org-1',
    {
      boxId: 'IL1-ORDERED-1',
      receivedWeightLbs: '8.75',
    },
    'warehouse-user'
  );

  assert.equal(response.ok, true);
  assert.match(
    response.warnings.join(' '),
    /100 LF placeholder from IL1-ORDERED-1 was resolved to job 5555 for Film Order FO-RECEIVE-1/i
  );
  assert.equal(client.state.allocations.length, 1);
  assert.equal(client.state.allocations[0].allocation_id, 'ALLOC-PLACEHOLDER-1');
  assert.equal(client.state.allocations[0].film_order_id, 'FO-RECEIVE-1');
  assert.equal(client.state.allocations[0].allocation_source, 'FILM_ORDER_RECEIPT');
  assert.equal(client.state.allocations[0].covered_feet, 100);
  assert.equal(client.state.filmOrder.covered_feet, 100);
  assert.equal(client.state.filmOrder.status, 'FULFILLED');
  assert.equal(client.state.filmOrderLink.auto_allocated_feet, 100);
});

test('receiveOrderedBox splits larger placeholders without increasing total active allocated feet', async () => {
  const client = createRecordingClient();
  client.state.box = createBoxRow({
    initial_feet: 200,
    feet_available: 200,
  });
  client.state.allocations = [
    createAllocationRow({
      allocation_id: 'ALLOC-PLACEHOLDER-200',
      allocated_feet: 150,
      covered_feet: 150,
    }),
  ];

  const response = await receiveOrderedBox(
    client,
    'org-1',
    {
      boxId: 'IL1-ORDERED-1',
    },
    'warehouse-user'
  );

  assert.equal(response.ok, true);
  assert.equal(client.state.allocations.length, 2);

  const placeholder = client.state.allocations.find((entry) => entry.allocation_id === 'ALLOC-PLACEHOLDER-200');
  const receipt = client.state.allocations.find((entry) => entry.film_order_id === 'FO-RECEIVE-1');
  assert.equal(placeholder.allocated_feet, 50);
  assert.equal(placeholder.covered_feet, 50);
  assert.equal(placeholder.film_order_id, '');
  assert.equal(receipt.allocated_feet, 100);
  assert.equal(receipt.covered_feet, 100);
  assert.equal(receipt.allocation_source, 'FILM_ORDER_RECEIPT');
  assert.equal(client.state.allocations.reduce((total, entry) => total + entry.allocated_feet, 0), 150);
  assert.equal(client.state.filmOrderLink.auto_allocated_feet, 100);
});
