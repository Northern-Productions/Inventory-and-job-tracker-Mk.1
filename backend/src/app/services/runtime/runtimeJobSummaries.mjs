// Purpose: Job summary, lifecycle, and linked film-order presentation helpers.
import { buildCurrentCheckedOutAllocationIdSet } from '../../../../../shared/checkoutSemantics.mjs';
import { hasSameDayCrewConflict } from '../../../../../shared/domain/sameDayCrewConflicts.mjs';
import {
  chooseCurrentJobPhaseGroup,
  compareJobPhasesByNumber,
  getJobPhaseWorkflowStatus,
  isJobPhaseComplete,
  isJobPhaseWorkflowActive,
  resolveCurrentJobCrewLeader,
} from '../../../../../shared/domain/jobCurrentAssignment.mjs';
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
  listFilmOrderLinksByFilmOrderIds,
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
  matchesBoxSearchQuery,
  rankBoxSearchCandidates,
  canSharedJobPlanningFilmSatisfyRequirement,
  compareSharedJobPlanningFilmMatches,
  describeSharedJobPlanningFilm,
  getSharedJobPlanningFilmMatch,
  rankJobNumberSearchCandidates,
} from '../runtimeDeps.mjs';
import {
  buildAllocationCoverageByRequirementId,
  buildAllocationJobSummary,
  buildCaulkCoverageByRequirementId,
  getFilmOnTheWayFeetForRequirement,
  getStoredAllocationCoveredFeet,
  isCaulkRequirementComplete,
  isRequirementComplete,
  resolveAllocationJobMetadata,
  summarizeCaulkRequirementCoverage,
} from './runtimeAllocationCoverage.mjs';
import {
  enrichOpenFilmOrdersWithJobSchedule,
  isUnresolvedFilmOrderStatus,
} from './runtimeFilmOrderSchedule.mjs';
import { buildCaulkTransferAlertMessage, buildFilmTransferAlertMessage } from './runtimeTransferUsage.mjs';
import { buildBoxReservationMetrics } from './runtimeAllocationReservations.mjs';

function countUnresolvedFilmOrders(filmOrders) {
  const entries = Array.isArray(filmOrders) ? filmOrders : [];
  let count = 0;
  for (let index = 0; index < entries.length; index += 1) {
    if (isUnresolvedFilmOrderStatus(entries[index]?.status)) {
      count += 1;
    }
  }

  return count;
}

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
    workScope: null,
    sections: null,
    installDate: metadata.installDate,
    crewLeader: metadata.crewLeader,
    lifecycleStatus: 'ACTIVE',
    isLaborOnly: false,
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

  if (legacySummary.status === 'COMPLETED') {
    return 'COMPLETED';
  }

  return 'FILM_ORDER';
}

function isOpenMaterialFilmOrder(entry) {
  const status = asTrimmedString(entry?.status).toUpperCase();
  return status === 'FILM_ORDER' || status === 'FILM_ON_THE_WAY';
}

function isActiveMaterialFilmOrder(entry) {
  return asTrimmedString(entry?.status).toUpperCase() === 'FILM_ORDER';
}

function getRequirementId(requirement) {
  return asTrimmedString(requirement?.requirementId || requirement?.id);
}

function indexReadinessBoxes(allBoxes, boxById = {}) {
  const response = { ...(boxById || {}) };
  const entries = Array.isArray(allBoxes) ? allBoxes : [];

  for (let index = 0; index < entries.length; index += 1) {
    const box = entries[index];
    const boxId = asTrimmedString(box?.boxId);
    if (!boxId) {
      continue;
    }

    response[boxId] = box;
    response[boxId.toUpperCase()] = box;
  }

  return response;
}

