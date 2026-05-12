import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { deleteFilmOrder } from '../../src/app/services/runtime/runtimeJobsMutations.mjs';
import { validateFilmOrderJobMutationOwnership } from '../../../shared/domain/filmOrderMutationIdentity.mjs';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_JOB_ID = '22222222-2222-4222-8222-222222222222';

function buildJobRow(overrides = {}) {
  return {
    id: JOB_ID,
    org_id: 'org-1',
    job_number: '19413',
    warehouse: 'IL1',
    sections: 'Section 1',
    due_date: '2026-04-24',
    crew_leader: 'Crew',
    lifecycle_status: 'ACTIVE',
    is_labor_only: false,
    is_staged_for_pickup: false,
    notes: '',
    created_at: '2026-04-20T10:00:00Z',
    created_by: 'tester',
    updated_at: '2026-04-20T10:00:00Z',
    updated_by: 'tester',
    ...overrides,
  };
}

function buildFilmOrderRow(overrides = {}) {
  return {
    id: 'film-order-row-1',
    org_id: 'org-1',
    film_order_id: 'FO-1',
    job_id: JOB_ID,
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

function createRuntimeDeleteClient({ job = buildJobRow(), filmOrder = buildFilmOrderRow() } = {}) {
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

      if (sql.startsWith('delete from app.film_order_box_links')) {
        state.deletedLinkFilmOrderIds.push(params[1]);
        return { rows: [] };
      }

      if (sql.startsWith('delete from app.film_orders')) {
        state.deletedFilmOrderIds.push(params[1]);
        return { rows: [] };
      }

      if (sql.includes('from app.jobs') && sql.includes('and id = $2')) {
        return {
          rows: job && job.id === params[1] ? [{ ...job }] : [],
        };
      }

      if (sql.includes('from app.film_orders') && sql.includes('film_order_id = $2')) {
        return {
          rows: filmOrder && filmOrder.film_order_id === params[1] ? [{ ...filmOrder }] : [],
        };
      }

      if (sql.includes('from app.allocations') && sql.includes('film_order_id = $2')) {
        return { rows: [] };
      }

      if (sql.includes('from app.film_order_box_links') && sql.includes('film_order_id = $2')) {
        return { rows: [] };
      }

      throw new Error(`Unexpected query in film-order delete identity test: ${sql}`);
    },
  };
}

test('shared film order ownership accepts selected jobId film order rows', () => {
  const result = validateFilmOrderJobMutationOwnership({
    filmOrder: {
      filmOrderId: 'FO-1',
      jobId: JOB_ID,
      jobNumber: '19413',
    },
    filmOrderId: 'FO-1',
    target: {
      jobId: JOB_ID,
      jobNumber: '19413',
    },
    normalizeJobNumberDigits: (value) => String(value || '').trim(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.jobId, JOB_ID);
  assert.equal(result.jobNumber, '19413');
});

test('shared film order ownership rejects rows from another job before delete', () => {
  const result = validateFilmOrderJobMutationOwnership({
    filmOrder: {
      filmOrderId: 'FO-other',
      jobId: OTHER_JOB_ID,
      jobNumber: '19413',
    },
    filmOrderId: 'FO-other',
    target: {
      jobId: JOB_ID,
      jobNumber: '19413',
    },
    normalizeJobNumberDigits: (value) => String(value || '').trim(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'FILM_ORDER_JOB_ID_MISMATCH');
  assert.match(result.message, /different job/);
});

test('backend deleteFilmOrder validates jobId ownership before existing delete behavior', async () => {
  const client = createRuntimeDeleteClient();

  const response = await deleteFilmOrder(
    client,
    'org-1',
    {
      jobId: JOB_ID,
      jobNumber: '19413',
      filmOrderId: 'FO-1',
      reason: 'Delete selected film order.',
    },
    'tester'
  );

  assert.equal(response.ok, true);
  assert.equal(response.data.filmOrderId, 'FO-1');
  assert.deepEqual(client.state.deletedLinkFilmOrderIds, ['FO-1']);
  assert.deepEqual(client.state.deletedFilmOrderIds, ['FO-1']);
});

test('backend deleteFilmOrder rejects mismatched jobId and jobNumber before film order mutation', async () => {
  const client = createRuntimeDeleteClient();

  await assert.rejects(
    () =>
      deleteFilmOrder(
        client,
        'org-1',
        {
          jobId: JOB_ID,
          jobNumber: '99999',
          filmOrderId: 'FO-1',
        },
        'tester'
      ),
    /Job identity mismatch/
  );

  assert.deepEqual(client.state.deletedFilmOrderIds, []);
});

test('backend deleteFilmOrder rejects filmOrderId from another job before mutation', async () => {
  const client = createRuntimeDeleteClient({
    filmOrder: buildFilmOrderRow({
      job_id: OTHER_JOB_ID,
      job_number: '19413',
    }),
  });

  await assert.rejects(
    () =>
      deleteFilmOrder(
        client,
        'org-1',
        {
          jobId: JOB_ID,
          jobNumber: '19413',
          filmOrderId: 'FO-1',
        },
        'tester'
      ),
    /belongs to a different job/
  );

  assert.deepEqual(client.state.deletedFilmOrderIds, []);
});

test('film order delete guard stays transition-only while create, cancel, and planner remain jobNumber-based', () => {
  const deleteMigration = readFileSync(
    new URL('../../migrations/0089_guard_plain_pending_film_order_delete.sql', import.meta.url),
    'utf8'
  );
  const createMigration = readFileSync(
    new URL('../../migrations/0098_box_checkin_reconciliation.sql', import.meta.url),
    'utf8'
  );
  const cancelMigration = readFileSync(
    new URL('../../migrations/0110_preserve_caulk_on_film_order_cancel.sql', import.meta.url),
    'utf8'
  );
  const planner = readFileSync(
    new URL('../../src/app/services/runtime/runtimeAutoAllocationPlanner.mjs', import.meta.url),
    'utf8'
  );

  assert.match(deleteMigration, /where f\.org_id = p_org_id\s+and f\.film_order_id = v_film_order_id/s);
  assert.doesNotMatch(deleteMigration, /p_payload->>'jobId'/);
  assert.match(createMigration, /app_api\.get_or_resolve_job_id\(p_org_id, p_payload->>'jobNumber'\)/);
  assert.match(cancelMigration, /app_api\.require_text\(p_payload->>'jobNumber', 'JobNumber'\)/);
  assert.match(planner, /logicalPath === '\/film-orders\/delete'/);
  assert.match(planner, /buildFilmOrderDeletePlannerScope/);
});
