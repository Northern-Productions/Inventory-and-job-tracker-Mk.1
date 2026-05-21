// Purpose: Job list, search, calendar, detail, and staging read helpers.
import { runParallelReadTasks } from '../../../db/client.mjs';
import {
  HttpError,
  ZEROED_BOX_AUTO_CANCEL_NOTE,
  queryRow,
  queryRows,
  ok,
  asTrimmedString,
  requireString,
  normalizeStringArrayParam,
  normalizeUsername,
  normalizeDateString,
  coerceNonNegativeNumber,
  coerceOptionalNonNegativeNumber,
  coerceFeetValue,
  assertBoxStatus,
  isAllocatableBoxStatus,
  computeAllocationPlanningFeet,
  getBoxAllocationPlanningFeet,
  boxUsesOrderedPlanning,
  boxCanReceiveReleasedAllocationFeet,
  applyPlanningAllocationToBox,
  releaseAllocationFeetFromBox,
  hasActiveOrderedAllocations,
  hasActiveOrderedRequirementAllocations,
  buildOrderedAllocationReceiptMessage,
  parseBooleanFlag,
  parseStrictBooleanFlag,
  numericOrNull,
  integerOrZero,
  integerOrNull,
  normalizeAllocationKind,
  parseIntegerInput,
  requireUuid,
  cloneValue,
  createLogId,
  createTransferId,
  roundToDecimals,
  normalizeWarehouseCodeFormat,
  buildFilmKey,
  todayDateString,
  deriveAddFeetAvailable,
  deriveLifecycleStatus,
  normalizeCoreType,
  deriveCoreWeightLbs,
  deriveLfWeightLbsPerFt,
  deriveInitialWeightLbs,
  deriveSqFtWeightLbsPerSqFt,
  deriveFeetAvailableFromRollWeight,
  clampFeetToInitialRange,
  deriveLfWeightLbsPerFtIfPossible,
  isLowStockBox,
  hasPositivePhysicalFeet,
  hasIncompleteBoxHistoryForZeroedEdit,
  hasExplicitZeroNumericInput,
  hasExplicitZeroFeetAvailableInput,
  determineZeroedReason,
  normalizeMeaningfulZeroedNote,
  stampZeroedMetadata,
  applyAddOrEditWarnings,
  applyCheckoutWarnings,
  applyCheckInWarnings,
  compareCatalogStrings,
  normalizeRequirementWidthKey,
  canonicalizeNumericDigits,
  normalizeCollapsedCatalogLabel,
  canonicalizeManufacturerLabel,
  normalizeCatalogLookupKey,
  normalizeCatalogManufacturerLookupKey,
  assertAveryNaturaShadeForWrite,
  normalizeCanonicalManufacturerAndFilm,
  normalizeCatalogWriteManufacturerAndFilm,
  normalizeFilmKeyInput,
  normalizeCatalogWriteFilmKeyInput,
  resolveCanonicalFilmNameAlias,
  resolveCanonicalFilmEntry,
  resolveCatalogWriteFilmEntry,
  dedupeNormalizedJobRequirements,
  canonicalizeJobRequirementEntriesWithAliases,
  normalizeJobRequirementInput,
  normalizeJobNumberDigits,
  normalizeJobWarehouse,
  normalizeJobWorkScope,
  normalizeJobLifecycleStatus,
  normalizeJobLifecycleFilter,
  normalizeJobRequirementLookupKey,
  dedupeJobRequirements,
  normalizeJobNumberKey,
  normalizeCrewLeaderKey,
  compareBoxesByOldestStock,
  compareAllocationJobSummaries,
  compareJobsListEntries,
  extractJobNumberDigitsForSearch,
  compareBigInt,
  absoluteBigInt,
  mapDbBoxRow,
  toPublicBox,
  mapDbBoxTransferRow,
  toPublicBoxTransfer,
  mapDbFilmCatalogRow,
  mapDbAllocationRow,
  toPublicAllocation,
  mapDbFilmOrderRow,
  toPublicFilmOrder,
  mapDbFilmOrderLinkRow,
  mapDbJobRow,
  mapDbRequirementRow,
  mapDbCaulkJobRequirementRow,
  mapDbCaulkJobAllocationRow,
  mapDbCaulkJobCheckoutRow,
  mapDbAuditRow,
  mapDbRollHistoryRow,
  mapCaulkManufacturerRow,
  mapCaulkProductRow,
  mapCaulkStockRow,
  mapCaulkTransactionRow,
  normalizeCaulkCaseMath,
  listWarehouseCodes,
  requireConfiguredWarehouse,
  findWarehouseEntry,
  getBoxIdPrefixToken,
  getTransferredBoxIdSuffix,
  buildTransferredBoxId,
  resolveBoxIdAlias,
  resolveWarehouseFromBoxId,
  buildBoxSelectColumns,
  listBoxes,
  listBoxesByIds,
  findBoxById,
  saveBoxRecord,
  findBoxByRecordId,
  findBoxTransferByTransferId,
  listBoxTransfersByBoxRecordId,
  getLatestBoxTransferByBoxId,
  findPendingBoxTransferByBoxRecordId,
  listPendingBoxTransfersByBoxRecordIds,
  indexPendingBoxTransfersByBoxRecordId,
  saveBoxTransferRecord,
  deleteBoxRecord,
  listAllocationsByBox,
  listFilmCatalog,
  findFilmCatalogByFilmKey,
  seedFilmCatalogRecordIfMissing,
  upsertFilmCatalogRecord,
  listAllocations,
  listAllocationsByJob,
  listAllocationsByJobId,
  listAllocationsByFilmOrderId,
  listActiveAllocations,
  saveAllocationRecord,
  listFilmOrders,
  listFilmOrdersByJob,
  listFilmOrdersByJobId,
  findFilmOrderById,
  saveFilmOrderRecord,
  deleteFilmOrderRecord,
  listFilmOrderLinks,
  listFilmOrderLinksByFilmOrderId,
  listFilmOrderLinksByBoxId,
  saveFilmOrderLinkRecord,
  deleteFilmOrderLinksByFilmOrderId,
  listJobs,
  listJobsByNumber,
  findJobByNumber,
  findJobById,
  saveJobRecord,
  listJobPhases,
  listJobRequirements,
  listJobRequirementsByJob,
  listJobRequirementsByJobId,
  listJobCaulkRequirements,
  listJobCaulkRequirementsByJob,
  listJobCaulkRequirementsByJobId,
  listCaulkJobAllocations,
  listCaulkJobAllocationsByJob,
  listCaulkJobAllocationsByJobId,
  listCaulkJobCheckoutsByJob,
  replaceJobRequirementsForJob,
  normalizeJobCaulkRequirementEntries,
  replaceJobCaulkRequirementsForJob,
  parseExplicitJobLaborOnlyValue,
  hasJobMaterialRequirements,
  derivePersistedJobMaterialFlags,
  deleteJobRequirementsByJobId,
  deleteJobRecord,
  listAuditEntries,
  listAuditEntriesByBox,
  findAuditEntryByLogId,
  appendAuditEntry,
  listRollHistoryByBox,
  listRollHistoryByJob,
  appendRollHistoryEntry,
  computeCoveredFeetForAllocation,
  isSplitCoveragePair,
  planCoverageAllocation,
  matchesBoxSearchQuery,
  rankBoxSearchCandidates,
  canSharedJobPlanningFilmSatisfyRequirement,
  compareSharedJobPlanningFilmMatches,
  describeSharedJobPlanningFilm,
  getSharedJobPlanningFilmMatch,
  rankJobNumberSearchCandidates,
} from '../runtimeDeps.mjs';
import { buildPublicJobRequirementEntries, buildPublicCaulkRequirementEntries } from './runtimeAllocationCoverage.mjs';
import { buildJobListEntry, buildLegacyJobHeaderFromData, deriveJobStatusFromLegacyAllocationData } from './runtimeJobSummaries.mjs';
import { checkoutAllJobMaterials, loadJobStagingValidationState } from './runtimeCheckoutOperations.mjs';
import {
  buildJobDuplicateCheckResult,
  getJobDuplicateWorkScopeInput,
} from '../../../../../shared/domain/jobDuplicateContract.mjs';
import {
  buildJobDetailPayload,
  loadJobDetailContext,
  loadJobDetailContextById,
  loadJobDetailContextWithPooledReads,
  loadJobDetailContextByIdWithPooledReads,
  assertLegacyJobNumberReadIsUnambiguousWithPooledReads,
} from './runtimeJobDetails.mjs';

