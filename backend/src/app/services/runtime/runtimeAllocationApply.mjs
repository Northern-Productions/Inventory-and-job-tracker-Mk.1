// Purpose: Allocation preview and apply mutation runtime workflows.
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
  buildActiveAllocationsByBoxIndex,
  buildJobRequirementsByLookupKey,
  allocationMatchesRequirement,
  normalizeRequirementFilmKey,
  planningFilmCanSatisfyRequirement
} from './runtimeAllocationCoverage.mjs';
import { resolveExistingOrLegacyJobHeader } from './runtimeJobsRead.mjs';
import {
  resolveJobContext,
  buildAllocationPreviewPlan,
  calculateSelectedSuggestionAllocations,
  parseCrossWarehouseFlag,
  normalizeOptionalWarehouse,
  createAllocationRecord,
  createFilmOrderForShortage,
} from './runtimeAllocationPlanning.mjs';
import { buildPublicFilmOrderLinkedBoxes } from './runtimeJobSummaries.mjs';

async function previewAllocationPlan(client, orgId, payload) {
  const source = await findBoxById(client, orgId, payload.boxId);
  if (!source) {
    throw new HttpError(404, 'Box not found.');
  }

  if (!isAllocatableBoxStatus(source.status)) {
    throw new HttpError(400, 'Only in-stock or ordered boxes can be allocated.');
  }

  const crossWarehouse = parseCrossWarehouseFlag(payload.crossWarehouse);
  const allBoxes = await listBoxes(client, orgId);
  const activeAllocationsByBox = buildActiveAllocationsByBoxIndex(await listActiveAllocations(client, orgId));
  const jobContext = await resolveJobContext(
    client,
    orgId,
    payload.jobNumber,
    payload.jobDate,
    payload.crewLeader
  );
  const requirementId = asTrimmedString(payload.requirementId);
  const selectedRequirement = requirementId
    ? resolveSelectedRequirement(
        await listJobRequirementsByJob(client, orgId, jobContext.jobNumber),
        requirementId,
        source,
        jobContext.jobNumber
      )
    : null;

  return buildAllocationPreviewPlan(source, payload.requestedFeet, jobContext, {
    crossWarehouse,
    minimumWidthIn: payload.requestedWidthIn,
    allBoxes,
    activeAllocationsByBox,
    selectedRequirement,
    jobWarehouse: normalizeOptionalWarehouse(payload.jobWarehouse, 'JobWarehouse')
  });
}

function resolveSelectedRequirement(requirements, requirementId, sourceBox, jobNumber) {
  const normalizedRequirementId = asTrimmedString(requirementId);
  if (!normalizedRequirementId) {
    throw new HttpError(400, 'RequirementId is required for film allocations.');
  }

  const selectedRequirement =
    requirements.find((entry) => asTrimmedString(entry.id) === normalizedRequirementId) || null;
  if (!selectedRequirement) {
    throw new HttpError(400, `Requirement ${normalizedRequirementId} does not belong to job ${jobNumber}.`);
  }

  if (!allocationMatchesRequirement(sourceBox, selectedRequirement)) {
    throw new HttpError(
      400,
      `Box ${sourceBox.boxId} does not match requirement ${normalizedRequirementId}.`
    );
  }

  return selectedRequirement;
}

