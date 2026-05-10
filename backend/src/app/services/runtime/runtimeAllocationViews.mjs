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
import { groupEntriesByJobNumber } from './runtimeCollectionsAndBoxes.mjs';
import {
  buildAllocationJobDetailPayload,
  loadJobDetailContext,
  loadJobDetailContextWithPooledReads,
} from './runtimeJobDetails.mjs';

const SUMMARY_SNAPSHOT_READ_CONCURRENCY = 2;

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
  const groupedAllocations = groupEntriesByJobNumber(allAllocations);
  const groupedFilmOrders = groupEntriesByJobNumber(allFilmOrders);
  const groupedRequirements = groupEntriesByJobNumber(allRequirements);
  const groupedCaulkRequirements = groupEntriesByJobNumber(allCaulkRequirements);
  const groupedCaulkAllocations = groupEntriesByJobNumber(allCaulkAllocations);
  const jobNumbers = {};
  const jobHeadersByNumber = {};
  const boxById = {};
  const response = [];

  for (let index = 0; index < jobs.length; index += 1) {
    if (asTrimmedString(jobs[index].jobNumber)) {
      jobNumbers[jobs[index].jobNumber] = true;
      jobHeadersByNumber[jobs[index].jobNumber] = jobs[index];
    }
  }

  for (let index = 0; index < allBoxes.length; index += 1) {
    boxById[allBoxes[index].boxId] = allBoxes[index];
  }

  for (let index = 0; index < allAllocations.length; index += 1) {
    if (allAllocations[index].jobNumber) {
      jobNumbers[allAllocations[index].jobNumber] = true;
    }
  }

  for (let index = 0; index < allFilmOrders.length; index += 1) {
    if (allFilmOrders[index].jobNumber) {
      jobNumbers[allFilmOrders[index].jobNumber] = true;
    }
  }

  for (let index = 0; index < allCaulkRequirements.length; index += 1) {
    if (allCaulkRequirements[index].jobNumber) {
      jobNumbers[allCaulkRequirements[index].jobNumber] = true;
    }
  }

  for (let index = 0; index < allCaulkAllocations.length; index += 1) {
    if (allCaulkAllocations[index].jobNumber) {
      jobNumbers[allCaulkAllocations[index].jobNumber] = true;
    }
  }

  const keys = Object.keys(jobNumbers);
  for (let index = 0; index < keys.length; index += 1) {
    const jobNumber = keys[index];
    const allocations = groupedAllocations[jobNumber] || [];
    const filmOrders = groupedFilmOrders[jobNumber] || [];
    const requirements = buildPublicJobRequirementEntries(
      groupedRequirements[jobNumber] || [],
      allocations,
      boxById
    );
    const header = jobHeadersByNumber[jobNumber];
    const publicCaulkRequirements = buildPublicCaulkRequirementEntries(
      groupedCaulkRequirements[jobNumber] || [],
      groupedCaulkAllocations[jobNumber] || [],
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
      header?.id || ''
    );
    summary.status = deriveInStockReadinessStatus({
      lifecycleStatus: header?.lifecycleStatus || 'ACTIVE',
      isLaborOnly: Boolean(header?.isLaborOnly),
      requirements,
      caulkRequirements: publicCaulkRequirements,
      allocations,
      caulkAllocations: groupedCaulkAllocations[jobNumber] || [],
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
  return buildAllocationJobDetailPayload(
    await loadJobDetailContextWithPooledReads(orgId, jobNumber)
  );
}

export {
  buildAllocationJobList,
  buildAllocationJobDetail,
  buildReadAllocationJobDetail,
};
