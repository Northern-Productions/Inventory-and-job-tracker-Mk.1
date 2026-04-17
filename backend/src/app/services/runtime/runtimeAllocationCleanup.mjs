// Purpose: Allocation and film-order release, cancellation, and cleanup helpers.
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
import { recalculateFilmOrder } from './runtimeAllocationPlanning.mjs';
import { isUnresolvedFilmOrderStatus } from './runtimeFilmOrderSchedule.mjs';
import { getAllocationReservationState } from '../../../../../shared/domain/filmAllocationReservations.mjs';
import { deleteOrphanAutoShortageFilmOrdersForRequirement } from './runtimeAutoShortageFilmOrders.mjs';

function getRestoredAllocatableFeet(entry) {
  return getAllocationReservationState(entry) === 'WITH_INSTALL_DATE' ? integerOrZero(entry?.allocatedFeet) : 0;
}

function countFilmOrderStateEntries(entry) {
  if (Array.isArray(entry)) {
    return entry.length;
  }

  return integerOrZero(entry);
}

function buildStaleAutoShortageFilmOrderCleanupCandidates({
  jobNumber,
  requirement,
  remainingRequirementFeet,
  filmOrders,
  filmOrderLinksById = {},
  filmOrderAllocationsById = {}
}) {
  if (!requirement || integerOrZero(remainingRequirementFeet) > 0) {
    return [];
  }

  const normalizedJobNumber = normalizeJobNumberKey(jobNumber);
  const requirementKey = normalizeJobRequirementLookupKey(
    requirement.manufacturer,
    requirement.filmName,
    requirement.widthIn
  );
  const source = Array.isArray(filmOrders) ? filmOrders : [];
  const response = [];

  for (let index = 0; index < source.length; index += 1) {
    const filmOrder = source[index];
    const filmOrderId = asTrimmedString(filmOrder && filmOrder.filmOrderId);
    if (!filmOrderId) {
      continue;
    }

    if (!isUnresolvedFilmOrderStatus(filmOrder.status)) {
      continue;
    }

    if (!asTrimmedString(filmOrder.sourceBoxId)) {
      continue;
    }

    if (normalizedJobNumber && normalizeJobNumberKey(filmOrder.jobNumber) !== normalizedJobNumber) {
      continue;
    }

    if (
      normalizeJobRequirementLookupKey(
        filmOrder.manufacturer,
        filmOrder.filmName,
        filmOrder.widthIn
      ) !== requirementKey
    ) {
      continue;
    }

    if (countFilmOrderStateEntries(filmOrderLinksById[filmOrderId]) > 0) {
      continue;
    }

    if (countFilmOrderStateEntries(filmOrderAllocationsById[filmOrderId]) > 0) {
      continue;
    }

    response.push(filmOrder);
  }

  return response;
}

async function deleteStaleAutoShortageFilmOrdersForRequirement(
  client,
  orgId,
  jobNumber,
  requirement,
  remainingRequirementFeet
) {
  if (!requirement || integerOrZero(remainingRequirementFeet) > 0) {
    return [];
  }
  return deleteOrphanAutoShortageFilmOrdersForRequirement(
    client,
    orgId,
    jobNumber,
    requirement
  );
}

async function cancelJobAndReleaseAllocations(client, orgId, jobNumber, user, reason) {
  const allocations = await listAllocationsByJob(client, orgId, jobNumber);
  const activeByBoxId = {};
  let activeCount = 0;
  const filmOrders = await listFilmOrdersByJob(client, orgId, jobNumber);
  const note = asTrimmedString(reason) || 'Job cancelled.';
  let deletedFilmOrderCount = 0;

  for (let index = 0; index < allocations.length; index += 1) {
    const entry = cloneValue(allocations[index]);
    if (entry.status !== 'ACTIVE') {
      continue;
    }

    activeByBoxId[entry.boxId] = (activeByBoxId[entry.boxId] || 0) + getRestoredAllocatableFeet(entry);
    entry.status = 'CANCELLED';
    entry.resolvedAt = new Date().toISOString();
    entry.resolvedBy = asTrimmedString(user);
    entry.notes = note;
    await saveAllocationRecord(client, orgId, entry);
    activeCount += 1;
  }

  for (const boxId of Object.keys(activeByBoxId)) {
    const box = await findBoxById(client, orgId, boxId);
    if (!box || asTrimmedString(box.status).toUpperCase() === 'ZEROED' || asTrimmedString(box.status).toUpperCase() === 'RETIRED') {
      continue;
    }

    await saveBoxRecord(client, orgId, releaseAllocationFeetFromBox(box, activeByBoxId[boxId]));
  }

  for (let index = 0; index < filmOrders.length; index += 1) {
    const order = filmOrders[index];
    const filmOrderId = asTrimmedString(order.filmOrderId);
    if (!filmOrderId) {
      continue;
    }
    await deleteFilmOrderLinksByFilmOrderId(client, orgId, filmOrderId);
    await deleteFilmOrderRecord(client, orgId, filmOrderId);
    deletedFilmOrderCount += 1;
  }

  return {
    releasedAllocationCount: activeCount,
    affectedBoxCount: Object.keys(activeByBoxId).length,
    deletedFilmOrderCount
  };
}

