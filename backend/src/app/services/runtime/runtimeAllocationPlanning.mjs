// Purpose: Allocation preview, film-order recalculation, and shortage planning helpers.
import { getSameDayCrewConflictJobs } from '../../../../../shared/domain/sameDayCrewConflicts.mjs';
import { getFilmBoxAllocationEligibility } from '../../../../../shared/domain/filmBoxAllocationEligibility.mjs';
import {
  getFilmOrderLinkCoveredFeet,
  getFilmOrderLinkReceivedFeet,
  getFilmOrderReceiptHistoryStatus,
} from '../../../../../shared/domain/filmOrderReceiptContract.mjs';
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
  findPendingTransferForBox,
  getTransferAllocationBlockReason,
  isJobAllocationEligibleBox,
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
  normalizeAllocationSource,
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
  listManualRequirementAllocationMergeCandidates,
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
  getActiveAllocationsForBox,
  getStoredAllocationCoveredFeet,
  allocationMatchesRequirement,
  normalizeRequirementFilmKey,
  planningFilmCanSatisfyRequirement,
  getRequirementPlanningFilmMatch,
  requirementFilmIsExterior,
} from './runtimeAllocationCoverage.mjs';
import { deriveBoxPhysicalFeetAvailable } from './runtimeAllocationReservations.mjs';
import {
  allocationReservesCapacity,
  isOrderedFilmReservationBoxStatus,
  isPhysicalFilmReservationBoxStatus,
} from '../../../../../shared/domain/filmAllocationReservations.mjs';

async function resolveJobContext(client, orgId, jobNumber, installDate, crewLeader) {
  const normalizedJobNumber = requireString(jobNumber, 'JobNumber');
  const normalizedInstallDate = normalizeDateString(installDate, 'Install Date', true);
  const normalizedCrewLeader = asTrimmedString(crewLeader);
  const existingHeader = await findJobByNumber(client, orgId, normalizedJobNumber);
  if (existingHeader && normalizeJobLifecycleStatus(existingHeader.lifecycleStatus) !== 'ACTIVE') {
    throw new HttpError(400, `Job ${normalizedJobNumber} is closed and cannot receive allocations.`);
  }
  const existingAllocations = await listAllocationsByJob(client, orgId, normalizedJobNumber);
  const existingFilmOrders = await listFilmOrdersByJob(client, orgId, normalizedJobNumber);
  let existingInstallDate = existingHeader?.installDate || '';
  let existingCrewLeader = existingHeader?.crewLeader || '';

  for (let index = 0; index < existingAllocations.length; index += 1) {
    if (!existingInstallDate && existingAllocations[index].installDate) {
      existingInstallDate = existingAllocations[index].installDate;
    }

    if (!existingCrewLeader && existingAllocations[index].crewLeader) {
      existingCrewLeader = existingAllocations[index].crewLeader;
    }
  }

  for (let index = 0; index < existingFilmOrders.length; index += 1) {
    if (!existingInstallDate && existingFilmOrders[index].installDate) {
      existingInstallDate = existingFilmOrders[index].installDate;
    }

    if (!existingCrewLeader && existingFilmOrders[index].crewLeader) {
      existingCrewLeader = existingFilmOrders[index].crewLeader;
    }
  }

  if (existingInstallDate && normalizedInstallDate && existingInstallDate !== normalizedInstallDate) {
    throw new HttpError(400, 'Install Date must stay the same for an existing Job Number.');
  }

  if (
    existingCrewLeader &&
    normalizedCrewLeader &&
    normalizeCrewLeaderKey(existingCrewLeader) !== normalizeCrewLeaderKey(normalizedCrewLeader)
  ) {
    throw new HttpError(400, 'Crew Leader must stay the same for an existing Job Number.');
  }

  const resolvedInstallDate = normalizedInstallDate || existingInstallDate;
  const resolvedCrewLeader = normalizedCrewLeader || existingCrewLeader;

  if (resolvedInstallDate && !resolvedCrewLeader) {
    throw new HttpError(400, 'Crew Leader is required when Install Date is set.');
  }

  return {
    jobNumber: normalizedJobNumber,
    installDate: resolvedInstallDate,
    crewLeader: resolvedCrewLeader
  };
}

function getDateConflictJobsForBox(boxId, jobContext, activeAllocationsByBox) {
  return getSameDayCrewConflictJobs(jobContext, getActiveAllocationsForBox(boxId, activeAllocationsByBox));
}

function getAllocationCandidateStatusRank(box) {
  const normalizedStatus = asTrimmedString(box?.status).toUpperCase();
  if (normalizedStatus === 'IN_STOCK') {
    return 0;
  }

  if (normalizedStatus === 'TRANSFER') {
    return 1;
  }

  if (normalizedStatus === 'ORDERED') {
    return 2;
  }

  return 3;
}

