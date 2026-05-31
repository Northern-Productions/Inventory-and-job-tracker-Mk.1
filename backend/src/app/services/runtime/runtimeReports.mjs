// Purpose: Reports and owner inventory valuation runtime helpers.
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
import { buildJobsList } from './runtimeJobsRead.mjs';

async function loadReportBoxesSnapshot(client, orgId) {
  if (client) {
    return listBoxes(client, orgId);
  }

  const [allBoxes] = await runParallelReadTasks([
    (readClient) => listBoxes(readClient, orgId),
  ], { maxConcurrency: 1 });
  return allBoxes;
}

async function loadReportRequirementsSnapshot(client, orgId) {
  if (client) {
    return listJobRequirements(client, orgId);
  }

  const [allRequirements] = await runParallelReadTasks([
    (readClient) => listJobRequirements(readClient, orgId),
  ], { maxConcurrency: 1 });
  return allRequirements;
}

function boxMatchesReportFilters(box, filters) {
  if (filters.warehouse && box.warehouse !== filters.warehouse) {
    return false;
  }

  const manufacturerFilterKey = normalizeCatalogManufacturerLookupKey(filters.manufacturer);
  if (
    manufacturerFilterKey &&
    normalizeCatalogManufacturerLookupKey(box.manufacturer).indexOf(manufacturerFilterKey) === -1
  ) {
    return false;
  }

  if (
    filters.film &&
    box.filmName.toLowerCase().indexOf(filters.film.toLowerCase()) === -1 &&
    box.filmKey.toLowerCase().indexOf(filters.film.toLowerCase()) === -1 &&
    box.manufacturer.toLowerCase().indexOf(filters.film.toLowerCase()) === -1
  ) {
    return false;
  }

  if (filters.width && String(box.widthIn) !== filters.width) {
    return false;
  }

  return true;
}

function normalizeReportDate(value) {
  const text = asTrimmedString(value);
  if (!text) {
    return '';
  }

  return text.slice(0, 10);
}

function extractClosedDate(updatedAt) {
  const timestamp = asTrimmedString(updatedAt);
  if (!timestamp) {
    return '';
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(timestamp)) {
    return timestamp;
  }

  return timestamp.slice(0, 10);
}

function matchesClosedJobReportFilters(jobEntry, filters) {
  if (filters.warehouse && jobEntry.warehouse !== filters.warehouse) {
    return false;
  }

  const closedDate = extractClosedDate(jobEntry.updatedAt);
  if (!closedDate) {
    return false;
  }

  if (filters.from && closedDate < filters.from) {
    return false;
  }

  if (filters.to && closedDate > filters.to) {
    return false;
  }

  return true;
}

function resolveRequirementDateBasis(requirement, jobEntry) {
  return (
    normalizeReportDate(requirement.phaseInstallDate) ||
    normalizeReportDate(jobEntry?.installDate) ||
    normalizeReportDate(jobEntry?.createdAt)
  );
}

function mostUsedFilmMatchesDateRange(dateBasis, filters) {
  if (!dateBasis) {
    return false;
  }

  if (filters.from && dateBasis < filters.from) {
    return false;
  }

  if (filters.to && dateBasis > filters.to) {
    return false;
  }

  return true;
}

function mostUsedFilmMatchesSelectedFilters(requirement, filters) {
  const manufacturerFilterKey = normalizeCatalogManufacturerLookupKey(filters.manufacturer);
  if (
    manufacturerFilterKey &&
    normalizeCatalogManufacturerLookupKey(requirement.manufacturer) !== manufacturerFilterKey
  ) {
    return false;
  }

  const filmFilterKey = normalizeCatalogLookupKey(filters.film);
  if (filmFilterKey && normalizeCatalogLookupKey(requirement.filmName) !== filmFilterKey) {
    return false;
  }

  if (filters.width && String(requirement.widthIn) !== filters.width) {
    return false;
  }

  return true;
}

function sortTextValues(values) {
  return [...values].sort(compareCatalogStrings);
}

