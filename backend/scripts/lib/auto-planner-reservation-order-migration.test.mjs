import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0100_auto_planner_reservation_order.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260429123000_auto_planner_reservation_order.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

test('auto planner reservation-order migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('auto planner reservation-order migration removes install-date film priority', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const replacement = extractSnippetVariable(migration, 'v_new_job_order');

  assert.match(replacement, /select j\.\*/);
  assert.match(replacement, /select min\(a\.created_at\)/);
  assert.match(replacement, /select min\(a\.allocation_id\)/);
  assert.match(replacement, /app_api\.film_allocation_reserves_capacity\(a, b\.status::text\)/);
  assert.match(replacement, /a\.requirement_id = r\.id/);
  assert.doesNotMatch(replacement, /install_date nulls last/);
});

test('latest schema check forbids reservation-order planner internals after manual-only migration', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');


  assert.match(schemaCheck, /0181_tenant_direct_write_grants_hardening\.sql/);

  assert.match(schemaCheck, /'manualOnly', true/);
  assert.match(schemaCheck, /perform app_api\.reconcile_auto_planned_allocations/);
  assert.match(schemaCheck, /select \*\\n    from auto_planner_jobs\\n    order by/);
  assert.match(schemaCheck, /install_date nulls last/);
  assert.match(schemaCheck, /covered_feet = auto_planner_desired_film\.covered_feet \+ excluded\.covered_feet/);
  assert.match(schemaCheck, /allocated_tubes = auto_planner_desired_caulk\.allocated_tubes \+ excluded\.allocated_tubes/);
});

test('reservation order keeps older allocations when a later job install date moves earlier', () => {
  const box = { boxId: 'IL1-100', physicalFeet: 100, status: 'IN_STOCK' };
  const jobA = buildJob({
    jobId: 'job-a',
    jobNumber: '9100',
    installDate: '2026-05-06',
    createdAt: '2026-04-29T03:45:09.000Z',
  });
  const jobB = buildJob({
    jobId: 'job-b',
    jobNumber: '9200',
    installDate: '2026-05-04',
    createdAt: '2026-04-29T03:45:16.000Z',
  });
  const existingAllocations = [
    buildAllocation({
      allocationId: 'alloc-a',
      jobId: 'job-a',
      jobNumber: '9100',
      allocatedFeet: 75,
      createdAt: '2026-04-29T03:45:09.500Z',
    }),
    buildAllocation({
      allocationId: 'alloc-b',
      jobId: 'job-b',
      jobNumber: '9200',
      allocatedFeet: 25,
      createdAt: '2026-04-29T03:45:16.500Z',
    }),
  ];

  const result = planByReservationOrder({
    box,
    jobs: [jobB, jobA],
    existingAllocations,
    requiredFeetByJobId: new Map([
      ['job-a', 75],
      ['job-b', 50],
    ]),
  });

  assert.equal(result.get('job-a'), 75);
  assert.equal(result.get('job-b'), 25);
  assert.equal(sumMapValues(result), 100);
  assert.ok(sumMapValues(result) <= box.physicalFeet, 'active reserved LF must not exceed physical LF');
});

function buildJob({ jobId, jobNumber, installDate, createdAt }) {
  return { jobId, jobNumber, installDate, createdAt };
}

function buildAllocation({
  allocationId,
  jobId,
  jobNumber,
  allocatedFeet,
  createdAt,
  status = 'ACTIVE',
  source = 'AUTO_PLANNED',
  kind = 'REQUIREMENT',
} = {}) {
  return { allocationId, jobId, jobNumber, allocatedFeet, createdAt, status, source, kind };
}

function planByReservationOrder({ box, jobs, existingAllocations, requiredFeetByJobId }) {
  let remaining = box.physicalFeet;
  const result = new Map();
  const jobsByReservationOrder = jobs.slice().sort((left, right) => {
    const leftAllocation = earliestActiveAutoAllocationForJob(existingAllocations, left.jobId);
    const rightAllocation = earliestActiveAutoAllocationForJob(existingAllocations, right.jobId);
    return (
      compareAscendingStrings(leftAllocation?.createdAt || 'infinity', rightAllocation?.createdAt || 'infinity') ||
      compareAscendingStrings(leftAllocation?.allocationId || '', rightAllocation?.allocationId || '') ||
      compareAscendingStrings(left.createdAt, right.createdAt) ||
      compareAscendingStrings(left.jobNumber, right.jobNumber)
    );
  });

  for (const job of jobsByReservationOrder) {
    let needed = requiredFeetByJobId.get(job.jobId) || 0;
    for (const allocation of existingAllocations
      .filter((entry) => entry.jobId === job.jobId && reservesCapacity(entry))
      .sort((left, right) => compareAscendingStrings(left.createdAt, right.createdAt) || compareAscendingStrings(left.allocationId, right.allocationId))) {
      if (needed <= 0 || remaining <= 0) {
        break;
      }
      const allocated = Math.min(allocation.allocatedFeet, needed, remaining);
      result.set(job.jobId, (result.get(job.jobId) || 0) + allocated);
      needed -= allocated;
      remaining -= allocated;
    }
  }

  return result;
}

function earliestActiveAutoAllocationForJob(allocations, jobId) {
  return allocations
    .filter((entry) => entry.jobId === jobId && reservesCapacity(entry))
    .sort((left, right) => compareAscendingStrings(left.createdAt, right.createdAt) || compareAscendingStrings(left.allocationId, right.allocationId))[0];
}

function reservesCapacity(allocation) {
  return (
    allocation.status === 'ACTIVE' &&
    allocation.source === 'AUTO_PLANNED' &&
    allocation.kind === 'REQUIREMENT' &&
    allocation.allocatedFeet > 0
  );
}

function compareAscendingStrings(left, right) {
  if (left === right) {
    return 0;
  }
  if (!left) {
    return 1;
  }
  if (!right) {
    return -1;
  }
  return left < right ? -1 : 1;
}

function sumMapValues(values) {
  let total = 0;
  for (const value of values.values()) {
    total += value;
  }
  return total;
}

function extractSnippetVariable(migration, variableName) {
  const match = migration.match(new RegExp(`${variableName} text := \\$snippet\\$([\\s\\S]*?)\\$snippet\\$;`));
  assert.ok(match, `Expected ${variableName} snippet in migration`);
  return match[1];
}
