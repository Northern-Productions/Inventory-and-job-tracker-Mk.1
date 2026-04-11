// Purpose: Job summary, lifecycle, and linked film-order presentation helpers.
import { buildCurrentCheckedOutAllocationIdSet } from '../../../../../shared/checkoutSemantics.mjs';
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
import {
  buildAllocationJobSummary,
  resolveAllocationJobMetadata,
  summarizeCaulkRequirementCoverage,
} from './runtimeAllocationCoverage.mjs';
import { enrichOpenFilmOrdersWithJobSchedule } from './runtimeFilmOrderSchedule.mjs';

function buildLegacyJobHeaderFromData(jobNumber, allocations, filmOrders) {
  const metadata = resolveAllocationJobMetadata(allocations, filmOrders);
  let warehouse = '';
  let createdAt = '';
  let updatedAt = '';

  for (let index = 0; index < allocations.length; index += 1) {
    const allocation = allocations[index];
    if (!warehouse && allocation.warehouse) {
      warehouse = allocation.warehouse;
    }

    if (!createdAt || (allocation.createdAt && allocation.createdAt < createdAt)) {
      createdAt = allocation.createdAt || createdAt;
    }

    const allocationUpdatedAt = allocation.resolvedAt || allocation.createdAt;
    if (!updatedAt || (allocationUpdatedAt && allocationUpdatedAt > updatedAt)) {
      updatedAt = allocationUpdatedAt || updatedAt;
    }
  }

  for (let index = 0; index < filmOrders.length; index += 1) {
    const filmOrder = filmOrders[index];
    if (!warehouse && filmOrder.warehouse) {
      warehouse = filmOrder.warehouse;
    }

    if (!createdAt || (filmOrder.createdAt && filmOrder.createdAt < createdAt)) {
      createdAt = filmOrder.createdAt || createdAt;
    }

    const filmUpdatedAt = filmOrder.resolvedAt || filmOrder.createdAt;
    if (!updatedAt || (filmUpdatedAt && filmUpdatedAt > updatedAt)) {
      updatedAt = filmUpdatedAt || updatedAt;
    }
  }

  return {
    id: '',
    orgId: '',
    jobNumber,
    warehouse: warehouse || '',
    sections: null,
    dueDate: metadata.jobDate,
    crewLeader: metadata.crewLeader,
    lifecycleStatus: 'ACTIVE',
    isLaborOnly: false,
    isLaborAssigned: false,
    isStagedForPickup: false,
    notes: '',
    createdAt,
    createdBy: '',
    updatedAt,
    updatedBy: ''
  };
}

function deriveLegacyLifecycleStatus(allocations, filmOrders) {
  const legacyStatus = buildAllocationJobSummary('', allocations || [], filmOrders || []).status;
  if (legacyStatus === 'CANCELLED') {
    return 'CANCELLED';
  }

  if (legacyStatus === 'COMPLETED') {
    return 'COMPLETED';
  }

  return 'ACTIVE';
}

function resolveEffectiveJobLifecycleStatus(lifecycleStatus, allocations, filmOrders) {
  return normalizeJobLifecycleStatus(lifecycleStatus);
}

function deriveJobStatusFromLegacyAllocationData(allocations, filmOrders) {
  const legacySummary = buildAllocationJobSummary('', allocations || [], filmOrders || []);
  if (legacySummary.status === 'CANCELLED') {
    return 'CANCELLED';
  }

  if (legacySummary.status === 'READY' || legacySummary.status === 'COMPLETED') {
    return 'READY';
  }

  return 'ALLOCATE';
}

