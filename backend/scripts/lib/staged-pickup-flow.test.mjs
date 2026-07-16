import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  mapDbAllocationRow,
  mapDbFilmOrderRow,
  mapDbJobPhaseRow,
  mapDbRequirementRow,
} from '../../src/app/repositories/mappers.mjs';
import { getJobStagingBlockingReason } from '../../src/app/services/runtime/runtimeJobSummaries.mjs';
import {
  buildJobStagingValidationState,
  loadJobStagingValidationState,
} from '../../src/app/services/runtime/runtimeCheckoutOperations.mjs';
import { executeSetJobStagedPickup } from '../../src/app/services/runtime/runtimeJobsRead.mjs';

function buildPhasedValidationState(overrides = {}) {
  const activeRequirement = {
    id: 'req-active',
    orgId: 'org-1',
    jobId: 'job-1',
    phaseId: 'phase-active',
    jobNumber: 'job-1',
    manufacturer: 'Test Film',
    filmName: 'Clear',
    widthIn: 60,
    requiredFeet: 10,
  };
  const inactiveRequirement = {
    id: 'req-inactive',
    orgId: 'org-1',
    jobId: 'job-1',
    phaseId: 'phase-placeholder',
    jobNumber: 'job-1',
    manufacturer: 'Test Film',
    filmName: 'Clear',
    widthIn: 60,
    requiredFeet: 10,
  };
  const activeAllocation = {
    id: 'allocation-row-active',
    allocationId: 'allocation-active',
    orgId: 'org-1',
    jobId: 'job-1',
    jobNumber: 'job-1',
    requirementId: 'req-active',
    boxId: 'BOX-ACTIVE',
    status: 'FULFILLED',
    allocationKind: 'REQUIREMENT',
    allocatedFeet: 10,
    coveredFeet: 10,
    resolvedAt: '2026-07-16T12:00:00Z',
  };
  const inactiveAllocation = {
    id: 'allocation-row-inactive',
    allocationId: 'allocation-inactive',
    orgId: 'org-1',
    jobId: 'job-1',
    jobNumber: 'job-1',
    requirementId: 'req-inactive',
    boxId: 'BOX-INACTIVE',
    status: 'ACTIVE',
    allocationKind: 'REQUIREMENT',
    allocatedFeet: 10,
    coveredFeet: 10,
  };
  const activeFilmOrder = {
    id: 'film-order-row-active',
    filmOrderId: 'film-order-active',
    orgId: 'org-1',
    jobId: 'job-1',
    jobNumber: 'job-1',
    requirementId: 'req-active',
    status: 'FILM_ORDER',
  };
  const inactiveFilmOrder = {
    id: 'film-order-row-inactive',
    filmOrderId: 'film-order-inactive',
    orgId: 'org-1',
    jobId: 'job-1',
    jobNumber: 'job-1',
    requirementId: 'req-inactive',
    status: 'FILM_ORDER',
  };

  return buildJobStagingValidationState({
    jobNumber: 'job-1',
    warehouse: 'IL1',
    phases: [
      {
        phaseId: 'phase-active',
        phaseNumber: 1,
        workflowStatus: 'ACTIVE',
        isPrimary: true,
      },
      {
        phaseId: 'phase-placeholder',
        phaseNumber: 2,
        workflowStatus: 'PLACEHOLDER',
      },
    ],
    requirements: [activeRequirement, inactiveRequirement],
    allocations: [activeAllocation, inactiveAllocation],
    filmOrders: [activeFilmOrder, inactiveFilmOrder],
    caulkRequirements: [],
    caulkAllocations: [],
    boxes: [
      {
        id: 'box-row-active',
        boxId: 'BOX-ACTIVE',
        manufacturer: 'Test Film',
        filmName: 'Clear',
        widthIn: 60,
        status: 'CHECKED_OUT',
      },
      {
        id: 'box-row-inactive',
        boxId: 'BOX-INACTIVE',
        manufacturer: 'Test Film',
        filmName: 'Clear',
        widthIn: 60,
        status: 'IN_STOCK',
      },
    ],
    pendingTransfersByBoxRecordId: {},
    ...overrides,
  });
}