function buildMostUsedFilmReport(jobEntries, requirements, filters) {
  const rankBy = asTrimmedString(filters.rankBy) === 'jobs_using_it' ? 'jobs_using_it' : 'actual_used_lf';
  const jobsById = new Map();
  const jobsByNumber = new Map();
  const optionManufacturers = new Set();
  const optionFilmNames = new Set();
  const optionWidths = new Set();
  const groups = new Map();

  for (const jobEntry of jobEntries) {
    const jobId = asTrimmedString(jobEntry.jobId);
    if (jobId) {
      jobsById.set(jobId, jobEntry);
    }

    const jobNumber = asTrimmedString(jobEntry.jobNumber);
    if (jobNumber && !jobsByNumber.has(jobNumber)) {
      jobsByNumber.set(jobNumber, jobEntry);
    }
  }

  for (const requirement of requirements) {
    const jobId = asTrimmedString(requirement.jobId);
    const jobEntry = (jobId && jobsById.get(jobId)) || jobsByNumber.get(asTrimmedString(requirement.jobNumber));

    if (!jobEntry) {
      continue;
    }

    if (normalizeJobLifecycleStatus(jobEntry.lifecycleStatus) === 'CANCELLED') {
      continue;
    }

    if (filters.warehouse && jobEntry.warehouse !== filters.warehouse) {
      continue;
    }

    const dateBasis = resolveRequirementDateBasis(requirement, jobEntry);
    if (!mostUsedFilmMatchesDateRange(dateBasis, filters)) {
      continue;
    }

    if (asTrimmedString(requirement.manufacturer)) {
      optionManufacturers.add(requirement.manufacturer);
    }

    if (asTrimmedString(requirement.filmName)) {
      optionFilmNames.add(requirement.filmName);
    }

    const optionWidth = Number(requirement.widthIn) || 0;
    if (optionWidth > 0) {
      optionWidths.add(optionWidth);
    }

    if (!mostUsedFilmMatchesSelectedFilters(requirement, filters)) {
      continue;
    }

    const groupKey = [
      normalizeCatalogManufacturerLookupKey(requirement.manufacturer),
      normalizeCatalogLookupKey(requirement.filmName),
      String(Number(requirement.widthIn) || 0)
    ].join('|');

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        manufacturer: requirement.manufacturer,
        filmName: requirement.filmName,
        widthIn: Number(requirement.widthIn) || 0,
        jobIds: new Set(),
        totalRequiredLf: 0,
        actualUsedLf: 0
      });
    }

    const group = groups.get(groupKey);
    group.jobIds.add(jobId || asTrimmedString(requirement.jobNumber));
    group.totalRequiredLf += Math.max(0, integerOrZero(requirement.requiredFeet));
    group.actualUsedLf += Math.max(0, integerOrZero(requirement.actualUsedFeet));
  }

  const mostUsedFilm = Array.from(groups.values())
    .filter((group) => rankBy !== 'actual_used_lf' || group.actualUsedLf > 0)
    .map((group) => {
      const jobsUsingIt = group.jobIds.size;
      return {
        rank: 0,
        manufacturer: group.manufacturer,
        filmName: group.filmName,
        widthIn: group.widthIn,
        jobsUsingIt,
        totalRequiredLf: group.totalRequiredLf,
        averageLfPerJob: jobsUsingIt > 0 ? roundToDecimals(group.totalRequiredLf / jobsUsingIt, 1) : 0,
        actualUsedLf: group.actualUsedLf
      };
    });

  mostUsedFilm.sort((left, right) => {
    if (rankBy === 'jobs_using_it' && left.jobsUsingIt !== right.jobsUsingIt) {
      return right.jobsUsingIt - left.jobsUsingIt;
    }

    if (rankBy === 'actual_used_lf' && left.actualUsedLf !== right.actualUsedLf) {
      return right.actualUsedLf - left.actualUsedLf;
    }

    if (left.actualUsedLf !== right.actualUsedLf) {
      return right.actualUsedLf - left.actualUsedLf;
    }

    if (left.jobsUsingIt !== right.jobsUsingIt) {
      return right.jobsUsingIt - left.jobsUsingIt;
    }

    if (left.totalRequiredLf !== right.totalRequiredLf) {
      return right.totalRequiredLf - left.totalRequiredLf;
    }

    const manufacturerCompare = compareCatalogStrings(left.manufacturer, right.manufacturer);
    if (manufacturerCompare !== 0) {
      return manufacturerCompare;
    }

    const filmCompare = compareCatalogStrings(left.filmName, right.filmName);
    if (filmCompare !== 0) {
      return filmCompare;
    }

    return left.widthIn - right.widthIn;
  });

  return {
    mostUsedFilm: mostUsedFilm.map((row, index) => ({ ...row, rank: index + 1 })),
    mostUsedFilmOptions: {
      manufacturers: sortTextValues(optionManufacturers),
      filmNames: sortTextValues(optionFilmNames),
      widths: Array.from(optionWidths).sort((left, right) => left - right)
    }
  };
}