function buildAllocationPreviewPlan(sourceBox, requestedFeet, jobContext, options) {
  const requested = coerceFeetValue(requestedFeet, 'RequestedFeet', [], true);
  if (requested <= 0) {
    throw new HttpError(400, 'RequestedFeet must be greater than zero.');
  }

  const useCrossWarehouse = options && options.crossWarehouse === true;
  const selectedRequirement = options && options.selectedRequirement ? options.selectedRequirement : null;
  const preferredWarehouse = asTrimmedString(options && options.jobWarehouse).toUpperCase();
  const pendingTransfersByBoxRecordId =
    options && options.pendingTransfersByBoxRecordId ? options.pendingTransfersByBoxRecordId : {};
  const requirementWidthValue = Number(selectedRequirement && selectedRequirement.widthIn);
  const minimumWidthValue = Number(options && options.minimumWidthIn);
  const minimumWidthIn =
    Number.isFinite(requirementWidthValue) && requirementWidthValue > 0
      ? requirementWidthValue
      : Number.isFinite(minimumWidthValue) && minimumWidthValue > 0
        ? minimumWidthValue
        : sourceBox.widthIn;
  if (selectedRequirement && !allocationMatchesRequirement(sourceBox, selectedRequirement)) {
    throw new HttpError(
      400,
      `Box ${sourceBox.boxId} does not match requirement ${asTrimmedString(selectedRequirement.id)}.`
    );
  }
  if (sourceBox.widthIn < minimumWidthIn) {
    throw new HttpError(400, 'Source box width must meet or exceed the requested width.');
  }
  const activeAllocationsByBox = (options && options.activeAllocationsByBox) || {};
  const sourcePendingTransfer = findPendingTransferForBox(sourceBox, pendingTransfersByBoxRecordId);
  const sourceEligibility = getFilmBoxAllocationEligibility(
    sourceBox,
    sourcePendingTransfer,
    preferredWarehouse,
    {
      allowTransferAssist: useCrossWarehouse,
      hasReservations: (activeAllocationsByBox[sourceBox.boxId] || []).some((allocation) =>
        allocationReservesCapacity(allocation, sourceBox)
      )
    }
  );
  if (sourceEligibility.reason) {
    throw new HttpError(400, sourceEligibility.reason);
  }
  if (!sourceEligibility.eligible) {
    throw new HttpError(400, `Box ${sourceBox.boxId} is no longer allocatable.`);
  }
  const sourcePlanningFeet = getBoxAllocationPlanningFeet(sourceBox, activeAllocationsByBox);
  const sourceConflicts = getDateConflictJobsForBox(sourceBox.boxId, jobContext, activeAllocationsByBox);
  const sourcePlan = sourceConflicts.length
    ? { allocatedFeet: 0, coveredFeet: 0, remainingCoveredFeet: requested }
    : planCoverageAllocation(requested, sourcePlanningFeet, sourceBox.widthIn, minimumWidthIn);
  const sourceSuggestedFeet = sourcePlan.allocatedFeet;
  const sourceSuggestedCoveredFeet = sourcePlan.coveredFeet;
  let remaining = sourcePlan.remainingCoveredFeet;
  const candidates = [];
  const candidateBoxes = useCrossWarehouse
    ? options.allBoxes
    : options.allBoxes.filter((box) => box.warehouse === sourceBox.warehouse);
  const filteredCandidates = [];

  for (let index = 0; index < candidateBoxes.length; index += 1) {
    const candidate = candidateBoxes[index];
    const candidatePlanningFeet = getBoxAllocationPlanningFeet(candidate, activeAllocationsByBox);
    const candidatePendingTransfer = findPendingTransferForBox(candidate, pendingTransfersByBoxRecordId);
    const candidateEligibility = getFilmBoxAllocationEligibility(
      candidate,
      candidatePendingTransfer,
      preferredWarehouse,
      {
        allowTransferAssist: useCrossWarehouse,
        hasReservations: (activeAllocationsByBox[candidate.boxId] || []).some((allocation) =>
          allocationReservesCapacity(allocation, candidate)
        )
      }
    );
    if (
      candidate.boxId === sourceBox.boxId ||
      !candidateEligibility.eligible ||
      candidatePlanningFeet <= 0 ||
      candidate.widthIn < minimumWidthIn
    ) {
      continue;
    }

    let filmMatch = null;
    if (selectedRequirement) {
      filmMatch = getRequirementPlanningFilmMatch(
        candidate.manufacturer,
        candidate.filmName,
        selectedRequirement.manufacturer,
        selectedRequirement.filmName
      );
      if (!filmMatch) {
        continue;
      }
    } else if (
      normalizeRequirementFilmKey(candidate.manufacturer, candidate.filmName) !==
      normalizeRequirementFilmKey(sourceBox.manufacturer, sourceBox.filmName)
    ) {
      continue;
    }

    filteredCandidates.push({
      candidate,
      filmMatch,
      eligibility: candidateEligibility
    });
  }

  filteredCandidates.sort((leftEntry, rightEntry) => {
    const left = leftEntry.candidate;
    const right = rightEntry.candidate;
    const leftStatusRank = getAllocationCandidateStatusRank(left);
    const rightStatusRank = getAllocationCandidateStatusRank(right);
    if (leftStatusRank !== rightStatusRank) {
      return leftStatusRank - rightStatusRank;
    }

    if (preferredWarehouse) {
      const leftPreferredWarehouse =
        asTrimmedString(left.warehouse).toUpperCase() === preferredWarehouse;
      const rightPreferredWarehouse =
        asTrimmedString(right.warehouse).toUpperCase() === preferredWarehouse;
      if (leftPreferredWarehouse !== rightPreferredWarehouse) {
        return leftPreferredWarehouse ? -1 : 1;
      }
    }

    if (selectedRequirement && leftEntry.filmMatch && rightEntry.filmMatch) {
      const filmComparison = compareSharedJobPlanningFilmMatches(leftEntry.filmMatch, rightEntry.filmMatch);
      if (filmComparison !== 0) {
        return filmComparison;
      }
    }

    const leftIsExactMatch = left.widthIn === minimumWidthIn;
    const rightIsExactMatch = right.widthIn === minimumWidthIn;
    if (leftIsExactMatch !== rightIsExactMatch) {
      return leftIsExactMatch ? -1 : 1;
    }

    const leftIsPreferredSplitMatch = isSplitCoveragePair(left.widthIn, minimumWidthIn);
    const rightIsPreferredSplitMatch = isSplitCoveragePair(right.widthIn, minimumWidthIn);
    if (leftIsPreferredSplitMatch !== rightIsPreferredSplitMatch) {
      return leftIsPreferredSplitMatch ? -1 : 1;
    }

    const leftWidthDelta = left.widthIn - minimumWidthIn;
    const rightWidthDelta = right.widthIn - minimumWidthIn;
    if (leftWidthDelta !== rightWidthDelta) {
      return leftWidthDelta - rightWidthDelta;
    }

    if (selectedRequirement && !requirementFilmIsExterior(selectedRequirement.manufacturer, selectedRequirement.filmName)) {
      const leftIsExterior = requirementFilmIsExterior(left.manufacturer, left.filmName);
      const rightIsExterior = requirementFilmIsExterior(right.manufacturer, right.filmName);
      if (leftIsExterior !== rightIsExterior) {
        return leftIsExterior ? 1 : -1;
      }
    }

    return compareBoxesByOldestStock(left, right);
  });

  for (let index = 0; index < filteredCandidates.length; index += 1) {
    const candidate = filteredCandidates[index].candidate;
    const candidatePlanningFeet = getBoxAllocationPlanningFeet(candidate, activeAllocationsByBox);
    const conflicts = getDateConflictJobsForBox(candidate.boxId, jobContext, activeAllocationsByBox);
    if (conflicts.length) {
      continue;
    }

    const candidatePlan = planCoverageAllocation(remaining, candidatePlanningFeet, candidate.widthIn, minimumWidthIn);
    candidates.push({
      boxId: candidate.boxId,
      warehouse: candidate.warehouse,
      widthIn: candidate.widthIn,
      availableFeet: candidate.feetAvailable,
      planningFeet: candidatePlanningFeet,
      boxStatus: candidate.status,
      requiresTransfer: filteredCandidates[index].eligibility.requiresTransfer,
      suggestedFeet: candidatePlan.allocatedFeet,
      suggestedCoveredFeet: candidatePlan.coveredFeet,
      receivedDate: candidate.receivedDate,
      orderDate: candidate.orderDate
    });

    if (remaining > 0) {
      remaining = candidatePlan.remainingCoveredFeet;
    }
  }

  return {
    jobNumber: jobContext.jobNumber,
    installDate: jobContext.installDate,
    crewLeader: jobContext.crewLeader,
    requestedFeet: requested,
    requestedWidthIn: minimumWidthIn,
    sourceBoxId: sourceBox.boxId,
    sourceWarehouse: sourceBox.warehouse,
    sourceWidthIn: sourceBox.widthIn,
    sourceBoxFeetAvailable: sourceBox.feetAvailable,
    sourceBoxPlanningFeet: sourcePlanningFeet,
    sourceBoxStatus: sourceBox.status,
    sourceRequiresTransfer: sourceEligibility.requiresTransfer,
    sourceSuggestedFeet,
    sourceSuggestedCoveredFeet,
    sourceConflicts,
    suggestions: candidates,
    defaultCoveredFeet: requested - remaining,
    defaultRemainingFeet: remaining
  };
}

