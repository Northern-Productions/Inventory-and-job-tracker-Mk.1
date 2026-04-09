// Purpose: Audit read/undo and film-order read runtime workflows.
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
import { cancelActiveFilmOrderAllocationsForBox, recalculateFilmOrdersForBoxLinks } from './runtimeAllocationCleanup.mjs';
import {
  getCheckoutJobNumberFromAuditNotes,
  reactivateFulfilledAllocationsForUndo,
  reactivateCancelledAllocationsForZeroUndo,
} from './runtimeCheckoutOperations.mjs';
import { enrichOpenFilmOrdersWithJobSchedule, isUnresolvedFilmOrderStatus } from './runtimeFilmOrderSchedule.mjs';
import { buildPublicFilmOrderLinkedBoxes } from './runtimeJobSummaries.mjs';

async function listAudit(client, orgId, params) {
  const from = asTrimmedString(params.from);
  const to = asTrimmedString(params.to);
  const user = asTrimmedString(params.user).toLowerCase();
  const action = asTrimmedString(params.action).toLowerCase();
  const entries = await listAuditEntries(client, orgId);
  const filtered = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const entryDate = entry.date.slice(0, 10);

    if (from && entryDate < from) {
      continue;
    }

    if (to && entryDate > to) {
      continue;
    }

    if (user && entry.user.toLowerCase().indexOf(user) === -1) {
      continue;
    }

    if (action && entry.action.toLowerCase().indexOf(action) === -1) {
      continue;
    }

    filtered.push(entry);
  }

  return filtered;
}

async function undoAudit(client, orgId, payload, actor) {
  const reason = asTrimmedString(payload.reason);
  const warnings = [];
  const auditEntry = await findAuditEntryByLogId(client, orgId, payload.logId);

  if (!auditEntry) {
    throw new HttpError(404, 'Audit entry not found.');
  }

  if (
    auditEntry.action === 'START_TRANSFER' ||
    auditEntry.action === 'RECEIVE_TRANSFER' ||
    auditEntry.action === 'CANCEL_TRANSFER'
  ) {
    throw new HttpError(
      400,
      'Transfer history cannot be undone from audit undo. Use the transfer receive or cancel actions instead.'
    );
  }

  const current = await findBoxById(client, orgId, auditEntry.boxId);
  const notes = `Undo ${auditEntry.action}${reason ? `: ${reason}` : ''}`;

  if (auditEntry.before) {
    let resultBox = cloneValue(auditEntry.before);
    resultBox = await saveBoxRecord(client, orgId, resultBox);

    if (auditEntry.action === 'SET_STATUS' && auditEntry.after && auditEntry.after.status === 'CHECKED_OUT') {
      const checkoutJobNumber = getCheckoutJobNumberFromAuditNotes(auditEntry.notes);
      if (checkoutJobNumber) {
        const reactivatedFulfilledCount = await reactivateFulfilledAllocationsForUndo(
          client,
          orgId,
          auditEntry.boxId,
          checkoutJobNumber
        );
        if (reactivatedFulfilledCount > 0) {
          warnings.push(
            `${reactivatedFulfilledCount} allocation${reactivatedFulfilledCount === 1 ? ' was' : 's were'} reactivated for job ${checkoutJobNumber}.`
          );
        }
      }
    }

    if (auditEntry.action === 'ZERO_OUT_BOX') {
      const reactivatedCancelledCount = await reactivateCancelledAllocationsForZeroUndo(
        client,
        orgId,
        auditEntry.boxId
      );
      if (reactivatedCancelledCount > 0) {
        warnings.push(
          `${reactivatedCancelledCount} zero-cancelled allocation${reactivatedCancelledCount === 1 ? ' was' : 's were'} reactivated.`
        );
      }
    }

    if (auditEntry.after && auditEntry.after.receivedDate && auditEntry.before && !auditEntry.before.receivedDate) {
      const cancelledFilmOrderAllocations = await cancelActiveFilmOrderAllocationsForBox(
        client,
        orgId,
        auditEntry.boxId,
        actor,
        'Cancelled because undo restored the box to its pre-receipt state.'
      );
      if (cancelledFilmOrderAllocations > 0) {
        warnings.push(
          `${cancelledFilmOrderAllocations} auto-allocation${cancelledFilmOrderAllocations === 1 ? ' was' : 's were'} cancelled because the linked box was reverted to pre-receipt.`
        );
      }
    }

    await recalculateFilmOrdersForBoxLinks(client, orgId, auditEntry.boxId, actor);

    const newLogId = await appendAuditEntry(
      client,
      orgId,
      'UNDO',
      auditEntry.boxId,
      current ? toPublicBox(current) : null,
      toPublicBox(resultBox),
      actor,
      notes
    );

    return ok({ box: toPublicBox(resultBox), logId: newLogId }, warnings);
  }

  if (!current) {
    throw new HttpError(400, 'Cannot undo add because the current box row is missing.');
  }

  await deleteBoxRecord(client, orgId, current.boxId);
  await cancelActiveFilmOrderAllocationsForBox(
    client,
    orgId,
    auditEntry.boxId,
    actor,
    'Cancelled because the linked box was removed by undo.'
  );
  await recalculateFilmOrdersForBoxLinks(client, orgId, auditEntry.boxId, actor);

  const newLogId = await appendAuditEntry(
    client,
    orgId,
    'UNDO_ADD_DELETE',
    auditEntry.boxId,
    toPublicBox(current),
    null,
    actor,
    notes
  );

  return ok({ box: null, logId: newLogId }, warnings);
}