function deriveInStockReadinessStatus({
  jobNumber,
  lifecycleStatus,
  isLaborOnly,
  requirements,
  caulkRequirements,
  allocations,
  caulkAllocations,
  filmOrders,
  allBoxes,
  boxById,
  caulkStockEntries,
  jobWarehouse,
}) {
  /**
   * PURPOSE:
   * Derives the active job material status from canonical stored allocation
   * coverage: requirement-linked caulk first, then deterministic same-product
   * fallback for unbound caulk allocations.
   *
   * AFFECTS:
   * Job list/detail status pills, allocation job summaries, calendar colors,
   * manual Order/Cancel affordances, and staging expectations.
   *
   * WHEN CHANGING THIS, ALSO CHECK:
   * Supabase api-handler status derivation, frontend optimistic status math,
   * jobSorts/jobCalendar, caulk allocation coverage, and allocation matching
   * rules.
   *
   * COMMON FAILURE MODES:
   * Trusting stale remaining values, counting stale requirement IDs, double
   * counting fallback caulk allocations, or local/Supabase status drift.
   */
  void caulkStockEntries;
  const normalizedLifecycleStatus = normalizeJobLifecycleStatus(lifecycleStatus);
  if (normalizedLifecycleStatus === 'CANCELLED') {
    return 'CANCELLED';
  }

  if (normalizedLifecycleStatus === 'COMPLETED') {
    return 'COMPLETED';
  }

  const normalizedRequirements = Array.isArray(requirements) ? requirements : [];
  const normalizedCaulkRequirements = Array.isArray(caulkRequirements) ? caulkRequirements : [];
  const normalizedFilmOrders = Array.isArray(filmOrders) ? filmOrders : [];
  const hasMaterialRequirements = hasJobMaterialRequirements(normalizedRequirements, normalizedCaulkRequirements);
  if (!hasMaterialRequirements) {
    if (isLaborOnly || normalizedRequirements.length || normalizedCaulkRequirements.length) {
      return 'READY';
    }
    if (!normalizedFilmOrders.some(isOpenMaterialFilmOrder)) {
      return 'READY';
    }
    if (normalizedFilmOrders.some((entry) => asTrimmedString(entry?.status).toUpperCase() === 'FILM_ORDER')) {
      return 'FILM_ORDER';
    }
    return 'ORDERED';
  }

  const readinessBoxById = indexReadinessBoxes(allBoxes, boxById);
  const filmCoverageByRequirementId = buildAllocationCoverageByRequirementId(
    normalizedRequirements,
    Array.isArray(allocations) ? allocations : [],
    readinessBoxById,
    { jobNumber }
  );
  const caulkCoverageByRequirementId = buildCaulkCoverageByRequirementId(
    normalizedCaulkRequirements,
    Array.isArray(caulkAllocations) ? caulkAllocations : [],
    { jobNumber, jobWarehouse }
  );

  function getMissingFilmFeet(requirement, allocatedFeet) {
    const requiredFeet = integerOrZero(requirement?.requiredFeet);
    if (requiredFeet <= 0) {
      return 0;
    }

    const actualUsedFeet = integerOrZero(requirement?.actualUsedFeet);
    return Math.max(0, requiredFeet - actualUsedFeet - Math.min(integerOrZero(allocatedFeet), requiredFeet));
  }

  const filmReady = normalizedRequirements.every((requirement) => {
    if (isRequirementComplete(requirement)) {
      return true;
    }
    if (integerOrZero(requirement?.requiredFeet) <= 0) {
      return true;
    }

    const requirementId = getRequirementId(requirement);
    if (!requirementId) {
      return false;
    }

    return getMissingFilmFeet(requirement, filmCoverageByRequirementId[requirementId]?.allocatedFeet) <= 0;
  });
  const caulkReady = normalizedCaulkRequirements.every((requirement) => {
    if (isCaulkRequirementComplete(requirement)) {
      return true;
    }
    const requiredTubes = integerOrZero(requirement?.requiredTubes);
    if (requiredTubes <= 0) {
      return true;
    }

    const requirementId = getRequirementId(requirement);
    if (!requirementId) {
      return false;
    }

    return integerOrZero(caulkCoverageByRequirementId[requirementId]) >= requiredTubes;
  });

  if (filmReady && caulkReady) {
    return 'READY';
  }

  const hasActiveFilmOrder = normalizedFilmOrders.some(isActiveMaterialFilmOrder);
  const filmOrdered = normalizedRequirements.every((requirement) => {
    if (isRequirementComplete(requirement)) {
      return true;
    }
    if (integerOrZero(requirement?.requiredFeet) <= 0) {
      return true;
    }

    const requirementId = getRequirementId(requirement);
    if (!requirementId) {
      return false;
    }

    const missingFeet = getMissingFilmFeet(requirement, filmCoverageByRequirementId[requirementId]?.allocatedFeet);
    return missingFeet <= 0 || getFilmOnTheWayFeetForRequirement(normalizedFilmOrders, requirement) >= missingFeet;
  });

  if (caulkReady && filmOrdered) {
    return 'ORDERED';
  }

  return hasActiveFilmOrder ? 'FILM_ORDER' : 'NEEDS_ALLOCATION';
}