function formatDeletedJobCleanupWarning({
  jobNumber,
  filmRequirementCount,
  caulkRequirementCount,
  releasedFilmAllocationCount,
  affectedBoxCount,
  releasedReservedCaulkTubes,
  cancelledCaulkAllocationCount,
  purgedFilmAllocationCount,
  purgedCaulkAllocationCount,
  purgedCaulkCheckoutCount,
  purgedRollHistoryCount,
  deletedFilmOrderCount
}) {
  return (
    `Deleted job ${jobNumber}. Removed ${filmRequirementCount} film requirement${filmRequirementCount === 1 ? '' : 's'} and ${caulkRequirementCount} caulk requirement${caulkRequirementCount === 1 ? '' : 's'}, ` +
    `released ${releasedFilmAllocationCount} active film allocation${releasedFilmAllocationCount === 1 ? '' : 's'} across ${affectedBoxCount} box${affectedBoxCount === 1 ? '' : 'es'} and ${releasedReservedCaulkTubes} reserved caulk tube${releasedReservedCaulkTubes === 1 ? '' : 's'} across ${cancelledCaulkAllocationCount} active caulk allocation${cancelledCaulkAllocationCount === 1 ? '' : 's'}, ` +
    `purged ${purgedFilmAllocationCount} film allocation${purgedFilmAllocationCount === 1 ? '' : 's'}, ${purgedCaulkAllocationCount} caulk allocation${purgedCaulkAllocationCount === 1 ? '' : 's'}, ${purgedCaulkCheckoutCount} caulk checkout${purgedCaulkCheckoutCount === 1 ? '' : 's'}, and ${purgedRollHistoryCount} roll history ${purgedRollHistoryCount === 1 ? 'entry' : 'entries'}, ` +
    `and deleted ${deletedFilmOrderCount} film order${deletedFilmOrderCount === 1 ? '' : 's'}.`
  );
}

