// Purpose: Job list, search, calendar, detail, and staging read helpers.
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
import { buildJobFilmTransferAlerts, buildPublicJobUsageEntries, buildPublicJobUsageTimelineEntries } from './runtimeTransferUsage.mjs';
import { buildPublicJobRequirementEntries, buildPublicCaulkRequirementEntries } from './runtimeAllocationCoverage.mjs';
import { buildJobListEntry, buildLegacyJobHeaderFromData, deriveJobStatusFromLegacyAllocationData, buildPublicAllocationEntriesForJob, buildPublicFilmOrdersForJob, getJobStagingBlockingReason } from './runtimeJobSummaries.mjs';
import { checkoutAllJobMaterials } from './runtimeCheckoutOperations.mjs';
import { groupEntriesByJobNumber } from './runtimeCollectionsAndBoxes.mjs';
import {
  buildJobDetailPayload,
  loadJobDetailContext,
  loadJobDetailContextWithPooledReads,
} from './runtimeJobDetails.mjs';

async function buildJobsList(client, orgId, limit, lifecycleStatus, jobNumbers = []) {
  const lifecycleFilter = normalizeJobLifecycleFilter(lifecycleStatus);
  const normalizedJobNumberFilters = normalizeStringArrayParam(jobNumbers);
  const jobNumberFilterSet = normalizedJobNumberFilters.length
    ? new Set(normalizedJobNumberFilters)
    : null;
  const jobs = await listJobs(client, orgId);
  const allAllocations = await listAllocations(client, orgId);
  const allFilmOrders = await listFilmOrders(client, orgId);
  const allRequirements = await listJobRequirements(client, orgId);
  const allCaulkRequirements = await listJobCaulkRequirements(client, orgId);
  const allCaulkAllocations = await listCaulkJobAllocations(client, orgId);
  const allBoxes = await listBoxes(client, orgId);
  const groupedAllocations = groupEntriesByJobNumber(allAllocations);
  const groupedFilmOrders = groupEntriesByJobNumber(allFilmOrders);
  const groupedRequirements = groupEntriesByJobNumber(allRequirements);
  const groupedCaulkRequirements = groupEntriesByJobNumber(allCaulkRequirements);
  const groupedCaulkAllocations = groupEntriesByJobNumber(allCaulkAllocations);
  const byJobNumber = {};
  const boxById = {};
  const response = [];

  for (let index = 0; index < allBoxes.length; index += 1) {
    boxById[allBoxes[index].boxId] = allBoxes[index];
  }

  for (let index = 0; index < jobs.length; index += 1) {
    if (jobNumberFilterSet && !jobNumberFilterSet.has(jobs[index].jobNumber)) {
      continue;
    }
    byJobNumber[jobs[index].jobNumber] = jobs[index];
  }

  for (let index = 0; index < allAllocations.length; index += 1) {
    if (allAllocations[index].jobNumber) {
      if (jobNumberFilterSet && !jobNumberFilterSet.has(allAllocations[index].jobNumber)) {
        continue;
      }
      byJobNumber[allAllocations[index].jobNumber] =
        byJobNumber[allAllocations[index].jobNumber] || null;
    }
  }

  for (let index = 0; index < allFilmOrders.length; index += 1) {
    if (allFilmOrders[index].jobNumber) {
      if (jobNumberFilterSet && !jobNumberFilterSet.has(allFilmOrders[index].jobNumber)) {
        continue;
      }
      byJobNumber[allFilmOrders[index].jobNumber] =
        byJobNumber[allFilmOrders[index].jobNumber] || null;
    }
  }

  for (let index = 0; index < allCaulkRequirements.length; index += 1) {
    if (allCaulkRequirements[index].jobNumber) {
      if (jobNumberFilterSet && !jobNumberFilterSet.has(allCaulkRequirements[index].jobNumber)) {
        continue;
      }
      byJobNumber[allCaulkRequirements[index].jobNumber] =
        byJobNumber[allCaulkRequirements[index].jobNumber] || null;
    }
  }

  for (let index = 0; index < allCaulkAllocations.length; index += 1) {
    if (allCaulkAllocations[index].jobNumber) {
      if (jobNumberFilterSet && !jobNumberFilterSet.has(allCaulkAllocations[index].jobNumber)) {
        continue;
      }
      byJobNumber[allCaulkAllocations[index].jobNumber] =
        byJobNumber[allCaulkAllocations[index].jobNumber] || null;
    }
  }

  const jobNumberKeys = Object.keys(byJobNumber);
  for (let index = 0; index < jobNumberKeys.length; index += 1) {
    const jobNumber = jobNumberKeys[index];
    const allocations = groupedAllocations[jobNumber] || [];
    const filmOrders = groupedFilmOrders[jobNumber] || [];
    const requirements = buildPublicJobRequirementEntries(
      groupedRequirements[jobNumber] || [],
      allocations,
      boxById
    );
    const publicCaulkRequirements = buildPublicCaulkRequirementEntries(
      groupedCaulkRequirements[jobNumber] || [],
      groupedCaulkAllocations[jobNumber] || []
    );
    const header = byJobNumber[jobNumber] || buildLegacyJobHeaderFromData(jobNumber, allocations, filmOrders);

    const entry = buildJobListEntry(
      header,
      requirements,
      allocations,
      filmOrders,
      allAllocations,
      publicCaulkRequirements,
      boxById
    );

    if (lifecycleFilter && entry.lifecycleStatus !== lifecycleFilter) {
      continue;
    }
    if (lifecycleFilter === 'COMPLETED' && entry.status !== 'COMPLETED') {
      continue;
    }

    response.push(entry);
  }

  response.sort(compareJobsListEntries);

  if (limit > 0 && response.length > limit) {
    return response.slice(0, limit);
  }

  return response;
}

