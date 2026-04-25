// Purpose: Shared targeted job-detail loader for job and allocation detail views.
import { runParallelReadTasks } from '../../../db/client.mjs';
import {
  HttpError,
  asTrimmedString,
  requireString,
  findJobByNumber,
  listAllocationsByJob,
  listFilmOrdersByJob,
  listJobRequirementsByJob,
  listJobCaulkRequirementsByJob,
  listCaulkJobAllocationsByJob,
  listCaulkJobCheckoutsByJob,
  listRollHistoryByJob,
  listBoxes,
  listBoxesByIds,
  listFilmOrderLinksByFilmOrderIds,
  listPendingBoxTransfersByBoxRecordIds,
  indexPendingBoxTransfersByBoxRecordId,
  listActiveAllocationsForJobConflictCheck,
} from '../runtimeDeps.mjs';
import { listCaulkStock } from '../caulk.mjs';
import {
  buildAllocationJobSummary,
  buildPublicJobRequirementEntries,
  buildPublicCaulkRequirementEntries,
  resolveAllocationJobMetadata,
} from './runtimeAllocationCoverage.mjs';
import {
  buildJobListEntry,
  buildLegacyJobHeaderFromData,
  buildPublicAllocationEntriesForJob,
  buildPublicFilmOrdersForJob,
  deriveInStockReadinessStatus,
} from './runtimeJobSummaries.mjs';
import {
  buildJobFilmTransferAlerts,
  buildJobCaulkTransferAlerts,
  buildPublicJobUsageEntries,
  buildPublicJobUsageTimelineEntries,
} from './runtimeTransferUsage.mjs';

function collectJobBoxIds(allocations, rollHistory, filmOrderLinks = []) {
  const boxIds = new Set();
  const normalizedAllocations = Array.isArray(allocations) ? allocations : [];
  const normalizedRollHistory = Array.isArray(rollHistory) ? rollHistory : [];
  const normalizedFilmOrderLinks = Array.isArray(filmOrderLinks) ? filmOrderLinks : [];

  for (let index = 0; index < normalizedAllocations.length; index += 1) {
    const boxId = asTrimmedString(normalizedAllocations[index]?.boxId).toUpperCase();
    if (boxId) {
      boxIds.add(boxId);
    }
  }

  for (let index = 0; index < normalizedRollHistory.length; index += 1) {
    const boxId = asTrimmedString(normalizedRollHistory[index]?.boxId).toUpperCase();
    if (boxId) {
      boxIds.add(boxId);
    }
  }

  for (let index = 0; index < normalizedFilmOrderLinks.length; index += 1) {
    const boxId = asTrimmedString(normalizedFilmOrderLinks[index]?.boxId).toUpperCase();
    if (boxId) {
      boxIds.add(boxId);
    }
  }

  return Array.from(boxIds);
}

function collectActiveAllocationBoxIds(allocations) {
  const boxIds = new Set();
  const normalizedAllocations = Array.isArray(allocations) ? allocations : [];

  for (let index = 0; index < normalizedAllocations.length; index += 1) {
    const allocation = normalizedAllocations[index];
    if (allocation?.status !== 'ACTIVE') {
      continue;
    }

    const boxId = asTrimmedString(allocation.boxId).toUpperCase();
    if (boxId) {
      boxIds.add(boxId);
    }
  }

  return Array.from(boxIds);
}

function indexBoxesById(boxes) {
  const indexed = {};
  const entries = Array.isArray(boxes) ? boxes : [];

  for (let index = 0; index < entries.length; index += 1) {
    const box = entries[index];
    const boxId = asTrimmedString(box?.boxId).toUpperCase();
    if (boxId) {
      indexed[boxId] = box;
    }
  }

  return indexed;
}

