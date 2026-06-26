import test from 'node:test';
import assert from 'node:assert/strict';

import { updateBox } from '../../src/app/services/runtime/boxes/index.mjs';

function createBoxRow(overrides = {}) {
  return {
    id: 'box-row-1',
    org_id: 'org-1',
    box_id: 'IL1-LF-CORRECT-1',
    warehouse: 'IL1',
    dealer: '',
    manufacturer: '3M',
    film_name: 'Solar Silver',
    width_in: 36,
    initial_feet: 82,
    feet_available: 0,
    lot_run: '',
    status: 'IN_STOCK',
    order_date: '2026-06-01',
    received_date: '2026-06-02',
    initial_weight_lbs: null,
    last_roll_weight_lbs: null,
    last_weighed_date: null,
    film_key: '3M|SOLAR_SILVER',
    core_type: '',
    core_weight_lbs: null,
    lf_weight_lbs_per_ft: null,
    price_per_lf: null,
    purchase_cost: null,
    notes: '',
    direct_to_job_site: false,
    has_label: false,
    has_ever_been_checked_out: false,
    last_checkout_job_id: null,
    last_checkout_job: '',
    last_checkout_date: null,
    zeroed_date: null,
    zeroed_reason: '',
    zeroed_by: '',
    created_at: '2026-06-01T09:00:00Z',
    updated_at: '2026-06-01T09:00:00Z',
    active_allocated_feet: 82,
    physical_feet_available: 82,
    allocatable_now_feet: 0,
    allocation_planning_feet: 0,
    ...overrides,
  };
}

