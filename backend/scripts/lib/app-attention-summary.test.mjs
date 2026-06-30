import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { isJobNeedingAllocationAttention } from '../../src/app/services/appShell.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const edgeApiHandlerPath = path.join(repoRoot, 'supabase', 'functions', '_shared', 'api-handler.ts');

function buildJob(overrides = {}) {
  return {
    lifecycleStatus: 'ACTIVE',
    status: 'FILM_ORDER',
    installDate: '2026-05-21',
    remainingFeet: 12,
    remainingTubes: 0,
    ...overrides,
  };
}

test('jobs attention flags scheduled Film Order, Ordered, and Needs Allocation jobs with remaining material needs', () => {
  assert.equal(isJobNeedingAllocationAttention(buildJob({ status: 'FILM_ORDER' })), true);
  assert.equal(isJobNeedingAllocationAttention(buildJob({ status: 'ORDERED', remainingFeet: 0, remainingTubes: 1 })), true);
  assert.equal(isJobNeedingAllocationAttention(buildJob({ status: 'NEEDS_ALLOCATION' })), true);
});

test('jobs attention ignores Ready, unscheduled, inactive, and fully covered jobs', () => {
  assert.equal(isJobNeedingAllocationAttention(buildJob({ status: 'READY' })), false);
  assert.equal(isJobNeedingAllocationAttention(buildJob({ installDate: '' })), false);
  assert.equal(isJobNeedingAllocationAttention(buildJob({ lifecycleStatus: 'CANCELLED' })), false);
  assert.equal(isJobNeedingAllocationAttention(buildJob({ remainingFeet: 0, remainingTubes: 0 })), false);
});

test('Edge jobs attention source mirrors scheduled actionable material status guard', async () => {
  const source = await readFile(edgeApiHandlerPath, 'utf8');
  const bodyStart = source.indexOf('async function hasActiveJobsNeedingAllocationForAttentionSummary');
  const bodyEnd = source.indexOf('/**', bodyStart + 1);
  const body = source.slice(bodyStart, bodyEnd);

  assert.ok(bodyStart >= 0 && bodyEnd > bodyStart, 'Expected jobs attention helper body.');
  assert.match(body, /status === "FILM_ORDER" \|\| status === "ORDERED" \|\| status === "NEEDS_ALLOCATION"/);
  assert.match(body, /installDate/);
  assert.match(body, /buildJobsList/);
});
