import test from 'node:test';
import assert from 'node:assert/strict';

import {
  syncJobMetadataToActiveAllocationsAndOpenFilmOrders
} from '../../src/app/services/runtime/runtimeJobsMutations.mjs';

const REQUIREMENT_ID = '11111111-1111-4111-8111-111111111111';

function createAllocationRow(overrides = {}) {
  return {
    id: 'allocation-row-1',
    org_id: 'org-1',
    allocation_id: 'ALLOC-JOB-DATE-1',
    box_id: 'IL1-JOB-DATE-1',
    job_id: 'job-row-1',
    job_number: '19413',
    warehouse: 'IL1',
    job_date: '2026-05-10',
    allocated_feet: 40,
    covered_feet: 40,
    requirement_id: REQUIREMENT_ID,
    status: 'ACTIVE',
    created_at: '2026-04-23T09:10:00Z',
    created_by: 'planner',
    resolved_at: null,
    resolved_by: '',
    notes: '',
    crew_leader: 'Old Crew',
    film_order_id: '',
    allocation_kind: 'REQUIREMENT',
    allocation_source: 'AUTO_PLANNED',
    ...overrides
  };
}

function createFilmOrderRow(overrides = {}) {
  return {
    id: 'film-order-row-1',
    org_id: 'org-1',
    film_order_id: 'FO-JOB-DATE-1',
    requirement_id: REQUIREMENT_ID,
    job_id: 'job-row-1',
    job_number: '19413',
    warehouse: 'IL1',
    manufacturer: 'Solar Gard',
    film_name: 'Slate 20',
    width_in: 60,
    requested_feet: 25,
    covered_feet: 0,
    ordered_feet: 0,
    remaining_to_order_feet: 25,
    job_date: '2026-05-10',
    crew_leader: 'Old Crew',
    status: 'FILM_ORDER',
    source_box_id: '',
    resolved_at: null,
    resolved_by: '',
    notes: '',
    created_at: '2026-04-23T09:12:00Z',
    created_by: 'planner',
    ...overrides
  };
}

function createBoxRow(overrides = {}) {
  return {
    id: 'box-row-1',
    org_id: 'org-1',
    box_id: 'IL1-JOB-DATE-1',
    warehouse: 'IL1',
    dealer: '',
    manufacturer: 'Solar Gard',
    film_name: 'Slate 20',
    width_in: 60,
    initial_feet: 100,
    feet_available: 60,
    lot_run: '',
    status: 'IN_STOCK',
    order_date: '2026-04-23',
    received_date: '2026-04-23',
    initial_weight_lbs: 12,
    last_roll_weight_lbs: 12,
    last_weighed_date: '2026-04-23',
    film_key: 'SOLAR GARD|SLATE 20',
    core_type: 'White plastic',
    core_weight_lbs: 1.5,
    lf_weight_lbs_per_ft: 0.105,
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
    active_allocated_feet: 40,
    allocation_planning_feet: 60,
    allocated_with_install_date_feet: 40,
    allocated_without_install_date_feet: 0,
    physical_feet_available: 100,
    allocatable_now_feet: 60,
    ...overrides
  };
}

function createJobRow(overrides = {}) {
  return {
    id: 'job-row-1',
    org_id: 'org-1',
    job_number: '19413',
    warehouse: 'IL1',
    sections: null,
    due_date: '2026-05-11',
    crew_leader: 'New Crew',
    lifecycle_status: 'ACTIVE',
    is_labor_only: false,
    is_staged_for_pickup: false,
    notes: '',
    created_at: '2026-04-23T09:00:00Z',
    created_by: 'planner',
    updated_at: '2026-04-23T09:15:00Z',
    updated_by: 'planner',
    ...overrides
  };
}

function countRequirementAssignments(sql) {
  return (String(sql).match(/requirement_id\s*=\s*excluded\.requirement_id/gi) || []).length;
}