async function loadBaseJobDetailData(client, orgId, normalizedJobNumber) {
  const storedHeader = await findJobByNumber(client, orgId, normalizedJobNumber);
  const allocations = await listAllocationsByJob(client, orgId, normalizedJobNumber);
  const filmOrders = await listFilmOrdersByJob(client, orgId, normalizedJobNumber);
  const filmOrderLinks = await listFilmOrderLinksByFilmOrderIds(
    client,
    orgId,
    filmOrders.map((entry) => entry.filmOrderId)
  );
  const requirements = await listJobRequirementsByJob(client, orgId, normalizedJobNumber);
  const caulkRequirements = await listJobCaulkRequirementsByJob(client, orgId, normalizedJobNumber);
  const caulkAllocations = await listCaulkJobAllocationsByJob(client, orgId, normalizedJobNumber);
  const caulkCheckouts = await listCaulkJobCheckoutsByJob(client, orgId, normalizedJobNumber);
  const rollHistory = await listRollHistoryByJob(client, orgId, normalizedJobNumber);

  return {
    storedHeader,
    allocations,
    filmOrders,
    filmOrderLinks,
    requirements,
    caulkRequirements,
    caulkAllocations,
    caulkCheckouts,
    rollHistory,
  };
}

async function loadBaseJobDetailDataWithPooledReads(orgId, normalizedJobNumber) {
  const [
    storedHeader,
    allocations,
    filmOrders,
    requirements,
    caulkRequirements,
    caulkAllocations,
    caulkCheckouts,
    rollHistory,
  ] = await runParallelReadTasks([
    (client) => findJobByNumber(client, orgId, normalizedJobNumber),
    (client) => listAllocationsByJob(client, orgId, normalizedJobNumber),
    (client) => listFilmOrdersByJob(client, orgId, normalizedJobNumber),
    (client) => listJobRequirementsByJob(client, orgId, normalizedJobNumber),
    (client) => listJobCaulkRequirementsByJob(client, orgId, normalizedJobNumber),
    (client) => listCaulkJobAllocationsByJob(client, orgId, normalizedJobNumber),
    (client) => listCaulkJobCheckoutsByJob(client, orgId, normalizedJobNumber),
    (client) => listRollHistoryByJob(client, orgId, normalizedJobNumber),
  ]);
  const filmOrderLinks = await runParallelReadTasks([
    (client) =>
      listFilmOrderLinksByFilmOrderIds(
        client,
        orgId,
        filmOrders.map((entry) => entry.filmOrderId)
      ),
  ]);

  return {
    storedHeader,
    allocations,
    filmOrders,
    filmOrderLinks: filmOrderLinks[0],
    requirements,
    caulkRequirements,
    caulkAllocations,
    caulkCheckouts,
    rollHistory,
  };
}

function resolveJobDetailBaseContext(normalizedJobNumber, baseData) {
  const {
    storedHeader,
    allocations,
    filmOrders,
    requirements,
    caulkRequirements,
    caulkAllocations,
  } = baseData;

  if (
    !storedHeader &&
    !allocations.length &&
    !filmOrders.length &&
    !requirements.length &&
    !caulkRequirements.length &&
    !caulkAllocations.length
  ) {
    throw new HttpError(404, 'Job not found.');
  }

  const header = storedHeader || buildLegacyJobHeaderFromData(normalizedJobNumber, allocations, filmOrders);
  const metadata = resolveAllocationJobMetadata(allocations, filmOrders);
  return {
    header,
    activeAllocationBoxIds: collectActiveAllocationBoxIds(allocations),
    boxIds: collectJobBoxIds(allocations, baseData.rollHistory, baseData.filmOrderLinks),
    installDate: asTrimmedString(header.installDate) || metadata.installDate,
    crewLeader: asTrimmedString(header.crewLeader) || metadata.crewLeader,
  };
}