function calculateSelectedSuggestionAllocations(plan, selectedBoxIds) {
  const selectedMap = {};
  const allocations = [];
  let remaining = plan.requestedFeet;

  if (plan.sourceSuggestedFeet > 0) {
    const sourcePlan = planCoverageAllocation(
      remaining,
      plan.sourceSuggestedFeet,
      plan.sourceWidthIn,
      plan.requestedWidthIn
    );
    allocations.push({
      boxId: plan.sourceBoxId,
      allocatedFeet: sourcePlan.allocatedFeet,
      coveredFeet: sourcePlan.coveredFeet
    });
    remaining = sourcePlan.remainingCoveredFeet;
  }

  for (let index = 0; index < selectedBoxIds.length; index += 1) {
    selectedMap[selectedBoxIds[index]] = true;
  }

  for (let index = 0; index < plan.suggestions.length; index += 1) {
    const suggestion = plan.suggestions[index];
    if (!selectedMap[suggestion.boxId] || remaining <= 0) {
      continue;
    }

    const nextPlan = planCoverageAllocation(
      remaining,
      integerOrZero(suggestion.planningFeet ?? suggestion.availableFeet),
      suggestion.widthIn,
      plan.requestedWidthIn
    );
    allocations.push({
      boxId: suggestion.boxId,
      allocatedFeet: nextPlan.allocatedFeet,
      coveredFeet: nextPlan.coveredFeet
    });
    remaining = nextPlan.remainingCoveredFeet;
  }

  return {
    allocations,
    remainingFeet: remaining
  };
}