const SUMMARY_SNAPSHOT_READ_CONCURRENCY = 2;

function getWorkScopeInput(payload) {
  return Object.prototype.hasOwnProperty.call(payload || {}, 'workScope')
    ? payload.workScope
    : payload?.sections;
}

function normalizeSummarySnapshotConcurrency(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return SUMMARY_SNAPSHOT_READ_CONCURRENCY;
  }

  return Math.floor(numericValue);
}

function getEntryJobId(entry) {
  return asTrimmedString(entry?.jobId || entry?.id);
}

function getEntryJobNumber(entry) {
  return asTrimmedString(entry?.jobNumber);
}

function groupEntriesByCanonicalJobId(entries) {
  const grouped = {};
  for (let index = 0; index < entries.length; index += 1) {
    const jobId = getEntryJobId(entries[index]);
    if (!jobId) {
      continue;
    }
    if (!grouped[jobId]) {
      grouped[jobId] = [];
    }
    grouped[jobId].push(entries[index]);
  }
  return grouped;
}

function groupEntriesByJobNumberFallback(entries, { includeScopedRows = false } = {}) {
  const grouped = {};
  for (let index = 0; index < entries.length; index += 1) {
    if (!includeScopedRows && getEntryJobId(entries[index])) {
      continue;
    }
    const jobNumber = getEntryJobNumber(entries[index]);
    if (!jobNumber) {
      continue;
    }
    if (!grouped[jobNumber]) {
      grouped[jobNumber] = [];
    }
    grouped[jobNumber].push(entries[index]);
  }
  return grouped;
}

