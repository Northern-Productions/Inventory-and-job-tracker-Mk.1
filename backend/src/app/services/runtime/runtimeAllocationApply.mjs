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
  parseIntegerInput,
  requireUuid,
  cloneValue,
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
  findJobById,
  saveJobRecord,
  listJobRequirements,
  listJobRequirementsByJob,
  listJobRequirementsByJobId,
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
  isRequirementComplete,
  normalizeRequirementFilmKey,
  planningFilmCanSatisfyRequirement,
} from './runtimeAllocationCoverage.mjs';
import { resolveExistingOrLegacyJobHeader } from './runtimeJobsRead.mjs';
import {
  resolveJobContext,
  buildAllocationPreviewPlan,
  calculateSelectedSuggestionAllocations,
  parseCrossWarehouseFlag,
  normalizeOptionalWarehouse,
  createAllocationRecord,
} from './runtimeAllocationPlanning.mjs';
import { buildBoxReservationMetrics } from './runtimeAllocationReservations.mjs';

async function buildPendingTransfersByBoxRecordId(client, orgId, boxes) {
  return indexPendingBoxTransfersByBoxRecordId(
    await listPendingBoxTransfersByBoxRecordIds(
      client,
      orgId,
      Array.from(
        new Set(
          (Array.isArray(boxes) ? boxes : [])
            .filter((box) => asTrimmedString(box?.status).toUpperCase() === 'TRANSFER' && box?.id)
            .map((box) => box.id)
        )
      )
    )
  );
}

/**
 * PURPOSE:
 * Loads the exact box candidate snapshot needed by allocation preview.
 *
 * AFFECTS:
 * /allocations/preview, allocation suggestion ordering, transfer eligibility,
 * and request latency for non-cross-warehouse allocation planning.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * Supabase readHandlers /allocations/preview parity, buildAllocationPreviewPlan
 * candidate filtering, pending transfer lookup, and DEV timing audit results.
 *
 * COMMON FAILURE MODES:
 * Accidentally narrowing cross-warehouse previews, using a stale/requested
 * warehouse instead of the source box warehouse, or changing suggestion order.
 */
async function loadAllocationPreviewBoxes(client, orgId, sourceBox, crossWarehouse, deps = {}) {
  const loadAllBoxes = deps.listBoxes || listBoxes;
  const loadWarehouseBoxes = deps.listBoxesByWarehouses || listBoxesByWarehouses;
  const sourceWarehouse = asTrimmedString(sourceBox?.warehouse).toUpperCase();

  if (crossWarehouse || !sourceWarehouse) {
    return loadAllBoxes(client, orgId);
  }

  return loadWarehouseBoxes(client, orgId, [sourceWarehouse]);
}

async function resolveAllocationJobWarehouse(client, orgId, payload, jobNumber, selectedJob = null, options = {}) {
  if (selectedJob) {
    const selectedWarehouse = asTrimmedString(selectedJob.warehouse).toUpperCase();
    if (selectedWarehouse) {
      return selectedWarehouse;
    }
  }

  const existingJob = await findJobByNumber(client, orgId, jobNumber);
  const existingWarehouse = asTrimmedString(existingJob?.warehouse).toUpperCase();
  if (existingWarehouse) {
    return existingWarehouse;
  }

  if (!options.requirePersistedJobWarehouse) {
    const explicitWarehouse = normalizeOptionalWarehouse(payload.jobWarehouse, 'JobWarehouse');
    if (explicitWarehouse) {
      return explicitWarehouse;
    }
  }

  return '';
}

