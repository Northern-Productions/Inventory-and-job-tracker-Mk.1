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
    has_ever_been_checked_out: true,
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
    filmOrderLinks: [],
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
        return { rows: [] };
      }

      if (sql.includes('select * from app.audit_log') && sql.includes('and box_id = $2')) {
        return { rows: [] };
      }

      if (sql.includes('insert into app.roll_weight_log')) {
        state.rollHistoryEntries.push({
          org_id: params[0],
          log_id: params[1],
          box_id: params[2],
          job_number: params[7],
          notes: params[17],
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

      if (sql.includes('select * from app.film_order_box_links') && sql.includes('and box_id = $2')) {
        return { rows: [] };
      }

      if (sql.includes('select app_api.reconcile_box_checkin_allocations')) {
        return {
          rows: [
            {
              result: {
                warnings: [],
                affectedJobNumbers: [],
                reducedAllocationIds: [],
                cancelledAllocationIds: [],
                updatedFilmOrderIds: [],
                feetAvailable: Math.max(0, Number(params[3] || 0)),
              },
            },
          ],
        };
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