function createRecordingClient() {
  const state = {
    allocation: createAllocationRow(),
    filmOrder: createFilmOrderRow(),
    box: createBoxRow(),
    jobs: [createJobRow()],
    calls: []
  };

  return {
    state,
    async query(text, params = []) {
      const rawSql = String(text);
      const sql = rawSql.replace(/\s+/g, ' ').trim().toLowerCase();
      state.calls.push({ sql, rawSql, params });

      if (sql.includes('select * from app.allocations') && sql.includes('upper(trim(job_number))')) {
        return { rows: [{ ...state.allocation }] };
      }

      if (sql.includes('select * from app.film_orders') && sql.includes('upper(trim(job_number))')) {
        return { rows: [{ ...state.filmOrder }] };
      }

      if (sql.includes('select app_api.resolve_box_id_alias')) {
        return { rows: [{ box_id: params[1] }] };
      }

      if (sql.includes('from app.boxes b') && sql.includes('and b.box_id = $2')) {
        return { rows: state.box.box_id === params[1] ? [{ ...state.box }] : [] };
      }

      if (sql.includes('select * from app.allocations') && sql.includes('and box_id = $2')) {
        return {
          rows: state.allocation.box_id === params[1] ? [{ ...state.allocation }] : []
        };
      }

      if (sql.includes('select * from app.jobs') && !sql.includes('upper(trim(job_number))')) {
        return { rows: state.jobs.map((entry) => ({ ...entry })) };
      }

      if (sql.includes('insert into app.allocations') && sql.includes('on conflict (org_id, allocation_id) do update set')) {
        assert.equal(
          countRequirementAssignments(rawSql),
          1,
          'allocation upsert must assign requirement_id only once'
        );
        state.allocation = {
          ...state.allocation,
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
          created_at: params[11] || state.allocation.created_at,
          created_by: params[12],
          resolved_at: params[13] || null,
          resolved_by: params[14],
          notes: params[15],
          crew_leader: params[16],
          film_order_id: params[17],
          allocation_kind: params[18],
          allocation_source: params[19]
        };
        return { rows: [{ ...state.allocation }] };
      }

      if (sql.includes('app_api.assert_film_box_allocation_capacity')) {
        return { rows: [{ ok: null }] };
      }

      if (sql.includes('insert into app.film_orders') && sql.includes('on conflict (org_id, film_order_id) do update set')) {
        state.filmOrder = {
          ...state.filmOrder,
          org_id: params[0],
          film_order_id: params[1],
          requirement_id: params[2] || null,
          job_id: params[3],
          job_number: params[4],
          warehouse: params[5],
          manufacturer: params[6],
          film_name: params[7],
          width_in: params[8],
          requested_feet: params[9],
          covered_feet: params[10],
          ordered_feet: params[11],
          remaining_to_order_feet: params[12],
          job_date: params[13] || null,
          crew_leader: params[14],
          status: params[15],
          source_box_id: params[16],
          resolved_at: params[17] || null,
          resolved_by: params[18],
          notes: params[19],
          created_at: params[20] || state.filmOrder.created_at,
          created_by: params[21]
        };
        return { rows: [{ ...state.filmOrder }] };
      }

      if (sql.includes('insert into app.boxes')) {
        throw new Error('Reservation recalculation should not update box feet for this fixture.');
      }

      throw new Error(`Unexpected query during job install-date regression test: ${sql}`);
    }
  };
}

test('install-date sync preserves requirement_id while updating allocation and film-order metadata', async () => {
  const client = createRecordingClient();

  const result = await syncJobMetadataToActiveAllocationsAndOpenFilmOrders(
    client,
    'org-1',
    '19413',
    'planner',
    '2026-05-10',
    '2026-05-11',
    'New Crew'
  );

  assert.deepEqual(result, {
    updatedAllocationCount: 1,
    updatedFilmOrderCount: 1
  });
  assert.equal(client.state.allocation.job_date, '2026-05-11');
  assert.equal(client.state.allocation.crew_leader, 'New Crew');
  assert.equal(client.state.allocation.requirement_id, REQUIREMENT_ID);
  assert.equal(client.state.filmOrder.job_date, '2026-05-11');
  assert.equal(client.state.filmOrder.crew_leader, 'New Crew');
  assert.equal(client.state.filmOrder.requirement_id, REQUIREMENT_ID);

  const allocationSaveCall = client.state.calls.find((call) =>
    call.sql.includes('insert into app.allocations') &&
    call.sql.includes('on conflict (org_id, allocation_id) do update set')
  );
  assert.ok(allocationSaveCall);
  assert.equal(countRequirementAssignments(allocationSaveCall.rawSql), 1);
});
