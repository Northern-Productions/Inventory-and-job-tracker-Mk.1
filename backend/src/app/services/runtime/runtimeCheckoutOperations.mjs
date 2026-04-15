// Purpose: Checkout, check-in, and allocation resolution runtime helpers.
import { buildFilmCheckoutActionPlan } from '../../../../../shared/checkoutSemantics.mjs';
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
  hasNonCancelledAllocationForBoxJob,
  autoLinkRemainingJobFeetToCheckedOutBox,
} from './runtimeAllocationLinks.mjs';
import {
  recalculateFilmOrder,
} from './runtimeAllocationPlanning.mjs';

async function resolveAllocationsForCheckout(client, orgId, boxId, jobNumber, user) {
  const active = (await listAllocationsByBox(client, orgId, boxId)).filter((entry) => entry.status === 'ACTIVE');
  const normalizedJobNumber = normalizeJobNumberKey(jobNumber);
  const resolvedAt = new Date().toISOString();
  const resolvedBy = asTrimmedString(user);
  const checkoutMarkerNote = `Checked out for job ${jobNumber}.`;
  // Keep legacy field names to avoid wider call-site churn; these counts now track
  // same-job allocations that stay ACTIVE so checkout coverage is preserved.
  const result = {
    fulfilledCount: 0,
    fulfilledFeet: 0,
    otherJobs: []
  };
  const otherJobs = {};

  for (let index = 0; index < active.length; index += 1) {
    const entry = cloneValue(active[index]);
    if (normalizeJobNumberKey(entry.jobNumber) === normalizedJobNumber) {
      let shouldSave = false;

      if (!entry.resolvedAt) {
        entry.resolvedAt = resolvedAt;
        shouldSave = true;
      }

      if (!entry.resolvedBy && resolvedBy) {
        entry.resolvedBy = resolvedBy;
        shouldSave = true;
      }

      if (entry.notes !== checkoutMarkerNote) {
        entry.notes = checkoutMarkerNote;
        shouldSave = true;
      }

      if (shouldSave) {
        await saveAllocationRecord(client, orgId, entry);
      }

      result.fulfilledCount += 1;
      result.fulfilledFeet += entry.allocatedFeet;
      continue;
    }

    if (entry.jobNumber && !otherJobs[entry.jobNumber]) {
      otherJobs[entry.jobNumber] = true;
      result.otherJobs.push(entry.jobNumber);
    }
  }

  return result;
}

function shouldRecalculateReceivedFeetFromState(
  existingBox,
  initialFeet,
  resolvedLastRollWeightLbs,
  resolvedCoreWeightLbs,
  resolvedLfWeightLbsPerFt,
  reactivateFromZeroed
) {
  if (!existingBox || !existingBox.receivedDate) {
    return true;
  }

  return (
    existingBox.initialFeet !== initialFeet ||
    existingBox.lastRollWeightLbs !== resolvedLastRollWeightLbs ||
    existingBox.coreWeightLbs !== resolvedCoreWeightLbs ||
    existingBox.lfWeightLbsPerFt !== resolvedLfWeightLbsPerFt ||
    reactivateFromZeroed
  );
}

function hasPositiveReactivationSignal(box) {
  return (
    integerOrZero(box?.feetAvailable) > 0 ||
    (box && box.lastRollWeightLbs !== null && Number(box.lastRollWeightLbs) > 0)
  );
}

