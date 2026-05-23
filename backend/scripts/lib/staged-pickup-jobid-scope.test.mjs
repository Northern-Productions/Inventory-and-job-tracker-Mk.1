import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');

async function readRepoFile(...parts) {
  return fs.readFile(path.join(repoRoot, ...parts), 'utf8');
}

test('staged pickup jobId scope is runtime-only and adds no migration', async () => {
  const [backendMigrations, supabaseMigrations] = await Promise.all([
    fs.readdir(path.join(repoRoot, 'backend', 'migrations')),
    fs.readdir(path.join(repoRoot, 'supabase', 'migrations')),
  ]);

  assert.equal(
    backendMigrations.some((name) => /staged[_-]pickup.*jobid|jobid.*staged[_-]pickup/i.test(name)),
    false,
  );
  assert.equal(
    supabaseMigrations.some((name) => /staged[_-]pickup.*jobid|jobid.*staged[_-]pickup/i.test(name)),
    false,
  );
});

test('frontend staged pickup sends canonical jobId and avoids unsafe legacy detail patching', async () => {
  const [domainSource, workflowSource, mutationSource] = await Promise.all([
    readRepoFile('frontend', 'src', 'domain', 'inventory', 'planning.ts'),
    readRepoFile('frontend', 'src', 'features', 'inventory', 'pages', 'allocation-job', 'useJobLifecycleWorkflow.ts'),
    readRepoFile(
      'frontend',
      'src',
      'features',
      'inventory',
      'hooks',
      'mutations',
      'planning',
      'jobMaterialWorkflowMutations.ts',
    ),
  ]);

  assert.match(domainSource, /export interface SetJobStagedForPickupPayload \{\s+jobId\?: string;/);
  assert.match(workflowSource, /setJobStagedForPickup\(\{\s+\.\.\.\(canonicalJobId \? \{ jobId: canonicalJobId \} : \{\}\),\s+jobNumber: summary\.jobNumber,/);
  assert.match(mutationSource, /const jobId = String\(payload\.jobId \|\| ''\)\.trim\(\);/);
  assert.match(mutationSource, /inventoryKeys\.jobById\(jobId\)/);
  assert.match(mutationSource, /payload\.autoCheckoutRemaining && !jobId/);
  assert.match(mutationSource, /syncAllocationJobDetail: !jobId,\s+syncLegacyJobDetail: !jobId/);
});

test('backend staged pickup validates canonical jobId before side effects', async () => {
  const [runtimeSource, handlerSource, plannerSource] = await Promise.all([
    readRepoFile('backend', 'src', 'app', 'services', 'runtime', 'runtimeJobsRead.mjs'),
    readRepoFile('backend', 'src', 'app', 'handlers', 'mutationHandlers.mjs'),
    readRepoFile('backend', 'src', 'app', 'services', 'runtime', 'runtimeAutoAllocationPlanner.mjs'),
  ]);

  assert.match(runtimeSource, /const selectedJobId = suppliedJobId \? requireUuid\(suppliedJobId, 'jobId'\) : '';/);
  assert.match(runtimeSource, /existingJob = await loadJobById\(client, orgId, selectedJobId\);/);
  assert.match(runtimeSource, /Job identity mismatch: jobId/);
  assert.match(runtimeSource, /jobId: selectedJobId,\s+allocations: await loadAllocationsByJobId/);
  assert.match(runtimeSource, /loadAllocationsByJobId\(client, orgId, selectedJobId\)/);
  assert.match(runtimeSource, /\(\$2::uuid is not null and id = \$2::uuid\)/);
  assert.match(runtimeSource, /return \{\s+\.\.\.\(selectedJobId \? \{ jobId: selectedJobId \} : \{\}\),/);
  assert.match(handlerSource, /result\.jobId\s+\? await buildJobDetailById\(client, orgId, result\.jobId\)\s+: await buildJobDetail\(client, orgId, jobNumber\)/);
  assert.match(plannerSource, /const JOB_ID_SHADOW_SCOPE_ROUTES = new Set\(\[[\s\S]*'\/jobs\/set-staged-pickup'/);
});

test('Edge staged pickup validates canonical jobId and reloads by id without planner duplication', async () => {
  const [edgeSource, routeSource] = await Promise.all([
    readRepoFile('supabase', 'functions', '_shared', 'api-handler.ts'),
    readRepoFile('supabase', 'functions', '_shared', 'routes', 'mutationHandlers.ts'),
  ]);
  const routeBody = routeSource.slice(
    routeSource.indexOf('"/jobs/set-staged-pickup": async'),
    routeSource.indexOf('"/jobs/checkout-all": async'),
  );

  assert.match(edgeSource, /const target = await resolveEdgeJobMutationTargetById\(client, orgId, payload,/);
  assert.match(edgeSource, /const targetJobId = target\.usedJobId \? requireString\(target\.jobId, "jobId"\) : "";/);
  assert.match(edgeSource, /effectiveJobId\s+\?\s+\{\s+jobId: effectiveJobId,/);
  assert.match(edgeSource, /listAllocationsByJobIdDirect\(orgId, targetJobId\)/);
  assert.match(edgeSource, /\.eq\("id", effectiveJobId\)/);
  assert.match(edgeSource, /\.\.\.\(target\.usedJobId \? \{ jobId: targetJobId \} : \{\}\),/);
  assert.match(routeSource, /const SQL_PLANNER_HANDLED_ROUTES = new Set\(\[[\s\S]*"\/jobs\/set-staged-pickup"/);
  assert.match(routeBody, /const jobId = deps\.asTrimmedString\(result\.jobId\);/);
  assert.match(routeBody, /jobId\s+\? await deps\.buildJobDetailById\(client, identity\.orgId, jobId\)\s+: await deps\.buildJobDetail\(client, identity\.orgId, jobNumber\)/);
});

test('staged pickup jobId scope keeps unrelated mutation families out of scope', async () => {
  const [runtimeSource, edgeSource] = await Promise.all([
    readRepoFile('backend', 'src', 'app', 'services', 'runtime', 'runtimeJobsRead.mjs'),
    readRepoFile('supabase', 'functions', '_shared', 'routes', 'mutationHandlers.ts'),
  ]);
  const runtimeBody = runtimeSource.slice(
    runtimeSource.indexOf('async function executeSetJobStagedPickup'),
    runtimeSource.indexOf('async function setJobStagedPickup'),
  );
  const edgeRouteBody = edgeSource.slice(
    edgeSource.indexOf('"/jobs/set-staged-pickup": async'),
    edgeSource.indexOf('"/jobs/checkout-all": async'),
  );

  assert.doesNotMatch(runtimeBody, /api_jobs_create|checkJobDuplicate|completeJob|cancelJob|deleteFilmOrder|applyAllocationPlan/);
  assert.doesNotMatch(edgeRouteBody, /\/jobs\/complete|film-orders|allocations\/apply|allocations\/caulk/);
});
