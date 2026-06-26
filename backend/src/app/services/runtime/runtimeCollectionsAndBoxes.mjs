// Purpose: Collection helpers, box payload normalization, and box search runtime helpers.
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
  listBoxesByWarehouses,
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
import { shouldRecalculateReceivedFeetFromState, hasPositiveReactivationSignal } from './runtimeCheckoutOperations.mjs';
import { applyReservationMetricsToBox } from './runtimeAllocationReservations.mjs';
import {
  allocationConsumesStoredPhysicalFeet,
} from '../../../../../shared/domain/filmAllocationReservations.mjs';

function groupEntriesByJobNumber(entries) {
  const grouped = {};

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry.jobNumber) {
      continue;
    }

    if (!grouped[entry.jobNumber]) {
      grouped[entry.jobNumber] = [];
    }

    grouped[entry.jobNumber].push(entry);
  }

  return grouped;
}

function buildRequirementRowsForReplace(jobNumber, requirementEntries, existingByKey, user, nowIso) {
  const rows = [];
  const existingRequirements = Object.values(existingByKey || {});

  for (let index = 0; index < requirementEntries.length; index += 1) {
    const requirement = requirementEntries[index];
    const phaseKey = asTrimmedString(requirement.phaseId) || asTrimmedString(requirement.phaseNumber) || 'default';
    const key = `${phaseKey}|${normalizeJobRequirementLookupKey(
      requirement.manufacturer,
      requirement.filmName,
      requirement.widthIn
    )}`;
    const requirementId = asTrimmedString(requirement.requirementId);
    const existingByRequirementId = requirementId
      ? existingRequirements.find((entry) => asTrimmedString(entry.id || entry.requirementId) === requirementId)
      : null;
    const existing = existingByRequirementId || existingByKey[key] || null;

    rows.push({
      id: existing ? existing.id : '',
      jobNumber,
      phaseId: asTrimmedString(requirement.phaseId || existing?.phaseId),
      phaseNumber: asTrimmedString(requirement.phaseNumber || existing?.phaseNumber),
      manufacturer: requirement.manufacturer,
      filmName: requirement.filmName,
      widthIn: requirement.widthIn,
      requiredFeet: requirement.requiredFeet,
      status: requirement.status || existing?.status,
      actualUsedFeet: requirement.actualUsedFeet ?? existing?.actualUsedFeet,
      completedAt: requirement.completedAt || existing?.completedAt,
      completedBy: requirement.completedBy || existing?.completedBy,
      createdAt: existing ? existing.createdAt : nowIso,
      createdBy: existing ? existing.createdBy : user,
      updatedAt: nowIso,
      updatedBy: user,
      notes: existing ? existing.notes : ''
    });
  }

  return rows;
}

async function requireActiveOwnerCompany(client, orgId, ownerCompanyId, fieldName = 'OwnerCompanyId') {
  const normalizedOwnerCompanyId = requireUuid(ownerCompanyId, fieldName);
  const row = await queryRow(
    client,
    `
      select
        id,
        code,
        display_name,
        is_active
      from app.owner_companies
      where org_id = $1::uuid
        and id = $2::uuid
      limit 1
    `,
    [orgId, normalizedOwnerCompanyId]
  );

  if (!row) {
    throw new HttpError(400, 'Owner company was not found.');
  }
  if (row.is_active !== true) {
    throw new HttpError(400, 'Owner company is inactive and cannot be selected for new inventory.');
  }
  return row;
}