async function prepareDeletedJobCleanup(client, orgId, jobNumber, user, reason) {
  const allocations = await listAllocationsByJob(client, orgId, jobNumber);
  const filmOrders = await listFilmOrdersByJob(client, orgId, jobNumber);
  const caulkCheckouts = await listCaulkJobCheckoutsByJob(client, orgId, jobNumber);
  const note = asTrimmedString(reason) || `Deleted job ${jobNumber}.`;
  const releasedFeetByBox = {};
  let releasedFilmAllocationCount = 0;
  let affectedBoxCount = 0;
  let deletedFilmOrderCount = 0;

  for (let index = 0; index < allocations.length; index += 1) {
    const entry = cloneValue(allocations[index]);
    if (entry.status !== 'ACTIVE') {
      continue;
    }

    releasedFeetByBox[entry.boxId] =
      integerOrZero(releasedFeetByBox[entry.boxId]) + getRestoredAllocatableFeet(entry);
    entry.status = 'CANCELLED';
    entry.resolvedAt = new Date().toISOString();
    entry.resolvedBy = asTrimmedString(user);
    entry.notes = note;
    await saveAllocationRecord(client, orgId, entry);
    releasedFilmAllocationCount += 1;
  }

  for (const boxId of Object.keys(releasedFeetByBox)) {
    const box = await findBoxById(client, orgId, boxId);
    if (!box || asTrimmedString(box.status).toUpperCase() === 'ZEROED' || asTrimmedString(box.status).toUpperCase() === 'RETIRED') {
      continue;
    }

    await saveBoxRecord(client, orgId, releaseAllocationFeetFromBox(box, releasedFeetByBox[boxId]));
    affectedBoxCount += 1;
  }

  for (let index = 0; index < filmOrders.length; index += 1) {
    const order = filmOrders[index];
    const filmOrderId = asTrimmedString(order.filmOrderId);
    if (!filmOrderId) {
      continue;
    }

    await deleteFilmOrderLinksByFilmOrderId(client, orgId, filmOrderId);
    await deleteFilmOrderRecord(client, orgId, filmOrderId);
    deletedFilmOrderCount += 1;
  }

  const caulkCancelResponse = await queryRow(
    client,
    `select public.api_acl_jobs_cancel_caulk_allocations($1::uuid, $2::text, $3::jsonb) as payload`,
    [
      orgId,
      asTrimmedString(user),
      JSON.stringify({
        jobNumber,
        reason: note
      })
    ]
  );
  const caulkCancelPayload =
    caulkCancelResponse && typeof caulkCancelResponse.payload === 'object'
      ? cloneValue(caulkCancelResponse.payload)
      : {};

  const purgedFilmAllocationsResult = await client.query(
    `
      delete from app.allocations
      where org_id = $1
        and upper(trim(job_number)) = upper(trim($2))
    `,
    [orgId, jobNumber]
  );
  const purgedCaulkAllocationsResult = await client.query(
    `
      delete from app.caulk_job_allocations
      where org_id = $1
        and upper(trim(job_number)) = upper(trim($2))
    `,
    [orgId, jobNumber]
  );
  const purgedRollHistoryResult = await client.query(
    `
      delete from app.roll_weight_log
      where org_id = $1
        and upper(trim(job_number)) = upper(trim($2))
    `,
    [orgId, jobNumber]
  );

  return {
    releasedFilmAllocationCount,
    affectedBoxCount,
    cancelledCaulkAllocationCount: integerOrZero(caulkCancelPayload.cancelledAllocationCount),
    releasedReservedCaulkTubes: integerOrZero(caulkCancelPayload.releasedReservedTubes),
    purgedFilmAllocationCount: integerOrZero(purgedFilmAllocationsResult.rowCount),
    purgedCaulkAllocationCount: integerOrZero(purgedCaulkAllocationsResult.rowCount),
    purgedCaulkCheckoutCount: caulkCheckouts.length,
    purgedRollHistoryCount: integerOrZero(purgedRollHistoryResult.rowCount),
    deletedFilmOrderCount
  };
}

async function removeAllocationFromJob(client, orgId, jobNumber, allocationId, user, reason) {
  const jobHeader = await findJobByNumber(client, orgId, jobNumber);
  if (jobHeader && normalizeJobLifecycleStatus(jobHeader.lifecycleStatus) !== 'ACTIVE') {
    throw new HttpError(400, `Job ${jobNumber} is closed and allocation rows cannot be removed.`);
  }

  const allocations = await listAllocationsByJob(client, orgId, jobNumber);
  const normalizedJobNumber = normalizeJobNumberKey(jobNumber);
  const normalizedAllocationId = asTrimmedString(allocationId);
  const resolvedAt = new Date().toISOString();
  let target = null;

  for (let index = 0; index < allocations.length; index += 1) {
    if (asTrimmedString(allocations[index].allocationId) === normalizedAllocationId) {
      target = allocations[index];
      break;
    }
  }

  if (!target) {
    throw new HttpError(404, `Allocation ${allocationId} was not found for job ${jobNumber}.`);
  }

  if (target.status === 'CANCELLED') {
    return {
      allocationId: target.allocationId,
      boxId: target.boxId,
      removedAllocationCount: 0,
      releasedFeet: 0
    };
  }

  const entry = cloneValue(target);
  const box = await findBoxById(client, orgId, entry.boxId);
  if (
    box &&
    box.status === 'CHECKED_OUT' &&
    normalizeJobNumberKey(box.lastCheckoutJob) === normalizedJobNumber
  ) {
    throw new HttpError(
      400,
      `Box ${entry.boxId} is checked out on job ${jobNumber} and cannot be removed until the box is checked in.`
    );
  }

  const note =
    asTrimmedString(reason) ||
    `Removed allocation ${entry.allocationId} for box ${entry.boxId} from job ${jobNumber} on allocation detail page.`;
  const releasedFeet =
    entry.status === 'ACTIVE' || entry.status === 'FULFILLED' ? getRestoredAllocatableFeet(entry) : 0;

  entry.status = 'CANCELLED';
  entry.resolvedAt = resolvedAt;
  entry.resolvedBy = asTrimmedString(user);
  entry.notes = note;
  await saveAllocationRecord(client, orgId, entry);

  if (releasedFeet > 0) {
    if (box && asTrimmedString(box.status).toUpperCase() !== 'ZEROED' && asTrimmedString(box.status).toUpperCase() !== 'RETIRED') {
      await saveBoxRecord(client, orgId, releaseAllocationFeetFromBox(box, releasedFeet));
    }
  }

  if (entry.filmOrderId) {
    await recalculateFilmOrder(client, orgId, entry.filmOrderId, user);
  }

  return {
    allocationId: entry.allocationId,
    boxId: entry.boxId,
    removedAllocationCount: 1,
    releasedFeet
  };
}

