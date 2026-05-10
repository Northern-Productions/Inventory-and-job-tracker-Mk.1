import test from 'node:test';
import assert from 'node:assert/strict';

import {
  filterRollHistoryForJobAllocations,
  loadJobDetailContext,
  loadJobDetailContextById,
} from '../../src/app/services/runtime/runtimeJobDetails.mjs';

const JOB_A_ID = '11111111-1111-4111-8111-111111111111';
const JOB_B_ID = '22222222-2222-4222-8222-222222222222';

const jobRows = [
  {
    id: JOB_A_ID,
    org_id: 'org-1',
    job_number: '1234',
    warehouse: 'IL1',
    sections: 'Section 1',
    due_date: '2026-05-01',
    crew_leader: 'Crew A',
    lifecycle_status: 'ACTIVE',
  },
  {
    id: JOB_B_ID,
    org_id: 'org-1',
    job_number: '1234',
    warehouse: 'IL1',
    sections: 'Section 4',
    due_date: '2026-05-02',
    crew_leader: 'Crew B',
    lifecycle_status: 'ACTIVE',
  },
];

const allocationRows = [
  {
    id: 'alloc-row-a',
    org_id: 'org-1',
    allocation_id: 'ALLOC-A',
    box_id: 'IL1-100',
    warehouse: 'IL1',
    job_id: JOB_A_ID,
    job_number: '1234',
    job_date: '2026-05-01',
    allocated_feet: 20,
    covered_feet: 20,
    requirement_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    status: 'ACTIVE',
    created_at: '2026-05-01T10:00:00Z',
    crew_leader: 'Crew A',
  },
  {
    id: 'alloc-row-b',
    org_id: 'org-1',
    allocation_id: 'ALLOC-B',
    box_id: 'IL1-200',
    warehouse: 'IL1',
    job_id: JOB_B_ID,
    job_number: '1234',
    job_date: '2026-05-02',
    allocated_feet: 30,
    covered_feet: 30,
    requirement_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    status: 'ACTIVE',
    created_at: '2026-05-02T10:00:00Z',
    crew_leader: 'Crew B',
  },
];

const requirementRows = [
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    org_id: 'org-1',
    job_id: JOB_A_ID,
    job_number: '1234',
    manufacturer: '3M',
    film_name: 'Dusted Crystal',
    width_in: 48,
    required_feet: 20,
    auto_planning_suppressed: false,
  },
  {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    org_id: 'org-1',
    job_id: JOB_B_ID,
    job_number: '1234',
    manufacturer: '3M',
    film_name: 'Fasara',
    width_in: 60,
    required_feet: 30,
    auto_planning_suppressed: false,
  },
];

const boxRows = [
  {
    id: 'box-row-a',
    org_id: 'org-1',
    box_id: 'IL1-100',
    warehouse: 'IL1',
    status: 'IN_STOCK',
    manufacturer: '3M',
    film_name: 'Dusted Crystal',
    width_in: 48,
    initial_feet: 100,
    feet_available: 80,
  },
  {
    id: 'box-row-b',
    org_id: 'org-1',
    box_id: 'IL1-200',
    warehouse: 'IL1',
    status: 'IN_STOCK',
    manufacturer: '3M',
    film_name: 'Fasara',
    width_in: 60,
    initial_feet: 100,
    feet_available: 70,
  },
];

const rollRows = [
  {
    id: 'roll-a',
    org_id: 'org-1',
    log_id: 'ROLL-A',
    box_id: 'IL1-100',
    warehouse: 'IL1',
    manufacturer: '3M',
    film_name: 'Dusted Crystal',
    width_in: 48,
    job_number: '1234',
    checked_out_at: '2026-05-01T11:00:00Z',
    checked_out_by: 'Crew A',
    feet_before: 100,
    feet_after: 80,
  },
  {
    id: 'roll-b',
    org_id: 'org-1',
    log_id: 'ROLL-B',
    box_id: 'IL1-200',
    warehouse: 'IL1',
    manufacturer: '3M',
    film_name: 'Fasara',
    width_in: 60,
    job_number: '1234',
    checked_out_at: '2026-05-02T11:00:00Z',
    checked_out_by: 'Crew B',
    feet_before: 100,
    feet_after: 70,
  },
];