async function buildFilmOrdersList(client, orgId) {
  const entries = await enrichOpenFilmOrdersWithJobSchedule(
    client,
    orgId,
    await listFilmOrders(client, orgId)
  );
  const sorted = entries.slice().sort((left, right) => {
    const leftOpen = isUnresolvedFilmOrderStatus(left.status);
    const rightOpen = isUnresolvedFilmOrderStatus(right.status);

    if (leftOpen !== rightOpen) {
      return leftOpen ? -1 : 1;
    }

    if (leftOpen) {
      return left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0;
    }

    const leftResolved = left.resolvedAt || left.createdAt;
    const rightResolved = right.resolvedAt || right.createdAt;
    return leftResolved < rightResolved ? -1 : leftResolved > rightResolved ? 1 : 0;
  });
  const response = [];

  for (let index = 0; index < sorted.length; index += 1) {
    const entry = sorted[index];
    response.push(
      toPublicFilmOrder(
        entry,
        await buildPublicFilmOrderLinkedBoxes(client, orgId, entry.filmOrderId)
      )
    );
  }

  return response;
}

async function buildFilmCatalog(client, orgId) {
  const entries = await listFilmCatalog(client, orgId);
  const dedupedByKey = {};

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const normalized = normalizeCatalogWriteManufacturerAndFilm(entry.manufacturer, entry.filmName);
    const manufacturer = normalized.manufacturer;
    const filmName = normalized.filmName;
    const manufacturerKey = normalizeCatalogManufacturerLookupKey(manufacturer);
    const filmNameKey = normalizeCatalogLookupKey(filmName);

    if (!manufacturerKey || !filmNameKey) {
      continue;
    }

    dedupedByKey[`${manufacturerKey}|${filmNameKey}`] = {
      filmKey: buildFilmKey(manufacturer, filmName),
      manufacturer,
      filmName,
      updatedAt: asTrimmedString(entry.updatedAt),
    };
  }

  const response = Object.values(dedupedByKey);
  response.sort((left, right) => {
    const manufacturerCompare = compareCatalogStrings(left.manufacturer, right.manufacturer);
    if (manufacturerCompare !== 0) {
      return manufacturerCompare;
    }

    const filmCompare = compareCatalogStrings(left.filmName, right.filmName);
    if (filmCompare !== 0) {
      return filmCompare;
    }

    return compareCatalogStrings(left.filmKey, right.filmKey);
  });

  return response;
}

export {
  listAudit,
  undoAudit,
  buildFilmOrdersList,
  buildFilmCatalog,
};
