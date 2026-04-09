// Purpose: Allocation job list and detail read builders.
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
import { buildJobFilmTransferAlerts, buildPublicJobUsageEntries, buildPublicJobUsageTimelineEntries } from './runtimeTransferUsage.mjs';
import { buildPublicJobRequirementEntries, buildPublicCaulkRequirementEntries } from './runtimeAllocationCoverage.mjs';
import { buildAllocationJobSummary, } from './runtimeAllocationCoverage.mjs';
import { buildPublicAllocationEntriesForJob, buildPublicFilmOrdersForJob } from './runtimeJobSummaries.mjs';
import { groupEntriesByJobNumber } from './runtimeCollectionsAndBoxes.mjs';

async function buildAllocationJobList(client, orgId) {
  const jobs = await listJobs(client, orgId);
  const allAllocations = await listAllocations(client, orgId);
  const allFilmOrders = await listFilmOrders(client, orgId);
  const allRequirements = await listJobRequirements(client, orgId);
  const allCaulkRequirements = await listJobCaulkRequirements(client, orgId);
  const allCaulkAllocations = await listCaulkJobAllocations(client, orgId);
  const allBoxes = await listBoxes(client, orgId);
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
    const publicCaulkRequirements = buildPublicCaulkRequirementEntries(
      groupedCaulkRequirements[jobNumber] || [],
      groupedCaulkAllocations[jobNumber] || []
    );
    const header = jobHeadersByNumber[jobNumber];
    if (!allocations.length && !filmOrders.length && !requirements.length && !publicCaulkRequirements.length) {
      continue;
    }

    response.push(
      buildAllocationJobSummary(
        jobNumber,
        allocations,
        filmOrders,
        requirements,
        publicCaulkRequirements,
        header?.lifecycleStatus || 'ACTIVE',
        Boolean(header?.isLaborOnly),
        Boolean(header?.isLaborAssigned),
        Boolean(header?.isStagedForPickup),
        header?.dueDate || '',
        header?.crewLeader || '',
        boxById
      )
    );
  }

  response.sort(compareAllocationJobSummaries);
  return response;
}

async function buildAllocationJobDetail(client, orgId, jobNumber) {
  const normalizedJobNumber = requireString(jobNumber, 'jobNumber');
  const header = await findJobByNumber(client, orgId, normalizedJobNumber);
  const allocations = await listAllocationsByJob(client, orgId, normalizedJobNumber);
  const filmOrders = await listFilmOrdersByJob(client, orgId, normalizedJobNumber);
  const requirements = await listJobRequirementsByJob(client, orgId, normalizedJobNumber);
  const caulkRequirements = await listJobCaulkRequirementsByJob(client, orgId, normalizedJobNumber);
  const caulkAllocations = await listCaulkJobAllocationsByJob(client, orgId, normalizedJobNumber);
  const caulkCheckouts = await listCaulkJobCheckoutsByJob(client, orgId, normalizedJobNumber);
  const rollHistory = await listRollHistoryByJob(client, orgId, normalizedJobNumber);

  if (!header && !allocations.length && !filmOrders.length && !caulkRequirements.length && !caulkAllocations.length) {
    throw new HttpError(404, 'Job not found.');
  }

  const boxById = {};
  const boxes = await listBoxes(client, orgId);
  for (let index = 0; index < boxes.length; index += 1) {
    boxById[boxes[index].boxId] = boxes[index];
  }
  const pendingTransfersByBoxRecordId = indexPendingBoxTransfersByBoxRecordId(
    await listPendingBoxTransfersByBoxRecordIds(
      client,
      orgId,
      boxes.map((box) => box.id)
    )
  );

  const publicRequirements = buildPublicJobRequirementEntries(requirements, allocations, boxById);
  const publicCaulkRequirements = buildPublicCaulkRequirementEntries(caulkRequirements, caulkAllocations);
  const jobWarehouse = header?.warehouse || '';
  const filmTransferAlerts = buildJobFilmTransferAlerts(
    jobWarehouse,
    allocations,
    boxById,
    pendingTransfersByBoxRecordId
  );

  return {
    summary: buildAllocationJobSummary(
      normalizedJobNumber,
      allocations,
      filmOrders,
      publicRequirements,
      publicCaulkRequirements,
      header?.lifecycleStatus || 'ACTIVE',
      Boolean(header?.isLaborOnly),
      Boolean(header?.isLaborAssigned),
      Boolean(header?.isStagedForPickup),
      header?.dueDate || '',
      header?.crewLeader || '',
      boxById
    ),
    allocations: buildPublicAllocationEntriesForJob(allocations, boxById),
    usage: buildPublicJobUsageEntries(rollHistory, boxById),
    usageTimeline: buildPublicJobUsageTimelineEntries(rollHistory, boxById, caulkCheckouts),
    caulkRequirements: publicCaulkRequirements,
    caulkAllocations,
    caulkCheckouts,
    filmOrders: await buildPublicFilmOrdersForJob(client, orgId, filmOrders),
    filmTransferAlerts
  };
}

export {
  buildAllocationJobList,
  buildAllocationJobDetail,
};