function computeJobStatusFromRequirements(
  lifecycleStatus,
  isLaborOnly,
  isStagedForPickup,
  requirements,
  caulkRequirements,
  allocations,
  filmOrders,
  options = {}
) {
  void isStagedForPickup;
  return deriveInStockReadinessStatus({
    lifecycleStatus,
    isLaborOnly,
    requirements,
    caulkRequirements,
    allocations,
    caulkAllocations: options.caulkAllocations || [],
    filmOrders,
    allBoxes: options.allBoxes || [],
    boxById: options.boxById || {},
    caulkStockEntries: options.caulkStockEntries || [],
    jobWarehouse: options.jobWarehouse || '',
    jobNumber: options.jobNumber || '',
  });
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
      !asTrimmedString(entry.resolvedAt || entry.resolved_at) &&
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
  caulkTransferAlerts = [],
  boxById = {}
) {
  const hasMaterialRequirements = hasJobMaterialRequirements(requirements, caulkRequirements);
  if (!hasMaterialRequirements) {
    return '';
  }

  const hasRemainingFilm = requirements.some((entry) => integerOrZero(entry.remainingFeet) > 0);
  const hasRemainingCaulk = caulkRequirements.some(
    (entry) => !isCaulkRequirementComplete(entry) && integerOrZero(entry.remainingTubes) > 0
  );
  if (hasRemainingFilm || hasRemainingCaulk) {
    return 'All required film and caulk must be fully allocated before staging this job.';
  }

  if (
    Array.isArray(filmTransferAlerts) &&
    filmTransferAlerts.length > 0 &&
    Array.isArray(caulkTransferAlerts) &&
    caulkTransferAlerts.length > 0
  ) {
    return 'Receive transferred film and caulk before staging this job.';
  }

  if (Array.isArray(filmTransferAlerts) && filmTransferAlerts.length > 0) {
    return buildFilmTransferAlertMessage(filmTransferAlerts, 'staging');
  }

  if (Array.isArray(caulkTransferAlerts) && caulkTransferAlerts.length > 0) {
    return buildCaulkTransferAlertMessage(caulkTransferAlerts, 'staging');
  }

  if (hasActiveOrderedRequirementAllocations(allocations, boxById)) {
    return buildOrderedAllocationReceiptMessage('staging');
  }

  if (hasUncheckedOutFilmRequirementAllocations(allocations)) {
    return 'All required film must be checked out before staging this job.';
  }

  if (hasUncheckedOutCaulkAllocations(caulkAllocations)) {
    return 'All required caulk must be checked out before staging this job.';
  }

  return '';
}

function hasSharedActiveBoxConflict(jobNumber, installDate, crewLeader, jobAllocations, allAllocations) {
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

  return hasSameDayCrewConflict(
    { jobNumber, installDate, crewLeader },
    allAllocations,
    { boxIds: activeBoxIds }
  );
}

function getEntryPhaseId(entry) {
  return asTrimmedString(entry?.phaseId || entry?.phase_id);
}

function getPhaseWorkflowStatus(phase) {
  return getJobPhaseWorkflowStatus(phase);
}

function isPhaseWorkflowActive(phase) {
  return isJobPhaseWorkflowActive(phase);
}

function getPhaseDisplayWorkScope(phase, fallback = null) {
  return phase?.workScope ?? phase?.sections ?? fallback ?? null;
}

function buildFallbackJobPhase(jobHeader) {
  return {
    phaseId: '',
    phaseNumber: 1,
    workScope: jobHeader.workScope ?? jobHeader.sections ?? null,
    sections: jobHeader.sections ?? jobHeader.workScope ?? null,
    installDate: jobHeader.installDate || '',
    crewLeader: jobHeader.crewLeader || '',
    laborStatus: jobHeader.isLaborOnly ? 'ACTIVE' : 'ACTIVE',
    workflowStatus: 'ACTIVE',
    isPlaceholder: false,
    isPrimary: true,
    createdAt: jobHeader.createdAt || '',
    updatedAt: jobHeader.updatedAt || '',
  };
}

function filterEntriesForPhase(entries, phase, fallbackPhaseId = '') {
  const phaseId = asTrimmedString(phase?.phaseId);
  const fallbackId = asTrimmedString(fallbackPhaseId);
  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    const entryPhaseId = getEntryPhaseId(entry);
    if (phaseId) {
      return entryPhaseId === phaseId || (!entryPhaseId && fallbackId === phaseId);
    }
    return !entryPhaseId;
  });
}

function filterRequirementLinkedEntriesForPhase(entries, phase, requirementIds, fallbackPhaseId = '') {
  const phaseId = asTrimmedString(phase?.phaseId);
  const fallbackId = asTrimmedString(fallbackPhaseId);
  const scopedRequirementIds = requirementIds instanceof Set ? requirementIds : new Set();
  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    const entryPhaseId = getEntryPhaseId(entry);
    if (entryPhaseId) {
      return entryPhaseId === phaseId || (!phaseId && !entryPhaseId);
    }

    const requirementId = getRequirementId(entry);
    if (requirementId) {
      return scopedRequirementIds.has(requirementId);
    }

    return Boolean(phaseId && fallbackId === phaseId);
  });
}

