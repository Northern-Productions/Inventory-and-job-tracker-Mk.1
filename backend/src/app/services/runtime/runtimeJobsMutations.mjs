// Purpose: Job, film-order, and delete mutation runtime workflows.
import {
  HttpError,
  queryRows,
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
  normalizeJobPhaseNumber,
  normalizeJobPhaseLaborStatus,
  normalizeJobPhaseWorkflowStatus,
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
  listJobPhasesByJobId,
  replaceJobPhasesForJob,
  setJobPhaseLaborState as saveJobPhaseLaborState,
  listJobRequirementsByJob,
  listJobRequirementsByJobId,
  setJobRequirementState as saveJobRequirementState,
  setJobCaulkRequirementState as saveJobCaulkRequirementState,
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
import { loadJobStagingValidationState } from './runtimeCheckoutOperations.mjs';
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
  buildPublicFilmOrderLinkedBoxes,
} from './runtimeJobSummaries.mjs';
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
  DELETE_JOB_FAILURE_MESSAGE,
  isCheckedOutBoxAssignedToJob,
  isExpectedDeleteJobHttpStatus,
} from '../../../../../shared/domain/jobDeleteContract.mjs';
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

function getPayloadPhaseEntries(payload) {
  return Array.isArray(payload?.phases) ? payload.phases : [];
}

function normalizePhaseInstallEndDate(value, installDate, fieldName) {
  const normalizedEndDate = normalizeDateString(value, fieldName, true);
  if (!normalizedEndDate) {
    return '';
  }

  if (!installDate) {
    throw new HttpError(400, `${fieldName} requires an Install Date.`);
  }

  if (normalizedEndDate < installDate) {
    throw new HttpError(400, `${fieldName} must be the same day as or later than Install Date.`);
  }

  return normalizedEndDate;
}

function buildDefaultPhaseInputFromJobPayload(payload, fallbackPhase = {}) {
  const installDate = normalizeDateString(
    payload.installDate !== undefined || payload.dueDate !== undefined
      ? payload.installDate !== undefined ? payload.installDate : payload.dueDate
      : fallbackPhase.installDate,
    'Install Date',
    true
  );
  return {
    phaseId: asTrimmedString(fallbackPhase.phaseId || fallbackPhase.id),
    phaseNumber: normalizeJobPhaseNumber(payload.phaseNumber || fallbackPhase.phaseNumber || 1, 'PhaseNumber'),
    sections: hasWorkScopeInput(payload)
      ? normalizeJobWorkScope(getWorkScopeInput(payload))
      : fallbackPhase.sections ?? fallbackPhase.workScope ?? null,
    installDate,
    installEndDate: normalizePhaseInstallEndDate(
      payload.installEndDate ?? payload.install_end_date ?? fallbackPhase.installEndDate,
      installDate,
      'Install End Date'
    ),
    crewLeader: payload.crewLeader !== undefined
      ? asTrimmedString(payload.crewLeader)
      : asTrimmedString(fallbackPhase.crewLeader),
    laborStatus: normalizeJobPhaseLaborStatus(fallbackPhase.laborStatus || fallbackPhase.status),
    workflowStatus: normalizeJobPhaseWorkflowStatus(
      payload.workflowStatus ??
      payload.workflow_status ??
      fallbackPhase.workflowStatus ??
      fallbackPhase.workflow_status ??
      (Number(payload.phaseNumber || fallbackPhase.phaseNumber || 1) === 1 ? 'ACTIVE' : 'PLACEHOLDER')
    ),
    isPrimary: true,
  };
}