function getRowsForJobHeader(header, rowsByJobId, unscopedRowsByJobNumber, jobNumberHeaderCounts) {
  const jobId = getEntryJobId(header);
  const jobNumber = getEntryJobNumber(header);
  const scopedRows = jobId ? rowsByJobId[jobId] || [] : [];
  const fallbackRows = jobNumberHeaderCounts[jobNumber] === 1
    ? unscopedRowsByJobNumber[jobNumber] || []
    : [];
  return fallbackRows.length ? [...scopedRows, ...fallbackRows] : scopedRows;
}

function getRowsForLegacyJobNumber(jobNumber, rowsByJobNumber) {
  return rowsByJobNumber[jobNumber] || [];
}

function collectLegacyJobNumbersFromRows(rows, legacyJobNumbers, jobNumberFilterSet) {
  for (let index = 0; index < rows.length; index += 1) {
    const jobNumber = getEntryJobNumber(rows[index]);
    if (!jobNumber || (jobNumberFilterSet && !jobNumberFilterSet.has(jobNumber))) {
      continue;
    }
    legacyJobNumbers.add(jobNumber);
  }
}

function collectAllocationBoxIds(allocations) {
  return Array.from(
    new Set(
      (Array.isArray(allocations) ? allocations : [])
        .map((entry) => asTrimmedString(entry?.boxId))
        .filter(Boolean)
    )
  );
}

function shouldUsePooledSummaryReads(client) {
  return !client || typeof client.release === 'function';
}

async function runBoundedTasksOnClient(client, taskFactories, maxConcurrency) {
  const results = new Array(taskFactories.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < taskFactories.length) {
      const taskIndex = nextIndex;
      nextIndex += 1;
      results[taskIndex] = await taskFactories[taskIndex](client);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(maxConcurrency, taskFactories.length) },
      () => runWorker()
    )
  );
  return results;
}

async function runSummarySnapshotReads(client, taskFactories, maxConcurrency = SUMMARY_SNAPSHOT_READ_CONCURRENCY) {
  if (shouldUsePooledSummaryReads(client)) {
    return runParallelReadTasks(taskFactories, { maxConcurrency });
  }

  return runBoundedTasksOnClient(client, taskFactories, maxConcurrency);
}

/**
 * PURPOSE:
 * Builds public job-list summaries from org-scoped job, allocation, order,
 * requirement, box, and caulk snapshots.
 *
 * AFFECTS:
 * Jobs list/search/calendar reads, allocation job summaries, app shell job
 * previews, and reports that reuse job summary state.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * /jobs/list, /jobs/search, /jobs/calendar, /allocations/jobs,
 * /reports/summary, Edge api-handler parity, and job summary parity checks.
 *
 * COMMON FAILURE MODES:
 * Duplicate full-org reads, stale preloaded snapshots, local/Edge drift,
 * changed sort/filter behavior, or report response-shape regressions.
 */
