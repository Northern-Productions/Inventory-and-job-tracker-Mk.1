// Purpose: Job, film-order, and delete mutation runtime workflows.
import {
  HttpError,
  queryRow,
  ok,
  asTrimmedString,
  requireString,
  normalizeDateString,
  coerceNonNegativeNumber,
  coerceFeetValue,
  requireUuid,
  releaseAllocationFeetFromBox,
  integerOrZero,
  cloneValue,
  createLogId,
  assertAveryNaturaShadeForWrite,
  resolveCanonicalFilmEntry,
  resolveCatalogWriteFilmEntry,
  normalizeJobRequirementEntriesForWrite,
  normalizeJobNumberDigits,
  normalizeJobWarehouse,
  normalizeJobWorkScope,
  normalizeJobLifecycleStatus,
  normalizeJobRequirementLookupKey,
  dedupeJobRequirements,
  normalizeJobNumberKey,
  normalizeCrewLeaderKey,
  toPublicBox,
  toPublicFilmOrder,
  requireConfiguredWarehouse,
  listBoxes,
  findBoxById,
  saveBoxRecord,
  deleteBoxRecord,
  listAllocationsByJob,
  listAllocationsByJobId,
  findAllocationById,
  saveAllocationRecord,
  listFilmOrdersByJob,
  listFilmOrdersByJobId,
  findFilmOrderById,
  saveFilmOrderRecord,
  listJobsByNumber,
  findJobByNumber,
  saveJobRecord,
  saveJobRecordById,
  listJobRequirementsByJob,
  listJobRequirementsByJobId,
  setJobRequirementState as saveJobRequirementState,
  listJobCaulkRequirementsByJob,
  listJobCaulkRequirementsByJobId,
  listCaulkJobCheckoutsByJob,
  listCaulkJobCheckoutsByJobId,
  replaceJobRequirementsForJob,
  normalizeJobCaulkRequirementEntries,
  replaceJobCaulkRequirementsForJob,
  derivePersistedJobMaterialFlags,
  deleteJobRequirementsByJobId,
  deleteJobRecord,
  deleteJobRecordById,
  appendAuditEntry,
} from '../runtimeDeps.mjs';
import {
  buildJobDetail,
  buildJobDetailById,
  ensureJobHeaderForUpdate,
  resolveExistingOrLegacyJobHeader,
} from './runtimeJobsRead.mjs';
import {
  buildJobRequirementsByLookupKey,
  isRequirementComplete,
} from './runtimeAllocationCoverage.mjs';
import {
  formatDeletedJobCleanupWarning,
  prepareDeletedJobCleanup,
  prepareDeletedJobCleanupByJobId,
  removeAllocationFromJob,
  cancelJobAndReleaseAllocations,
  cancelJobAndReleaseAllocationsByJobId,
  cancelFilmOrderAndReleaseAllocations,
} from './runtimeAllocationCleanup.mjs';
import {
  buildRequirementRowsForReplace,
} from './runtimeCollectionsAndBoxes.mjs';
import {
  getOrResolveJobId,
} from './runtimeAllocationPlanning.mjs';
import { getAllocationReservationState } from '../../../../../shared/domain/filmAllocationReservations.mjs';
import {
  buildJobDuplicateCheckResult,
  getJobDuplicateWorkScopeInput,
} from '../../../../../shared/domain/jobDuplicateContract.mjs';
import {
  capturePhysicalFeetAvailableByBoxId,
  recalculateReservationBoxesByIds,
} from './runtimeAllocationReservationReconciliation.mjs';
import { resolveJobMutationTargetById } from './jobMutationIdentity.mjs';
import {
  validateAllocationJobMutationOwnership,
} from '../../../../../shared/domain/allocationMutationIdentity.mjs';
import {
  validateFilmOrderJobMutationOwnership,
} from '../../../../../shared/domain/filmOrderMutationIdentity.mjs';
import {
  normalizePlannerSuppressionMaterialType,
  validatePlannerSuppressionRequirementOwnership,
} from '../../../../../shared/domain/plannerSuppressionMutationIdentity.mjs';

function getWorkScopeInput(payload) {
  return Object.prototype.hasOwnProperty.call(payload || {}, 'workScope')
    ? payload.workScope
    : payload?.sections;
}

function hasWorkScopeInput(payload) {
  return (
    Object.prototype.hasOwnProperty.call(payload || {}, 'workScope') ||
    Object.prototype.hasOwnProperty.call(payload || {}, 'sections')
  );
}

function getRestoredAllocatableFeet(entry) {
  return getAllocationReservationState(entry) === 'WITH_INSTALL_DATE' ? integerOrZero(entry?.allocatedFeet) : 0;
}

