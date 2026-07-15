import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildJobsCalendar,
  buildJobsList,
  buildJobsSearchResults,
} from '../../src/app/services/runtime/runtimeJobsRead.mjs';
import { buildAllocationJobList } from '../../src/app/services/runtime/runtimeAllocationViews.mjs';
import { buildReportsSummary } from '../../src/app/services/runtime/runtimeReports.mjs';

const ORG_ID = 'ecf4f1c5-f153-4072-b814-18a41c52fcdc';
const NOW = '2026-05-02T12:00:00.000Z';

function buildBoxRows() {
  return [
    {
      id: 'box-active',
      org_id: ORG_ID,
      box_id: 'IL1-1000',
      warehouse: 'IL1',
      manufacturer: '3M',
      film_name: 'Solar Film',
      width_in: 60,
      initial_feet: 100,
      feet_available: 80,
      active_allocated_feet: 0,
      status: 'IN_STOCK',
      received_date: '2026-01-10',
      has_ever_been_checked_out: false,
      created_at: NOW,
      updated_at: NOW,
    },
    {
      id: 'box-zeroed',
      org_id: ORG_ID,
      box_id: 'IL1-2000',
      warehouse: 'IL1',
      manufacturer: '3M',
      film_name: 'Zeroed Film',
      width_in: 48,
      initial_feet: 75,
      feet_available: 0,
      active_allocated_feet: 0,
      status: 'ZEROED',
      received_date: '2026-01-15',
      zeroed_date: '2026-02-01',
      has_ever_been_checked_out: true,
      created_at: NOW,
      updated_at: NOW,
    },
  ];
}

function buildJobRows() {
  return [
    {
      id: 'job-completed',
      org_id: ORG_ID,
      job_number: '10001',
      warehouse: 'IL1',
      sections: 'A',
      due_date: '2026-02-10',
      crew_leader: 'Completed Lead',
      lifecycle_status: 'COMPLETED',
      is_labor_only: false,
      is_staged_for_pickup: false,
      created_at: NOW,
      updated_at: '2026-03-01T08:00:00.000Z',
    },
    {
      id: 'job-cancelled',
      org_id: ORG_ID,
      job_number: '20002',
      warehouse: 'IL1',
      sections: 'B',
      due_date: '2026-02-12',
      crew_leader: 'Cancelled Lead',
      lifecycle_status: 'CANCELLED',
      is_labor_only: false,
      is_staged_for_pickup: false,
      created_at: NOW,
      updated_at: '2026-03-02T08:00:00.000Z',
    },
    {
      id: 'job-active',
      org_id: ORG_ID,
      job_number: '30003',
      warehouse: 'IL1',
      sections: 'C',
      due_date: '2026-02-14',
      crew_leader: 'Active Lead',
      lifecycle_status: 'ACTIVE',
      is_labor_only: false,
      is_staged_for_pickup: false,
      created_at: NOW,
      updated_at: NOW,
    },
  ];
}

function buildAllocationRows() {
  return [
    {
      id: 'allocation-active',
      org_id: ORG_ID,
      allocation_id: 'ALLOC-30003',
      box_id: 'IL1-1000',
      warehouse: 'IL1',
      job_id: 'job-active',
      job_number: '30003',
      job_date: '2026-02-14',
      allocated_feet: 40,
      covered_feet: 40,
      requirement_id: 'requirement-active',
      allocation_kind: 'REQUIREMENT',
      allocation_source: 'MANUAL',
      status: 'ACTIVE',
      created_at: NOW,
      created_by: 'test',
      crew_leader: 'Active Lead',
    },
  ];
}

function buildRequirementRows() {
  return [
    {
      id: 'requirement-active',
      org_id: ORG_ID,
      job_id: 'job-active',
      job_number: '30003',
      manufacturer: '3M',
      film_name: 'Solar Film',
      width_in: 60,
      required_feet: 40,
      created_at: NOW,
      updated_at: NOW,
    },
  ];
}

function createFakeClient(options = {}) {
  const jobs = Array.isArray(options.jobs) ? options.jobs : buildJobRows();
  const phases = Array.isArray(options.phases) ? options.phases : [];
  const allocations = Array.isArray(options.allocations) ? options.allocations : [];
  const requirements = Array.isArray(options.requirements) ? options.requirements : [];
  const caulkRequirements = Array.isArray(options.caulkRequirements) ? options.caulkRequirements : [];
  const caulkAllocations = Array.isArray(options.caulkAllocations) ? options.caulkAllocations : [];
  const queryDelayMs = Number.isFinite(options.queryDelayMs) ? Math.max(0, Math.floor(options.queryDelayMs)) : 0;
  const counts = {
    boxes: 0,
    jobs: 0,
    phases: 0,
    allocations: 0,
    filmOrders: 0,
    requirements: 0,
    caulkRequirements: 0,
    caulkAllocations: 0,
    caulkStock: 0,
  };
  const concurrency = {
    active: 0,
    maxActive: 0,
  };

  return {
    counts,
    concurrency,
    async query(text) {
      concurrency.active += 1;
      concurrency.maxActive = Math.max(concurrency.maxActive, concurrency.active);
      try {
        if (queryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, queryDelayMs));
        }
        const normalized = String(text).replace(/\s+/g, ' ').toLowerCase();
        if (normalized.includes('from app.boxes b')) {
          counts.boxes += 1;
          return { rows: buildBoxRows() };
        }
        if (normalized.includes('from app.job_requirements r')) {
          counts.requirements += 1;
          return { rows: requirements };
        }
        if (normalized.includes('from app.job_phases')) {
          counts.phases += 1;
          return { rows: phases };
        }
        if (normalized.includes('from app.job_caulk_requirements r')) {
          counts.caulkRequirements += 1;
          return { rows: caulkRequirements };
        }
        if (normalized.includes('from app.caulk_job_allocations a')) {
          counts.caulkAllocations += 1;
          return { rows: caulkAllocations };
        }
        if (normalized.includes('from app.caulk_stock s')) {
          counts.caulkStock += 1;
          return { rows: [] };
        }
        if (normalized.includes('from app.allocations')) {
          counts.allocations += 1;
          return { rows: allocations };
        }
        if (normalized.includes('from app.film_orders')) {
          counts.filmOrders += 1;
          return { rows: [] };
        }
        if (normalized.includes('from app.jobs')) {
          counts.jobs += 1;
          return { rows: jobs };
        }
        throw new Error(`Unexpected query in reports summary box reuse test: ${normalized.slice(0, 160)}`);
      } finally {
        concurrency.active -= 1;
      }
    },
  };
}