function parseCrossWarehouseFlag(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

function normalizeOptionalWarehouse(value, fieldName) {
  const normalized = asTrimmedString(value).toUpperCase();
  if (!normalized) {
    return '';
  }

  return normalizeWarehouseCodeFormat(normalized, fieldName || 'Warehouse');
}

async function getOrResolveJobId(client, orgId, jobNumber) {
  const header = await findJobByNumber(client, orgId, jobNumber);
  return header ? header.id : null;
}

const MANUAL_REQUIREMENT_MERGE_SOURCES = new Set(['MANUAL', 'AUTO_PLANNED']);

function normalizeAllocationKey(value) {
  return asTrimmedString(value).toUpperCase();
}

function allocationJobMatchesMergeTarget(candidate, target) {
  const candidateJobId = asTrimmedString(candidate?.jobId);
  const targetJobId = asTrimmedString(target?.jobId);
  if (candidateJobId && targetJobId) {
    return candidateJobId === targetJobId;
  }

  return normalizeAllocationKey(candidate?.jobNumber) === normalizeAllocationKey(target?.jobNumber);
}

function compareManualRequirementMergeCandidates(left, right) {
  const sourcePriority = (entry) => {
    const source = normalizeAllocationSource(entry?.allocationSource);
    if (source === 'MANUAL') {
      return 0;
    }
    if (source === 'AUTO_PLANNED') {
      return 1;
    }
    return 2;
  };
  const priorityDelta = sourcePriority(left) - sourcePriority(right);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  const createdDelta = asTrimmedString(left?.createdAt).localeCompare(asTrimmedString(right?.createdAt));
  if (createdDelta !== 0) {
    return createdDelta;
  }

  return asTrimmedString(left?.allocationId).localeCompare(asTrimmedString(right?.allocationId));
}

function isManualRequirementMergeTarget(candidate, target) {
  return (
    candidate &&
    target &&
    normalizeAllocationKind(candidate.allocationKind) === 'REQUIREMENT' &&
    normalizeAllocationKind(target.allocationKind) === 'REQUIREMENT' &&
    normalizeAllocationKey(candidate.status) === 'ACTIVE' &&
    MANUAL_REQUIREMENT_MERGE_SOURCES.has(normalizeAllocationSource(candidate.allocationSource)) &&
    normalizeAllocationSource(target.allocationSource) === 'MANUAL' &&
    asTrimmedString(candidate.filmOrderId) === asTrimmedString(target.filmOrderId) &&
    !asTrimmedString(target.filmOrderId) &&
    normalizeAllocationKey(candidate.boxId) === normalizeAllocationKey(target.boxId) &&
    asTrimmedString(candidate.requirementId) === asTrimmedString(target.requirementId) &&
    Boolean(asTrimmedString(target.requirementId)) &&
    allocationJobMatchesMergeTarget(candidate, target)
  );
}

function buildSupersededManualMergeNote(primaryAllocationId) {
  return `Superseded by manual allocation merge into ${asTrimmedString(primaryAllocationId)}.`;
}

/**
 * PURPOSE:
 * Consolidates manual same-job/same-requirement/same-box allocation writes so a
 * user override owns one active REQUIREMENT row instead of duplicate MANUAL and
 * AUTO_PLANNED rows.
 *
 * AFFECTS:
 * Manual Allocate Job Film apply flow, SQL api_allocations_apply parity, job
 * detail allocation rows, requirement coverage totals, and allocation caches.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * inventoryRecordsRepository merge candidate query, paired backend/Supabase
 * migrations, frontend optimistic allocation cache behavior, and planner
 * suppression rules for user-owned boxes.
 *
 * COMMON FAILURE MODES:
 * Merging EXTRA or film-order rows, reviving cancelled history, double-counting
 * a superseded AUTO_PLANNED row, or tracking the merged total as new capacity.
 */
function buildManualRequirementAllocationMergePlan(existingAllocations, addition, options = {}) {
  const candidates = (Array.isArray(existingAllocations) ? existingAllocations : [])
    .filter((entry) => isManualRequirementMergeTarget(entry, addition))
    .sort(compareManualRequirementMergeCandidates);

  if (!candidates.length) {
    return null;
  }

  const primary = cloneValue(candidates[0]);
  const supersededAllocations = [];
  let allocatedFeet = integerOrZero(primary.allocatedFeet);
  let coveredFeet = integerOrZero(primary.coveredFeet) || integerOrZero(primary.allocatedFeet);
  const resolvedAt = asTrimmedString(options.resolvedAt) || new Date().toISOString();
  const resolvedBy = asTrimmedString(options.resolvedBy);

  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = cloneValue(candidates[index]);
    allocatedFeet += integerOrZero(candidate.allocatedFeet);
    coveredFeet += integerOrZero(candidate.coveredFeet) || integerOrZero(candidate.allocatedFeet);
    candidate.status = 'CANCELLED';
    candidate.resolvedAt = resolvedAt;
    candidate.resolvedBy = resolvedBy;
    candidate.notes = buildSupersededManualMergeNote(primary.allocationId);
    supersededAllocations.push(candidate);
  }

  primary.allocatedFeet = allocatedFeet + integerOrZero(addition.allocatedFeet);
  primary.coveredFeet = coveredFeet + (integerOrZero(addition.coveredFeet) || integerOrZero(addition.allocatedFeet));
  primary.allocationSource = 'MANUAL';
  primary.status = 'ACTIVE';
  primary.resolvedAt = '';
  primary.resolvedBy = '';
  primary.boxId = addition.boxId || primary.boxId;
  primary.warehouse = addition.warehouse || primary.warehouse;
  primary.jobId = addition.jobId || primary.jobId;
  primary.jobNumber = addition.jobNumber || primary.jobNumber;
  primary.installDate = addition.installDate || primary.installDate;
  primary.crewLeader = addition.crewLeader || primary.crewLeader;
  primary.requirementId = addition.requirementId || primary.requirementId;
  primary.filmOrderId = asTrimmedString(addition.filmOrderId);

  return {
    mergedAllocation: primary,
    supersededAllocations
  };
}