async function buildBoxFromPayload(client, orgId, payload, warnings, existingBox) {
  const boxId = existingBox ? existingBox.boxId : requireString(payload.boxId, 'BoxID');
  const ownerCompanyId = existingBox
    ? asTrimmedString(existingBox.ownerCompanyId)
    : asTrimmedString(payload.ownerCompanyId);
  if (!existingBox) {
    await requireActiveOwnerCompany(client, orgId, ownerCompanyId, 'OwnerCompanyId');
  }
  const sourceManufacturer = requireString(payload.manufacturer, 'Manufacturer');
  const sourceFilmName = requireString(payload.filmName, 'FilmName');
  assertAveryNaturaShadeForWrite(sourceManufacturer, sourceFilmName, 'FilmName');
  const canonical = await resolveCatalogWriteFilmEntry(
    client,
    orgId,
    sourceManufacturer,
    sourceFilmName
  );
  const manufacturer = canonical.manufacturer;
  const filmName = canonical.filmName;
  const widthIn = coerceNonNegativeNumber(payload.widthIn, 'WidthIn');
  const initialFeet = coerceFeetValue(payload.initialFeet, 'InitialFeet', warnings, false);
  const orderDate = normalizeDateString(payload.orderDate, 'OrderDate', false);
  const receivedDate = normalizeDateString(payload.receivedDate, 'ReceivedDate', true);
  const feetAvailableInput = asTrimmedString(payload.feetAvailable);
  const hasSubmittedInitialWeightLbs = Object.prototype.hasOwnProperty.call(payload, 'initialWeightLbs');
  const hasSubmittedLastRollWeightLbs = Object.prototype.hasOwnProperty.call(payload, 'lastRollWeightLbs');
  const hasSubmittedLastWeighedDate = Object.prototype.hasOwnProperty.call(payload, 'lastWeighedDate');
  const hasSubmittedCoreType = Object.prototype.hasOwnProperty.call(payload, 'coreType');
  const hasSubmittedCurrentFeetOnRoll = Object.prototype.hasOwnProperty.call(payload, 'currentFeetOnRoll');
  const filmKey = normalizeCatalogWriteFilmKeyInput(manufacturer, filmName, payload.filmKey);
  const initialWeightInput = coerceOptionalNonNegativeNumber(payload.initialWeightLbs, 'InitialWeightLbs');
  const lastRollWeightInput = coerceOptionalNonNegativeNumber(payload.lastRollWeightLbs, 'LastRollWeightLbs');
  const lastWeighedDateInput = normalizeDateString(payload.lastWeighedDate, 'LastWeighedDate', true);
  const coreTypeInput = normalizeCoreType(payload.coreType, true);
  const currentFeetOnRollInput =
    hasSubmittedCurrentFeetOnRoll && asTrimmedString(payload.currentFeetOnRoll)
      ? coerceFeetValue(payload.currentFeetOnRoll, 'CurrentFeetOnRoll', warnings, true)
      : null;
  const existingCoreType = existingBox ? normalizeCoreType(existingBox.coreType, true) : '';
  const reactivateFromZeroed =
    payload.reactivateFromZeroed === true || String(payload.reactivateFromZeroed) === 'true';
  let feetAvailable;
  let resolvedInitialWeightLbs = initialWeightInput;
  let resolvedLastRollWeightLbs = lastRollWeightInput;
  let resolvedLastWeighedDate = lastWeighedDateInput;
  let resolvedCoreType = coreTypeInput || existingCoreType;
  let resolvedCoreWeightLbs = null;
  let resolvedLfWeightLbsPerFt = null;
  let shouldRefreshReceivingMetrics = false;
  let storedAllocatedFeet = 0;
  let usedPartialReceivingMetrics = false;

  if (!feetAvailableInput) {
    if (existingBox) {
      feetAvailable = existingBox.feetAvailable;
    } else {
      feetAvailable = deriveAddFeetAvailable(initialFeet, receivedDate);
    }
  } else {
    feetAvailable = coerceFeetValue(payload.feetAvailable, 'FeetAvailable', warnings, true);
  }

  if (existingBox && existingBox.receivedDate && !receivedDate) {
    throw new HttpError(400, 'ReceivedDate cannot be cleared after a box has been received.');
  }

  if (receivedDate) {
    if (widthIn <= 0) {
      throw new HttpError(400, 'WidthIn must be greater than zero for received boxes.');
    }

    if (initialFeet <= 0) {
      throw new HttpError(400, 'InitialFeet must be greater than zero for received boxes.');
    }

    if (existingBox) {
      const existingAllocations = await listAllocationsByBox(client, orgId, boxId);
      for (let index = 0; index < existingAllocations.length; index += 1) {
        if (allocationConsumesStoredPhysicalFeet(existingAllocations[index], existingBox)) {
          storedAllocatedFeet += existingAllocations[index].allocatedFeet;
        }
      }
    }

    shouldRefreshReceivingMetrics =
      !existingBox ||
      !existingBox.receivedDate ||
      existingBox.filmKey !== filmKey ||
      existingBox.widthIn !== widthIn ||
      existingBox.initialFeet !== initialFeet ||
      coreTypeInput !== existingCoreType ||
      initialWeightInput !== (existingBox ? existingBox.initialWeightLbs : null);

    if (shouldRefreshReceivingMetrics) {
      const filmData = await findFilmCatalogByFilmKey(client, orgId, filmKey);
      const filmDataCoreType = filmData ? normalizeCoreType(filmData.defaultCoreType, true) : '';
      const shouldRespectBlankCoreType = Boolean(existingBox && hasSubmittedCoreType && !coreTypeInput);
      const effectiveCoreType = shouldRespectBlankCoreType
        ? ''
        : coreTypeInput || filmDataCoreType || existingCoreType;

      if (filmData && filmData.sqFtWeightLbsPerSqFt !== null) {
        if (!effectiveCoreType) {
          if (!existingBox) {
            throw new HttpError(400, 'CoreType is required before this film can be received.');
          }
        }

        if (effectiveCoreType) {
          const knownSqFtWeight = coerceNonNegativeNumber(
            filmData.sqFtWeightLbsPerSqFt,
            'SqFtWeightLbsPerSqFt'
          );
          resolvedCoreType = effectiveCoreType;
          resolvedCoreWeightLbs = deriveCoreWeightLbs(effectiveCoreType, widthIn);

          if (initialWeightInput !== null) {
            const inputSqFtWeight = deriveSqFtWeightLbsPerSqFt(
              initialWeightInput,
              resolvedCoreWeightLbs,
              widthIn,
              initialFeet
            );
            resolvedLfWeightLbsPerFt = deriveLfWeightLbsPerFt(inputSqFtWeight, widthIn);
            resolvedInitialWeightLbs = roundToDecimals(initialWeightInput, 2);
          } else if (!existingBox || !hasSubmittedInitialWeightLbs) {
            resolvedLfWeightLbsPerFt = deriveLfWeightLbsPerFt(knownSqFtWeight, widthIn);
            resolvedInitialWeightLbs = deriveInitialWeightLbs(
              resolvedLfWeightLbsPerFt,
              initialFeet,
              resolvedCoreWeightLbs
            );
          }

          if (resolvedLastRollWeightLbs === null) {
            if (existingBox && !hasSubmittedLastRollWeightLbs && existingBox.lastRollWeightLbs !== null) {
              resolvedLastRollWeightLbs = existingBox.lastRollWeightLbs;
            } else if (!existingBox && resolvedInitialWeightLbs !== null) {
              resolvedLastRollWeightLbs = resolvedInitialWeightLbs;
            }
          }

          if (!resolvedLastWeighedDate) {
            if (existingBox && !hasSubmittedLastWeighedDate && existingBox.lastWeighedDate) {
              resolvedLastWeighedDate = existingBox.lastWeighedDate;
            } else if (!existingBox && resolvedLastRollWeightLbs !== null) {
              resolvedLastWeighedDate = receivedDate;
            }
          }

          if ((!existingBox || !existingBox.receivedDate) && initialWeightInput === null && !existingBox) {
            warnings.push('Initial and last roll weights were auto-filled from FILM DATA.');
          }

          const hasFullFilmCatalogMetrics =
            resolvedInitialWeightLbs !== null &&
            resolvedLastRollWeightLbs !== null &&
            resolvedCoreWeightLbs !== null &&
            resolvedLfWeightLbsPerFt !== null &&
            resolvedLfWeightLbsPerFt > 0;

          if (hasFullFilmCatalogMetrics && (!filmDataCoreType || filmDataCoreType !== effectiveCoreType)) {
            await upsertFilmCatalogRecord(client, orgId, {
              filmKey,
              manufacturer: filmData.manufacturer || manufacturer,
              filmName: filmData.filmName || filmName,
              sqFtWeightLbsPerSqFt: knownSqFtWeight,
              defaultCoreType: effectiveCoreType,
              sourceWidthIn: filmData.sourceWidthIn,
              sourceInitialFeet: filmData.sourceInitialFeet,
              sourceInitialWeightLbs: filmData.sourceInitialWeightLbs,
              updatedAt: new Date().toISOString(),
              sourceBoxId: filmData.sourceBoxId || boxId,
              notes: filmData.notes
            });
            warnings.push('FILM DATA was updated with the selected core type.');
          }
        }
      } else {
        const shouldRespectBlankInitialWeight = Boolean(
          existingBox && hasSubmittedInitialWeightLbs && initialWeightInput === null
        );
        const seedInitialWeight =
          initialWeightInput !== null
            ? initialWeightInput
            : existingBox && !shouldRespectBlankInitialWeight && existingBox.initialWeightLbs !== null
              ? existingBox.initialWeightLbs
              : null;

        if (!effectiveCoreType) {
          if (!existingBox) {
            throw new HttpError(400, 'CoreType is required the first time a received film is saved.');
          }
        }

        if (seedInitialWeight === null) {
          if (!existingBox) {
            throw new HttpError(400, 'InitialWeightLbs is required the first time a received film is saved.');
          }
        }

        if (effectiveCoreType && seedInitialWeight !== null) {
          resolvedCoreType = effectiveCoreType;
          resolvedCoreWeightLbs = deriveCoreWeightLbs(effectiveCoreType, widthIn);
          const derivedSqFtWeight = deriveSqFtWeightLbsPerSqFt(
            seedInitialWeight,
            resolvedCoreWeightLbs,
            widthIn,
            initialFeet
          );
          resolvedLfWeightLbsPerFt = deriveLfWeightLbsPerFt(derivedSqFtWeight, widthIn);
          resolvedInitialWeightLbs = roundToDecimals(seedInitialWeight, 2);

          if (resolvedLastRollWeightLbs === null) {
            if (existingBox && !hasSubmittedLastRollWeightLbs && existingBox.lastRollWeightLbs !== null) {
              resolvedLastRollWeightLbs = existingBox.lastRollWeightLbs;
            } else if (!existingBox) {
              resolvedLastRollWeightLbs = resolvedInitialWeightLbs;
            }
          }

          if (!resolvedLastWeighedDate) {
            if (existingBox && !hasSubmittedLastWeighedDate && existingBox.lastWeighedDate) {
              resolvedLastWeighedDate = existingBox.lastWeighedDate;
            } else if (!existingBox && resolvedLastRollWeightLbs !== null) {
              resolvedLastWeighedDate = receivedDate;
            }
          }

          const hasFullSeededMetrics =
            resolvedInitialWeightLbs !== null &&
            resolvedLastRollWeightLbs !== null &&
            resolvedCoreWeightLbs !== null &&
            resolvedLfWeightLbsPerFt !== null &&
            resolvedLfWeightLbsPerFt > 0;

          if (hasFullSeededMetrics) {
            await upsertFilmCatalogRecord(client, orgId, {
              filmKey,
              manufacturer,
              filmName,
              sqFtWeightLbsPerSqFt: derivedSqFtWeight,
              defaultCoreType: effectiveCoreType,
              sourceWidthIn: widthIn,
              sourceInitialFeet: initialFeet,
              sourceInitialWeightLbs: resolvedInitialWeightLbs,
              updatedAt: new Date().toISOString(),
              sourceBoxId: boxId,
              notes: ''
            });
            warnings.push(`FILM DATA was created from the first received weight for ${filmKey}.`);
          }
        }
      }
    } else {
      resolvedInitialWeightLbs =
        initialWeightInput !== null
          ? initialWeightInput
          : existingBox && !hasSubmittedInitialWeightLbs
            ? existingBox.initialWeightLbs
            : null;
      resolvedCoreType = hasSubmittedCoreType ? coreTypeInput : coreTypeInput || existingCoreType;
      resolvedCoreWeightLbs = existingBox ? existingBox.coreWeightLbs : null;
      resolvedLfWeightLbsPerFt = existingBox ? existingBox.lfWeightLbsPerFt : null;
      resolvedLastRollWeightLbs =
        resolvedLastRollWeightLbs !== null
          ? resolvedLastRollWeightLbs
          : existingBox && !hasSubmittedLastRollWeightLbs
            ? existingBox.lastRollWeightLbs
            : null;
      resolvedLastWeighedDate = resolvedLastWeighedDate
        ? resolvedLastWeighedDate
        : existingBox && !hasSubmittedLastWeighedDate
          ? existingBox.lastWeighedDate
          : '';
    }

    if (resolvedCoreType && resolvedCoreWeightLbs === null) {
      resolvedCoreWeightLbs = deriveCoreWeightLbs(resolvedCoreType, widthIn);
    }

    if (resolvedLfWeightLbsPerFt === null) {
      resolvedLfWeightLbsPerFt = deriveLfWeightLbsPerFtIfPossible(
        resolvedInitialWeightLbs,
        resolvedCoreWeightLbs,
        widthIn,
        initialFeet
      );
    }

    const hasFullReceivingMetrics =
      resolvedInitialWeightLbs !== null &&
      resolvedLastRollWeightLbs !== null &&
      resolvedCoreWeightLbs !== null &&
      resolvedLfWeightLbsPerFt !== null &&
      resolvedLfWeightLbsPerFt > 0;

    if (!hasFullReceivingMetrics && existingBox) {
      usedPartialReceivingMetrics = true;
      resolvedInitialWeightLbs =
        initialWeightInput !== null
          ? initialWeightInput
          : existingBox && !hasSubmittedInitialWeightLbs
            ? existingBox.initialWeightLbs
            : null;
      resolvedLastRollWeightLbs =
        lastRollWeightInput !== null
          ? lastRollWeightInput
          : existingBox && !hasSubmittedLastRollWeightLbs
            ? existingBox.lastRollWeightLbs
            : null;
      resolvedLastWeighedDate = lastWeighedDateInput
        ? lastWeighedDateInput
        : existingBox && !hasSubmittedLastWeighedDate
          ? existingBox.lastWeighedDate
          : '';
      resolvedCoreType = hasSubmittedCoreType ? coreTypeInput : existingCoreType;
      resolvedCoreWeightLbs = resolvedCoreType ? deriveCoreWeightLbs(resolvedCoreType, widthIn) : null;
      resolvedLfWeightLbsPerFt = deriveLfWeightLbsPerFtIfPossible(
        resolvedInitialWeightLbs,
        resolvedCoreWeightLbs,
        widthIn,
        initialFeet
      );
    }

    if (usedPartialReceivingMetrics) {
      if (currentFeetOnRollInput !== null) {
        feetAvailable = clampFeetToInitialRange(currentFeetOnRollInput - storedAllocatedFeet, initialFeet);
      } else {
        feetAvailable = clampFeetToInitialRange(existingBox?.feetAvailable ?? feetAvailable, initialFeet);
      }
    } else {
      if (resolvedLastRollWeightLbs === null) {
        throw new HttpError(
          400,
          'LastRollWeightLbs is required for received boxes because FeetAvailable is derived from roll weight.'
        );
      }

      if (
        resolvedCoreWeightLbs === null ||
        resolvedLfWeightLbsPerFt === null ||
        resolvedLfWeightLbsPerFt <= 0
      ) {
        throw new HttpError(
          400,
          'CoreWeightLbs and LfWeightLbsPerFt must be set for received boxes because FeetAvailable is derived from roll weight.'
        );
      }

      const isFirstReceipt = !existingBox || !existingBox.receivedDate;
      const shouldRecalculateReceivedFeet = shouldRecalculateReceivedFeetFromState(
        existingBox,
        initialFeet,
        resolvedLastRollWeightLbs,
        resolvedCoreWeightLbs,
        resolvedLfWeightLbsPerFt,
        reactivateFromZeroed
      );
      const physicalFeetAvailable = deriveFeetAvailableFromRollWeight(
        resolvedLastRollWeightLbs,
        resolvedCoreWeightLbs,
        resolvedLfWeightLbsPerFt,
        initialFeet
      );
      const shouldRepairStaleFeet =
        Boolean(existingBox && existingBox.receivedDate) &&
        Math.max(existingBox ? existingBox.feetAvailable : 0, 0) === 0 &&
        physicalFeetAvailable > 0;

      if (isFirstReceipt) {
        feetAvailable = Math.max(initialFeet - storedAllocatedFeet, 0);
      } else if (shouldRecalculateReceivedFeet || shouldRepairStaleFeet) {
        const recalculatedFeetAvailable = Math.max(physicalFeetAvailable - storedAllocatedFeet, 0);
        if (feetAvailable !== recalculatedFeetAvailable) {
          feetAvailable = recalculatedFeetAvailable;
          warnings.push('FeetAvailable was recalculated from Last Roll Weight and weight metadata.');
        }
      } else {
        feetAvailable = Math.min(Math.max(existingBox ? existingBox.feetAvailable : feetAvailable, 0), initialFeet);
      }
    }
  } else {
    resolvedInitialWeightLbs = null;
    resolvedLastRollWeightLbs = null;
    resolvedLastWeighedDate = '';
    resolvedCoreType = '';
    resolvedCoreWeightLbs = null;
    resolvedLfWeightLbsPerFt = null;
  }

  const hasSubmittedPricePerLf = Object.prototype.hasOwnProperty.call(payload, 'pricePerLf');
  const submittedPurchaseCost = coerceOptionalNonNegativeNumber(payload.purchaseCost, 'PurchaseCost');
  let resolvedPricePerLf = null;

  if (submittedPurchaseCost !== null) {
    if (initialFeet <= 0) {
      throw new HttpError(400, 'PurchaseCost requires InitialFeet > 0 to derive PricePerLf.');
    }
    resolvedPricePerLf = roundToDecimals(submittedPurchaseCost / initialFeet, 4);
  } else if (hasSubmittedPricePerLf) {
    resolvedPricePerLf = coerceOptionalNonNegativeNumber(payload.pricePerLf, 'PricePerLf');
  } else if (existingBox) {
    resolvedPricePerLf = existingBox.pricePerLf;
  }

  return {
    boxId,
    warehouse: await resolveWarehouseFromBoxId(client, orgId, boxId),
    ownerCompanyId,
    dealer:
      payload && Object.prototype.hasOwnProperty.call(payload, 'dealer')
        ? asTrimmedString(payload.dealer)
        : asTrimmedString(existingBox?.dealer),
    manufacturer,
    filmName,
    widthIn,
    initialFeet,
    feetAvailable,
    lotRun: asTrimmedString(payload.lotRun),
    status:
      existingBox &&
      (existingBox.status === 'CHECKED_OUT' ||
        existingBox.status === 'ZEROED' ||
        existingBox.status === 'RETIRED')
        ? existingBox.status
        : deriveLifecycleStatus(receivedDate),
    orderDate,
    receivedDate,
    initialWeightLbs: resolvedInitialWeightLbs,
    lastRollWeightLbs: resolvedLastRollWeightLbs,
    lastWeighedDate: resolvedLastWeighedDate,
    filmKey,
    coreType: resolvedCoreType,
    coreWeightLbs: resolvedCoreWeightLbs,
    lfWeightLbsPerFt: resolvedLfWeightLbsPerFt,
    pricePerLf: resolvedPricePerLf,
    purchaseCost: submittedPurchaseCost,
    notes: asTrimmedString(payload.notes),
    directToJobSite: existingBox ? existingBox.directToJobSite === true : false,
    hasLabel: existingBox ? existingBox.hasLabel !== false : false,
    hasEverBeenCheckedOut: existingBox ? existingBox.hasEverBeenCheckedOut === true : false,
    lastCheckoutJob: existingBox ? existingBox.lastCheckoutJob : '',
    lastCheckoutDate: existingBox ? existingBox.lastCheckoutDate : '',
    zeroedDate: '',
    zeroedReason: '',
    zeroedBy: ''
  };
}

