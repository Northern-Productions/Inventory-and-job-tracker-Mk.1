// Purpose: Allocation job list and detail read builders.
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
  normalizeJobSections,
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
  listAllocationsByFilmOrderId,
  listActiveAllocations,
  saveAllocationRecord,
  listFilmOrders,
  listFilmOrdersByJob,
  findFilmOrderById,
  saveFilmOrderRecord,
  deleteFilmOrderRecord,
  listFilmOrderLinks,
  listFilmOrderLinksByFilmOrderId,
  listFilmOrderLinksByBoxId,
  saveFilmOrderLinkRecord,
  deleteFilmOrderLinksByFilmOrderId,
  listJobs,
  findJobByNumber,
  saveJobRecord,
  listJobRequirements,
  listJobRequirementsByJob,
  listJobCaulkRequirements,
  listJobCaulkRequirementsByJob,
  listCaulkJobAllocations,
  listCaulkJobAllocationsByJob,
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
import { listCaulkStock } from '../caulk.mjs';
import { buildJobFilmTransferAlerts, buildPublicJobUsageEntries, buildPublicJobUsageTimelineEntries } from './runtimeTransferUsage.mjs';
import { buildPublicJobRequirementEntries, buildPublicCaulkRequirementEntries } from './runtimeAllocationCoverage.mjs';
import { buildAllocationJobSummary, } from './runtimeAllocationCoverage.mjs';
import {
  buildPublicAllocationEntriesForJob,
  buildPublicFilmOrdersForJob,
  deriveInStockReadinessStatus,
} from './runtimeJobSummaries.mjs';
import {
  buildAllocationJobDetailPayload,
  loadJobDetailContext,
  loadJobDetailContextWithPooledReads,
  assertLegacyJobNumberReadIsUnambiguousWithPooledReads,
} from './runtimeJobDetails.mjs';

const SUMMARY_SNAPSHOT_READ_CONCURRENCY = 2;

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

function collectJobNumbersFromRows(rows, legacyJobNumbers) {
  for (let index = 0; index < rows.length; index += 1) {
    const jobNumber = getEntryJobNumber(rows[index]);
    if (!jobNumber) {
      continue;
    }
    legacyJobNumbers.add(jobNumber);
  }
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

async function runSummarySnapshotReads(client, taskFactories) {
  if (shouldUsePooledSummaryReads(client)) {
    return runParallelReadTasks(taskFactories, { maxConcurrency: SUMMARY_SNAPSHOT_READ_CONCURRENCY });
  }

  return runBoundedTasksOnClient(client, taskFactories, SUMMARY_SNAPSHOT_READ_CONCURRENCY);
}

async function buildAllocationJobList(client, orgId) {
  const [
    jobs,
    allAllocations,
    allFilmOrders,
    allRequirements,
    allCaulkRequirements,
    allCaulkAllocations,
    allBoxes,
    allCaulkStock,
  ] = await runSummarySnapshotReads(client, [
    (readClient) => listJobs(readClient, orgId),
    (readClient) => listAllocations(readClient, orgId),
    (readClient) => listFilmOrders(readClient, orgId),
    (readClient) => listJobRequirements(readClient, orgId),
    (readClient) => listJobCaulkRequirements(readClient, orgId),
    (readClient) => listCaulkJobAllocations(readClient, orgId),
    (readClient) => listBoxes(readClient, orgId),
    (readClient) => listCaulkStock(readClient, orgId, {}),
  ]);
  const allocationsByJobId = groupEntriesByCanonicalJobId(allAllocations);
  const filmOrdersByJobId = groupEntriesByCanonicalJobId(allFilmOrders);
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

  for (let index = 0; index < jobs.length; index += 1) {
    const jobNumber = getEntryJobNumber(jobs[index]);
    if (jobNumber) {
      jobHeaders.push(jobs[index]);
      jobNumberHeaderCounts[jobNumber] = (jobNumberHeaderCounts[jobNumber] || 0) + 1;
    }
  }

  for (let index = 0; index < allBoxes.length; index += 1) {
    boxById[allBoxes[index].boxId] = allBoxes[index];
  }

  collectJobNumbersFromRows(allAllocations, legacyJobNumbers);
  collectJobNumbersFromRows(allFilmOrders, legacyJobNumbers);
  collectJobNumbersFromRows(allRequirements, legacyJobNumbers);
  collectJobNumbersFromRows(allCaulkRequirements, legacyJobNumbers);
  collectJobNumbersFromRows(allCaulkAllocations, legacyJobNumbers);

  const jobContexts = jobHeaders.map((header) => ({
    jobNumber: getEntryJobNumber(header),
    header,
    legacy: false,
  }));

  for (const jobNumber of legacyJobNumbers) {
    if (!jobNumberHeaderCounts[jobNumber]) {
      jobContexts.push({
        jobNumber,
        header: null,
        legacy: true,
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
    const header = context.header;
    const caulkAllocations = context.legacy
      ? getRowsForLegacyJobNumber(jobNumber, allCaulkAllocationsByJobNumber)
      : getRowsForJobHeader(
          context.header,
          caulkAllocationsByJobId,
          legacyCaulkAllocationsByJobNumber,
          jobNumberHeaderCounts
        );
    const publicCaulkRequirements = buildPublicCaulkRequirementEntries(
      context.legacy
        ? getRowsForLegacyJobNumber(jobNumber, allCaulkRequirementsByJobNumber)
        : getRowsForJobHeader(
            context.header,
            caulkRequirementsByJobId,
            legacyCaulkRequirementsByJobNumber,
            jobNumberHeaderCounts
          ),
      caulkAllocations,
      {
        jobNumber,
        jobWarehouse: header?.warehouse || ''
      }
    );
    if (!allocations.length && !filmOrders.length && !requirements.length && !publicCaulkRequirements.length) {
      continue;
    }

    const summary = buildAllocationJobSummary(
      jobNumber,
      allocations,
      filmOrders,
      requirements,
      publicCaulkRequirements,
      header?.lifecycleStatus || 'ACTIVE',
      Boolean(header?.isLaborOnly),
      Boolean(header?.isStagedForPickup),
      header?.installDate || '',
      header?.crewLeader || '',
      boxById,
      header?.id || '',
      header?.workScope ?? header?.sections ?? null
    );
    summary.status = deriveInStockReadinessStatus({
      lifecycleStatus: header?.lifecycleStatus || 'ACTIVE',
      isLaborOnly: Boolean(header?.isLaborOnly),
      requirements,
      caulkRequirements: publicCaulkRequirements,
      allocations,
      caulkAllocations,
      filmOrders,
      allBoxes,
      boxById,
      caulkStockEntries: allCaulkStock,
      jobWarehouse: header?.warehouse || '',
      jobNumber,
    });

    response.push(summary);
  }

  response.sort(compareAllocationJobSummaries);
  return response;
}

async function buildAllocationJobDetail(client, orgId, jobNumber) {
  return buildAllocationJobDetailPayload(
    await loadJobDetailContext(client, orgId, jobNumber)
  );
}

async function buildReadAllocationJobDetail(orgId, jobNumber) {
  await assertLegacyJobNumberReadIsUnambiguousWithPooledReads(orgId, jobNumber);
  return buildAllocationJobDetailPayload(
    await loadJobDetailContextWithPooledReads(orgId, jobNumber)
  );
}

export {
  buildAllocationJobList,
  buildAllocationJobDetail,
  buildReadAllocationJobDetail,
};