function isPhaseCompleteFromRequirements(phase, requirements, caulkRequirements = []) {
  return isJobPhaseComplete(phase, requirements, caulkRequirements);
}

function comparePhasesByNumber(left, right) {
  return compareJobPhasesByNumber(left, right, compareCatalogStrings);
}

function chooseNextRelevantPhaseGroup(phases) {
  return chooseCurrentJobPhaseGroup(phases, {
    today: todayDateString(),
    compareStrings: compareCatalogStrings,
  });
}

function combinePhaseGroupStatus(phases) {
  const statuses = (Array.isArray(phases) ? phases : []).map((phase) => asTrimmedString(phase.status).toUpperCase());
  if (statuses.includes('FILM_ORDER')) {
    return 'FILM_ORDER';
  }
  if (statuses.includes('ORDERED')) {
    return 'ORDERED';
  }
  if (statuses.includes('NEEDS_ALLOCATION')) {
    return 'NEEDS_ALLOCATION';
  }
  if (statuses.includes('COMPLETED')) {
    return 'COMPLETED';
  }
  return 'READY';
}

function buildJobPhaseEntries(
  jobHeader,
  phases,
  requirements,
  allocations,
  filmOrders,
  caulkRequirements,
  caulkAllocations,
  boxById,
  options = {}
) {
  const phaseSource = Array.isArray(phases) && phases.length
    ? phases.slice().sort(comparePhasesByNumber)
    : [buildFallbackJobPhase(jobHeader)];
  const fallbackPhaseId = asTrimmedString(phaseSource.find((entry) => entry.isPrimary)?.phaseId || phaseSource[0]?.phaseId);
  const entries = [];

  for (let index = 0; index < phaseSource.length; index += 1) {
    const phase = phaseSource[index];
    const phaseRequirements = filterEntriesForPhase(requirements, phase, fallbackPhaseId);
    const phaseCaulkRequirements = filterEntriesForPhase(caulkRequirements, phase, fallbackPhaseId);
    const phaseRequirementIds = new Set(phaseRequirements.map((entry) => getRequirementId(entry)).filter(Boolean));
    const phaseCaulkRequirementIds = new Set(phaseCaulkRequirements.map((entry) => getRequirementId(entry)).filter(Boolean));
    const phaseAllocations = filterRequirementLinkedEntriesForPhase(
      allocations,
      phase,
      phaseRequirementIds,
      fallbackPhaseId
    );
    const phaseCaulkAllocations = filterRequirementLinkedEntriesForPhase(
      caulkAllocations,
      phase,
      phaseCaulkRequirementIds,
      fallbackPhaseId
    );
    const phaseFilmOrders = filterRequirementLinkedEntriesForPhase(
      filmOrders,
      phase,
      phaseRequirementIds,
      fallbackPhaseId
    );
    const isComplete = isPhaseCompleteFromRequirements(phase, phaseRequirements, phaseCaulkRequirements);
    const workflowStatus = getPhaseWorkflowStatus(phase);
    const status = isComplete
      ? 'COMPLETED'
      : deriveInStockReadinessStatus({
          lifecycleStatus: jobHeader.lifecycleStatus,
          isLaborOnly: !phaseRequirements.length && !phaseCaulkRequirements.length,
          requirements: phaseRequirements,
          caulkRequirements: phaseCaulkRequirements,
          allocations: phaseAllocations,
          caulkAllocations: phaseCaulkAllocations,
          filmOrders: phaseFilmOrders,
          allBoxes: options.allBoxes || Object.values(boxById || {}),
          boxById,
          caulkStockEntries: options.caulkStockEntries || [],
          jobWarehouse: jobHeader.warehouse || '',
          jobNumber: jobHeader.jobNumber || '',
        });
    let requiredFeet = 0;
    let allocatedFeet = 0;
    let allocatedWithInstallDateFeet = 0;
    let allocatedWithoutInstallDateFeet = 0;
    let remainingFeet = 0;
    for (let requirementIndex = 0; requirementIndex < phaseRequirements.length; requirementIndex += 1) {
      const requirement = phaseRequirements[requirementIndex];
      if (isRequirementComplete(requirement)) {
        continue;
      }
      requiredFeet += integerOrZero(requirement.requiredFeet);
      allocatedFeet += integerOrZero(requirement.allocatedFeet);
      allocatedWithInstallDateFeet += integerOrZero(requirement.allocatedWithInstallDateFeet);
      allocatedWithoutInstallDateFeet += integerOrZero(requirement.allocatedWithoutInstallDateFeet);
      remainingFeet += integerOrZero(requirement.remainingFeet);
    }
    const caulkTotals = summarizeCaulkRequirementCoverage(isComplete ? [] : phaseCaulkRequirements);

    entries.push({
      phaseId: asTrimmedString(phase.phaseId || phase.id),
      phaseNumber: integerOrZero(phase.phaseNumber) || index + 1,
      workScope: getPhaseDisplayWorkScope(phase, jobHeader.workScope ?? jobHeader.sections ?? null),
      sections: getPhaseDisplayWorkScope(phase, jobHeader.sections ?? jobHeader.workScope ?? null),
      installDate: asTrimmedString(phase.installDate),
      installEndDate: asTrimmedString(phase.installEndDate),
      crewLeader: asTrimmedString(phase.crewLeader),
      laborStatus: asTrimmedString(phase.laborStatus || phase.status).toUpperCase() === 'COMPLETE' ? 'COMPLETE' : 'ACTIVE',
      workflowStatus,
      isPlaceholder: workflowStatus === 'PLACEHOLDER',
      isWorkflowActive: workflowStatus === 'ACTIVE',
      status,
      isComplete,
      isPrimary: phase.isPrimary === true || (!phase.isPrimary && index === 0),
      requiredFeet,
      allocatedFeet,
      allocatedWithInstallDateFeet,
      allocatedWithoutInstallDateFeet,
      remainingFeet,
      requiredTubes: caulkTotals.requiredTubes,
      allocatedTubes: caulkTotals.allocatedTubes,
      remainingTubes: caulkTotals.remainingTubes,
      requirementCount: phaseRequirements.length,
      caulkRequirementCount: phaseCaulkRequirements.length,
      filmOrderCount: countUnresolvedFilmOrders(phaseFilmOrders),
      allocationCount: phaseAllocations.length,
      createdAt: asTrimmedString(phase.createdAt),
      updatedAt: asTrimmedString(phase.updatedAt),
    });
  }

  const currentGroup = chooseNextRelevantPhaseGroup(entries);
  const currentIds = new Set(currentGroup.map((entry) => asTrimmedString(entry.phaseId)));
  return entries.map((entry) => ({
    ...entry,
    isNextRelevant: currentIds.has(asTrimmedString(entry.phaseId)),
    isExpandedByDefault:
      currentIds.has(asTrimmedString(entry.phaseId)) ||
      (entry.isWorkflowActive && !entry.isComplete && !entry.installDate)
  }));
}