async function clearStagedPickupIfActiveMaterialBlocked(
  client,
  orgId,
  jobHeader,
  actor,
  warnings,
  reason = 'Staged pickup was cleared because active phase material is no longer fully checked out.'
) {
  if (!jobHeader?.isStagedForPickup) {
    return jobHeader;
  }

  const jobId = asTrimmedString(jobHeader.id || jobHeader.jobId);
  const jobNumber = asTrimmedString(jobHeader.jobNumber);
  if (!jobId || !jobNumber) {
    return jobHeader;
  }

  const stagingState = await loadJobStagingValidationState(
    client,
    orgId,
    jobNumber,
    jobHeader.warehouse,
    { jobId }
  );
  if (!stagingState.blockingReason) {
    return jobHeader;
  }

  const nextJob = cloneValue(jobHeader);
  nextJob.isStagedForPickup = false;
  nextJob.updatedAt = new Date().toISOString();
  nextJob.updatedBy = actor;
  const savedJob = await saveJobRecordById(client, orgId, nextJob);
  warnings.push(reason);
  return savedJob;
}

function findExistingPhaseForPayloadEntry(entry, phaseNumber, existingPhases = []) {
  const phaseId = asTrimmedString(entry?.phaseId || entry?.id);
  if (phaseId) {
    const byId = existingPhases.find((phase) => asTrimmedString(phase.phaseId || phase.id) === phaseId);
    if (byId) {
      return byId;
    }
  }

  return existingPhases.find((phase) => Number(phase.phaseNumber) === Number(phaseNumber)) || null;
}

function normalizePhaseInputsFromPayload(payload, fallbackPrimaryPhase = null, existingPhases = []) {
  const rawPhases = getPayloadPhaseEntries(payload);
  if (!rawPhases.length) {
    return [buildDefaultPhaseInputFromJobPayload(payload, fallbackPrimaryPhase || {})];
  }

  const seenPhaseNumbers = new Set();
  return rawPhases.map((entry, index) => {
    const phaseNumber = normalizeJobPhaseNumber(entry?.phaseNumber ?? index + 1, `Phases[${index + 1}].PhaseNumber`);
    if (seenPhaseNumbers.has(phaseNumber)) {
      throw new HttpError(400, `Phase ${phaseNumber} already exists on this job.`);
    }
    seenPhaseNumbers.add(phaseNumber);
    const installDate = normalizeDateString(entry?.installDate ?? entry?.dueDate, `Phases[${index + 1}].InstallDate`, true);
    const existingPhase = findExistingPhaseForPayloadEntry(entry, phaseNumber, existingPhases);
    const workflowStatusInput = asTrimmedString(
      entry?.workflowStatus ?? entry?.workflow_status ?? entry?.phaseWorkflowStatus
    );
    return {
      phaseId: asTrimmedString(entry?.phaseId || entry?.id),
      phaseNumber,
      sections: normalizeJobWorkScope(entry?.workScope ?? entry?.sections ?? ''),
      installDate,
      installEndDate: normalizePhaseInstallEndDate(
        entry?.installEndDate ?? entry?.install_end_date ?? entry?.endDate,
        installDate,
        `Phases[${index + 1}].InstallEndDate`
      ),
      crewLeader: asTrimmedString(entry?.crewLeader),
      laborStatus: normalizeJobPhaseLaborStatus(entry?.laborStatus || entry?.status),
      workflowStatus: normalizeJobPhaseWorkflowStatus(
        workflowStatusInput ||
        existingPhase?.workflowStatus ||
        existingPhase?.workflow_status ||
        (phaseNumber === 1 ? 'ACTIVE' : 'PLACEHOLDER')
      ),
      isPrimary: entry?.isPrimary === true || index === 0,
      requirements: Array.isArray(entry?.requirements) ? entry.requirements : [],
      caulkRequirements: Array.isArray(entry?.caulkRequirements) ? entry.caulkRequirements : [],
    };
  });
}

function attachPhaseIdentityToEntries(entries, phase) {
  return (Array.isArray(entries) ? entries : []).map((entry) => ({
    ...entry,
    phaseId: asTrimmedString(phase.phaseId),
    phaseNumber: phase.phaseNumber,
  }));
}