async function resolvePreviewJobContext(client, orgId, payload, installDate) {
  const jobIdText = asTrimmedString(payload.jobId);
  if (!jobIdText) {
    return {
      job: null,
      jobId: '',
      jobContext: await resolveJobContext(
        client,
        orgId,
        payload.jobNumber,
        installDate,
        payload.crewLeader
      )
    };
  }

  const jobId = requireUuid(jobIdText, 'jobId');
  const job = await findJobById(client, orgId, jobId);
  if (!job) {
    throw new HttpError(404, 'Job was not found.');
  }

  const selectedJobNumber = requireString(job.jobNumber, 'JobNumber');
  const suppliedJobNumber = requireString(payload.jobNumber, 'JobNumber');
  if (normalizeJobNumberKey(selectedJobNumber) !== normalizeJobNumberKey(suppliedJobNumber)) {
    throw new HttpError(400, 'Job identity mismatch: selected job does not match jobNumber.');
  }

  if (normalizeJobLifecycleStatus(job.lifecycleStatus) !== 'ACTIVE') {
    throw new HttpError(400, `Job ${selectedJobNumber} is closed and cannot receive allocations.`);
  }

  const normalizedInstallDate = normalizeDateString(installDate, 'Install Date', true);
  const normalizedCrewLeader = asTrimmedString(payload.crewLeader);
  const existingInstallDate = asTrimmedString(job.installDate);
  const existingCrewLeader = asTrimmedString(job.crewLeader);

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
    job,
    jobId,
    jobContext: {
      jobId,
      jobNumber: selectedJobNumber,
      installDate: resolvedInstallDate,
      crewLeader: resolvedCrewLeader
    }
  };
}

function ensureBoxEligibleForJobAllocation(box, pendingTransfersByBoxRecordId, jobWarehouse, fallbackMessage) {
  const pendingTransfer = findPendingTransferForBox(box, pendingTransfersByBoxRecordId);
  const transferBlockReason = getTransferAllocationBlockReason(box, pendingTransfer, jobWarehouse);
  if (transferBlockReason) {
    throw new HttpError(400, transferBlockReason);
  }

  if (!isJobAllocationEligibleBox(box, pendingTransfer, jobWarehouse)) {
    throw new HttpError(400, fallbackMessage || `Box ${box?.boxId || 'this box'} is no longer allocatable.`);
  }
}

function trackActiveAllocationForCapacity(activeAllocationsByBox, allocation) {
  if (!allocation || asTrimmedString(allocation.status).toUpperCase() !== 'ACTIVE') {
    return;
  }

  const boxId = asTrimmedString(allocation.boxId);
  if (!boxId) {
    return;
  }

  if (!activeAllocationsByBox[boxId]) {
    activeAllocationsByBox[boxId] = [];
  }
  activeAllocationsByBox[boxId].push(allocation);
}

