import {
  asTrimmedString,
  integerOrZero,
  normalizeJobNumberKey,
  normalizeJobRequirementLookupKey,
  listFilmOrdersByJob,
  listFilmOrderLinksByFilmOrderId,
  listAllocationsByFilmOrderId,
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

async function deleteOrphanAutoShortageFilmOrdersForRequirement(
  client,
  orgId,
  jobNumber,
  requirement,
  filmOrders = null
) {
  /**
   * PURPOSE:
   * Preserves legacy auto-shortage film orders now that film orders require
   * explicit user approval.
   *
   * AFFECTS:
   * Allocation apply, box receive/update reconciliation, job schedule sync,
   * and any old cleanup path that used to silently delete shortage orders.
   *
   * WHEN CHANGING THIS, ALSO CHECK:
   * runtimeAllocationCleanup.mjs, runtimeAllocationReservationReconciliation.mjs,
   * mirrored Supabase migrations, and film-order delete/cancel UI flows.
   *
   * COMMON FAILURE MODES:
   * Reintroducing hidden order deletion, stale UI after manual cancel, or
   * backend/Supabase drift where one runtime still mutates orders.
   */
  void client;
  void orgId;
  void jobNumber;
  void requirement;
  void filmOrders;
  return [];
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
  void client;
  void orgId;
  void actor;
  void job;
  void requirement;
  void sourceBox;
  void filmOrders;
  void warehouse;
  return {
    created: null,
    updated: null,
    deleted: [],
    committedRequestedFeet: 0,
    targetRequestedFeet: integerOrZero(targetRequestedFeet),
  };
}

export {
  deleteOrphanAutoShortageFilmOrdersForRequirement,
  loadAutoShortageFilmOrdersForRequirement,
  matchesAutoShortageRequirement,
  reconcileAutoShortageFilmOrdersForRequirement,
};
