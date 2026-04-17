// Purpose: Auto-linking and reconciliation helpers for checked-out or zeroed boxes.
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
  getActiveAllocatedFeetForBox,
  buildPublicJobRequirementEntries,
  resolveAllocationJobMetadata,
} from './runtimeAllocationCoverage.mjs';
import { buildPublicAllocationEntriesForJob } from './runtimeJobSummaries.mjs';
import { createAllocationRecord } from './runtimeAllocationPlanning.mjs';
import { getSameDayCrewConflictJobs } from '../../../../../shared/domain/sameDayCrewConflicts.mjs';

function hasNonCancelledAllocationForBoxJob(allocations, boxId, jobNumber) {
  const normalizedJobNumber = normalizeJobNumberKey(jobNumber);

  for (let index = 0; index < allocations.length; index += 1) {
    const entry = allocations[index];
    if (
      entry.status !== 'CANCELLED' &&
      entry.boxId === boxId &&
      normalizeJobNumberKey(entry.jobNumber) === normalizedJobNumber
    ) {
      return true;
    }
  }

  return false;
}

function readFeetAvailableFromAuditState(state) {
  if (!state || typeof state !== 'object') {
    return null;
  }

  const rawValue = state.feetAvailable;
  if (rawValue === null || rawValue === undefined || rawValue === '') {
    return null;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.max(0, Math.floor(parsed));
}

function resolveCheckoutSnapshotAllocationFeet(checkoutAudit, box) {
  const afterFeet = readFeetAvailableFromAuditState(checkoutAudit && checkoutAudit.after);
  if (afterFeet !== null) {
    return afterFeet;
  }

  const beforeFeet = readFeetAvailableFromAuditState(checkoutAudit && checkoutAudit.before);
  if (beforeFeet !== null) {
    return beforeFeet;
  }

  return Math.max(0, integerOrZero(box.feetAvailable));
}

function sumRemainingMatchingRequirementFeetForBox(requirements, box) {
  let total = 0;

  for (let index = 0; index < requirements.length; index += 1) {
    const requirement = requirements[index];
    if (
      !planningFilmCanSatisfyRequirement(
        box.manufacturer,
        box.filmName,
        requirement.manufacturer,
        requirement.filmName
      )
    ) {
      continue;
    }

    if ((Number(requirement.widthIn) || 0) > (Number(box.widthIn) || 0)) {
      continue;
    }

    total += Math.max(0, Number(requirement.remainingFeet || 0));
  }

  return total;
}

async function buildJobContextForAutoLinkedAllocation(client, orgId, jobNumber, allocations) {
  const normalizedJobNumber = requireString(jobNumber, 'JobNumber');
  const header = await findJobByNumber(client, orgId, normalizedJobNumber);
  const filmOrders = await listFilmOrdersByJob(client, orgId, normalizedJobNumber);
  const metadata = resolveAllocationJobMetadata(allocations, filmOrders);

  return {
    jobNumber: normalizedJobNumber,
    installDate: asTrimmedString(header?.installDate) || metadata.installDate || '',
    crewLeader: asTrimmedString(header?.crewLeader) || metadata.crewLeader || ''
  };
}

function getCheckoutCrewConflictJobs(targetJobContext, allocations) {
  return getSameDayCrewConflictJobs(targetJobContext, allocations);
}

async function listCheckoutCrewConflictJobsForBox(client, orgId, boxId, jobNumber) {
  const boxAllocations = await listAllocationsByBox(client, orgId, boxId);
  if (!boxAllocations.length) {
    return [];
  }

  const targetJobAllocations = await listAllocationsByJob(client, orgId, jobNumber);
  const targetJobContext = await buildJobContextForAutoLinkedAllocation(
    client,
    orgId,
    jobNumber,
    targetJobAllocations
  );

  return getCheckoutCrewConflictJobs(targetJobContext, boxAllocations);
}

async function autoLinkRemainingJobFeetToCheckedOutBox(client, orgId, box, jobNumber, user, mode = 'checkout') {
  const normalizedJobNumber = requireString(jobNumber, 'JobNumber');
  const availableFeet = Math.max(0, integerOrZero(box.feetAvailable));

  if (availableFeet <= 0) {
    return {
      created: false,
      allocatedFeet: 0,
      skippedReason: 'NO_AVAILABLE_FEET'
    };
  }

  const requirements = await listJobRequirementsByJob(client, orgId, normalizedJobNumber);
  if (!requirements.length) {
    return {
      created: false,
      allocatedFeet: 0,
      skippedReason: 'NO_REQUIREMENTS'
    };
  }

  const jobAllocations = await listAllocationsByJob(client, orgId, normalizedJobNumber);
  if (hasNonCancelledAllocationForBoxJob(jobAllocations, box.boxId, normalizedJobNumber)) {
    return {
      created: false,
      allocatedFeet: 0,
      skippedReason: 'ALREADY_LINKED'
    };
  }

  const allBoxes = await listBoxes(client, orgId);
  const boxById = {};
  for (let index = 0; index < allBoxes.length; index += 1) {
    boxById[allBoxes[index].boxId] = allBoxes[index];
  }

  const publicRequirements = buildPublicJobRequirementEntries(requirements, jobAllocations, boxById);
  const remainingMatchingFeet = sumRemainingMatchingRequirementFeetForBox(publicRequirements, box);
  if (remainingMatchingFeet <= 0) {
    return {
      created: false,
      allocatedFeet: 0,
      skippedReason: 'NO_MATCHING_REMAINING_REQUIREMENTS'
    };
  }

  const allocatableFeet = Math.min(availableFeet, remainingMatchingFeet);
  if (allocatableFeet <= 0) {
    return {
      created: false,
      allocatedFeet: 0,
      skippedReason: 'NO_ALLOCATABLE_FEET'
    };
  }

  const jobContext = await buildJobContextForAutoLinkedAllocation(
    client,
    orgId,
    normalizedJobNumber,
    jobAllocations
  );
  const allocation = await createAllocationRecord(
    client,
    orgId,
    box,
    jobContext,
    allocatableFeet,
    allocatableFeet,
    user,
    ''
  );

  box.feetAvailable = Math.max(availableFeet - allocatableFeet, 0);

  return {
    created: true,
    allocatedFeet: allocatableFeet,
    allocationId: allocation.allocationId,
    skippedReason: ''
  };
}

async function reconcileCheckedOutBoxAllocationLink(client, orgId, box, user) {
  if (!box || box.status !== 'CHECKED_OUT') {
    return {
      created: false,
      allocatedFeet: 0,
      skippedReason: 'NOT_CHECKED_OUT'
    };
  }

  const checkoutJobNumber = asTrimmedString(box.lastCheckoutJob);
  if (!checkoutJobNumber) {
    return {
      created: false,
      allocatedFeet: 0,
      skippedReason: 'MISSING_CHECKOUT_JOB'
    };
  }

  const jobAllocations = await listAllocationsByJob(client, orgId, checkoutJobNumber);
  if (hasNonCancelledAllocationForBoxJob(jobAllocations, box.boxId, checkoutJobNumber)) {
    return {
      created: false,
      allocatedFeet: 0,
      skippedReason: 'ALREADY_LINKED'
    };
  }

  const checkoutAudit = await findLatestCheckoutAuditEntryByBoxId(client, orgId, box.boxId);
  const snapshotFeet = resolveCheckoutSnapshotAllocationFeet(checkoutAudit, box);
  if (snapshotFeet <= 0) {
    return {
      created: false,
      allocatedFeet: 0,
      skippedReason: 'NO_CHECKOUT_SNAPSHOT_FEET'
    };
  }

  const workingBox = cloneValue(box);
  const jobContext = await buildJobContextForAutoLinkedAllocation(
    client,
    orgId,
    checkoutJobNumber,
    jobAllocations
  );

  await createAllocationRecord(
    client,
    orgId,
    workingBox,
    jobContext,
    snapshotFeet,
    snapshotFeet,
    user,
    ''
  );

  const availableBefore = Math.max(0, integerOrZero(workingBox.feetAvailable));
  const deductedFeet = Math.min(availableBefore, snapshotFeet);
  workingBox.feetAvailable = Math.max(availableBefore - deductedFeet, 0);

  await resolveAllocationsForCheckout(client, orgId, workingBox.boxId, checkoutJobNumber, user);
  await saveBoxRecord(client, orgId, workingBox);

  return {
    created: true,
    allocatedFeet: snapshotFeet,
    skippedReason: ''
  };
}

async function reconcileCheckedOutBoxAllocationLinkByBoxId(client, orgId, boxId, user) {
  const box = await findBoxById(client, orgId, boxId);
  if (!box) {
    return {
      created: false,
      allocatedFeet: 0,
      skippedReason: 'BOX_NOT_FOUND'
    };
  }

  return reconcileCheckedOutBoxAllocationLink(client, orgId, box, user);
}

async function reconcileCheckedOutBoxAllocationLinksForJob(client, orgId, jobNumber, user) {
  const normalizedJobNumber = requireString(jobNumber, 'jobNumber');
  const normalizedKey = normalizeJobNumberKey(normalizedJobNumber);
  const boxes = await listBoxes(client, orgId);

  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index];
    if (box.status !== 'CHECKED_OUT') {
      continue;
    }

    if (normalizeJobNumberKey(box.lastCheckoutJob) !== normalizedKey) {
      continue;
    }

    await reconcileCheckedOutBoxAllocationLink(client, orgId, box, user);
  }
}