test('phase-aware staging resolves reviewed requirement identity aliases canonically', () => {
  const identityShapes = [
    { id: 'req-active' },
    { requirementId: 'req-active' },
    { requirement_id: 'req-active' },
    {
      id: 'req-active',
      requirementId: 'req-active',
      requirement_id: 'req-active',
    },
    {
      id: '  ',
      requirementId: 'req-active',
      requirement_id: '',
    },
  ];

  for (const identityShape of identityShapes) {
    const state = buildPhasedValidationState({
      requirements: [
        {
          ...identityShape,
          orgId: 'org-1',
          jobId: 'job-1',
          phaseId: 'phase-active',
          jobNumber: 'job-1',
          manufacturer: 'Test Film',
          filmName: 'Clear',
          widthIn: 60,
          requiredFeet: 10,
        },
      ],
      allocations: [
        {
          allocationId: 'allocation-active',
          requirement_id: 'req-active',
          boxId: 'BOX-ACTIVE',
          jobNumber: 'job-1',
          status: 'FULFILLED',
          allocationKind: 'REQUIREMENT',
          allocatedFeet: 10,
          coveredFeet: 10,
          resolvedAt: '2026-07-16T12:00:00Z',
        },
      ],
      filmOrders: [
        {
          filmOrderId: 'film-order-active',
          requirement_id: 'req-active',
          jobNumber: 'job-1',
          status: 'FILM_ORDER',
        },
      ],
    });

    assert.equal(state.requirements[0].requirementId, 'req-active');
    assert.equal(state.publicRequirements[0].requirementId, 'req-active');
    assert.deepEqual(state.allocations.map((entry) => entry.allocationId), ['allocation-active']);
    assert.deepEqual(state.filmOrders.map((entry) => entry.filmOrderId), ['film-order-active']);
    assert.equal(state.publicRequirements[0].remainingFeet, 0);
  }
});

test('mapped phased requirement id retains its linked allocation and film order', () => {
  const phase = mapDbJobPhaseRow({
    id: 'phase-active',
    org_id: 'org-1',
    job_id: 'job-1',
    phase_number: 1,
    workflow_status: 'ACTIVE',
    labor_status: 'ACTIVE',
    is_primary: true,
  });
  const requirement = mapDbRequirementRow({
    id: 'req-active',
    org_id: 'org-1',
    job_id: 'job-1',
    phase_id: 'phase-active',
    job_number: 'job-1',
    manufacturer: 'Test Film',
    film_name: 'Clear',
    width_in: 60,
    required_feet: 10,
    status: 'ACTIVE',
  });
  const allocation = mapDbAllocationRow({
    id: 'allocation-row-active',
    allocation_id: 'allocation-active',
    org_id: 'org-1',
    job_id: 'job-1',
    job_number: 'job-1',
    requirement_id: 'req-active',
    box_id: 'BOX-ACTIVE',
    status: 'FULFILLED',
    allocation_kind: 'REQUIREMENT',
    allocated_feet: 10,
    covered_feet: 10,
    resolved_at: '2026-07-16T12:00:00Z',
  });
  const filmOrder = mapDbFilmOrderRow({
    id: 'film-order-row-active',
    film_order_id: 'film-order-active',
    org_id: 'org-1',
    job_id: 'job-1',
    job_number: 'job-1',
    requirement_id: 'req-active',
    warehouse: 'IL1',
    manufacturer: 'Test Film',
    film_name: 'Clear',
    width_in: 60,
    requested_feet: 10,
    status: 'FILM_ORDER',
  });
  const state = buildPhasedValidationState({
    phases: [phase],
    requirements: [requirement],
    allocations: [allocation],
    filmOrders: [filmOrder],
  });

  assert.equal(requirement.id, 'req-active');
  assert.equal(requirement.requirementId, undefined);
  assert.deepEqual(state.requirements.map((entry) => entry.requirementId), ['req-active']);
  assert.deepEqual(state.allocations.map((entry) => entry.allocationId), ['allocation-active']);
  assert.deepEqual(state.filmOrders.map((entry) => entry.filmOrderId), ['film-order-active']);
  assert.equal(state.publicRequirements[0].remainingFeet, 0);
});