function buildPhaseScopedRequirementPayload(payload, savedPhases) {
  const rawPhases = getPayloadPhaseEntries(payload);
  if (!rawPhases.length) {
    const primaryPhase = savedPhases.find((entry) => entry.isPrimary) || savedPhases[0];
    return attachPhaseIdentityToEntries(payload.requirements, primaryPhase);
  }

  const savedByPhaseNumber = new Map(savedPhases.map((entry) => [Number(entry.phaseNumber), entry]));
  const response = [];
  for (let index = 0; index < rawPhases.length; index += 1) {
    const phaseNumber = normalizeJobPhaseNumber(rawPhases[index]?.phaseNumber ?? index + 1, `Phases[${index + 1}].PhaseNumber`);
    const phase = savedByPhaseNumber.get(phaseNumber);
    response.push(...attachPhaseIdentityToEntries(rawPhases[index]?.requirements, phase));
  }
  return response;
}

function buildPhaseScopedCaulkRequirementPayload(payload, savedPhases) {
  const rawPhases = getPayloadPhaseEntries(payload);
  if (!rawPhases.length) {
    const primaryPhase = savedPhases.find((entry) => entry.isPrimary) || savedPhases[0];
    return attachPhaseIdentityToEntries(payload.caulkRequirements, primaryPhase);
  }

  const savedByPhaseNumber = new Map(savedPhases.map((entry) => [Number(entry.phaseNumber), entry]));
  const response = [];
  for (let index = 0; index < rawPhases.length; index += 1) {
    const phaseNumber = normalizeJobPhaseNumber(rawPhases[index]?.phaseNumber ?? index + 1, `Phases[${index + 1}].PhaseNumber`);
    const phase = savedByPhaseNumber.get(phaseNumber);
    response.push(...attachPhaseIdentityToEntries(rawPhases[index]?.caulkRequirements, phase));
  }
  return response;
}

function mergeRetainedPhaseRequirements(existingRequirements, incomingRequirements, phasesToReplace) {
  const replacingPhaseIds = new Set((Array.isArray(phasesToReplace) ? phasesToReplace : []).map((entry) => asTrimmedString(entry.phaseId)).filter(Boolean));
  if (!replacingPhaseIds.size) {
    return incomingRequirements;
  }

  return [
    ...existingRequirements.filter((entry) => !replacingPhaseIds.has(asTrimmedString(entry.phaseId))),
    ...incomingRequirements,
  ];
}

function getRestoredAllocatableFeet(entry) {
  return getAllocationReservationState(entry) === 'WITH_INSTALL_DATE' ? integerOrZero(entry?.allocatedFeet) : 0;
}

