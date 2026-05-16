import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  JOB_NUMBER_AMBIGUOUS_CODE,
  resolveLegacyJobNumberReadTargetFromHeaders,
} from '../../../shared/domain/legacyJobNumberReadAmbiguity.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const runtimeJobsReadPath = path.join(
  repoRoot,
  'backend',
  'src',
  'app',
  'services',
  'runtime',
  'runtimeJobsRead.mjs'
);
const runtimeAllocationViewsPath = path.join(
  repoRoot,
  'backend',
  'src',
  'app',
  'services',
  'runtime',
  'runtimeAllocationViews.mjs'
);
const runtimeJobDetailsPath = path.join(
  repoRoot,
  'backend',
  'src',
  'app',
  'services',
  'runtime',
  'runtimeJobDetails.mjs'
);
const edgeReadHandlersPath = path.join(
  repoRoot,
  'supabase',
  'functions',
  '_shared',
  'routes',
  'readHandlers.ts'
);

function extractFunctionBody(source, functionName) {
  const start = source.indexOf(`async function ${functionName}`);
  assert.notEqual(start, -1, `Unable to find ${functionName}.`);
  const nextFunction = source.indexOf('\nasync function ', start + 1);
  return source.slice(start, nextFunction === -1 ? source.length : nextFunction);
}

test('legacy jobNumber ambiguity resolver distinguishes zero, one, and multiple headers', () => {
  const headers = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      jobNumber: '81234',
      warehouse: 'IL1',
      sections: 'Phase A',
      installDate: '2026-05-01',
      crewLeader: 'Crew A',
      lifecycleStatus: 'ACTIVE',
      updatedAt: '2026-05-01T12:00:00Z',
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      jobNumber: '81234',
      warehouse: 'MS1',
      workScope: 'Phase B',
      installDate: '2026-05-02',
      crewLeader: 'Crew B',
      lifecycleStatus: 'COMPLETED',
      updatedAt: '2026-05-02T12:00:00Z',
    },
  ];

  const zero = resolveLegacyJobNumberReadTargetFromHeaders([], '81234');
  assert.equal(zero.kind, 'legacy-fallback');

  const one = resolveLegacyJobNumberReadTargetFromHeaders([headers[0]], ' 81234 ');
  assert.equal(one.kind, 'selected');
  assert.equal(one.jobId, headers[0].id);

  const multiple = resolveLegacyJobNumberReadTargetFromHeaders(headers, '81234');
  assert.equal(multiple.kind, 'ambiguous');
  assert.equal(multiple.details.code, JOB_NUMBER_AMBIGUOUS_CODE);
  assert.deepEqual(
    multiple.candidates.map((candidate) => ({
      jobId: candidate.jobId,
      jobNumber: candidate.jobNumber,
      routeTarget: candidate.routeTarget,
      workScope: candidate.workScope,
      warehouse: candidate.warehouse,
      installDate: candidate.installDate,
      crewLeader: candidate.crewLeader,
      lifecycleStatus: candidate.lifecycleStatus,
      updatedAt: candidate.updatedAt,
    })),
    [
      {
        jobId: headers[0].id,
        jobNumber: '81234',
        routeTarget: `/allocations/jobs/${headers[0].id}`,
        workScope: 'Phase A',
        warehouse: 'IL1',
        installDate: '2026-05-01',
        crewLeader: 'Crew A',
        lifecycleStatus: 'ACTIVE',
        updatedAt: '2026-05-01T12:00:00Z',
      },
      {
        jobId: headers[1].id,
        jobNumber: '81234',
        routeTarget: `/allocations/jobs/${headers[1].id}`,
        workScope: 'Phase B',
        warehouse: 'MS1',
        installDate: '2026-05-02',
        crewLeader: 'Crew B',
        lifecycleStatus: 'COMPLETED',
        updatedAt: '2026-05-02T12:00:00Z',
      },
    ]
  );
});

test('local /jobs/get checks ambiguity before pooled legacy detail aggregation', async () => {
  const source = await readFile(runtimeJobsReadPath, 'utf8');
  const buildReadJobDetail = extractFunctionBody(source, 'buildReadJobDetail');

  assert.match(buildReadJobDetail, /assertLegacyJobNumberReadIsUnambiguousWithPooledReads\(orgId,\s*jobNumber\)/);
  assert.ok(
    buildReadJobDetail.indexOf('assertLegacyJobNumberReadIsUnambiguousWithPooledReads') <
      buildReadJobDetail.indexOf('loadJobDetailContextWithPooledReads'),
    'Expected /jobs/get ambiguity guard to run before legacy detail aggregation.'
  );
});

test('local /allocations/by-job checks ambiguity before pooled legacy detail aggregation', async () => {
  const source = await readFile(runtimeAllocationViewsPath, 'utf8');
  const buildReadAllocationJobDetail = extractFunctionBody(source, 'buildReadAllocationJobDetail');

  assert.match(
    buildReadAllocationJobDetail,
    /assertLegacyJobNumberReadIsUnambiguousWithPooledReads\(orgId,\s*jobNumber\)/
  );
  assert.ok(
    buildReadAllocationJobDetail.indexOf('assertLegacyJobNumberReadIsUnambiguousWithPooledReads') <
      buildReadAllocationJobDetail.indexOf('loadJobDetailContextWithPooledReads'),
    'Expected /allocations/by-job ambiguity guard to run before legacy detail aggregation.'
  );
});

test('local ambiguity guard uses job headers and does not require schema helpers', async () => {
  const source = await readFile(runtimeJobDetailsPath, 'utf8');
  const guard = extractFunctionBody(source, 'assertLegacyJobNumberReadIsUnambiguousWithPooledReads');

  assert.match(guard, /listJobs\(client,\s*orgId\)/);
  assert.match(guard, /resolveLegacyJobNumberReadTargetFromHeaders/);
  assert.match(guard, /new HttpError\(\s*409/);
  assert.doesNotMatch(guard, /queryRows|queryRow|rpcOrThrow/);
});

test('Edge read handlers guard legacy jobNumber reads before detail aggregation', async () => {
  const source = await readFile(edgeReadHandlersPath, 'utf8');

  const jobsGetIndex = source.indexOf('"/jobs/get"');
  const jobsGetGuardIndex = source.indexOf('assertLegacyJobNumberReadIsUnambiguous', jobsGetIndex);
  const jobsGetDetailIndex = source.indexOf('deps.buildJobDetail', jobsGetIndex);
  assert.ok(jobsGetGuardIndex > jobsGetIndex && jobsGetGuardIndex < jobsGetDetailIndex);

  const allocationGetIndex = source.indexOf('"/allocations/by-job"');
  const allocationGuardIndex = source.indexOf('assertLegacyJobNumberReadIsUnambiguous', allocationGetIndex);
  const allocationDetailIndex = source.indexOf('deps.buildAllocationJobDetail', allocationGetIndex);
  assert.ok(allocationGuardIndex > allocationGetIndex && allocationGuardIndex < allocationDetailIndex);
});