function buildJobListEntry(
  jobHeader,
  requirements,
  allocations,
  filmOrders,
  allAllocations = [],
  caulkRequirements = [],
  boxById = {},
  options = {}
) {
  const metadata = resolveAllocationJobMetadata(allocations, filmOrders);
  const phaseEntries = buildJobPhaseEntries(
    jobHeader,
    options.phases || [],
    requirements,
    allocations,
    filmOrders,
    caulkRequirements,
    options.caulkAllocations || [],
    boxById,
    options
  );
  const nextPhaseGroup = chooseNextRelevantPhaseGroup(phaseEntries);
  const activePhaseEntries = phaseEntries.filter(isPhaseWorkflowActive);
  const currentPhase = nextPhaseGroup[0] || activePhaseEntries[0] || phaseEntries[0] || null;
  let installDate = asTrimmedString(currentPhase?.installDate) || jobHeader.installDate;
  if (!installDate) {
    installDate = metadata.installDate;
  }
  const installEndDate = asTrimmedString(currentPhase?.installEndDate);
  const crewLeader = resolveCurrentJobCrewLeader({
    currentPhase,
    jobCrewLeader: jobHeader.crewLeader,
    legacyCrewLeader: metadata.crewLeader,
  });

  let requiredFeet = 0;
  let allocatedFeet = 0;
  let allocatedWithInstallDateFeet = 0;
  let allocatedWithoutInstallDateFeet = 0;
  let remainingFeet = 0;
  const summaryPhaseGroup = nextPhaseGroup.length ? nextPhaseGroup : activePhaseEntries;
  const entryBelongsToSummaryPhase = (entry) => {
    const entryPhaseId = getEntryPhaseId(entry);
    return summaryPhaseGroup.some((phase) => {
      const phaseId = asTrimmedString(phase.phaseId);
      return phaseId ? entryPhaseId === phaseId : !entryPhaseId;
    });
  };
  const summaryRequirements = summaryPhaseGroup.length
    ? requirements.filter(entryBelongsToSummaryPhase)
    : [];
  const summaryCaulkRequirements = summaryPhaseGroup.length
    ? caulkRequirements.filter(entryBelongsToSummaryPhase)
    : [];
  const caulkTotals = summaryPhaseGroup.length
    ? {
        requiredTubes: summaryPhaseGroup.reduce((sum, phase) => sum + integerOrZero(phase.requiredTubes), 0),
        allocatedTubes: summaryPhaseGroup.reduce((sum, phase) => sum + integerOrZero(phase.allocatedTubes), 0),
        remainingTubes: summaryPhaseGroup.reduce((sum, phase) => sum + integerOrZero(phase.remainingTubes), 0),
      }
    : { requiredTubes: 0, allocatedTubes: 0, remainingTubes: 0 };

  for (let index = 0; index < summaryRequirements.length; index += 1) {
    if (isRequirementComplete(summaryRequirements[index])) {
      continue;
    }
    requiredFeet += summaryRequirements[index].requiredFeet;
    allocatedFeet += summaryRequirements[index].allocatedFeet;
    allocatedWithInstallDateFeet += integerOrZero(summaryRequirements[index].allocatedWithInstallDateFeet);
    allocatedWithoutInstallDateFeet += integerOrZero(summaryRequirements[index].allocatedWithoutInstallDateFeet);
    remainingFeet += summaryRequirements[index].remainingFeet;
  }

  const lifecycleStatus =
    jobHeader && jobHeader.id
      ? resolveEffectiveJobLifecycleStatus(jobHeader.lifecycleStatus, allocations, filmOrders)
      : deriveLegacyLifecycleStatus(allocations, filmOrders);
  const summaryRequirementIds = new Set(summaryRequirements.map((entry) => getRequirementId(entry)).filter(Boolean));
  const summaryCaulkRequirementIds = new Set(summaryCaulkRequirements.map((entry) => getRequirementId(entry)).filter(Boolean));
  const scopedAllocations = summaryPhaseGroup.length
    ? allocations.filter((entry) => summaryRequirementIds.has(getRequirementId(entry)) || entryBelongsToSummaryPhase(entry))
    : [];
  const scopedFilmOrders = summaryPhaseGroup.length
    ? filmOrders.filter((entry) => summaryRequirementIds.has(getRequirementId(entry)) || entryBelongsToSummaryPhase(entry))
    : [];
  const scopedCaulkAllocations = summaryPhaseGroup.length
    ? (options.caulkAllocations || []).filter((entry) =>
        summaryCaulkRequirementIds.has(getRequirementId(entry)) || entryBelongsToSummaryPhase(entry)
      )
    : [];
  const baseStatus = nextPhaseGroup.length
    ? combinePhaseGroupStatus(nextPhaseGroup)
    : computeJobStatusFromRequirements(
    lifecycleStatus,
    !summaryRequirements.length && !summaryCaulkRequirements.length,
    Boolean(jobHeader.isStagedForPickup),
    summaryRequirements,
    summaryCaulkRequirements,
    scopedAllocations,
    scopedFilmOrders,
    {
      allBoxes: options.allBoxes || Object.values(boxById || {}),
      caulkAllocations: scopedCaulkAllocations,
      caulkStockEntries: options.caulkStockEntries || [],
      jobWarehouse: jobHeader.warehouse || '',
      jobNumber: jobHeader.jobNumber || '',
      boxById,
    }
  );
  const status =
    baseStatus === 'FILM_ORDER' &&
    hasSharedActiveBoxConflict(jobHeader.jobNumber, installDate, crewLeader, allocations, allAllocations)
      ? 'FILM_ORDER'
      : baseStatus;

  const primaryWorkScope = jobHeader.workScope ?? jobHeader.sections ?? null;
  const workScope = getPhaseDisplayWorkScope(currentPhase, primaryWorkScope);

  return {
    jobId: jobHeader.id || '',
    jobNumber: jobHeader.jobNumber,
    warehouse: jobHeader.warehouse || '',
    workScope,
    primaryWorkScope,
    workScopeKey: jobHeader.workScopeKey || '',
    sections: workScope,
    phaseId: asTrimmedString(currentPhase?.phaseId),
    phaseNumber: integerOrZero(currentPhase?.phaseNumber) || undefined,
    phaseWorkScope: workScope,
    workflowStatus: getPhaseWorkflowStatus(currentPhase),
    isPlaceholder: getPhaseWorkflowStatus(currentPhase) === 'PLACEHOLDER',
    phaseCount: phaseEntries.length,
    phases: phaseEntries,
    installDate,
    installEndDate,
    crewLeader,
    status,
    lifecycleStatus,
    isLaborOnly: Boolean(jobHeader.isLaborOnly),
    isStagedForPickup: Boolean(jobHeader.isStagedForPickup),
    requiredFeet,
    allocatedFeet,
    allocatedWithInstallDateFeet,
    allocatedWithoutInstallDateFeet,
    remainingFeet,
    requiredTubes: caulkTotals.requiredTubes,
    allocatedTubes: caulkTotals.allocatedTubes,
    remainingTubes: caulkTotals.remainingTubes,
    requirementCount: requirements.length,
    allocationCount: allocations.length,
    filmOrderCount: countUnresolvedFilmOrders(scopedFilmOrders),
    hasOrderedAllocations: hasActiveOrderedAllocations(scopedAllocations, boxById),
    createdAt: jobHeader.createdAt || '',
    updatedAt: jobHeader.updatedAt || '',
    notes: jobHeader.notes || ''
  };
}