function buildDetailContext(
  normalizedJobNumber,
  baseData,
  resolvedBaseContext,
  boxes,
  conflictAllocations,
  pendingTransfersByBoxRecordId,
  publicFilmOrders,
  allBoxes = [],
  caulkStockEntries = []
) {
  const boxById = indexBoxesById(boxes);
  const publicRequirements = buildPublicJobRequirementEntries(baseData.requirements, baseData.allocations, boxById);
  const publicCaulkRequirements = buildPublicCaulkRequirementEntries(
    baseData.caulkRequirements,
    baseData.caulkAllocations
  );
  const filmTransferAlerts = buildJobFilmTransferAlerts(
    resolvedBaseContext.header?.warehouse || '',
    baseData.allocations,
    boxById,
    allBoxes,
    caulkStockEntries,
    pendingTransfersByBoxRecordId
  );
  const caulkTransferAlerts = buildJobCaulkTransferAlerts(
    resolvedBaseContext.header?.warehouse || '',
    baseData.caulkAllocations
  );

  return {
    jobNumber: normalizedJobNumber,
    header: resolvedBaseContext.header,
    allocations: baseData.allocations,
    filmOrders: baseData.filmOrders,
    requirements: baseData.requirements,
    caulkRequirements: baseData.caulkRequirements,
    caulkAllocations: baseData.caulkAllocations,
    caulkCheckouts: baseData.caulkCheckouts,
    rollHistory: baseData.rollHistory,
    conflictAllocations,
    boxById,
    publicRequirements,
    publicCaulkRequirements,
    publicAllocations: buildPublicAllocationEntriesForJob(baseData.allocations, boxById),
    publicFilmOrders,
    usage: buildPublicJobUsageEntries(baseData.rollHistory, boxById),
    usageTimeline: buildPublicJobUsageTimelineEntries(
      normalizedJobNumber,
      baseData.rollHistory,
      boxById,
      baseData.caulkCheckouts,
      baseData.filmOrderLinks,
      baseData.filmOrders
    ),
    filmTransferAlerts,
    caulkTransferAlerts,
    allBoxes,
    caulkStockEntries,
  };
}

async function loadJobDetailContext(client, orgId, jobNumber) {
  const normalizedJobNumber = requireString(jobNumber, 'jobNumber');
  const baseData = await loadBaseJobDetailData(client, orgId, normalizedJobNumber);
  const resolvedBaseContext = resolveJobDetailBaseContext(normalizedJobNumber, baseData);
  const boxes = await listBoxesByIds(client, orgId, resolvedBaseContext.boxIds);
  const allBoxes = await listBoxes(client, orgId);
  const caulkStockEntries = await listCaulkStock(client, orgId, {});
  const conflictAllocations = await listActiveAllocationsForJobConflictCheck(
    client,
    orgId,
    resolvedBaseContext.activeAllocationBoxIds,
    resolvedBaseContext.installDate,
    normalizedJobNumber,
    resolvedBaseContext.crewLeader
  );
  const boxById = indexBoxesById(boxes);
  const pendingTransfersByBoxRecordId = indexPendingBoxTransfersByBoxRecordId(
    await listPendingBoxTransfersByBoxRecordIds(
      client,
      orgId,
      boxes.map((box) => box.id).filter(Boolean)
    )
  );
  const publicFilmOrders = await buildPublicFilmOrdersForJob(client, orgId, baseData.filmOrders, { boxById });

  return buildDetailContext(
    normalizedJobNumber,
    baseData,
    resolvedBaseContext,
    boxes,
    conflictAllocations,
    pendingTransfersByBoxRecordId,
    publicFilmOrders,
    allBoxes,
    caulkStockEntries
  );
}

async function loadJobDetailContextWithPooledReads(orgId, jobNumber) {
  const normalizedJobNumber = requireString(jobNumber, 'jobNumber');
  const baseData = await loadBaseJobDetailDataWithPooledReads(orgId, normalizedJobNumber);
  const resolvedBaseContext = resolveJobDetailBaseContext(normalizedJobNumber, baseData);
  const [boxes, conflictAllocations, allBoxes, caulkStockEntries] = await runParallelReadTasks([
    (client) => listBoxesByIds(client, orgId, resolvedBaseContext.boxIds),
    (client) =>
      listActiveAllocationsForJobConflictCheck(
        client,
        orgId,
        resolvedBaseContext.activeAllocationBoxIds,
        resolvedBaseContext.installDate,
        normalizedJobNumber,
        resolvedBaseContext.crewLeader
      ),
    (client) => listBoxes(client, orgId),
    (client) => listCaulkStock(client, orgId, {}),
  ]);
  const boxById = indexBoxesById(boxes);
  const [pendingTransfersByBoxRecordId, publicFilmOrders] = await runParallelReadTasks([
    async (client) =>
      indexPendingBoxTransfersByBoxRecordId(
        await listPendingBoxTransfersByBoxRecordIds(
          client,
          orgId,
          boxes.map((box) => box.id).filter(Boolean)
        )
      ),
    (client) => buildPublicFilmOrdersForJob(client, orgId, baseData.filmOrders, { boxById }),
  ]);

  return buildDetailContext(
    normalizedJobNumber,
    baseData,
    resolvedBaseContext,
    boxes,
    conflictAllocations,
    pendingTransfersByBoxRecordId,
    publicFilmOrders,
    allBoxes,
    caulkStockEntries
  );
}