function computeJobStatusFromRequirements(
  lifecycleStatus,
  isLaborOnly,
  isLaborAssigned,
  isStagedForPickup,
  requirements,
  caulkRequirements,
  allocations,
  filmOrders
) {
  const normalizedLifecycleStatus = normalizeJobLifecycleStatus(lifecycleStatus);
  if (normalizedLifecycleStatus === 'CANCELLED') {
    return 'CANCELLED';
  }

  if (normalizedLifecycleStatus === 'COMPLETED') {
    return 'COMPLETED';
  }

  const hasMaterialRequirements = hasJobMaterialRequirements(requirements, caulkRequirements);
  if (!hasMaterialRequirements) {
    if (isLaborOnly || requirements.length || caulkRequirements.length) {
      return 'READY';
    }

    if (filmOrders.some((entry) => asTrimmedString(entry.status).toUpperCase() === 'FILM_ORDER')) {
      return 'FILM_ORDER';
    }

    if (filmOrders.some((entry) => asTrimmedString(entry.status).toUpperCase() === 'FILM_ON_THE_WAY')) {
      return 'ON_ORDER';
    }

    return deriveJobStatusFromLegacyAllocationData(allocations, filmOrders);
  }

  const hasRemainingFilm = requirements.some((entry) => integerOrZero(entry.remainingFeet) > 0);
  const hasRemainingCaulk = caulkRequirements.some((entry) => integerOrZero(entry.remainingTubes) > 0);
  if (!hasRemainingFilm && !hasRemainingCaulk) {
    return 'READY';
  }

  if (filmOrders.some((entry) => asTrimmedString(entry.status).toUpperCase() === 'FILM_ORDER')) {
    return 'FILM_ORDER';
  }

  if (filmOrders.some((entry) => asTrimmedString(entry.status).toUpperCase() === 'FILM_ON_THE_WAY')) {
    return 'ON_ORDER';
  }

  for (let index = 0; index < requirements.length; index += 1) {
    if (requirements[index].remainingFeet > 0) {
      return 'ALLOCATE';
    }
  }

  for (let index = 0; index < caulkRequirements.length; index += 1) {
    if (caulkRequirements[index].remainingTubes > 0) {
      return 'ALLOCATE';
    }
  }

  return 'ALLOCATE';
}

function hasOpenFilmOrders(filmOrders) {
  for (let index = 0; index < filmOrders.length; index += 1) {
    const status = asTrimmedString(filmOrders[index].status).toUpperCase();
    if (status === 'FILM_ORDER' || status === 'FILM_ON_THE_WAY') {
      return true;
    }
  }

  return false;
}

function hasUncheckedOutFilmRequirementAllocations(allocations) {
  for (let index = 0; index < allocations.length; index += 1) {
    const entry = allocations[index];
    if (
      asTrimmedString(entry.status).toUpperCase() === 'ACTIVE' &&
      normalizeAllocationKind(entry.allocationKind) !== 'EXTRA' &&
      integerOrZero(entry.allocatedFeet) > 0
    ) {
      return true;
    }
  }

  return false;
}

function hasUncheckedOutCaulkAllocations(caulkAllocations) {
  for (let index = 0; index < caulkAllocations.length; index += 1) {
    const entry = caulkAllocations[index];
    if (
      asTrimmedString(entry.status).toUpperCase() === 'ACTIVE' &&
      integerOrZero(entry.allocatedTubes) > 0 &&
      integerOrZero(entry.reservedTubesRemaining) > 0
    ) {
      return true;
    }
  }

  return false;
}

function getJobStagingBlockingReason(
  requirements,
  caulkRequirements,
  allocations,
  filmOrders,
  caulkAllocations,
  filmTransferAlerts = [],
  boxById = {}
) {
  const hasMaterialRequirements = hasJobMaterialRequirements(requirements, caulkRequirements);
  if (!hasMaterialRequirements) {
    return '';
  }

  const hasRemainingFilm = requirements.some((entry) => integerOrZero(entry.remainingFeet) > 0);
  const hasRemainingCaulk = caulkRequirements.some((entry) => integerOrZero(entry.remainingTubes) > 0);
  if (hasRemainingFilm || hasRemainingCaulk) {
    return 'All required film and caulk must be fully allocated before staging this job.';
  }

  if (Array.isArray(filmTransferAlerts) && filmTransferAlerts.length > 0) {
    return buildFilmTransferAlertMessage(filmTransferAlerts, 'staging');
  }

  if (hasActiveOrderedRequirementAllocations(allocations, boxById)) {
    return buildOrderedAllocationReceiptMessage('staging');
  }

  if (hasUncheckedOutCaulkAllocations(caulkAllocations)) {
    return 'All required caulk must be checked out before staging this job.';
  }

  return '';
}