async function clearStagedPickupForActiveFilmRequirementAllocation(client, orgId, allocation, actor) {
  const jobId = asTrimmedString(allocation?.jobId);
  const requirementId = asTrimmedString(allocation?.requirementId);
  if (!jobId || !requirementId) {
    return;
  }

  await queryRow(
    client,
    `
      update app.jobs j
      set is_staged_for_pickup = false,
          updated_at = now(),
          updated_by = $4::text
      from app.job_requirements r
      left join app.job_phases p
        on p.org_id = r.org_id
       and p.job_id = r.job_id
       and p.id = r.phase_id
      where j.org_id = $1::uuid
        and j.id = $2::uuid
        and j.is_staged_for_pickup = true
        and r.org_id = j.org_id
        and r.job_id = j.id
        and r.id = $3::uuid
        and coalesce(p.workflow_status, 'ACTIVE') = 'ACTIVE'
      returning j.id
    `,
    [orgId, jobId, requirementId, asTrimmedString(actor)]
  );
}

async function createAllocationRecord(
  client,
  orgId,
  box,
  jobContext,
  allocatedFeet,
  coveredFeet,
  user,
  filmOrderId,
  allocationKind = 'REQUIREMENT',
  requirementId = '',
  options = {}
) {
  const jobId = asTrimmedString(jobContext.jobId) || await getOrResolveJobId(client, orgId, jobContext.jobNumber);
  const allocationSource = normalizeAllocationSource(options.allocationSource);
  const entry = {
    allocationId: createLogId(),
    boxId: box.boxId,
    warehouse: box.warehouse,
    jobId,
    jobNumber: jobContext.jobNumber,
    installDate: jobContext.installDate,
    allocatedFeet,
    coveredFeet: integerOrZero(coveredFeet) || allocatedFeet,
    requirementId: asTrimmedString(requirementId),
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    createdBy: asTrimmedString(user),
    resolvedAt: '',
    resolvedBy: '',
    notes: asTrimmedString(options.notes),
    crewLeader: jobContext.crewLeader,
    filmOrderId: asTrimmedString(filmOrderId),
    allocationKind: normalizeAllocationKind(allocationKind),
    allocationSource
  };

  if (
    entry.allocationKind === 'REQUIREMENT' &&
    allocationSource === 'MANUAL' &&
    entry.requirementId &&
    !entry.filmOrderId
  ) {
    const mergePlan = buildManualRequirementAllocationMergePlan(
      await listManualRequirementAllocationMergeCandidates(client, orgId, entry),
      entry,
      { resolvedBy: asTrimmedString(user) }
    );

    if (mergePlan) {
      for (let index = 0; index < mergePlan.supersededAllocations.length; index += 1) {
        await saveAllocationRecord(client, orgId, mergePlan.supersededAllocations[index]);
      }

      const savedAllocation = await saveAllocationRecord(client, orgId, mergePlan.mergedAllocation);
      await clearStagedPickupForActiveFilmRequirementAllocation(client, orgId, savedAllocation, user);
      return savedAllocation;
    }
  }

  const savedAllocation = await saveAllocationRecord(client, orgId, entry);
  await clearStagedPickupForActiveFilmRequirementAllocation(client, orgId, savedAllocation, user);
  return savedAllocation;
}

async function sumFilmOrderCoveredFeet(client, orgId, filmOrderId) {
  const allocations = await listAllocationsByFilmOrderId(client, orgId, filmOrderId);
  let total = 0;

  for (let index = 0; index < allocations.length; index += 1) {
    if (allocations[index].status !== 'CANCELLED') {
      total += getStoredAllocationCoveredFeet(allocations[index]);
    }
  }

  return total;
}

async function sumFilmOrderOrderedFeet(client, orgId, filmOrderId) {
  const filmOrder = await findFilmOrderById(client, orgId, filmOrderId);
  if (!filmOrder) {
    return 0;
  }

  const links = await listFilmOrderLinksByFilmOrderId(client, orgId, filmOrderId);
  let total = 0;

  for (let index = 0; index < links.length; index += 1) {
    const box = await findBoxById(client, orgId, links[index].boxId);
    if (box) {
      total += getLinkedBoxCoveredFeetForFilmOrder(filmOrder, links[index], box);
    }
  }

  return total;
}

function getLinkedBoxPhysicalFeet(link, box, allocations = []) {
  if (isOrderedFilmReservationBoxStatus(box?.status)) {
    const orderedBoxFeet = integerOrZero(box?.initialFeet);
    if (orderedBoxFeet > 0) {
      return orderedBoxFeet;
    }

    return integerOrZero(link?.orderedFeet);
  }

  if (isPhysicalFilmReservationBoxStatus(box?.status)) {
    if (box?.physicalFeetAvailable !== null && box?.physicalFeetAvailable !== undefined) {
      return integerOrZero(box.physicalFeetAvailable);
    }

    const derivedPhysicalFeet = deriveBoxPhysicalFeetAvailable(box, allocations);
    if (derivedPhysicalFeet !== null && derivedPhysicalFeet !== undefined) {
      return integerOrZero(derivedPhysicalFeet);
    }
  }

  const correctedBoxFeet = integerOrZero(box?.initialFeet);
  if (correctedBoxFeet > 0) {
    return correctedBoxFeet;
  }

  return integerOrZero(link?.orderedFeet);
}

function getLinkedBoxCoveredFeetForFilmOrder(filmOrder, link, box, allocations = []) {
  void allocations;
  return getFilmOrderLinkCoveredFeet(filmOrder, link, box);
}

function getLinkedBoxRemainingPhysicalFeet(link, box, allocations = []) {
  return Math.max(getLinkedBoxPhysicalFeet(link, box, allocations) - integerOrZero(link?.autoAllocatedFeet), 0);
}