async function buildReportsSummary(client, orgId, params) {
  const filters = {
    warehouse: asTrimmedString(params.warehouse).toUpperCase(),
    manufacturer: canonicalizeManufacturerLabel(params.manufacturer),
    film: asTrimmedString(params.film),
    width: asTrimmedString(params.width),
    from: asTrimmedString(params.from),
    to: asTrimmedString(params.to),
    rankBy: asTrimmedString(params.rankBy)
  };
  const allBoxes = await loadReportBoxesSnapshot(client, orgId);
  const activeBoxes = allBoxes.filter((box) => box.status !== 'ZEROED' && box.status !== 'RETIRED');
  const widthGroups = {};
  const availableFeetByWidth = [];
  const neverCheckedOut = [];
  const zeroedByMonthMap = {};
  const zeroedByMonth = [];
  const completedJobs = [];
  const cancelledJobs = [];

  for (let index = 0; index < activeBoxes.length; index += 1) {
    const activeBox = activeBoxes[index];
    if (!boxMatchesReportFilters(activeBox, filters)) {
      continue;
    }

    const widthKey = String(activeBox.widthIn);
    if (!widthGroups[widthKey]) {
      widthGroups[widthKey] = {
        widthIn: activeBox.widthIn,
        totalFeetAvailable: 0,
        boxCount: 0
      };
    }

    widthGroups[widthKey].totalFeetAvailable += activeBox.feetAvailable;
    widthGroups[widthKey].boxCount += 1;
  }

  for (const widthGroupKey of Object.keys(widthGroups)) {
    availableFeetByWidth.push(widthGroups[widthGroupKey]);
  }

  availableFeetByWidth.sort((left, right) => left.widthIn - right.widthIn);

  for (let index = 0; index < allBoxes.length; index += 1) {
    const box = allBoxes[index];
    if (!boxMatchesReportFilters(box, filters)) {
      continue;
    }

    if (box.receivedDate && !box.hasEverBeenCheckedOut) {
      if (filters.from && box.receivedDate < filters.from) {
        continue;
      }

      if (filters.to && box.receivedDate > filters.to) {
        continue;
      }

      neverCheckedOut.push({
        boxId: box.boxId,
        warehouse: box.warehouse,
        manufacturer: box.manufacturer,
        filmName: box.filmName,
        widthIn: box.widthIn,
        receivedDate: box.receivedDate,
        status: box.status,
        feetAvailable: box.feetAvailable
      });
    }

    if (box.status === 'ZEROED' && box.zeroedDate) {
      if (filters.from && box.zeroedDate < filters.from) {
        continue;
      }

      if (filters.to && box.zeroedDate > filters.to) {
        continue;
      }

      const monthKey = box.zeroedDate.slice(0, 7);
      zeroedByMonthMap[monthKey] = (zeroedByMonthMap[monthKey] || 0) + 1;
    }
  }

  neverCheckedOut.sort((left, right) => {
    if (left.receivedDate !== right.receivedDate) {
      return left.receivedDate < right.receivedDate ? -1 : 1;
    }

    return left.boxId < right.boxId ? -1 : left.boxId > right.boxId ? 1 : 0;
  });

  for (const month of Object.keys(zeroedByMonthMap)) {
    zeroedByMonth.push({
      month,
      zeroedCount: zeroedByMonthMap[month]
    });
  }

  zeroedByMonth.sort((left, right) => (left.month < right.month ? -1 : left.month > right.month ? 1 : 0));

  const allJobEntries = await buildJobsList(client, orgId, 0, undefined, [], {
    preloadedBoxes: allBoxes,
    snapshotConcurrency: 1,
  });
  const allRequirements = await loadReportRequirementsSnapshot(client, orgId);
  const { mostUsedFilm, mostUsedFilmOptions } = buildMostUsedFilmReport(
    allJobEntries,
    allRequirements,
    filters
  );
  for (let index = 0; index < allJobEntries.length; index += 1) {
    const jobEntry = allJobEntries[index];
    const lifecycleStatus = normalizeJobLifecycleStatus(jobEntry.lifecycleStatus);

    if (lifecycleStatus !== 'COMPLETED' && lifecycleStatus !== 'CANCELLED') {
      continue;
    }

    if (!matchesClosedJobReportFilters(jobEntry, filters)) {
      continue;
    }

    const reportEntry = {
      ...(asTrimmedString(jobEntry.jobId) ? { jobId: asTrimmedString(jobEntry.jobId) } : {}),
      ...(asTrimmedString(jobEntry.workScope ?? jobEntry.sections)
        ? {
            workScope: asTrimmedString(jobEntry.workScope ?? jobEntry.sections),
            sections: asTrimmedString(jobEntry.workScope ?? jobEntry.sections),
          }
        : {}),
      jobNumber: jobEntry.jobNumber,
      warehouse: jobEntry.warehouse,
      installDate: jobEntry.installDate,
      crewLeader: jobEntry.crewLeader,
      status: jobEntry.status,
      lifecycleStatus,
      requiredFeet: jobEntry.requiredFeet,
      allocatedFeet: jobEntry.allocatedFeet,
      remainingFeet: jobEntry.remainingFeet,
      closedAt: asTrimmedString(jobEntry.updatedAt)
    };

    if (lifecycleStatus === 'COMPLETED') {
      completedJobs.push(reportEntry);
    } else {
      cancelledJobs.push(reportEntry);
    }
  }

  const compareClosedJobs = (left, right) => {
    if (left.closedAt !== right.closedAt) {
      return left.closedAt > right.closedAt ? -1 : 1;
    }

    return left.jobNumber > right.jobNumber ? -1 : left.jobNumber < right.jobNumber ? 1 : 0;
  };
  completedJobs.sort(compareClosedJobs);
  cancelledJobs.sort(compareClosedJobs);

  return {
    availableFeetByWidth,
    neverCheckedOut,
    zeroedByMonth,
    completedJobs,
    cancelledJobs,
    mostUsedFilm,
    mostUsedFilmOptions
  };
}

