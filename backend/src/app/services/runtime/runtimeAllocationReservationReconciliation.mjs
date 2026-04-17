import {
  asTrimmedString,
  cloneValue,
  computeCoveredFeetForAllocation,
  findBoxById,
  findJobByNumber,
  integerOrZero,
  listAllocationsByBox,
  listAllocationsByJob,
  listBoxes,
  listJobRequirementsByJob,
  listJobs,
  listFilmOrdersByJob,
  normalizeAllocationKind,
  saveBoxRecord,
} from '../runtimeDeps.mjs';
import {
  applyReservationMetricsToBox,
  buildBoxReservationMetrics,
  buildJobCreatedAtByJobNumber,
  deriveBoxPhysicalFeetAvailable,
  getActiveScheduledAllocatedFeet,
} from './runtimeAllocationReservations.mjs';
import {
  getStoredAllocationCoveredFeet,
  shouldIgnoreAllocationCoverageForBoxStatus,
} from './runtimeAllocationCoverage.mjs';
import {
  isOrderedFilmReservationBoxStatus,
  isPhysicalFilmReservationBoxStatus,
} from '../../../../../shared/domain/filmAllocationReservations.mjs';
import { reconcileAutoShortageFilmOrdersForRequirement } from './runtimeAutoShortageFilmOrders.mjs';

async function capturePhysicalFeetAvailableByBoxId(client, orgId, boxIds = []) {
  const uniqueBoxIds = Array.from(new Set((Array.isArray(boxIds) ? boxIds : []).map((value) => asTrimmedString(value)).filter(Boolean)));
  const response = {};

  for (let index = 0; index < uniqueBoxIds.length; index += 1) {
    const boxId = uniqueBoxIds[index];
    const box = await findBoxById(client, orgId, boxId);
    if (!box) {
      continue;
    }

    const allocations = await listAllocationsByBox(client, orgId, boxId);
    response[boxId] = deriveBoxPhysicalFeetAvailable(box, allocations);
  }

  return response;
}

async function recalculateReservationBoxesByIds(client, orgId, boxIds = [], options = {}) {
  const uniqueBoxIds = Array.from(new Set((Array.isArray(boxIds) ? boxIds : []).map((value) => asTrimmedString(value)).filter(Boolean)));
  if (!uniqueBoxIds.length) {
    return {};
  }

  const jobs = Array.isArray(options.jobs) ? options.jobs : await listJobs(client, orgId);
  const jobCreatedAtByJobNumber = buildJobCreatedAtByJobNumber(jobs);
  const response = {};

  for (let index = 0; index < uniqueBoxIds.length; index += 1) {
    const boxId = uniqueBoxIds[index];
    const box = await findBoxById(client, orgId, boxId);
    if (!box) {
      continue;
    }

    const allocations = await listAllocationsByBox(client, orgId, boxId);
    const physicalFeetAvailable =
      options.physicalFeetAvailableByBoxId &&
      Object.prototype.hasOwnProperty.call(options.physicalFeetAvailableByBoxId, boxId)
        ? options.physicalFeetAvailableByBoxId[boxId]
        : deriveBoxPhysicalFeetAvailable(box, allocations);
    const recalculatedBox = applyReservationMetricsToBox(box, allocations, {
      jobs,
      jobCreatedAtByJobNumber,
      physicalFeetAvailable,
    });

    if (isPhysicalFilmReservationBoxStatus(box.status) && integerOrZero(box.feetAvailable) !== integerOrZero(recalculatedBox.feetAvailable)) {
      const nextBox = cloneValue(box);
      nextBox.feetAvailable = integerOrZero(recalculatedBox.feetAvailable);
      await saveBoxRecord(client, orgId, nextBox);
    }

    response[boxId] = recalculatedBox;
  }

  return response;
}

