import {
  HttpError,
  asTrimmedString,
  listBoxesByIds,
  listAllocationsByJob,
  listFilmOrdersByJob,
  listJobRequirementsByJob,
  listJobPhasesByJobId,
  listJobCaulkRequirementsByJob,
  listCaulkJobAllocationsByJob,
  findJobByNumber,
  saveJobRecord,
  listPendingBoxTransfersByBoxRecordIds,
  indexPendingBoxTransfersByBoxRecordId,
} from '../../runtimeDeps.mjs';
import {
  buildPublicJobRequirementEntries,
  buildPublicCaulkRequirementEntries,
} from '../runtimeAllocationCoverage.mjs';
import { buildJobCaulkTransferAlerts, buildJobFilmTransferAlerts } from '../runtimeTransferUsage.mjs';
import {
  buildLegacyJobHeaderFromData,
  deriveJobStatusFromLegacyAllocationData,
  getJobStagingBlockingReason,
  isPhaseWorkflowActive,
} from '../runtimeJobSummaries.mjs';

function collectAllocationBoxIds(allocations) {
  const boxIds = new Set();

  for (let index = 0; index < (Array.isArray(allocations) ? allocations : []).length; index += 1) {
    const boxId = asTrimmedString(allocations[index]?.boxId).toUpperCase();
    if (boxId) {
      boxIds.add(boxId);
    }
  }

  return Array.from(boxIds);
}

function indexBoxesById(boxes) {
  const indexed = {};

  for (let index = 0; index < (Array.isArray(boxes) ? boxes : []).length; index += 1) {
    const box = boxes[index];
    const boxId = asTrimmedString(box?.boxId).toUpperCase();
    if (boxId) {
      indexed[boxId] = box;
    }
  }

  return indexed;
}

function getPhaseId(entry) {
  return asTrimmedString(entry?.phaseId || entry?.phase_id);
}

function resolveRequirementIdentity(entry, fields) {
  const values = fields
    .map((field) => asTrimmedString(entry?.[field]))
    .filter(Boolean);
  const distinctValues = new Set(values);
  if (distinctValues.size > 1) {
    throw new HttpError(500, 'Conflicting requirement identity aliases.');
  }
  return values[0] || '';
}

// Requirement rows use app.job_requirements.id; linked rows have their own unrelated id.
function getCanonicalRequirementId(entry) {
  return resolveRequirementIdentity(entry, ['requirementId', 'requirement_id', 'id']);
}

function getLinkedRequirementId(entry) {
  return resolveRequirementIdentity(entry, ['requirementId', 'requirement_id']);
}

function normalizeActiveRequirementIdentities(entries) {
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    const requirementId = getCanonicalRequirementId(entry);
    if (!requirementId) {
      throw new HttpError(500, 'Active requirement is missing its canonical identity.');
    }
    const normalizedId = asTrimmedString(entry?.id);
    return entry?.requirementId === requirementId && entry?.id === normalizedId
      ? entry
      : {
          ...entry,
          id: normalizedId || undefined,
          requirementId,
        };
  });
}

function filterForActivePhases(entries, phases, fallbackPhaseId = '') {
  const phaseEntries = Array.isArray(phases) ? phases : [];
  if (!phaseEntries.length) {
    return Array.isArray(entries) ? entries : [];
  }

  const activePhaseIds = new Set(
    phaseEntries
      .filter(isPhaseWorkflowActive)
      .map((entry) => getPhaseId(entry))
      .filter(Boolean)
  );
  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    const phaseId = getPhaseId(entry);
    if (phaseId) {
      return activePhaseIds.has(phaseId);
    }
    return Boolean(fallbackPhaseId && activePhaseIds.has(fallbackPhaseId));
  });
}