function rowsForSql(sql, params) {
  if (sql.includes('from app.jobs') && sql.includes('and id = $2')) {
    return jobRows.filter((job) => job.id === params[1]);
  }

  if (sql.includes('from app.jobs') && sql.includes('upper(trim(job_number))')) {
    return jobRows.filter((job) => job.job_number === String(params[1]).trim()).slice(0, 1);
  }

  if (sql.includes('from app.allocations') && sql.includes('and job_id = $2')) {
    return allocationRows.filter((allocation) => allocation.job_id === params[1]);
  }

  if (sql.includes('from app.allocations') && sql.includes('upper(trim(job_number))')) {
    return allocationRows.filter((allocation) => allocation.job_number === String(params[1]).trim());
  }

  if (sql.includes('from app.film_orders')) {
    return [];
  }

  if (sql.includes('from app.job_requirements') && sql.includes('r.job_id = $2')) {
    return requirementRows.filter((requirement) => requirement.job_id === params[1]);
  }

  if (sql.includes('from app.job_requirements') && sql.includes('upper(trim(j.job_number))')) {
    return requirementRows.filter((requirement) => requirement.job_number === String(params[1]).trim());
  }

  if (
    sql.includes('from app.job_caulk_requirements') ||
    sql.includes('from app.caulk_job_allocations') ||
    sql.includes('from app.caulk_job_checkouts') ||
    sql.includes('from app.box_transfers') ||
    sql.includes('from app.film_order_box_links')
  ) {
    return [];
  }

  if (sql.includes('from app.roll_weight_log') && sql.includes('box_id = $2')) {
    return rollRows.filter((entry) => entry.box_id === params[1]);
  }

  if (sql.includes('from app.roll_weight_log') && sql.includes('upper(trim(job_number))')) {
    return rollRows.filter((entry) => entry.job_number === String(params[1]).trim());
  }

  if (sql.includes('from app.boxes b')) {
    return boxRows.filter((box) => params[1].includes(box.box_id));
  }

  return [];
}

function createFakeClient() {
  return {
    async query(sql, params = []) {
      return { rows: rowsForSql(sql, params) };
    },
  };
}

test('loadJobDetailContextById scopes same-number detail rows to the selected job id', async () => {
  const detail = await loadJobDetailContextById(createFakeClient(), 'org-1', JOB_A_ID);

  assert.equal(detail.header.id, JOB_A_ID);
  assert.deepEqual(detail.allocations.map((entry) => entry.allocationId), ['ALLOC-A']);
  assert.deepEqual(detail.requirements.map((entry) => entry.id), ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
  assert.deepEqual(detail.rollHistory.map((entry) => entry.logId), ['ROLL-A']);
});

test('legacy loadJobDetailContext remains job-number scoped', async () => {
  const detail = await loadJobDetailContext(createFakeClient(), 'org-1', '1234');

  assert.deepEqual(detail.allocations.map((entry) => entry.allocationId), ['ALLOC-A', 'ALLOC-B']);
  assert.deepEqual(detail.requirements.map((entry) => entry.id), [
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ]);
});

test('filterRollHistoryForJobAllocations does not include rows solely because job number matches', () => {
  const filtered = filterRollHistoryForJobAllocations(rollRows.map((entry) => ({
    logId: entry.log_id,
    boxId: entry.box_id,
    jobNumber: entry.job_number,
    checkedOutAt: entry.checked_out_at,
  })), [
    {
      allocationId: 'ALLOC-A',
      boxId: 'IL1-100',
      createdAt: '2026-05-01T10:00:00Z',
      resolvedAt: '',
    },
  ]);

  assert.deepEqual(filtered.map((entry) => entry.logId), ['ROLL-A']);
});
