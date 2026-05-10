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

async function check(params, { existingJob = null, summary = existingJob } = {}) {
  let buildListCallCount = 0;
  const response = await checkJobDuplicate({}, 'org-1', params, {
    findJobByNumber: async (_client, orgId, jobNumber) =>
      existingJob ? { ...existingJob, orgId, jobNumber } : null,
    buildJobsList: async (_client, orgId, _limit, _status, jobNumbers) => {
      buildListCallCount += 1;
      return summary
        ? [{
            ...summary,
            orgId,
            jobNumber: Array.isArray(jobNumbers) ? jobNumbers[0] : summary.jobNumber,
          }]
        : [];
    },
  });

  return { response, buildListCallCount };
}

test('/jobs/check-duplicate keeps jobNumber-only compatibility when a duplicate exists', async () => {
  const { response } = await check('81234', {
    existingJob: buildJob({ workScope: 'Sections 4, 5', sections: 'Sections 4, 5' }),
  });

  assert.equal(response.exists, true);
  assert.equal(response.allowed, false);
  assert.equal(response.job.jobNumber, '81234');
  assert.equal(response.job.workScope, 'Sections 4, 5');
  assert.equal(response.existingJob.jobId, '11111111-1111-4111-8111-111111111111');
  assert.equal(response.existingJob.routeTarget, '/allocations/jobs/11111111-1111-4111-8111-111111111111');
});

test('/jobs/check-duplicate returns allowed no-match diagnostics for unique job numbers', async () => {
  const { response, buildListCallCount } = await check(
    { jobNumber: '81235', workScope: 'Section 1' },
    { existingJob: null }
  );

  assert.deepEqual(response, {
    exists: false,
    allowed: true,
    reason: 'NO_MATCH',
    jobNumber: '81235',
    workScope: 'Section 1',
    workScopeKey: 'section:1',
    job: null,
    existingJob: null,
    sameJobNumberJobs: [],
  });
  assert.equal(buildListCallCount, 0);
});

test('/jobs/check-duplicate blocks active same job number and same normalized work scope', async () => {
  const { response } = await check(
    { jobNumber: '81234', workScope: 'Sections 01' },
    { existingJob: buildJob({ workScope: 'Section 1', sections: 'Section 1' }) }
  );

  assert.equal(response.exists, true);
  assert.equal(response.allowed, false);
  assert.equal(response.reason, 'SAME_JOB_SCOPE_ACTIVE');
  assert.equal(response.workScopeKey, 'section:1');
  assert.equal(response.existingJob.workScopeKey, 'section:1');
});

test('/jobs/check-duplicate blocks completed same job number and same normalized work scope', async () => {
  const { response } = await check(
    { jobNumber: '81234', workScope: 'section 1 and 2' },
    {
      existingJob: buildJob({
        workScope: 'Sections 2, 1',
        sections: 'Sections 2, 1',
        lifecycleStatus: 'COMPLETED',
        status: 'COMPLETED',
      }),
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
    { existingJob: buildJob({ workScope: 'Section 1', sections: 'Section 1' }) }
  );

  assert.equal(response.exists, true);
  assert.equal(response.allowed, false);
  assert.equal(response.reason, 'SAME_JOB_NUMBER_BLOCKED_UNTIL_SCOPE_DUPLICATES_ENABLED');
  assert.equal(response.workScopeKey, 'section:4,5');
});

test('/jobs/check-duplicate prefers workScope over legacy sections', async () => {
  const { response } = await check(
    { jobNumber: '81234', workScope: 'Section 1', sections: 'Sections 4, 5' },
    { existingJob: buildJob({ workScope: 'Section 1', sections: 'Section 1' }) }
  );

  assert.equal(response.reason, 'SAME_JOB_SCOPE_ACTIVE');
  assert.equal(response.workScope, 'Section 1');
  assert.equal(response.workScopeKey, 'section:1');
});

test('/jobs/check-duplicate falls back to legacy sections when workScope is absent', async () => {
  const { response } = await check(
    { jobNumber: '81234', sections: 'Sections 01' },
    { existingJob: buildJob({ workScope: 'Section 1', sections: 'Section 1' }) }
  );

  assert.equal(response.reason, 'SAME_JOB_SCOPE_ACTIVE');
  assert.equal(response.workScope, 'Sections 01');
  assert.equal(response.workScopeKey, 'section:1');
});