async function createJob(client, orgId, payload, actor) {
  const warnings = [];
  const jobNumber = normalizeJobNumberDigits(payload.jobNumber, 'Job ID number');
  const sameJobNumberJobs = await listJobsByNumber(client, orgId, jobNumber);
  const duplicateResult = buildJobDuplicateCheckResult({
    jobNumber,
    workScopeInput: getJobDuplicateWorkScopeInput(payload),
    existingJob: sameJobNumberJobs[0] || null,
    sameJobNumberJobs,
    duplicatesEnabled: true,
  });
  if (duplicateResult.exactScopeDuplicateExists) {
    throw new HttpError(
      409,
      `Job ${jobNumber} already exists.`,
      [],
      duplicateResult
    );
  }

  const warehouse = normalizeJobWarehouse(payload.warehouse);
  const sections = normalizeJobWorkScope(getWorkScopeInput(payload));
  const installDate = normalizeDateString(
    payload.installDate !== undefined ? payload.installDate : payload.dueDate,
    'Install Date',
    true
  );
  const crewLeader = asTrimmedString(payload.crewLeader);
  const lifecycleStatus = normalizeJobLifecycleStatus(payload.lifecycleStatus);
  const notes = asTrimmedString(payload.notes);
  const incomingRequirementsRaw = dedupeJobRequirements(payload.requirements, warnings);
  const incomingRequirements = await normalizeJobRequirementEntriesForWrite(
    client,
    orgId,
    incomingRequirementsRaw
  );
  const normalizedCaulkRequirements = await normalizeJobCaulkRequirementEntries(
    client,
    orgId,
    payload.caulkRequirements
  );
  const nowIso = new Date().toISOString();
  let nextHeader = {
    id: '',
    orgId,
    jobNumber,
    warehouse,
    sections,
    installDate,
    crewLeader,
    lifecycleStatus,
    isLaborOnly: false,
    isStagedForPickup: false,
    notes,
    createdAt: nowIso,
    createdBy: actor,
    updatedAt: nowIso,
    updatedBy: actor
  };

  const materialFlags = derivePersistedJobMaterialFlags(
    nextHeader,
    payload,
    incomingRequirements,
    normalizedCaulkRequirements
  );
  nextHeader.isLaborOnly = materialFlags.isLaborOnly;
  nextHeader.isStagedForPickup = materialFlags.isStagedForPickup;

  try {
    nextHeader = await saveJobRecord(client, orgId, nextHeader);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === '23505') {
      const raceCandidates = await listJobsByNumber(client, orgId, jobNumber);
      throw new HttpError(
        409,
        `Job ${jobNumber} already exists.`,
        [],
        buildJobDuplicateCheckResult({
          jobNumber,
          workScopeInput: getJobDuplicateWorkScopeInput(payload),
          existingJob: raceCandidates[0] || null,
          sameJobNumberJobs: raceCandidates,
          duplicatesEnabled: true,
        })
      );
    }
    throw error;
  }

  const existingRequirements = await listJobRequirementsByJobId(client, orgId, nextHeader.id);
  const merged = {};

  for (let index = 0; index < existingRequirements.length; index += 1) {
    const existing = existingRequirements[index];
    const existingCanonical = await resolveCanonicalFilmEntry(
      client,
      orgId,
      existing.manufacturer,
      existing.filmName
    );
    const existingManufacturer = existingCanonical.manufacturer;
    const existingFilmName = existingCanonical.filmName;
    const existingKey = normalizeJobRequirementLookupKey(
      existingManufacturer,
      existingFilmName,
      existing.widthIn
    );
    merged[existingKey] = {
      manufacturer: existingManufacturer,
      filmName: existingFilmName,
      widthIn: existing.widthIn,
      requiredFeet: existing.requiredFeet
    };
  }

  for (let index = 0; index < incomingRequirements.length; index += 1) {
    const incoming = incomingRequirements[index];
    const incomingKey = normalizeJobRequirementLookupKey(
      incoming.manufacturer,
      incoming.filmName,
      incoming.widthIn
    );

    if (!merged[incomingKey]) {
      merged[incomingKey] = incoming;
      continue;
    }

    merged[incomingKey].manufacturer = incoming.manufacturer;
    merged[incomingKey].filmName = incoming.filmName;
    merged[incomingKey].requiredFeet += incoming.requiredFeet;
  }

  const mergedValues = Object.values(merged);
  const existingByKey = buildJobRequirementsByLookupKey(existingRequirements);
  await replaceJobRequirementsForJob(
    client,
    orgId,
    nextHeader,
    buildRequirementRowsForReplace(jobNumber, mergedValues, existingByKey, actor, nowIso)
  );
  await replaceJobCaulkRequirementsForJob(
    client,
    orgId,
    nextHeader,
    normalizedCaulkRequirements,
    actor,
    nowIso
  );

  return ok(await buildJobDetailById(client, orgId, nextHeader.id), warnings);
}

async function syncJobMetadataToActiveAllocationsAndOpenFilmOrders(
  client,
  orgId,
  jobNumber,
  actor,
  previousInstallDate,
  installDate,
  crewLeader
) {
  const allocations = await listAllocationsByJob(client, orgId, jobNumber);
  const filmOrders = await listFilmOrdersByJob(client, orgId, jobNumber);
  let updatedAllocationCount = 0;
  let updatedFilmOrderCount = 0;
  const installDateChanged = asTrimmedString(previousInstallDate) !== asTrimmedString(installDate);
  const affectedBoxIds = Array.from(
    new Set(
      allocations
        .filter((entry) => entry?.status === 'ACTIVE')
        .map((entry) => asTrimmedString(entry?.boxId))
        .filter(Boolean)
    )
  );
  const physicalFeetAvailableByBoxId = installDateChanged
    ? await capturePhysicalFeetAvailableByBoxId(client, orgId, affectedBoxIds)
    : {};

  for (let index = 0; index < allocations.length; index += 1) {
    const allocation = cloneValue(allocations[index]);
    if (allocation.status !== 'ACTIVE') {
      continue;
    }

    if (allocation.installDate === installDate && allocation.crewLeader === crewLeader) {
      continue;
    }

    allocation.installDate = installDate;
    allocation.crewLeader = crewLeader;
    await saveAllocationRecord(client, orgId, allocation);
    updatedAllocationCount += 1;
  }

  for (let index = 0; index < filmOrders.length; index += 1) {
    const filmOrder = cloneValue(filmOrders[index]);
    if (filmOrder.status === 'CANCELLED' || filmOrder.status === 'FULFILLED') {
      continue;
    }

    if (filmOrder.installDate === installDate && filmOrder.crewLeader === crewLeader) {
      continue;
    }

    filmOrder.installDate = installDate;
    filmOrder.crewLeader = crewLeader;
    await saveFilmOrderRecord(client, orgId, filmOrder);
    updatedFilmOrderCount += 1;
  }

  if (installDateChanged && affectedBoxIds.length > 0) {
    await recalculateReservationBoxesByIds(client, orgId, affectedBoxIds, {
      physicalFeetAvailableByBoxId,
    });
  }

  return {
    updatedAllocationCount,
    updatedFilmOrderCount,
  };
}

