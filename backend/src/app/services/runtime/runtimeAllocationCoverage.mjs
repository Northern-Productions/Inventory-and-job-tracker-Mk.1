// Purpose: Allocation coverage math and requirement projection helpers.
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
import { getAllocationReservationState } from '../../../../../shared/domain/filmAllocationReservations.mjs';

function buildActiveAllocationsByBoxIndex(entries) {
  const grouped = {};

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.status !== 'ACTIVE') {
      continue;
    }

    if (!grouped[entry.boxId]) {
      grouped[entry.boxId] = [];
    }

    grouped[entry.boxId].push(entry);
  }

  return grouped;
}

function getActiveAllocationsForBox(boxId, activeAllocationsByBox) {
  return activeAllocationsByBox && activeAllocationsByBox[boxId] ? activeAllocationsByBox[boxId] : [];
}

function getActiveAllocatedFeetForBox(boxId, activeAllocationsByBox) {
  const entries = getActiveAllocationsForBox(boxId, activeAllocationsByBox);
  let total = 0;

  for (let index = 0; index < entries.length; index += 1) {
    total += entries[index].allocatedFeet;
  }

  return total;
}

function buildJobRequirementsByLookupKey(entries) {
  const byKey = {};

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    byKey[normalizeJobRequirementLookupKey(entry.manufacturer, entry.filmName, entry.widthIn)] = entry;
  }

  return byKey;
}

function stripPlanningExteriorSuffix(filmName) {
  const normalized = normalizeCollapsedCatalogLabel(filmName);
  if (!/\bexterior$/i.test(normalized)) {
    return {
      familyFilmName: normalized,
      isExterior: false
    };
  }

  const stripped = normalizeCollapsedCatalogLabel(normalized.replace(/\s+exterior$/i, ''));
  return {
    familyFilmName: stripped || normalized,
    isExterior: true
  };
}

function describeRequirementPlanningFilm(manufacturer, filmName) {
  const canonical = normalizeCanonicalManufacturerAndFilm(manufacturer, filmName);
  return describeSharedJobPlanningFilm(canonical.manufacturer, canonical.filmName);
}

function normalizeRequirementFilmKey(manufacturer, filmName) {
  return describeRequirementPlanningFilm(manufacturer, filmName).key;
}

function normalizeRequirementFilmFamilyKey(manufacturer, filmName) {
  return describeRequirementPlanningFilm(manufacturer, filmName).familyKey;
}

function requirementFilmIsExterior(manufacturer, filmName) {
  return describeRequirementPlanningFilm(manufacturer, filmName).isExterior;
}

function planningFilmCanSatisfyRequirement(
  candidateManufacturer,
  candidateFilmName,
  requirementManufacturer,
  requirementFilmName
) {
  const candidate = normalizeCanonicalManufacturerAndFilm(candidateManufacturer, candidateFilmName);
  const requirement = normalizeCanonicalManufacturerAndFilm(requirementManufacturer, requirementFilmName);
  return canSharedJobPlanningFilmSatisfyRequirement(
    candidate.manufacturer,
    candidate.filmName,
    requirement.manufacturer,
    requirement.filmName
  );
}

function getRequirementPlanningFilmMatch(
  candidateManufacturer,
  candidateFilmName,
  requirementManufacturer,
  requirementFilmName
) {
  const candidate = normalizeCanonicalManufacturerAndFilm(candidateManufacturer, candidateFilmName);
  const requirement = normalizeCanonicalManufacturerAndFilm(requirementManufacturer, requirementFilmName);
  return getSharedJobPlanningFilmMatch(
    candidate.manufacturer,
    candidate.filmName,
    requirement.manufacturer,
    requirement.filmName
  );
}

function getRequirementPlanningManufacturerGroupKey(manufacturer, filmName) {
  return describeRequirementPlanningFilm(manufacturer, filmName).manufacturerKey;
}

function allocationMatchesRequirement(box, requirement) {
  if (!box || !requirement) {
    return false;
  }

  return (
    planningFilmCanSatisfyRequirement(
      box.manufacturer,
      box.filmName,
      requirement.manufacturer,
      requirement.filmName
    ) &&
    (Number(box.widthIn) || 0) >= (Number(requirement.widthIn) || 0)
  );
}