function createAllocationRow(overrides = {}) {
  return {
    id: 'allocation-row-1',
    org_id: 'org-1',
    allocation_id: 'ALLOC-LF-CORRECT-1',
    box_id: 'IL1-LF-CORRECT-1',
    job_id: 'job-row-1',
    job_number: '9001',
    warehouse: 'IL1',
    job_date: '2026-06-20',
    allocated_feet: 82,
    covered_feet: 82,
    requirement_id: 'req-row-1',
    status: 'ACTIVE',
    created_at: '2026-06-01T09:10:00Z',
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
    allocations: [createAllocationRow()],
    auditEntries: [],
    filmCatalogSeeds: [],
    filmWeightSampleLogs: [],
    calls: [],
  };

  const activeAllocatedFeet = () =>
    state.allocations
      .filter((entry) => String(entry.status || '').toUpperCase() === 'ACTIVE')
      .reduce((total, entry) => total + Number(entry.allocated_feet || 0), 0);

  const withBoxMetrics = (row) =>
    row
      ? {
          ...row,
          active_allocated_feet: activeAllocatedFeet(),
          physical_feet_available: Math.max(0, Number(row.feet_available || 0) + activeAllocatedFeet()),
          allocatable_now_feet: Math.max(0, Number(row.feet_available || 0)),
          allocation_planning_feet: Math.max(0, Number(row.feet_available || 0)),
        }
      : null;

  return {
    state,
    async query(text, params = []) {
      const sql = String(text).replace(/\s+/g, ' ').trim().toLowerCase();
      state.calls.push({ sql, params });

      if (/^(savepoint|release savepoint|rollback to savepoint)\b/i.test(sql)) {
        return { rows: [] };
      }

      if (sql.includes('select app_api.resolve_box_id_alias')) {
        return { rows: [{ box_id: params[1] }] };
      }

      if (sql.includes('select app_api.resolve_warehouse_from_box_id')) {
        return { rows: [{ warehouse: 'IL1' }] };
      }

      if (sql.includes('select') && sql.includes('from app.boxes b') && sql.includes('and b.box_id = $2')) {
        return { rows: state.box?.box_id === params[1] ? [withBoxMetrics(state.box)] : [] };
      }

      if (sql.includes('select * from app.allocations') && sql.includes('and box_id = $2')) {
        return {
          rows: state.allocations
            .filter((entry) => entry.box_id === params[1])
            .slice()
            .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at))),
        };
      }

      if (sql.includes('select * from app.film_catalog')) {
        return { rows: [] };
      }

      if (sql.includes('select * from app.film_order_box_links') && sql.includes('and box_id = $2')) {
        return { rows: [] };
      }

      if (sql.includes('select app_api.reconcile_box_checkin_allocations')) {
        const physicalFeetAfter = Math.max(0, Number(params[3] || 0));
        let remainingFeet = physicalFeetAfter;
        const reducedAllocationIds = [];
        const warnings = [];

        for (const allocation of state.allocations) {
          if (String(allocation.status || '').toUpperCase() !== 'ACTIVE') {
            continue;
          }

          const allocatedFeet = Number(allocation.allocated_feet || 0);
          if (remainingFeet >= allocatedFeet) {
            remainingFeet -= allocatedFeet;
            continue;
          }

          reducedAllocationIds.push(allocation.allocation_id);
          allocation.allocated_feet = remainingFeet;
          allocation.covered_feet = remainingFeet;
          warnings.push(`Reduced allocation ${allocation.allocation_id} for job ${allocation.job_number}.`);
          remainingFeet = 0;
        }

        const storedActiveFeet = activeAllocatedFeet();
        state.box.feet_available = Math.max(physicalFeetAfter - storedActiveFeet, 0);

        return {
          rows: [
            {
              result: {
                boxId: params[2],
                physicalFeetAfter,
                activeStoredFeet: storedActiveFeet,
                feetAvailable: state.box.feet_available,
                reducedAllocationIds,
                cancelledAllocationIds: [],
                affectedJobNumbers: ['9001'],
                updatedFilmOrderIds: [],
                warnings,
              },
            },
          ],
        };
      }

      if (sql.includes('app_api.record_film_weight_sample_from_box')) {
        state.filmWeightSampleLogs.push({
          org_id: params[0],
          box_id: params[1],
          actor: params[2],
        });
        return { rows: [{ result: { decision: 'skipped' } }] };
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

      if (sql.includes('insert into app.boxes') && sql.includes('on conflict (org_id, box_id) do update set')) {
        state.box = {
          ...state.box,
          org_id: params[0],
          box_id: params[1],
          warehouse: params[2],
          owner_company_id: params[3] || state.box?.owner_company_id || null,
          dealer: params[4],
          manufacturer: params[5],
          film_name: params[6],
          width_in: params[7],
          initial_feet: params[8],
          feet_available: params[9],
          lot_run: params[10],
          status: params[11],
          order_date: params[12],
          received_date: params[13] || null,
          initial_weight_lbs: params[14],
          last_roll_weight_lbs: params[15],
          last_weighed_date: params[16] || null,
          film_key: params[17],
          core_type: params[18],
          core_weight_lbs: params[19],
          lf_weight_lbs_per_ft: params[20],
          price_per_lf: params[21],
          purchase_cost: params[22],
          notes: params[23],
          direct_to_job_site: params[24] === true,
          has_label: params[25] !== false,
          has_ever_been_checked_out: params[26] === true,
          last_checkout_job_id: params[27] || null,
          last_checkout_job: params[28],
          last_checkout_date: params[29] || null,
          zeroed_date: params[30] || null,
          zeroed_reason: params[31],
          zeroed_by: params[32],
          updated_at: '2026-06-01T10:00:00Z',
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

      throw new Error(`Unexpected query during box LF correction runtime test: ${sql}`);
    },
  };
}

test('updateBox allows current LF below active allocation and reconciles the allocation', async () => {
  const client = createRecordingClient();

  const response = await updateBox(
    client,
    'org-1',
    {
      boxId: 'IL1-LF-CORRECT-1',
      manufacturer: '3M',
      filmName: 'Solar Silver',
      widthIn: 36,
      initialFeet: 82,
      receivedDate: '2026-06-02',
      currentFeetOnRoll: 80,
      feetAvailable: 0,
      lotRun: '',
      orderDate: '2026-06-01',
      auditNote: 'Correct physical LF from received label.',
    },
    'warehouse-user'
  );

  assert.equal(response.ok, true);
  assert.equal(client.state.box.initial_feet, 82);
  assert.equal(client.state.box.feet_available, 0);
  assert.equal(client.state.allocations[0].status, 'ACTIVE');
  assert.equal(client.state.allocations[0].allocated_feet, 80);
  assert.equal(client.state.allocations[0].covered_feet, 80);
  assert.equal(client.state.auditEntries.length, 1);
  assert.equal(client.state.auditEntries[0].action, 'UPDATE_BOX');
  assert.match(response.warnings.join(' '), /Reduced allocation ALLOC-LF-CORRECT-1/i);
  assert.doesNotMatch(response.warnings.join(' '), /cannot be lower than/i);
});