async function updateJob(client, orgId, payload, actor) {
  const warnings = [];
  const target = await resolveJobMutationTargetById(client, orgId, payload);
  const jobNumber = target.usedJobId
    ? target.jobNumber
    : normalizeJobNumberDigits(payload.jobNumber, 'Job ID number');
  const updatePayload = target.usedJobId ? { ...payload, jobNumber } : payload;
  if (
    updatePayload.lifecycleStatus !== undefined &&
    normalizeJobLifecycleStatus(updatePayload.lifecycleStatus) !== 'ACTIVE'
  ) {
    throw new HttpError(400, `Closed lifecycle changes are not allowed here. Use complete/reopen actions for job ${jobNumber}.`);
  }
  const requirementsRaw = dedupeJobRequirements(updatePayload.requirements, warnings);
  const requirements = await normalizeJobRequirementEntriesForWrite(client, orgId, requirementsRaw);
  const normalizedCaulkRequirements = await normalizeJobCaulkRequirementEntries(
    client,
    orgId,
    updatePayload.caulkRequirements
  );
  const nowIso = new Date().toISOString();
  const header = target.usedJobId
    ? target.job
    : await ensureJobHeaderForUpdate(client, orgId, jobNumber, updatePayload, actor, nowIso);
  if (normalizeJobLifecycleStatus(header.lifecycleStatus) !== 'ACTIVE') {
    throw new HttpError(400, `Job ${jobNumber} is closed. Reopen it before editing.`);
  }
  const nextHeader = cloneValue(header);

  if (updatePayload.warehouse !== undefined) {
    nextHeader.warehouse = normalizeJobWarehouse(updatePayload.warehouse);
  }

  if (hasWorkScopeInput(updatePayload)) {
    nextHeader.sections = normalizeJobWorkScope(getWorkScopeInput(updatePayload));
  }

  if (updatePayload.installDate !== undefined || updatePayload.dueDate !== undefined) {
    nextHeader.installDate = normalizeDateString(
      updatePayload.installDate !== undefined ? updatePayload.installDate : updatePayload.dueDate,
      'Install Date',
      true
    );
  }

  if (updatePayload.crewLeader !== undefined) {
    nextHeader.crewLeader = asTrimmedString(updatePayload.crewLeader);
  }

  if (updatePayload.lifecycleStatus !== undefined) {
    nextHeader.lifecycleStatus = normalizeJobLifecycleStatus(updatePayload.lifecycleStatus);
  }

  if (updatePayload.notes !== undefined) {
    nextHeader.notes = asTrimmedString(updatePayload.notes);
  }

  const materialFlags = derivePersistedJobMaterialFlags(
    nextHeader,
    updatePayload,
    requirements,
    normalizedCaulkRequirements
  );
  nextHeader.isLaborOnly = materialFlags.isLaborOnly;
  nextHeader.isStagedForPickup = materialFlags.isStagedForPickup;

  nextHeader.updatedAt = nowIso;
  nextHeader.updatedBy = actor;

  const savedHeader = target.usedJobId
    ? await saveJobRecordById(client, orgId, nextHeader)
    : await saveJobRecord(client, orgId, nextHeader);
  const existingRequirements = target.usedJobId
    ? await listJobRequirementsByJobId(client, orgId, target.jobId)
    : await listJobRequirementsByJob(client, orgId, jobNumber);
  const existingByKey = buildJobRequirementsByLookupKey(existingRequirements);
  await replaceJobRequirementsForJob(
    client,
    orgId,
    savedHeader,
    buildRequirementRowsForReplace(jobNumber, requirements, existingByKey, actor, nowIso)
  );
  await replaceJobCaulkRequirementsForJob(
    client,
    orgId,
    savedHeader,
    normalizedCaulkRequirements,
    actor,
    nowIso
  );

  const installDateChanged = asTrimmedString(header.installDate) !== asTrimmedString(savedHeader.installDate);
  const crewLeaderChanged =
    normalizeCrewLeaderKey(header.crewLeader) !== normalizeCrewLeaderKey(savedHeader.crewLeader);
  if (installDateChanged || crewLeaderChanged) {
    const syncResult = await syncJobMetadataToActiveAllocationsAndOpenFilmOrders(
      client,
      orgId,
      jobNumber,
      actor,
      header.installDate,
      savedHeader.installDate,
      savedHeader.crewLeader
    );
    if (syncResult.updatedAllocationCount > 0 || syncResult.updatedFilmOrderCount > 0) {
      warnings.push(
        `Updated scheduling metadata on ${syncResult.updatedAllocationCount} active allocation${syncResult.updatedAllocationCount === 1 ? '' : 's'} and ${syncResult.updatedFilmOrderCount} open film order${syncResult.updatedFilmOrderCount === 1 ? '' : 's'}.`
      );
    }
  }

  return ok(
    target.usedJobId
      ? await buildJobDetailById(client, orgId, target.jobId)
      : await buildJobDetail(client, orgId, jobNumber),
    warnings
  );
}

async function cancelActiveCaulkAllocationsForCompleteJob(client, orgId, actor, payload) {
  const response = await queryRow(
    client,
    `select public.api_acl_jobs_cancel_caulk_allocations($1::uuid, $2::text, $3::jsonb) as payload`,
    [orgId, asTrimmedString(actor), JSON.stringify(payload)]
  );

  return response && typeof response.payload === 'object'
    ? cloneValue(response.payload)
    : {};
}