function getStoredAllocationCoveredFeet(allocation) {
  const coveredFeet = integerOrZero(allocation.coveredFeet);
  if (coveredFeet > 0) {
    return coveredFeet;
  }

  return integerOrZero(allocation.allocatedFeet);
}

function shouldIgnoreAllocationCoverageForBoxStatus(allocation, box) {
  void allocation;
  if (!box) {
    return false;
  }

  return box.status === 'ZEROED' || box.status === 'RETIRED';
}

function compareRequirementCoveragePoolsForRequirement(left, right, requirement) {
  const leftMatch = getRequirementPlanningFilmMatch(
    left.manufacturer,
    left.filmName,
    requirement.manufacturer,
    requirement.filmName
  );
  const rightMatch = getRequirementPlanningFilmMatch(
    right.manufacturer,
    right.filmName,
    requirement.manufacturer,
    requirement.filmName
  );

  if (leftMatch && rightMatch) {
    const matchComparison = compareSharedJobPlanningFilmMatches(leftMatch, rightMatch);
    if (matchComparison !== 0) {
      return matchComparison;
    }
  }

  if (!requirementFilmIsExterior(requirement.manufacturer, requirement.filmName) && left.isExterior !== right.isExterior) {
    return left.isExterior ? 1 : -1;
  }

  if (left.widthIn !== right.widthIn) {
    return left.widthIn - right.widthIn;
  }

  return left.index - right.index;
}

function createEmptyRequirementCoverageSummary() {
  return {
    allocatedFeet: 0,
    allocatedWithInstallDateFeet: 0,
    allocatedWithoutInstallDateFeet: 0,
  };
}

function ensureRequirementCoverageSummary(coverage, requirementId) {
  if (!coverage[requirementId]) {
    coverage[requirementId] = createEmptyRequirementCoverageSummary();
  }

  return coverage[requirementId];
}

function addRequirementCoverageFeet(coverage, requirementId, requiredFeet, reservationState, feet) {
  const normalizedFeet = Math.max(0, Number(feet || 0));
  if (!requirementId || normalizedFeet <= 0 || requiredFeet <= 0) {
    return 0;
  }

  const summary = ensureRequirementCoverageSummary(coverage, requirementId);
  const remainingCapacity = Math.max(0, requiredFeet - Math.max(0, Number(summary.allocatedFeet || 0)));
  if (remainingCapacity <= 0) {
    return 0;
  }

  const appliedFeet = Math.min(remainingCapacity, normalizedFeet);
  summary.allocatedFeet += appliedFeet;
  if (reservationState === 'WITH_INSTALL_DATE') {
    summary.allocatedWithInstallDateFeet += appliedFeet;
  } else {
    summary.allocatedWithoutInstallDateFeet += appliedFeet;
  }

  return appliedFeet;
}

function getRequirementCoverageId(requirement, index) {
  return asTrimmedString(requirement?.id || requirement?.requirementId) || `generated-${index}`;
}

function findCoverageBoxById(boxById, boxId) {
  const normalizedBoxId = asTrimmedString(boxId);
  if (!normalizedBoxId) {
    return null;
  }

  return boxById[normalizedBoxId] || boxById[normalizedBoxId.toUpperCase()] || null;
}

/**
 * PURPOSE:
 * Computes requirement coverage only from stored allocations bound directly
 * to the same requirement and job.
 *
 * AFFECTS:
 * Job READY/FILM_ORDER status, requirement remaining LF, order amounts,
 * staging checks, and frontend optimistic cache parity.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * Supabase api-handler mirrored helper, frontend jobRequirementCoverage,
 * allocation apply/remove flows, and requirement edit behavior.
 *
 * COMMON FAILURE MODES:
 * Counting stale requirement IDs, falling back across requirements, ignoring
 * checked-out allocations, or trusting raw inventory availability.
 */