test('buildJobsList only loads referenced allocation boxes when no preloaded box snapshot is supplied', async () => {
  const client = createFakeClient();

  const entries = await buildJobsList(client, ORG_ID, 0);

  assert.equal(client.counts.boxes, 0);
  assert.equal(client.counts.caulkStock, 0);
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((entry) => entry.jobNumber).sort(),
    ['10001', '20002', '30003']
  );
  assert.deepEqual(Object.keys(entries.find((entry) => entry.jobNumber === '30003')), [
    'jobId',
    'jobNumber',
    'warehouse',
    'workScope',
    'primaryWorkScope',
    'workScopeKey',
    'sections',
    'phaseId',
    'phaseNumber',
    'phaseWorkScope',
    'workflowStatus',
    'isPlaceholder',
    'phaseCount',
    'phases',
    'installDate',
    'installEndDate',
    'crewLeader',
    'status',
    'lifecycleStatus',
    'isLaborOnly',
    'isStagedForPickup',
    'requiredFeet',
    'allocatedFeet',
    'allocatedWithInstallDateFeet',
    'allocatedWithoutInstallDateFeet',
    'remainingFeet',
    'requiredTubes',
    'allocatedTubes',
    'remainingTubes',
    'requirementCount',
    'allocationCount',
    'filmOrderCount',
    'hasOrderedAllocations',
    'createdAt',
    'updatedAt',
    'notes',
  ]);
  assert.equal(entries.find((entry) => entry.jobNumber === '30003').phaseCount, 1);
  assert.equal(entries.find((entry) => entry.jobNumber === '30003').status, 'READY');
});

test('canonical jobs list excludes an unscoped own-id allocation while retaining all scoped film rows', async () => {
  const activeAllocation = buildAllocationRows()[0];
  const allocations = [
    activeAllocation,
    {
      ...activeAllocation,
      id: 'allocation-cancelled-retained',
      allocation_id: 'ALLOC-CANCELLED-RETAINED',
      status: 'CANCELLED',
    },
    {
      ...activeAllocation,
      id: 'allocation-fulfilled-retained',
      allocation_id: 'ALLOC-FULFILLED-RETAINED',
      status: 'FULFILLED',
    },
    {
      ...activeAllocation,
      id: 'allocation-unscoped-history',
      allocation_id: 'ALLOC-UNSCOPED-HISTORY',
      job_id: null,
      requirement_id: null,
      status: 'CANCELLED',
    },
  ];
  const caulkAllocations = [
    {
      id: 'caulk-allocation-row',
      caulk_allocation_id: 'CAULK-ALLOC-ROW',
      org_id: ORG_ID,
      job_id: 'job-active',
      job_number: '30003',
      product_id: 'caulk-product',
      manufacturer: 'Fixture',
      product_name: 'Fixture Caulk',
      product_code: 'FIXTURE',
      warehouse: 'IL1',
      allocated_tubes: 4,
      reserved_tubes_remaining: 4,
      checked_out_tubes_total: 0,
      returned_unused_tubes_total: 0,
      used_tubes_total: 0,
      overage_tubes_total: 0,
      status: 'ACTIVE',
      created_at: NOW,
      created_by: 'test',
      updated_at: NOW,
    },
  ];
  const client = createFakeClient({
    jobs: buildJobRows().filter((row) => row.id === 'job-active'),
    allocations,
    requirements: buildRequirementRows(),
    caulkAllocations,
  });

  const entries = await buildJobsList(client, ORG_ID, 0, 'ACTIVE');

  assert.equal(entries.length, 1);
  assert.equal(entries[0].jobId, 'job-active');
  assert.equal(entries[0].allocationCount, 3);
  assert.equal(entries[0].requiredFeet, 40);
  assert.equal(entries[0].allocatedFeet, 40);
  assert.equal(entries[0].remainingFeet, 0);
  assert.equal(entries[0].requiredTubes, 0);
  assert.equal(entries[0].allocatedTubes, 0);
  assert.equal(entries[0].status, 'READY');
});

test('cancelled legacy-only allocation remains historical without active coverage', async () => {
  const unscopedAllocation = {
    ...buildAllocationRows()[0],
    id: 'allocation-legacy-history',
    allocation_id: 'ALLOC-LEGACY-HISTORY',
    job_id: null,
    requirement_id: null,
    status: 'CANCELLED',
  };
  const client = createFakeClient({
    jobs: [],
    allocations: [unscopedAllocation],
    requirements: [],
  });

  const entries = await buildJobsList(client, ORG_ID, 0);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].jobId, '');
  assert.equal(entries[0].allocationCount, 1);
  assert.equal(entries[0].allocatedFeet, 0);
  assert.equal(entries[0].remainingFeet, 0);
  assert.equal(entries[0].lifecycleStatus, 'CANCELLED');
});