async function completeJob(client, orgId, payload, actor) {
  const warnings = [];
  const target = await resolveJobMutationTargetById(client, orgId, payload);
  const jobNumber = target.usedJobId
    ? target.jobNumber
    : normalizeJobNumberDigits(payload.jobNumber, 'Job ID number');
  const resolvedAt = new Date().toISOString();
  const resolvedContext = target.usedJobId
    ? {
        header: target.job,
        allocations: await listAllocationsByJobId(client, orgId, target.jobId),
        filmOrders: await listFilmOrdersByJobId(client, orgId, target.jobId),
      }
    : await resolveExistingOrLegacyJobHeader(
        client,
        orgId,
        jobNumber,
        actor,
        resolvedAt
      );
  const existingJob = resolvedContext.header;
  if (!existingJob) {
    throw new HttpError(404, `Job ${jobNumber} was not found.`);
  }

  const lifecycleStatus = normalizeJobLifecycleStatus(existingJob.lifecycleStatus);
  if (lifecycleStatus === 'COMPLETED') {
    throw new HttpError(400, `Job ${jobNumber} is already completed.`);
  }

  if (lifecycleStatus === 'CANCELLED') {
    throw new HttpError(400, `Job ${jobNumber} is cancelled and cannot be completed.`);
  }

  const normalizedTargetJobId = target.usedJobId ? asTrimmedString(target.jobId).toLowerCase() : '';
  const normalizedTargetJobNumber = normalizeJobNumberKey(jobNumber);
  const checkedOutBoxes = (await listBoxes(client, orgId)).filter((box) => {
    if (box.status !== 'CHECKED_OUT') {
      return false;
    }
    if (!target.usedJobId) {
      return normalizeJobNumberKey(box.lastCheckoutJob) === normalizedTargetJobNumber;
    }

    const boxJobId = asTrimmedString(box.lastCheckoutJobId).toLowerCase();
    return (
      boxJobId === normalizedTargetJobId ||
      (!boxJobId && normalizeJobNumberKey(box.lastCheckoutJob) === normalizedTargetJobNumber)
    );
  });
  if (checkedOutBoxes.length) {
    const listedBoxes = checkedOutBoxes
      .slice(0, 5)
      .map((box) => box.boxId)
      .join(', ');
    const suffix = checkedOutBoxes.length > 5 ? ', ...' : '';
    throw new HttpError(
      400,
      `Job ${jobNumber} cannot be completed while boxes are still checked out: ${listedBoxes}${suffix}.`
    );
  }

  const caulkCheckouts = target.usedJobId
    ? await listCaulkJobCheckoutsByJobId(client, orgId, target.jobId)
    : await listCaulkJobCheckoutsByJob(client, orgId, jobNumber);
  const openCaulkCheckoutCount = caulkCheckouts.filter((entry) => entry.status === 'OPEN').length;
  if (openCaulkCheckoutCount > 0) {
    throw new HttpError(
      400,
      `Job ${jobNumber} cannot be completed while ${openCaulkCheckoutCount} caulk checkout${openCaulkCheckoutCount === 1 ? ' remains' : 's remain'} open.`
    );
  }

  const cancelNote =
    asTrimmedString(payload.reason) || `Cancelled because job ${jobNumber} was marked completed.`;
  const activeAllocations = resolvedContext.allocations || (await listAllocationsByJob(client, orgId, jobNumber));
  const releasedFeetByBox = {};
  let cancelledAllocationCount = 0;

  for (let index = 0; index < activeAllocations.length; index += 1) {
    const allocation = cloneValue(activeAllocations[index]);
    if (allocation.status !== 'ACTIVE') {
      continue;
    }

    releasedFeetByBox[allocation.boxId] =
      integerOrZero(releasedFeetByBox[allocation.boxId]) + getRestoredAllocatableFeet(allocation);
    allocation.status = 'CANCELLED';
    allocation.resolvedAt = resolvedAt;
    allocation.resolvedBy = asTrimmedString(actor);
    allocation.notes = cancelNote;
    await saveAllocationRecord(client, orgId, allocation);
    cancelledAllocationCount += 1;
  }

  for (const boxId of Object.keys(releasedFeetByBox)) {
    const box = await findBoxById(client, orgId, boxId);
    if (!box || asTrimmedString(box.status).toUpperCase() === 'ZEROED' || asTrimmedString(box.status).toUpperCase() === 'RETIRED') {
      continue;
    }

    await saveBoxRecord(client, orgId, releaseAllocationFeetFromBox(box, releasedFeetByBox[boxId]));
  }

  const filmOrders = resolvedContext.filmOrders || (await listFilmOrdersByJob(client, orgId, jobNumber));
  let cancelledFilmOrderCount = 0;
  for (let index = 0; index < filmOrders.length; index += 1) {
    const filmOrder = cloneValue(filmOrders[index]);
    if (filmOrder.status !== 'FILM_ORDER' && filmOrder.status !== 'FILM_ON_THE_WAY') {
      continue;
    }

    filmOrder.status = 'CANCELLED';
    filmOrder.resolvedAt = resolvedAt;
    filmOrder.resolvedBy = asTrimmedString(actor);
    filmOrder.notes = cancelNote;
    await saveFilmOrderRecord(client, orgId, filmOrder);
    cancelledFilmOrderCount += 1;
  }

  const caulkCancelPayload = target.usedJobId
    ? await cancelActiveCaulkAllocationsForCompleteJob(client, orgId, actor, {
        jobId: target.jobId,
        jobNumber,
        reason: cancelNote
      })
    : {};
  const cancelledCaulkAllocationCount = integerOrZero(caulkCancelPayload.cancelledAllocationCount);
  const releasedReservedCaulkTubes = integerOrZero(caulkCancelPayload.releasedReservedTubes);

  existingJob.lifecycleStatus = 'COMPLETED';
  existingJob.updatedAt = resolvedAt;
  existingJob.updatedBy = actor;
  await (target.usedJobId
    ? saveJobRecordById(client, orgId, existingJob)
    : saveJobRecord(client, orgId, existingJob));

  if (target.usedJobId) {
    warnings.push(
      `Marked job ${jobNumber} completed. Cancelled ${cancelledAllocationCount} active allocation${cancelledAllocationCount === 1 ? '' : 's'}, ${cancelledCaulkAllocationCount} active caulk allocation${cancelledCaulkAllocationCount === 1 ? '' : 's'}, released ${releasedReservedCaulkTubes} reserved caulk tube${releasedReservedCaulkTubes === 1 ? '' : 's'}, and ${cancelledFilmOrderCount} open film order${cancelledFilmOrderCount === 1 ? '' : 's'}.`
    );
  } else {
    warnings.push(
      `Marked job ${jobNumber} completed. Cancelled ${cancelledAllocationCount} active allocation${cancelledAllocationCount === 1 ? '' : 's'} and ${cancelledFilmOrderCount} open film order${cancelledFilmOrderCount === 1 ? '' : 's'}.`
    );
  }

  return ok(
    target.usedJobId ? await buildJobDetailById(client, orgId, target.jobId) : await buildJobDetail(client, orgId, jobNumber),
    warnings
  );
}