function buildRequirementBackedCoverageIndex(
  jobNumber,
  requirements,
  allocations,
  boxesById,
  reservationMetricsByBoxId
) {
  const coverageByRequirementId = {};
  const requirementById = {};
  const sourceBoxByRequirementId = {};
  const source = Array.isArray(requirements) ? requirements : [];

  for (let index = 0; index < source.length; index += 1) {
    const requirement = source[index];
    const requirementId = asTrimmedString(requirement?.id);
    if (!requirementId) {
      continue;
    }

    requirementById[requirementId] = requirement;
    coverageByRequirementId[requirementId] = {
      requirement,
      requiredFeet: integerOrZero(requirement?.requiredFeet),
      backedCoveredFeet: 0,
    };
  }

  const allocationSource = Array.isArray(allocations) ? allocations : [];
  for (let index = 0; index < allocationSource.length; index += 1) {
    const allocation = allocationSource[index];
    if (
      asTrimmedString(allocation?.status).toUpperCase() !== 'ACTIVE' ||
      asTrimmedString(allocation?.jobNumber) !== asTrimmedString(jobNumber) ||
      normalizeAllocationKind(allocation?.allocationKind) === 'EXTRA'
    ) {
      continue;
    }

    const requirementId = asTrimmedString(allocation?.requirementId);
    const requirement = requirementById[requirementId];
    const box = boxesById[asTrimmedString(allocation?.boxId)];
    if (!requirement || !box || shouldIgnoreAllocationCoverageForBoxStatus(allocation, box)) {
      continue;
    }

    const storedCoveredFeet = getStoredAllocationCoveredFeet(allocation);
    let coveredFeet = storedCoveredFeet;
    if (isPhysicalFilmReservationBoxStatus(box.status)) {
      const reservationSnapshot =
        reservationMetricsByBoxId[box.boxId]?.allocationSnapshotsById?.[asTrimmedString(allocation?.allocationId)];
      coveredFeet = computeCoveredFeetForAllocation(
        integerOrZero(reservationSnapshot?.backedPhysicalFeet),
        box.widthIn,
        requirement.widthIn,
        storedCoveredFeet
      );
    }

    coverageByRequirementId[requirementId].backedCoveredFeet += integerOrZero(coveredFeet);
    if (!sourceBoxByRequirementId[requirementId]) {
      sourceBoxByRequirementId[requirementId] = box;
    }
  }

  return Object.keys(coverageByRequirementId).map((requirementId) => ({
    requirement: coverageByRequirementId[requirementId].requirement,
    requiredFeet: coverageByRequirementId[requirementId].requiredFeet,
    backedCoveredFeet: coverageByRequirementId[requirementId].backedCoveredFeet,
    shortageFeet: Math.max(
      0,
      coverageByRequirementId[requirementId].requiredFeet - coverageByRequirementId[requirementId].backedCoveredFeet
    ),
    sourceBox: sourceBoxByRequirementId[requirementId] || null,
  }));
}

async function reconcileReservationShortagesForJob(
  client,
  orgId,
  jobNumber,
  actor,
  options = {}
) {
  const normalizedJobNumber = asTrimmedString(jobNumber);
  if (!normalizedJobNumber) {
    return {
      createdCount: 0,
      updatedCount: 0,
      deletedCount: 0,
    };
  }

  const job = options.job || await findJobByNumber(client, orgId, normalizedJobNumber);
  if (!job) {
    return {
      createdCount: 0,
      updatedCount: 0,
      deletedCount: 0,
    };
  }

  const allowPlaceholderShortages = options.allowPlaceholderShortages === true;
  const shouldCreateShortages = Boolean(asTrimmedString(job.installDate)) || allowPlaceholderShortages;
  const requirements = Array.isArray(options.requirements)
    ? options.requirements
    : await listJobRequirementsByJob(client, orgId, normalizedJobNumber);
  const jobAllocations = Array.isArray(options.allocations)
    ? options.allocations
    : await listAllocationsByJob(client, orgId, normalizedJobNumber);
  const jobFilmOrders = Array.isArray(options.filmOrders)
    ? options.filmOrders
    : await listFilmOrdersByJob(client, orgId, normalizedJobNumber);
  const uniqueBoxIds = Array.from(
    new Set(
      jobAllocations
        .map((entry) => asTrimmedString(entry?.boxId))
        .filter(Boolean)
    )
  );
  const boxesById = options.boxesById || {};
  const reservationMetricsByBoxId = options.reservationMetricsByBoxId || {};
  const missingBoxIds = uniqueBoxIds.filter((boxId) => !boxesById[boxId] || !reservationMetricsByBoxId[boxId]);
  let resolvedBoxesById = boxesById;
  let resolvedReservationMetricsByBoxId = reservationMetricsByBoxId;

  if (missingBoxIds.length > 0) {
    const jobs = await listJobs(client, orgId);
    const jobCreatedAtByJobNumber = buildJobCreatedAtByJobNumber(jobs);
    resolvedBoxesById = { ...boxesById };
    resolvedReservationMetricsByBoxId = { ...reservationMetricsByBoxId };
    for (let index = 0; index < missingBoxIds.length; index += 1) {
      const boxId = missingBoxIds[index];
      const box = await findBoxById(client, orgId, boxId);
      if (!box) {
        continue;
      }

      const allocations = await listAllocationsByBox(client, orgId, boxId);
      resolvedBoxesById[boxId] = box;
      resolvedReservationMetricsByBoxId[boxId] = buildBoxReservationMetrics(box, allocations, {
        jobs,
        jobCreatedAtByJobNumber,
      });
    }
  }

  const requirementShortages = buildRequirementBackedCoverageIndex(
    normalizedJobNumber,
    requirements,
    jobAllocations,
    resolvedBoxesById,
    resolvedReservationMetricsByBoxId
  );
  const result = {
    createdCount: 0,
    updatedCount: 0,
    deletedCount: 0,
  };

  for (let index = 0; index < requirementShortages.length; index += 1) {
    const shortage = requirementShortages[index];
    const targetRequestedFeet = shouldCreateShortages ? shortage.shortageFeet : 0;
    const reconciliation = await reconcileAutoShortageFilmOrdersForRequirement(
      client,
      orgId,
      {
        actor,
        job,
        jobNumber: normalizedJobNumber,
        requirement: shortage.requirement,
        targetRequestedFeet,
        sourceBox: shortage.sourceBox,
        filmOrders: jobFilmOrders,
        warehouse: asTrimmedString(job.warehouse),
      }
    );

    if (reconciliation.created) {
      result.createdCount += 1;
      jobFilmOrders.push(reconciliation.created);
    }
    if (reconciliation.updated) {
      result.updatedCount += 1;
      const updatedFilmOrderId = asTrimmedString(reconciliation.updated.filmOrderId);
      const updatedIndex = jobFilmOrders.findIndex(
        (entry) => asTrimmedString(entry?.filmOrderId) === updatedFilmOrderId
      );
      if (updatedIndex >= 0) {
        jobFilmOrders[updatedIndex] = reconciliation.updated;
      } else {
        jobFilmOrders.push(reconciliation.updated);
      }
    }
    if (Array.isArray(reconciliation.deleted) && reconciliation.deleted.length > 0) {
      result.deletedCount += reconciliation.deleted.length;
      const deletedIds = new Set(
        reconciliation.deleted.map((entry) => asTrimmedString(entry?.filmOrderId)).filter(Boolean)
      );
      for (let filmOrderIndex = jobFilmOrders.length - 1; filmOrderIndex >= 0; filmOrderIndex -= 1) {
        if (deletedIds.has(asTrimmedString(jobFilmOrders[filmOrderIndex]?.filmOrderId))) {
          jobFilmOrders.splice(filmOrderIndex, 1);
        }
      }
    }
  }

  return result;
}