test('buildJobsList preserves duplicate job-number rows by canonical jobId', async () => {
  const duplicateJobs = [
    {
      id: 'job-9327001-section-1',
      org_id: ORG_ID,
      job_number: '9327001',
      warehouse: 'IL1',
      sections: 'Sections 1',
      work_scope_key: 'section:1',
      due_date: '2026-04-01',
      crew_leader: 'Fixture Lead',
      lifecycle_status: 'ACTIVE',
      is_labor_only: false,
      is_staged_for_pickup: false,
      created_at: NOW,
      updated_at: '2026-04-01T09:00:00.000Z',
    },
    {
      id: 'job-9327001-section-2',
      org_id: ORG_ID,
      job_number: '9327001',
      warehouse: 'IL1',
      sections: 'Sections 2',
      work_scope_key: 'section:2',
      due_date: '2026-04-01',
      crew_leader: 'Fixture Lead',
      lifecycle_status: 'ACTIVE',
      is_labor_only: false,
      is_staged_for_pickup: false,
      created_at: NOW,
      updated_at: '2026-04-01T09:00:00.000Z',
    },
  ];
  const duplicateRequirements = [
    {
      id: 'requirement-section-1',
      org_id: ORG_ID,
      job_id: 'job-9327001-section-1',
      job_number: '9327001',
      manufacturer: '3M',
      film_name: 'Solar Film',
      width_in: 60,
      required_feet: 10,
      created_at: NOW,
      updated_at: NOW,
    },
    {
      id: 'requirement-section-2',
      org_id: ORG_ID,
      job_id: 'job-9327001-section-2',
      job_number: '9327001',
      manufacturer: '3M',
      film_name: 'Solar Film',
      width_in: 60,
      required_feet: 20,
      created_at: NOW,
      updated_at: NOW,
    },
  ];
  const duplicateAllocations = [
    {
      id: 'allocation-section-1',
      org_id: ORG_ID,
      allocation_id: 'ALLOC-S1',
      box_id: 'IL1-1000',
      warehouse: 'IL1',
      job_id: 'job-9327001-section-1',
      job_number: '9327001',
      job_date: '2026-04-01',
      allocated_feet: 10,
      covered_feet: 10,
      requirement_id: 'requirement-section-1',
      allocation_kind: 'REQUIREMENT',
      allocation_source: 'MANUAL',
      status: 'ACTIVE',
      created_at: NOW,
      created_by: 'test',
      crew_leader: 'Fixture Lead',
    },
    {
      id: 'allocation-section-2',
      org_id: ORG_ID,
      allocation_id: 'ALLOC-S2',
      box_id: 'IL1-1000',
      warehouse: 'IL1',
      job_id: 'job-9327001-section-2',
      job_number: '9327001',
      job_date: '2026-04-01',
      allocated_feet: 5,
      covered_feet: 5,
      requirement_id: 'requirement-section-2',
      allocation_kind: 'REQUIREMENT',
      allocation_source: 'MANUAL',
      status: 'ACTIVE',
      created_at: NOW,
      created_by: 'test',
      crew_leader: 'Fixture Lead',
    },
  ];
  const duplicateCaulkRequirements = [
    {
      requirement_id: 'caulk-requirement-section-1',
      org_id: ORG_ID,
      job_id: 'job-9327001-section-1',
      job_number: '9327001',
      product_id: 'caulk-product-bronze',
      manufacturer_id: 'caulk-manufacturer-3m',
      manufacturer: '3M',
      product_name: 'Bronze Caulk',
      product_code: 'BRONZE',
      tubes_per_case: 12,
      required_tubes: 1,
      updated_at: NOW,
    },
    {
      requirement_id: 'caulk-requirement-section-2',
      org_id: ORG_ID,
      job_id: 'job-9327001-section-2',
      job_number: '9327001',
      product_id: 'caulk-product-bronze',
      manufacturer_id: 'caulk-manufacturer-3m',
      manufacturer: '3M',
      product_name: 'Bronze Caulk',
      product_code: 'BRONZE',
      tubes_per_case: 12,
      required_tubes: 2,
      updated_at: NOW,
    },
  ];
  const duplicateCaulkAllocations = [
    {
      caulk_allocation_id: 'CAULK-ALLOC-S1',
      requirement_id: 'caulk-requirement-section-1',
      org_id: ORG_ID,
      job_id: 'job-9327001-section-1',
      job_number: '9327001',
      product_id: 'caulk-product-bronze',
      manufacturer_id: 'caulk-manufacturer-3m',
      manufacturer: '3M',
      product_name: 'Bronze Caulk',
      product_code: 'BRONZE',
      tubes_per_case: 12,
      warehouse: 'IL1',
      allocated_tubes: 1,
      reserved_tubes_remaining: 1,
      checked_out_tubes_total: 0,
      returned_unused_tubes_total: 0,
      used_tubes_total: 0,
      overage_tubes_total: 0,
      status: 'ACTIVE',
      allocation_source: 'MANUAL',
      created_at: NOW,
      created_by: 'test',
      updated_at: NOW,
    },
    {
      caulk_allocation_id: 'CAULK-ALLOC-S2',
      requirement_id: 'caulk-requirement-section-2',
      org_id: ORG_ID,
      job_id: 'job-9327001-section-2',
      job_number: '9327001',
      product_id: 'caulk-product-bronze',
      manufacturer_id: 'caulk-manufacturer-3m',
      manufacturer: '3M',
      product_name: 'Bronze Caulk',
      product_code: 'BRONZE',
      tubes_per_case: 12,
      warehouse: 'IL1',
      allocated_tubes: 2,
      reserved_tubes_remaining: 2,
      checked_out_tubes_total: 0,
      returned_unused_tubes_total: 0,
      used_tubes_total: 0,
      overage_tubes_total: 0,
      status: 'ACTIVE',
      allocation_source: 'MANUAL',
      created_at: NOW,
      created_by: 'test',
      updated_at: NOW,
    },
  ];
  const client = createFakeClient({
    jobs: duplicateJobs,
    requirements: duplicateRequirements,
    allocations: duplicateAllocations,
    caulkRequirements: duplicateCaulkRequirements,
    caulkAllocations: duplicateCaulkAllocations,
  });

  const entries = await buildJobsList(client, ORG_ID, 0, 'ACTIVE', ['9327001']);

  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((entry) => ({
      jobId: entry.jobId,
      jobNumber: entry.jobNumber,
      workScope: entry.workScope,
      workScopeKey: entry.workScopeKey,
      requiredFeet: entry.requiredFeet,
      allocatedFeet: entry.allocatedFeet,
      requiredTubes: entry.requiredTubes,
      allocatedTubes: entry.allocatedTubes,
    })),
    [
      {
        jobId: 'job-9327001-section-1',
        jobNumber: '9327001',
        workScope: 'Sections 1',
        workScopeKey: 'section:1',
        requiredFeet: 10,
        allocatedFeet: 10,
        requiredTubes: 1,
        allocatedTubes: 1,
      },
      {
        jobId: 'job-9327001-section-2',
        jobNumber: '9327001',
        workScope: 'Sections 2',
        workScopeKey: 'section:2',
        requiredFeet: 20,
        allocatedFeet: 5,
        requiredTubes: 2,
        allocatedTubes: 2,
      },
    ]
  );
});