async function createJob(client, orgId, payload, actor) {
  const warnings = [];
  const jobNumber = normalizeJobNumberDigits(payload.jobNumber, 'Job ID number');
  const phaseInputs = normalizePhaseInputsFromPayload(payload);
  const primaryPhaseInput = phaseInputs.find((entry) => entry.isPrimary) || phaseInputs[0];
  const duplicatePayload = { ...payload, workScope: primaryPhaseInput.sections, sections: primaryPhaseInput.sections };
  const sameJobNumberJobs = await listJobsByNumber(client, orgId, jobNumber);
  const duplicateResult = buildJobDuplicateCheckResult({
    jobNumber,
    workScopeInput: getJobDuplicateWorkScopeInput(duplicatePayload),
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
  const sections = normalizeJobWorkScope(primaryPhaseInput.sections);
  const installDate = primaryPhaseInput.installDate;
  const crewLeader = asTrimmedString(primaryPhaseInput.crewLeader);
  const lifecycleStatus = normalizeJobLifecycleStatus(payload.lifecycleStatus);
  const notes = asTrimmedString(payload.notes);
  const nowIso = new Date().toISOString();
  const hasNestedPhasePayload = getPayloadPhaseEntries(payload).length > 0;
  const rawRequirementPayload = hasNestedPhasePayload
    ? phaseInputs.flatMap((phase) => attachPhaseIdentityToEntries(phase.requirements, phase))
    : (payload.requirements || []);
  const rawCaulkRequirementPayload = hasNestedPhasePayload
    ? phaseInputs.flatMap((phase) => attachPhaseIdentityToEntries(phase.caulkRequirements, phase))
    : (payload.caulkRequirements || []);
  const hasRawMaterials = (Array.isArray(rawRequirementPayload) && rawRequirementPayload.length > 0) ||
    (Array.isArray(rawCaulkRequirementPayload) && rawCaulkRequirementPayload.length > 0);
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
    hasRawMaterials ? [{ requiredFeet: 1 }] : [],
    []
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

  const savedPhases = await replaceJobPhasesForJob(client, orgId, nextHeader, phaseInputs, actor, nowIso);
  const incomingRequirementsRaw = dedupeJobRequirements(
    buildPhaseScopedRequirementPayload(payload, savedPhases),
    warnings
  );
  const incomingRequirements = await normalizeJobRequirementEntriesForWrite(
    client,
    orgId,
    incomingRequirementsRaw
  );
  const normalizedCaulkRequirements = await normalizeJobCaulkRequirementEntries(
    client,
    orgId,
    buildPhaseScopedCaulkRequirementPayload(payload, savedPhases)
  );
  const persistedFlags = derivePersistedJobMaterialFlags(
    nextHeader,
    payload,
    incomingRequirements,
    normalizedCaulkRequirements
  );
  if (
    persistedFlags.isLaborOnly !== nextHeader.isLaborOnly ||
    persistedFlags.isStagedForPickup !== nextHeader.isStagedForPickup
  ) {
    nextHeader.isLaborOnly = persistedFlags.isLaborOnly;
    nextHeader.isStagedForPickup = persistedFlags.isStagedForPickup;
    nextHeader.updatedAt = nowIso;
    nextHeader.updatedBy = actor;
    nextHeader = await saveJobRecordById(client, orgId, nextHeader);
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
    merged[`${asTrimmedString(existing.phaseId) || 'default'}|${existingKey}`] = {
      phaseId: existing.phaseId,
      phaseNumber: existing.phaseNumber,
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
    const incomingMergeKey = `${asTrimmedString(incoming.phaseId) || asTrimmedString(incoming.phaseNumber) || 'default'}|${incomingKey}`;

    if (!merged[incomingMergeKey]) {
      merged[incomingMergeKey] = incoming;
      continue;
    }

    merged[incomingMergeKey].manufacturer = incoming.manufacturer;
    merged[incomingMergeKey].filmName = incoming.filmName;
    merged[incomingMergeKey].requiredFeet += incoming.requiredFeet;
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
  crewLeader,
  options = {}
) {
  const jobId = asTrimmedString(options.jobId);
  const allocations = jobId
    ? await listAllocationsByJobId(client, orgId, jobId)
    : await listAllocationsByJob(client, orgId, jobNumber);
  const filmOrders = jobId
    ? await listFilmOrdersByJobId(client, orgId, jobId)
    : await listFilmOrdersByJob(client, orgId, jobNumber);
  const phaseSchedulesByRequirementId = {};
  const scheduledPhases = Array.isArray(options.phases) ? options.phases : [];
  if (jobId && scheduledPhases.length) {
    const phaseById = new Map(
      scheduledPhases
        .map((phase) => [asTrimmedString(phase.phaseId), phase])
        .filter(([phaseId]) => Boolean(phaseId))
    );
    const requirements = await listJobRequirementsByJobId(client, orgId, jobId);
    for (let index = 0; index < requirements.length; index += 1) {
      const phase = phaseById.get(asTrimmedString(requirements[index].phaseId));
      if (!phase) {
        continue;
      }
      phaseSchedulesByRequirementId[asTrimmedString(requirements[index].id || requirements[index].requirementId)] = {
        installDate: asTrimmedString(phase.installDate),
        crewLeader: asTrimmedString(phase.crewLeader),
      };
    }
  }
  let updatedAllocationCount = 0;
  let updatedFilmOrderCount = 0;
  const installDateChanged =
    options.forceScheduleRefresh === true ||
    asTrimmedString(previousInstallDate) !== asTrimmedString(installDate);
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

    const schedule = phaseSchedulesByRequirementId[asTrimmedString(allocation.requirementId)] || { installDate, crewLeader };
    if (
      Object.keys(phaseSchedulesByRequirementId).length &&
      !phaseSchedulesByRequirementId[asTrimmedString(allocation.requirementId)]
    ) {
      continue;
    }

    if (allocation.installDate === schedule.installDate && allocation.crewLeader === schedule.crewLeader) {
      continue;
    }

    allocation.installDate = schedule.installDate;
    allocation.crewLeader = schedule.crewLeader;
    await saveAllocationRecord(client, orgId, allocation);
    updatedAllocationCount += 1;
  }

  for (let index = 0; index < filmOrders.length; index += 1) {
    const filmOrder = cloneValue(filmOrders[index]);
    if (filmOrder.status === 'CANCELLED' || filmOrder.status === 'FULFILLED') {
      continue;
    }

    const schedule = phaseSchedulesByRequirementId[asTrimmedString(filmOrder.requirementId)] || { installDate, crewLeader };
    if (
      Object.keys(phaseSchedulesByRequirementId).length &&
      !phaseSchedulesByRequirementId[asTrimmedString(filmOrder.requirementId)]
    ) {
      continue;
    }

    if (filmOrder.installDate === schedule.installDate && filmOrder.crewLeader === schedule.crewLeader) {
      continue;
    }

    filmOrder.installDate = schedule.installDate;
    filmOrder.crewLeader = schedule.crewLeader;
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
  const nowIso = new Date().toISOString();
  const header = target.usedJobId
    ? target.job
    : await ensureJobHeaderForUpdate(client, orgId, jobNumber, updatePayload, actor, nowIso);
  if (normalizeJobLifecycleStatus(header.lifecycleStatus) !== 'ACTIVE') {
    throw new HttpError(400, `Job ${jobNumber} is closed. Reopen it before editing.`);
  }
  const nextHeader = cloneValue(header);
  const existingPhases = header?.id ? await listJobPhasesByJobId(client, orgId, header.id) : [];
  const primaryExistingPhase = existingPhases.find((entry) => entry.isPrimary) || existingPhases[0] || null;
  const phaseInputs = normalizePhaseInputsFromPayload(updatePayload, primaryExistingPhase, existingPhases);
  const primaryPhaseInput = phaseInputs.find((entry) => entry.isPrimary) || phaseInputs[0];

  if (updatePayload.warehouse !== undefined) {
    nextHeader.warehouse = normalizeJobWarehouse(updatePayload.warehouse);
  }

  if (hasWorkScopeInput(updatePayload)) {
    nextHeader.sections = normalizeJobWorkScope(primaryPhaseInput.sections ?? getWorkScopeInput(updatePayload));
  }

  if (updatePayload.installDate !== undefined || updatePayload.dueDate !== undefined) {
    nextHeader.installDate = primaryPhaseInput.installDate;
  }

  if (updatePayload.crewLeader !== undefined) {
    nextHeader.crewLeader = asTrimmedString(primaryPhaseInput.crewLeader);
  }

  if (updatePayload.lifecycleStatus !== undefined) {
    nextHeader.lifecycleStatus = normalizeJobLifecycleStatus(updatePayload.lifecycleStatus);
  }

  if (updatePayload.notes !== undefined) {
    nextHeader.notes = asTrimmedString(updatePayload.notes);
  }

  nextHeader.updatedAt = nowIso;
  nextHeader.updatedBy = actor;

  let savedHeader = target.usedJobId
    ? await saveJobRecordById(client, orgId, nextHeader)
    : await saveJobRecord(client, orgId, nextHeader);
  const savedPhases = await replaceJobPhasesForJob(client, orgId, savedHeader, phaseInputs, actor, nowIso);
  const replacingPhases = getPayloadPhaseEntries(updatePayload).length
    ? savedPhases
    : [savedPhases.find((entry) => entry.isPrimary) || savedPhases[0]];
  const phaseScopedRequirementsRaw = dedupeJobRequirements(
    buildPhaseScopedRequirementPayload(updatePayload, savedPhases),
    warnings
  );
  const requirements = await normalizeJobRequirementEntriesForWrite(client, orgId, phaseScopedRequirementsRaw);
  const normalizedCaulkRequirements = await normalizeJobCaulkRequirementEntries(
    client,
    orgId,
    buildPhaseScopedCaulkRequirementPayload(updatePayload, savedPhases)
  );
  const materialFlags = derivePersistedJobMaterialFlags(
    savedHeader,
    updatePayload,
    requirements,
    normalizedCaulkRequirements
  );
  if (
    materialFlags.isLaborOnly !== savedHeader.isLaborOnly ||
    materialFlags.isStagedForPickup !== savedHeader.isStagedForPickup
  ) {
    savedHeader.isLaborOnly = materialFlags.isLaborOnly;
    savedHeader.isStagedForPickup = materialFlags.isStagedForPickup;
    savedHeader.updatedAt = nowIso;
    savedHeader.updatedBy = actor;
    savedHeader = target.usedJobId
      ? await saveJobRecordById(client, orgId, savedHeader)
      : await saveJobRecord(client, orgId, savedHeader);
  }
  const existingRequirements = target.usedJobId
    ? await listJobRequirementsByJobId(client, orgId, target.jobId)
    : await listJobRequirementsByJob(client, orgId, jobNumber);
  const existingByKey = buildJobRequirementsByLookupKey(existingRequirements);
  const replacementRequirements = getPayloadPhaseEntries(updatePayload).length
    ? requirements
    : mergeRetainedPhaseRequirements(existingRequirements, requirements, replacingPhases);
  await replaceJobRequirementsForJob(
    client,
    orgId,
    savedHeader,
    buildRequirementRowsForReplace(jobNumber, replacementRequirements, existingByKey, actor, nowIso)
  );
  const existingCaulkRequirements = target.usedJobId
    ? await listJobCaulkRequirementsByJobId(client, orgId, target.jobId)
    : await listJobCaulkRequirementsByJob(client, orgId, jobNumber);
  const replacementCaulkRequirements = getPayloadPhaseEntries(updatePayload).length
    ? normalizedCaulkRequirements
    : mergeRetainedPhaseRequirements(existingCaulkRequirements, normalizedCaulkRequirements, replacingPhases);
  await replaceJobCaulkRequirementsForJob(
    client,
    orgId,
    savedHeader,
    replacementCaulkRequirements,
    actor,
    nowIso
  );

  const installDateChanged = asTrimmedString(header.installDate) !== asTrimmedString(savedHeader.installDate);
  const crewLeaderChanged =
    normalizeCrewLeaderKey(header.crewLeader) !== normalizeCrewLeaderKey(savedHeader.crewLeader);
  const phasePayloadChanged = getPayloadPhaseEntries(updatePayload).length > 0;
  if (installDateChanged || crewLeaderChanged || phasePayloadChanged) {
    const syncResult = await syncJobMetadataToActiveAllocationsAndOpenFilmOrders(
      client,
      orgId,
      jobNumber,
      actor,
      header.installDate,
      savedHeader.installDate,
      savedHeader.crewLeader,
      {
        jobId: savedHeader.id,
        phases: replacingPhases,
        forceScheduleRefresh: phasePayloadChanged,
      }
    );
    if (syncResult.updatedAllocationCount > 0 || syncResult.updatedFilmOrderCount > 0) {
      warnings.push(
        `Updated scheduling metadata on ${syncResult.updatedAllocationCount} active allocation${syncResult.updatedAllocationCount === 1 ? '' : 's'} and ${syncResult.updatedFilmOrderCount} open film order${syncResult.updatedFilmOrderCount === 1 ? '' : 's'}.`
      );
    }
  }

  savedHeader = await clearStagedPickupIfActiveMaterialBlocked(
    client,
    orgId,
    savedHeader,
    actor,
    warnings
  );

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

async function listCheckedOutBoxesForJobMutation(client, orgId, target, jobNumber) {
  const rows = await queryRows(
    client,
    `
      select box_id, status, last_checkout_job, last_checkout_job_id
      from app.boxes
      where org_id = $1
        and status = 'CHECKED_OUT'
    `,
    [orgId]
  );

  return rows.filter((entry) =>
    isCheckedOutBoxAssignedToJob(entry, {
      jobId: target.usedJobId ? target.jobId : '',
      jobNumber,
    })
  );
}

function toSafeDeleteJobError(error) {
  if (error instanceof HttpError && isExpectedDeleteJobHttpStatus(error.statusCode)) {
    return error;
  }

  return new DeleteJobOperationError();
}

class DeleteJobOperationError extends HttpError {
  constructor() {
    super(500, DELETE_JOB_FAILURE_MESSAGE);
    this.name = 'DeleteJobOperationError';
  }
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

async function executeDeleteJob(client, orgId, payload, actor, role) {
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

  const checkedOutBoxes = await listCheckedOutBoxesForJobMutation(client, orgId, target, jobNumber);
  if (checkedOutBoxes.length) {
    const listedBoxes = checkedOutBoxes
      .slice(0, 5)
      .map((box) => asTrimmedString(box.box_id || box.boxId))
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

async function deleteJob(client, orgId, payload, actor, role) {
  try {
    return await executeDeleteJob(client, orgId, payload, actor, role);
  } catch (error) {
    throw toSafeDeleteJobError(error);
  }
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
    installDate: asTrimmedString(selectedRequirement?.phaseInstallDate || existingJob?.installDate),
    crewLeader: asTrimmedString(selectedRequirement?.phaseCrewLeader || existingJob?.crewLeader),
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
  const materialType = asTrimmedString(payload.materialType || payload.material_type).toUpperCase() === 'CAULK'
    ? 'CAULK'
    : 'FILM';
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

  if (materialType === 'CAULK') {
    await saveJobCaulkRequirementState(
      client,
      orgId,
      {
        jobId,
        requirementId,
        status: nextStatus,
      },
      actor
    );
  } else {
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
  }

  if (nextStatus === 'ACTIVE') {
    await clearStagedPickupIfActiveMaterialBlocked(
      client,
      orgId,
      existingJob,
      actor,
      warnings,
      'Staged pickup was cleared because an active requirement now has material that is not fully checked out.'
    );
  }

  return ok(await buildJobDetailById(client, orgId, jobId), warnings);
}

async function setJobPhaseLaborState(client, orgId, payload, actor) {
  const warnings = [];
  const suppliedJobId = asTrimmedString(payload.jobId);
  if (suppliedJobId) {
    requireUuid(suppliedJobId, 'jobId');
  }
  const phaseId = requireUuid(payload.phaseId, 'PhaseId');
  const hasLaborStatus =
    Object.prototype.hasOwnProperty.call(payload || {}, 'status') ||
    Object.prototype.hasOwnProperty.call(payload || {}, 'laborStatus') ||
    Object.prototype.hasOwnProperty.call(payload || {}, 'labor_status');
  const hasWorkflowStatus =
    Object.prototype.hasOwnProperty.call(payload || {}, 'workflowStatus') ||
    Object.prototype.hasOwnProperty.call(payload || {}, 'workflow_status') ||
    Object.prototype.hasOwnProperty.call(payload || {}, 'phaseWorkflowStatus');
  if (!hasLaborStatus && !hasWorkflowStatus) {
    throw new HttpError(400, 'Phase state update requires a status or workflowStatus.');
  }
  const nextStatus = normalizeJobPhaseLaborStatus(payload.status || payload.laborStatus || payload.labor_status);
  const nextWorkflowStatus = normalizeJobPhaseWorkflowStatus(
    payload.workflowStatus || payload.workflow_status || payload.phaseWorkflowStatus
  );

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
      throw new HttpError(409, `Job ${jobNumber} has multiple work scopes. Open the exact job before changing phase state.`);
    }
    existingJob = sameNumberJobs[0] || null;
    if (!existingJob) {
      throw new HttpError(404, `Job ${jobNumber} was not found.`);
    }
    jobId = existingJob.id;
  }

  if (existingJob && normalizeJobLifecycleStatus(existingJob.lifecycleStatus) !== 'ACTIVE') {
    throw new HttpError(400, `Job ${jobNumber} is closed. Reopen it before changing phase state.`);
  }

  await saveJobPhaseLaborState(
    client,
    orgId,
    {
      jobId,
      phaseId,
      ...(hasLaborStatus ? { status: nextStatus } : {}),
      ...(hasWorkflowStatus ? { workflowStatus: nextWorkflowStatus } : {})
    },
    actor
  );
  if (hasWorkflowStatus && nextWorkflowStatus === 'ACTIVE') {
    await clearStagedPickupIfActiveMaterialBlocked(
      client,
      orgId,
      existingJob,
      actor,
      warnings,
      'Staged pickup was cleared because an active phase has material that is not fully checked out.'
    );
  }
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

async function manualFulfillFilmOrder(client, orgId, payload, actor) {
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

  const { orgId: _requestOrgId, ...payloadWithoutRequestOrg } = payload || {};
  const rpcPayload = {
    ...payloadWithoutRequestOrg,
    ...(target.usedJobId ? { jobId: target.jobId, jobNumber: target.jobNumber } : {})
  };
  const row = await queryRow(
    client,
    `
      select public.api_acl_film_orders_manual_fulfill(
        $1::uuid,
        $2::text,
        $3::jsonb
      ) as result
    `,
    [orgId, asTrimmedString(actor), JSON.stringify(rpcPayload)]
  );
  const result = row?.result || {};
  const filmOrder = await findFilmOrderById(client, orgId, filmOrderId);
  if (!filmOrder) {
    throw new HttpError(500, 'Film order was manually fulfilled but could not be reloaded.');
  }

  return ok(
    toPublicFilmOrder(
      filmOrder,
      await buildPublicFilmOrderLinkedBoxes(client, orgId, filmOrder.filmOrderId)
    ),
    Array.isArray(result.warnings) ? result.warnings : []
  );
}

async function correctFilmOrderReceipt(client, orgId, payload, actor) {
  const row = await queryRow(
    client,
    `
      select public.api_acl_film_orders_correct_received_lf(
        $1::uuid,
        $2::text,
        $3::jsonb
      ) as result
    `,
    [orgId, asTrimmedString(actor), JSON.stringify(payload || {})]
  );
  const result = row?.result || {};
  return ok(result, Array.isArray(result.warnings) ? result.warnings : []);
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

  await queryRow(client, `select set_config('app.actor', $1, true)`, [
    asTrimmedString(actor) || 'system',
  ]);
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
  setJobPhaseLaborState,
  cancelJob,
  removeJobBoxAllocation,
  clearAllocationPlannerSuppression,
  deleteFilmOrder,
  manualFulfillFilmOrder,
  correctFilmOrderReceipt,
  deleteBox,
};