test('phase-aware staging fails closed on conflicting or missing requirement identity', () => {
  assert.throws(
    () =>
      buildPhasedValidationState({
        requirements: [
          {
            id: 'req-active',
            requirementId: 'req-conflict',
            phaseId: 'phase-active',
            manufacturer: 'Test Film',
            filmName: 'Clear',
            widthIn: 60,
            requiredFeet: 10,
          },
        ],
      }),
    /Conflicting requirement identity aliases/,
  );

  assert.throws(
    () =>
      buildPhasedValidationState({
        requirements: [
          {
            phaseId: 'phase-active',
            description: 'Not an identity',
            manufacturer: 'Test Film',
            filmName: 'Clear',
            widthIn: 60,
            requiredFeet: 10,
          },
        ],
      }),
    /Active requirement is missing its canonical identity/,
  );

  assert.throws(
    () =>
      buildPhasedValidationState({
        allocations: [
          {
            allocationId: 'allocation-active',
            requirementId: 'req-active',
            requirement_id: 'req-conflict',
            boxId: 'BOX-ACTIVE',
            status: 'ACTIVE',
            allocationKind: 'REQUIREMENT',
            allocatedFeet: 10,
          },
        ],
      }),
    /Conflicting requirement identity aliases/,
  );
});

test('phase-aware staging keeps only active-phase linked material', () => {
  const state = buildPhasedValidationState();

  assert.deepEqual(state.requirements.map((entry) => entry.requirementId), ['req-active']);
  assert.deepEqual(state.allocations.map((entry) => entry.allocationId), ['allocation-active']);
  assert.deepEqual(state.filmOrders.map((entry) => entry.filmOrderId), ['film-order-active']);
  assert.equal(state.publicRequirements[0].remainingFeet, 0);
  assert.equal(state.blockingReason, '');
});

test('phase-null legacy requirement remains assigned to the active primary phase', () => {
  const state = buildPhasedValidationState({
    requirements: [
      {
        id: 'req-active',
        phaseId: '',
        jobNumber: 'job-1',
        manufacturer: 'Test Film',
        filmName: 'Clear',
        widthIn: 60,
        requiredFeet: 10,
      },
    ],
    allocations: [
      {
        allocationId: 'allocation-active',
        requirementId: 'req-active',
        boxId: 'BOX-ACTIVE',
        jobNumber: 'job-1',
        status: 'FULFILLED',
        allocationKind: 'REQUIREMENT',
        allocatedFeet: 10,
        coveredFeet: 10,
        resolvedAt: '2026-07-16T12:00:00Z',
      },
    ],
    filmOrders: [
      {
        filmOrderId: 'film-order-active',
        requirementId: 'req-active',
        jobNumber: 'job-1',
        status: 'FILM_ORDER',
      },
    ],
  });

  assert.deepEqual(state.requirements.map((entry) => entry.requirementId), ['req-active']);
  assert.deepEqual(state.allocations.map((entry) => entry.allocationId), ['allocation-active']);
  assert.deepEqual(state.filmOrders.map((entry) => entry.filmOrderId), ['film-order-active']);
});

test('phase-aware staging does not attach foreign requirement identities or row ids', () => {
  const state = buildPhasedValidationState({
    allocations: [
      {
        id: 'req-active',
        allocationId: 'allocation-own-row-id',
        requirementId: 'req-other-job',
        phaseId: 'phase-placeholder',
        boxId: 'BOX-ACTIVE',
        jobNumber: 'other-job',
        orgId: 'other-org',
        status: 'ACTIVE',
        allocationKind: 'REQUIREMENT',
        allocatedFeet: 10,
      },
    ],
    filmOrders: [
      {
        id: 'req-active',
        filmOrderId: 'film-order-own-row-id',
        requirementId: 'req-other-job',
        phaseId: 'phase-placeholder',
        jobNumber: 'other-job',
        orgId: 'other-org',
        status: 'FILM_ORDER',
      },
    ],
  });

  assert.deepEqual(state.allocations, []);
  assert.deepEqual(state.filmOrders, []);
  assert.equal(state.publicRequirements[0].remainingFeet, 10);
});