function getLinkedFilmOrderAllocatedFeet(allocations, filmOrderId) {
  let total = 0;
  const normalizedFilmOrderId = asTrimmedString(filmOrderId);

  for (let index = 0; index < allocations.length; index += 1) {
    const entry = allocations[index];
    const status = asTrimmedString(entry?.status).toUpperCase();
    if (
      asTrimmedString(entry?.filmOrderId) === normalizedFilmOrderId &&
      (status === 'ACTIVE' || status === 'FULFILLED')
    ) {
      total += integerOrZero(entry?.allocatedFeet);
    }
  }

  return total;
}

async function syncFilmOrderLinkAllocatedFeet(client, orgId, link, allocations) {
  const autoAllocatedFeet = getLinkedFilmOrderAllocatedFeet(allocations, link.filmOrderId);
  if (autoAllocatedFeet === integerOrZero(link?.autoAllocatedFeet)) {
    return link;
  }

  return saveFilmOrderLinkRecord(client, orgId, {
    ...link,
    autoAllocatedFeet,
  });
}

async function summarizeFilmOrderLinkedBoxes(client, orgId, filmOrderId) {
  const filmOrder = await findFilmOrderById(client, orgId, filmOrderId);
  if (!filmOrder) {
    return {
      hasLinkedBoxes: false,
      allLinkedBoxesReceived: false,
      orderedFeet: 0,
      receivedFeet: 0,
      receiptHistoryComplete: true
    };
  }

  const links = await listFilmOrderLinksByFilmOrderId(client, orgId, filmOrderId);
  if (!links.length) {
    return {
      hasLinkedBoxes: false,
      allLinkedBoxesReceived: false,
      orderedFeet: 0,
      receivedFeet: 0,
      receiptHistoryComplete: true
    };
  }

  let orderedFeet = 0;
  let receivedFeet = 0;
  let allLinkedBoxesReceived = true;
  let receiptHistoryComplete = true;

  for (let index = 0; index < links.length; index += 1) {
    const link = links[index];
    const box = await findBoxById(client, orgId, link.boxId);
    if (!box) {
      allLinkedBoxesReceived = false;
      continue;
    }

    const allocations = await listAllocationsByBox(client, orgId, box.boxId);
    const syncedLink = await syncFilmOrderLinkAllocatedFeet(client, orgId, link, allocations);

    orderedFeet += getLinkedBoxCoveredFeetForFilmOrder(filmOrder, syncedLink, box, allocations);
    receivedFeet += getFilmOrderLinkReceivedFeet(filmOrder, syncedLink, box);
    const receiptStatus = getFilmOrderReceiptHistoryStatus(syncedLink, box);
    if (receiptStatus !== 'FINALIZED') {
      allLinkedBoxesReceived = false;
    }
    if (receiptStatus === 'MISSING') {
      receiptHistoryComplete = false;
    }
  }

  return {
    hasLinkedBoxes: true,
    allLinkedBoxesReceived,
    orderedFeet,
    receivedFeet,
    receiptHistoryComplete
  };
}

async function recalculateFilmOrder(client, orgId, filmOrderId, user) {
  const existing = await findFilmOrderById(client, orgId, filmOrderId);
  if (!existing) {
    return null;
  }

  const updated = cloneValue(existing);
  updated.coveredFeet = await sumFilmOrderCoveredFeet(client, orgId, filmOrderId);
  const linkedBoxSummary = await summarizeFilmOrderLinkedBoxes(client, orgId, filmOrderId);
  if (!linkedBoxSummary.receiptHistoryComplete) {
    return existing;
  }
  updated.orderedFeet = linkedBoxSummary.orderedFeet;
  updated.remainingToOrderFeet = Math.max(updated.requestedFeet - updated.orderedFeet, 0);

  if (updated.status !== 'CANCELLED') {
    if (linkedBoxSummary.hasLinkedBoxes) {
      if (updated.orderedFeet < updated.requestedFeet) {
        updated.status = 'FILM_ORDER';
        updated.resolvedAt = '';
        updated.resolvedBy = '';
      } else if (linkedBoxSummary.allLinkedBoxesReceived) {
        updated.status = 'FULFILLED';
        if (!updated.resolvedAt) {
          updated.resolvedAt = new Date().toISOString();
          updated.resolvedBy = asTrimmedString(user);
        }
      } else {
        updated.status = 'FILM_ON_THE_WAY';
        updated.resolvedAt = '';
        updated.resolvedBy = '';
      }
    } else if (updated.coveredFeet >= updated.requestedFeet) {
      updated.status = 'FULFILLED';
      if (!updated.resolvedAt) {
        updated.resolvedAt = new Date().toISOString();
        updated.resolvedBy = asTrimmedString(user);
      }
    } else if (updated.orderedFeet >= updated.requestedFeet) {
      updated.status = 'FILM_ON_THE_WAY';
      updated.resolvedAt = '';
      updated.resolvedBy = '';
    } else {
      updated.status = 'FILM_ORDER';
      updated.resolvedAt = '';
      updated.resolvedBy = '';
    }
  }

  return saveFilmOrderRecord(client, orgId, updated);
}

async function createFilmOrderForShortage(
  client,
  orgId,
  sourceBox,
  selectedRequirement,
  jobContext,
  requestedFeet,
  shortageFeet,
  shortageWidthIn,
  user,
  shortageWarehouse
) {
  /**
   * PURPOSE:
   * Guards the retired auto-shortage order path. Film orders must now be
   * created only by explicit user actions.
   *
   * AFFECTS:
   * Allocation preview/apply, ordered receipt, inventory check-in, and any
   * legacy service export that still calls shortage-order creation.
   *
   * WHEN CHANGING THIS, ALSO CHECK:
   * runtimeAutoShortageFilmOrders.mjs, runtimeJobsMutations.createFilmOrder,
   * mirrored SQL reconciliation functions, and job detail Order buttons.
   *
   * COMMON FAILURE MODES:
   * Hidden purchasing records from shortage detection, duplicated manual
   * orders, or frontend cache assuming an automatic filmOrder response.
   */
  void client;
  void orgId;
  void sourceBox;
  void selectedRequirement;
  void jobContext;
  void requestedFeet;
  void shortageFeet;
  void shortageWidthIn;
  void user;
  void shortageWarehouse;
  return null;
}