async function reopenJob(client, orgId, payload, actor) {
  const warnings = [];
  const nowIso = new Date().toISOString();
  const target = await resolveJobMutationTargetById(client, orgId, payload);
  const jobNumber = target.usedJobId
    ? target.jobNumber
    : normalizeJobNumberDigits(payload.jobNumber, 'Job ID number');
  const resolvedContext = target.usedJobId
    ? { header: target.job }
    : await resolveExistingOrLegacyJobHeader(client, orgId, jobNumber, actor, nowIso);
  const existingJob = resolvedContext.header;
  if (!existingJob) {
    throw new HttpError(404, `Job ${jobNumber} was not found.`);
  }

  const lifecycleStatus = normalizeJobLifecycleStatus(existingJob.lifecycleStatus);
  if (lifecycleStatus !== 'COMPLETED' && lifecycleStatus !== 'CANCELLED') {
    throw new HttpError(400, `Job ${jobNumber} is already active.`);
  }

  existingJob.lifecycleStatus = 'ACTIVE';
  existingJob.updatedAt = nowIso;
  existingJob.updatedBy = actor;
  await saveJobRecord(client, orgId, existingJob);
  warnings.push(`Reopened job ${jobNumber}. Previously cancelled allocations and film orders remain cancelled.`);

  return ok(
    target.usedJobId ? await buildJobDetailById(client, orgId, target.jobId) : await buildJobDetail(client, orgId, jobNumber),
    warnings
  );
}

async function deleteJob(client, orgId, payload, actor, role) {
  const warnings = [];
  if (role !== 'owner' && role !== 'admin') {
    throw new HttpError(403, 'Admin or owner access is required.');
  }

  const suppliedJobId = asTrimmedString(payload.jobId);
  if (suppliedJobId) {
    requireUuid(suppliedJobId, 'jobId');
  }
  const suppliedJobNumber = normalizeJobNumberDigits(payload.jobNumber, 'Job ID number');
  const target = await resolveJobMutationTargetById(client, orgId, {
    ...payload,
    jobNumber: suppliedJobNumber
  });
  const jobNumber = target.usedJobId
    ? target.jobNumber
    : suppliedJobNumber;
  const existingJob = target.usedJobId
    ? target.job
    : await findJobByNumber(client, orgId, jobNumber);
  if (!existingJob) {
    throw new HttpError(404, `Job ${jobNumber} was not found.`);
  }

  const normalizedTargetJobId = target.usedJobId ? asTrimmedString(target.jobId).toLowerCase() : '';
  const normalizedTargetJobNumber = normalizeJobNumberKey(jobNumber);
  const checkedOutBoxes = (await listBoxes(client, orgId)).filter((box) => {
    if (box.status !== 'CHECKED_OUT') {
      return false;
    }
    if (!target.usedJobId) {
      return normalizeJobNumberKey(box.lastCheckoutJob) === normalizedTargetJobNumber;
    }

    const boxJobId = asTrimmedString(box.lastCheckoutJobId).toLowerCase();
    return (
      boxJobId === normalizedTargetJobId ||
      (!boxJobId && normalizeJobNumberKey(box.lastCheckoutJob) === normalizedTargetJobNumber)
    );
  });
  if (checkedOutBoxes.length) {
    const listedBoxes = checkedOutBoxes
      .slice(0, 5)
      .map((box) => box.boxId)
      .join(', ');
    const suffix = checkedOutBoxes.length > 5 ? ', ...' : '';
    throw new HttpError(
      400,
      `Job ${jobNumber} cannot be deleted while boxes are still checked out: ${listedBoxes}${suffix}.`
    );
  }

  const caulkCheckouts = target.usedJobId
    ? await listCaulkJobCheckoutsByJobId(client, orgId, target.jobId)
    : await listCaulkJobCheckoutsByJob(client, orgId, jobNumber);
  const openCaulkCheckoutCount = caulkCheckouts.filter((entry) => entry.status === 'OPEN').length;
  if (openCaulkCheckoutCount > 0) {
    throw new HttpError(
      400,
      `Job ${jobNumber} cannot be deleted while ${openCaulkCheckoutCount} caulk checkout${openCaulkCheckoutCount === 1 ? ' remains' : 's remain'} open.`
    );
  }

  const existingRequirements = target.usedJobId
    ? await listJobRequirementsByJobId(client, orgId, target.jobId)
    : await listJobRequirementsByJob(client, orgId, jobNumber);
  const existingCaulkRequirements = target.usedJobId
    ? await listJobCaulkRequirementsByJobId(client, orgId, target.jobId)
    : await listJobCaulkRequirementsByJob(client, orgId, jobNumber);
  const deleteReason = asTrimmedString(payload.reason) || `Deleted job ${jobNumber}.`;
  const deleteResult = target.usedJobId
    ? await prepareDeletedJobCleanupByJobId(
        client,
        orgId,
        target.jobId,
        jobNumber,
        actor,
        deleteReason
      )
    : await prepareDeletedJobCleanup(
        client,
        orgId,
        jobNumber,
        actor,
        deleteReason
      );

  await deleteJobRequirementsByJobId(client, orgId, target.usedJobId ? target.jobId : existingJob.id);
  await (target.usedJobId
    ? deleteJobRecordById(client, orgId, target.jobId)
    : deleteJobRecord(client, orgId, jobNumber));

  warnings.push(
    formatDeletedJobCleanupWarning({
      jobNumber,
      filmRequirementCount: existingRequirements.length,
      caulkRequirementCount: existingCaulkRequirements.length,
      releasedFilmAllocationCount: deleteResult.releasedFilmAllocationCount,
      affectedBoxCount: deleteResult.affectedBoxCount,
      releasedReservedCaulkTubes: deleteResult.releasedReservedCaulkTubes,
      cancelledCaulkAllocationCount: deleteResult.cancelledCaulkAllocationCount,
      purgedFilmAllocationCount: deleteResult.purgedFilmAllocationCount,
      purgedCaulkAllocationCount: deleteResult.purgedCaulkAllocationCount,
      purgedCaulkCheckoutCount: deleteResult.purgedCaulkCheckoutCount,
      purgedRollHistoryCount: deleteResult.purgedRollHistoryCount,
      deletedFilmOrderCount: deleteResult.deletedFilmOrderCount
    })
  );

  return ok(target.usedJobId ? { jobId: target.jobId, jobNumber } : { jobNumber }, warnings);
}