async function buildOwnerAssetTotalCost(client, orgId, params) {
  const warehouseFilter = asTrimmedString(params.warehouse).toUpperCase();
  const boxes = await listBoxes(client, orgId);

  let includedBoxCount = 0;
  let includedFeet = 0;
  let pricedBoxCount = 0;
  let pricedFeet = 0;
  let unpricedBoxCount = 0;
  let unpricedFeet = 0;
  let totalAssetCost = 0;

  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index];
    const status = asTrimmedString(box.status).toUpperCase();
    const warehouse = asTrimmedString(box.warehouse).toUpperCase();
    const feetAvailable = Math.max(0, integerOrZero(box.feetAvailable));
    const pricePerLf = numericOrNull(box.pricePerLf);

    if (warehouseFilter && warehouse !== warehouseFilter) {
      continue;
    }

    if (status === 'ZEROED' || status === 'RETIRED') {
      continue;
    }

    if (feetAvailable <= 0) {
      continue;
    }

    includedBoxCount += 1;
    includedFeet += feetAvailable;

    if (pricePerLf === null || pricePerLf < 0) {
      unpricedBoxCount += 1;
      unpricedFeet += feetAvailable;
      continue;
    }

    pricedBoxCount += 1;
    pricedFeet += feetAvailable;
    totalAssetCost += feetAvailable * pricePerLf;
  }

  return {
    warehouse: warehouseFilter,
    includedBoxCount,
    includedFeet,
    pricedBoxCount,
    pricedFeet,
    unpricedBoxCount,
    unpricedFeet,
    coveragePercentByFeet: includedFeet > 0 ? roundToDecimals(pricedFeet / includedFeet, 6) : 0,
    totalAssetCost: roundToDecimals(totalAssetCost, 2)
  };
}

export {
  boxMatchesReportFilters,
  extractClosedDate,
  matchesClosedJobReportFilters,
  buildMostUsedFilmReport,
  buildReportsSummary,
  buildOwnerAssetTotalCost,
};