async function buildSearchBoxes(client, orgId, params) {
  const configuredWarehouses = await listWarehouseCodes(client, orgId);
  const requestedWarehouseTokens = normalizeStringArrayParam([
    params?.warehouse,
    ...(Array.isArray(params?.warehouses) ? params.warehouses : [params?.warehouses])
  ]).map((entry) => asTrimmedString(entry).toUpperCase());
  const warehouseFilters =
    requestedWarehouseTokens.length === 0 || requestedWarehouseTokens.includes('ALL')
      ? [...configuredWarehouses]
      : requestedWarehouseTokens.map((entry) => normalizeWarehouseCodeFormat(entry, 'warehouse'));
  const invalidWarehouse = warehouseFilters.find((entry) => !configuredWarehouses.includes(entry));
  if (invalidWarehouse) {
    throw new HttpError(400, 'warehouse is not configured.');
  }
  const warehouseFilterSet = new Set(warehouseFilters);

  const manufacturerFilterKey = normalizeCatalogManufacturerLookupKey(params.manufacturer);
  const query = asTrimmedString(params.q).toLowerCase();
  const status = asTrimmedString(params.status).toUpperCase();
  const film = asTrimmedString(params.film).toLowerCase();
  const width = asTrimmedString(params.width);
  const showRetired = String(params.showRetired) === 'true';
  /**
   * PURPOSE:
   * Loads only the requested warehouse boxes before search/result mapping.
   *
   * AFFECTS:
   * Inventory search, offline snapshot refresh, and allocation planning box candidates.
   *
   * WHEN CHANGING THIS, ALSO CHECK:
   * Supabase Edge buildSearchBoxes, /boxes/search filters, and offline inventory sync ordering.
   *
   * COMMON FAILURE MODES:
   * Loading all org boxes for each warehouse can exceed production statement timeouts during offline refresh.
   */
  const boxes = await listBoxesByWarehouses(client, orgId, Array.from(warehouseFilterSet));
  const activeAllocations = await listActiveAllocations(client, orgId);
  const activeAllocationsByBoxId = {};
  for (let index = 0; index < activeAllocations.length; index += 1) {
    const entry = activeAllocations[index];
    if (!activeAllocationsByBoxId[entry.boxId]) {
      activeAllocationsByBoxId[entry.boxId] = [];
    }

    activeAllocationsByBoxId[entry.boxId].push(entry);
  }
  const filtered = [];

  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index];

    if (!showRetired && !status && (box.status === 'ZEROED' || box.status === 'RETIRED')) {
      continue;
    }

    if (status && box.status !== status) {
      continue;
    }

    if (
      manufacturerFilterKey &&
      normalizeCatalogManufacturerLookupKey(box.manufacturer).indexOf(manufacturerFilterKey) === -1
    ) {
      continue;
    }

    if (width && String(box.widthIn) !== width) {
      continue;
    }

    if (
      film &&
      box.filmName.toLowerCase().indexOf(film) === -1 &&
      box.manufacturer.toLowerCase().indexOf(film) === -1 &&
      box.filmKey.toLowerCase().indexOf(film) === -1
    ) {
      continue;
    }

    if (query && !matchesBoxSearchQuery(box, query)) {
      continue;
    }

    filtered.push(applyReservationMetricsToBox(box, activeAllocationsByBoxId[box.boxId] || []));
  }

  const pendingTransfersByBoxRecordId = indexPendingBoxTransfersByBoxRecordId(
    await listPendingBoxTransfersByBoxRecordIds(
      client,
      orgId,
      filtered
        .filter((box) => box.status === 'TRANSFER' && box.id)
        .map((box) => box.id)
    )
  );
  let publicBoxes = filtered.map((box) => {
    const publicBox = toPublicBox(box);
    const pendingTransfer = findPendingTransferForBox(box, pendingTransfersByBoxRecordId);
    if (!pendingTransfer || !isJobAllocationEligibleBox(box, pendingTransfer, pendingTransfer.destinationWarehouse)) {
      return publicBox;
    }

    return {
      ...publicBox,
      pendingTransfer: {
        transferId: pendingTransfer.transferId,
        status: 'PENDING',
        sourceWarehouse: pendingTransfer.sourceWarehouse,
        destinationWarehouse: pendingTransfer.destinationWarehouse
      }
    };
  });

  if (film) {
    const lowStock = [];
    const remaining = [];

    for (let index = 0; index < publicBoxes.length; index += 1) {
      if (isLowStockBox(publicBoxes[index])) {
        lowStock.push(publicBoxes[index]);
      } else {
        remaining.push(publicBoxes[index]);
      }
    }

    lowStock.sort((left, right) => {
      if (left.feetAvailable !== right.feetAvailable) {
        return left.feetAvailable - right.feetAvailable;
      }

      return left.boxId < right.boxId ? -1 : left.boxId > right.boxId ? 1 : 0;
    });

    publicBoxes = lowStock.concat(remaining);
  }

  if (query) {
    publicBoxes = rankBoxSearchCandidates(publicBoxes, query);
  }

  return publicBoxes;
}

export {
  groupEntriesByJobNumber,
  buildRequirementRowsForReplace,
  buildBoxFromPayload,
  buildSearchBoxes,
};