async function linkBoxToFilmOrder(client, orgId, filmOrderId, box, user) {
  const existing = await findFilmOrderById(client, orgId, filmOrderId);
  if (!existing) {
    throw new HttpError(404, 'Film Order not found.');
  }

  if (existing.status === 'CANCELLED') {
    throw new HttpError(400, 'Cancelled Film Orders cannot receive new boxes.');
  }

  await saveFilmOrderLinkRecord(client, orgId, {
    linkId: createLogId(),
    filmOrderId: existing.filmOrderId,
    boxId: box.boxId,
    orderedFeet: getLinkedBoxPhysicalFeet({ orderedFeet: box.initialFeet }, box),
    autoAllocatedFeet: 0,
    createdAt: new Date().toISOString(),
    createdBy: asTrimmedString(user)
  });

  return recalculateFilmOrder(client, orgId, existing.filmOrderId, user);
}

function filmOrderMatchesRequirement(filmOrder, requirement) {
  const requirementWidth = Number(requirement?.widthIn || 0);
  return (
    requirementWidth > 0 &&
    Number(filmOrder?.widthIn || 0) >= requirementWidth &&
    planningFilmCanSatisfyRequirement(
      filmOrder.manufacturer,
      filmOrder.filmName,
      requirement?.manufacturer,
      requirement?.filmName
    )
  );
}

function findFilmOrderRequirement(requirements, filmOrder) {
  return (
    (Array.isArray(requirements) ? requirements : []).find((entry) =>
      filmOrderMatchesRequirement(filmOrder, entry)
    ) || null
  );
}

function findResolvableReceiptAllocation(allocations, filmOrder, requirements) {
  const jobKey = normalizeJobNumberKey(filmOrder.jobNumber);
  const matchingRequirementIds = new Set(
    (Array.isArray(requirements) ? requirements : [])
      .filter((entry) => filmOrderMatchesRequirement(filmOrder, entry))
      .map((entry) => asTrimmedString(entry.id))
      .filter(Boolean)
  );
  const sourceRank = (entry) => {
    const source = normalizeAllocationSource(entry?.allocationSource);
    if (source === 'MANUAL') {
      return 0;
    }
    if (source === 'AUTO_PLANNED') {
      return 1;
    }
    return 2;
  };

  return (
    (Array.isArray(allocations) ? allocations : [])
      .filter((entry) => {
        if (!entry || entry.status !== 'ACTIVE') {
          return false;
        }
        if (normalizeAllocationKind(entry.allocationKind) !== 'REQUIREMENT') {
          return false;
        }
        if (!matchingRequirementIds.has(asTrimmedString(entry.requirementId))) {
          return false;
        }
        if (asTrimmedString(entry.filmOrderId)) {
          return false;
        }
        if (entry.jobId && filmOrder.jobId) {
          return entry.jobId === filmOrder.jobId;
        }
        return normalizeJobNumberKey(entry.jobNumber) === jobKey;
      })
      .sort((left, right) => {
        const rankDiff = sourceRank(left) - sourceRank(right);
        if (rankDiff !== 0) {
          return rankDiff;
        }
        const createdDiff = String(left.createdAt || '').localeCompare(String(right.createdAt || ''));
        if (createdDiff !== 0) {
          return createdDiff;
        }
        return String(left.allocationId || '').localeCompare(String(right.allocationId || ''));
      })[0] || null
  );
}

/**
 * PURPOSE:
 * Converts linked ordered boxes into one canonical allocation record when
 * physical stock is received, reusing a matching job requirement reservation
 * before creating any new receipt allocation.
 *
 * AFFECTS:
 * Ordered-box receive, film order coverage, job detail allocated rows, and
 * box physical LF edit validation.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * app_api.process_linked_box_receipt, public.api_acl_boxes_receive_ordered,
 * shared allocation reservation metrics, and film order receive regression
 * tests.
 *
 * COMMON FAILURE MODES:
 * Duplicate active rows for the same box/job requirement, film order coverage
 * drift, placeholder + physical double-counting, or received LF correction
 * being blocked by stale reservation rows.
 */