async function checkoutBoxForJob(client, orgId, boxId, jobNumber, user) {
  const normalizedJobNumber = normalizeJobNumberDigits(jobNumber, 'JobNumber');
  const normalizedJobKey = normalizeJobNumberKey(normalizedJobNumber);
  const box = await findBoxById(client, orgId, boxId);
  if (!box) {
    throw new HttpError(404, `Box ${boxId} was not found.`);
  }

  const warnings = [];
  const jobHeader = await findJobByNumber(client, orgId, normalizedJobNumber);
  const jobWarehouse = asTrimmedString(jobHeader?.warehouse).toUpperCase();
  if (box.status === 'TRANSFER') {
    throw new HttpError(
      400,
      `Box ${box.boxId} is pending transfer and must be received before it can be checked out.`
    );
  }

  if (jobWarehouse && asTrimmedString(box.warehouse).toUpperCase() !== jobWarehouse) {
    throw new HttpError(
      400,
      `Box ${box.boxId} must be transferred from ${box.warehouse} to ${jobWarehouse} before checkout.`
    );
  }

  const isCheckedOutOnThisJob =
    box.status === 'CHECKED_OUT' && normalizeJobNumberKey(box.lastCheckoutJob) === normalizedJobKey;

  if (box.status !== 'IN_STOCK' && !isCheckedOutOnThisJob) {
    throw new HttpError(
      400,
      `Box ${box.boxId} is ${box.status || 'not in stock'} and cannot be checked out from this view.`
    );
  }

  const workingBox = cloneValue(box);
  if (box.status === 'IN_STOCK') {
    applyCheckoutWarnings(warnings, workingBox);
    workingBox.status = 'CHECKED_OUT';
    workingBox.hasEverBeenCheckedOut = true;
    workingBox.lastCheckoutJob = normalizedJobNumber;
    workingBox.lastCheckoutDate = todayDateString();
    workingBox.zeroedDate = '';
    workingBox.zeroedReason = '';
    workingBox.zeroedBy = '';

    const autoLinkResult = await autoLinkRemainingJobFeetToCheckedOutBox(
      client,
      orgId,
      workingBox,
      normalizedJobNumber,
      user,
      'checkout'
    );
    if (autoLinkResult.created) {
      warnings.push(
        `Auto-linked ${autoLinkResult.allocatedFeet} LF from ${workingBox.boxId} to job ${normalizedJobNumber} at checkout.`
      );
    } else if (autoLinkResult.skippedReason === 'NO_REQUIREMENTS') {
      warnings.push(`No job requirements were found for job ${normalizedJobNumber}, so no LF was auto-linked.`);
    }

    const allocationResolution = await resolveAllocationsForCheckout(
      client,
      orgId,
      workingBox.boxId,
      normalizedJobNumber,
      user
    );
    if (allocationResolution.fulfilledCount > 0) {
      warnings.push(
        `Kept ${allocationResolution.fulfilledCount} allocation${allocationResolution.fulfilledCount === 1 ? '' : 's'} totaling ${allocationResolution.fulfilledFeet} LF linked to job ${normalizedJobNumber} after checkout.`
      );
    }

    if (allocationResolution.otherJobs.length > 0) {
      warnings.push(`This box still has active allocations for ${allocationResolution.otherJobs.join(', ')}.`);
    }

    const savedBox = await saveBoxRecord(client, orgId, workingBox);
    return {
      box: savedBox,
      warnings,
      checkedOut: true
    };
  }

  const allocationResolution = await resolveAllocationsForCheckout(
    client,
    orgId,
    workingBox.boxId,
    normalizedJobNumber,
    user
  );
  if (allocationResolution.fulfilledCount > 0) {
    warnings.push(
      `Kept ${allocationResolution.fulfilledCount} allocation${allocationResolution.fulfilledCount === 1 ? '' : 's'} totaling ${allocationResolution.fulfilledFeet} LF linked to job ${normalizedJobNumber} after checkout.`
    );
  }

  if (allocationResolution.otherJobs.length > 0) {
    warnings.push(`This box still has active allocations for ${allocationResolution.otherJobs.join(', ')}.`);
  }

  return {
    box: workingBox,
    warnings,
    checkedOut: false
  };
}

async function checkoutCaulkAllocationForJob(client, orgId, jobNumber, caulkAllocation, user) {
  const allocation = cloneValue(caulkAllocation);
  const remaining = Math.max(0, integerOrZero(allocation.reservedTubesRemaining));
  const openCount = Math.max(0, integerOrZero(allocation.openCheckoutCount));

  if (allocation.status !== 'ACTIVE') {
    return {
      checkoutCreated: false,
      warnings: []
    };
  }

  if (remaining <= 0) {
    return {
      checkoutCreated: false,
      warnings: []
    };
  }

  if (openCount > 0) {
    throw new HttpError(
      400,
      `Caulk allocation ${allocation.caulkAllocationId} already has an open checkout and cannot be bulk checked out again until that cycle is closed.`
    );
  }

  const response = await queryRow(
    client,
    `select public.api_acl_allocations_caulk_checkout($1::uuid, $2::text, $3::jsonb) as payload`,
    [
      orgId,
      user,
      JSON.stringify({
        caulkAllocationId: allocation.caulkAllocationId,
        checkoutTubes: remaining,
        notes: `Checked out all remaining caulk for job ${jobNumber}.`
      })
    ]
  );

  const payload = response && typeof response.payload === 'object' ? cloneValue(response.payload) : null;
  const warnings = Array.isArray(payload?.warnings) ? payload.warnings.map((entry) => asTrimmedString(entry)).filter(Boolean) : [];
  return {
    checkoutCreated: true,
    warnings
  };
}

