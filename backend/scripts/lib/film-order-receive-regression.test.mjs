import test from 'node:test';
import assert from 'node:assert/strict';

import { receiveOrderedBox } from '../../src/app/services/runtime/boxes/receiveOrdered.mjs';
import { recalculateFilmOrder } from '../../src/app/services/runtime/runtimeAllocationPlanning.mjs';

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
    has_label: false,
    has_ever_been_checked_out: false,
    last_checkout_job_id: null,
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
    receipt_contribution_feet: null,
    receipt_source_width_in: null,
    receipt_finalized_at: null,
    receipt_finalized_by: null,
    receipt_capture_source: null,
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
    boxes: null,
    filmOrder: createFilmOrderRow(),
    filmOrderLink: createFilmOrderLinkRow(),
    filmOrderLinks: null,
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

  const getBoxes = () => (Array.isArray(state.boxes) ? state.boxes : state.box ? [state.box] : []);
  const getLinks = () =>
    Array.isArray(state.filmOrderLinks) ? state.filmOrderLinks : state.filmOrderLink ? [state.filmOrderLink] : [];

  const saveBoxState = (row) => {
    const previousBox = getBoxes().find((entry) => entry.box_id === row.box_id) || null;
    if (Array.isArray(state.boxes)) {
      const index = state.boxes.findIndex((entry) => entry.box_id === row.box_id);
      if (index >= 0) {
        state.boxes.splice(index, 1, row);
      } else {
        state.boxes.push(row);
      }
    }
    state.box = row;

    const becameReceived =
      row.received_date &&
      String(row.status || '').toUpperCase() !== 'ORDERED' &&
      (!previousBox?.received_date || String(previousBox?.status || '').toUpperCase() === 'ORDERED');
    if (becameReceived) {
      for (const link of getLinks().filter((entry) => entry.box_id === row.box_id)) {
        if (link.receipt_contribution_feet !== null && link.receipt_contribution_feet !== undefined) {
          continue;
        }
        saveLinkState({
          ...link,
          receipt_contribution_feet: Math.max(0, Number(row.initial_feet || 0)),
          receipt_source_width_in: Number(row.width_in || 0),
          receipt_finalized_at: '2026-04-23T10:00:00Z',
          receipt_finalized_by: 'warehouse-user',
          receipt_capture_source: 'LIVE_RECEIPT',
        });
      }
    }
  };

  const saveLinkState = (row) => {
    if (Array.isArray(state.filmOrderLinks)) {
      const index = state.filmOrderLinks.findIndex((entry) => entry.link_id === row.link_id);
      if (index >= 0) {
        state.filmOrderLinks.splice(index, 1, row);
      } else {
        state.filmOrderLinks.push(row);
      }
    }
    state.filmOrderLink = row;
  };

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

      if (/^(savepoint|release savepoint|rollback to savepoint)\b/i.test(sql)) {
        return { rows: [] };
      }

      if (sql.includes('app_api.record_film_weight_sample_from_box')) {
        state.filmWeightSampleLogs = state.filmWeightSampleLogs || [];
        state.filmWeightSampleLogs.push({
          org_id: params[0],
          box_id: params[1],
          actor: params[2],
        });
        return { rows: [{ result: { decision: 'skipped' } }] };
      }

      if (sql.includes('select app_api.reconcile_box_checkin_allocations')) {
        const boxId = params[2];
        const physicalFeetAfter = Math.max(0, Number(params[3] || 0));
        const activeRows = state.allocations
          .filter((entry) => entry.box_id === boxId && String(entry.status || '').toUpperCase() === 'ACTIVE')
          .sort((left, right) => {
            const leftDateRank = left.job_date ? 0 : 1;
            const rightDateRank = right.job_date ? 0 : 1;
            if (leftDateRank !== rightDateRank) {
              return leftDateRank - rightDateRank;
            }
            const dateDiff = String(left.job_date || '').localeCompare(String(right.job_date || ''));
            if (dateDiff !== 0) {
              return dateDiff;
            }
            const createdDiff = String(left.created_at || '').localeCompare(String(right.created_at || ''));
            if (createdDiff !== 0) {
              return createdDiff;
            }
            return String(left.allocation_id || '').localeCompare(String(right.allocation_id || ''));
          });
        let remainingFeet = physicalFeetAfter;
        const reducedAllocationIds = [];
        const cancelledAllocationIds = [];
        const affectedJobNumbers = [];
        const updatedFilmOrderIds = [];
        const warnings = [];

        for (const allocation of activeRows) {
          const allocatedFeet = Number(allocation.allocated_feet || 0);
          if (remainingFeet >= allocatedFeet) {
            remainingFeet -= allocatedFeet;
            continue;
          }

          if (allocation.job_number) {
            affectedJobNumbers.push(allocation.job_number);
          }
          if (allocation.film_order_id) {
            updatedFilmOrderIds.push(allocation.film_order_id);
          }

          if (remainingFeet > 0) {
            reducedAllocationIds.push(allocation.allocation_id);
            allocation.allocated_feet = remainingFeet;
            allocation.covered_feet = Math.min(Number(allocation.covered_feet || allocatedFeet), remainingFeet);
            warnings.push(`Reduced allocation ${allocation.allocation_id} for job ${allocation.job_number}.`);
            remainingFeet = 0;
          } else {
            cancelledAllocationIds.push(allocation.allocation_id);
            allocation.status = 'CANCELLED';
            allocation.resolved_at = '2026-04-23T10:30:00Z';
            allocation.resolved_by = params[1];
            warnings.push(`Cancelled allocation ${allocation.allocation_id} for job ${allocation.job_number}.`);
          }
        }

        const storedActiveFeet = state.allocations
          .filter((entry) => entry.box_id === boxId && String(entry.status || '').toUpperCase() === 'ACTIVE')
          .reduce((total, entry) => total + Number(entry.allocated_feet || 0), 0);
        const box = getBoxes().find((entry) => entry.box_id === boxId);
        if (box) {
          box.feet_available = Math.max(physicalFeetAfter - storedActiveFeet, 0);
        }

        return {
          rows: [
            {
              result: {
                boxId,
                physicalFeetAfter,
                activeStoredFeet: storedActiveFeet,
                feetAvailable: Math.max(physicalFeetAfter - storedActiveFeet, 0),
                reducedAllocationIds,
                cancelledAllocationIds,
                affectedJobNumbers,
                updatedFilmOrderIds,
                warnings,
              },
            },
          ],
        };
      }

      if (sql.includes('select app_api.resolve_box_id_alias')) {
        return { rows: [{ box_id: params[1] }] };
      }

      if (sql.includes('select') && sql.includes('from app.boxes b') && sql.includes('and b.box_id = $2')) {
        const box = getBoxes().find((entry) => entry.box_id === params[1]);
        return { rows: box ? [withBoxMetrics(box)] : [] };
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
          rows: getLinks()
            .filter((entry) => entry.box_id === params[1])
            .map((entry) => ({ ...entry })),
        };
      }

      if (sql.includes('select * from app.film_order_box_links') && sql.includes('and film_order_id = $2')) {
        return {
          rows: getLinks()
            .filter((entry) => entry.film_order_id === params[1])
            .map((entry) => ({ ...entry })),
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
        const existingLink = getLinks().find((entry) => entry.link_id === params[1]) || null;
        const row = {
          ...(existingLink || {}),
          id: existingLink?.id || state.filmOrderLink?.id || 'film-order-link-row-1',
          org_id: params[0],
          link_id: params[1],
          film_order_id: params[2],
          box_id: params[3],
          ordered_feet: params[4],
          auto_allocated_feet: params[5],
          created_at: params[6] || state.filmOrderLink?.created_at || '2026-04-23T09:05:00Z',
          created_by: params[7],
        };
        saveLinkState(row);
        return { rows: [{ ...row }] };
      }

      if (sql.includes('insert into app.film_orders') && sql.includes('on conflict (org_id, film_order_id) do update set')) {
        state.filmOrder = {
          id: state.filmOrder?.id || 'film-order-row-1',
          org_id: params[0],
          film_order_id: params[1],
          requirement_id: params[2] || state.filmOrder?.requirement_id || null,
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
          created_at: params[20] || state.filmOrder?.created_at || '2026-04-23T09:05:00Z',
          created_by: params[21],
        };
        return { rows: [{ ...state.filmOrder }] };
      }

      if (sql.includes('insert into app.boxes') && sql.includes('on conflict (org_id, box_id) do update set')) {
        const existingBox = getBoxes().find((entry) => entry.box_id === params[1]) || state.box;
        const row = {
          id: existingBox?.id || 'box-row-1',
          org_id: params[0],
          box_id: params[1],
          warehouse: params[2],
          owner_company_id: params[3] || existingBox?.owner_company_id || null,
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
          created_at: existingBox?.created_at || '2026-04-23T09:00:00Z',
          updated_at: '2026-04-23T10:00:00Z',
        };
        saveBoxState(row);
        return { rows: [withBoxMetrics(row)] };
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
      coreType: 'Red plastic',
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
  assert.equal(response.data.box.coreType, 'Red plastic');
  assert.equal(response.data.box.coreWeightLbs, 0.925);
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

test('recalculateFilmOrder trusts corrected linked box LF instead of stale link ordered feet', async () => {
  const client = createRecordingClient();
  client.state.box = createBoxRow({
    initial_feet: 100,
    feet_available: 100,
    width_in: 36,
    status: 'ORDERED',
  });
  client.state.filmOrder = createFilmOrderRow({
    requested_feet: 230,
    ordered_feet: 230,
    remaining_to_order_feet: 0,
    status: 'FILM_ON_THE_WAY',
  });
  client.state.filmOrderLink = createFilmOrderLinkRow({
    ordered_feet: 230,
    auto_allocated_feet: 0,
  });

  await recalculateFilmOrder(client, 'org-1', 'FO-RECEIVE-1', 'warehouse-user');

  assert.equal(client.state.filmOrder.ordered_feet, 100);
  assert.equal(client.state.filmOrder.remaining_to_order_feet, 130);
  assert.equal(client.state.filmOrder.status, 'FILM_ORDER');
  assert.equal(client.state.filmOrder.resolved_at, null);
  assert.equal(client.state.filmOrder.resolved_by, '');
});

test('recalculateFilmOrder keeps finalized receipt LF after physical allocation reconciliation', async () => {
  const client = createRecordingClient();
  client.state.box = createBoxRow({
    initial_feet: 82,
    feet_available: 0,
    width_in: 36,
    status: 'IN_STOCK',
    received_date: '2026-04-23',
  });
  client.state.filmOrder = createFilmOrderRow({
    requested_feet: 82,
    covered_feet: 82,
    ordered_feet: 82,
    remaining_to_order_feet: 0,
    status: 'FULFILLED',
    resolved_at: '2026-04-23T10:00:00Z',
    resolved_by: 'warehouse-user',
  });
  client.state.filmOrderLink = createFilmOrderLinkRow({
    ordered_feet: 82,
    auto_allocated_feet: 82,
    receipt_contribution_feet: 82,
    receipt_source_width_in: 36,
    receipt_finalized_at: '2026-04-23T10:00:00Z',
    receipt_finalized_by: 'warehouse-user',
    receipt_capture_source: 'LIVE_RECEIPT',
  });
  client.state.allocations = [
    createAllocationRow({
      allocated_feet: 80,
      covered_feet: 80,
      film_order_id: 'FO-RECEIVE-1',
      status: 'ACTIVE',
    }),
  ];

  await recalculateFilmOrder(client, 'org-1', 'FO-RECEIVE-1', 'warehouse-user');

  assert.equal(client.state.filmOrder.covered_feet, 80);
  assert.equal(client.state.filmOrder.ordered_feet, 82);
  assert.equal(client.state.filmOrder.remaining_to_order_feet, 0);
  assert.equal(client.state.filmOrder.status, 'FULFILLED');
  assert.equal(client.state.filmOrder.resolved_at, '2026-04-23T10:00:00.000Z');
  assert.equal(client.state.filmOrder.resolved_by, 'warehouse-user');
  assert.equal(client.state.filmOrderLink.auto_allocated_feet, 80);
  assert.equal(client.state.filmOrderLink.receipt_contribution_feet, 82);
});

test('receiveOrderedBox preserves existing core metrics when core type is omitted', async () => {
  const client = createRecordingClient();
  client.state.box = createBoxRow({
    core_type: 'White plastic',
    core_weight_lbs: 1,
  });

  const response = await receiveOrderedBox(
    client,
    'org-1',
    {
      boxId: 'IL1-ORDERED-1',
    },
    'warehouse-user'
  );

  assert.equal(response.ok, true);
  assert.equal(response.data.box.coreType, 'White plastic');
  assert.equal(response.data.box.coreWeightLbs, 1);
});

test('receiveOrderedBox rejects invalid submitted core type', async () => {
  const client = createRecordingClient();

  await assert.rejects(
    () =>
      receiveOrderedBox(
        client,
        'org-1',
        {
          boxId: 'IL1-ORDERED-1',
          coreType: 'Unsupported core',
        },
        'warehouse-user'
      ),
    /CoreType must be White plastic/
  );
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
    /100 covered LF \(100 physical LF\) placeholder from IL1-ORDERED-1 was resolved to job 5555 for Film Order FO-RECEIVE-1/i
  );
  assert.equal(client.state.allocations.length, 1);
  assert.equal(client.state.allocations[0].allocation_id, 'ALLOC-PLACEHOLDER-1');
  assert.equal(client.state.allocations[0].film_order_id, 'FO-RECEIVE-1');
  assert.equal(client.state.allocations[0].allocation_source, 'FILM_ORDER_RECEIPT');
  assert.equal(client.state.allocations[0].covered_feet, 100);
  assert.equal(client.state.filmOrder.covered_feet, 100);
  assert.equal(client.state.filmOrder.status, 'FULFILLED');
  assert.equal(client.state.filmOrderLink.auto_allocated_feet, 100);
  assert.equal(client.state.box.feet_available, 0);
});

test('receiveOrderedBox accepts corrected received LF below existing allocation and reconciles the shortage', async () => {
  const client = createRecordingClient();
  client.state.box = createBoxRow({
    initial_feet: 82,
    feet_available: 82,
  });
  client.state.filmOrder = createFilmOrderRow({
    requested_feet: 82,
    covered_feet: 0,
    ordered_feet: 82,
    remaining_to_order_feet: 0,
    status: 'FILM_ON_THE_WAY',
  });
  client.state.filmOrderLink = createFilmOrderLinkRow({
    ordered_feet: 82,
    auto_allocated_feet: 0,
  });
  client.state.jobRequirements = [
    createJobRequirementRow({
      required_feet: 82,
    }),
  ];
  client.state.allocations = [
    createAllocationRow({
      allocated_feet: 82,
      covered_feet: 82,
    }),
  ];

  const response = await receiveOrderedBox(
    client,
    'org-1',
    {
      boxId: 'IL1-ORDERED-1',
      currentFeetOnRoll: 80,
    },
    'warehouse-user'
  );

  assert.equal(response.ok, true);
  assert.equal(client.state.box.initial_feet, 80);
  assert.equal(client.state.box.feet_available, 0);
  assert.equal(client.state.allocations.length, 1);
  assert.equal(client.state.allocations[0].status, 'ACTIVE');
  assert.equal(client.state.allocations[0].allocated_feet, 80);
  assert.equal(client.state.allocations[0].covered_feet, 80);
  assert.equal(client.state.allocations[0].film_order_id, 'FO-RECEIVE-1');
  assert.equal(client.state.filmOrderLink.auto_allocated_feet, 80);
  assert.equal(client.state.filmOrder.ordered_feet, 80);
  assert.equal(client.state.filmOrder.remaining_to_order_feet, 2);
  assert.equal(client.state.filmOrder.status, 'FILM_ORDER');
  assert.match(client.state.auditEntries[0].notes, /with 80 LF recorded/);
  assert.match(response.warnings.join(' '), /Reduced allocation ALLOC-PLACEHOLDER-1/i);
});

test('receiveOrderedBox canonicalizes compatible film aliases across multiple linked boxes without duplicate rows', async () => {
  const client = createRecordingClient();
  client.state.boxes = [
    createBoxRow({
      id: 'box-row-6944',
      box_id: 'IL1-6944',
      manufacturer: 'Llumar',
      film_name: 'Frost NRMPS2',
      width_in: 48,
      initial_feet: 100,
      feet_available: 100,
    }),
    createBoxRow({
      id: 'box-row-6945',
      box_id: 'IL1-6945',
      manufacturer: 'Llumar',
      film_name: 'Frost NRMPS2',
      width_in: 48,
      initial_feet: 100,
      feet_available: 100,
    }),
    createBoxRow({
      id: 'box-row-6946',
      box_id: 'IL1-6946',
      manufacturer: 'Llumar',
      film_name: 'Frost NRMPS2',
      width_in: 48,
      initial_feet: 30,
      feet_available: 30,
    }),
  ];
  client.state.box = client.state.boxes[0];
  client.state.filmOrder = createFilmOrderRow({
    film_order_id: '20260416123431490-540',
    job_number: '4486',
    manufacturer: 'Llumar',
    film_name: 'Frost NRMPS2',
    width_in: 48,
    requested_feet: 230,
    covered_feet: 0,
    ordered_feet: 230,
    job_date: null,
  });
  client.state.filmOrderLinks = [
    createFilmOrderLinkRow({
      id: 'link-row-6944',
      link_id: 'link-6944',
      film_order_id: '20260416123431490-540',
      box_id: 'IL1-6944',
      ordered_feet: 100,
    }),
    createFilmOrderLinkRow({
      id: 'link-row-6945',
      link_id: 'link-6945',
      film_order_id: '20260416123431490-540',
      box_id: 'IL1-6945',
      ordered_feet: 100,
    }),
    createFilmOrderLinkRow({
      id: 'link-row-6946',
      link_id: 'link-6946',
      film_order_id: '20260416123431490-540',
      box_id: 'IL1-6946',
      ordered_feet: 30,
    }),
  ];
  client.state.filmOrderLink = client.state.filmOrderLinks[0];
  client.state.jobRequirements = [
    createJobRequirementRow({
      id: 'req-4486',
      job_number: '4486',
      manufacturer: 'Llumar',
      film_name: 'Frost (NRM PS2)',
      width_in: 48,
      required_feet: 230,
    }),
  ];
  client.state.allocations = [
    createAllocationRow({
      id: 'allocation-row-6944',
      allocation_id: 'ALLOC-6944',
      box_id: 'IL1-6944',
      job_number: '4486',
      requirement_id: 'req-4486',
      allocated_feet: 100,
      covered_feet: 100,
      job_date: null,
    }),
    createAllocationRow({
      id: 'allocation-row-6945',
      allocation_id: 'ALLOC-6945',
      box_id: 'IL1-6945',
      job_number: '4486',
      requirement_id: 'req-4486',
      allocated_feet: 100,
      covered_feet: 100,
      job_date: null,
    }),
    createAllocationRow({
      id: 'allocation-row-6946',
      allocation_id: 'ALLOC-6946',
      box_id: 'IL1-6946',
      job_number: '4486',
      requirement_id: 'req-4486',
      allocated_feet: 30,
      covered_feet: 30,
      job_date: null,
    }),
  ];

  for (const boxId of ['IL1-6944', 'IL1-6945', 'IL1-6946']) {
    const response = await receiveOrderedBox(client, 'org-1', { boxId }, 'warehouse-user');
    assert.equal(response.ok, true);
  }

  const activeRows = client.state.allocations.filter((entry) => entry.status === 'ACTIVE');
  assert.equal(activeRows.length, 3);
  assert.deepEqual(
    activeRows.map((entry) => [entry.box_id, entry.allocated_feet, entry.film_order_id, entry.allocation_source]),
    [
      ['IL1-6944', 100, '20260416123431490-540', 'FILM_ORDER_RECEIPT'],
      ['IL1-6945', 100, '20260416123431490-540', 'FILM_ORDER_RECEIPT'],
      ['IL1-6946', 30, '20260416123431490-540', 'FILM_ORDER_RECEIPT'],
    ]
  );
  assert.equal(activeRows.reduce((total, entry) => total + entry.allocated_feet, 0), 230);
  assert.deepEqual(
    client.state.filmOrderLinks.map((entry) => [entry.box_id, entry.ordered_feet, entry.auto_allocated_feet]),
    [
      ['IL1-6944', 100, 100],
      ['IL1-6945', 100, 100],
      ['IL1-6946', 30, 30],
    ]
  );
  assert.equal(client.state.filmOrder.covered_feet, 230);
  assert.equal(client.state.filmOrder.status, 'FULFILLED');
  assert.deepEqual(
    client.state.boxes.map((entry) => [entry.box_id, entry.feet_available]),
    [
      ['IL1-6944', 0],
      ['IL1-6945', 0],
      ['IL1-6946', 0],
    ]
  );
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