function buildPublicAllocationEntriesForJob(allocations, boxById, requirements = []) {
  const sortedAllocations = allocations
    .slice()
    .sort((left, right) => {
      if (left.status !== right.status) {
        return left.status === 'ACTIVE' ? -1 : right.status === 'ACTIVE' ? 1 : left.status < right.status ? -1 : 1;
      }

      if (left.installDate !== right.installDate) {
        if (left.installDate && right.installDate) {
          return left.installDate < right.installDate ? -1 : 1;
        }

        if (left.installDate) {
          return -1;
        }

        if (right.installDate) {
          return 1;
        }
      }

      return left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0;
    });
  const currentCheckedOutAllocationIds = buildCurrentCheckedOutAllocationIdSet(sortedAllocations, boxById);
  const activeAllocationsByBoxId = {};

  for (let index = 0; index < sortedAllocations.length; index += 1) {
    const entry = sortedAllocations[index];
    if (asTrimmedString(entry?.status).toUpperCase() !== 'ACTIVE') {
      continue;
    }

    if (!activeAllocationsByBoxId[entry.boxId]) {
      activeAllocationsByBoxId[entry.boxId] = [];
    }

    activeAllocationsByBoxId[entry.boxId].push(entry);
  }

  const reservationMetricsByBoxId = {};
  for (const boxId of Object.keys(activeAllocationsByBoxId)) {
    const box = boxById[boxId];
    if (!box) {
      continue;
    }

    reservationMetricsByBoxId[boxId] = buildBoxReservationMetrics(box, activeAllocationsByBoxId[boxId]);
  }
  const requirementById = {};
  for (let index = 0; index < requirements.length; index += 1) {
    const requirement = requirements[index];
    const requirementId = asTrimmedString(requirement?.id || requirement?.requirementId);
    if (requirementId) {
      requirementById[requirementId] = requirement;
    }
  }

  return sortedAllocations.map((entry) => {
    const box = boxById[entry.boxId];
    const requirement = requirementById[asTrimmedString(entry.requirementId)] || null;
    const reservationSnapshot =
      reservationMetricsByBoxId[entry.boxId]?.allocationSnapshotsById?.[entry.allocationId] || null;
    return {
      ...toPublicAllocation(entry),
      manufacturer: box ? box.manufacturer : '',
      filmName: box ? box.filmName : '',
      widthIn: box ? box.widthIn : 0,
      requirementManufacturer: requirement ? requirement.manufacturer : '',
      requirementFilmName: requirement ? requirement.filmName : '',
      requirementWidthIn: requirement ? requirement.widthIn : 0,
      boxStatus: box ? box.status : '',
      backedPhysicalFeet: reservationSnapshot ? reservationSnapshot.backedPhysicalFeet : integerOrZero(entry.allocatedFeet),
      reservationState: reservationSnapshot ? reservationSnapshot.reservationState : 'WITHOUT_INSTALL_DATE',
      checkedOutOnThisJob: Boolean(currentCheckedOutAllocationIds[entry.allocationId])
    };
  });
}

