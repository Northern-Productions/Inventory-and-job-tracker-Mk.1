import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  JOB_SUMMARY_COMPARISON_MODES,
  JobSummaryParityDiagnosticError,
  assertJobSummaryParity,
  compareJobSummaryEntries,
  observeLegacyRouteDivergences,
  selectJobSummaryComparisonMode,
} from './job-summary-parity.mjs';

function buildSummary(overrides = {}) {
  return {
    status: 'READY',
    lifecycleStatus: 'ACTIVE',
    hasOrderedAllocations: false,
    requiredFeet: 10,
    allocatedFeet: 10,
    remainingFeet: 0,
    requiredTubes: 0,
    allocatedTubes: 0,
    remainingTubes: 0,
    requirementCount: 1,
    allocationCount: 1,
    filmOrderCount: 0,
    ...overrides,
  };
}

test('canonical entries use UUID detail for numeric and nonnumeric identifiers', async () => {
  const entries = [
    buildSummary({ jobId: 101, jobNumber: '1001' }),
    buildSummary({ jobId: 'canonical-alpha', jobNumber: 'JOB-ALPHA' }),
  ];
  const calls = [];

  const result = await compareJobSummaryEntries({
    client: {},
    orgId: 'org-fixture',
    entries,
    buildJobDetail: async () => {
      throw new Error('legacy detail must not be called for canonical entries');
    },
    buildJobDetailById: async (_client, _orgId, jobId) => {
      calls.push(jobId);
      return { summary: entries.find((entry) => String(entry.jobId) === jobId) };
    },
  });

  assert.deepEqual(calls, ['101', 'canonical-alpha']);
  assert.equal(result.canonicalComparedCount, 2);
  assert.equal(result.legacyComparedCount, 0);
  assert.equal(result.mismatchCount, 0);
});

test('entries without jobId use legacy detail for numeric and nonnumeric job numbers', async () => {
  const entries = [
    buildSummary({ jobNumber: 1001 }),
    buildSummary({ jobNumber: 'JOB-ALPHA' }),
  ];
  const calls = [];

  const result = await compareJobSummaryEntries({
    client: {},
    orgId: 'org-fixture',
    entries,
    buildJobDetail: async (_client, _orgId, jobNumber) => {
      calls.push(jobNumber);
      return { summary: entries.find((entry) => String(entry.jobNumber) === jobNumber) };
    },
    buildJobDetailById: async () => {
      throw new Error('UUID detail must not be called for legacy entries');
    },
  });

  assert.deepEqual(calls, ['1001', 'JOB-ALPHA']);
  assert.equal(result.canonicalComparedCount, 0);
  assert.equal(result.legacyComparedCount, 2);
  assert.equal(result.mismatchCount, 0);
});

test('canonical lookup failure is safe and never falls back to job number', async () => {
  let legacyCallCount = 0;

  await assert.rejects(
    compareJobSummaryEntries({
      client: {},
      orgId: 'org-fixture',
      entries: [buildSummary({ jobId: 'sensitive-canonical-id', jobNumber: 'sensitive-job-number' })],
      buildJobDetail: async () => {
        legacyCallCount += 1;
        return { summary: buildSummary() };
      },
      buildJobDetailById: async () => {
        throw new Error('sensitive-canonical-id was not found');
      },
    }),
    (error) => {
      assert.ok(error instanceof JobSummaryParityDiagnosticError);
      assert.equal(error.message, 'canonical UUID detail lookup failed.');
      assert.doesNotMatch(error.message, /sensitive/i);
      return true;
    },
  );

  assert.equal(legacyCallCount, 0);
});

test('canonical parity mismatch fails with aggregate fields only', async () => {
  const result = await compareJobSummaryEntries({
    client: {},
    orgId: 'org-fixture',
    entries: [buildSummary({ jobId: 'canonical-sensitive-id', jobNumber: 'sensitive-number' })],
    buildJobDetail: async () => {
      throw new Error('legacy detail must not be called');
    },
    buildJobDetailById: async () => ({
      summary: buildSummary({ allocationCount: 3 }),
    }),
  });

  assert.equal(result.canonicalMismatchCount, 1);
  assert.equal(result.legacyMismatchCount, 0);
  assert.deepEqual(result.differingFields, { allocationCount: 1 });
  assert.throws(
    () => assertJobSummaryParity(result),
    (error) => {
      assert.match(error.message, /canonical UUID: 1/);
      assert.match(error.message, /legacy job-number: 0/);
      assert.match(error.message, /allocationCount/);
      assert.doesNotMatch(error.message, /canonical-sensitive-id|sensitive-number|\b3\b/);
      return true;
    },
  );
});

