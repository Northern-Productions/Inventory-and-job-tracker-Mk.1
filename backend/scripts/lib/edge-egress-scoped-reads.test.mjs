import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const apiHandlerUrl = new URL('../../../supabase/functions/_shared/api-handler.ts', import.meta.url);
const repositoryUrl = new URL(
  '../../../supabase/functions/_shared/repositories/inventoryRepositories.ts',
  import.meta.url
);
const readHandlersUrl = new URL('../../../supabase/functions/_shared/routes/readHandlers.ts', import.meta.url);
const attentionUrl = new URL('../../../supabase/functions/_shared/services/appAttention.ts', import.meta.url);

function functionSource(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `Missing function marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing function boundary: ${endMarker}`);
  return source.slice(start, end);
}

test('job collection reads scope material rows and planning boxes before PostgREST transfer', async () => {
  const source = await readFile(apiHandlerUrl, 'utf8');
  const allocationList = functionSource(
    source,
    'export async function buildAllocationJobList',
    'async function buildAllocationJobDetail'
  );
  const jobsList = functionSource(
    source,
    'export async function buildJobsList',
    'async function buildJobsSearchResults'
  );

  for (const implementation of [allocationList, jobsList]) {
    assert.match(implementation, /loadJobSummarySnapshot\(/);
    assert.match(implementation, /listPlanningBoxesByIds\(/);
    assert.doesNotMatch(implementation, /listBoxes\(client, orgId\)/);
    assert.doesNotMatch(implementation, /listAllocations\(client, orgId\)/);
    assert.doesNotMatch(implementation, /listFilmOrders\(client, orgId\)/);
    assert.doesNotMatch(implementation, /listJobRequirements\(client, orgId\)/);
  }
  assert.match(jobsList, /selectedJobs\.map\(\(job\) => getEntryJobId\(job\)\)/);
  assert.match(jobsList, /legacyJobNumbers: Array\.from\(jobNumberFilterSet\)/);
});

test('search and calendar preselect candidates before loading job material graphs', async () => {
  const source = await readFile(apiHandlerUrl, 'utf8');
  const search = functionSource(source, 'async function buildJobsSearchResults', 'async function hasActiveJobsNeedingAllocation');
  const calendar = functionSource(source, 'async function buildJobsCalendar', 'async function buildJobDetail');

  assert.match(search, /listJobSearchCandidateNumbers\(/);
  assert.match(search, /listJobsByNumbers\(client, orgId, candidateJobNumbers\)/);
  assert.match(search, /buildJobsList\(client, orgId, 0, lifecycleFilter, candidateJobNumbers/);
  assert.doesNotMatch(search, /listJobs\(client, orgId/);
  assert.doesNotMatch(search, /loadJobSummarySnapshot\(client, orgId, \[\]/);
  assert.match(calendar, /listJobCalendarCandidateNumbers\(/);
  assert.match(calendar, /listJobsByNumbers\(client, orgId, candidateJobNumbers\)/);
  assert.match(calendar, /calendarEntryOverlapsRange\(entry, range\.startDate, range\.endDate\)/);
  assert.match(calendar, /buildJobsList\(client, orgId, 0, lifecycleFilter, candidateJobNumbers/);
  assert.doesNotMatch(calendar, /listJobPhases\(client, orgId\)/);
  assert.doesNotMatch(calendar, /loadJobSummarySnapshot\(client, orgId, \[\]/);
});

test('film-order and history reads batch headers and reuse already-loaded rows', async () => {
  const [apiSource, readSource] = await Promise.all([
    readFile(apiHandlerUrl, 'utf8'),
    readFile(readHandlersUrl, 'utf8'),
  ]);
  const filmLinking = functionSource(
    apiSource,
    'async function buildPublicFilmOrderLinkedBoxesByFilmOrderId',
    'async function buildPublicFilmOrderLinkedBoxes'
  );
  const filmSchedule = functionSource(
    apiSource,
    'async function enrichOpenFilmOrdersWithJobSchedule',
    'async function buildPublicFilmOrdersForJob'
  );

  assert.match(filmLinking, /initialFilmOrders/);
  assert.match(filmLinking, /missingFilmOrderIds/);
  assert.match(filmLinking, /listPlanningBoxesByIds/);
  assert.match(filmSchedule, /listJobsByIds/);
  assert.match(filmSchedule, /listJobsByNumbers/);
  assert.match(readSource, /deps\.listJobsByIds/);
  assert.match(readSource, /deps\.listJobsByNumbers/);
});

test('attention and inventory filters return only necessary state', async () => {
  const [apiSource, repositorySource, attentionSource] = await Promise.all([
    readFile(apiHandlerUrl, 'utf8'),
    readFile(repositoryUrl, 'utf8'),
    readFile(attentionUrl, 'utf8'),
  ]);

  assert.match(apiSource, /excludeStatuses: \["ZEROED", "RETIRED"\]/);
  assert.match(apiSource, /query = query\.neq\("status", excludedStatus\)/);
  assert.match(repositorySource, /api_acl_has_film_orders_needing_attention/);
  assert.match(repositorySource, /api_acl_job_attention_candidate_numbers/);
  assert.match(apiSource, /listJobAttentionCandidateNumbers\(client, orgId\)/);
  assert.match(attentionSource, /deps\.hasFilmOrdersNeedingAttention/);
});

test('duplicate checks and mutation response reloads use scoped batch reads', async () => {
  const [apiSource, readSource, repositorySource, mutationSource] = await Promise.all([
    readFile(apiHandlerUrl, 'utf8'),
    readFile(readHandlersUrl, 'utf8'),
    readFile(repositoryUrl, 'utf8'),
    readFile(new URL('../../../supabase/functions/_shared/routes/mutationHandlers.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(readSource, /deps\.listJobsByNumbers\(client, orgId, \[jobNumber\]\)/);
  assert.match(repositorySource, /api_acl_box_reservation_snapshot/);
  assert.match(apiSource, /loadBoxReservationSnapshot,/);

  const allocationReload = functionSource(
    mutationSource,
    'async function buildPublicAllocationsWithReservationMetrics',
    'async function clearStagedPickupForActiveRequirements'
  );
  assert.match(allocationReload, /deps\.loadBoxReservationSnapshot\(client, orgId/);
  assert.doesNotMatch(allocationReload, /deps\.listJobs\(/);
  assert.doesNotMatch(allocationReload, /deps\.findBoxById\(/);
  assert.doesNotMatch(allocationReload, /deps\.listAllocationsByBox\(/);
});
