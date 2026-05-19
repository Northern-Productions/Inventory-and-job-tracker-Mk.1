import test from 'node:test';
import assert from 'node:assert/strict';

import { checkJobDuplicate } from '../../src/app/services/runtime/runtimeJobsRead.mjs';

function buildJob(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    jobId: '11111111-1111-4111-8111-111111111111',
    orgId: 'org-1',
    jobNumber: '81234',
    warehouse: 'IL1',
    workScope: 'Section 1',
    sections: 'Section 1',
    lifecycleStatus: 'ACTIVE',
    status: 'READY',
    ...overrides,
  };
}

async function check(params, { candidates = [] } = {}) {
  let listCandidatesCallCount = 0;
  const response = await checkJobDuplicate({}, 'org-1', params, {
    listJobsByNumber: async (_client, orgId, jobNumber) => {
      listCandidatesCallCount += 1;
      return candidates.map((entry) => ({ ...entry, orgId, jobNumber: entry.jobNumber || jobNumber }));
    },
    buildJobsList: async () => {
      throw new Error('Duplicate checks must not use grouped job-list summaries.');
    },
  });

  return { response, listCandidatesCallCount };
}

test('/jobs/check-duplicate keeps jobNumber-only compatibility when a duplicate exists', async () => {
  const { response } = await check('81234', {
    candidates: [buildJob({ workScope: 'Sections 4, 5', sections: 'Sections 4, 5' })],
  });

  assert.equal(response.exists, true);
  assert.equal(response.allowed, false);
  assert.equal(response.job.jobNumber, '81234');
  assert.equal(response.job.workScope, 'Sections 4, 5');
  assert.equal(response.existingJob.jobId, '11111111-1111-4111-8111-111111111111');
  assert.equal(response.existingJob.routeTarget, '/allocations/jobs/11111111-1111-4111-8111-111111111111');
  assert.equal(response.canCreate, false);
  assert.equal(response.duplicatesEnabled, false);
  assert.equal(response.blockingReason, 'SAME_JOB_NUMBER_BLOCKED_UNTIL_SCOPE_DUPLICATES_ENABLED');
});

test('/jobs/check-duplicate returns allowed no-match diagnostics for unique job numbers', async () => {
  const { response, listCandidatesCallCount } = await check(
    { jobNumber: '81235', workScope: 'Section 1' },
    { candidates: [] }
  );

  assert.deepEqual(response, {
    exists: false,
    allowed: true,
    canCreate: true,
    duplicatesEnabled: false,
    reason: 'NO_MATCH',
    blockingReason: null,
    duplicateScopeMode: 'NO_MATCH',
    jobNumber: '81235',
    workScope: 'Section 1',
    workScopeKey: 'section:1',
    requestedWorkScope: 'Section 1',
    requestedWorkScopeKey: 'section:1',
    exactScopeDuplicateExists: false,
    sameJobNumberDifferentScopeExists: false,
    futureCanCreateAfterEnablement: false,
    exactScopeJobs: [],
    differentScopeJobs: [],
    job: null,
    existingJob: null,
    sameJobNumberJobs: [],
  });
  assert.equal(listCandidatesCallCount, 1);
});

test('/jobs/check-duplicate blocks active same job number and same normalized work scope', async () => {
  const { response } = await check(
    { jobNumber: '81234', workScope: 'Sections 01' },
    { candidates: [buildJob({ workScope: 'Section 1', sections: 'Section 1' })] }
  );

  assert.equal(response.exists, true);
  assert.equal(response.allowed, false);
  assert.equal(response.canCreate, false);
  assert.equal(response.reason, 'SAME_JOB_SCOPE_ACTIVE');
  assert.equal(response.blockingReason, 'SAME_JOB_SCOPE_ACTIVE');
  assert.equal(response.duplicateScopeMode, 'EXACT_SCOPE');
  assert.equal(response.workScopeKey, 'section:1');
  assert.equal(response.existingJob.workScopeKey, 'section:1');
  assert.equal(response.exactScopeDuplicateExists, true);
  assert.equal(response.sameJobNumberDifferentScopeExists, false);
  assert.equal(response.futureCanCreateAfterEnablement, false);
  assert.equal(response.exactScopeJobs.length, 1);
  assert.equal(response.differentScopeJobs.length, 0);
});

test('/jobs/check-duplicate blocks completed same job number and same normalized work scope', async () => {
  const { response } = await check(
    { jobNumber: '81234', workScope: 'section 1 and 2' },
    {
      candidates: [buildJob({
        workScope: 'Sections 2, 1',
        sections: 'Sections 2, 1',
        lifecycleStatus: 'COMPLETED',
        status: 'COMPLETED',
      })],
    }
  );

  assert.equal(response.exists, true);
  assert.equal(response.allowed, false);
  assert.equal(response.reason, 'SAME_JOB_SCOPE_COMPLETED');
  assert.equal(response.existingJob.lifecycleStatus, 'COMPLETED');
});

