// Purpose: Allocation preview, film-order recalculation, and shortage planning helpers.
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
  getActiveAllocationsForBox,
  allocationMatchesRequirement,
  normalizeRequirementFilmKey,
  getRequirementPlanningFilmMatch,
  requirementFilmIsExterior,
} from './runtimeAllocationCoverage.mjs';

async function resolveJobContext(client, orgId, jobNumber, jobDate, crewLeader) {
  const normalizedJobNumber = requireString(jobNumber, 'JobNumber');
  const normalizedJobDate = normalizeDateString(jobDate, 'JobDate', true);
  const normalizedCrewLeader = asTrimmedString(crewLeader);
  const existingHeader = await findJobByNumber(client, orgId, normalizedJobNumber);
  if (existingHeader && normalizeJobLifecycleStatus(existingHeader.lifecycleStatus) !== 'ACTIVE') {
    throw new HttpError(400, `Job ${normalizedJobNumber} is closed and cannot receive allocations.`);
  }
  const existingAllocations = await listAllocationsByJob(client, orgId, normalizedJobNumber);
  const existingFilmOrders = await listFilmOrdersByJob(client, orgId, normalizedJobNumber);
  let existingJobDate = existingHeader?.dueDate || '';
  let existingCrewLeader = existingHeader?.crewLeader || '';

  for (let index = 0; index < existingAllocations.length; index += 1) {
    if (!existingJobDate && existingAllocations[index].jobDate) {
      existingJobDate = existingAllocations[index].jobDate;
    }

    if (!existingCrewLeader && existingAllocations[index].crewLeader) {
      existingCrewLeader = existingAllocations[index].crewLeader;
    }
  }

  for (let index = 0; index < existingFilmOrders.length; index += 1) {
    if (!existingJobDate && existingFilmOrders[index].jobDate) {
      existingJobDate = existingFilmOrders[index].jobDate;
    }

    if (!existingCrewLeader && existingFilmOrders[index].crewLeader) {
      existingCrewLeader = existingFilmOrders[index].crewLeader;
    }
  }

  if (existingJobDate && normalizedJobDate && existingJobDate !== normalizedJobDate) {
    throw new HttpError(400, 'JobDate must stay the same for an existing Job Number.');
  }

  if (
    existingCrewLeader &&
    normalizedCrewLeader &&
    normalizeCrewLeaderKey(existingCrewLeader) !== normalizeCrewLeaderKey(normalizedCrewLeader)
  ) {
    throw new HttpError(400, 'CrewLeader must stay the same for an existing Job Number.');
  }

  const resolvedJobDate = normalizedJobDate || existingJobDate;
  const resolvedCrewLeader = normalizedCrewLeader || existingCrewLeader;

  if (resolvedJobDate && !resolvedCrewLeader) {
    throw new HttpError(400, 'CrewLeader is required when JobDate is set.');
  }

  return {
    jobNumber: normalizedJobNumber,
    jobDate: resolvedJobDate,
    crewLeader: resolvedCrewLeader
  };
}

function getDateConflictJobsForBox(boxId, jobContext, activeAllocationsByBox) {
  if (!jobContext.jobDate) {
    return [];
  }

  const active = getActiveAllocationsForBox(boxId, activeAllocationsByBox);
  const conflicts = [];
  const seen = {};

  for (let index = 0; index < active.length; index += 1) {
    const entry = active[index];
    if (
      entry.jobDate !== jobContext.jobDate ||
      normalizeJobNumberKey(entry.jobNumber) === normalizeJobNumberKey(jobContext.jobNumber)
    ) {
      continue;
    }

    if (normalizeCrewLeaderKey(entry.crewLeader) === normalizeCrewLeaderKey(jobContext.crewLeader)) {
      continue;
    }

    if (!seen[entry.jobNumber]) {
      seen[entry.jobNumber] = true;
      conflicts.push(entry.jobNumber);
    }
  }

  return conflicts;
}

