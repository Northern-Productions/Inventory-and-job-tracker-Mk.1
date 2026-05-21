import test from 'node:test';
import assert from 'node:assert/strict';

import { setBoxStatus } from '../../src/app/services/runtime/boxes/statusTransitions.mjs';
import { DIRECT_TO_SITE_FIRST_RETURN_PREFIX } from '../../src/app/services/runtime/boxes/directToJobSite.mjs';

function createBoxRow(overrides = {}) {
  return {
    id: 'box-row-1',
    org_id: 'org-1',
    box_id: 'IL1-DTS-1',
    warehouse: 'IL1',
    dealer: '',
    manufacturer: 'Solar Gard',
    film_name: 'Slate 20',
    width_in: 36,
    initial_feet: 100,
    feet_available: 100,
    lot_run: '',
    status: 'CHECKED_OUT',
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
    direct_to_job_site: true,
    has_label: true,
    has_ever_been_checked_out: true,
    last_checkout_job_id: null,
    last_checkout_job: '5555',
    last_checkout_date: '2026-04-23',
    zeroed_date: null,
    zeroed_reason: '',
    zeroed_by: '',
    created_at: '2026-04-23T09:00:00Z',
    updated_at: '2026-04-23T09:00:00Z',
    active_allocated_feet: 0,
    allocation_planning_feet: 0,
    ...overrides,
  };
}

function createRecordingClient() {
  const state = {
    box: createBoxRow(),
    allocations: [],
    auditEntries: [],
    rollHistoryEntries: [],
    requirementUsageEntries: [],
    filmOrderLinks: [],
    reconciliationResult: {
      warnings: [],
      affectedJobNumbers: [],
      reducedAllocationIds: [],
      cancelledAllocationIds: [],
      updatedFilmOrderIds: [],
      feetAvailable: 0,
    },
    calls: [],
  };

  const withBoxMetrics = (row) =>
    row
      ? {
          ...row,
          active_allocated_feet: 0,
          allocation_planning_feet: 0,
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

      if (sql.includes('from app.boxes b') && sql.includes('and b.box_id = $2')) {
        return {
          rows: state.box && state.box.box_id === params[1] ? [withBoxMetrics(state.box)] : [],
        };
      }

      if (sql.includes('select * from app.allocations') && sql.includes('and box_id = $2')) {
        return { rows: state.allocations.filter((entry) => entry.box_id === params[1]) };
      }

      if (sql.includes('from app.allocations a join app.job_requirements r')) {
        const boxId = String(params[1] || '').trim().toUpperCase();
        const jobId = String(params[2] || '').trim();
        const jobNumber = String(params[3] || '').trim().toUpperCase();
        return {
          rows: state.allocations
            .filter(
              (entry) =>
                String(entry.box_id || '').trim().toUpperCase() === boxId &&
                String(entry.status || '').trim().toUpperCase() === 'ACTIVE' &&
                String(entry.allocation_kind || 'REQUIREMENT').trim().toUpperCase() === 'REQUIREMENT' &&
                String(entry.requirement_id || '').trim() &&
                (jobId
                  ? String(entry.job_id || '').trim() === jobId
                  : String(entry.job_number || '').trim().toUpperCase() === jobNumber)
            )
            .map((entry) => ({
              allocation_id: entry.allocation_id,
              requirement_id: entry.requirement_id,
              usage_basis_feet: entry.covered_feet || entry.allocated_feet || 0,
              created_at: entry.created_at,
              job_id: entry.job_id || '33333333-3333-4333-8333-333333333333',
              job_number: entry.job_number,
            })),
        };
      }

      if (sql.includes('select * from app.audit_log') && sql.includes('and box_id = $2')) {
        return { rows: [] };
      }

      if (sql.includes('insert into app.roll_weight_log')) {
        state.rollHistoryEntries.push({
          org_id: params[0],
          log_id: params[1],
          box_id: params[2],
          job_id: params[7],
          job_number: params[8],
          notes: params[18],
        });
        return { rows: [] };
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
          has_label: params[24] !== false,
          has_ever_been_checked_out: params[25] === true,
          last_checkout_job_id: params[26] || null,
          last_checkout_job: params[27],
          last_checkout_date: params[28] || null,
          zeroed_date: params[29] || null,
          zeroed_reason: params[30],
          zeroed_by: params[31],
          created_at: state.box?.created_at || '2026-04-23T09:00:00Z',
          updated_at: '2026-04-23T10:00:00Z',
        };
        return { rows: [withBoxMetrics(state.box)] };
      }

      if (sql.includes('select * from app.film_order_box_links') && sql.includes('and box_id = $2')) {
        return { rows: [] };
      }

      if (sql.includes('select app_api.reconcile_box_checkin_allocations')) {
        return {
          rows: [
            {
              result: {
                ...state.reconciliationResult,
                feetAvailable:
                  state.reconciliationResult.feetAvailable ?? Math.max(0, Number(params[3] || 0)),
              },
            },
          ],
        };
      }

      if (sql.includes('update app.job_requirements') && sql.includes('set actual_used_feet')) {
        state.requirementUsageEntries.push({
          org_id: params[0],
          job_id: params[1],
          requirement_id: params[2],
          applied_feet: params[3],
          actor: params[4],
        });
        return { rows: [] };
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

      throw new Error(`Unexpected query during setBoxStatus regression test: ${sql}`);
    },
  };
}