async function buildJobsSearchResults(client, orgId, query, limit, lifecycleStatus) {
  const normalizedQueryDigits = extractJobNumberDigitsForSearch(query);
  if (!normalizedQueryDigits) {
    return [];
  }

  const lifecycleFilter = normalizeJobLifecycleFilter(lifecycleStatus) || 'ACTIVE';
  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 25;
  const entries = await buildJobsList(client, orgId, 0, lifecycleFilter);
  return rankJobNumberSearchCandidates(entries, normalizedQueryDigits, {
    compareWithinMatch: compareJobsListEntries,
    limit: normalizedLimit
  });
}

function normalizeCalendarMonth(value) {
  const month = asTrimmedString(value);
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new HttpError(400, 'month must use yyyy-mm.');
  }

  return month;
}

function normalizeCalendarView(value) {
  const normalized = asTrimmedString(value).toLowerCase();
  if (!normalized || normalized === 'month') {
    return 'month';
  }

  if (normalized === 'week') {
    return 'week';
  }

  throw new HttpError(400, 'view must be week or month.');
}

function parseCalendarDate(value) {
  const match = asTrimmedString(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const dayOfMonth = Number(match[3]);
  const parsed = new Date(year, monthIndex, dayOfMonth);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== monthIndex ||
    parsed.getDate() !== dayOfMonth
  ) {
    return null;
  }

  return parsed;
}