function filterLinkedForActiveRequirements(entries, activeRequirements, phases, fallbackPhaseId = '') {
  const phaseEntries = Array.isArray(phases) ? phases : [];
  if (!phaseEntries.length) {
    return Array.isArray(entries) ? entries : [];
  }
  const requirementIds = new Set(
    normalizeActiveRequirementIdentities(activeRequirements)
      .map((entry) => entry.requirementId)
  );
  const activePhaseIds = new Set(
    phaseEntries
      .filter(isPhaseWorkflowActive)
      .map((entry) => getPhaseId(entry))
      .filter(Boolean)
  );
  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    const requirementId = getLinkedRequirementId(entry);
    if (requirementId) {
      return requirementIds.has(requirementId);
    }
    const phaseId = getPhaseId(entry);
    if (phaseId) {
      return activePhaseIds.has(phaseId);
    }
    return Boolean(fallbackPhaseId && activePhaseIds.has(fallbackPhaseId));
  });
}

function buildJobStagingValidationState({
  jobNumber,
  warehouse,
  phases,
  allocations,
  filmOrders,
  requirements,
  caulkRequirements,
  caulkAllocations,
  boxes,
  pendingTransfersByBoxRecordId
}) {
  const phaseEntries = Array.isArray(phases) ? phases : [];
  const fallbackPhaseId = getPhaseId(phaseEntries.find((entry) => entry?.isPrimary) || phaseEntries[0]);
  const activeRequirements = filterForActivePhases(requirements, phaseEntries, fallbackPhaseId);
  const activeCaulkRequirements = filterForActivePhases(caulkRequirements, phaseEntries, fallbackPhaseId);
  const normalizedActiveRequirements = phaseEntries.length
    ? normalizeActiveRequirementIdentities(activeRequirements)
    : activeRequirements;
  const normalizedActiveCaulkRequirements = phaseEntries.length
    ? normalizeActiveRequirementIdentities(activeCaulkRequirements)
    : activeCaulkRequirements;
  const activeAllocations = filterLinkedForActiveRequirements(
    allocations,
    normalizedActiveRequirements,
    phaseEntries,
    fallbackPhaseId
  );
  const activeFilmOrders = filterLinkedForActiveRequirements(
    filmOrders,
    normalizedActiveRequirements,
    phaseEntries,
    fallbackPhaseId
  );
  const activeCaulkAllocations = filterLinkedForActiveRequirements(
    caulkAllocations,
    normalizedActiveCaulkRequirements,
    phaseEntries,
    fallbackPhaseId
  );
  const boxById = indexBoxesById(boxes);
  const publicRequirements = buildPublicJobRequirementEntries(
    normalizedActiveRequirements,
    activeAllocations,
    boxById
  );
  const publicCaulkRequirements = buildPublicCaulkRequirementEntries(
    normalizedActiveCaulkRequirements,
    activeCaulkAllocations,
    {
      jobNumber,
      jobWarehouse: warehouse
    }
  );
  const filmTransferAlerts = buildJobFilmTransferAlerts(
    warehouse,
    activeAllocations,
    boxById,
    pendingTransfersByBoxRecordId
  );
  const caulkTransferAlerts = buildJobCaulkTransferAlerts(warehouse, activeCaulkAllocations);

  return {
    jobNumber,
    warehouse,
    phases: phaseEntries,
    allocations: activeAllocations,
    filmOrders: activeFilmOrders,
    requirements: normalizedActiveRequirements,
    caulkRequirements: normalizedActiveCaulkRequirements,
    caulkAllocations: activeCaulkAllocations,
    boxes,
    boxById,
    pendingTransfersByBoxRecordId,
    publicRequirements,
    publicCaulkRequirements,
    filmTransferAlerts,
    caulkTransferAlerts,
    blockingReason: getJobStagingBlockingReason(
      publicRequirements,
      publicCaulkRequirements,
      activeAllocations,
      activeFilmOrders,
      activeCaulkAllocations,
      filmTransferAlerts,
      caulkTransferAlerts,
      boxById
    )
  };
}