async function buildJobsList(client, orgId, limit, lifecycleStatus, jobNumbers = [], options = {}) {
  const lifecycleFilter = normalizeJobLifecycleFilter(lifecycleStatus);
  const normalizedJobNumberFilters = normalizeStringArrayParam(jobNumbers);
  const jobNumberFilterSet = normalizedJobNumberFilters.length
    ? new Set(normalizedJobNumberFilters)
    : null;
  const hasPreloadedBoxes = Array.isArray(options.preloadedBoxes);
  const snapshotConcurrency = normalizeSummarySnapshotConcurrency(options.snapshotConcurrency);
  const readTasks = [
    (readClient) => listJobs(readClient, orgId),
    (readClient) => listAllocations(readClient, orgId),
    (readClient) => listFilmOrders(readClient, orgId),
    (readClient) => listJobPhases(readClient, orgId),
    (readClient) => listJobRequirements(readClient, orgId),
    (readClient) => listJobCaulkRequirements(readClient, orgId),
    (readClient) => listCaulkJobAllocations(readClient, orgId),
  ];

  const snapshotResults = await runSummarySnapshotReads(client, readTasks, snapshotConcurrency);
  let snapshotIndex = 0;
  const jobs = snapshotResults[snapshotIndex++];
  const allAllocations = snapshotResults[snapshotIndex++];
  const allFilmOrders = snapshotResults[snapshotIndex++];
  const allPhases = snapshotResults[snapshotIndex++];
  const allRequirements = snapshotResults[snapshotIndex++];
  const allCaulkRequirements = snapshotResults[snapshotIndex++];
  const allCaulkAllocations = snapshotResults[snapshotIndex++];
  const allBoxes = hasPreloadedBoxes
    ? options.preloadedBoxes
    : (
        await runSummarySnapshotReads(
          client,
          [(readClient) => listBoxesByIds(readClient, orgId, collectAllocationBoxIds(allAllocations))],
          1
        )
      )[0];
  const allocationsByJobId = groupEntriesByCanonicalJobId(allAllocations);
  const filmOrdersByJobId = groupEntriesByCanonicalJobId(allFilmOrders);
  const phasesByJobId = groupEntriesByCanonicalJobId(allPhases);
  const requirementsByJobId = groupEntriesByCanonicalJobId(allRequirements);
  const caulkRequirementsByJobId = groupEntriesByCanonicalJobId(allCaulkRequirements);
  const caulkAllocationsByJobId = groupEntriesByCanonicalJobId(allCaulkAllocations);
  const legacyAllocationsByJobNumber = groupEntriesByJobNumberFallback(allAllocations);
  const legacyFilmOrdersByJobNumber = groupEntriesByJobNumberFallback(allFilmOrders);
  const legacyRequirementsByJobNumber = groupEntriesByJobNumberFallback(allRequirements);
  const legacyCaulkRequirementsByJobNumber = groupEntriesByJobNumberFallback(allCaulkRequirements);
  const legacyCaulkAllocationsByJobNumber = groupEntriesByJobNumberFallback(allCaulkAllocations);
  const allAllocationsByJobNumber = groupEntriesByJobNumberFallback(allAllocations, { includeScopedRows: true });
  const allFilmOrdersByJobNumber = groupEntriesByJobNumberFallback(allFilmOrders, { includeScopedRows: true });
  const allRequirementsByJobNumber = groupEntriesByJobNumberFallback(allRequirements, { includeScopedRows: true });
  const allCaulkRequirementsByJobNumber = groupEntriesByJobNumberFallback(allCaulkRequirements, { includeScopedRows: true });
  const allCaulkAllocationsByJobNumber = groupEntriesByJobNumberFallback(allCaulkAllocations, { includeScopedRows: true });
  const jobHeaders = [];
  const jobNumberHeaderCounts = {};
  const legacyJobNumbers = new Set();
  const boxById = {};
  const response = [];

  for (let index = 0; index < allBoxes.length; index += 1) {
    boxById[allBoxes[index].boxId] = allBoxes[index];
  }

  for (let index = 0; index < jobs.length; index += 1) {
    if (jobNumberFilterSet && !jobNumberFilterSet.has(jobs[index].jobNumber)) {
      continue;
    }
    const jobNumber = getEntryJobNumber(jobs[index]);
    jobHeaders.push(jobs[index]);
    jobNumberHeaderCounts[jobNumber] = (jobNumberHeaderCounts[jobNumber] || 0) + 1;
  }

  collectLegacyJobNumbersFromRows(allAllocations, legacyJobNumbers, jobNumberFilterSet);
  collectLegacyJobNumbersFromRows(allFilmOrders, legacyJobNumbers, jobNumberFilterSet);
  collectLegacyJobNumbersFromRows(allRequirements, legacyJobNumbers, jobNumberFilterSet);
  collectLegacyJobNumbersFromRows(allCaulkRequirements, legacyJobNumbers, jobNumberFilterSet);
  collectLegacyJobNumbersFromRows(allCaulkAllocations, legacyJobNumbers, jobNumberFilterSet);

  const jobContexts = jobHeaders.map((header) => ({
    jobNumber: getEntryJobNumber(header),
    header,
    legacy: false
  }));

  for (const jobNumber of legacyJobNumbers) {
    if (!jobNumberHeaderCounts[jobNumber]) {
      jobContexts.push({
        jobNumber,
        header: null,
        legacy: true
      });
    }
  }

  for (let index = 0; index < jobContexts.length; index += 1) {
    const context = jobContexts[index];
    const jobNumber = context.jobNumber;
    const allocations = context.legacy
      ? getRowsForLegacyJobNumber(jobNumber, allAllocationsByJobNumber)
      : getRowsForJobHeader(context.header, allocationsByJobId, legacyAllocationsByJobNumber, jobNumberHeaderCounts);
    const filmOrders = context.legacy
      ? getRowsForLegacyJobNumber(jobNumber, allFilmOrdersByJobNumber)
      : getRowsForJobHeader(context.header, filmOrdersByJobId, legacyFilmOrdersByJobNumber, jobNumberHeaderCounts);
    const requirements = buildPublicJobRequirementEntries(
      context.legacy
        ? getRowsForLegacyJobNumber(jobNumber, allRequirementsByJobNumber)
        : getRowsForJobHeader(context.header, requirementsByJobId, legacyRequirementsByJobNumber, jobNumberHeaderCounts),
      allocations,
      boxById
    );
    const header = context.header || buildLegacyJobHeaderFromData(jobNumber, allocations, filmOrders);
    const publicCaulkRequirements = buildPublicCaulkRequirementEntries(
      context.legacy
        ? getRowsForLegacyJobNumber(jobNumber, allCaulkRequirementsByJobNumber)
        : getRowsForJobHeader(
            context.header,
            caulkRequirementsByJobId,
            legacyCaulkRequirementsByJobNumber,
            jobNumberHeaderCounts
          ),
      context.legacy
        ? getRowsForLegacyJobNumber(jobNumber, allCaulkAllocationsByJobNumber)
        : getRowsForJobHeader(
            context.header,
            caulkAllocationsByJobId,
            legacyCaulkAllocationsByJobNumber,
            jobNumberHeaderCounts
          ),
      {
        jobNumber,
        jobWarehouse: header?.warehouse || ''
      }
    );

    const entry = buildJobListEntry(
      header,
      requirements,
      allocations,
      filmOrders,
      allAllocations,
      publicCaulkRequirements,
      boxById,
      {
        phases: context.legacy ? [] : getRowsForJobHeader(context.header, phasesByJobId, {}, jobNumberHeaderCounts),
        allBoxes,
        caulkAllocations: context.legacy
          ? getRowsForLegacyJobNumber(jobNumber, allCaulkAllocationsByJobNumber)
          : getRowsForJobHeader(
              context.header,
              caulkAllocationsByJobId,
              legacyCaulkAllocationsByJobNumber,
              jobNumberHeaderCounts
            ),
      }
    );

    if (lifecycleFilter && entry.lifecycleStatus !== lifecycleFilter) {
      continue;
    }
    if (lifecycleFilter === 'COMPLETED' && entry.status !== 'COMPLETED') {
      continue;
    }

    response.push(entry);
  }

  response.sort(compareJobsListEntries);

  if (limit > 0 && response.length > limit) {
    return response.slice(0, limit);
  }

  return response;
}