async function checkoutAllJobMaterials(client, orgId, jobNumber, user) {
  const normalizedJobNumber = normalizeJobNumberDigits(jobNumber, 'JobNumber');
  const resolvedContext = await resolveExistingOrLegacyJobHeader(
    client,
    orgId,
    normalizedJobNumber,
    user,
    new Date().toISOString()
  );
  const existingJob = resolvedContext.header;
  if (!existingJob) {
    throw new HttpError(404, `Job ${normalizedJobNumber} was not found.`);
  }

  if (normalizeJobLifecycleStatus(existingJob.lifecycleStatus) !== 'ACTIVE') {
    throw new HttpError(400, `Job ${normalizedJobNumber} is closed and checkout-all cannot be changed.`);
  }

  const allocations = resolvedContext.allocations || (await listAllocationsByJob(client, orgId, normalizedJobNumber));
  const filmOrders = resolvedContext.filmOrders || (await listFilmOrdersByJob(client, orgId, normalizedJobNumber));
  const requirements = await listJobRequirementsByJob(client, orgId, normalizedJobNumber);
  const caulkRequirements = await listJobCaulkRequirementsByJob(client, orgId, normalizedJobNumber);
  const caulkAllocations = await listCaulkJobAllocationsByJob(client, orgId, normalizedJobNumber);
  const boxes = await listBoxes(client, orgId);
  const boxById = {};
  const warnings = [];
  let checkedOutBoxCount = 0;
  let checkedOutCaulkCount = 0;

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
  const preCheckoutTransferAlerts = buildJobFilmTransferAlerts(
    existingJob.warehouse,
    allocations,
    boxById,
    pendingTransfersByBoxRecordId
  );
  if (preCheckoutTransferAlerts.length > 0) {
    throw new HttpError(400, buildFilmTransferAlertMessage(preCheckoutTransferAlerts, 'checkout'));
  }

  if (hasActiveOrderedRequirementAllocations(allocations, boxById)) {
    throw new HttpError(400, buildOrderedAllocationReceiptMessage('checkout'));
  }

  const checkoutPlan = buildFilmCheckoutActionPlan(allocations, boxById, normalizedJobNumber);

  for (let index = 0; index < checkoutPlan.length; index += 1) {
    const step = checkoutPlan[index];
    const currentBox = boxById[step.boxId];
    if (boxUsesOrderedPlanning(currentBox)) {
      continue;
    }

    const checkoutResult = await checkoutBoxForJob(
      client,
      orgId,
      step.boxId,
      normalizedJobNumber,
      user
    );
    warnings.push(...checkoutResult.warnings);
    if (checkoutResult.checkedOut) {
      checkedOutBoxCount += 1;
    }
  }

  for (let index = 0; index < caulkAllocations.length; index += 1) {
    const allocation = caulkAllocations[index];
    if (allocation.status !== 'ACTIVE') {
      continue;
    }

    const remaining = Math.max(0, integerOrZero(allocation.reservedTubesRemaining));
    const openCount = Math.max(0, integerOrZero(allocation.openCheckoutCount));
    if (remaining <= 0) {
      continue;
    }

    if (openCount > 0) {
      throw new HttpError(
        400,
        `Caulk allocation ${allocation.caulkAllocationId} already has an open checkout and cannot be bulk checked out again until that cycle is closed.`
      );
    }

    const checkoutResult = await checkoutCaulkAllocationForJob(
      client,
      orgId,
      normalizedJobNumber,
      allocation,
      user
    );
    warnings.push(...checkoutResult.warnings);
    if (checkoutResult.checkoutCreated) {
      checkedOutCaulkCount += 1;
    }
  }

  const refreshedAllocations = await listAllocationsByJob(client, orgId, normalizedJobNumber);
  const refreshedFilmOrders = await listFilmOrdersByJob(client, orgId, normalizedJobNumber);
  const refreshedRequirements = await listJobRequirementsByJob(client, orgId, normalizedJobNumber);
  const refreshedCaulkRequirements = await listJobCaulkRequirementsByJob(client, orgId, normalizedJobNumber);
  const refreshedCaulkAllocations = await listCaulkJobAllocationsByJob(client, orgId, normalizedJobNumber);
  const refreshedBoxes = await listBoxes(client, orgId);
  const refreshedBoxById = {};

  for (let index = 0; index < refreshedBoxes.length; index += 1) {
    refreshedBoxById[refreshedBoxes[index].boxId] = refreshedBoxes[index];
  }

  const publicRequirements = buildPublicJobRequirementEntries(
    refreshedRequirements,
    refreshedAllocations,
    refreshedBoxById
  );
  const publicCaulkRequirements = buildPublicCaulkRequirementEntries(
    refreshedCaulkRequirements,
    refreshedCaulkAllocations
  );
  const refreshedPendingTransfersByBoxRecordId = indexPendingBoxTransfersByBoxRecordId(
    await listPendingBoxTransfersByBoxRecordIds(
      client,
      orgId,
      refreshedBoxes.map((box) => box.id)
    )
  );
  const filmTransferAlerts = buildJobFilmTransferAlerts(
    existingJob.warehouse,
    refreshedAllocations,
    refreshedBoxById,
    refreshedPendingTransfersByBoxRecordId
  );
  const blockingReason = getJobStagingBlockingReason(
    publicRequirements,
    publicCaulkRequirements,
    refreshedAllocations,
    refreshedFilmOrders,
    refreshedCaulkAllocations,
    filmTransferAlerts,
    refreshedBoxById
  );
  if (blockingReason) {
    throw new HttpError(400, blockingReason);
  }

  if (checkedOutBoxCount > 0 || checkedOutCaulkCount > 0) {
    warnings.push(
      `Checked out ${checkedOutBoxCount} film box${checkedOutBoxCount === 1 ? '' : 'es'} and ${checkedOutCaulkCount} caulk allocation${checkedOutCaulkCount === 1 ? '' : 's'} for job ${normalizedJobNumber}.`
    );
  }

  return {
    warnings
  };
}

