import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildJobsList,
  buildJobsSearchResults,
} from '../../src/app/services/runtime/runtimeJobsRead.mjs';
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

function createFakeClient() {
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

  return {
    counts,
    async query(text) {
      const normalized = String(text).replace(/\s+/g, ' ').toLowerCase();
      if (normalized.includes('from app.boxes b')) {
        counts.boxes += 1;
        return { rows: buildBoxRows() };
      }
      if (normalized.includes('from app.job_requirements r')) {
        counts.requirements += 1;
        return { rows: [] };
      }
      if (normalized.includes('from app.job_caulk_requirements r')) {
        counts.caulkRequirements += 1;
        return { rows: [] };
      }
      if (normalized.includes('from app.caulk_job_allocations a')) {
        counts.caulkAllocations += 1;
        return { rows: [] };
      }
      if (normalized.includes('from app.caulk_stock s')) {
        counts.caulkStock += 1;
        return { rows: [] };
      }
      if (normalized.includes('from app.allocations')) {
        counts.allocations += 1;
        return { rows: [] };
      }
      if (normalized.includes('from app.film_orders')) {
        counts.filmOrders += 1;
        return { rows: [] };
      }
      if (normalized.includes('from app.jobs')) {
        counts.jobs += 1;
        return { rows: buildJobRows() };
      }
      throw new Error(`Unexpected query in reports summary box reuse test: ${normalized.slice(0, 160)}`);
    },
  };
}

test('buildJobsList still loads boxes normally when no preloaded box snapshot is supplied', async () => {
  const client = createFakeClient();

  const entries = await buildJobsList(client, ORG_ID, 0);

  assert.equal(client.counts.boxes, 1);
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((entry) => entry.jobNumber).sort(),
    ['10001', '20002', '30003']
  );
});

test('buildReportsSummary reuses its already-loaded box snapshot for job summaries', async () => {
  const client = createFakeClient();

  const summary = await buildReportsSummary(client, ORG_ID, { warehouse: 'IL1' });

  assert.equal(client.counts.boxes, 1);
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
    summary.cancelledJobs.map((entry) => entry.jobNumber),
    ['20002']
  );
});

test('jobs search keeps its existing default box-loading behavior', async () => {
  const client = createFakeClient();

  const entries = await buildJobsSearchResults(client, ORG_ID, '30003', 25, 'ACTIVE');

  assert.equal(client.counts.boxes, 1);
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
  const edgeSource = fs.readFileSync(path.join(repoRoot, 'supabase/functions/_shared/api-handler.ts'), 'utf8');

  assert.match(
    localReportsSource,
    /buildJobsList\(client, orgId, 0, undefined, \[\], \{ preloadedBoxes: allBoxes \}\)/
  );
  assert.match(
    edgeSource,
    /buildJobsList\(client, orgId, 0, undefined, \[\], \{ preloadedBoxes: allBoxes \}\)/
  );
  assert.match(edgeSource, /zeroedBoxes,/);
});
