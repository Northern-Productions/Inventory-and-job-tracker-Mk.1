import {
  asTrimmedString,
  integerOrZero,
  createLogId,
  normalizeJobNumberKey,
  normalizeJobRequirementLookupKey,
  listFilmOrdersByJob,
  listFilmOrderLinksByFilmOrderId,
  listAllocationsByFilmOrderId,
  saveFilmOrderRecord,
  deleteFilmOrderLinksByFilmOrderId,
  deleteFilmOrderRecord,
} from '../runtimeDeps.mjs';
import { isUnresolvedFilmOrderStatus } from './runtimeFilmOrderSchedule.mjs';

function matchesAutoShortageRequirement(filmOrder, jobNumber, requirement) {
  if (!filmOrder || !requirement) {
    return false;
  }

  if (!isUnresolvedFilmOrderStatus(filmOrder.status)) {
    return false;
  }

  if (!asTrimmedString(filmOrder.sourceBoxId)) {
    return false;
  }

  const normalizedJobNumber = normalizeJobNumberKey(jobNumber);
  if (normalizedJobNumber && normalizeJobNumberKey(filmOrder.jobNumber) !== normalizedJobNumber) {
    return false;
  }

  return (
    normalizeJobRequirementLookupKey(
      filmOrder.manufacturer,
      filmOrder.filmName,
      filmOrder.widthIn
    ) ===
    normalizeJobRequirementLookupKey(
      requirement.manufacturer,
      requirement.filmName,
      requirement.widthIn
    )
  );
}

async function loadAutoShortageFilmOrdersForRequirement(client, orgId, jobNumber, requirement, filmOrders = null) {
  const source = Array.isArray(filmOrders)
    ? filmOrders
    : await listFilmOrdersByJob(client, orgId, jobNumber);
  const response = [];

  for (let index = 0; index < source.length; index += 1) {
    const filmOrder = source[index];
    if (!matchesAutoShortageRequirement(filmOrder, jobNumber, requirement)) {
      continue;
    }

    const filmOrderId = asTrimmedString(filmOrder?.filmOrderId);
    if (!filmOrderId) {
      continue;
    }

    const [links, allocations] = await Promise.all([
      listFilmOrderLinksByFilmOrderId(client, orgId, filmOrderId),
      listAllocationsByFilmOrderId(client, orgId, filmOrderId),
    ]);

    response.push({
      filmOrder,
      links,
      allocations,
      isOrphan: links.length === 0 && allocations.length === 0,
    });
  }

  response.sort((left, right) => {
    const leftCreatedAt = asTrimmedString(left?.filmOrder?.createdAt);
    const rightCreatedAt = asTrimmedString(right?.filmOrder?.createdAt);
    if (leftCreatedAt !== rightCreatedAt) {
      if (!leftCreatedAt) {
        return 1;
      }
      if (!rightCreatedAt) {
        return -1;
      }
      return leftCreatedAt < rightCreatedAt ? -1 : 1;
    }

    const leftId = asTrimmedString(left?.filmOrder?.filmOrderId);
    const rightId = asTrimmedString(right?.filmOrder?.filmOrderId);
    if (leftId === rightId) {
      return 0;
    }

    return leftId < rightId ? -1 : 1;
  });

  return response;
}

async function deleteAutoShortageFilmOrderEntries(client, orgId, entries) {
  const deleted = [];
  const source = Array.isArray(entries) ? entries : [];

  for (let index = 0; index < source.length; index += 1) {
    const filmOrder = source[index]?.filmOrder || source[index];
    const filmOrderId = asTrimmedString(filmOrder?.filmOrderId);
    if (!filmOrderId) {
      continue;
    }

    await deleteFilmOrderLinksByFilmOrderId(client, orgId, filmOrderId);
    await deleteFilmOrderRecord(client, orgId, filmOrderId);
    deleted.push(filmOrder);
  }

  return deleted;
}

async function deleteOrphanAutoShortageFilmOrdersForRequirement(
  client,
  orgId,
  jobNumber,
  requirement,
  filmOrders = null
) {
  const candidates = await loadAutoShortageFilmOrdersForRequirement(
    client,
    orgId,
    jobNumber,
    requirement,
    filmOrders
  );
  const orphanCandidates = candidates.filter((entry) => entry.isOrphan);
  await deleteAutoShortageFilmOrderEntries(client, orgId, orphanCandidates);
  return orphanCandidates.map((entry) => entry.filmOrder);
}

