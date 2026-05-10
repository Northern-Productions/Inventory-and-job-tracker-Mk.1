// Purpose: Shared targeted job-detail loader for job and allocation detail views.
import { runParallelReadTasks } from '../../../db/client.mjs';
import {
  HttpError,
  asTrimmedString,
  requireString,
  findJobByNumber,
  findJobById,
  listAllocationsByJob,
  listAllocationsByJobId,
  listFilmOrdersByJob,
  listFilmOrdersByJobId,
  listJobRequirementsByJob,
  listJobRequirementsByJobId,
  listJobCaulkRequirementsByJob,
  listJobCaulkRequirementsByJobId,
  listCaulkJobAllocationsByJob,
  listCaulkJobAllocationsByJobId,
  listCaulkJobCheckoutsByJob,
  listCaulkJobCheckoutsByJobId,
  listRollHistoryByJob,
  listRollHistoryByBox,
  listBoxesByIds,
  listFilmOrderLinksByFilmOrderIds,
  listPendingBoxTransfersByBoxRecordIds,
  indexPendingBoxTransfersByBoxRecordId,
  listActiveAllocationsForJobConflictCheck,
  listActiveAllocationsForJobIdConflictCheck,
} from '../runtimeDeps.mjs';
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

function getRollHistoryActivityTimestamp(entry) {
  return asTrimmedString(entry?.checkedInAt) || asTrimmedString(entry?.checkedOutAt) || '';
}

function toTimestampMs(value) {
  const timestamp = asTrimmedString(value);
  if (!timestamp) {
    return null;
  }

  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildRollHistoryAllocationWindowsByBox(allocations) {
  const grouped = {};
  const entries = Array.isArray(allocations) ? allocations : [];
  for (let index = 0; index < entries.length; index += 1) {
    const allocation = entries[index];
    const boxId = asTrimmedString(allocation?.boxId).toUpperCase();
    if (!boxId) {
      continue;
    }

    if (!grouped[boxId]) {
      grouped[boxId] = [];
    }

    grouped[boxId].push({
      startMs: toTimestampMs(allocation?.createdAt),
      endMs: toTimestampMs(allocation?.resolvedAt),
    });
  }

  return grouped;
}

function isTimestampInAllocationWindow(timestampMs, window) {
  if (timestampMs === null) {
    return false;
  }
  if (window.startMs !== null && timestampMs < window.startMs) {
    return false;
  }
  if (window.endMs !== null && timestampMs > window.endMs) {
    return false;
  }
  return true;
}

function isRollHistoryEntryInAllocationWindow(entry, windows) {
  const source = Array.isArray(windows) ? windows : [];
  if (!source.length) {
    return false;
  }

  const activityTimestampMs = toTimestampMs(getRollHistoryActivityTimestamp(entry));
  return source.some((window) => isTimestampInAllocationWindow(activityTimestampMs, window));
}

function buildRollHistoryEntryDedupeKey(entry) {
  return `${asTrimmedString(entry?.logId)}|${asTrimmedString(entry?.boxId).toUpperCase()}`;
}

function filterRollHistoryForJobAllocations(entries, allocations) {
  const windowsByBox = buildRollHistoryAllocationWindowsByBox(allocations);
  const deduped = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    const boxId = asTrimmedString(entry?.boxId).toUpperCase();
    if (!boxId || !isRollHistoryEntryInAllocationWindow(entry, windowsByBox[boxId])) {
      continue;
    }

    const dedupeKey = buildRollHistoryEntryDedupeKey(entry);
    if (!deduped[dedupeKey]) {
      deduped[dedupeKey] = entry;
    }
  }

  return Object.values(deduped).sort((left, right) => {
    const leftDate = getRollHistoryActivityTimestamp(left);
    const rightDate = getRollHistoryActivityTimestamp(right);
    if (leftDate !== rightDate) {
      return leftDate > rightDate ? -1 : 1;
    }

    const leftLogId = asTrimmedString(left?.logId);
    const rightLogId = asTrimmedString(right?.logId);
    return leftLogId < rightLogId ? 1 : leftLogId > rightLogId ? -1 : 0;
  });
}