test('setBoxStatus reuses the direct-to-site first-return note for roll history and audit entry', async () => {
  const client = createRecordingClient();

  const response = await setBoxStatus(
    client,
    'org-1',
    {
      boxId: 'IL1-DTS-1',
      status: 'IN_STOCK',
      lastRollWeightLbs: 0,
      currentFeetOnRoll: 0,
      auditNote: 'Returned after install',
    },
    'warehouse-user'
  );

  assert.equal(response.ok, true);
  assert.equal(client.state.rollHistoryEntries.length, 1);
  assert.equal(client.state.auditEntries.length, 1);

  const rollHistoryNote = client.state.rollHistoryEntries[0].notes;
  const auditNote = client.state.auditEntries[0].notes;

  assert.match(rollHistoryNote, new RegExp(`^${DIRECT_TO_SITE_FIRST_RETURN_PREFIX}: `));
  assert.equal(auditNote, rollHistoryNote);
  assert.match(auditNote, /Additional note: Returned after install/);
});

test('setBoxStatus delegates check-in overuse reconciliation and surfaces affected warnings', async () => {
  const client = createRecordingClient();
  client.state.box = createBoxRow({
    box_id: 'IL1-DTS-2',
    core_type: 'Red plastic',
    last_checkout_job: '5555',
  });
  client.state.allocations = [
    {
      id: 'allocation-row-1',
      org_id: 'org-1',
      allocation_id: 'alloc-other-job',
      box_id: 'IL1-DTS-2',
      warehouse: 'IL1',
      job_id: 'job-row-7777',
      job_number: '7777',
      job_date: '2026-04-25',
      allocated_feet: 10,
      covered_feet: 10,
      backed_physical_feet: null,
      reservation_state: 'WITH_INSTALL_DATE',
      requirement_id: '11111111-1111-4111-8111-111111111111',
      allocation_kind: 'REQUIREMENT',
      allocation_source: 'MANUAL',
      status: 'ACTIVE',
      created_at: '2026-04-20T12:00:00Z',
      created_by: 'planner',
      resolved_at: null,
      resolved_by: '',
      notes: '',
      crew_leader: '',
      film_order_id: '',
    },
  ];
  client.state.reconciliationResult = {
    warnings: [
      'Reduced allocation alloc-other-job for job 7777 from 10 LF to 5 LF because box IL1-DTS-2 physically returned with less LF.',
    ],
    affectedJobNumbers: ['7777'],
    reducedAllocationIds: ['alloc-other-job'],
    cancelledAllocationIds: [],
    updatedFilmOrderIds: [],
    feetAvailable: 0,
  };

  const response = await setBoxStatus(
    client,
    'org-1',
    {
      boxId: 'IL1-DTS-2',
      status: 'IN_STOCK',
      lastRollWeightLbs: 2.5,
      currentFeetOnRoll: 5,
      coreType: 'Red plastic',
      auditNote: 'Returned with less LF than other reservations expected',
    },
    'warehouse-user'
  );

  const reconcileCall = client.state.calls.find((call) =>
    call.sql.includes('select app_api.reconcile_box_checkin_allocations')
  );

  assert.equal(response.ok, true);
  assert.ok(reconcileCall, 'expected check-in flow to call reconciliation RPC');
  assert.equal(reconcileCall.params[2], 'IL1-DTS-2');
  assert.equal(reconcileCall.params[3], 5);
  assert.equal(client.state.box.feet_available, 0);
  assert.match(response.warnings.join(' '), /Reduced allocation alloc-other-job/);
  assert.match(response.warnings.join(' '), /manual reservations no longer fit this box/);
});