async function processLinkedFilmOrderReceipt(client, orgId, box, user, warnings) {
  const links = await listFilmOrderLinksByBoxId(client, orgId, box.boxId);
  const recalculatedOrders = {};

  if (!box.receivedDate || box.status !== 'IN_STOCK') {
    return box;
  }

  for (let index = 0; index < links.length; index += 1) {
    const link = cloneValue(links[index]);
    const filmOrder = await findFilmOrderById(client, orgId, link.filmOrderId);
    if (!filmOrder || filmOrder.status === 'CANCELLED' || filmOrder.status === 'FULFILLED') {
      continue;
    }

    recalculatedOrders[filmOrder.filmOrderId] = true;

    const requirements = await listJobRequirementsByJob(client, orgId, filmOrder.jobNumber);
    let requirement = null;
    let remainingNeed = Math.max(filmOrder.requestedFeet - filmOrder.coveredFeet, 0);
    let boxAllocations = await listAllocationsByBox(client, orgId, box.boxId);
    let linkCapacity = getLinkedBoxRemainingPhysicalFeet(link, box, boxAllocations);

    if (remainingNeed > 0 && linkCapacity > 0) {
      const existingAllocation = findResolvableReceiptAllocation(
        boxAllocations,
        filmOrder,
        requirements
      );
      const reusePlan = planCoverageAllocation(
        remainingNeed,
        Math.min(linkCapacity, integerOrZero(existingAllocation?.allocatedFeet)),
        box.widthIn,
        filmOrder.widthIn
      );
      const reusedFeet = reusePlan.allocatedFeet;
      const reusedCoveredFeet = reusePlan.coveredFeet;

      if (existingAllocation && reusedFeet > 0) {
        requirement =
          requirements.find((entry) => asTrimmedString(entry.id) === asTrimmedString(existingAllocation.requirementId)) ||
          null;

        if (reusedFeet === existingAllocation.allocatedFeet) {
          existingAllocation.filmOrderId = filmOrder.filmOrderId;
          existingAllocation.allocationSource = 'FILM_ORDER_RECEIPT';
          existingAllocation.coveredFeet = reusedCoveredFeet || existingAllocation.coveredFeet || existingAllocation.allocatedFeet;
          existingAllocation.notes =
            existingAllocation.notes ||
            `Resolved ordered-box placeholder on receipt for Film Order ${filmOrder.filmOrderId}.`;
          await saveAllocationRecord(client, orgId, existingAllocation);
        } else {
          const originalAllocationId = existingAllocation.allocationId;
          const originalCoveredFeet = existingAllocation.coveredFeet || existingAllocation.allocatedFeet;
          existingAllocation.allocatedFeet = Math.max(existingAllocation.allocatedFeet - reusedFeet, 0);
          existingAllocation.coveredFeet = Math.max(originalCoveredFeet - reusedCoveredFeet, 0);
          existingAllocation.notes =
            existingAllocation.notes ||
            `Split ${reusedFeet} LF to resolve ordered-box receipt for Film Order ${filmOrder.filmOrderId}.`;
          await saveAllocationRecord(client, orgId, existingAllocation);

          await createAllocationRecord(
            client,
            orgId,
            box,
            {
              jobNumber: filmOrder.jobNumber,
              installDate: filmOrder.installDate,
              crewLeader: filmOrder.crewLeader
            },
            reusedFeet,
            reusedCoveredFeet,
            user,
            filmOrder.filmOrderId,
            'REQUIREMENT',
            existingAllocation.requirementId,
            {
              allocationSource: 'FILM_ORDER_RECEIPT',
              notes: `Split from ordered-box placeholder ${originalAllocationId} on receipt for Film Order ${filmOrder.filmOrderId}.`
            }
          );
        }

        link.autoAllocatedFeet += reusedFeet;
        await saveFilmOrderLinkRecord(client, orgId, link);
        filmOrder.coveredFeet += reusedCoveredFeet;
        remainingNeed = Math.max(filmOrder.requestedFeet - filmOrder.coveredFeet, 0);
        boxAllocations = await listAllocationsByBox(client, orgId, box.boxId);
        linkCapacity = getLinkedBoxRemainingPhysicalFeet(link, box, boxAllocations);
        warnings.push(
          `${reusedCoveredFeet} covered LF (${reusedFeet} physical LF) placeholder from ${box.boxId} was resolved to job ${filmOrder.jobNumber} for Film Order ${filmOrder.filmOrderId}.`
        );
        box.feetAvailable = Math.max(box.feetAvailable - reusedFeet, 0);
      }
    }

    requirement ||= findFilmOrderRequirement(requirements, filmOrder);
    const allocationPlan = planCoverageAllocation(
      remainingNeed,
      Math.min(linkCapacity, integerOrZero(box.feetAvailable)),
      box.widthIn,
      filmOrder.widthIn
    );
    const allocationFeet = allocationPlan.allocatedFeet;
    const allocationCoveredFeet = allocationPlan.coveredFeet;

    if (allocationFeet <= 0 || allocationCoveredFeet <= 0) {
      continue;
    }

    await createAllocationRecord(
      client,
      orgId,
      box,
      {
        jobNumber: filmOrder.jobNumber,
        installDate: filmOrder.installDate,
        crewLeader: filmOrder.crewLeader
      },
      allocationFeet,
      allocationCoveredFeet,
      user,
      filmOrder.filmOrderId,
      'REQUIREMENT',
      requirement?.id || '',
      { allocationSource: 'FILM_ORDER_RECEIPT' }
    );

    box.feetAvailable = Math.max(box.feetAvailable - allocationFeet, 0);
    link.autoAllocatedFeet += allocationFeet;
    await saveFilmOrderLinkRecord(client, orgId, link);
    warnings.push(
      `${allocationCoveredFeet} covered LF (${allocationFeet} physical LF) from ${box.boxId} was automatically allocated to job ${filmOrder.jobNumber} for Film Order ${filmOrder.filmOrderId}.`
    );
  }

  for (const filmOrderId of Object.keys(recalculatedOrders)) {
    await recalculateFilmOrder(client, orgId, filmOrderId, user);
  }

  return box;
}

export {
  resolveJobContext,
  getDateConflictJobsForBox,
  buildAllocationPreviewPlan,
  calculateSelectedSuggestionAllocations,
  parseCrossWarehouseFlag,
  normalizeOptionalWarehouse,
  getOrResolveJobId,
  buildManualRequirementAllocationMergePlan,
  createAllocationRecord,
  sumFilmOrderCoveredFeet,
  sumFilmOrderOrderedFeet,
  recalculateFilmOrder,
  createFilmOrderForShortage,
  linkBoxToFilmOrder,
  processLinkedFilmOrderReceipt,
};