function formatCalendarDate(date) {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function normalizeCalendarAnchorDate(anchorDate, monthFallback) {
  const parsedAnchorDate = parseCalendarDate(anchorDate);
  if (parsedAnchorDate) {
    return formatCalendarDate(parsedAnchorDate);
  }

  const month = asTrimmedString(monthFallback);
  if (month) {
    return `${normalizeCalendarMonth(month)}-01`;
  }

  throw new HttpError(400, 'anchorDate must use yyyy-mm-dd.');
}

function shiftCalendarDate(anchorDate, deltaDays) {
  const parsedAnchorDate = parseCalendarDate(anchorDate);
  if (!parsedAnchorDate) {
    throw new HttpError(400, 'anchorDate must use yyyy-mm-dd.');
  }

  return formatCalendarDate(
    new Date(
      parsedAnchorDate.getFullYear(),
      parsedAnchorDate.getMonth(),
      parsedAnchorDate.getDate() + deltaDays
    )
  );
}

function getCalendarWeekStart(anchorDate) {
  const parsedAnchorDate = parseCalendarDate(anchorDate);
  if (!parsedAnchorDate) {
    throw new HttpError(400, 'anchorDate must use yyyy-mm-dd.');
  }

  return formatCalendarDate(
    new Date(
      parsedAnchorDate.getFullYear(),
      parsedAnchorDate.getMonth(),
      parsedAnchorDate.getDate() - parsedAnchorDate.getDay()
    )
  );
}

async function buildJobsCalendar(client, orgId, view, anchorDate, month, lifecycleStatus) {
  const normalizedView = normalizeCalendarView(view);
  const normalizedAnchorDate = normalizeCalendarAnchorDate(anchorDate, month);
  const lifecycleFilter = normalizeJobLifecycleFilter(lifecycleStatus) || 'ACTIVE';
  const entries = await buildJobsList(client, orgId, 0, lifecycleFilter);
  if (normalizedView === 'week') {
    const weekStart = getCalendarWeekStart(normalizedAnchorDate);
    const weekEnd = shiftCalendarDate(weekStart, 6);
    return entries.filter((entry) => {
      const installDate = asTrimmedString(entry.installDate);
      return /^\d{4}-\d{2}-\d{2}$/.test(installDate) && installDate >= weekStart && installDate <= weekEnd;
    });
  }

  const normalizedMonth = normalizedAnchorDate.slice(0, 7);
  return entries.filter((entry) => asTrimmedString(entry.installDate).slice(0, 7) === normalizedMonth);
}

async function buildJobDetail(client, orgId, jobNumber) {
  return buildJobDetailPayload(await loadJobDetailContext(client, orgId, jobNumber));
}

async function buildReadJobDetail(orgId, jobNumber) {
  return buildJobDetailPayload(await loadJobDetailContextWithPooledReads(orgId, jobNumber));
}

async function setJobStagedPickup(client, orgId, jobNumber, isStagedForPickup, actor, payload = {}) {
  const normalizedJobNumber = normalizeJobNumberDigits(jobNumber, 'JobNumber');
  const warnings = [];
  const normalizedFlag = typeof isStagedForPickup === 'boolean'
    ? String(isStagedForPickup)
    : asTrimmedString(isStagedForPickup).toLowerCase();
  let nextIsStaged = null;

  if (normalizedFlag === 'true' || normalizedFlag === 't' || normalizedFlag === '1' || normalizedFlag === 'yes' || normalizedFlag === 'on') {
    nextIsStaged = true;
  } else if (
    normalizedFlag === 'false' ||
    normalizedFlag === 'f' ||
    normalizedFlag === '0' ||
    normalizedFlag === 'no' ||
    normalizedFlag === 'off'
  ) {
    nextIsStaged = false;
  }

  if (nextIsStaged === null) {
    throw new HttpError(400, 'isStagedForPickup must be true or false.');
  }

  const nowIso = new Date().toISOString();
  const resolvedContext = await resolveExistingOrLegacyJobHeader(client, orgId, normalizedJobNumber, actor, nowIso);
  const existingJob = resolvedContext.header;
  if (!existingJob) {
    throw new HttpError(404, `Job ${normalizedJobNumber} was not found.`);
  }

  if (normalizeJobLifecycleStatus(existingJob.lifecycleStatus) !== 'ACTIVE') {
    throw new HttpError(400, `Job ${normalizedJobNumber} is closed and staged pickup cannot be changed.`);
  }

  if (nextIsStaged) {
    const autoCheckoutRemaining = payload.autoCheckoutRemaining === true || String(payload.autoCheckoutRemaining) === 'true';

    if (autoCheckoutRemaining) {
      const checkoutResult = await checkoutAllJobMaterials(client, orgId, normalizedJobNumber, actor);
      if (checkoutResult && Array.isArray(checkoutResult.warnings)) {
        for (let index = 0; index < checkoutResult.warnings.length; index += 1) {
          const warning = asTrimmedString(checkoutResult.warnings[index]);
          if (warning) {
            warnings.push(warning);
          }
        }
      }
    }

    const allocations = await listAllocationsByJob(client, orgId, normalizedJobNumber);
    const filmOrders = await listFilmOrdersByJob(client, orgId, normalizedJobNumber);
    const requirements = await listJobRequirementsByJob(client, orgId, normalizedJobNumber);
    const caulkRequirements = await listJobCaulkRequirementsByJob(client, orgId, normalizedJobNumber);
    const caulkAllocations = await listCaulkJobAllocationsByJob(client, orgId, normalizedJobNumber);
    const boxes = await listBoxes(client, orgId);
    const boxById = {};

    for (let index = 0; index < boxes.length; index += 1) {
      boxById[boxes[index].boxId] = boxes[index];
    }

    const publicRequirements = buildPublicJobRequirementEntries(requirements, allocations, boxById);
    const publicCaulkRequirements = buildPublicCaulkRequirementEntries(caulkRequirements, caulkAllocations);
    const pendingTransfersByBoxRecordId = indexPendingBoxTransfersByBoxRecordId(
      await listPendingBoxTransfersByBoxRecordIds(
        client,
        orgId,
        boxes.map((box) => box.id)
      )
    );
    const filmTransferAlerts = buildJobFilmTransferAlerts(
      existingJob.warehouse,
      allocations,
      boxById,
      pendingTransfersByBoxRecordId
    );
    const blockingReason = getJobStagingBlockingReason(
      publicRequirements,
      publicCaulkRequirements,
      allocations,
      filmOrders,
      caulkAllocations,
      filmTransferAlerts,
      boxById
    );

    if (blockingReason) {
      throw new HttpError(400, blockingReason);
    }
  }

  const row = await queryRow(
    client,
    `
      update app.jobs
      set
        is_staged_for_pickup = $3,
        updated_at = $4::timestamptz,
        updated_by = $5
      where org_id = $1
        and upper(trim(job_number)) = upper(trim($2))
      returning *
    `,
    [
      orgId,
      normalizedJobNumber,
      nextIsStaged,
      nowIso,
      actor
    ]
  );

  if (!row) {
    return null;
  }

  const savedJob = mapDbJobRow(row);
  return {
    jobNumber: savedJob.jobNumber,
    isStagedForPickup: savedJob.isStagedForPickup,
    updatedAt: savedJob.updatedAt,
    warnings
  };
}

async function ensureJobHeaderForUpdate(client, orgId, jobNumber, payload, user, nowIso) {
  const existing = await findJobByNumber(client, orgId, jobNumber);
  if (existing) {
    return existing;
  }

  const legacyAllocations = await listAllocationsByJob(client, orgId, jobNumber);
  const legacyFilmOrders = await listFilmOrdersByJob(client, orgId, jobNumber);
  const derived = buildLegacyJobHeaderFromData(jobNumber, legacyAllocations, legacyFilmOrders);

  derived.warehouse = payload.warehouse ? normalizeJobWarehouse(payload.warehouse) : derived.warehouse;
  derived.sections = normalizeJobSections(payload.sections);
  derived.installDate = normalizeDateString(
    payload.installDate !== undefined ? payload.installDate : payload.dueDate,
    'Install Date',
    true
  );
  derived.crewLeader =
    payload.crewLeader !== undefined ? asTrimmedString(payload.crewLeader) : derived.crewLeader;
  derived.lifecycleStatus = normalizeJobLifecycleStatus(payload.lifecycleStatus);
  derived.createdAt = derived.createdAt || nowIso;
  derived.createdBy = derived.createdBy || user;
  derived.updatedAt = nowIso;
  derived.updatedBy = user;
  derived.isLaborOnly = false;
  derived.isStagedForPickup = false;
  derived.notes = asTrimmedString(payload.notes || derived.notes);

  return saveJobRecord(client, orgId, derived);
}

async function resolveExistingOrLegacyJobHeader(client, orgId, jobNumber, actor, nowIso) {
  const existing = await findJobByNumber(client, orgId, jobNumber);
  if (existing) {
    return {
      header: existing,
      allocations: null,
      filmOrders: null
    };
  }

  const allocations = await listAllocationsByJob(client, orgId, jobNumber);
  const filmOrders = await listFilmOrdersByJob(client, orgId, jobNumber);
  const requirements = await listJobRequirementsByJob(client, orgId, jobNumber);
  if (!allocations.length && !filmOrders.length && !requirements.length) {
    return {
      header: null,
      allocations,
      filmOrders
    };
  }

  const derived = buildLegacyJobHeaderFromData(jobNumber, allocations, filmOrders);
  const legacyStatus = deriveJobStatusFromLegacyAllocationData(allocations, filmOrders);
  if (legacyStatus === 'CANCELLED') {
    derived.lifecycleStatus = 'CANCELLED';
  } else if (legacyStatus === 'COMPLETED') {
    derived.lifecycleStatus = 'COMPLETED';
  } else {
    derived.lifecycleStatus = 'ACTIVE';
  }
  derived.createdAt = derived.createdAt || nowIso;
  derived.createdBy = derived.createdBy || actor;
  derived.updatedAt = nowIso;
  derived.updatedBy = actor;
  derived.isLaborOnly = false;
  derived.isStagedForPickup = false;

  return {
    header: await saveJobRecord(client, orgId, derived),
    allocations,
    filmOrders
  };
}

export {
  buildJobsList,
  buildJobsSearchResults,
  normalizeCalendarMonth,
  normalizeCalendarView,
  parseCalendarDate,
  formatCalendarDate,
  normalizeCalendarAnchorDate,
  shiftCalendarDate,
  getCalendarWeekStart,
  buildJobsCalendar,
  buildJobDetail,
  buildReadJobDetail,
  setJobStagedPickup,
  ensureJobHeaderForUpdate,
  resolveExistingOrLegacyJobHeader,
};