test('legacy parity mismatch is classified separately from canonical mismatch', async () => {
  const result = await compareJobSummaryEntries({
    client: {},
    orgId: 'org-fixture',
    entries: [buildSummary({ jobNumber: 'legacy-sensitive-number' })],
    buildJobDetail: async () => ({
      summary: buildSummary({ filmOrderCount: 2 }),
    }),
    buildJobDetailById: async () => {
      throw new Error('UUID detail must not be called');
    },
  });

  assert.equal(result.canonicalMismatchCount, 0);
  assert.equal(result.legacyMismatchCount, 1);
  assert.throws(
    () => assertJobSummaryParity(result),
    (error) => {
      assert.match(error.message, /canonical UUID: 0/);
      assert.match(error.message, /legacy job-number: 1/);
      assert.doesNotMatch(error.message, /legacy-sensitive-number/);
      return true;
    },
  );
});

test('legacy-route historical divergence is observed without becoming canonical failure', async () => {
  const entry = buildSummary({ jobId: 'canonical-id', jobNumber: 'legacy-number' });
  const primaryResult = await compareJobSummaryEntries({
    client: {},
    orgId: 'org-fixture',
    entries: [entry],
    buildJobDetail: async () => {
      throw new Error('legacy detail must not be called during canonical parity');
    },
    buildJobDetailById: async () => ({ summary: buildSummary() }),
  });
  const observation = await observeLegacyRouteDivergences({
    client: {},
    orgId: 'org-fixture',
    entries: [entry],
    buildJobDetail: async () => ({
      summary: buildSummary({ allocationCount: 3 }),
    }),
  });

  assert.doesNotThrow(() => assertJobSummaryParity(primaryResult));
  assert.equal(primaryResult.canonicalMismatchCount, 0);
  assert.equal(observation.classification, JOB_SUMMARY_COMPARISON_MODES.LEGACY_ROUTE_OBSERVATION);
  assert.equal(observation.observedCount, 1);
  assert.equal(observation.divergenceCount, 1);
  assert.deepEqual(observation.differingFields, { allocationCount: 1 });
  assert.doesNotMatch(JSON.stringify(observation), /canonical-id|legacy-number/);
});

test('comparison mode depends only on canonical jobId presence', () => {
  assert.equal(
    selectJobSummaryComparisonMode({ jobId: 'canonical-id', jobNumber: 'legacy-number' }),
    JOB_SUMMARY_COMPARISON_MODES.CANONICAL_UUID,
  );
  assert.equal(
    selectJobSummaryComparisonMode({ jobId: null, jobNumber: 'legacy-number' }),
    JOB_SUMMARY_COMPARISON_MODES.LEGACY_JOB_NUMBER,
  );
});

test('diagnostic command enforces read-only execution and exposes UUID detail through the script surface', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const diagnosticSource = fs.readFileSync(
    path.join(repoRoot, 'backend/scripts/verify-job-summary-parity.mjs'),
    'utf8',
  );
  const internalSource = fs.readFileSync(
    path.join(repoRoot, 'backend/src/app/internal.mjs'),
    'utf8',
  );

  assert.match(diagnosticSource, /buildJobDetailById/);
  assert.match(diagnosticSource, /begin transaction isolation level repeatable read read only/);
  assert.match(diagnosticSource, /await client\.query\("rollback"\)/);
  assert.match(diagnosticSource, /application_name: "job-summary-parity-read-only"/);
  assert.doesNotMatch(diagnosticSource, /JSON\.stringify\(mismatches|jobNumber: entry\.jobNumber/);
  assert.match(internalSource, /buildJobDetailById/);
});

test('local and Edge job lists mirror the canonical ownership fallback policy', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const sources = [
    fs.readFileSync(
      path.join(repoRoot, 'backend/src/app/services/runtime/runtimeJobsRead.mjs'),
      'utf8',
    ),
    fs.readFileSync(
      path.join(repoRoot, 'supabase/functions/_shared/api-handler.ts'),
      'utf8',
    ),
  ];

  for (const source of sources) {
    const identityBlock = source.match(
      /function getEntryJobId[\s\S]*?function getEntryJobNumber/,
    )?.[0] || '';
    const fallbackBlock = source.match(
      /function groupEntriesByJobNumberFallback[\s\S]*?function getRowsForJobHeader/,
    )?.[0] || '';
    const listBlock = source.match(
      /(?:export\s+)?async function buildJobsList[\s\S]*?async function buildJobsSearchResults/,
    )?.[0] || '';

    assert.match(identityBlock, /entry\?\.jobId \|\| entry\?\.id/);
    assert.match(identityBlock, /child[\s\S]*own id[\s\S]*job-number fallback/i);
    assert.match(fallbackBlock, /getEntryJobId\(entr(?:y|ies\[index\])\)/);
    assert.match(listBlock, /groupEntriesByCanonicalJobId\(allAllocations\)/);
    assert.match(listBlock, /groupEntriesByJobNumberFallback\(allAllocations\)/);
  }
});