async function createFilmOrder(client, orgId, payload, actor) {
  const warnings = [];
  const warehouse = await requireConfiguredWarehouse(client, orgId, payload.warehouse, 'Warehouse');
  const suppliedJobId = asTrimmedString(payload.jobId);
  if (suppliedJobId) {
    requireUuid(suppliedJobId, 'jobId');
  }
  const target = await resolveJobMutationTargetById(client, orgId, payload);
  const jobNumber = target.usedJobId
    ? requireString(target.jobNumber, 'JobNumber')
    : requireString(payload.jobNumber, 'JobNumber');
  const sourceManufacturer = requireString(payload.manufacturer, 'Manufacturer');
  const sourceFilmName = requireString(payload.filmName, 'FilmName');
  assertAveryNaturaShadeForWrite(sourceManufacturer, sourceFilmName, 'FilmName');
  const canonical = await resolveCatalogWriteFilmEntry(client, orgId, sourceManufacturer, sourceFilmName);
  const manufacturer = canonical.manufacturer;
  const filmName = canonical.filmName;
  const widthIn = coerceNonNegativeNumber(payload.widthIn, 'WidthIn');
  const requestedFeet = coerceFeetValue(payload.requestedFeet, 'RequestedFeet', warnings, false);
  const requirementId = asTrimmedString(payload.requirementId);
  let selectedRequirement = null;

  if (widthIn <= 0) {
    throw new HttpError(400, 'WidthIn must be greater than zero.');
  }

  if (requestedFeet <= 0) {
    throw new HttpError(400, 'RequestedFeet must be greater than zero.');
  }

  const existingJob = target.usedJobId
    ? target.job
    : await findJobByNumber(client, orgId, jobNumber);
  if (existingJob && normalizeJobLifecycleStatus(existingJob.lifecycleStatus) !== 'ACTIVE') {
    throw new HttpError(400, `Job ${jobNumber} is closed and cannot receive film orders.`);
  }

  const duplicateKey = normalizeJobRequirementLookupKey(manufacturer, filmName, widthIn);
  if (target.usedJobId && !requirementId) {
    throw new HttpError(400, 'RequirementID is required when jobId is supplied.');
  }

  if (requirementId) {
    const requirements = target.usedJobId
      ? await listJobRequirementsByJobId(client, orgId, target.jobId)
      : await listJobRequirementsByJob(client, orgId, jobNumber);
    selectedRequirement = requirements.find((entry) => asTrimmedString(entry.id || entry.requirementId) === requirementId) || null;
    if (!selectedRequirement) {
      throw new HttpError(404, 'Job requirement was not found.');
    }

    if (isRequirementComplete(selectedRequirement)) {
      throw new HttpError(400, 'Requirement is complete. Reactivate it before ordering more film.');
    }

    const requirementKey = normalizeJobRequirementLookupKey(
      selectedRequirement.manufacturer,
      selectedRequirement.filmName,
      selectedRequirement.widthIn
    );
    if (requirementKey !== duplicateKey) {
      throw new HttpError(400, 'Film order product and width must match the selected requirement.');
    }
  }

  const existingFilmOrders = target.usedJobId
    ? await listFilmOrdersByJobId(client, orgId, target.jobId)
    : await listFilmOrdersByJob(client, orgId, jobNumber);
  const duplicateOrder = existingFilmOrders.find((entry) => {
    const status = asTrimmedString(entry?.status).toUpperCase();
    if (status !== 'FILM_ORDER' && status !== 'FILM_ON_THE_WAY') {
      return false;
    }

    const existingRequirementId = asTrimmedString(entry.requirementId);
    if (requirementId && existingRequirementId) {
      return existingRequirementId === requirementId &&
        normalizeJobRequirementLookupKey(entry.manufacturer, entry.filmName, entry.widthIn) === duplicateKey;
    }

    return normalizeJobRequirementLookupKey(entry.manufacturer, entry.filmName, entry.widthIn) === duplicateKey;
  });
  if (duplicateOrder) {
    throw new HttpError(
      409,
      `Film order ${duplicateOrder.filmOrderId} already covers this job requirement. Cancel it before creating another order.`
    );
  }

  const jobId = target.usedJobId
    ? target.jobId
    : await getOrResolveJobId(client, orgId, jobNumber);
  const entry = await saveFilmOrderRecord(client, orgId, {
    filmOrderId: createLogId(),
    requirementId,
    jobId,
    jobNumber,
    warehouse,
    manufacturer,
    filmName,
    widthIn,
    requestedFeet,
    coveredFeet: 0,
    orderedFeet: 0,
    remainingToOrderFeet: requestedFeet,
    installDate: asTrimmedString(existingJob?.installDate),
    crewLeader: asTrimmedString(existingJob?.crewLeader),
    status: 'FILM_ORDER',
    sourceBoxId: '',
    createdAt: new Date().toISOString(),
    createdBy: asTrimmedString(actor),
    resolvedAt: '',
    resolvedBy: '',
    notes: 'Created manually from Film Orders.'
  });

  return ok(toPublicFilmOrder(entry, []), warnings);
}