async function buildPublicFilmOrderLinkedBoxes(client, orgId, filmOrderId) {
  const groupedLinkedBoxes = await buildPublicFilmOrderLinkedBoxesByFilmOrderId(
    client,
    orgId,
    [{ filmOrderId }]
  );

  return groupedLinkedBoxes[asTrimmedString(filmOrderId)] || [];
}

function isReceivedLinkedBoxStatus(status) {
  const normalizedStatus = asTrimmedString(status).toUpperCase();
  return normalizedStatus !== '' && normalizedStatus !== 'ORDERED';
}

async function buildPublicFilmOrderLinkedBoxesByFilmOrderId(client, orgId, filmOrders, boxById = {}) {
  const normalizedFilmOrders = Array.isArray(filmOrders) ? filmOrders : [];
  const filmOrderIds = Array.from(
    new Set(
      normalizedFilmOrders
        .map((entry) => asTrimmedString(entry?.filmOrderId))
        .filter(Boolean)
    )
  );
  if (!filmOrderIds.length) {
    return {};
  }

  const links = await listFilmOrderLinksByFilmOrderIds(client, orgId, filmOrderIds);
  const linkedBoxById = {
    ...(boxById || {})
  };
  const missingBoxIds = Array.from(
    new Set(
      links
        .map((entry) => asTrimmedString(entry?.boxId).toUpperCase())
        .filter((boxId) => boxId && !linkedBoxById[boxId])
    )
  );
  if (missingBoxIds.length) {
    const missingBoxes = await listBoxesByIds(client, orgId, missingBoxIds);
    for (let index = 0; index < missingBoxes.length; index += 1) {
      const box = missingBoxes[index];
      linkedBoxById[box.boxId] = box;
    }
  }

  const grouped = {};
  const filmOrderById = {};
  for (let index = 0; index < normalizedFilmOrders.length; index += 1) {
    const filmOrderId = asTrimmedString(normalizedFilmOrders[index]?.filmOrderId);
    if (filmOrderId) {
      filmOrderById[filmOrderId] = normalizedFilmOrders[index];
    }
  }

  for (let index = 0; index < links.length; index += 1) {
    const link = links[index];
    const filmOrderId = asTrimmedString(link?.filmOrderId);
    const boxId = asTrimmedString(link?.boxId).toUpperCase();
    if (!filmOrderId || !boxId || !linkedBoxById[boxId]) {
      continue;
    }

    if (!grouped[filmOrderId]) {
      grouped[filmOrderId] = [];
    }

    const box = linkedBoxById[boxId];
    const filmOrder = filmOrderById[filmOrderId] || {};
    const orderedFeet = computeCoveredFeetForAllocation(
      Math.max(0, Number(box?.initialFeet || link.orderedFeet || 0) || 0),
      box?.widthIn || filmOrder?.widthIn,
      filmOrder?.widthIn
    );

    grouped[filmOrderId].push({
      boxId,
      orderedFeet,
      autoAllocatedFeet: link.autoAllocatedFeet,
      dealer: asTrimmedString(box.dealer),
      isReceived: isReceivedLinkedBoxStatus(box.status),
      ...(box.directToJobSite === true ? { isDirectToJobSite: true } : {})
    });
  }

  const groupedKeys = Object.keys(grouped);
  for (let index = 0; index < groupedKeys.length; index += 1) {
    grouped[groupedKeys[index]].sort((left, right) =>
      left.boxId < right.boxId ? -1 : left.boxId > right.boxId ? 1 : 0
    );
  }

  return grouped;
}