function buildAllocationCoverageByRequirementId(requirements, allocations, boxById, options = {}) {
  const coverage = {};
  const requirementById = {};
  const expectedJobNumber = normalizeJobNumberKey(options.jobNumber);

  for (let index = 0; index < requirements.length; index += 1) {
    const requirement = requirements[index];
    const requirementId = getRequirementCoverageId(requirement, index);
    requirementById[requirementId] = {
      requirement,
      requirementId,
      jobNumber: normalizeJobNumberKey(requirement.jobNumber || options.jobNumber),
      requiredFeet: Math.max(0, Number(requirement.requiredFeet || 0))
    };
  }

  for (let index = 0; index < allocations.length; index += 1) {
    const allocation = allocations[index];
    const allocationStatus = asTrimmedString(allocation.status).toUpperCase();
    const coveredFeet = getStoredAllocationCoveredFeet(allocation);
    if (
      allocationStatus === 'CANCELLED' ||
      coveredFeet <= 0 ||
      normalizeAllocationKind(allocation.allocationKind) === 'EXTRA'
    ) {
      continue;
    }

    const boundRequirementId = asTrimmedString(allocation.requirementId);
    const requirementEntry = boundRequirementId ? requirementById[boundRequirementId] : null;
    if (!requirementEntry) {
      continue;
    }

    const requirementJobNumber = expectedJobNumber || requirementEntry.jobNumber;
    if (
      requirementJobNumber &&
      normalizeJobNumberKey(allocation.jobNumber) !== requirementJobNumber
    ) {
      continue;
    }

    const box = findCoverageBoxById(boxById, allocation.boxId);
    if (!box) {
      continue;
    }

    if (shouldIgnoreAllocationCoverageForBoxStatus(allocation, box)) {
      continue;
    }

    if (!allocationMatchesRequirement(box, requirementEntry.requirement)) {
      continue;
    }

    addRequirementCoverageFeet(
      coverage,
      boundRequirementId,
      requirementEntry.requiredFeet,
      getAllocationReservationState(allocation),
      coveredFeet
    );
  }

  return coverage;
}

/**
 * PURPOSE:
 * Builds public film requirement coverage rows from stored allocations and
 * attaches planner suppression state for user-paused AUTO planning.
 *
 * AFFECTS:
 * Job detail Film Requirements, status/readiness math, Order actions, and
 * Resume auto-plan UI.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * jobsRepository requirement suppression query, Supabase Edge equivalent,
 * frontend jobRequirementCoverage, and planner suppression migration 0086.
 *
 * COMMON FAILURE MODES:
 * Stale remaining LF, backend/frontend status drift, or suppressed
 * requirements being hidden from the user.
 */
function buildPublicJobRequirementEntries(requirements, allocations, boxById) {
  const coverage = buildAllocationCoverageByRequirementId(requirements, allocations, boxById);
  const response = [];

  for (let index = 0; index < requirements.length; index += 1) {
    const requirement = requirements[index];
    const requirementId = getRequirementCoverageId(requirement, index);
    const coverageSummary = coverage[requirementId] || createEmptyRequirementCoverageSummary();
    const allocatedFeet = Math.max(0, Number(coverageSummary.allocatedFeet || 0));
    const requiredFeet = Math.max(0, Number(requirement.requiredFeet || 0));
    const remainingFeet = Math.max(0, requiredFeet - allocatedFeet);
    const cappedAllocatedFeet = requiredFeet - remainingFeet;

    response.push({
      requirementId,
      manufacturer: requirement.manufacturer,
      filmName: requirement.filmName,
      widthIn: requirement.widthIn,
      requiredFeet,
      allocatedFeet: cappedAllocatedFeet,
      allocatedWithInstallDateFeet: Math.min(
        cappedAllocatedFeet,
        Math.max(0, Number(coverageSummary.allocatedWithInstallDateFeet || 0))
      ),
      allocatedWithoutInstallDateFeet: Math.min(
        cappedAllocatedFeet,
        Math.max(0, Number(coverageSummary.allocatedWithoutInstallDateFeet || 0))
      ),
      remainingFeet,
      autoPlanningSuppressed: requirement.autoPlanningSuppressed === true
    });
  }

  response.sort((left, right) => {
    const manufacturerCompare = compareCatalogStrings(left.manufacturer, right.manufacturer);
    if (manufacturerCompare !== 0) {
      return manufacturerCompare;
    }

    const filmCompare = compareCatalogStrings(left.filmName, right.filmName);
    if (filmCompare !== 0) {
      return filmCompare;
    }

    if (left.widthIn !== right.widthIn) {
      return left.widthIn < right.widthIn ? -1 : 1;
    }

    return compareCatalogStrings(left.requirementId, right.requirementId);
  });

  return response;
}