test('/jobs/check-duplicate still blocks same job number with different work scope until duplicates are enabled', async () => {
  const { response } = await check(
    { jobNumber: '81234', workScope: 'Sections 4, 5' },
    { candidates: [buildJob({ workScope: 'Section 1', sections: 'Section 1' })] }
  );

  assert.equal(response.exists, true);
  assert.equal(response.allowed, false);
  assert.equal(response.canCreate, false);
  assert.equal(response.reason, 'SAME_JOB_NUMBER_BLOCKED_UNTIL_SCOPE_DUPLICATES_ENABLED');
  assert.equal(response.blockingReason, 'SAME_JOB_NUMBER_BLOCKED_UNTIL_SCOPE_DUPLICATES_ENABLED');
  assert.equal(response.duplicateScopeMode, 'DIFFERENT_SCOPE');
  assert.equal(response.workScopeKey, 'section:4,5');
  assert.equal(response.exactScopeDuplicateExists, false);
  assert.equal(response.sameJobNumberDifferentScopeExists, true);
  assert.equal(response.futureCanCreateAfterEnablement, true);
  assert.equal(response.exactScopeJobs.length, 0);
  assert.equal(response.differentScopeJobs.length, 1);
});

test('/jobs/check-duplicate prefers workScope over legacy sections', async () => {
  const { response } = await check(
    { jobNumber: '81234', workScope: 'Section 1', sections: 'Sections 4, 5' },
    { candidates: [buildJob({ workScope: 'Section 1', sections: 'Section 1' })] }
  );

  assert.equal(response.reason, 'SAME_JOB_SCOPE_ACTIVE');
  assert.equal(response.workScope, 'Section 1');
  assert.equal(response.workScopeKey, 'section:1');
});

test('/jobs/check-duplicate falls back to legacy sections when workScope is absent', async () => {
  const { response } = await check(
    { jobNumber: '81234', sections: 'Sections 01' },
    { candidates: [buildJob({ workScope: 'Section 1', sections: 'Section 1' })] }
  );

  assert.equal(response.reason, 'SAME_JOB_SCOPE_ACTIVE');
  assert.equal(response.workScope, 'Sections 01');
  assert.equal(response.workScopeKey, 'section:1');
});

test('/jobs/check-duplicate returns all same-number candidates split by requested work scope', async () => {
  const exactJob = buildJob({
    id: '22222222-2222-4222-8222-222222222222',
    jobId: '22222222-2222-4222-8222-222222222222',
    workScope: 'Sections 01',
    sections: 'Sections 01',
    workScopeKey: 'section:1',
  });
  const differentJob = buildJob({
    id: '33333333-3333-4333-8333-333333333333',
    jobId: '33333333-3333-4333-8333-333333333333',
    workScope: 'Sections 4, 5',
    sections: 'Sections 4, 5',
    workScopeKey: 'section:4,5',
  });
  const { response } = await check(
    { jobNumber: '81234', workScope: 'Section 1' },
    { candidates: [differentJob, exactJob] }
  );

  assert.equal(response.allowed, false);
  assert.equal(response.canCreate, false);
  assert.equal(response.reason, 'SAME_JOB_SCOPE_ACTIVE');
  assert.equal(response.duplicateScopeMode, 'MIXED_SCOPE');
  assert.equal(response.exactScopeDuplicateExists, true);
  assert.equal(response.sameJobNumberDifferentScopeExists, true);
  assert.equal(response.futureCanCreateAfterEnablement, false);
  assert.equal(response.job.jobId, exactJob.jobId);
  assert.equal(response.sameJobNumberJobs.length, 2);
  assert.equal(response.exactScopeJobs.length, 1);
  assert.equal(response.exactScopeJobs[0].jobId, exactJob.jobId);
  assert.equal(response.differentScopeJobs.length, 1);
  assert.equal(response.differentScopeJobs[0].jobId, differentJob.jobId);
});

test('/jobs/check-duplicate prefers persisted work_scope_key when available', async () => {
  const { response } = await check(
    { jobNumber: '81234', workScope: 'Section 9' },
    {
      candidates: [
        buildJob({
          workScope: 'Section 1',
          sections: 'Section 1',
          work_scope_key: 'section:9',
        }),
      ],
    }
  );

  assert.equal(response.reason, 'SAME_JOB_SCOPE_ACTIVE');
  assert.equal(response.exactScopeDuplicateExists, true);
  assert.equal(response.exactScopeJobs[0].workScopeKey, 'section:9');
});