async function reconcileReservationShortagesForJobs(
  client,
  orgId,
  jobNumbers,
  actor,
  options = {}
) {
  const uniqueJobNumbers = Array.from(
    new Set((Array.isArray(jobNumbers) ? jobNumbers : []).map((value) => asTrimmedString(value)).filter(Boolean))
  );
  const result = {
    createdCount: 0,
    updatedCount: 0,
    deletedCount: 0,
  };

  for (let index = 0; index < uniqueJobNumbers.length; index += 1) {
    const jobResult = await reconcileReservationShortagesForJob(
      client,
      orgId,
      uniqueJobNumbers[index],
      actor,
      options
    );
    result.createdCount += jobResult.createdCount;
    result.updatedCount += jobResult.updatedCount;
    result.deletedCount += jobResult.deletedCount;
  }

  return result;
}

async function reconcileReservationShortagesForBox(
  client,
  orgId,
  boxId,
  actor,
  options = {}
) {
  const box = await findBoxById(client, orgId, boxId);
  if (!box || (!isPhysicalFilmReservationBoxStatus(box.status) && !isOrderedFilmReservationBoxStatus(box.status))) {
    return {
      createdCount: 0,
      updatedCount: 0,
      deletedCount: 0,
    };
  }

  const allocations = await listAllocationsByBox(client, orgId, boxId);
  const activeJobNumbers = Array.from(
    new Set(
      allocations
        .filter((entry) => asTrimmedString(entry?.status).toUpperCase() === 'ACTIVE')
        .map((entry) => asTrimmedString(entry?.jobNumber))
        .filter(Boolean)
    )
  );
  if (!activeJobNumbers.length) {
    return {
      createdCount: 0,
      updatedCount: 0,
      deletedCount: 0,
    };
  }

  return reconcileReservationShortagesForJobs(
    client,
    orgId,
    activeJobNumbers,
    actor,
    {
      ...options,
      allowPlaceholderShortages: options.allowPlaceholderShortages !== false,
    }
  );
}

export {
  capturePhysicalFeetAvailableByBoxId,
  recalculateReservationBoxesByIds,
  reconcileReservationShortagesForBox,
  reconcileReservationShortagesForJob,
  reconcileReservationShortagesForJobs,
};