async function cancelActiveAllocationsForBox(client, orgId, boxId, user, reason) {
  const cancellable = (await listAllocationsByBox(client, orgId, boxId)).filter(
    (entry) => entry.status === 'ACTIVE'
  );
  const resolvedAt = new Date().toISOString();
  const trimmedReason = asTrimmedString(reason);
  const affectedFilmOrders = {};

  for (let index = 0; index < cancellable.length; index += 1) {
    const entry = cloneValue(cancellable[index]);
    entry.status = 'CANCELLED';
    entry.resolvedAt = resolvedAt;
    entry.resolvedBy = asTrimmedString(user);
    entry.notes = trimmedReason || entry.notes;
    await saveAllocationRecord(client, orgId, entry);

    if (entry.filmOrderId) {
      affectedFilmOrders[entry.filmOrderId] = true;
    }
  }

  for (const filmOrderId of Object.keys(affectedFilmOrders)) {
    await recalculateFilmOrder(client, orgId, filmOrderId, user);
  }

  return cancellable.length;
}

async function cancelActiveAllocationsForCheckInJob(client, orgId, boxId, jobNumber, user, reason = '') {
  const normalizedJobNumber = normalizeJobNumberKey(jobNumber);
  if (!normalizedJobNumber) {
    return { cancelledCount: 0, cancelledFeet: 0 };
  }

  const resolvedAt = new Date().toISOString();
  const resolvedBy = asTrimmedString(user);
  const trimmedReason = asTrimmedString(reason) || `Returned to stock during check-in for job ${jobNumber}.`;
  const affectedFilmOrders = {};
  let cancelledCount = 0;
  let cancelledFeet = 0;
  const entries = await listAllocationsByBox(client, orgId, boxId);

  for (let index = 0; index < entries.length; index += 1) {
    const entry = cloneValue(entries[index]);
    if (entry.status !== 'ACTIVE' || normalizeJobNumberKey(entry.jobNumber) !== normalizedJobNumber) {
      continue;
    }

    entry.status = 'CANCELLED';
    entry.resolvedAt = resolvedAt;
    entry.resolvedBy = resolvedBy;
    entry.notes = trimmedReason;
    await saveAllocationRecord(client, orgId, entry);

    if (entry.filmOrderId) {
      affectedFilmOrders[entry.filmOrderId] = true;
    }

    cancelledCount += 1;
    cancelledFeet += integerOrZero(entry.allocatedFeet);
  }

  for (const filmOrderId of Object.keys(affectedFilmOrders)) {
    await recalculateFilmOrder(client, orgId, filmOrderId, user);
  }

  return { cancelledCount, cancelledFeet };
}