test('buildJobsCalendar emits scheduled phase entries and filters inclusive date ranges', async () => {
  const client = createFakeClient({
    jobs: [
      {
        id: 'job-active',
        org_id: ORG_ID,
        job_number: '30003',
        warehouse: 'IL1',
        sections: 'Primary Scope',
        due_date: '2026-03-08',
        crew_leader: 'Active Lead',
        lifecycle_status: 'ACTIVE',
        is_labor_only: false,
        is_staged_for_pickup: true,
        created_at: NOW,
        updated_at: NOW,
      },
    ],
    phases: [
      {
        id: 'phase-unscheduled',
        org_id: ORG_ID,
        job_id: 'job-active',
        phase_number: 1,
        sections: 'No Date',
        install_date: null,
        install_end_date: null,
        crew_leader: '',
        labor_status: 'ACTIVE',
        is_primary: true,
        created_at: NOW,
        updated_at: NOW,
      },
      {
        id: 'phase-range',
        org_id: ORG_ID,
        job_id: 'job-active',
        phase_number: 2,
        sections: 'Sections 7',
        install_date: '2026-03-08',
        install_end_date: '2026-03-10',
        crew_leader: 'Napo',
        labor_status: 'ACTIVE',
        is_primary: false,
        created_at: NOW,
        updated_at: NOW,
      },
      {
        id: 'phase-next-week',
        org_id: ORG_ID,
        job_id: 'job-active',
        phase_number: 3,
        sections: 'Next Week',
        install_date: '2026-03-15',
        install_end_date: null,
        crew_leader: 'Napo',
        labor_status: 'ACTIVE',
        is_primary: false,
        created_at: NOW,
        updated_at: NOW,
      },
    ],
  });

  const weekEntries = await buildJobsCalendar(client, ORG_ID, 'week', '2026-03-10', '', 'ACTIVE');

  assert.deepEqual(weekEntries.map((entry) => entry.phaseId), ['phase-range']);
  assert.equal(weekEntries[0].phaseNumber, 2);
  assert.equal(weekEntries[0].installDate, '2026-03-08');
  assert.equal(weekEntries[0].installEndDate, '2026-03-10');
  assert.equal(weekEntries[0].phaseWorkScope, 'Sections 7');
  assert.equal(weekEntries[0].isStagedForPickup, true);

  const monthEntries = await buildJobsCalendar(client, ORG_ID, 'month', '2026-03-01', '', 'ACTIVE');

  assert.deepEqual(
    monthEntries.map((entry) => entry.phaseId),
    ['phase-range', 'phase-next-week']
  );
});

test('buildReportsSummary reuses its already-loaded box snapshot for job summaries', async () => {
  const client = createFakeClient({ queryDelayMs: 5 });

  const summary = await buildReportsSummary(client, ORG_ID, { warehouse: 'IL1' });

  assert.equal(client.counts.boxes, 1);
  assert.equal(client.counts.caulkStock, 0);
  assert.equal(client.concurrency.maxActive, 1);
  assert.deepEqual(Object.keys(summary), [
    'availableFeetByWidth',
    'neverCheckedOut',
    'zeroedByMonth',
    'completedJobs',
    'cancelledJobs',
    'mostUsedFilm',
    'mostUsedFilmOptions',
  ]);
  assert.deepEqual(summary.availableFeetByWidth, [
    {
      widthIn: 60,
      totalFeetAvailable: 80,
      boxCount: 1,
    },
  ]);
  assert.equal(summary.neverCheckedOut.length, 1);
  assert.deepEqual(summary.zeroedByMonth, [{ month: '2026-02', zeroedCount: 1 }]);
  assert.deepEqual(
    summary.completedJobs.map((entry) => entry.jobNumber),
    ['10001']
  );
  assert.deepEqual(
    summary.completedJobs.map((entry) => entry.jobId),
    ['job-completed']
  );
  assert.deepEqual(
    summary.completedJobs.map((entry) => ({ workScope: entry.workScope, sections: entry.sections })),
    [{ workScope: 'A', sections: 'A' }]
  );
  assert.deepEqual(
    summary.cancelledJobs.map((entry) => entry.jobNumber),
    ['20002']
  );
  assert.deepEqual(
    summary.cancelledJobs.map((entry) => entry.jobId),
    ['job-cancelled']
  );
  assert.deepEqual(
    summary.cancelledJobs.map((entry) => ({ workScope: entry.workScope, sections: entry.sections })),
    [{ workScope: 'B', sections: 'B' }]
  );
});

