import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
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
  const allocations = Array.isArray(options.allocations) ? options.allocations : [];
  const requirements = Array.isArray(options.requirements) ? options.requirements : [];
  const caulkRequirements = Array.isArray(options.caulkRequirements) ? options.caulkRequirements : [];
  const caulkAllocations = Array.isArray(options.caulkAllocations) ? options.caulkAllocations : [];
  const queryDelayMs = Number.isFinite(options.queryDelayMs) ? Math.max(0, Math.floor(options.queryDelayMs)) : 0;
  const counts = {
    boxes: 0,
    jobs: 0,
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

test('buildJobsList still loads boxes normally when no preloaded box snapshot is supplied', async () => {
  const client = createFakeClient();

  const entries = await buildJobsList(client, ORG_ID, 0);

  assert.equal(client.counts.boxes, 1);
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
    'workScopeKey',
    'sections',
    'installDate',
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
  assert.equal(entries.find((entry) => entry.jobNumber === '30003').status, 'READY');
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

test('jobs search keeps its existing default box-loading behavior', async () => {
  const client = createFakeClient();

  const entries = await buildJobsSearchResults(client, ORG_ID, '30003', 25, 'ACTIVE');

  assert.equal(client.counts.boxes, 1);
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
  assert.match(
    edgeSource,
    /buildJobsList\(client, orgId, 0, undefined, \[\], \{\s*preloadedBoxes: allBoxes,\s*snapshotConcurrency: 1,\s*\}\)/s
  );
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
    assert.match(source, /const jobContexts/);
    assert.match(source, /groupEntriesByCanonicalJobId\(allAllocations\)/);
    assert.doesNotMatch(source, /const byJobNumber/);
    assert.doesNotMatch(source, /byJobNumber\[[^\]]+\.jobNumber\]\s*=/);
    assert.doesNotMatch(source, /Object\.keys\(byJobNumber\)/);
  }

  assert.match(edgeBuildJobsList, /requirementsByJobId\[contextJobId\]/);
  assert.match(edgeBuildJobsList, /allocationsByJobId\[contextJobId\]/);
  assert.match(edgeBuildJobsList, /loadCaulkPlanningByJobContexts\(client, orgId, jobContexts\)/);
  assert.doesNotMatch(edgeBuildJobsList, /loadCaulkPlanningByJobNumbers\(/);
});

test('Edge jobs list and calendar load caulk summaries through canonical job ids', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const edgeSource = fs.readFileSync(path.join(repoRoot, 'supabase/functions/_shared/api-handler.ts'), 'utf8');
  const caulkPlanningSource = edgeSource.match(
    /(?:export\s+)?async function loadCaulkPlanningByJobContexts[\s\S]*?async function buildJobsList/
  )?.[0] || '';
  const edgeBuildJobsList = edgeSource.match(/async function buildJobsList[\s\S]*?async function buildJobsSearchResults/)?.[0] || '';
  const edgeCalendarSource = edgeSource.match(
    /async function buildJobsCalendarEntriesForHeaders[\s\S]*?async function buildJobsCalendar/
  )?.[0] || '';

  assert.match(caulkPlanningSource, /listJobCaulkRequirementsByJobIdDirect\(orgId, header\)/);
  assert.match(caulkPlanningSource, /listCaulkJobAllocationsByJobIdDirect\(orgId, jobId\)/);
  assert.match(caulkPlanningSource, /listJobCaulkRequirementsByJob\(client, orgId, jobNumber\)/);
  assert.match(caulkPlanningSource, /listCaulkJobAllocationsByJob\(client, orgId, jobNumber\)/);
  assert.match(edgeBuildJobsList, /loadCaulkPlanningByJobContexts\(client, orgId, jobContexts\)/);
  assert.match(edgeCalendarSource, /jobId\s*\?\s*listJobCaulkRequirementsByJobIdDirect\(orgId, header\)/);
  assert.match(edgeCalendarSource, /jobId\s*\?\s*listCaulkJobAllocationsByJobIdDirect\(orgId, jobId\)/);
});