function buildCaulkCoverageByRequirementId(caulkRequirements, caulkAllocations, options = {}) {
  const totals = {};
  const requirementById = {};
  const expectedJobNumber = normalizeJobNumberKey(options.jobNumber);
  const requirements = Array.isArray(caulkRequirements) ? caulkRequirements : [];

  for (let index = 0; index < requirements.length; index += 1) {
    const requirement = requirements[index];
    const requirementId = asTrimmedString(requirement.requirementId || requirement.id);
    if (!requirementId) {
      continue;
    }

    requirementById[requirementId] = {
      requirement,
      jobNumber: normalizeJobNumberKey(requirement.jobNumber || options.jobNumber)
    };
  }

  const allocations = Array.isArray(caulkAllocations) ? caulkAllocations : [];
  for (let index = 0; index < allocations.length; index += 1) {
    const allocation = allocations[index];
    const requirementId = asTrimmedString(allocation.requirementId);
    const requirementEntry = requirementId ? requirementById[requirementId] : null;
    if (
      !requirementEntry ||
      asTrimmedString(allocation.status).toUpperCase() === 'CANCELLED' ||
      integerOrZero(allocation.allocatedTubes) <= 0
    ) {
      continue;
    }

    const requirementJobNumber = expectedJobNumber || requirementEntry.jobNumber;
    if (
      requirementJobNumber &&
      normalizeJobNumberKey(allocation.jobNumber) !== requirementJobNumber
    ) {
      continue;
    }

    if (asTrimmedString(allocation.productId) !== asTrimmedString(requirementEntry.requirement.productId)) {
      continue;
    }

    totals[requirementId] =
      integerOrZero(totals[requirementId]) + Math.max(0, integerOrZero(allocation.allocatedTubes));
  }

  return totals;
}

function buildCaulkCoverageByProductId(caulkAllocations) {
  const totals = {};

  for (let index = 0; index < caulkAllocations.length; index += 1) {
    const entry = caulkAllocations[index];
    const productId = asTrimmedString(entry.productId);
    if (!productId || asTrimmedString(entry.status).toUpperCase() === 'CANCELLED') {
      continue;
    }

    totals[productId] = integerOrZero(totals[productId]) + Math.max(0, integerOrZero(entry.allocatedTubes));
  }

  return totals;
}

function buildPublicCaulkRequirementEntries(caulkRequirements, caulkAllocations, options = {}) {
  const coverageByRequirementId = buildCaulkCoverageByRequirementId(
    Array.isArray(caulkRequirements) ? caulkRequirements : [],
    Array.isArray(caulkAllocations) ? caulkAllocations : [],
    options
  );
  const source = Array.isArray(caulkRequirements) ? caulkRequirements : [];
  const response = [];

  for (let index = 0; index < source.length; index += 1) {
    const entry = source[index];
    const requirementId = asTrimmedString(entry.requirementId);
    const requiredTubes = Math.max(0, integerOrZero(entry.requiredTubes));
    const allocatedTubes = Math.max(
      0,
      integerOrZero(coverageByRequirementId[requirementId] || 0)
    );
    const remainingTubes = Math.max(0, requiredTubes - allocatedTubes);
    response.push({
      requirementId,
      jobNumber: asTrimmedString(entry.jobNumber),
      productId: asTrimmedString(entry.productId),
      manufacturerId: asTrimmedString(entry.manufacturerId),
      manufacturer: asTrimmedString(entry.manufacturer),
      productName: asTrimmedString(entry.productName),
      productCode: asTrimmedString(entry.productCode),
      tubesPerCase: integerOrZero(entry.tubesPerCase),
      requiredTubes,
      allocatedTubes,
      remainingTubes,
      notes: asTrimmedString(entry.notes),
      updatedAt: asTrimmedString(entry.updatedAt)
    });
  }

  response.sort((left, right) => {
    const manufacturerCompare = compareCatalogStrings(left.manufacturer, right.manufacturer);
    if (manufacturerCompare !== 0) {
      return manufacturerCompare;
    }

    const productCompare = compareCatalogStrings(left.productName, right.productName);
    if (productCompare !== 0) {
      return productCompare;
    }

    return compareCatalogStrings(left.productCode, right.productCode);
  });

  return response;
}