test('cancelled active-phase allocations do not become active requirement coverage', () => {
  const state = buildPhasedValidationState({
    allocations: [
      {
        allocationId: 'allocation-cancelled',
        requirementId: 'req-active',
        boxId: 'BOX-ACTIVE',
        jobNumber: 'job-1',
        status: 'CANCELLED',
        allocationKind: 'REQUIREMENT',
        allocatedFeet: 10,
        coveredFeet: 10,
      },
    ],
  });

  assert.deepEqual(state.allocations.map((entry) => entry.allocationId), ['allocation-cancelled']);
  assert.equal(state.publicRequirements[0].allocatedFeet, 0);
  assert.equal(state.publicRequirements[0].remainingFeet, 10);
});

test('legacy no-phase staging preserves identity shapes and linked rows unchanged', () => {
  const requirement = {
    requirement_id: '',
    description: 'Legacy requirement',
    requiredFeet: 0,
  };
  const allocation = {
    id: 'allocation-row',
    allocationId: 'allocation-legacy',
    requirementId: '',
    boxId: 'BOX-ACTIVE',
    status: 'ACTIVE',
    allocationKind: 'EXTRA',
    allocatedFeet: 1,
  };
  const filmOrder = {
    id: 'film-order-row',
    filmOrderId: 'film-order-legacy',
    requirementId: '',
    status: 'CANCELLED',
  };
  const state = buildPhasedValidationState({
    phases: [],
    requirements: [requirement],
    allocations: [allocation],
    filmOrders: [filmOrder],
  });

  assert.equal(state.requirements[0], requirement);
  assert.equal(state.allocations[0], allocation);
  assert.equal(state.filmOrders[0], filmOrder);
});