async function cancelAllocationsForZeroedBox(client, orgId, boxId, user) {
  return cancelActiveAllocationsForBox(
    client,
    orgId,
    boxId,
    user,
    ZEROED_BOX_AUTO_CANCEL_NOTE
  );
}

async function reactivateFulfilledAllocationsForUndo(client, orgId, boxId, jobNumber) {
  const entries = await listAllocationsByBox(client, orgId, boxId);
  const checkoutMarkerNote = `Checked out for job ${jobNumber}.`;
  const legacyCheckoutNote = `Fulfilled by checkout for job ${jobNumber}.`;
  let count = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = cloneValue(entries[index]);
    if (
      (entry.status === 'ACTIVE' || entry.status === 'FULFILLED') &&
      normalizeJobNumberKey(entry.jobNumber) === normalizeJobNumberKey(jobNumber) &&
      (entry.notes === checkoutMarkerNote || entry.notes === legacyCheckoutNote)
    ) {
      entry.status = 'ACTIVE';
      entry.resolvedAt = '';
      entry.resolvedBy = '';
      entry.notes = '';
      await saveAllocationRecord(client, orgId, entry);
      count += 1;
    }
  }

  return count;
}

async function reactivateCancelledAllocationsForZeroUndo(client, orgId, boxId) {
  const entries = await listAllocationsByBox(client, orgId, boxId);
  const expectedNote = ZEROED_BOX_AUTO_CANCEL_NOTE;
  let count = 0;
  const affectedFilmOrders = {};

  for (let index = 0; index < entries.length; index += 1) {
    const entry = cloneValue(entries[index]);
    if (entry.status === 'CANCELLED' && entry.notes === expectedNote) {
      entry.status = 'ACTIVE';
      entry.resolvedAt = '';
      entry.resolvedBy = '';
      entry.notes = '';
      await saveAllocationRecord(client, orgId, entry);
      if (entry.filmOrderId) {
        affectedFilmOrders[entry.filmOrderId] = true;
      }
      count += 1;
    }
  }

  for (const filmOrderId of Object.keys(affectedFilmOrders)) {
    await recalculateFilmOrder(client, orgId, filmOrderId, '');
  }

  return count;
}

async function findLatestCheckoutAuditEntryByBoxId(client, orgId, boxId) {
  const entries = await listAuditEntriesByBox(client, orgId, boxId);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.action !== 'SET_STATUS') {
      continue;
    }

    if (entry.after && entry.after.status === 'CHECKED_OUT') {
      return entry;
    }
  }

  return null;
}

function getCheckoutJobNumberFromAuditNotes(notes) {
  const text = asTrimmedString(notes);
  const match = text.match(/^Checked out for job\s+(.+)$/i);
  return match ? asTrimmedString(match[1]) : '';
}

export {
  resolveAllocationsForCheckout,
  shouldRecalculateReceivedFeetFromState,
  hasPositiveReactivationSignal,
  checkoutBoxForJob,
  checkoutCaulkAllocationForJob,
  checkoutAllJobMaterials,
  cancelActiveAllocationsForBox,
  cancelActiveAllocationsForCheckInJob,
  cancelAllocationsForZeroedBox,
  reactivateFulfilledAllocationsForUndo,
  reactivateCancelledAllocationsForZeroUndo,
  findLatestCheckoutAuditEntryByBoxId,
  getCheckoutJobNumberFromAuditNotes,
};