async function buildJobsSearchResults(client, orgId, query, limit, lifecycleStatus) {
  const normalizedQueryDigits = extractJobNumberDigitsForSearch(query);
  if (!normalizedQueryDigits) {
    return [];
  }

  const lifecycleFilter = normalizeJobLifecycleFilter(lifecycleStatus) || 'ACTIVE';
  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 25;
  const entries = await buildJobsList(client, orgId, 0, lifecycleFilter);
  return rankJobNumberSearchCandidates(entries, normalizedQueryDigits, {
    compareWithinMatch: compareJobsListEntries,
    limit: normalizedLimit
  });
}

async function checkJobDuplicate(client, orgId, params, deps = {}) {
  const normalizeJobNumber = deps.normalizeJobNumberDigits || normalizeJobNumberDigits;
  const listCandidates = deps.listJobsByNumber || listJobsByNumber;
  const rawJobNumber = params && typeof params === 'object' ? params.jobNumber : params;
  const workScopeInput = params && typeof params === 'object'
    ? getJobDuplicateWorkScopeInput(params)
    : undefined;
  const jobNumber = normalizeJobNumber(rawJobNumber, 'JobNumber');
  const sameJobNumberJobs = await listCandidates(client, orgId, jobNumber);
  return buildJobDuplicateCheckResult({
    jobNumber,
    workScopeInput,
    existingJob: sameJobNumberJobs[0] || null,
    sameJobNumberJobs,
    duplicatesEnabled: true,
  });
}

function normalizeCalendarMonth(value) {
  const month = asTrimmedString(value);
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new HttpError(400, 'month must use yyyy-mm.');
  }

  return month;
}

function normalizeCalendarView(value) {
  const normalized = asTrimmedString(value).toLowerCase();
  if (!normalized || normalized === 'month') {
    return 'month';
  }

  if (normalized === 'week') {
    return 'week';
  }

  throw new HttpError(400, 'view must be week or month.');
}

function parseCalendarDate(value) {
  const match = asTrimmedString(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const dayOfMonth = Number(match[3]);
  const parsed = new Date(year, monthIndex, dayOfMonth);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== monthIndex ||
    parsed.getDate() !== dayOfMonth
  ) {
    return null;
  }

  return parsed;
}