async function setJobRequirementState(client, orgId, payload, actor) {
  const warnings = [];
  const suppliedJobId = asTrimmedString(payload.jobId);
  if (suppliedJobId) {
    requireUuid(suppliedJobId, 'jobId');
  }
  const requirementId = requireUuid(payload.requirementId, 'RequirementId');
  const nextStatus = asTrimmedString(payload.status).toUpperCase();
  if (nextStatus !== 'ACTIVE' && nextStatus !== 'COMPLETE') {
    throw new HttpError(400, 'Requirement status must be ACTIVE or COMPLETE.');
  }

  let jobId = '';
  let jobNumber = '';
  let existingJob = null;
  if (suppliedJobId) {
    const target = await resolveJobMutationTargetById(client, orgId, payload);
    jobId = target.jobId;
    jobNumber = target.jobNumber;
    existingJob = target.job;
  } else {
    jobNumber = requireString(payload.jobNumber, 'JobNumber');
    const sameNumberJobs = await listJobsByNumber(client, orgId, jobNumber);
    if (sameNumberJobs.length > 1) {
      throw new HttpError(409, `Job ${jobNumber} has multiple work scopes. Open the exact job before changing requirement state.`);
    }
    existingJob = sameNumberJobs[0] || null;
    if (!existingJob) {
      throw new HttpError(404, `Job ${jobNumber} was not found.`);
    }
    jobId = existingJob.id;
  }

  if (existingJob && normalizeJobLifecycleStatus(existingJob.lifecycleStatus) !== 'ACTIVE') {
    throw new HttpError(400, `Job ${jobNumber} is closed. Reopen it before changing requirement state.`);
  }

  await saveJobRequirementState(
    client,
    orgId,
    {
      jobId,
      requirementId,
      status: nextStatus,
    },
    actor
  );

  return ok(await buildJobDetailById(client, orgId, jobId), warnings);
}

async function cancelJob(client, orgId, payload, actor) {
  const warnings = [];
  const suppliedJobId = asTrimmedString(payload.jobId);
  if (suppliedJobId) {
    requireUuid(suppliedJobId, 'jobId');
  }
  requireString(payload.jobNumber, 'JobNumber');
  const target = await resolveJobMutationTargetById(client, orgId, payload);
  const jobNumber = target.usedJobId
    ? requireString(target.jobNumber, 'JobNumber')
    : requireString(payload.jobNumber, 'JobNumber');
  const result = target.usedJobId
    ? await cancelJobAndReleaseAllocationsByJobId(client, orgId, target.jobId, jobNumber, actor, payload.reason)
    : await cancelJobAndReleaseAllocations(client, orgId, jobNumber, actor, payload.reason);
  const existingJob = target.usedJobId ? target.job : await findJobByNumber(client, orgId, jobNumber);

  if (existingJob) {
    existingJob.lifecycleStatus = 'CANCELLED';
    existingJob.updatedAt = new Date().toISOString();
    existingJob.updatedBy = actor;
    if (target.usedJobId) {
      await saveJobRecordById(client, orgId, existingJob);
    } else {
      await saveJobRecord(client, orgId, existingJob);
    }
  }

  warnings.push(
    `Cancelled job ${jobNumber}. Released ${result.releasedAllocationCount} active allocation${result.releasedAllocationCount === 1 ? '' : 's'} across ${result.affectedBoxCount} box${result.affectedBoxCount === 1 ? '' : 'es'} and deleted ${result.deletedFilmOrderCount} film order${result.deletedFilmOrderCount === 1 ? '' : 's'}.`
  );

  return ok(target.usedJobId ? { jobId: target.jobId, jobNumber } : { jobNumber }, warnings);
}

async function removeJobBoxAllocation(client, orgId, payload, actor) {
  const warnings = [];
  const allocationId = requireString(payload.allocationId, 'AllocationID');
  const target = await resolveJobMutationTargetById(client, orgId, payload);
  const jobNumber = target.usedJobId
    ? requireString(target.jobNumber, 'JobNumber')
    : requireString(payload.jobNumber, 'JobNumber');

  if (target.usedJobId) {
    const allocation = await findAllocationById(client, orgId, allocationId);
    const ownership = validateAllocationJobMutationOwnership({
      allocation,
      allocationId,
      target,
      normalizeJobNumberDigits,
    });
    if (!ownership.ok) {
      throw new HttpError(ownership.status || 409, ownership.message);
    }
  }

  const result = await removeAllocationFromJob(
    client,
    orgId,
    jobNumber,
    allocationId,
    actor,
    payload.reason
  );

  if (result.removedAllocationCount === 0) {
    warnings.push(`Allocation ${allocationId} was already cancelled for job ${jobNumber}.`);
  } else {
    warnings.push(
      `Removed allocation ${result.allocationId} for box ${result.boxId} on job ${jobNumber}. Released ${result.releasedFeet} LF back to planning capacity.`
    );
  }

  return ok(
    {
      ...(target.usedJobId ? { jobId: target.jobId } : {}),
      jobNumber,
      allocationId: result.allocationId,
      boxId: result.boxId,
      removedAllocationCount: result.removedAllocationCount,
      releasedFeet: result.releasedFeet
    },
    warnings
  );
}