function summarizeCaulkRequirementCoverage(caulkRequirements) {
  let requiredTubes = 0;
  let allocatedTubes = 0;
  let remainingTubes = 0;
  const source = Array.isArray(caulkRequirements) ? caulkRequirements : [];

  for (let index = 0; index < source.length; index += 1) {
    const entry = source[index];
    requiredTubes += Math.max(0, integerOrZero(entry.requiredTubes));
    allocatedTubes += Math.max(0, integerOrZero(entry.allocatedTubes));
    remainingTubes += Math.max(0, integerOrZero(entry.remainingTubes));
  }

  return {
    requiredTubes,
    allocatedTubes,
    remainingTubes
  };
}

function resolveAllocationJobMetadata(allocations, filmOrders) {
  let installDate = '';
  let crewLeader = '';

  for (let index = 0; index < allocations.length; index += 1) {
    if (!installDate && allocations[index].installDate) {
      installDate = allocations[index].installDate;
    }

    if (!crewLeader && allocations[index].crewLeader) {
      crewLeader = allocations[index].crewLeader;
    }
  }

  for (let index = 0; index < filmOrders.length; index += 1) {
    if (!installDate && filmOrders[index].installDate) {
      installDate = filmOrders[index].installDate;
    }

    if (!crewLeader && filmOrders[index].crewLeader) {
      crewLeader = filmOrders[index].crewLeader;
    }
  }

  return { installDate, crewLeader };
}

