import test from 'node:test';
import assert from 'node:assert/strict';

import { mapDbFilmOrderRow, toPublicFilmOrder } from '../../src/app/repositories/mappers.mjs';
import { reconcileAutoShortageFilmOrdersForRequirement } from '../../src/app/services/runtime/runtimeAutoShortageFilmOrders.mjs';

function asTrimmedString(value) {
  return String(value || '').trim();
}

function createSavedFilmOrderRow(params) {
  return {
    id: 'film-order-row-1',
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
    job_date: params[12],
    crew_leader: params[13],
    status: params[14],
    source_box_id: params[15],
    resolved_at: params[16],
    resolved_by: params[17],
    notes: params[18],
    created_at: params[19],
    created_by: params[20],
  };
}

function createRecordingClient(options = {}) {
  const calls = [];
  const filmOrderRowsByJob = Array.isArray(options.filmOrderRowsByJob) ? options.filmOrderRowsByJob : [];
  const filmOrderLinksById = options.filmOrderLinksById || {};
  const allocationsByFilmOrderId = options.allocationsByFilmOrderId || {};
  return {
    calls,
    async query(text, params = []) {
      const sql = String(text);
      calls.push({ text, params });

      if (sql.includes('from app.film_orders') && sql.includes('upper(trim(job_number))')) {
        return { rows: filmOrderRowsByJob };
      }

      if (sql.includes('from app.film_order_box_links')) {
        return { rows: filmOrderLinksById[asTrimmedString(params[1])] || [] };
      }

      if (sql.includes('from app.allocations') && sql.includes('film_order_id = $2')) {
        return { rows: allocationsByFilmOrderId[asTrimmedString(params[1])] || [] };
      }

      if (sql.includes('insert into app.film_orders')) {
        const row = createSavedFilmOrderRow(params);
        return {
          rows: [row],
        };
      }

      throw new Error(`Unexpected query during test: ${sql.trim()}`);
    },
  };
}

test('mapDbFilmOrderRow derives MANUAL origin when no source box is present', () => {
  const entry = mapDbFilmOrderRow({
    id: 'row-1',
    org_id: 'org-1',
    film_order_id: 'FO-1',
    job_number: '4447',
    warehouse: 'IL1',
    manufacturer: 'Security',
    film_name: '3M Ultra S800',
    width_in: 60,
    requested_feet: 100,
    covered_feet: 0,
    ordered_feet: 0,
    remaining_to_order_feet: 100,
    status: 'FILM_ORDER',
    source_box_id: '',
    created_at: '2026-04-16T15:47:48.884Z',
    created_by: 'tester',
  });

  assert.equal(entry.origin, 'MANUAL');
  assert.equal(toPublicFilmOrder(entry, []).origin, 'MANUAL');
});

test('mapDbFilmOrderRow derives AUTO_SHORTAGE origin when a source box is present', () => {
  const entry = mapDbFilmOrderRow({
    id: 'row-2',
    org_id: 'org-1',
    film_order_id: 'FO-2',
    job_number: '4447',
    warehouse: 'IL1',
    manufacturer: 'Security',
    film_name: '3M Ultra S800',
    width_in: 60,
    requested_feet: 41,
    covered_feet: 0,
    ordered_feet: 0,
    remaining_to_order_feet: 41,
    status: 'FILM_ORDER',
    source_box_id: 'IL1-6923',
    created_at: '2026-04-16T18:18:00.000Z',
    created_by: 'tester',
  });

  assert.equal(entry.origin, 'AUTO_SHORTAGE');
  assert.equal(toPublicFilmOrder(entry, []).origin, 'AUTO_SHORTAGE');
});

test('reconcileAutoShortageFilmOrdersForRequirement keeps the shortage order width on the unmet requirement', async () => {
  const client = createRecordingClient();

  const result = await reconcileAutoShortageFilmOrdersForRequirement(client, 'org-1', {
    actor: 'tester',
    job: {
      id: 'job-1',
      jobNumber: '4447',
      installDate: '2026-04-24',
      crewLeader: 'Napo',
    },
    jobNumber: '4447',
    requirement: {
      manufacturer: 'Security',
      filmName: '3M Ultra S800',
      widthIn: 60,
    },
    targetRequestedFeet: 41,
    sourceBox: {
      boxId: 'IL1-6923',
      warehouse: 'IL1',
      widthIn: 72,
    },
    warehouse: 'IL1',
  });

  assert.equal(result.created?.widthIn, 60);
  assert.equal(result.created?.requestedFeet, 41);
  assert.equal(result.created?.sourceBoxId, 'IL1-6923');
  assert.equal(result.created?.origin, 'AUTO_SHORTAGE');
  assert.equal(
    client.calls.some((call) => String(call.text).includes('insert into app.film_orders')),
    true,
  );
});

test('reconcileAutoShortageFilmOrdersForRequirement updates orphan shortage orders with indexed warehouses', async () => {
  const client = createRecordingClient({
    filmOrderRowsByJob: [
      {
        id: 'row-3',
        org_id: 'org-1',
        film_order_id: 'FO-ORPHAN',
        job_id: 'job-1',
        job_number: '4447',
        warehouse: 'IL',
        manufacturer: 'Security',
        film_name: '3M Ultra S800',
        width_in: 60,
        requested_feet: 20,
        covered_feet: 0,
        ordered_feet: 0,
        remaining_to_order_feet: 20,
        job_date: '2026-04-20',
        crew_leader: 'Old Crew',
        status: 'FILM_ORDER',
        source_box_id: 'IL-OLD-BOX',
        created_at: '2026-04-16T18:18:00.000Z',
        created_by: 'tester',
        resolved_at: null,
        resolved_by: '',
        notes: '',
      },
    ],
    filmOrderLinksById: {
      'FO-ORPHAN': [],
    },
    allocationsByFilmOrderId: {
      'FO-ORPHAN': [],
    },
  });

  const result = await reconcileAutoShortageFilmOrdersForRequirement(client, 'org-1', {
    actor: 'tester',
    job: {
      id: 'job-1',
      jobNumber: '4447',
      installDate: '2026-04-24',
      crewLeader: 'Napo',
    },
    jobNumber: '4447',
    requirement: {
      manufacturer: 'Security',
      filmName: '3M Ultra S800',
      widthIn: 60,
    },
    targetRequestedFeet: 41,
    sourceBox: {
      boxId: 'IL1-6923',
      warehouse: 'IL1',
      widthIn: 72,
    },
    warehouse: 'IL1',
  });

  assert.equal(result.created, null);
  assert.equal(result.updated?.filmOrderId, 'FO-ORPHAN');
  assert.equal(result.updated?.warehouse, 'IL1');
  assert.equal(result.updated?.requestedFeet, 41);
  assert.equal(result.updated?.remainingToOrderFeet, 41);
  assert.equal(result.updated?.sourceBoxId, 'IL1-6923');
  assert.equal(result.updated?.installDate, '2026-04-24');
  assert.equal(result.updated?.crewLeader, 'Napo');
  assert.equal(result.deleted.length, 0);
});