async function applyAllocationPlan(client, orgId, payload, actor) {
  const warnings = [];
  const boxId = requireString(payload.boxId, 'BoxID');
  const crossWarehouse = parseCrossWarehouseFlag(payload.crossWarehouse);
  const source = await findBoxById(client, orgId, boxId);

  if (!source) {
    throw new HttpError(404, 'Box not found.');
  }

  if (!isAllocatableBoxStatus(source.status)) {
    throw new HttpError(400, 'Only in-stock or ordered boxes can be allocated.');
  }

  const requestedFeet = coerceFeetValue(payload.requestedFeet ?? 0, 'RequestedFeet', warnings, false);
  const extraAllocationsPayload = payload.extraAllocations;
  if (extraAllocationsPayload !== undefined && !Array.isArray(extraAllocationsPayload)) {
    throw new HttpError(400, 'extraAllocations must be an array.');
  }

  const requestedExtraAllocations = [];
  const extraByBoxId = {};
  for (let index = 0; index < (Array.isArray(extraAllocationsPayload) ? extraAllocationsPayload.length : 0); index += 1) {
    const entry = extraAllocationsPayload[index];
    if (!entry || typeof entry !== 'object') {
      throw new HttpError(400, 'Each extra allocation entry must be an object.');
    }

    const extraBoxId = requireString(entry.boxId, 'extraAllocations[].boxId');
    if (extraByBoxId[extraBoxId]) {
      throw new HttpError(400, `Duplicate extra allocation entry for box ${extraBoxId}.`);
    }

    const extraFeet = coerceFeetValue(entry.allocatedFeet, `Extra LF for ${extraBoxId}`, warnings, false);
    if (extraFeet <= 0) {
      throw new HttpError(400, `Extra allocation for box ${extraBoxId} must be greater than zero.`);
    }

    extraByBoxId[extraBoxId] = true;
    requestedExtraAllocations.push({
      boxId: extraBoxId,
      allocatedFeet: extraFeet
    });
  }

  if (requestedFeet <= 0 && requestedExtraAllocations.length === 0) {
    throw new HttpError(400, 'RequestedFeet must be greater than zero unless extraAllocations are provided.');
  }

  const allBoxes = await listBoxes(client, orgId);
  const boxById = {};
  for (let index = 0; index < allBoxes.length; index += 1) {
    boxById[allBoxes[index].boxId] = cloneValue(allBoxes[index]);
  }

  const activeAllocationsByBox = buildActiveAllocationsByBoxIndex(await listActiveAllocations(client, orgId));
  const jobContext = await resolveJobContext(
    client,
    orgId,
    payload.jobNumber,
    payload.jobDate,
    payload.crewLeader
  );
  const requirementId = asTrimmedString(payload.requirementId);
  if (requestedFeet > 0 && !requirementId) {
    throw new HttpError(400, 'RequirementId is required for film allocations.');
  }
  const jobRequirements =
    requirementId ? await listJobRequirementsByJob(client, orgId, jobContext.jobNumber) : [];
  const selectedRequirement =
    requirementId
      ? resolveSelectedRequirement(jobRequirements, requirementId, source, jobContext.jobNumber)
      : null;
  const minimumWidthValue = Number(payload.requestedWidthIn);
  const minimumWidthIn = selectedRequirement
    ? Number(selectedRequirement.widthIn) || 0
    : Number.isFinite(minimumWidthValue) && minimumWidthValue > 0
      ? minimumWidthValue
      : source.widthIn;
  if (source.widthIn < minimumWidthIn) {
    throw new HttpError(400, 'Source box width must meet or exceed the requested width.');
  }
  let selection = {
    allocations: [],
    remainingFeet: 0
  };
  if (requestedFeet > 0) {
    const plan = buildAllocationPreviewPlan(source, requestedFeet, jobContext, {
      crossWarehouse,
      minimumWidthIn,
      allBoxes,
      activeAllocationsByBox,
      selectedRequirement,
      jobWarehouse: normalizeOptionalWarehouse(payload.jobWarehouse, 'JobWarehouse')
    });
    const selectedSuggestionBoxIds = Array.isArray(payload.selectedSuggestionBoxIds)
      ? payload.selectedSuggestionBoxIds.map((value) => asTrimmedString(value))
      : plan.suggestions.map((suggestion) => suggestion.boxId);
    selection = calculateSelectedSuggestionAllocations(plan, selectedSuggestionBoxIds);
  }

  const createdAllocations = [];

  for (let index = 0; index < selection.allocations.length; index += 1) {
    const plannedAllocation = selection.allocations[index];
    if (plannedAllocation.allocatedFeet <= 0) {
      continue;
    }

    const currentBox = boxById[plannedAllocation.boxId] || (await findBoxById(client, orgId, plannedAllocation.boxId));
    if (!currentBox) {
      throw new HttpError(404, `Box not found: ${plannedAllocation.boxId}`);
    }

    if (!isAllocatableBoxStatus(currentBox.status)) {
      throw new HttpError(400, `Box ${currentBox.boxId} is no longer allocatable.`);
    }

    if (getBoxAllocationPlanningFeet(currentBox) < plannedAllocation.allocatedFeet) {
      throw new HttpError(400, `Box ${currentBox.boxId} no longer has enough planning LF.`);
    }

    const allocation = await createAllocationRecord(
      client,
      orgId,
      currentBox,
      jobContext,
      plannedAllocation.allocatedFeet,
      plannedAllocation.coveredFeet,
      actor,
      '',
      'REQUIREMENT',
      selectedRequirement ? selectedRequirement.id : ''
    );
    boxById[currentBox.boxId] = await saveBoxRecord(
      client,
      orgId,
      applyPlanningAllocationToBox(currentBox, plannedAllocation.allocatedFeet)
    );
    createdAllocations.push(toPublicAllocation(allocation));
  }

  for (let index = 0; index < requestedExtraAllocations.length; index += 1) {
    const plannedExtra = requestedExtraAllocations[index];
    const currentBox = boxById[plannedExtra.boxId] || (await findBoxById(client, orgId, plannedExtra.boxId));
    if (!currentBox) {
      throw new HttpError(404, `Box not found: ${plannedExtra.boxId}`);
    }

    if (!isAllocatableBoxStatus(currentBox.status)) {
      throw new HttpError(400, `Box ${currentBox.boxId} is no longer allocatable.`);
    }

    if (selectedRequirement) {
      if (
        !planningFilmCanSatisfyRequirement(
          currentBox.manufacturer,
          currentBox.filmName,
          selectedRequirement.manufacturer,
          selectedRequirement.filmName
        )
      ) {
        throw new HttpError(
          400,
          `Extra box ${currentBox.boxId} must use a compatible film for requirement ${selectedRequirement.id}.`
        );
      }
    } else if (
      normalizeRequirementFilmKey(currentBox.manufacturer, currentBox.filmName) !==
      normalizeRequirementFilmKey(source.manufacturer, source.filmName)
    ) {
      throw new HttpError(
        400,
        `Extra box ${currentBox.boxId} must match the source box film (${source.manufacturer} ${source.filmName}).`
      );
    }

    if (currentBox.widthIn < minimumWidthIn) {
      throw new HttpError(400, `Extra box ${currentBox.boxId} must meet or exceed ${minimumWidthIn}" width.`);
    }

    if (getBoxAllocationPlanningFeet(currentBox) < plannedExtra.allocatedFeet) {
      throw new HttpError(400, `Box ${currentBox.boxId} no longer has enough planning LF.`);
    }

    const allocation = await createAllocationRecord(
      client,
      orgId,
      currentBox,
      jobContext,
      plannedExtra.allocatedFeet,
      plannedExtra.allocatedFeet,
      actor,
      '',
      'EXTRA'
    );
    boxById[currentBox.boxId] = await saveBoxRecord(
      client,
      orgId,
      applyPlanningAllocationToBox(currentBox, plannedExtra.allocatedFeet)
    );
    createdAllocations.push(toPublicAllocation(allocation));
  }

  let publicFilmOrder = null;
  if (requestedFeet > 0 && selection.remainingFeet > 0) {
    const filmOrder = await createFilmOrderForShortage(
      client,
      orgId,
      source,
      selectedRequirement,
      jobContext,
      requestedFeet,
      selection.remainingFeet,
      minimumWidthIn,
      actor,
      normalizeOptionalWarehouse(payload.jobWarehouse, 'JobWarehouse')
    );
    publicFilmOrder = filmOrder
      ? toPublicFilmOrder(filmOrder, await buildPublicFilmOrderLinkedBoxes(client, orgId, filmOrder.filmOrderId))
      : null;

    if (filmOrder) {
      warnings.push(
        `Film Order ${filmOrder.filmOrderId} was created for the remaining ${selection.remainingFeet} LF.`
      );
    }
  }

  return ok(
    {
      allocations: createdAllocations,
      filmOrder: publicFilmOrder,
      remainingUncoveredFeet: selection.remainingFeet
    },
    warnings
  );
}

export {
  previewAllocationPlan,
  resolveSelectedRequirement,
  applyAllocationPlan,
};