test('buildReportsSummary ranks most-used film by job requirement actual usage and distinct jobs', async () => {
  const jobs = [
    {
      id: 'job-a',
      org_id: ORG_ID,
      job_number: '41001',
      warehouse: 'IL1',
      sections: 'A',
      due_date: '2026-05-10',
      crew_leader: 'Lead',
      lifecycle_status: 'ACTIVE',
      is_labor_only: false,
      is_staged_for_pickup: false,
      created_at: '2026-01-05T08:00:00.000Z',
      updated_at: NOW,
    },
    {
      id: 'job-b',
      org_id: ORG_ID,
      job_number: '41002',
      warehouse: 'IL1',
      sections: 'B',
      due_date: '2026-05-11',
      crew_leader: 'Lead',
      lifecycle_status: 'COMPLETED',
      is_labor_only: false,
      is_staged_for_pickup: false,
      created_at: '2026-01-06T08:00:00.000Z',
      updated_at: NOW,
    },
    {
      id: 'job-cancelled',
      org_id: ORG_ID,
      job_number: '41003',
      warehouse: 'IL1',
      sections: 'Cancelled',
      due_date: '2026-05-12',
      crew_leader: 'Lead',
      lifecycle_status: 'CANCELLED',
      is_labor_only: false,
      is_staged_for_pickup: false,
      created_at: '2026-01-07T08:00:00.000Z',
      updated_at: NOW,
    },
    {
      id: 'job-ms1',
      org_id: ORG_ID,
      job_number: '41004',
      warehouse: 'MS1',
      sections: 'MS1',
      due_date: '2026-05-13',
      crew_leader: 'Lead',
      lifecycle_status: 'ACTIVE',
      is_labor_only: false,
      is_staged_for_pickup: false,
      created_at: '2026-01-08T08:00:00.000Z',
      updated_at: NOW,
    },
    {
      id: 'job-created-fallback',
      org_id: ORG_ID,
      job_number: '41005',
      warehouse: 'IL1',
      sections: 'Created fallback',
      due_date: null,
      crew_leader: 'Lead',
      lifecycle_status: 'ACTIVE',
      is_labor_only: false,
      is_staged_for_pickup: false,
      created_at: '2026-02-09T08:00:00.000Z',
      updated_at: NOW,
    },
  ];
  const requirements = [
    {
      id: 'req-a-1',
      org_id: ORG_ID,
      job_id: 'job-a',
      job_number: '41001',
      manufacturer: '3M Solar',
      film_name: 'Prestige 70',
      width_in: 60,
      required_feet: 50,
      actual_used_feet: 40,
      phase_install_date: '2026-05-10',
      created_at: NOW,
      updated_at: NOW,
    },
    {
      id: 'req-a-2',
      org_id: ORG_ID,
      job_id: 'job-a',
      job_number: '41001',
      manufacturer: '3M Solar',
      film_name: 'Prestige 70',
      width_in: 60,
      required_feet: 30,
      actual_used_feet: 10,
      phase_install_date: '2026-05-10',
      created_at: NOW,
      updated_at: NOW,
    },
    {
      id: 'req-b-1',
      org_id: ORG_ID,
      job_id: 'job-b',
      job_number: '41002',
      manufacturer: '3M Solar',
      film_name: 'Prestige 70',
      width_in: 60,
      required_feet: 40,
      actual_used_feet: 25,
      phase_install_date: '2026-05-11',
      created_at: NOW,
      updated_at: NOW,
    },
    {
      id: 'req-b-zero',
      org_id: ORG_ID,
      job_id: 'job-b',
      job_number: '41002',
      manufacturer: '3M Solar',
      film_name: 'Prestige 70',
      width_in: 36,
      required_feet: 20,
      actual_used_feet: 0,
      phase_install_date: '2026-05-11',
      created_at: NOW,
      updated_at: NOW,
    },
    {
      id: 'req-created',
      org_id: ORG_ID,
      job_id: 'job-created-fallback',
      job_number: '41005',
      manufacturer: 'Madico',
      film_name: 'Safetyshield 800',
      width_in: 72,
      required_feet: 110,
      actual_used_feet: 100,
      phase_install_date: null,
      created_at: NOW,
      updated_at: NOW,
    },
    {
      id: 'req-cancelled',
      org_id: ORG_ID,
      job_id: 'job-cancelled',
      job_number: '41003',
      manufacturer: '3M Solar',
      film_name: 'Prestige 70',
      width_in: 60,
      required_feet: 999,
      actual_used_feet: 999,
      phase_install_date: '2026-05-12',
      created_at: NOW,
      updated_at: NOW,
    },
    {
      id: 'req-ms1',
      org_id: ORG_ID,
      job_id: 'job-ms1',
      job_number: '41004',
      manufacturer: '3M Solar',
      film_name: 'Prestige 70',
      width_in: 60,
      required_feet: 100,
      actual_used_feet: 90,
      phase_install_date: '2026-05-13',
      created_at: NOW,
      updated_at: NOW,
    },
  ];
  const client = createFakeClient({ jobs, requirements });

  const actualSummary = await buildReportsSummary(client, ORG_ID, {
    warehouse: 'IL1',
    from: '2026-01-01',
    to: '2026-12-31',
    rankBy: 'actual_used_lf',
  });
  assert.deepEqual(
    actualSummary.mostUsedFilm.map((row) => ({
      rank: row.rank,
      manufacturer: row.manufacturer,
      filmName: row.filmName,
      widthIn: row.widthIn,
      jobsUsingIt: row.jobsUsingIt,
      totalRequiredLf: row.totalRequiredLf,
      averageLfPerJob: row.averageLfPerJob,
      actualUsedLf: row.actualUsedLf,
    })),
    [
      {
        rank: 1,
        manufacturer: 'Madico',
        filmName: 'Safetyshield 800',
        widthIn: 72,
        jobsUsingIt: 1,
        totalRequiredLf: 110,
        averageLfPerJob: 110,
        actualUsedLf: 100,
      },
      {
        rank: 2,
        manufacturer: '3M Solar',
        filmName: 'Prestige 70',
        widthIn: 60,
        jobsUsingIt: 2,
        totalRequiredLf: 120,
        averageLfPerJob: 60,
        actualUsedLf: 75,
      },
    ]
  );
  assert.deepEqual(actualSummary.mostUsedFilmOptions, {
    manufacturers: ['3M Solar', 'Madico'],
    filmNames: ['Prestige 70', 'Safetyshield 800'],
    widths: [36, 60, 72],
  });

  const jobsSummary = await buildReportsSummary(client, ORG_ID, {
    warehouse: 'IL1',
    from: '2026-01-01',
    to: '2026-12-31',
    rankBy: 'jobs_using_it',
  });
  assert.deepEqual(
    jobsSummary.mostUsedFilm.map((row) => ({
      rank: row.rank,
      filmName: row.filmName,
      widthIn: row.widthIn,
      jobsUsingIt: row.jobsUsingIt,
      totalRequiredLf: row.totalRequiredLf,
      actualUsedLf: row.actualUsedLf,
    })),
    [
      {
        rank: 1,
        filmName: 'Prestige 70',
        widthIn: 60,
        jobsUsingIt: 2,
        totalRequiredLf: 120,
        actualUsedLf: 75,
      },
      {
        rank: 2,
        filmName: 'Safetyshield 800',
        widthIn: 72,
        jobsUsingIt: 1,
        totalRequiredLf: 110,
        actualUsedLf: 100,
      },
      {
        rank: 3,
        filmName: 'Prestige 70',
        widthIn: 36,
        jobsUsingIt: 1,
        totalRequiredLf: 20,
        actualUsedLf: 0,
      },
    ]
  );
});

test('buildReportsSummary filters most-used film by manufacturer, film, width, and phase date basis', async () => {
  const jobs = [
    {
      id: 'job-phase-2025',
      org_id: ORG_ID,
      job_number: '51001',
      warehouse: 'IL1',
      sections: 'Phase date controls',
      due_date: '2026-02-10',
      crew_leader: 'Lead',
      lifecycle_status: 'ACTIVE',
      is_labor_only: false,
      is_staged_for_pickup: false,
      created_at: '2026-02-01T08:00:00.000Z',
      updated_at: NOW,
    },
    {
      id: 'job-phase-2026',
      org_id: ORG_ID,
      job_number: '51002',
      warehouse: 'IL1',
      sections: 'Current year',
      due_date: '2026-03-10',
      crew_leader: 'Lead',
      lifecycle_status: 'ACTIVE',
      is_labor_only: false,
      is_staged_for_pickup: false,
      created_at: '2026-03-01T08:00:00.000Z',
      updated_at: NOW,
    },
  ];
  const requirements = [
    {
      id: 'req-phase-2025',
      org_id: ORG_ID,
      job_id: 'job-phase-2025',
      job_number: '51001',
      manufacturer: '3M Solar',
      film_name: 'Prestige 70',
      width_in: 60,
      required_feet: 70,
      actual_used_feet: 65,
      phase_install_date: '2025-12-15',
      created_at: NOW,
      updated_at: NOW,
    },
    {
      id: 'req-phase-2026',
      org_id: ORG_ID,
      job_id: 'job-phase-2026',
      job_number: '51002',
      manufacturer: '3M Solar',
      film_name: 'Prestige 70',
      width_in: 72,
      required_feet: 90,
      actual_used_feet: 80,
      phase_install_date: '2026-03-10',
      created_at: NOW,
      updated_at: NOW,
    },
  ];
  const client = createFakeClient({ jobs, requirements });

  const summary = await buildReportsSummary(client, ORG_ID, {
    warehouse: 'IL1',
    manufacturer: '3M Solar',
    film: 'Prestige 70',
    width: '60',
    from: '2025-01-01',
    to: '2025-12-31',
    rankBy: 'actual_used_lf',
  });

  assert.deepEqual(
    summary.mostUsedFilm.map((row) => ({
      filmName: row.filmName,
      widthIn: row.widthIn,
      totalRequiredLf: row.totalRequiredLf,
      actualUsedLf: row.actualUsedLf,
    })),
    [
      {
        filmName: 'Prestige 70',
        widthIn: 60,
        totalRequiredLf: 70,
        actualUsedLf: 65,
      },
    ]
  );
});