function formatCalendarDate(date) {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function normalizeCalendarAnchorDate(anchorDate, monthFallback) {
  const parsedAnchorDate = parseCalendarDate(anchorDate);
  if (parsedAnchorDate) {
    return formatCalendarDate(parsedAnchorDate);
  }

  const month = asTrimmedString(monthFallback);
  if (month) {
    return `${normalizeCalendarMonth(month)}-01`;
  }

  throw new HttpError(400, 'anchorDate must use yyyy-mm-dd.');
}

function shiftCalendarDate(anchorDate, deltaDays) {
  const parsedAnchorDate = parseCalendarDate(anchorDate);
  if (!parsedAnchorDate) {
    throw new HttpError(400, 'anchorDate must use yyyy-mm-dd.');
  }

  return formatCalendarDate(
    new Date(
      parsedAnchorDate.getFullYear(),
      parsedAnchorDate.getMonth(),
      parsedAnchorDate.getDate() + deltaDays
    )
  );
}

function getCalendarWeekStart(anchorDate) {
  const parsedAnchorDate = parseCalendarDate(anchorDate);
  if (!parsedAnchorDate) {
    throw new HttpError(400, 'anchorDate must use yyyy-mm-dd.');
  }

  return formatCalendarDate(
    new Date(
      parsedAnchorDate.getFullYear(),
      parsedAnchorDate.getMonth(),
      parsedAnchorDate.getDate() - parsedAnchorDate.getDay()
    )
  );
}

function buildPhaseCalendarEntries(entries) {
  const response = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const phases = Array.isArray(entry?.phases) ? entry.phases : [];
    const phaseSource = phases.length
      ? phases
      : [{
          phaseId: entry.phaseId,
          phaseNumber: entry.phaseNumber || 1,
          installDate: entry.installDate,
          installEndDate: entry.installEndDate,
          crewLeader: entry.crewLeader,
          status: entry.status,
          workScope: entry.workScope ?? entry.sections,
          sections: entry.sections ?? entry.workScope,
        }];

    for (let phaseIndex = 0; phaseIndex < phaseSource.length; phaseIndex += 1) {
      const phase = phaseSource[phaseIndex];
      const installDate = asTrimmedString(phase.installDate);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(installDate)) {
        continue;
      }
      const rawEndDate = asTrimmedString(phase.installEndDate);
      const installEndDate = /^\d{4}-\d{2}-\d{2}$/.test(rawEndDate) && rawEndDate >= installDate
        ? rawEndDate
        : '';
      response.push({
        ...entry,
        installDate,
        installEndDate,
        crewLeader: asTrimmedString(phase.crewLeader),
        status: asTrimmedString(phase.status) || entry.status,
        workScope: phase.workScope ?? phase.sections ?? entry.workScope,
        sections: phase.sections ?? phase.workScope ?? entry.sections,
        phaseId: asTrimmedString(phase.phaseId),
        phaseNumber: integerOrZero(phase.phaseNumber) || phaseIndex + 1,
        phaseWorkScope: phase.workScope ?? phase.sections ?? entry.workScope,
      });
    }
  }

  return response;
}

function calendarEntryOverlapsRange(entry, rangeStart, rangeEnd) {
  const installDate = asTrimmedString(entry.installDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(installDate)) {
    return false;
  }
  const rawEndDate = asTrimmedString(entry.installEndDate);
  const installEndDate = /^\d{4}-\d{2}-\d{2}$/.test(rawEndDate) && rawEndDate >= installDate
    ? rawEndDate
    : installDate;
  return installDate <= rangeEnd && installEndDate >= rangeStart;
}

function getCalendarMonthRange(anchorDate) {
  const year = Number(anchorDate.slice(0, 4));
  const monthIndex = Number(anchorDate.slice(5, 7)) - 1;
  const startDate = `${anchorDate.slice(0, 7)}-01`;
  if (!Number.isInteger(year) || !Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    return { startDate, endDate: startDate };
  }

  return {
    startDate,
    endDate: formatCalendarDate(new Date(year, monthIndex + 1, 0)),
  };
}

async function buildJobsCalendar(client, orgId, view, anchorDate, month, lifecycleStatus) {
  const normalizedView = normalizeCalendarView(view);
  const normalizedAnchorDate = normalizeCalendarAnchorDate(anchorDate, month);
  const lifecycleFilter = normalizeJobLifecycleFilter(lifecycleStatus) || 'ACTIVE';
  const entries = buildPhaseCalendarEntries(await buildJobsList(client, orgId, 0, lifecycleFilter));
  if (normalizedView === 'week') {
    const weekStart = getCalendarWeekStart(normalizedAnchorDate);
    const weekEnd = shiftCalendarDate(weekStart, 6);
    return entries.filter((entry) => calendarEntryOverlapsRange(entry, weekStart, weekEnd));
  }

  const monthRange = getCalendarMonthRange(normalizedAnchorDate);
  return entries.filter((entry) => calendarEntryOverlapsRange(entry, monthRange.startDate, monthRange.endDate));
}

async function buildJobDetail(client, orgId, jobNumber) {
  return buildJobDetailPayload(await loadJobDetailContext(client, orgId, jobNumber));
}

async function buildJobDetailById(client, orgId, jobId) {
  return buildJobDetailPayload(await loadJobDetailContextById(client, orgId, jobId));
}

async function buildReadJobDetail(orgId, jobNumber) {
  await assertLegacyJobNumberReadIsUnambiguousWithPooledReads(orgId, jobNumber);
  return buildJobDetailPayload(await loadJobDetailContextWithPooledReads(orgId, jobNumber));
}

async function buildReadJobDetailById(orgId, jobId) {
  return buildJobDetailPayload(await loadJobDetailContextByIdWithPooledReads(orgId, jobId));
}