async function loadJobStagingValidationState(
  client,
  orgId,
  jobNumber,
  warehouse,
  seedData = {},
  deps = {}
) {
  const loadAllocationsByJob = deps.listAllocationsByJob || listAllocationsByJob;
  const loadFilmOrdersByJob = deps.listFilmOrdersByJob || listFilmOrdersByJob;
  const loadJobRequirementsByJob = deps.listJobRequirementsByJob || listJobRequirementsByJob;
  const loadJobPhasesByJobId = deps.listJobPhasesByJobId || listJobPhasesByJobId;
  const loadJobCaulkRequirementsByJob = deps.listJobCaulkRequirementsByJob || listJobCaulkRequirementsByJob;
  const loadCaulkJobAllocationsByJob = deps.listCaulkJobAllocationsByJob || listCaulkJobAllocationsByJob;
  const loadBoxesByIds = deps.listBoxesByIds || listBoxesByIds;
  const loadPendingTransfersByBoxRecordIds =
    deps.listPendingBoxTransfersByBoxRecordIds || listPendingBoxTransfersByBoxRecordIds;
  const buildPendingTransfersByBoxRecordId =
    deps.indexPendingBoxTransfersByBoxRecordId || indexPendingBoxTransfersByBoxRecordId;
  const collectBoxIds = deps.collectAllocationBoxIds || collectAllocationBoxIds;
  const buildValidationState = deps.buildJobStagingValidationState || buildJobStagingValidationState;
  const phases = Array.isArray(seedData.phases)
    ? seedData.phases
    : seedData.jobId
      ? await loadJobPhasesByJobId(client, orgId, seedData.jobId)
      : [];

  const allocations = Array.isArray(seedData.allocations)
    ? seedData.allocations
    : await loadAllocationsByJob(client, orgId, jobNumber);
  const filmOrders = Array.isArray(seedData.filmOrders)
    ? seedData.filmOrders
    : await loadFilmOrdersByJob(client, orgId, jobNumber);
  const requirements = Array.isArray(seedData.requirements)
    ? seedData.requirements
    : await loadJobRequirementsByJob(client, orgId, jobNumber);
  const caulkRequirements = Array.isArray(seedData.caulkRequirements)
    ? seedData.caulkRequirements
    : await loadJobCaulkRequirementsByJob(client, orgId, jobNumber);
  const caulkAllocations = Array.isArray(seedData.caulkAllocations)
    ? seedData.caulkAllocations
    : await loadCaulkJobAllocationsByJob(client, orgId, jobNumber);
  const fallbackPhaseId = getPhaseId(phases.find((entry) => entry?.isPrimary) || phases[0]);
  const activeRequirements = filterForActivePhases(requirements, phases, fallbackPhaseId);
  const activeAllocations = filterLinkedForActiveRequirements(
    allocations,
    activeRequirements,
    phases,
    fallbackPhaseId
  );
  const boxes = Array.isArray(seedData.boxes)
    ? seedData.boxes
    : await loadBoxesByIds(client, orgId, collectBoxIds(activeAllocations));
  const pendingTransfersByBoxRecordId =
    seedData.pendingTransfersByBoxRecordId ||
    (boxes.length
      ? buildPendingTransfersByBoxRecordId(
          await loadPendingTransfersByBoxRecordIds(
            client,
            orgId,
            boxes.map((box) => box.id).filter(Boolean)
          )
        )
      : {});

  return buildValidationState({
    jobNumber,
    warehouse,
    phases,
    allocations,
    filmOrders,
    requirements,
    caulkRequirements,
    caulkAllocations,
    boxes,
    pendingTransfersByBoxRecordId
  });
}

async function resolveExistingOrLegacyJobHeader(client, orgId, jobNumber, actor, nowIso) {
  const existing = await findJobByNumber(client, orgId, jobNumber);
  if (existing) {
    return {
      header: existing,
      allocations: null,
      filmOrders: null,
    };
  }

  const allocations = await listAllocationsByJob(client, orgId, jobNumber);
  const filmOrders = await listFilmOrdersByJob(client, orgId, jobNumber);
  const requirements = await listJobRequirementsByJob(client, orgId, jobNumber);
  if (!allocations.length && !filmOrders.length && !requirements.length) {
    return {
      header: null,
      allocations,
      filmOrders,
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
    filmOrders,
  };
}

export {
  collectAllocationBoxIds,
  buildJobStagingValidationState,
  loadJobStagingValidationState,
  resolveExistingOrLegacyJobHeader,
};