test('buildReportsSummary falls back from phase install date to job install date and created date', async () => {
  const jobs = [
    {
      id: 'job-install-fallback',
      org_id: ORG_ID,
      job_number: '52001',
      warehouse: 'IL1',
      sections: 'Install fallback',
      due_date: '2025-07-15',
      crew_leader: 'Lead',
      lifecycle_status: 'ACTIVE',
      is_labor_only: false,
      is_staged_for_pickup: false,
      created_at: '2026-01-01T08:00:00.000Z',
      updated_at: NOW,
    },
    {
      id: 'job-created-fallback-only',
      org_id: ORG_ID,
      job_number: '52002',
      warehouse: 'IL1',
      sections: 'Created fallback',
      due_date: null,
      crew_leader: 'Lead',
      lifecycle_status: 'ACTIVE',
      is_labor_only: false,
      is_staged_for_pickup: false,
      created_at: '2024-11-01T08:00:00.000Z',
      updated_at: NOW,
    },
  ];
  const requirements = [
    {
      id: 'req-install-fallback',
      org_id: ORG_ID,
      job_id: 'job-install-fallback',
      job_number: '52001',
      manufacturer: 'LLumar',
      film_name: 'Vista',
      width_in: 48,
      required_feet: 30,
      actual_used_feet: 20,
      phase_install_date: null,
      created_at: NOW,
      updated_at: NOW,
    },
    {
      id: 'req-created-fallback-only',
      org_id: ORG_ID,
      job_id: 'job-created-fallback-only',
      job_number: '52002',
      manufacturer: 'Avery Dennison',
      film_name: 'Natura',
      width_in: 60,
      required_feet: 40,
      actual_used_feet: 35,
      phase_install_date: null,
      created_at: NOW,
      updated_at: NOW,
    },
  ];
  const client = createFakeClient({ jobs, requirements });

  const installFallbackSummary = await buildReportsSummary(client, ORG_ID, {
    warehouse: 'IL1',
    from: '2025-01-01',
    to: '2025-12-31',
    rankBy: 'actual_used_lf',
  });
  assert.deepEqual(
    installFallbackSummary.mostUsedFilm.map((row) => row.filmName),
    ['Vista']
  );

  const createdFallbackSummary = await buildReportsSummary(client, ORG_ID, {
    warehouse: 'IL1',
    from: '2024-01-01',
    to: '2024-12-31',
    rankBy: 'actual_used_lf',
  });
  assert.deepEqual(
    createdFallbackSummary.mostUsedFilm.map((row) => row.filmName),
    ['Natura']
  );
});