function hasSharedActiveBoxConflict(jobNumber, dueDate, crewLeader, jobAllocations, allAllocations) {
  const normalizedJobDate = asTrimmedString(dueDate);
  if (!normalizedJobDate) {
    return false;
  }

  const normalizedJobNumber = normalizeJobNumberKey(jobNumber);
  const normalizedCrewLeader = normalizeCrewLeaderKey(crewLeader);
  const activeBoxIds = {};

  for (let index = 0; index < jobAllocations.length; index += 1) {
    const allocation = jobAllocations[index];
    if (allocation.status !== 'ACTIVE' || !allocation.boxId) {
      continue;
    }

    activeBoxIds[allocation.boxId] = true;
  }

  if (!Object.keys(activeBoxIds).length) {
    return false;
  }

  const candidates = Array.isArray(allAllocations) ? allAllocations : [];
  for (let index = 0; index < candidates.length; index += 1) {
    const entry = candidates[index];
    if (entry.status !== 'ACTIVE') {
      continue;
    }

    if (!activeBoxIds[entry.boxId]) {
      continue;
    }

    if (normalizeJobNumberKey(entry.jobNumber) === normalizedJobNumber) {
      continue;
    }

    if (asTrimmedString(entry.jobDate) !== normalizedJobDate) {
      continue;
    }

    if (normalizeCrewLeaderKey(entry.crewLeader) === normalizedCrewLeader) {
      continue;
    }

    return true;
  }

  return false;
}

function buildJobListEntry(
  jobHeader,
  requirements,
  allocations,
  filmOrders,
  allAllocations = [],
  caulkRequirements = [],
  boxById = {}
) {
  const metadata = resolveAllocationJobMetadata(allocations, filmOrders);
  let dueDate = jobHeader.dueDate;
  if (!dueDate) {
    dueDate = metadata.jobDate;
  }
  const crewLeader = asTrimmedString(jobHeader.crewLeader) || metadata.crewLeader;

  let requiredFeet = 0;
  let allocatedFeet = 0;
  let remainingFeet = 0;
  const caulkTotals = summarizeCaulkRequirementCoverage(caulkRequirements);

  for (let index = 0; index < requirements.length; index += 1) {
    requiredFeet += requirements[index].requiredFeet;
    allocatedFeet += requirements[index].allocatedFeet;
    remainingFeet += requirements[index].remainingFeet;
  }

  const lifecycleStatus =
    jobHeader && jobHeader.id
      ? resolveEffectiveJobLifecycleStatus(jobHeader.lifecycleStatus, allocations, filmOrders)
      : deriveLegacyLifecycleStatus(allocations, filmOrders);
  const baseStatus = computeJobStatusFromRequirements(
    lifecycleStatus,
    Boolean(jobHeader.isLaborOnly),
    Boolean(jobHeader.isLaborAssigned),
    Boolean(jobHeader.isStagedForPickup),
    requirements,
    caulkRequirements,
    allocations,
    filmOrders
  );
  const status =
    baseStatus === 'ALLOCATE' &&
    hasSharedActiveBoxConflict(jobHeader.jobNumber, dueDate, crewLeader, allocations, allAllocations)
      ? 'CONFLICT'
      : baseStatus;

  return {
    jobNumber: jobHeader.jobNumber,
    warehouse: jobHeader.warehouse || '',
    sections: jobHeader.sections,
    dueDate,
    crewLeader,
    status,
    lifecycleStatus,
    isLaborOnly: Boolean(jobHeader.isLaborOnly),
    isLaborAssigned: Boolean(jobHeader.isLaborAssigned),
    isStagedForPickup: Boolean(jobHeader.isStagedForPickup),
    requiredFeet,
    allocatedFeet,
    remainingFeet,
    requiredTubes: caulkTotals.requiredTubes,
    allocatedTubes: caulkTotals.allocatedTubes,
    remainingTubes: caulkTotals.remainingTubes,
    requirementCount: requirements.length,
    allocationCount: allocations.length,
    filmOrderCount: filmOrders.length,
    hasOrderedAllocations: hasActiveOrderedAllocations(allocations, boxById),
    createdAt: jobHeader.createdAt || '',
    updatedAt: jobHeader.updatedAt || '',
    notes: jobHeader.notes || ''
  };
}