function buildAllocationJobSummary(
  jobNumber,
  allocations,
  filmOrders,
  requirements = [],
  caulkRequirements = [],
  lifecycleStatus = 'ACTIVE',
  isLaborOnly = false,
  isStagedForPickup = false,
  fallbackInstallDate = '',
  fallbackCrewLeader = '',
  boxById = {}
) {
  const metadata = resolveAllocationJobMetadata(allocations, filmOrders);
  let hasFilmOrder = false;
  let hasFilmOnTheWay = false;
  let hasActiveAllocation = false;
  let hasCancelledRecord = false;
  let hasFulfilledRecord = false;
  let activeAllocatedFeet = 0;
  let allocatedWithInstallDateFeet = 0;
  let allocatedWithoutInstallDateFeet = 0;
  let fulfilledAllocatedFeet = 0;
  let openFilmOrderCount = 0;
  const distinctBoxes = {};
  const normalizedLifecycleStatus = normalizeJobLifecycleStatus(lifecycleStatus);
  const caulkTotals = summarizeCaulkRequirementCoverage(caulkRequirements);
  const hasMaterialRequirements = hasJobMaterialRequirements(requirements, caulkRequirements);
  const hasOrderedAllocations = hasActiveOrderedAllocations(allocations, boxById);

  for (let index = 0; index < requirements.length; index += 1) {
    allocatedWithInstallDateFeet += Math.max(0, Number(requirements[index]?.allocatedWithInstallDateFeet || 0));
    allocatedWithoutInstallDateFeet += Math.max(0, Number(requirements[index]?.allocatedWithoutInstallDateFeet || 0));
  }

  for (let index = 0; index < allocations.length; index += 1) {
    const allocation = allocations[index];
    if (allocation.boxId) {
      distinctBoxes[allocation.boxId] = true;
    }

    if (allocation.status === 'ACTIVE') {
      hasActiveAllocation = true;
      activeAllocatedFeet += getStoredAllocationCoveredFeet(allocation);
    } else if (allocation.status === 'FULFILLED') {
      hasFulfilledRecord = true;
      fulfilledAllocatedFeet += getStoredAllocationCoveredFeet(allocation);
    } else if (allocation.status === 'CANCELLED') {
      hasCancelledRecord = true;
    }
  }

  for (let index = 0; index < filmOrders.length; index += 1) {
    const filmOrder = filmOrders[index];
    if (filmOrder.status === 'FILM_ORDER') {
      hasFilmOrder = true;
      openFilmOrderCount += 1;
    } else if (filmOrder.status === 'FILM_ON_THE_WAY') {
      hasFilmOnTheWay = true;
      openFilmOrderCount += 1;
    } else if (filmOrder.status === 'FULFILLED') {
      hasFulfilledRecord = true;
    } else if (filmOrder.status === 'CANCELLED') {
      hasCancelledRecord = true;
    }
  }

  let status = 'READY';
  if (normalizedLifecycleStatus === 'CANCELLED') {
    status = 'CANCELLED';
  } else if (normalizedLifecycleStatus === 'COMPLETED') {
    status = 'COMPLETED';
  } else if (hasMaterialRequirements) {
    let hasRemainingFilm = false;
    for (let index = 0; index < requirements.length; index += 1) {
      if (Math.max(0, Number(requirements[index].remainingFeet || 0)) > 0) {
        hasRemainingFilm = true;
        break;
      }
    }

    let hasRemainingCaulk = false;
    for (let index = 0; index < caulkRequirements.length; index += 1) {
      if (Math.max(0, Number(caulkRequirements[index].remainingTubes || 0)) > 0) {
        hasRemainingCaulk = true;
        break;
      }
    }

    status = hasRemainingFilm || hasRemainingCaulk ? 'FILM_ORDER' : 'READY';
  } else if (isLaborOnly || requirements.length || caulkRequirements.length) {
    status = 'READY';
  } else if (hasFilmOrder) {
    status = 'FILM_ORDER';
  } else if (hasFilmOnTheWay) {
    status = 'FILM_ORDER';
  } else if (hasActiveAllocation) {
    status = 'READY';
  } else if (hasCancelledRecord) {
    status = 'CANCELLED';
  } else if (hasFulfilledRecord) {
    status = 'COMPLETED';
  }

  return {
    jobNumber,
    installDate: metadata.installDate || fallbackInstallDate,
    crewLeader: metadata.crewLeader || fallbackCrewLeader,
    status,
    activeAllocatedFeet,
    allocatedWithInstallDateFeet,
    allocatedWithoutInstallDateFeet,
    fulfilledAllocatedFeet,
    requiredTubes: caulkTotals.requiredTubes,
    allocatedTubes: caulkTotals.allocatedTubes,
    remainingTubes: caulkTotals.remainingTubes,
    openFilmOrderCount,
    boxCount: Object.keys(distinctBoxes).length,
    hasOrderedAllocations
  };
}

export {
  buildActiveAllocationsByBoxIndex,
  getActiveAllocationsForBox,
  getActiveAllocatedFeetForBox,
  buildJobRequirementsByLookupKey,
  stripPlanningExteriorSuffix,
  describeRequirementPlanningFilm,
  normalizeRequirementFilmKey,
  normalizeRequirementFilmFamilyKey,
  requirementFilmIsExterior,
  planningFilmCanSatisfyRequirement,
  getRequirementPlanningFilmMatch,
  getRequirementPlanningManufacturerGroupKey,
  allocationMatchesRequirement,
  getStoredAllocationCoveredFeet,
  shouldIgnoreAllocationCoverageForBoxStatus,
  compareRequirementCoveragePoolsForRequirement,
  buildAllocationCoverageByRequirementId,
  buildPublicJobRequirementEntries,
  buildCaulkCoverageByRequirementId,
  buildCaulkCoverageByProductId,
  buildPublicCaulkRequirementEntries,
  summarizeCaulkRequirementCoverage,
  resolveAllocationJobMetadata,
  buildAllocationJobSummary,
};