function buildAllocationPreviewPlan(sourceBox, requestedFeet, jobContext, options) {
  const requested = coerceFeetValue(requestedFeet, 'RequestedFeet', [], true);
  if (requested <= 0) {
    throw new HttpError(400, 'RequestedFeet must be greater than zero.');
  }

  const useCrossWarehouse = options && options.crossWarehouse === true;
  const selectedRequirement = options && options.selectedRequirement ? options.selectedRequirement : null;
  const preferredWarehouse = asTrimmedString(options && options.jobWarehouse).toUpperCase();
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
    if (
      candidate.boxId === sourceBox.boxId ||
      !isAllocatableBoxStatus(candidate.status) ||
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
      filmMatch
    });
  }

  filteredCandidates.sort((leftEntry, rightEntry) => {
    const left = leftEntry.candidate;
    const right = rightEntry.candidate;
    const leftStatusRank = boxUsesOrderedPlanning(left) ? 1 : 0;
    const rightStatusRank = boxUsesOrderedPlanning(right) ? 1 : 0;
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
    jobDate: jobContext.jobDate,
    crewLeader: jobContext.crewLeader,
    requestedFeet: requested,
    requestedWidthIn: minimumWidthIn,
    sourceBoxId: sourceBox.boxId,
    sourceWarehouse: sourceBox.warehouse,
    sourceWidthIn: sourceBox.widthIn,
    sourceBoxFeetAvailable: sourceBox.feetAvailable,
    sourceBoxPlanningFeet: sourcePlanningFeet,
    sourceBoxStatus: sourceBox.status,
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
  requirementId = ''
) {
  const jobId = await getOrResolveJobId(client, orgId, jobContext.jobNumber);
  return saveAllocationRecord(client, orgId, {
    allocationId: createLogId(),
    boxId: box.boxId,
    warehouse: box.warehouse,
    jobId,
    jobNumber: jobContext.jobNumber,
    jobDate: jobContext.jobDate,
    allocatedFeet,
    coveredFeet: integerOrZero(coveredFeet) || allocatedFeet,
    requirementId: asTrimmedString(requirementId),
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    createdBy: asTrimmedString(user),
    resolvedAt: '',
    resolvedBy: '',
    notes: '',
    crewLeader: jobContext.crewLeader,
    filmOrderId: asTrimmedString(filmOrderId),
    allocationKind: normalizeAllocationKind(allocationKind)
  });
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
  const links = await listFilmOrderLinksByFilmOrderId(client, orgId, filmOrderId);
  let total = 0;

  for (let index = 0; index < links.length; index += 1) {
    const box = await findBoxById(client, orgId, links[index].boxId);
    if (box) {
      total += links[index].orderedFeet;
    }
  }

  return total;
}

async function recalculateFilmOrder(client, orgId, filmOrderId, user) {
  const existing = await findFilmOrderById(client, orgId, filmOrderId);
  if (!existing) {
    return null;
  }

  const updated = cloneValue(existing);
  updated.coveredFeet = await sumFilmOrderCoveredFeet(client, orgId, filmOrderId);
  updated.orderedFeet = await sumFilmOrderOrderedFeet(client, orgId, filmOrderId);
  updated.remainingToOrderFeet = Math.max(updated.requestedFeet - updated.orderedFeet, 0);

  if (updated.status !== 'CANCELLED') {
    if (updated.coveredFeet >= updated.requestedFeet) {
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
  if (shortageFeet <= 0) {
    return null;
  }

  const resolvedWarehouse = asTrimmedString(shortageWarehouse).toUpperCase() || sourceBox.warehouse;
  const jobId = await getOrResolveJobId(client, orgId, jobContext.jobNumber);

  return saveFilmOrderRecord(client, orgId, {
    filmOrderId: createLogId(),
    jobId,
    jobNumber: jobContext.jobNumber,
    warehouse: resolvedWarehouse,
    manufacturer: selectedRequirement ? selectedRequirement.manufacturer : sourceBox.manufacturer,
    filmName: selectedRequirement ? selectedRequirement.filmName : sourceBox.filmName,
    widthIn: Number(shortageWidthIn) > 0
      ? Number(shortageWidthIn)
      : selectedRequirement
        ? Number(selectedRequirement.widthIn) || sourceBox.widthIn
        : sourceBox.widthIn,
    requestedFeet: shortageFeet,
    coveredFeet: 0,
    orderedFeet: 0,
    remainingToOrderFeet: shortageFeet,
    jobDate: jobContext.jobDate,
    crewLeader: jobContext.crewLeader,
    status: 'FILM_ORDER',
    sourceBoxId: sourceBox.boxId,
    createdAt: new Date().toISOString(),
    createdBy: asTrimmedString(user),
    resolvedAt: '',
    resolvedBy: '',
    notes: `Created from a shortage while trying to allocate ${requestedFeet} LF.`
  });
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
    orderedFeet: box.initialFeet,
    autoAllocatedFeet: 0,
    createdAt: new Date().toISOString(),
    createdBy: asTrimmedString(user)
  });

  return recalculateFilmOrder(client, orgId, existing.filmOrderId, user);
}

async function processLinkedFilmOrderReceipt(client, orgId, box, user, warnings) {
  const links = await listFilmOrderLinksByBoxId(client, orgId, box.boxId);
  const recalculatedOrders = {};

  if (!box.receivedDate || box.status !== 'IN_STOCK' || box.feetAvailable <= 0) {
    return box;
  }

  for (let index = 0; index < links.length; index += 1) {
    const link = cloneValue(links[index]);
    const filmOrder = await findFilmOrderById(client, orgId, link.filmOrderId);
    if (!filmOrder || filmOrder.status === 'CANCELLED' || filmOrder.status === 'FULFILLED') {
      continue;
    }

    const remainingNeed = Math.max(filmOrder.requestedFeet - filmOrder.coveredFeet, 0);
    const linkCapacity = Math.max(link.orderedFeet - link.autoAllocatedFeet, 0);
    const allocationFeet = Math.min(remainingNeed, linkCapacity, box.feetAvailable);

    if (allocationFeet <= 0) {
      continue;
    }

    await createAllocationRecord(
      client,
      orgId,
      box,
      {
        jobNumber: filmOrder.jobNumber,
        jobDate: filmOrder.jobDate,
        crewLeader: filmOrder.crewLeader
      },
      allocationFeet,
      allocationFeet,
      user,
      filmOrder.filmOrderId
    );

    box.feetAvailable = Math.max(box.feetAvailable - allocationFeet, 0);
    link.autoAllocatedFeet += allocationFeet;
    await saveFilmOrderLinkRecord(client, orgId, link);
    warnings.push(
      `${allocationFeet} LF from ${box.boxId} was automatically allocated to job ${filmOrder.jobNumber} for Film Order ${filmOrder.filmOrderId}.`
    );
    recalculatedOrders[filmOrder.filmOrderId] = true;
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
  createAllocationRecord,
  sumFilmOrderCoveredFeet,
  sumFilmOrderOrderedFeet,
  recalculateFilmOrder,
  createFilmOrderForShortage,
  linkBoxToFilmOrder,
  processLinkedFilmOrderReceipt,
};