async function listRollHistoryForJobAllocations(client, orgId, allocations) {
  // roll_weight_log does not store job_id yet, so by-id detail scopes usage through
  // selected allocation box windows instead of trusting matching job_number alone.
  const boxIds = Object.keys(buildRollHistoryAllocationWindowsByBox(allocations));
  if (!boxIds.length) {
    return [];
  }

  const entries = [];
  for (let index = 0; index < boxIds.length; index += 1) {
    entries.push(...(await listRollHistoryByBox(client, orgId, boxIds[index])));
  }

  return filterRollHistoryForJobAllocations(entries, allocations);
}

async function listRollHistoryForJobAllocationsWithPooledReads(orgId, allocations) {
  // roll_weight_log does not store job_id yet, so by-id detail scopes usage through
  // selected allocation box windows instead of trusting matching job_number alone.
  const boxIds = Object.keys(buildRollHistoryAllocationWindowsByBox(allocations));
  if (!boxIds.length) {
    return [];
  }

  const entryGroups = await runParallelReadTasks(
    boxIds.map((boxId) => (client) => listRollHistoryByBox(client, orgId, boxId))
  );

  return filterRollHistoryForJobAllocations(entryGroups.flat(), allocations);
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

async function loadBaseJobDetailDataById(client, orgId, header) {
  const jobId = requireString(header?.id, 'jobId');
  const [
    allocations,
    filmOrders,
    requirements,
    caulkRequirements,
    caulkAllocations,
    caulkCheckouts,
  ] = await Promise.all([
    listAllocationsByJobId(client, orgId, jobId),
    listFilmOrdersByJobId(client, orgId, jobId),
    listJobRequirementsByJobId(client, orgId, jobId),
    listJobCaulkRequirementsByJobId(client, orgId, jobId),
    listCaulkJobAllocationsByJobId(client, orgId, jobId),
    listCaulkJobCheckoutsByJobId(client, orgId, jobId),
  ]);
  const filmOrderLinks = await listFilmOrderLinksByFilmOrderIds(
    client,
    orgId,
    filmOrders.map((entry) => entry.filmOrderId)
  );
  const rollHistory = await listRollHistoryForJobAllocations(client, orgId, allocations);

  return {
    storedHeader: header,
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

async function loadBaseJobDetailDataByIdWithPooledReads(orgId, header) {
  const jobId = requireString(header?.id, 'jobId');
  const [
    allocations,
    filmOrders,
    requirements,
    caulkRequirements,
    caulkAllocations,
    caulkCheckouts,
  ] = await runParallelReadTasks([
    (client) => listAllocationsByJobId(client, orgId, jobId),
    (client) => listFilmOrdersByJobId(client, orgId, jobId),
    (client) => listJobRequirementsByJobId(client, orgId, jobId),
    (client) => listJobCaulkRequirementsByJobId(client, orgId, jobId),
    (client) => listCaulkJobAllocationsByJobId(client, orgId, jobId),
    (client) => listCaulkJobCheckoutsByJobId(client, orgId, jobId),
  ]);
  const [filmOrderLinks, rollHistory] = await Promise.all([
    runParallelReadTasks([
      (client) =>
        listFilmOrderLinksByFilmOrderIds(
          client,
          orgId,
          filmOrders.map((entry) => entry.filmOrderId)
        ),
    ]).then((results) => results[0]),
    listRollHistoryForJobAllocationsWithPooledReads(orgId, allocations),
  ]);

  return {
    storedHeader: header,
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

async function hydrateDetailContext(
  client,
  orgId,
  normalizedJobNumber,
  baseData,
  currentJobId = ''
) {
  const resolvedBaseContext = resolveJobDetailBaseContext(normalizedJobNumber, baseData);
  const boxes = await listBoxesByIds(client, orgId, resolvedBaseContext.boxIds);
  const conflictAllocations = currentJobId
    ? await listActiveAllocationsForJobIdConflictCheck(
        client,
        orgId,
        resolvedBaseContext.activeAllocationBoxIds,
        resolvedBaseContext.installDate,
        currentJobId,
        resolvedBaseContext.crewLeader
      )
    : await listActiveAllocationsForJobConflictCheck(
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
    boxes,
    []
  );
}

async function hydrateDetailContextWithPooledReads(
  orgId,
  normalizedJobNumber,
  baseData,
  currentJobId = ''
) {
  const resolvedBaseContext = resolveJobDetailBaseContext(normalizedJobNumber, baseData);
  const [boxes, conflictAllocations] = await runParallelReadTasks([
    (client) => listBoxesByIds(client, orgId, resolvedBaseContext.boxIds),
    (client) =>
      currentJobId
        ? listActiveAllocationsForJobIdConflictCheck(
            client,
            orgId,
            resolvedBaseContext.activeAllocationBoxIds,
            resolvedBaseContext.installDate,
            currentJobId,
            resolvedBaseContext.crewLeader
          )
        : listActiveAllocationsForJobConflictCheck(
            client,
            orgId,
            resolvedBaseContext.activeAllocationBoxIds,
            resolvedBaseContext.installDate,
            normalizedJobNumber,
            resolvedBaseContext.crewLeader
          ),
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
    boxes,
    []
  );
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
  /**
   * PURPOSE:
   * Shapes job detail from targeted job-owned reads only.
   *
   * AFFECTS:
   * /jobs/get, post-mutation job detail reloads, allocation detail views, and
   * status/transfer warning derivation.
   *
   * WHEN CHANGING THIS, ALSO CHECK:
   * Supabase buildJobDetail, runtimeJobSummaries readiness math, film order
   * linked-box enrichment, and staged-pickup validation.
   *
   * COMMON FAILURE MODES:
   * Reintroducing full org inventory reads, missing linked boxes in status
   * coverage, or letting local/Edge job detail payloads drift.
   */
  const boxById = indexBoxesById(boxes);
  const publicRequirements = buildPublicJobRequirementEntries(baseData.requirements, baseData.allocations, boxById);
  const publicCaulkRequirements = buildPublicCaulkRequirementEntries(
    baseData.caulkRequirements,
    baseData.caulkAllocations,
    {
      jobNumber: normalizedJobNumber,
      jobWarehouse: resolvedBaseContext.header?.warehouse || ''
    }
  );
  const filmTransferAlerts = buildJobFilmTransferAlerts(
    resolvedBaseContext.header?.warehouse || '',
    baseData.allocations,
    boxById,
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
  return hydrateDetailContext(client, orgId, normalizedJobNumber, baseData);
}

async function loadJobDetailContextById(client, orgId, jobId) {
  const header = await findJobById(client, orgId, jobId);
  if (!header) {
    throw new HttpError(404, 'Job not found.');
  }

  const normalizedJobNumber = requireString(header.jobNumber, 'jobNumber');
  const baseData = await loadBaseJobDetailDataById(client, orgId, header);
  return hydrateDetailContext(client, orgId, normalizedJobNumber, baseData, header.id);
}

async function loadJobDetailContextWithPooledReads(orgId, jobNumber) {
  const normalizedJobNumber = requireString(jobNumber, 'jobNumber');
  const baseData = await loadBaseJobDetailDataWithPooledReads(orgId, normalizedJobNumber);
  return hydrateDetailContextWithPooledReads(orgId, normalizedJobNumber, baseData);
}

async function loadJobDetailContextByIdWithPooledReads(orgId, jobId) {
  const [header] = await runParallelReadTasks([
    (client) => findJobById(client, orgId, jobId),
  ]);
  if (!header) {
    throw new HttpError(404, 'Job not found.');
  }

  const normalizedJobNumber = requireString(header.jobNumber, 'jobNumber');
  const baseData = await loadBaseJobDetailDataByIdWithPooledReads(orgId, header);
  return hydrateDetailContextWithPooledReads(orgId, normalizedJobNumber, baseData, header.id);
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
    detailContext.boxById,
    detailContext.header?.id || '',
    detailContext.header?.workScope ?? detailContext.header?.sections ?? null
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
  filterRollHistoryForJobAllocations,
  loadJobDetailContext,
  loadJobDetailContextById,
  loadJobDetailContextWithPooledReads,
  loadJobDetailContextByIdWithPooledReads,
  buildJobDetailPayload,
  buildAllocationJobDetailPayload,
};
