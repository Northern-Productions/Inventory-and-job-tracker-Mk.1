import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const runtimeAllocationApply = readFileSync(
  new URL('../../../backend/src/app/services/runtime/runtimeAllocationApply.mjs', import.meta.url),
  'utf8'
);
const edgeReadHandlers = readFileSync(
  new URL('../../../supabase/functions/_shared/routes/readHandlers.ts', import.meta.url),
  'utf8'
);

function extractBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Expected marker ${startMarker}.`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `Expected marker ${endMarker}.`);
  return source.slice(start, end);
}

test('local allocation preview supports explicit jobId without changing legacy preview fallback', () => {
  const resolverBody = extractBetween(
    runtimeAllocationApply,
    'async function resolvePreviewJobContext',
    'function ensureBoxEligibleForJobAllocation'
  );
  const previewBody = extractBetween(
    runtimeAllocationApply,
    'async function previewAllocationPlan',
    'function resolveSelectedRequirement'
  );

  assert.match(resolverBody, /payload\.jobId/);
  assert.match(resolverBody, /requireUuid\(jobIdText, 'jobId'\)/);
  assert.match(resolverBody, /findJobById\(client, orgId, jobId\)/);
  assert.match(resolverBody, /Job was not found\./);
  assert.match(resolverBody, /Job identity mismatch: selected job does not match jobNumber\./);
  assert.match(resolverBody, /resolveJobContext\(\s*client,\s*orgId,\s*payload\.jobNumber/s);
  assert.match(previewBody, /resolvePreviewJobContext\(client, orgId, payload, installDate\)/);
  assert.match(previewBody, /listJobRequirementsByJobId\(client, orgId, previewTarget\.jobId\)/);
  assert.match(previewBody, /listJobRequirementsByJob\(client, orgId, jobContext\.jobNumber\)/);
});

test('allocation apply now reuses canonical jobId preview identity resolution', () => {
  const applyBody = extractBetween(
    runtimeAllocationApply,
    'async function applyAllocationPlan',
    'export {'
  );

  assert.match(applyBody, /resolvePreviewJobContext\(client, orgId, payload, installDate\)/);
  assert.match(applyBody, /listJobRequirementsByJobId\(client, orgId, applyTarget\.jobId\)/);
  assert.match(applyBody, /listJobRequirementsByJob\(client, orgId, jobContext\.jobNumber\)/);
});

test('Edge allocation preview mirrors canonical jobId validation and job_id requirement loading', () => {
  const resolverBody = extractBetween(
    edgeReadHandlers,
    'async function resolveAllocationPreviewJobContext',
    'async function buildOrderedForJobsForBox'
  );
  const previewHandlerBody = extractBetween(
    edgeReadHandlers,
    '"/allocations/preview": async',
    '"/jobs/list": async'
  );

  assert.match(resolverBody, /params\.jobId/);
  assert.match(resolverBody, /requireUuid\(jobIdText, "jobId"\)/);
  assert.match(resolverBody, /deps\.findJobById\(client, orgId, jobId\)/);
  assert.match(resolverBody, /Job was not found\./);
  assert.match(resolverBody, /Job identity mismatch: selected job does not match jobNumber\./);
  assert.match(resolverBody, /deps\.resolveJobContext\(\s*client,\s*orgId,\s*params\.jobNumber/s);
  assert.match(previewHandlerBody, /resolveAllocationPreviewJobContext\(client, orgId, params, deps\)/);
  assert.match(previewHandlerBody, /deps\.listJobRequirementsByJobId\(client, orgId, previewTarget\.jobId, previewTarget\.job\)/);
  assert.match(previewHandlerBody, /deps\.listJobRequirementsByJob\(/);
});
