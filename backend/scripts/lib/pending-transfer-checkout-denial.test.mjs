import test from 'node:test';
import assert from 'node:assert/strict';

import { checkoutAllJobMaterials } from '../../src/app/services/runtime/runtimeCheckoutOperations.mjs';
import { setBoxStatus } from '../../src/app/services/runtime/boxes/statusTransitions.mjs';
import { executeSetJobStagedPickup } from '../../src/app/services/runtime/runtimeJobsRead.mjs';
import { HttpError } from '../../src/lib/http.mjs';
import {
  PENDING_TRANSFER_CHECKOUT_BLOCKED_CODE,
  PENDING_TRANSFER_CHECKOUT_BLOCKED_MESSAGE,
} from '../../../shared/checkoutSemantics.mjs';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';

function buildJobRow() {
  return {
    id: JOB_ID,
    org_id: ORG_ID,
    job_number: '123456',
    warehouse: 'DEST',
    lifecycle_status: 'ACTIVE',
    is_labor_only: false,
    is_staged_for_pickup: false,
  };
}

function buildAllocationRow(boxId, overrides = {}) {
  return {
    id: crypto.randomUUID(),
    org_id: ORG_ID,
    allocation_id: `allocation-${boxId.toLowerCase()}`,
    box_id: boxId,
    warehouse: 'DEST',
    job_id: JOB_ID,
    job_number: '123456',
    allocated_feet: 10,
    covered_feet: 10,
    backed_physical_feet: 10,
    reservation_state: 'WITH_INSTALL_DATE',
    allocation_kind: 'REQUIREMENT',
    allocation_source: 'MANUAL',
    status: 'ACTIVE',
    created_at: '2026-01-01T00:00:00.000Z',
    resolved_at: null,
    ...overrides,
  };
}

function buildBoxRow(boxId, overrides = {}) {
  return {
    id: crypto.randomUUID(),
    org_id: ORG_ID,
    box_id: boxId,
    warehouse: 'DEST',
    manufacturer: 'Synthetic',
    film_name: 'Synthetic Film',
    width_in: 60,
    initial_feet: 100,
    feet_available: 90,
    physical_feet_available: 100,
    active_allocated_feet: 10,
    allocation_planning_feet: 90,
    status: 'IN_STOCK',
    received_date: '2026-01-01',
    initial_weight_lbs: 20,
    last_roll_weight_lbs: 18,
    last_weighed_date: '2026-01-02',
    core_type: '3in Cardboard',
    core_weight_lbs: 2,
    lf_weight_lbs_per_ft: 0.1,
    ...overrides,
  };
}