async function executeSetJobStagedPickup(
  client,
  orgId,
  jobNumber,
  isStagedForPickup,
  actor,
  payload = {},
  deps = {}
) {
  const normalizeJobNumber = deps.normalizeJobNumberDigits || normalizeJobNumberDigits;
  const trimString = deps.asTrimmedString || asTrimmedString;
  const resolveJobHeader = deps.resolveExistingOrLegacyJobHeader || resolveExistingOrLegacyJobHeader;
  const normalizeLifecycleStatus = deps.normalizeJobLifecycleStatus || normalizeJobLifecycleStatus;
  const runCheckoutAllJobMaterials = deps.checkoutAllJobMaterials || checkoutAllJobMaterials;
  const loadStagingValidationState = deps.loadJobStagingValidationState || loadJobStagingValidationState;
  const loadJobById = deps.findJobById || findJobById;
  const loadAllocationsByJobId = deps.listAllocationsByJobId || listAllocationsByJobId;
  const loadFilmOrdersByJobId = deps.listFilmOrdersByJobId || listFilmOrdersByJobId;
  const loadJobRequirementsByJobId = deps.listJobRequirementsByJobId || listJobRequirementsByJobId;
  const loadJobCaulkRequirementsByJobId = deps.listJobCaulkRequirementsByJobId || listJobCaulkRequirementsByJobId;
  const loadCaulkJobAllocationsByJobId = deps.listCaulkJobAllocationsByJobId || listCaulkJobAllocationsByJobId;
  const runQueryRow = deps.queryRow || queryRow;
  const mapJob = deps.mapDbJobRow || mapDbJobRow;
  const nowIso = deps.nowIso || new Date().toISOString();
  let normalizedJobNumber = normalizeJobNumber(jobNumber, 'JobNumber');
  const suppliedJobId = trimString(payload?.jobId);
  const selectedJobId = suppliedJobId ? requireUuid(suppliedJobId, 'jobId') : '';
  const warnings = [];
  const normalizedFlag = typeof isStagedForPickup === 'boolean'
    ? String(isStagedForPickup)
    : trimString(isStagedForPickup).toLowerCase();
  let nextIsStaged = null;

  if (normalizedFlag === 'true' || normalizedFlag === 't' || normalizedFlag === '1' || normalizedFlag === 'yes' || normalizedFlag === 'on') {
    nextIsStaged = true;
  } else if (
    normalizedFlag === 'false' ||
    normalizedFlag === 'f' ||
    normalizedFlag === '0' ||
    normalizedFlag === 'no' ||
    normalizedFlag === 'off'
  ) {
    nextIsStaged = false;
  }

  if (nextIsStaged === null) {
    throw new HttpError(400, 'isStagedForPickup must be true or false.');
  }

  let resolvedContext = null;
  let existingJob = null;

  if (selectedJobId) {
    existingJob = await loadJobById(client, orgId, selectedJobId);
    if (!existingJob) {
      throw new HttpError(404, `Job ${selectedJobId} was not found.`);
    }
    const selectedJobNumber = normalizeJobNumber(existingJob.jobNumber, 'JobNumber');
    if (normalizeJobNumberKey(selectedJobNumber) !== normalizeJobNumberKey(normalizedJobNumber)) {
      throw new HttpError(
        409,
        `Job identity mismatch: jobId ${selectedJobId} belongs to job ${selectedJobNumber}, not ${normalizedJobNumber}.`
      );
    }
    normalizedJobNumber = selectedJobNumber;
    resolvedContext = {
      header: existingJob,
      allocations: null,
      filmOrders: null
    };
  } else {
    resolvedContext = await resolveJobHeader(client, orgId, normalizedJobNumber, actor, nowIso);
    existingJob = resolvedContext.header;
  }

  if (!existingJob) {
    throw new HttpError(404, `Job ${normalizedJobNumber} was not found.`);
  }

  if (normalizeLifecycleStatus(existingJob.lifecycleStatus) !== 'ACTIVE') {
    throw new HttpError(400, `Job ${normalizedJobNumber} is closed and staged pickup cannot be changed.`);
  }

  if (nextIsStaged) {
    let stagingState = null;
    const autoCheckoutRemaining = payload.autoCheckoutRemaining === true || String(payload.autoCheckoutRemaining) === 'true';

    if (autoCheckoutRemaining) {
      const checkoutResult = await runCheckoutAllJobMaterials(
        client,
        orgId,
        selectedJobId
          ? {
              jobId: selectedJobId,
              jobNumber: normalizedJobNumber
            }
          : normalizedJobNumber,
        actor
      );
      if (checkoutResult && Array.isArray(checkoutResult.warnings)) {
        for (let index = 0; index < checkoutResult.warnings.length; index += 1) {
          const warning = trimString(checkoutResult.warnings[index]);
          if (warning) {
            warnings.push(warning);
          }
        }
      }
      stagingState = checkoutResult?.stagingState || null;
    }

    if (!stagingState) {
      const seedData = selectedJobId
        ? {
            allocations: await loadAllocationsByJobId(client, orgId, selectedJobId),
            filmOrders: await loadFilmOrdersByJobId(client, orgId, selectedJobId),
            requirements: await loadJobRequirementsByJobId(client, orgId, selectedJobId),
            caulkRequirements: await loadJobCaulkRequirementsByJobId(client, orgId, selectedJobId),
            caulkAllocations: await loadCaulkJobAllocationsByJobId(client, orgId, selectedJobId)
          }
        : {
            allocations: resolvedContext.allocations || undefined,
            filmOrders: resolvedContext.filmOrders || undefined
          };
      stagingState = await loadStagingValidationState(
        client,
        orgId,
        normalizedJobNumber,
        existingJob.warehouse,
        seedData
      );
    }

    if (stagingState.blockingReason) {
      throw new HttpError(400, stagingState.blockingReason);
    }
  }

  const row = await runQueryRow(
    client,
    `
      update app.jobs
      set
        is_staged_for_pickup = $4,
        updated_at = $5::timestamptz,
        updated_by = $6
      where org_id = $1
        and (
          ($2::uuid is not null and id = $2::uuid)
          or ($2::uuid is null and upper(trim(job_number)) = upper(trim($3)))
        )
      returning *
    `,
    [
      orgId,
      selectedJobId || null,
      normalizedJobNumber,
      nextIsStaged,
      nowIso,
      actor
    ]
  );

  if (!row) {
    return null;
  }

  const savedJob = mapJob(row);
  return {
    ...(selectedJobId ? { jobId: selectedJobId } : {}),
    jobNumber: savedJob.jobNumber,
    isStagedForPickup: savedJob.isStagedForPickup,
    updatedAt: savedJob.updatedAt,
    warnings
  };
}