async function reconcileAutoShortageFilmOrdersForRequirement(
  client,
  orgId,
  {
    actor,
    job,
    jobNumber,
    requirement,
    targetRequestedFeet,
    sourceBox,
    filmOrders = null,
    warehouse = '',
  }
) {
  const normalizedJobNumber = asTrimmedString(jobNumber || job?.jobNumber);
  const shortageFeetTarget = integerOrZero(targetRequestedFeet);
  const candidates = await loadAutoShortageFilmOrdersForRequirement(
    client,
    orgId,
    normalizedJobNumber,
    requirement,
    filmOrders
  );
  const orphanCandidates = candidates.filter((entry) => entry.isOrphan);
  const committedRequestedFeet = candidates
    .filter((entry) => !entry.isOrphan)
    .reduce((total, entry) => total + integerOrZero(entry?.filmOrder?.requestedFeet), 0);
  const targetOrphanRequestedFeet = Math.max(0, shortageFeetTarget - committedRequestedFeet);
  const deleted = [];
  let created = null;
  let updated = null;

  if (targetOrphanRequestedFeet <= 0) {
    const deletedEntries = await deleteAutoShortageFilmOrderEntries(client, orgId, orphanCandidates);
    deleted.push(...deletedEntries);
    return {
      created,
      updated,
      deleted,
      committedRequestedFeet,
      targetRequestedFeet: shortageFeetTarget,
    };
  }

  const [primaryOrphan, ...extraOrphans] = orphanCandidates;
  if (primaryOrphan) {
    const nextFilmOrder = {
      ...primaryOrphan.filmOrder,
      warehouse: asTrimmedString(warehouse).toUpperCase() || asTrimmedString(primaryOrphan.filmOrder.warehouse),
      requestedFeet: targetOrphanRequestedFeet,
      coveredFeet: 0,
      orderedFeet: 0,
      remainingToOrderFeet: targetOrphanRequestedFeet,
      installDate: asTrimmedString(job?.installDate),
      crewLeader: asTrimmedString(job?.crewLeader),
      status: 'FILM_ORDER',
      sourceBoxId: asTrimmedString(sourceBox?.boxId) || asTrimmedString(primaryOrphan.filmOrder.sourceBoxId),
      resolvedAt: '',
      resolvedBy: '',
      updatedAt: new Date().toISOString(),
      updatedBy: asTrimmedString(actor),
    };

    const hasMeaningfulChange =
      integerOrZero(primaryOrphan.filmOrder.requestedFeet) !== targetOrphanRequestedFeet ||
      integerOrZero(primaryOrphan.filmOrder.remainingToOrderFeet) !== targetOrphanRequestedFeet ||
      asTrimmedString(primaryOrphan.filmOrder.installDate) !== asTrimmedString(job?.installDate) ||
      asTrimmedString(primaryOrphan.filmOrder.crewLeader) !== asTrimmedString(job?.crewLeader) ||
      asTrimmedString(primaryOrphan.filmOrder.warehouse).toUpperCase() !==
        (asTrimmedString(nextFilmOrder.warehouse).toUpperCase()) ||
      asTrimmedString(primaryOrphan.filmOrder.sourceBoxId) !== asTrimmedString(nextFilmOrder.sourceBoxId) ||
      asTrimmedString(primaryOrphan.filmOrder.status).toUpperCase() !== 'FILM_ORDER' ||
      integerOrZero(primaryOrphan.filmOrder.coveredFeet) !== 0 ||
      integerOrZero(primaryOrphan.filmOrder.orderedFeet) !== 0;

    if (hasMeaningfulChange) {
      updated = await saveFilmOrderRecord(client, orgId, nextFilmOrder);
    }
  } else if (sourceBox && requirement) {
    created = await saveFilmOrderRecord(client, orgId, {
      filmOrderId: createLogId(),
      jobId: job?.id || '',
      jobNumber: normalizedJobNumber,
      warehouse: asTrimmedString(warehouse).toUpperCase() || asTrimmedString(sourceBox.warehouse).toUpperCase(),
      manufacturer: requirement.manufacturer,
      filmName: requirement.filmName,
      widthIn: Number(requirement.widthIn) || Number(sourceBox.widthIn) || 0,
      requestedFeet: targetOrphanRequestedFeet,
      coveredFeet: 0,
      orderedFeet: 0,
      remainingToOrderFeet: targetOrphanRequestedFeet,
      installDate: asTrimmedString(job?.installDate),
      crewLeader: asTrimmedString(job?.crewLeader),
      status: 'FILM_ORDER',
      sourceBoxId: asTrimmedString(sourceBox.boxId),
      createdAt: new Date().toISOString(),
      createdBy: asTrimmedString(actor),
      resolvedAt: '',
      resolvedBy: '',
      notes: `Created from a shortage while reconciling reserved film for job ${normalizedJobNumber}.`,
    });
  }

  const deletedEntries = await deleteAutoShortageFilmOrderEntries(client, orgId, extraOrphans);
  deleted.push(...deletedEntries);

  return {
    created,
    updated,
    deleted,
    committedRequestedFeet,
    targetRequestedFeet: shortageFeetTarget,
  };
}

export {
  deleteOrphanAutoShortageFilmOrdersForRequirement,
  loadAutoShortageFilmOrdersForRequirement,
  matchesAutoShortageRequirement,
  reconcileAutoShortageFilmOrdersForRequirement,
};