test('buildReportsSummary keeps closed job rows compatible when work scope is absent', async () => {
  const jobs = buildJobRows().map((row) => ({ ...row, sections: '' }));
  const client = createFakeClient({ jobs });

  const summary = await buildReportsSummary(client, ORG_ID, { warehouse: 'IL1' });

  assert.equal(Object.prototype.hasOwnProperty.call(summary.completedJobs[0], 'workScope'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(summary.completedJobs[0], 'sections'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(summary.cancelledJobs[0], 'workScope'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(summary.cancelledJobs[0], 'sections'), false);
});

test('buildAllocationJobList preserves allocation summaries with parallelized snapshot reads', async () => {
  const client = createFakeClient({
    allocations: buildAllocationRows(),
    requirements: buildRequirementRows(),
  });

  const entries = await buildAllocationJobList(client, ORG_ID);

  assert.equal(client.counts.jobs, 1);
  assert.equal(client.counts.allocations, 1);
  assert.equal(client.counts.filmOrders, 1);
  assert.equal(client.counts.requirements, 1);
  assert.equal(client.counts.caulkRequirements, 1);
  assert.equal(client.counts.caulkAllocations, 1);
  assert.equal(client.counts.boxes, 1);
  assert.equal(client.counts.caulkStock, 1);
  assert.deepEqual(entries.map((entry) => entry.jobNumber), ['30003']);
  assert.equal(entries[0].activeAllocatedFeet, 40);
  assert.equal(entries[0].status, 'READY');
});

test('buildAllocationJobList preserves duplicate job-number rows and caulk totals by job id', async () => {
  const jobs = [
    {
      id: 'job-9327001-s1',
      org_id: ORG_ID,
      job_number: '9327001',
      warehouse: 'IL1',
      sections: 'Sections 1',
      due_date: '2026-05-20',
      crew_leader: 'Fixture Crew',
      lifecycle_status: 'ACTIVE',
      is_labor_only: false,
      is_staged_for_pickup: false,
      created_at: NOW,
      updated_at: NOW,
    },
    {
      id: 'job-9327001-s2',
      org_id: ORG_ID,
      job_number: '9327001',
      warehouse: 'IL1',
      sections: 'Sections 2',
      due_date: '2026-05-21',
      crew_leader: 'Fixture Crew',
      lifecycle_status: 'ACTIVE',
      is_labor_only: false,
      is_staged_for_pickup: false,
      created_at: NOW,
      updated_at: NOW,
    },
  ];
  const allocations = [
    {
      id: 'allocation-s1',
      org_id: ORG_ID,
      allocation_id: 'ALLOC-S1',
      box_id: 'IL1-1000',
      warehouse: 'IL1',
      job_id: 'job-9327001-s1',
      job_number: '9327001',
      job_date: '2026-05-20',
      allocated_feet: 12,
      covered_feet: 12,
      requirement_id: 'film-req-s1',
      allocation_kind: 'REQUIREMENT',
      allocation_source: 'MANUAL',
      status: 'ACTIVE',
      created_at: NOW,
      created_by: 'test',
      crew_leader: 'Fixture Crew',
    },
    {
      id: 'allocation-s2',
      org_id: ORG_ID,
      allocation_id: 'ALLOC-S2',
      box_id: 'IL1-1000',
      warehouse: 'IL1',
      job_id: 'job-9327001-s2',
      job_number: '9327001',
      job_date: '2026-05-21',
      allocated_feet: 12,
      covered_feet: 12,
      requirement_id: 'film-req-s2',
      allocation_kind: 'REQUIREMENT',
      allocation_source: 'MANUAL',
      status: 'ACTIVE',
      created_at: NOW,
      created_by: 'test',
      crew_leader: 'Fixture Crew',
    },
  ];
  const requirements = [
    {
      id: 'film-req-s1',
      org_id: ORG_ID,
      job_id: 'job-9327001-s1',
      job_number: '9327001',
      manufacturer: '3M',
      film_name: 'Solar Film',
      width_in: 60,
      required_feet: 12,
      created_at: NOW,
      updated_at: NOW,
    },
    {
      id: 'film-req-s2',
      org_id: ORG_ID,
      job_id: 'job-9327001-s2',
      job_number: '9327001',
      manufacturer: '3M',
      film_name: 'Solar Film',
      width_in: 60,
      required_feet: 12,
      created_at: NOW,
      updated_at: NOW,
    },
  ];
  const caulkRequirements = [
    {
      requirement_id: 'caulk-req-s1',
      job_id: 'job-9327001-s1',
      job_number: '9327001',
      product_id: 'fixture-caulk',
      manufacturer: 'Fixture',
      product_name: 'Bronze Caulk',
      product_code: 'BRZ',
      tubes_per_case: 12,
      required_tubes: 1,
      auto_planning_suppressed: false,
      updated_at: NOW,
    },
    {
      requirement_id: 'caulk-req-s2',
      job_id: 'job-9327001-s2',
      job_number: '9327001',
      product_id: 'fixture-caulk',
      manufacturer: 'Fixture',
      product_name: 'Bronze Caulk',
      product_code: 'BRZ',
      tubes_per_case: 12,
      required_tubes: 1,
      auto_planning_suppressed: false,
      updated_at: NOW,
    },
  ];
  const caulkAllocations = [
    {
      caulk_allocation_id: 'caulk-alloc-s1',
      requirement_id: 'caulk-req-s1',
      job_id: 'job-9327001-s1',
      job_number: '9327001',
      product_id: 'fixture-caulk',
      manufacturer: 'Fixture',
      product_name: 'Bronze Caulk',
      product_code: 'BRZ',
      warehouse: 'IL1',
      allocated_tubes: 1,
      reserved_tubes_remaining: 1,
      status: 'ACTIVE',
      created_at: NOW,
      created_by: 'test',
      updated_at: NOW,
    },
    {
      caulk_allocation_id: 'caulk-alloc-s2',
      requirement_id: 'caulk-req-s2',
      job_id: 'job-9327001-s2',
      job_number: '9327001',
      product_id: 'fixture-caulk',
      manufacturer: 'Fixture',
      product_name: 'Bronze Caulk',
      product_code: 'BRZ',
      warehouse: 'IL1',
      allocated_tubes: 1,
      reserved_tubes_remaining: 1,
      status: 'ACTIVE',
      created_at: NOW,
      created_by: 'test',
      updated_at: NOW,
    },
  ];
  const client = createFakeClient({
    jobs,
    allocations,
    requirements,
    caulkRequirements,
    caulkAllocations,
  });

  const entries = await buildAllocationJobList(client, ORG_ID);
  const fixtureEntries = entries
    .filter((entry) => entry.jobNumber === '9327001')
    .sort((left, right) => left.jobId.localeCompare(right.jobId));

  assert.deepEqual(
    fixtureEntries.map((entry) => ({
      jobId: entry.jobId,
      jobNumber: entry.jobNumber,
      workScope: entry.workScope,
      activeAllocatedFeet: entry.activeAllocatedFeet,
      requiredTubes: entry.requiredTubes,
      allocatedTubes: entry.allocatedTubes,
    })),
    [
      {
        jobId: 'job-9327001-s1',
        jobNumber: '9327001',
        workScope: 'Sections 1',
        activeAllocatedFeet: 12,
        requiredTubes: 1,
        allocatedTubes: 1,
      },
      {
        jobId: 'job-9327001-s2',
        jobNumber: '9327001',
        workScope: 'Sections 2',
        activeAllocatedFeet: 12,
        requiredTubes: 1,
        allocatedTubes: 1,
      },
    ]
  );
});

test('summary snapshot reads are bounded while preserving job-list rows', async () => {
  const client = createFakeClient({ queryDelayMs: 5 });

  const entries = await buildJobsList(client, ORG_ID, 0);

  assert.equal(client.concurrency.maxActive, 2);
  assert.deepEqual(
    entries.map((entry) => entry.jobNumber).sort(),
    ['10001', '20002', '30003']
  );
});

test('allocation snapshot reads are bounded while preserving allocation rows', async () => {
  const client = createFakeClient({
    allocations: buildAllocationRows(),
    requirements: buildRequirementRows(),
    queryDelayMs: 5,
  });

  const entries = await buildAllocationJobList(client, ORG_ID);

  assert.equal(client.concurrency.maxActive, 2);
  assert.deepEqual(entries.map((entry) => entry.jobNumber), ['30003']);
});

test('jobs search avoids loading unrelated boxes when no allocations need them', async () => {
  const client = createFakeClient();

  const entries = await buildJobsSearchResults(client, ORG_ID, '30003', 25, 'ACTIVE');

  assert.equal(client.counts.boxes, 0);
  assert.equal(client.counts.caulkStock, 0);
  assert.deepEqual(
    entries.map((entry) => entry.jobNumber),
    ['30003']
  );
});

test('local and Edge report builders both pass preloaded boxes into buildJobsList', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const localReportsSource = fs.readFileSync(
    path.join(repoRoot, 'backend/src/app/services/runtime/runtimeReports.mjs'),
    'utf8'
  );
  const localJobsReadSource = fs.readFileSync(
    path.join(repoRoot, 'backend/src/app/services/runtime/runtimeJobsRead.mjs'),
    'utf8'
  );
  const edgeSource = fs.readFileSync(path.join(repoRoot, 'supabase/functions/_shared/api-handler.ts'), 'utf8');
  const localReadHandlersSource = fs.readFileSync(
    path.join(repoRoot, 'backend/src/app/handlers/readHandlers.mjs'),
    'utf8'
  );

  assert.match(
    localReportsSource,
    /buildJobsList\(client, orgId, 0, undefined, \[\], \{\s*preloadedBoxes: allBoxes,\s*snapshotConcurrency: 1,\s*\}\)/s
  );
  assert.match(localReportsSource, /const allRequirements = await loadReportRequirementsSnapshot\(client, orgId\)/);
  assert.match(localReportsSource, /buildMostUsedFilmReport\(\s*allJobEntries,\s*allRequirements,\s*filters,?\s*\)/s);
  assert.match(
    edgeSource,
    /buildJobsList\(client, orgId, 0, undefined, \[\], \{\s*preloadedBoxes: allBoxes,\s*snapshotConcurrency: 1,\s*\}\)/s
  );
  assert.match(edgeSource, /const allRequirements = await listJobRequirements\(client, orgId\)/);
  assert.match(edgeSource, /buildMostUsedFilmReport\(\s*allJobEntries,\s*allRequirements,\s*filters,?\s*\)/s);
  assert.match(edgeSource, /async function listBoxesSnapshotDirect\(orgId: string\)/);
  assert.match(localReportsSource, /workScope: asTrimmedString\(jobEntry\.workScope \?\? jobEntry\.sections\)/);
  assert.match(edgeSource, /workScope: asTrimmedString\(jobEntry\.workScope \?\? jobEntry\.sections\)/);
  assert.match(edgeSource, /zeroedBoxes,/);
  assert.match(localReadHandlersSource, /'\/allocations\/jobs'/);
  assert.match(localReadHandlersSource, /'\/jobs\/calendar'/);
  assert.match(localReadHandlersSource, /'\/jobs\/list'/);
  assert.match(localReadHandlersSource, /'\/jobs\/search'/);
  assert.match(localReadHandlersSource, /'\/reports\/summary'/);
  assert.match(edgeSource, /await runBoundedSnapshotReads\(\[\s*\(\) => listJobs\(client, orgId\),\s*\(\) => listAllocations\(client, orgId\),\s*\(\) => listFilmOrders\(client, orgId\),\s*\(\) => listJobRequirements\(client, orgId\),/s);
  const localBuildJobsList = localJobsReadSource.match(/async function buildJobsList[\s\S]*?async function buildJobsSearchResults/)?.[0] || '';
  const edgeBuildJobsList = edgeSource.match(/async function buildJobsList[\s\S]*?async function buildJobsSearchResults/)?.[0] || '';
  assert.match(localBuildJobsList, /listBoxesByIds\(readClient, orgId, collectAllocationBoxIds\(allAllocations\)\)/);
  assert.match(edgeBuildJobsList, /listBoxesByIds\(orgId, collectAllocationBoxIds\(allAllocations\)\)/);
  assert.doesNotMatch(localBuildJobsList, /readTasks\.push\(\(readClient\) => listBoxes\(readClient, orgId\)\)/);
  assert.doesNotMatch(edgeBuildJobsList, /snapshotTasks\.push\(\(\) => listBoxes\(client, orgId\)\)/);
  assert.doesNotMatch(localBuildJobsList, /listCaulkStock|caulkStockEntries: allCaulkStock/);
  assert.doesNotMatch(edgeBuildJobsList, /listCaulkStockEntries|caulkStockEntries: allCaulkStock/);
});

test('local and Edge jobs list builders avoid jobNumber-only row identity', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const localJobsReadSource = fs.readFileSync(
    path.join(repoRoot, 'backend/src/app/services/runtime/runtimeJobsRead.mjs'),
    'utf8'
  );
  const edgeSource = fs.readFileSync(path.join(repoRoot, 'supabase/functions/_shared/api-handler.ts'), 'utf8');
  const localBuildJobsList = localJobsReadSource.match(/async function buildJobsList[\s\S]*?async function buildJobsSearchResults/)?.[0] || '';
  const edgeBuildJobsList = edgeSource.match(/async function buildJobsList[\s\S]*?async function buildJobsSearchResults/)?.[0] || '';

  for (const [label, source] of [
    ['local', localBuildJobsList],
    ['edge', edgeBuildJobsList],
  ]) {
    assert.ok(source, `${label} buildJobsList source should be present`);
    assert.match(source, /const jobHeaders/);
    assert.match(source, /(?:const|let) jobContexts/);
    assert.match(source, /groupEntriesByCanonicalJobId\(allAllocations\)/);
    assert.doesNotMatch(source, /const byJobNumber/);
    assert.doesNotMatch(source, /byJobNumber\[[^\]]+\.jobNumber\]\s*=/);
    assert.doesNotMatch(source, /Object\.keys\(byJobNumber\)/);
  }

  assert.match(edgeBuildJobsList, /requirementsByJobId\[contextJobId\]/);
  assert.match(edgeBuildJobsList, /allocationsByJobId\[contextJobId\]/);
  assert.match(
    edgeBuildJobsList,
    /loadCaulkPlanningByJobContexts\(\s*client,\s*orgId,\s*jobContexts,\s*Array\.from\(jobNumberFilterSet\)/
  );
  assert.doesNotMatch(edgeBuildJobsList, /loadCaulkPlanningByJobNumbers\(/);
});

test('Edge jobs list uses bounded org snapshots for canonical and legacy caulk summaries', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const edgeSource = fs.readFileSync(path.join(repoRoot, 'supabase/functions/_shared/api-handler.ts'), 'utf8');
  const summarySource = fs.readFileSync(
    path.join(repoRoot, 'supabase/functions/_shared/services/jobsCaulkSummary.ts'),
    'utf8'
  );
  const caulkPlanningSource = edgeSource.match(
    /(?:export\s+)?async function loadCaulkPlanningByJobContexts[\s\S]*?async function buildJobsList/
  )?.[0] || '';
  const edgeBuildJobsList = edgeSource.match(/async function buildJobsList[\s\S]*?async function buildJobsSearchResults/)?.[0] || '';

  assert.match(caulkPlanningSource, /loadJobsCaulkSummary\(orgId, jobContexts, jobNumberFilters/);
  assert.match(caulkPlanningSource, /listJobCaulkRequirementsSnapshot\(/);
  assert.match(caulkPlanningSource, /listCaulkJobAllocationsSnapshot\(/);
  assert.doesNotMatch(caulkPlanningSource, /listJobCaulkRequirementsByJob\(/);
  assert.doesNotMatch(caulkPlanningSource, /listCaulkJobAllocationsByJob\(/);
  assert.match(summarySource, /Promise\.all\(\[\s*deps\.loadRequirements\(orgId\),\s*deps\.loadAllocations\(orgId\)/s);
  assert.match(summarySource, /\.eq\("org_id", options\.orgId\)/);
  assert.doesNotMatch(summarySource, /\.insert\(|\.update\(|\.delete\(|\.upsert\(|\.rpc\(/);
  assert.match(edgeBuildJobsList, /jobContexts\s*=\s*caulkPlanning\.jobContexts/);
});