function buildPublicAllocationEntriesForJob(allocations, boxById) {
  const sortedAllocations = allocations
    .slice()
    .sort((left, right) => {
      if (left.status !== right.status) {
        return left.status === 'ACTIVE' ? -1 : right.status === 'ACTIVE' ? 1 : left.status < right.status ? -1 : 1;
      }

      if (left.jobDate !== right.jobDate) {
        if (left.jobDate && right.jobDate) {
          return left.jobDate < right.jobDate ? -1 : 1;
        }

        if (left.jobDate) {
          return -1;
        }

        if (right.jobDate) {
          return 1;
        }
      }

      return left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0;
    });
  const currentCheckedOutAllocationIds = buildCurrentCheckedOutAllocationIdSet(sortedAllocations, boxById);

  return sortedAllocations.map((entry) => {
    const box = boxById[entry.boxId];
    return {
      ...toPublicAllocation(entry),
      manufacturer: box ? box.manufacturer : '',
      filmName: box ? box.filmName : '',
      widthIn: box ? box.widthIn : 0,
      boxStatus: box ? box.status : '',
      checkedOutOnThisJob: Boolean(currentCheckedOutAllocationIds[entry.allocationId])
    };
  });
}

async function buildPublicFilmOrderLinkedBoxes(client, orgId, filmOrderId) {
  const links = await listFilmOrderLinksByFilmOrderId(client, orgId, filmOrderId);
  const response = [];

  for (let index = 0; index < links.length; index += 1) {
    const link = links[index];
    const box = await findBoxById(client, orgId, link.boxId);
    if (!box) {
      continue;
    }

    response.push({
      boxId: link.boxId,
      orderedFeet: link.orderedFeet,
      autoAllocatedFeet: link.autoAllocatedFeet
    });
  }

  response.sort((left, right) => (left.boxId < right.boxId ? -1 : left.boxId > right.boxId ? 1 : 0));
  return response;
}

async function buildPublicFilmOrdersForJob(client, orgId, filmOrders) {
  const response = [];
  const enrichedEntries = await enrichOpenFilmOrdersWithJobSchedule(client, orgId, filmOrders);
  const sorted = enrichedEntries.slice().sort((left, right) =>
    compareAllocationJobSummaries(
      { jobDate: left.createdAt, jobNumber: left.filmOrderId },
      { jobDate: right.createdAt, jobNumber: right.filmOrderId }
    )
  );

  for (let index = 0; index < sorted.length; index += 1) {
    const entry = sorted[index];
    const linkedBoxes = await buildPublicFilmOrderLinkedBoxes(client, orgId, entry.filmOrderId);
    response.push(toPublicFilmOrder(entry, linkedBoxes));
  }

  return response;
}

export {
  buildLegacyJobHeaderFromData,
  deriveLegacyLifecycleStatus,
  resolveEffectiveJobLifecycleStatus,
  deriveJobStatusFromLegacyAllocationData,
  computeJobStatusFromRequirements,
  hasOpenFilmOrders,
  hasUncheckedOutFilmRequirementAllocations,
  hasUncheckedOutCaulkAllocations,
  getJobStagingBlockingReason,
  hasSharedActiveBoxConflict,
  buildJobListEntry,
  buildPublicAllocationEntriesForJob,
  buildPublicFilmOrderLinkedBoxes,
  buildPublicFilmOrdersForJob,
};