async function cancelFilmOrderAndReleaseAllocations(client, orgId, filmOrderId, user, reason) {
  const existing = await findFilmOrderById(client, orgId, filmOrderId);
  if (!existing) {
    throw new HttpError(404, 'Film Order not found.');
  }

  const allocations = await listAllocationsByFilmOrderId(client, orgId, filmOrderId);
  const activeByBoxId = {};
  let activeCount = 0;
  const resolvedAt = new Date().toISOString();
  const note = asTrimmedString(reason) || 'Film order deleted.';

  for (let index = 0; index < allocations.length; index += 1) {
    const entry = cloneValue(allocations[index]);
    if (entry.status !== 'ACTIVE') {
      continue;
    }

    activeByBoxId[entry.boxId] = (activeByBoxId[entry.boxId] || 0) + getRestoredAllocatableFeet(entry);
    entry.status = 'CANCELLED';
    entry.resolvedAt = resolvedAt;
    entry.resolvedBy = asTrimmedString(user);
    entry.notes = note;
    await saveAllocationRecord(client, orgId, entry);
    activeCount += 1;
  }

  for (const boxId of Object.keys(activeByBoxId)) {
    const box = await findBoxById(client, orgId, boxId);
    if (!box || asTrimmedString(box.status).toUpperCase() === 'ZEROED' || asTrimmedString(box.status).toUpperCase() === 'RETIRED') {
      continue;
    }

    await saveBoxRecord(client, orgId, releaseAllocationFeetFromBox(box, activeByBoxId[boxId]));
  }

  await deleteFilmOrderLinksByFilmOrderId(client, orgId, filmOrderId);
  await deleteFilmOrderRecord(client, orgId, filmOrderId);

  return {
    filmOrder: existing,
    releasedAllocationCount: activeCount,
    affectedBoxCount: Object.keys(activeByBoxId).length
  };
}

async function cancelActiveFilmOrderAllocationsForBox(client, orgId, boxId, user, reason) {
  const entries = await listAllocationsByBox(client, orgId, boxId);
  const resolvedAt = new Date().toISOString();
  const affectedFilmOrders = {};
  let count = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = cloneValue(entries[index]);
    if (entry.status !== 'ACTIVE' || !entry.filmOrderId) {
      continue;
    }

    entry.status = 'CANCELLED';
    entry.resolvedAt = resolvedAt;
    entry.resolvedBy = asTrimmedString(user);
    entry.notes = asTrimmedString(reason) || 'Cancelled because linked box state was undone.';
    await saveAllocationRecord(client, orgId, entry);
    affectedFilmOrders[entry.filmOrderId] = true;
    count += 1;
  }

  for (const filmOrderId of Object.keys(affectedFilmOrders)) {
    await recalculateFilmOrder(client, orgId, filmOrderId, user);
  }

  return count;
}

async function recalculateFilmOrdersForBoxLinks(client, orgId, boxId, user) {
  const links = await listFilmOrderLinksByBoxId(client, orgId, boxId);
  const seen = {};

  for (let index = 0; index < links.length; index += 1) {
    if (!seen[links[index].filmOrderId]) {
      seen[links[index].filmOrderId] = true;
      await recalculateFilmOrder(client, orgId, links[index].filmOrderId, user);
    }
  }
}

export {
  buildStaleAutoShortageFilmOrderCleanupCandidates,
  cancelJobAndReleaseAllocations,
  formatDeletedJobCleanupWarning,
  prepareDeletedJobCleanup,
  removeAllocationFromJob,
  cancelFilmOrderAndReleaseAllocations,
  cancelActiveFilmOrderAllocationsForBox,
  recalculateFilmOrdersForBoxLinks,
  deleteStaleAutoShortageFilmOrdersForRequirement,
};