async function buildPublicFilmOrdersForJob(client, orgId, filmOrders, options = {}) {
  const response = [];
  const enrichedEntries = await enrichOpenFilmOrdersWithJobSchedule(client, orgId, filmOrders);
  const linkedBoxesByFilmOrderId = await buildPublicFilmOrderLinkedBoxesByFilmOrderId(
    client,
    orgId,
    enrichedEntries,
    options.boxById
  );
  const sorted = enrichedEntries.slice().sort((left, right) =>
    compareAllocationJobSummaries(
      { installDate: left.createdAt, jobNumber: left.filmOrderId },
      { installDate: right.createdAt, jobNumber: right.filmOrderId }
    )
  );

  for (let index = 0; index < sorted.length; index += 1) {
    const entry = sorted[index];
    const linkedBoxes = linkedBoxesByFilmOrderId[asTrimmedString(entry.filmOrderId)] || [];
    response.push(toPublicFilmOrder(entry, linkedBoxes));
  }

  return response;
}

export {
  buildLegacyJobHeaderFromData,
  deriveLegacyLifecycleStatus,
  resolveEffectiveJobLifecycleStatus,
  deriveJobStatusFromLegacyAllocationData,
  deriveInStockReadinessStatus,
  computeJobStatusFromRequirements,
  hasOpenFilmOrders,
  hasUncheckedOutFilmRequirementAllocations,
  hasUncheckedOutCaulkAllocations,
  getJobStagingBlockingReason,
  getPhaseWorkflowStatus,
  isPhaseWorkflowActive,
  hasSharedActiveBoxConflict,
  buildJobPhaseEntries,
  chooseNextRelevantPhaseGroup,
  combinePhaseGroupStatus,
  buildJobListEntry,
  buildPublicAllocationEntriesForJob,
  buildPublicFilmOrderLinkedBoxesByFilmOrderId,
  buildPublicFilmOrderLinkedBoxes,
  buildPublicFilmOrdersForJob,
};