function buildTransferRow(box, allocation) {
  return {
    id: crypto.randomUUID(),
    org_id: ORG_ID,
    transfer_id: `transfer-${box.box_id.toLowerCase()}`,
    box_record_id: box.id,
    source_box_id: box.box_id,
    destination_box_id: `${box.box_id}-DEST`,
    source_warehouse: box.warehouse,
    destination_warehouse: 'DEST',
    transfer_created_allocation_id: allocation.allocation_id,
    status: 'PENDING',
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

function buildCaulkAllocationRow(overrides = {}) {
  return {
    caulk_allocation_id: 'caulk-allocation-synthetic',
    requirement_id: crypto.randomUUID(),
    job_id: JOB_ID,
    job_number: '123456',
    product_id: crypto.randomUUID(),
    manufacturer_id: crypto.randomUUID(),
    manufacturer: 'Synthetic',
    product_name: 'Synthetic Sealant',
    product_code: 'SYN',
    tubes_per_case: 12,
    warehouse: 'DEST',
    allocated_tubes: 2,
    reserved_tubes_remaining: 2,
    checked_out_tubes_total: 0,
    returned_unused_tubes_total: 0,
    used_tubes_total: 0,
    overage_tubes_total: 0,
    outstanding_checkout_tubes: 0,
    open_checkout_count: 0,
    status: 'ACTIVE',
    allocation_source: 'MANUAL',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createSyntheticClient({
  boxes = [],
  allocations = [],
  transfers = [],
  caulkAllocations = [],
  failSavedBoxWith = null,
  failCaulkCheckoutWith = null,
} = {}) {
  const state = {
    boxes: structuredClone(boxes),
    allocations: structuredClone(allocations),
    transfers: structuredClone(transfers),
    caulkAllocations: structuredClone(caulkAllocations),
  };
  let savepointSnapshot = null;
  let writeAttempts = 0;
  let rollbackToSavepointCount = 0;

  const client = {
    async query(text, params = []) {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      const normalized = sql.toLowerCase();

      if (normalized === 'savepoint checkout_all_item') {
        savepointSnapshot = structuredClone(state);
        return { rows: [] };
      }
      if (normalized === 'rollback to savepoint checkout_all_item') {
        Object.assign(state, structuredClone(savepointSnapshot));
        rollbackToSavepointCount += 1;
        return { rows: [] };
      }
      if (normalized === 'release savepoint checkout_all_item') {
        savepointSnapshot = null;
        return { rows: [] };
      }
      if (normalized.includes('from app.jobs') && normalized.includes('and id = $2')) {
        return { rows: [buildJobRow()] };
      }
      if (normalized.includes('from app.allocations') && normalized.includes('and job_id = $2')) {
        return { rows: structuredClone(state.allocations) };
      }
      if (normalized.includes('from app.allocations') && normalized.includes('and box_id = $2')) {
        return { rows: structuredClone(state.allocations.filter((entry) => entry.box_id === params[1])) };
      }
      if (normalized.includes('from app.film_orders')) {
        return { rows: [] };
      }
      if (normalized.includes('from app.job_phases')) {
        return { rows: [] };
      }
      if (normalized.includes('from app.job_requirements')) {
        return { rows: [] };
      }
      if (normalized.includes('from app.job_caulk_requirements')) {
        return { rows: [] };
      }
      if (normalized.includes('from app.caulk_job_allocations')) {
        return { rows: structuredClone(state.caulkAllocations) };
      }
      if (normalized.includes('from app.boxes b') && normalized.includes('box_id = any')) {
        const requested = new Set((params[1] || []).map((entry) => String(entry).toUpperCase()));
        return { rows: structuredClone(state.boxes.filter((entry) => requested.has(entry.box_id))) };
      }
      if (normalized.includes('from app.box_transfers')) {
        return { rows: structuredClone(state.transfers) };
      }
      if (normalized.includes('select app_api.resolve_box_id_alias')) {
        return { rows: [{ box_id: params[1] }] };
      }
      if (normalized.includes('from app.boxes b') && normalized.includes('b.box_id = $2')) {
        const box = state.boxes.find((entry) => entry.box_id === params[1]);
        return { rows: box ? [structuredClone(box)] : [] };
      }
      if (normalized.includes('insert into app.allocations')) {
        writeAttempts += 1;
        const allocation = state.allocations.find((entry) => entry.allocation_id === params[1]);
        assert.ok(allocation, 'Synthetic allocation save must target a fixture allocation.');
        Object.assign(allocation, {
          box_id: params[2],
          job_id: params[3],
          job_number: params[4],
          warehouse: params[5],
          allocated_feet: params[7],
          covered_feet: params[8],
          status: params[10],
          resolved_at: params[13],
          resolved_by: params[14],
          notes: params[15],
        });
        return { rows: [structuredClone(allocation)] };
      }
      if (normalized.includes('select app_api.assert_film_box_allocation_capacity')) {
        return { rows: [{ ok: true }] };
      }
      if (normalized.includes('with saved_box as ( insert into app.boxes')) {
        writeAttempts += 1;
        if (failSavedBoxWith) {
          throw failSavedBoxWith;
        }
        const box = state.boxes.find((entry) => entry.box_id === params[1]);
        assert.ok(box, 'Synthetic box save must target a fixture box.');
        Object.assign(box, {
          warehouse: params[2],
          feet_available: params[9],
          status: params[11],
          has_ever_been_checked_out: params[26],
          last_checkout_job_id: params[27],
          last_checkout_job: params[28],
          last_checkout_date: params[29],
        });
        return { rows: [structuredClone(box)] };
      }
      if (normalized.includes('select public.api_acl_allocations_caulk_checkout')) {
        writeAttempts += 1;
        if (failCaulkCheckoutWith) {
          throw failCaulkCheckoutWith;
        }
        return { rows: [{ payload: { warnings: [] } }] };
      }

      throw new Error(`Unexpected synthetic query category: ${sql.slice(0, 80)}`);
    },
  };

  return {
    client,
    getState: () => structuredClone(state),
    getWriteAttempts: () => writeAttempts,
    getRollbackToSavepointCount: () => rollbackToSavepointCount,
  };
}

async function assertPurePendingTransferDenial(clientState, expectedState) {
  let caught;
  try {
    await checkoutAllJobMaterials(
      clientState.client,
      ORG_ID,
      { jobId: JOB_ID, jobNumber: '123456' },
      'synthetic-actor',
    );
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof HttpError);
  const envelope = {
    ok: false,
    error: caught.message,
    warnings: caught.warnings,
    ...(caught.details || {}),
  };
  assert.deepEqual(envelope, {
    ok: false,
    error: PENDING_TRANSFER_CHECKOUT_BLOCKED_MESSAGE,
    warnings: [],
    code: PENDING_TRANSFER_CHECKOUT_BLOCKED_CODE,
  });
  assert.equal(caught.statusCode, 409);
  assert.doesNotMatch(JSON.stringify(envelope), /synthetic|allocation-|transfer-/i);
  assert.deepEqual(clientState.getState(), expectedState);
}

test('checkout-all rejects an all-film pending-transfer request without a business-row delta', async () => {
  const allocation = buildAllocationRow('BOX-BLOCKED', { warehouse: 'SRC' });
  const box = buildBoxRow('BOX-BLOCKED', { warehouse: 'SRC', status: 'TRANSFER' });
  const clientState = createSyntheticClient({
    boxes: [box],
    allocations: [allocation],
    transfers: [buildTransferRow(box, allocation)],
  });
  const before = clientState.getState();

  await assertPurePendingTransferDenial(clientState, before);
  assert.equal(clientState.getWriteAttempts(), 0);
});

test('checkout-all rejects an all-caulk pending-transfer request without a business-row delta', async () => {
  const caulkAllocation = buildCaulkAllocationRow({
    pending_transfer_id: 'caulk-transfer-synthetic',
    pending_transfer_source_warehouse: 'SRC',
    pending_transfer_destination_warehouse: 'DEST',
    pending_transfer_tubes: 2,
  });
  const clientState = createSyntheticClient({ caulkAllocations: [caulkAllocation] });
  const before = clientState.getState();

  await assertPurePendingTransferDenial(clientState, before);
  assert.equal(clientState.getWriteAttempts(), 0);
});

test('checkout-all preserves mixed partial success when same-job resolve-only work succeeds', async () => {
  const blockedAllocation = buildAllocationRow('BOX-BLOCKED', { warehouse: 'SRC' });
  const blockedBox = buildBoxRow('BOX-BLOCKED', { warehouse: 'SRC', status: 'TRANSFER' });
  const resolveAllocation = buildAllocationRow('BOX-RESOLVE');
  const resolveBox = buildBoxRow('BOX-RESOLVE', {
    status: 'CHECKED_OUT',
    last_checkout_job_id: JOB_ID,
    last_checkout_job: '123456',
  });
  const clientState = createSyntheticClient({
    boxes: [blockedBox, resolveBox],
    allocations: [blockedAllocation, resolveAllocation],
    transfers: [buildTransferRow(blockedBox, blockedAllocation)],
  });

  const result = await checkoutAllJobMaterials(
    clientState.client,
    ORG_ID,
    { jobId: JOB_ID, jobNumber: '123456' },
    'synthetic-actor',
  );

  assert.match(result.warnings[0], /^Kept 1 allocation totaling 10 LF linked/);
  assert.match(result.warnings[1], /^Skipped 1 film box waiting for transfer\.$/);
  assert.equal(clientState.getState().allocations[1].resolved_by, 'synthetic-actor');
});

test('checkout-all preserves mixed partial success when an eligible box is physically checked out', async () => {
  const blockedAllocation = buildAllocationRow('BOX-BLOCKED', { warehouse: 'SRC' });
  const blockedBox = buildBoxRow('BOX-BLOCKED', { warehouse: 'SRC', status: 'TRANSFER' });
  const eligibleAllocation = buildAllocationRow('BOX-ELIGIBLE');
  const eligibleBox = buildBoxRow('BOX-ELIGIBLE');
  const clientState = createSyntheticClient({
    boxes: [blockedBox, eligibleBox],
    allocations: [blockedAllocation, eligibleAllocation],
    transfers: [buildTransferRow(blockedBox, blockedAllocation)],
  });

  const result = await checkoutAllJobMaterials(
    clientState.client,
    ORG_ID,
    { jobId: JOB_ID, jobNumber: '123456' },
    'synthetic-actor',
  );

  assert.equal(clientState.getState().boxes[1].status, 'CHECKED_OUT');
  assert.equal(clientState.getState().allocations[1].resolved_by, 'synthetic-actor');
  assert.equal(
    result.warnings[0],
    'No job requirements were found for job 123456, so no LF was auto-linked.',
  );
  assert.match(result.warnings[1], /^Kept 1 allocation totaling 10 LF linked/);
  assert.equal(result.warnings[2], 'Checked out 1 item for job 123456.');
  assert.equal(result.warnings[3], 'Skipped 1 film box waiting for transfer.');
});

test('checkout-all preserves ordinary eligible checkout and current no-eligible behavior', async () => {
  const allocation = buildAllocationRow('BOX-ELIGIBLE');
  const box = buildBoxRow('BOX-ELIGIBLE');
  const eligibleClient = createSyntheticClient({ boxes: [box], allocations: [allocation] });
  const eligibleResult = await checkoutAllJobMaterials(
    eligibleClient.client,
    ORG_ID,
    { jobId: JOB_ID, jobNumber: '123456' },
    'synthetic-actor',
  );

  assert.equal(eligibleClient.getState().boxes[0].status, 'CHECKED_OUT');
  assert.equal(eligibleClient.getState().allocations[0].resolved_by, 'synthetic-actor');
  assert.ok(eligibleResult.warnings.some((entry) => entry === 'Checked out 1 item for job 123456.'));

  const emptyClient = createSyntheticClient();
  const emptyResult = await checkoutAllJobMaterials(
    emptyClient.client,
    ORG_ID,
    { jobId: JOB_ID, jobNumber: '123456' },
    'synthetic-actor',
  );
  assert.deepEqual(emptyResult.warnings, ['No eligible material was available to check out.']);
});

test('checkout-all rolls a race-time film denial back to its item savepoint and sanitizes the response', async () => {
  const allocation = buildAllocationRow('BOX-RACE');
  const box = buildBoxRow('BOX-RACE');
  const databaseDenial = new HttpError(
    409,
    'Box BOX-RACE has a pending transfer and can only be received, cancelled, or have its linked claim released.',
  );
  const clientState = createSyntheticClient({
    boxes: [box],
    allocations: [allocation],
    failSavedBoxWith: databaseDenial,
  });
  const before = clientState.getState();

  await assertPurePendingTransferDenial(clientState, before);
  assert.equal(clientState.getRollbackToSavepointCount(), 1);
});

test('checkout-all recognizes the exact caulk race denial and propagates unrelated conflicts unchanged', async () => {
  const caulkRow = buildCaulkAllocationRow();
  const caulkError = Object.assign(
    new Error('Receive or cancel transfer TRANSFER-RACE before checking out this allocation.'),
    { detail: 'status=400' },
  );
  const caulkClient = createSyntheticClient({
    caulkAllocations: [caulkRow],
    failCaulkCheckoutWith: caulkError,
  });
  const caulkBefore = caulkClient.getState();
  await assertPurePendingTransferDenial(caulkClient, caulkBefore);
  assert.equal(caulkClient.getRollbackToSavepointCount(), 1);

  const allocation = buildAllocationRow('BOX-CONFLICT');
  const box = buildBoxRow('BOX-CONFLICT');
  const unrelated = new HttpError(409, 'Concurrent update conflict. Retry the request.');
  const unrelatedClient = createSyntheticClient({
    boxes: [box],
    allocations: [allocation],
    failSavedBoxWith: unrelated,
  });

  await assert.rejects(
    checkoutAllJobMaterials(
      unrelatedClient.client,
      ORG_ID,
      { jobId: JOB_ID, jobNumber: '123456' },
      'synthetic-actor',
    ),
    (error) => error === unrelated,
  );
  assert.equal(unrelatedClient.getRollbackToSavepointCount(), 1);
});

test('single-box status checkout keeps the existing pending-transfer denial and makes no write', async () => {
  const box = buildBoxRow('BOX-STATUS-BLOCKED', { status: 'TRANSFER' });
  const clientState = createSyntheticClient({ boxes: [box] });
  const before = clientState.getState();

  await assert.rejects(
    setBoxStatus(
      clientState.client,
      ORG_ID,
      { boxId: box.box_id, status: 'CHECKED_OUT', auditNote: 'Synthetic checkout' },
      'synthetic-actor',
    ),
    (error) =>
      error instanceof HttpError &&
      error.statusCode === 400 &&
      /has a pending transfer and can only be received or have the transfer cancelled\.$/.test(
        error.message,
      ),
  );
  assert.deepEqual(clientState.getState(), before);
  assert.equal(clientState.getWriteAttempts(), 0);
});

test('staged pickup keeps the existing pending-transfer denial before its update query', async () => {
  let updateCount = 0;

  await assert.rejects(
    executeSetJobStagedPickup(
      {},
      ORG_ID,
      '123456',
      true,
      'synthetic-actor',
      {},
      {
        nowIso: '2026-01-01T00:00:00.000Z',
        normalizeJobNumberDigits: (value) => String(value).trim(),
        asTrimmedString: (value) => String(value || '').trim(),
        resolveExistingOrLegacyJobHeader: async () => ({
          header: buildJobRow(),
          allocations: [],
          filmOrders: [],
        }),
        normalizeJobLifecycleStatus: () => 'ACTIVE',
        loadJobStagingValidationState: async () => ({
          blockingReason: 'A job with film still in transfer cannot be staged for pickup.',
        }),
        queryRow: async () => {
          updateCount += 1;
          return null;
        },
      },
    ),
    (error) =>
      error instanceof HttpError &&
      error.statusCode === 400 &&
      error.message === 'A job with film still in transfer cannot be staged for pickup.',
  );
  assert.equal(updateCount, 0);
});
