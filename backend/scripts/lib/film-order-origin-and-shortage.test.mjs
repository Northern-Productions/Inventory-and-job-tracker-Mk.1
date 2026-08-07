import test from 'node:test';
import assert from 'node:assert/strict';

import { mapDbFilmOrderRow, toPublicFilmOrder } from '../../src/app/repositories/mappers.mjs';
import { reconcileAutoShortageFilmOrdersForRequirement } from '../../src/app/services/runtime/runtimeAutoShortageFilmOrders.mjs';
import { enrichOpenFilmOrdersWithJobSchedule } from '../../src/app/services/runtime/runtimeFilmOrderSchedule.mjs';

function asTrimmedString(value) {
  return String(value || '').trim();
}

function createSavedFilmOrderRow(params) {
  return {
    id: 'film-order-row-1',
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
    job_date: params[13],
    crew_leader: params[14],
    status: params[15],
    source_box_id: params[16],
    resolved_at: params[17],
    resolved_by: params[18],
    notes: params[19],
    created_at: params[20],
    created_by: params[21],
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

test('toPublicFilmOrder exposes additive jobId when the row has job_id', () => {
  const entry = mapDbFilmOrderRow({
    id: 'row-job-id',
    org_id: 'org-1',
    film_order_id: 'FO-JOB-ID',
    job_id: '11111111-1111-4111-8111-111111111111',
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
    stored_status: 'FILM_ORDER',
    display_status: 'FULFILLED_COVERED',
    need_source: 'CURRENT_REQUIREMENT',
    needed_feet: 100,
    fulfilled_feet: 125,
    remaining_feet: 0,
    overage_feet: 25,
    source_box_id: '',
    created_at: '2026-04-16T15:47:48.884Z',
    created_by: 'tester',
  });
  const publicEntry = toPublicFilmOrder(entry, []);

  assert.equal(publicEntry.jobId, '11111111-1111-4111-8111-111111111111');
  assert.equal(publicEntry.jobNumber, '4447');
  assert.deepEqual(
    {
      storedStatus: publicEntry.storedStatus,
      displayStatus: publicEntry.displayStatus,
      needSource: publicEntry.needSource,
      neededFeet: publicEntry.neededFeet,
      fulfilledFeet: publicEntry.fulfilledFeet,
      remainingFeet: publicEntry.remainingFeet,
      overageFeet: publicEntry.overageFeet,
    },
    {
      storedStatus: 'FILM_ORDER',
      displayStatus: 'FULFILLED_COVERED',
      needSource: 'CURRENT_REQUIREMENT',
      neededFeet: 100,
      fulfilledFeet: 125,
      remainingFeet: 0,
      overageFeet: 25,
    },
  );
});

test('toPublicFilmOrder exposes additive Work Scope fields when the row has sections', () => {
  const entry = mapDbFilmOrderRow({
    id: 'row-work-scope',
    org_id: 'org-1',
    film_order_id: 'FO-SCOPE',
    job_id: '11111111-1111-4111-8111-111111111111',
    job_number: '4447',
    warehouse: 'IL1',
    sections: 'Sections 4, 5',
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
  const publicEntry = toPublicFilmOrder(entry, []);

  assert.equal(publicEntry.workScope, 'Sections 4, 5');
  assert.equal(publicEntry.sections, 'Sections 4, 5');
});

test('toPublicFilmOrder preserves legacy records without jobId', () => {
  const entry = mapDbFilmOrderRow({
    id: 'row-legacy',
    org_id: 'org-1',
    film_order_id: 'FO-LEGACY',
    job_id: null,
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
  const publicEntry = toPublicFilmOrder(entry, []);

  assert.equal(Object.prototype.hasOwnProperty.call(publicEntry, 'jobId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(publicEntry, 'workScope'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(publicEntry, 'sections'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(publicEntry, 'displayStatus'), false);
  assert.equal(publicEntry.jobNumber, '4447');
});

test('enrichOpenFilmOrdersWithJobSchedule attaches Work Scope by jobId without jobNumber lookup', async () => {
  const jobId = '11111111-1111-4111-8111-111111111111';
  const client = {
    calls: [],
    async query(text, params = []) {
      const sql = String(text);
      this.calls.push({ text: sql, params });

      if (sql.includes('from app.jobs') && sql.includes('id = $2')) {
        return {
          rows: [
            {
              id: jobId,
              org_id: 'org-1',
              job_number: '4447',
              warehouse: 'IL1',
              sections: 'Sections 4, 5',
              due_date: '2026-04-16',
              crew_leader: 'Crew',
              lifecycle_status: 'ACTIVE',
            },
          ],
        };
      }

      throw new Error(`Unexpected query during test: ${sql.trim()}`);
    },
  };

  const [entry] = await enrichOpenFilmOrdersWithJobSchedule(client, 'org-1', [
    {
      filmOrderId: 'FO-SCOPE',
      jobId,
      jobNumber: '4447',
      warehouse: 'IL1',
      installDate: '2026-04-16',
      crewLeader: 'Crew',
      status: 'FILM_ORDER',
    },
  ]);

  assert.equal(entry.workScope, 'Sections 4, 5');
  assert.equal(entry.sections, 'Sections 4, 5');
  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0].text, /id = \$2/);
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

test('reconcileAutoShortageFilmOrdersForRequirement no longer creates shortage film orders', async () => {
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

  assert.equal(result.created, null);
  assert.equal(result.updated, null);
  assert.deepEqual(result.deleted, []);
  assert.equal(result.committedRequestedFeet, 0);
  assert.equal(result.targetRequestedFeet, 41);
  assert.equal(
    client.calls.some((call) => String(call.text).includes('insert into app.film_orders')),
    false,
  );
});

test('reconcileAutoShortageFilmOrdersForRequirement preserves legacy orphan shortage orders', async () => {
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
  assert.equal(result.updated, null);
  assert.equal(result.deleted.length, 0);
  assert.equal(
    client.calls.some((call) => String(call.text).includes('update app.film_orders')),
    false,
  );
});