async function reconcileZeroedBoxAllocationStateByBoxId(client, orgId, boxId, user) {
  const box = await findBoxById(client, orgId, boxId);
  if (!box) {
    return {
      cancelledCount: 0,
      skippedReason: 'BOX_NOT_FOUND'
    };
  }

  if (box.status !== 'ZEROED') {
    return {
      cancelledCount: 0,
      skippedReason: 'NOT_ZEROED'
    };
  }

  const cancelledCount = await cancelAllocationsForZeroedBox(client, orgId, box.boxId, user);
  return {
    cancelledCount,
    skippedReason: cancelledCount > 0 ? '' : 'NO_ALLOCATIONS_TO_CANCEL'
  };
}

async function reconcileZeroedBoxAllocationStateForJob(client, orgId, jobNumber, user) {
  const allocations = await listAllocationsByJob(client, orgId, requireString(jobNumber, 'jobNumber'));
  const boxes = await listBoxes(client, orgId);
  const boxesById = {};
  const zeroedBoxIds = {};
  let cancelledCount = 0;

  for (let index = 0; index < boxes.length; index += 1) {
    boxesById[boxes[index].boxId] = boxes[index];
  }

  for (let index = 0; index < allocations.length; index += 1) {
    const allocation = allocations[index];
    if (allocation.status === 'CANCELLED') {
      continue;
    }

    const box = boxesById[allocation.boxId];
    if (!box || box.status !== 'ZEROED' || zeroedBoxIds[box.boxId]) {
      continue;
    }

    zeroedBoxIds[box.boxId] = true;
  }

  for (const boxId of Object.keys(zeroedBoxIds)) {
    const result = await reconcileZeroedBoxAllocationStateByBoxId(client, orgId, boxId, user);
    cancelledCount += result.cancelledCount;
  }

  return {
    cancelledCount
  };
}

export {
  hasNonCancelledAllocationForBoxJob,
  readFeetAvailableFromAuditState,
  resolveCheckoutSnapshotAllocationFeet,
  sumRemainingMatchingRequirementFeetForBox,
  buildJobContextForAutoLinkedAllocation,
  getCheckoutCrewConflictJobs,
  listCheckoutCrewConflictJobsForBox,
  autoLinkRemainingJobFeetToCheckedOutBox,
  reconcileCheckedOutBoxAllocationLink,
  reconcileCheckedOutBoxAllocationLinkByBoxId,
  reconcileCheckedOutBoxAllocationLinksForJob,
  reconcileZeroedBoxAllocationStateByBoxId,
  reconcileZeroedBoxAllocationStateForJob,
};