async function previewAllocationPlan(client, orgId, payload) {
  const source = await findBoxById(client, orgId, payload.boxId);
  if (!source) {
    throw new HttpError(404, 'Box not found.');
  }

  const installDate = payload.installDate !== undefined ? payload.installDate : payload.jobDate;
  const requestedCrossWarehouse = parseCrossWarehouseFlag(payload.crossWarehouse);
  const autoAllocate = parseBooleanFlag(payload.autoAllocate);
  const previewTarget = await resolvePreviewJobContext(client, orgId, payload, installDate);
  const jobContext = previewTarget.jobContext;
  const jobWarehouse = await resolveAllocationJobWarehouse(
    client,
    orgId,
    payload,
    jobContext.jobNumber,
    previewTarget.job,
    { requirePersistedJobWarehouse: autoAllocate }
  );
  if (autoAllocate && !jobWarehouse) {
    throw new HttpError(400, 'Assign a warehouse to this job before auto-allocating material.');
  }
  if (autoAllocate && asTrimmedString(source.warehouse).toUpperCase() !== jobWarehouse) {
    throw new HttpError(400, `Auto Allocate only uses material from the job warehouse (${jobWarehouse}).`);
  }

  const crossWarehouse = autoAllocate ? false : requestedCrossWarehouse;
  const allBoxes = autoAllocate && jobWarehouse
    ? await listBoxesByWarehouses(client, orgId, [jobWarehouse])
    : await loadAllocationPreviewBoxes(client, orgId, source, crossWarehouse);
  const activeAllocationsByBox = buildActiveAllocationsByBoxIndex(await listActiveAllocations(client, orgId));
  const pendingTransfersByBoxRecordId = await buildPendingTransfersByBoxRecordId(client, orgId, [
    source,
    ...allBoxes
  ]);
  ensureBoxEligibleForJobAllocation(
    source,
    pendingTransfersByBoxRecordId,
    jobWarehouse,
    'Only in-stock, ordered, or transfer boxes can be allocated.'
  );
  const requirementId = asTrimmedString(payload.requirementId);
  const jobRequirements = requirementId
    ? previewTarget.jobId
      ? await listJobRequirementsByJobId(client, orgId, previewTarget.jobId)
      : await listJobRequirementsByJob(client, orgId, jobContext.jobNumber)
    : [];
  const selectedRequirement = requirementId
    ? resolveSelectedRequirement(
        jobRequirements,
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
    jobWarehouse,
    pendingTransfersByBoxRecordId
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

  if (isRequirementComplete(selectedRequirement)) {
    throw new HttpError(400, `Requirement ${normalizedRequirementId} is complete. Reactivate it before allocating film.`);
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
  const installDate = payload.installDate !== undefined ? payload.installDate : payload.jobDate;
  const requestedCrossWarehouse = parseCrossWarehouseFlag(payload.crossWarehouse);
  const autoAllocate = parseBooleanFlag(payload.autoAllocate);
  const source = await findBoxById(client, orgId, boxId);

  if (!source) {
    throw new HttpError(404, 'Box not found.');
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

  const applyTarget = await resolvePreviewJobContext(client, orgId, payload, installDate);
  const jobContext = applyTarget.jobContext;
  const jobWarehouse = await resolveAllocationJobWarehouse(
    client,
    orgId,
    payload,
    jobContext.jobNumber,
    applyTarget.job,
    { requirePersistedJobWarehouse: autoAllocate }
  );
  if (autoAllocate && !jobWarehouse) {
    throw new HttpError(400, 'Assign a warehouse to this job before auto-allocating material.');
  }
  if (autoAllocate && asTrimmedString(source.warehouse).toUpperCase() !== jobWarehouse) {
    throw new HttpError(400, `Auto Allocate only uses material from the job warehouse (${jobWarehouse}).`);
  }

  const crossWarehouse = autoAllocate ? false : requestedCrossWarehouse;
  const allBoxes = autoAllocate && jobWarehouse
    ? await listBoxesByWarehouses(client, orgId, [jobWarehouse])
    : await listBoxes(client, orgId);
  const boxById = {};
  for (let index = 0; index < allBoxes.length; index += 1) {
    boxById[allBoxes[index].boxId] = cloneValue(allBoxes[index]);
  }
  boxById[source.boxId] = boxById[source.boxId] || cloneValue(source);

  const activeAllocationsByBox = buildActiveAllocationsByBoxIndex(await listActiveAllocations(client, orgId));
  const pendingTransfersByBoxRecordId = await buildPendingTransfersByBoxRecordId(client, orgId, [
    source,
    ...allBoxes
  ]);
  ensureBoxEligibleForJobAllocation(
    source,
    pendingTransfersByBoxRecordId,
    jobWarehouse,
    'Only in-stock, ordered, or transfer boxes can be allocated.'
  );
  const requirementId = asTrimmedString(payload.requirementId);
  if (requestedFeet > 0 && !requirementId) {
    throw new HttpError(400, 'RequirementId is required for film allocations.');
  }
  const jobRequirements =
    requirementId
      ? applyTarget.jobId
        ? await listJobRequirementsByJobId(client, orgId, applyTarget.jobId)
        : await listJobRequirementsByJob(client, orgId, jobContext.jobNumber)
      : [];
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
      jobWarehouse,
      pendingTransfersByBoxRecordId
    });
    const hasExplicitSuggestionSelection = Array.isArray(payload.selectedSuggestionBoxIds);
    const selectedSuggestionBoxIds = hasExplicitSuggestionSelection
      ? payload.selectedSuggestionBoxIds.map((value) => asTrimmedString(value)).filter(Boolean)
      : autoAllocate
        ? plan.suggestions.map((suggestion) => suggestion.boxId)
        : [];
    selection = calculateSelectedSuggestionAllocations(plan, selectedSuggestionBoxIds);
  }

  const createdAllocations = [];
  const createdAllocationRecords = [];

  for (let index = 0; index < selection.allocations.length; index += 1) {
    const plannedAllocation = selection.allocations[index];
    if (plannedAllocation.allocatedFeet <= 0) {
      continue;
    }

    const currentBox = boxById[plannedAllocation.boxId] || (await findBoxById(client, orgId, plannedAllocation.boxId));
    if (!currentBox) {
      throw new HttpError(404, `Box not found: ${plannedAllocation.boxId}`);
    }
    ensureBoxEligibleForJobAllocation(
      currentBox,
      pendingTransfersByBoxRecordId,
      jobWarehouse,
      `Box ${currentBox.boxId} is no longer allocatable.`
    );

    if (getBoxAllocationPlanningFeet(currentBox, activeAllocationsByBox) < plannedAllocation.allocatedFeet) {
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
      applyPlanningAllocationToBox(currentBox, plannedAllocation.allocatedFeet, {
        consumeAllocatableFeet: Boolean(jobContext.installDate),
      })
    );
    trackActiveAllocationForCapacity(activeAllocationsByBox, {
      ...allocation,
      allocatedFeet: plannedAllocation.allocatedFeet,
      coveredFeet: plannedAllocation.coveredFeet,
    });
    createdAllocationRecords.push(allocation);
  }

  for (let index = 0; index < requestedExtraAllocations.length; index += 1) {
    const plannedExtra = requestedExtraAllocations[index];
    const currentBox = boxById[plannedExtra.boxId] || (await findBoxById(client, orgId, plannedExtra.boxId));
    if (!currentBox) {
      throw new HttpError(404, `Box not found: ${plannedExtra.boxId}`);
    }
    ensureBoxEligibleForJobAllocation(
      currentBox,
      pendingTransfersByBoxRecordId,
      jobWarehouse,
      `Box ${currentBox.boxId} is no longer allocatable.`
    );

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

    if (getBoxAllocationPlanningFeet(currentBox, activeAllocationsByBox) < plannedExtra.allocatedFeet) {
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
      applyPlanningAllocationToBox(currentBox, plannedExtra.allocatedFeet, {
        consumeAllocatableFeet: Boolean(jobContext.installDate),
      })
    );
    trackActiveAllocationForCapacity(activeAllocationsByBox, allocation);
    createdAllocationRecords.push(allocation);
  }

  const createdAllocationBoxIds = Array.from(
    new Set(createdAllocationRecords.map((entry) => asTrimmedString(entry?.boxId)).filter(Boolean))
  );
  const reservationMetricsByBoxId = {};
  if (createdAllocationBoxIds.length > 0) {
    const jobs = await listJobs(client, orgId);
    for (let index = 0; index < createdAllocationBoxIds.length; index += 1) {
      const reservationBoxId = createdAllocationBoxIds[index];
      const reservationBox = boxById[reservationBoxId] || (await findBoxById(client, orgId, reservationBoxId));
      if (!reservationBox) {
        continue;
      }

      reservationMetricsByBoxId[reservationBoxId] = buildBoxReservationMetrics(
        reservationBox,
        await listAllocationsByBox(client, orgId, reservationBoxId),
        { jobs }
      );
    }
  }

  for (let index = 0; index < createdAllocationRecords.length; index += 1) {
    const allocation = createdAllocationRecords[index];
    const reservationSnapshot =
      reservationMetricsByBoxId[asTrimmedString(allocation?.boxId)]?.allocationSnapshotsById?.[
        asTrimmedString(allocation?.allocationId)
      ];
    createdAllocations.push({
      ...toPublicAllocation(allocation),
      backedPhysicalFeet: reservationSnapshot
        ? reservationSnapshot.backedPhysicalFeet
        : integerOrZero(allocation?.allocatedFeet),
      reservationState: reservationSnapshot
        ? reservationSnapshot.reservationState
        : (asTrimmedString(allocation?.installDate) ? 'WITH_INSTALL_DATE' : 'WITHOUT_INSTALL_DATE'),
    });
  }

  return ok(
    {
      allocations: createdAllocations,
      filmOrder: null,
      remainingUncoveredFeet: selection.remainingFeet
    },
    warnings
  );
}

export {
  loadAllocationPreviewBoxes,
  previewAllocationPlan,
  resolveSelectedRequirement,
  applyAllocationPlan,
};