async function setJobStagedPickup(client, orgId, jobNumber, isStagedForPickup, actor, payload = {}) {
  return executeSetJobStagedPickup(client, orgId, jobNumber, isStagedForPickup, actor, payload);
}

async function ensureJobHeaderForUpdate(client, orgId, jobNumber, payload, user, nowIso) {
  const existing = await findJobByNumber(client, orgId, jobNumber);
  if (existing) {
    return existing;
  }

  const legacyAllocations = await listAllocationsByJob(client, orgId, jobNumber);
  const legacyFilmOrders = await listFilmOrdersByJob(client, orgId, jobNumber);
  const derived = buildLegacyJobHeaderFromData(jobNumber, legacyAllocations, legacyFilmOrders);

  derived.warehouse = payload.warehouse ? normalizeJobWarehouse(payload.warehouse) : derived.warehouse;
  derived.sections = normalizeJobWorkScope(getWorkScopeInput(payload));
  derived.installDate = normalizeDateString(
    payload.installDate !== undefined ? payload.installDate : payload.dueDate,
    'Install Date',
    true
  );
  derived.crewLeader =
    payload.crewLeader !== undefined ? asTrimmedString(payload.crewLeader) : derived.crewLeader;
  derived.lifecycleStatus = normalizeJobLifecycleStatus(payload.lifecycleStatus);
  derived.createdAt = derived.createdAt || nowIso;
  derived.createdBy = derived.createdBy || user;
  derived.updatedAt = nowIso;
  derived.updatedBy = user;
  derived.isLaborOnly = false;
  derived.isStagedForPickup = false;
  derived.notes = asTrimmedString(payload.notes || derived.notes);

  return saveJobRecord(client, orgId, derived);
}

async function resolveExistingOrLegacyJobHeader(client, orgId, jobNumber, actor, nowIso) {
  const existing = await findJobByNumber(client, orgId, jobNumber);
  if (existing) {
    return {
      header: existing,
      allocations: null,
      filmOrders: null
    };
  }

  const allocations = await listAllocationsByJob(client, orgId, jobNumber);
  const filmOrders = await listFilmOrdersByJob(client, orgId, jobNumber);
  const requirements = await listJobRequirementsByJob(client, orgId, jobNumber);
  if (!allocations.length && !filmOrders.length && !requirements.length) {
    return {
      header: null,
      allocations,
      filmOrders
    };
  }

  const derived = buildLegacyJobHeaderFromData(jobNumber, allocations, filmOrders);
  const legacyStatus = deriveJobStatusFromLegacyAllocationData(allocations, filmOrders);
  if (legacyStatus === 'CANCELLED') {
    derived.lifecycleStatus = 'CANCELLED';
  } else if (legacyStatus === 'COMPLETED') {
    derived.lifecycleStatus = 'COMPLETED';
  } else {
    derived.lifecycleStatus = 'ACTIVE';
  }
  derived.createdAt = derived.createdAt || nowIso;
  derived.createdBy = derived.createdBy || actor;
  derived.updatedAt = nowIso;
  derived.updatedBy = actor;
  derived.isLaborOnly = false;
  derived.isStagedForPickup = false;

  return {
    header: await saveJobRecord(client, orgId, derived),
    allocations,
    filmOrders
  };
}

export {
  buildJobsList,
  buildJobsSearchResults,
  checkJobDuplicate,
  normalizeCalendarMonth,
  normalizeCalendarView,
  parseCalendarDate,
  formatCalendarDate,
  normalizeCalendarAnchorDate,
  shiftCalendarDate,
  getCalendarWeekStart,
  buildJobsCalendar,
  buildJobDetail,
  buildJobDetailById,
  buildReadJobDetail,
  buildReadJobDetailById,
  executeSetJobStagedPickup,
  setJobStagedPickup,
  ensureJobHeaderForUpdate,
  resolveExistingOrLegacyJobHeader,
};