test('checkout-all, staged invalidation, and Edge remain aligned on staging state', async () => {
  const [checkoutSource, jobMutationSource, edgeSource] = await Promise.all([
    readFile(new URL('../../src/app/services/runtime/checkout/checkoutFlow.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../../src/app/services/runtime/runtimeJobsMutations.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../../../supabase/functions/_shared/api-handler.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(
    checkoutSource,
    /buildFilmCheckoutActionPlan\(\s*preCheckoutState\.allocations,\s*boxById,/,
  );
  assert.match(
    jobMutationSource,
    /const stagingState = await loadJobStagingValidationState\([\s\S]*if \(!stagingState\.blockingReason\) \{\s+return jobHeader;/,
  );
  assert.match(
    edgeSource,
    /function getRequirementId\(requirement: any\): string \{\s+return asTrimmedString\(requirement\?\.requirementId \|\| requirement\?\.id\);/,
  );
});

test('loadJobStagingValidationState only loads boxes linked to the job allocations', async () => {
  const boxLoadCalls = [];
  const pendingTransferCalls = [];
  const state = await loadJobStagingValidationState(
    {},
    'org-1',
    '18722',
    'IL1',
    {},
    {
      listAllocationsByJob: async () => [
        {
          allocationId: 'alloc-1',
          jobNumber: '18722',
          boxId: 'IL1-100',
          status: 'ACTIVE',
          allocationKind: 'REQUIREMENT',
          allocatedFeet: 25,
        },
        {
          allocationId: 'alloc-2',
          jobNumber: '18722',
          boxId: 'IL1-200',
          status: 'FULFILLED',
          allocationKind: 'REQUIREMENT',
          allocatedFeet: 0,
        },
      ],
      listFilmOrdersByJob: async () => [],
      listJobRequirementsByJob: async () => [],
      listJobCaulkRequirementsByJob: async () => [],
      listCaulkJobAllocationsByJob: async () => [],
      listBoxesByIds: async (_client, _orgId, boxIds) => {
        boxLoadCalls.push(boxIds);
        return [
          {
            id: 'box-record-1',
            boxId: 'IL1-100',
            warehouse: 'IL1',
            status: 'IN_STOCK',
            initialFeet: 100,
            feetAvailable: 75,
            activeAllocatedFeet: 25,
          },
        ];
      },
      listPendingBoxTransfersByBoxRecordIds: async (_client, _orgId, recordIds) => {
        pendingTransferCalls.push(recordIds);
        return [];
      },
      indexPendingBoxTransfersByBoxRecordId: () => ({}),
      listBoxes: async () => {
        throw new Error('Whole-org box loads should not be used for job-scoped staging validation.');
      },
    },
  );

  assert.deepEqual(boxLoadCalls, [['IL1-100', 'IL1-200']]);
  assert.deepEqual(pendingTransferCalls, [['box-record-1']]);
  assert.equal(state.boxes.length, 1);
  assert.equal(state.boxById['IL1-100'].status, 'IN_STOCK');
});

test('loadJobStagingValidationState ignores placeholder phase allocations for staging', async () => {
  const state = await loadJobStagingValidationState(
    {},
    'org-1',
    '18722',
    'IL1',
    {
      jobId: 'job-1',
      phases: [
        {
          phaseId: 'phase-active',
          phaseNumber: 1,
          workflowStatus: 'ACTIVE',
          isPrimary: true,
        },
        {
          phaseId: 'phase-placeholder',
          phaseNumber: 2,
          workflowStatus: 'PLACEHOLDER',
        },
      ],
      requirements: [
        {
          requirementId: 'req-placeholder',
          phaseId: 'phase-placeholder',
          requiredFeet: 20,
          allocatedFeet: 20,
          remainingFeet: 0,
        },
      ],
      allocations: [
        {
          allocationId: 'alloc-placeholder',
          requirementId: 'req-placeholder',
          boxId: 'IL1-200',
          status: 'ACTIVE',
          allocationKind: 'REQUIREMENT',
          allocatedFeet: 20,
        },
      ],
      filmOrders: [],
      caulkRequirements: [],
      caulkAllocations: [],
      boxes: [
        { id: 'box-2', boxId: 'IL1-200', status: 'IN_STOCK' },
      ],
      pendingTransfersByBoxRecordId: {},
    },
    {
      listPendingBoxTransfersByBoxRecordIds: async () => [],
      indexPendingBoxTransfersByBoxRecordId: () => ({}),
    },
  );

  assert.deepEqual(state.requirements.map((entry) => entry.requirementId), []);
  assert.deepEqual(state.allocations.map((entry) => entry.allocationId), []);
  assert.equal(state.blockingReason, '');
});

test('executeSetJobStagedPickup validates staged readiness without auto checkout', async () => {
  let loadCount = 0;
  let updateCount = 0;
  let checkoutCalled = false;

  const result = await executeSetJobStagedPickup(
    {},
    'org-1',
    '18722',
    true,
    'tester',
    { autoCheckoutRemaining: true },
    {
      nowIso: '2026-04-15T12:00:00Z',
      normalizeJobNumberDigits: (value) => String(value).trim(),
      asTrimmedString: (value) => String(value || '').trim(),
      resolveExistingOrLegacyJobHeader: async () => ({
        header: {
          jobNumber: '18722',
          warehouse: 'IL1',
          lifecycleStatus: 'ACTIVE',
        },
        allocations: null,
        filmOrders: null,
      }),
      normalizeJobLifecycleStatus: () => 'ACTIVE',
      checkoutAllJobMaterials: async () => {
        checkoutCalled = true;
        return {};
      },
      loadJobStagingValidationState: async () => {
        loadCount += 1;
        return { blockingReason: '' };
      },
      queryRow: async () => {
        updateCount += 1;
        return {
          job_number: '18722',
          is_staged_for_pickup: true,
          updated_at: '2026-04-15T12:00:00Z',
        };
      },
      mapDbJobRow: (row) => ({
        jobNumber: row.job_number,
        isStagedForPickup: row.is_staged_for_pickup,
        updatedAt: row.updated_at,
      }),
    },
  );

  assert.equal(checkoutCalled, false);
  assert.equal(loadCount, 1);
  assert.equal(updateCount, 1);
  assert.equal(result.isStagedForPickup, true);
  assert.equal(result.updatedAt, '2026-04-15T12:00:00Z');
  assert.deepEqual(result.warnings, []);
});

test('executeSetJobStagedPickup validates canonical jobId before staging without checkout-all', async () => {
  const jobId = '11111111-1111-4111-8111-111111111111';
  let checkoutPayload = null;
  let updateParams = null;
  let loadStatePayload = null;

  const result = await executeSetJobStagedPickup(
    {},
    'org-1',
    '18722',
    true,
    'tester',
    { jobId, autoCheckoutRemaining: true },
    {
      nowIso: '2026-04-15T12:00:00Z',
      normalizeJobNumberDigits: (value) => String(value).trim(),
      asTrimmedString: (value) => String(value || '').trim(),
      findJobById: async (_client, orgId, selectedJobId) => ({
        id: selectedJobId,
        orgId,
        jobNumber: '18722',
        warehouse: 'IL1',
        lifecycleStatus: 'ACTIVE',
      }),
      normalizeJobLifecycleStatus: () => 'ACTIVE',
      checkoutAllJobMaterials: async (_client, _orgId, payload) => {
        checkoutPayload = payload;
        return {
          warnings: ['Checked out 1 film box and 0 caulk allocations for job 18722.'],
          stagingState: { blockingReason: '' },
        };
      },
      loadJobStagingValidationState: async (_client, _orgId, _jobNumber, _warehouse, seedData) => {
        loadStatePayload = seedData;
        return { blockingReason: '' };
      },
      listAllocationsByJobId: async () => [],
      listFilmOrdersByJobId: async () => [],
      listJobPhasesByJobId: async () => [],
      listJobRequirementsByJobId: async () => [],
      listJobCaulkRequirementsByJobId: async () => [],
      listCaulkJobAllocationsByJobId: async () => [],
      queryRow: async (_client, _sql, params) => {
        updateParams = params;
        return {
          job_number: '18722',
          is_staged_for_pickup: true,
          updated_at: '2026-04-15T12:00:00Z',
        };
      },
      mapDbJobRow: (row) => ({
        jobNumber: row.job_number,
        isStagedForPickup: row.is_staged_for_pickup,
        updatedAt: row.updated_at,
      }),
    },
  );

  assert.equal(checkoutPayload, null);
  assert.equal(loadStatePayload?.jobId, jobId);
  assert.deepEqual(updateParams?.slice(0, 4), ['org-1', jobId, '18722', true]);
  assert.equal(result.jobId, jobId);
  assert.equal(result.isStagedForPickup, true);
});

test('executeSetJobStagedPickup clears canonical staged flag by jobId without checkout-all', async () => {
  const jobId = '11111111-1111-4111-8111-111111111111';
  let checkoutCalled = false;
  let updateParams = null;

  const result = await executeSetJobStagedPickup(
    {},
    'org-1',
    '18722',
    false,
    'tester',
    { jobId },
    {
      nowIso: '2026-04-15T12:00:00Z',
      normalizeJobNumberDigits: (value) => String(value).trim(),
      asTrimmedString: (value) => String(value || '').trim(),
      findJobById: async (_client, orgId, selectedJobId) => ({
        id: selectedJobId,
        orgId,
        jobNumber: '18722',
        warehouse: 'IL1',
        lifecycleStatus: 'ACTIVE',
      }),
      normalizeJobLifecycleStatus: () => 'ACTIVE',
      checkoutAllJobMaterials: async () => {
        checkoutCalled = true;
        return {};
      },
      queryRow: async (_client, _sql, params) => {
        updateParams = params;
        return {
          job_number: '18722',
          is_staged_for_pickup: false,
          updated_at: '2026-04-15T12:00:00Z',
        };
      },
      mapDbJobRow: (row) => ({
        jobNumber: row.job_number,
        isStagedForPickup: row.is_staged_for_pickup,
        updatedAt: row.updated_at,
      }),
    },
  );

  assert.equal(checkoutCalled, false);
  assert.deepEqual(updateParams?.slice(0, 4), ['org-1', jobId, '18722', false]);
  assert.equal(result.jobId, jobId);
  assert.equal(result.isStagedForPickup, false);
});

test('executeSetJobStagedPickup rejects canonical identity mismatch before side effects', async () => {
  const jobId = '11111111-1111-4111-8111-111111111111';
  let checkoutCalled = false;
  let updateCalled = false;

  await assert.rejects(
    () =>
      executeSetJobStagedPickup(
        {},
        'org-1',
        '18722',
        true,
        'tester',
        { jobId, autoCheckoutRemaining: true },
        {
          normalizeJobNumberDigits: (value) => String(value).trim(),
          asTrimmedString: (value) => String(value || '').trim(),
          findJobById: async () => ({
            id: jobId,
            jobNumber: '99999',
            warehouse: 'IL1',
            lifecycleStatus: 'ACTIVE',
          }),
          checkoutAllJobMaterials: async () => {
            checkoutCalled = true;
            return {};
          },
          queryRow: async () => {
            updateCalled = true;
            return {};
          },
        },
      ),
    /Job identity mismatch: jobId/,
  );

  assert.equal(checkoutCalled, false);
  assert.equal(updateCalled, false);
});

test('executeSetJobStagedPickup rejects closed jobs', async () => {
  await assert.rejects(
    () =>
      executeSetJobStagedPickup(
        {},
        'org-1',
        '18722',
        true,
        'tester',
        {},
        {
          normalizeJobNumberDigits: (value) => String(value).trim(),
          asTrimmedString: (value) => String(value || '').trim(),
          resolveExistingOrLegacyJobHeader: async () => ({
            header: {
              jobNumber: '18722',
              warehouse: 'IL1',
              lifecycleStatus: 'COMPLETED',
            },
          }),
          normalizeJobLifecycleStatus: () => 'COMPLETED',
        },
      ),
    /Job 18722 is closed and staged pickup cannot be changed\./,
  );
});

test('getJobStagingBlockingReason keeps transfer blockers intact', () => {
  const reason = getJobStagingBlockingReason(
    [{ requiredFeet: 25, remainingFeet: 0 }],
    [],
    [],
    [],
    [],
    [{ boxId: 'IL1-100', state: 'TRANSFER_PENDING' }],
    [],
    {},
  );

  assert.equal(reason, 'Receive transferred film before staging this job.');
});

test('getJobStagingBlockingReason blocks pending caulk transfers', () => {
  const reason = getJobStagingBlockingReason(
    [{ requiredFeet: 25, remainingFeet: 0 }],
    [{ requiredTubes: 3, remainingTubes: 0 }],
    [],
    [],
    [],
    [],
    [{ caulkAllocationId: 'caulk-1', state: 'TRANSFER_PENDING' }],
    {},
  );

  assert.equal(reason, 'Receive transferred caulk before staging this job.');
});

test('getJobStagingBlockingReason combines film and caulk transfer blockers', () => {
  const reason = getJobStagingBlockingReason(
    [{ requiredFeet: 25, remainingFeet: 0 }],
    [{ requiredTubes: 3, remainingTubes: 0 }],
    [],
    [],
    [],
    [{ boxId: 'IL1-100', state: 'TRANSFER_PENDING' }],
    [{ caulkAllocationId: 'caulk-1', state: 'TRANSFER_PENDING' }],
    {},
  );

  assert.equal(reason, 'Receive transferred film and caulk before staging this job.');
});

test('getJobStagingBlockingReason keeps ordered-allocation blockers intact', () => {
  const reason = getJobStagingBlockingReason(
    [{ requiredFeet: 25, remainingFeet: 0 }],
    [],
    [
      {
        boxId: 'IL1-200',
        status: 'ACTIVE',
        allocationKind: 'REQUIREMENT',
        allocatedFeet: 25,
      },
    ],
    [],
    [],
    [],
    [],
    {
      'IL1-200': {
        boxId: 'IL1-200',
        status: 'ORDERED',
      },
    },
  );

  assert.equal(reason, 'Receive ordered film before staging this job.');
});

test('getJobStagingBlockingReason keeps unchecked-out caulk blockers intact', () => {
  const reason = getJobStagingBlockingReason(
    [{ requiredFeet: 25, remainingFeet: 0 }],
    [{ requiredTubes: 1, remainingTubes: 0 }],
    [],
    [],
    [
      {
        status: 'ACTIVE',
        allocatedTubes: 1,
        reservedTubesRemaining: 1,
      },
    ],
    [],
    [],
    {},
  );

  assert.equal(reason, 'All required caulk must be checked out before staging this job.');
});