async function clearAllocationPlannerSuppression(client, orgId, payload, actor) {
  const target = await resolveJobMutationTargetById(client, orgId, payload);
  const jobNumber = target.usedJobId
    ? requireString(target.jobNumber, 'JobNumber')
    : requireString(payload.jobNumber, 'JobNumber');
  const requirementId = requireString(payload.requirementId, 'RequirementID');
  const materialType = normalizePlannerSuppressionMaterialType(
    payload.materialType !== undefined
      ? payload.materialType
      : payload.material_type
  );
  const reason =
    asTrimmedString(payload.reason) ||
    'User resumed auto-planning for requirement from job detail page.';

  if (target.usedJobId) {
    const requirements =
      materialType === 'CAULK'
        ? await listJobCaulkRequirementsByJobId(client, orgId, target.jobId)
        : await listJobRequirementsByJobId(client, orgId, target.jobId);
    const requirement =
      requirements.find((entry) =>
        asTrimmedString(entry?.requirementId || entry?.id) === requirementId
      ) || null;
    const ownership = validatePlannerSuppressionRequirementOwnership({
      requirement: requirement ? { ...requirement, jobId: target.jobId } : null,
      requirementId,
      materialType,
      target,
      normalizeJobNumberDigits,
    });
    if (!ownership.ok) {
      throw new HttpError(ownership.status || 409, ownership.message);
    }
  }

  // Guarded transition only: canonical identity is validated locally before
  // passing jobId through for SQL planner scope; legacy jobNumber remains valid.
  const row = await queryRow(
    client,
    `
      select public.api_acl_clear_allocation_planner_suppression(
        $1::uuid,
        $2::text,
        $3::jsonb
      ) as result
    `,
    [
      orgId,
      asTrimmedString(actor),
      JSON.stringify({
        ...(target.usedJobId ? { jobId: target.jobId } : {}),
        jobNumber,
        requirementId,
        materialType,
        reason
      })
    ]
  );
  const result = row?.result || {};
  const detailJobNumber = asTrimmedString(result.jobNumber) || jobNumber;

  const detail = target.usedJobId
    ? await buildJobDetailById(client, orgId, target.jobId)
    : await buildJobDetail(client, orgId, detailJobNumber);

  return ok(detail, [
    `Auto planning resumed for requirement ${requirementId} on job ${detailJobNumber}.`
  ]);
}

async function deleteFilmOrder(client, orgId, payload, actor) {
  const warnings = [];
  const filmOrderId = requireString(payload.filmOrderId, 'FilmOrderID');
  const target = await resolveJobMutationTargetById(client, orgId, payload);
  if (target.usedJobId) {
    const filmOrder = await findFilmOrderById(client, orgId, filmOrderId);
    const ownership = validateFilmOrderJobMutationOwnership({
      filmOrder,
      filmOrderId,
      target,
      normalizeJobNumberDigits,
    });
    if (!ownership.ok) {
      throw new HttpError(ownership.status || 409, ownership.message);
    }
  }

  // Guarded transition only: delete is filmOrderId-targeted, while create,
  // cancel, and planner scope remain jobNumber-based until a later RPC/schema
  // slice adds true duplicate-ready film-order semantics.
  const result = await cancelFilmOrderAndReleaseAllocations(
    client,
    orgId,
    filmOrderId,
    actor,
    payload.reason || 'Deleted from Film Orders.'
  );

  warnings.push(
    `Deleted film order ${filmOrderId}. Released ${result.releasedAllocationCount} active allocation${result.releasedAllocationCount === 1 ? '' : 's'} across ${result.affectedBoxCount} box${result.affectedBoxCount === 1 ? '' : 'es'}.`
  );

  return ok(toPublicFilmOrder(result.filmOrder, []), warnings);
}

async function deleteBox(client, orgId, payload, actor) {
  const boxId = requireString(payload.boxId, 'BoxID');
  const reason = asTrimmedString(payload.reason) || 'Deleted from box details.';
  const current = await findBoxById(client, orgId, boxId);

  if (!current) {
    throw new HttpError(404, 'Box not found.');
  }

  if (current.status === 'CHECKED_OUT') {
    throw new HttpError(
      400,
      'Checked-out boxes cannot be deleted. Check the box in or zero it out first.'
    );
  }

  const activeAllocationRow = await queryRow(
    client,
    `
      select count(*)::integer as count
      from app.allocations
      where org_id = $1
        and box_id = $2
        and status = 'ACTIVE'
    `,
    [orgId, current.boxId]
  );

  if (integerOrZero(activeAllocationRow?.count) > 0) {
    throw new HttpError(
      400,
      'Boxes with active allocations cannot be deleted. Resolve the allocations first.'
    );
  }

  const linkedFilmOrderRow = await queryRow(
    client,
    `
      select count(*)::integer as count
      from app.film_order_box_links
      where org_id = $1
        and box_id = $2
    `,
    [orgId, current.boxId]
  );

  if (integerOrZero(linkedFilmOrderRow?.count) > 0) {
    throw new HttpError(
      400,
      'Boxes linked to film orders cannot be deleted. Resolve the linked film order first.'
    );
  }

  await deleteBoxRecord(client, orgId, current.boxId);
  const logId = await appendAuditEntry(
    client,
    orgId,
    'DELETE_BOX',
    current.boxId,
    toPublicBox(current),
    null,
    actor,
    reason
  );

  return ok({ boxId: current.boxId, logId });
}

export {
  createJob,
  syncJobMetadataToActiveAllocationsAndOpenFilmOrders,
  updateJob,
  completeJob,
  reopenJob,
  deleteJob,
  createFilmOrder,
  setJobRequirementState,
  cancelJob,
  removeJobBoxAllocation,
  clearAllocationPlannerSuppression,
  deleteFilmOrder,
  deleteBox,
};
