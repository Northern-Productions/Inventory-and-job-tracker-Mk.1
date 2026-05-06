import {
  asTrimmedString,
  listBoxesByIds,
  listAllocationsByJob,
  listFilmOrdersByJob,
  listJobRequirementsByJob,
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

function buildJobStagingValidationState({
  jobNumber,
  warehouse,
  allocations,
  filmOrders,
  requirements,
  caulkRequirements,
  caulkAllocations,
  boxes,
  pendingTransfersByBoxRecordId
}) {
  const boxById = indexBoxesById(boxes);
  const publicRequirements = buildPublicJobRequirementEntries(requirements, allocations, boxById);
  const publicCaulkRequirements = buildPublicCaulkRequirementEntries(
    caulkRequirements,
    caulkAllocations,
    {
      jobNumber,
      jobWarehouse: warehouse
    }
  );
  const filmTransferAlerts = buildJobFilmTransferAlerts(
    warehouse,
    allocations,
    boxById,
    pendingTransfersByBoxRecordId
  );
  const caulkTransferAlerts = buildJobCaulkTransferAlerts(warehouse, caulkAllocations);

  return {
    jobNumber,
    warehouse,
    allocations,
    filmOrders,
    requirements,
    caulkRequirements,
    caulkAllocations,
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
      allocations,
      filmOrders,
      caulkAllocations,
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
  const loadJobCaulkRequirementsByJob = deps.listJobCaulkRequirementsByJob || listJobCaulkRequirementsByJob;
  const loadCaulkJobAllocationsByJob = deps.listCaulkJobAllocationsByJob || listCaulkJobAllocationsByJob;
  const loadBoxesByIds = deps.listBoxesByIds || listBoxesByIds;
  const loadPendingTransfersByBoxRecordIds =
    deps.listPendingBoxTransfersByBoxRecordIds || listPendingBoxTransfersByBoxRecordIds;
  const buildPendingTransfersByBoxRecordId =
    deps.indexPendingBoxTransfersByBoxRecordId || indexPendingBoxTransfersByBoxRecordId;
  const collectBoxIds = deps.collectAllocationBoxIds || collectAllocationBoxIds;
  const buildValidationState = deps.buildJobStagingValidationState || buildJobStagingValidationState;

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
  const boxes = Array.isArray(seedData.boxes)
    ? seedData.boxes
    : await loadBoxesByIds(client, orgId, collectBoxIds(allocations));
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