function buildJobDetailPayload(detailContext) {
  return {
    summary: buildJobListEntry(
      detailContext.header,
      detailContext.publicRequirements,
      detailContext.allocations,
      detailContext.filmOrders,
      detailContext.conflictAllocations,
      detailContext.publicCaulkRequirements,
      detailContext.boxById,
      {
        allBoxes: detailContext.allBoxes,
        caulkAllocations: detailContext.caulkAllocations,
        caulkStockEntries: detailContext.caulkStockEntries,
      }
    ),
    requirements: detailContext.publicRequirements,
    allocations: detailContext.publicAllocations,
    usage: detailContext.usage,
    usageTimeline: detailContext.usageTimeline,
    caulkRequirements: detailContext.publicCaulkRequirements,
    caulkAllocations: detailContext.caulkAllocations,
    caulkCheckouts: detailContext.caulkCheckouts,
    filmOrders: detailContext.publicFilmOrders,
    filmTransferAlerts: detailContext.filmTransferAlerts,
    caulkTransferAlerts: detailContext.caulkTransferAlerts,
  };
}

function buildAllocationJobDetailPayload(detailContext) {
  const summary = buildAllocationJobSummary(
    detailContext.jobNumber,
    detailContext.allocations,
    detailContext.filmOrders,
    detailContext.publicRequirements,
    detailContext.publicCaulkRequirements,
    detailContext.header?.lifecycleStatus || 'ACTIVE',
    Boolean(detailContext.header?.isLaborOnly),
    Boolean(detailContext.header?.isStagedForPickup),
    detailContext.header?.installDate || '',
    detailContext.header?.crewLeader || '',
    detailContext.boxById
  );
  summary.status = deriveInStockReadinessStatus({
    lifecycleStatus: detailContext.header?.lifecycleStatus || 'ACTIVE',
    isLaborOnly: Boolean(detailContext.header?.isLaborOnly),
    requirements: detailContext.publicRequirements,
    caulkRequirements: detailContext.publicCaulkRequirements,
    allocations: detailContext.allocations,
    caulkAllocations: detailContext.caulkAllocations,
    filmOrders: detailContext.filmOrders,
    allBoxes: detailContext.allBoxes,
    boxById: detailContext.boxById,
    caulkStockEntries: detailContext.caulkStockEntries,
    jobWarehouse: detailContext.header?.warehouse || '',
    jobNumber: detailContext.jobNumber,
  });

  return {
    summary,
    allocations: detailContext.publicAllocations,
    usage: detailContext.usage,
    usageTimeline: detailContext.usageTimeline,
    caulkRequirements: detailContext.publicCaulkRequirements,
    caulkAllocations: detailContext.caulkAllocations,
    caulkCheckouts: detailContext.caulkCheckouts,
    filmOrders: detailContext.publicFilmOrders,
    filmTransferAlerts: detailContext.filmTransferAlerts,
    caulkTransferAlerts: detailContext.caulkTransferAlerts,
  };
}

export {
  collectJobBoxIds,
  collectActiveAllocationBoxIds,
  indexBoxesById,
  loadJobDetailContext,
  loadJobDetailContextWithPooledReads,
  buildJobDetailPayload,
  buildAllocationJobDetailPayload,
};