test('setBoxStatus lets reconciliation reduce same-job active allocations during check-in', async () => {
  const client = createRecordingClient();
  client.state.box = createBoxRow({
    box_id: 'IL1-DTS-3',
    core_type: 'Red plastic',
    last_checkout_job: '5555',
  });
  client.state.allocations = [
    {
      id: 'allocation-row-1',
      org_id: 'org-1',
      allocation_id: 'alloc-same-job',
      box_id: 'IL1-DTS-3',
      warehouse: 'IL1',
      job_id: null,
      job_number: '5555',
      job_date: '2026-04-25',
      allocated_feet: 8,
      covered_feet: 8,
      backed_physical_feet: null,
      reservation_state: 'WITH_INSTALL_DATE',
      requirement_id: '22222222-2222-4222-8222-222222222222',
      allocation_kind: 'REQUIREMENT',
      allocation_source: 'AUTO_PLANNED',
      status: 'ACTIVE',
      created_at: '2026-04-20T12:00:00Z',
      created_by: 'planner',
      resolved_at: null,
      resolved_by: '',
      notes: '',
      crew_leader: '',
      film_order_id: '',
    },
  ];
  client.state.reconciliationResult = {
    warnings: [
      'Reduced allocation alloc-same-job for job 5555 from 8 LF to 5 LF because box IL1-DTS-3 physically returned with less LF.',
    ],
    affectedJobNumbers: ['5555'],
    reducedAllocationIds: ['alloc-same-job'],
    cancelledAllocationIds: [],
    updatedFilmOrderIds: [],
    feetAvailable: 0,
  };

  const response = await setBoxStatus(
    client,
    'org-1',
    {
      boxId: 'IL1-DTS-3',
      status: 'IN_STOCK',
      lastRollWeightLbs: 2.5,
      currentFeetOnRoll: 5,
      coreType: 'Red plastic',
      auditNote: 'Returned with less LF than the checkout job allocation expected',
    },
    'warehouse-user'
  );

  const reconcileCall = client.state.calls.find((call) =>
    call.sql.includes('select app_api.reconcile_box_checkin_allocations')
  );

  assert.equal(response.ok, true);
  assert.ok(reconcileCall, 'expected check-in flow to delegate same-job shortages to reconciliation RPC');
  assert.equal(reconcileCall.params[2], 'IL1-DTS-3');
  assert.equal(reconcileCall.params[3], 5);
  assert.match(response.warnings.join(' '), /Reduced allocation alloc-same-job/);
  assert.doesNotMatch(response.warnings.join(' '), /Released 1 active planning allocation/);
});
