function normalizeKey(value) {
  return String(value ?? '').trim().toUpperCase();
}

function trimString(value) {
  return String(value ?? '').trim();
}

export function isCurrentOperationalFilmAllocation(entry) {
  return normalizeKey(entry?.status) === 'ACTIVE' && trimString(entry?.resolvedAt) === '';
}

function isCheckoutDisplayCandidate(entry) {
  const status = normalizeKey(entry?.status);
  return status === 'ACTIVE' || status === 'FULFILLED';
}

/**
 * PURPOSE:
 * Identifies the allocation row that should represent a box's current
 * returned-material checkout on job detail screens.
 *
 * AFFECTS:
 * Job Allocated Boxes display, film check-in actions, returned-material
 * blockers, and completion/delete guards that depend on current checkout rows.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * AllocationJobPage visibility, jobReturnedMaterials summaries, backend
 * checkout/check-in status transitions, and checkout semantics tests.
 *
 * COMMON FAILURE MODES:
 * Hiding checked-out fulfilled rows, showing old fulfilled rows after return,
 * or treating requirement fulfillment as proof that the physical box returned.
 */
export function buildCurrentCheckedOutAllocationIdSet(allocations, boxById) {
  const grouped = Object.create(null);
  const currentAllocationIds = Object.create(null);

  for (let index = 0; index < allocations.length; index += 1) {
    const entry = allocations[index];
    if (!isCheckoutDisplayCandidate(entry)) {
      continue;
    }

    const allocationId = trimString(entry?.allocationId);
    const boxId = trimString(entry?.boxId);
    const jobKey = normalizeKey(entry?.jobNumber);
    if (!allocationId || !boxId || !jobKey) {
      continue;
    }

    const box = boxById?.[boxId];
    if (!box) {
      continue;
    }

    if (normalizeKey(box.status) !== 'CHECKED_OUT') {
      continue;
    }

    if (normalizeKey(box.lastCheckoutJob) !== jobKey) {
      continue;
    }

    const groupKey = `${boxId}::${jobKey}`;
    if (!grouped[groupKey]) {
      grouped[groupKey] = [];
    }
    grouped[groupKey].push(entry);
  }

  const groupKeys = Object.keys(grouped);
  for (let groupIndex = 0; groupIndex < groupKeys.length; groupIndex += 1) {
    const entries = grouped[groupKeys[groupIndex]];
    const unresolvedEntries = entries.filter((entry) => isCurrentOperationalFilmAllocation(entry));

    if (unresolvedEntries.length > 0) {
      for (let index = 0; index < unresolvedEntries.length; index += 1) {
        currentAllocationIds[trimString(unresolvedEntries[index].allocationId)] = true;
      }
      continue;
    }

    let latestResolvedAt = '';
    for (let index = 0; index < entries.length; index += 1) {
      const resolvedAt = trimString(entries[index].resolvedAt);
      if (resolvedAt > latestResolvedAt) {
        latestResolvedAt = resolvedAt;
      }
    }

    if (latestResolvedAt) {
      for (let index = 0; index < entries.length; index += 1) {
        if (trimString(entries[index].resolvedAt) === latestResolvedAt) {
          currentAllocationIds[trimString(entries[index].allocationId)] = true;
        }
      }
      continue;
    }

    let latestCreatedAt = '';
    for (let index = 0; index < entries.length; index += 1) {
      const createdAt = trimString(entries[index].createdAt);
      if (createdAt > latestCreatedAt) {
        latestCreatedAt = createdAt;
      }
    }

    for (let index = 0; index < entries.length; index += 1) {
      if (trimString(entries[index].createdAt) === latestCreatedAt) {
        currentAllocationIds[trimString(entries[index].allocationId)] = true;
      }
    }
  }

  return currentAllocationIds;
}

export function buildFilmCheckoutActionPlan(allocations, boxById, jobNumber) {
  const normalizedJobNumber = normalizeKey(jobNumber);
  const seenBoxIds = Object.create(null);
  const plan = [];

  for (let index = 0; index < allocations.length; index += 1) {
    const entry = allocations[index];
    if (!isCurrentOperationalFilmAllocation(entry)) {
      continue;
    }

    const boxId = trimString(entry?.boxId);
    if (!boxId || seenBoxIds[boxId]) {
      continue;
    }

    const box = boxById?.[boxId] ?? null;
    const action =
      normalizeKey(box?.status) === 'CHECKED_OUT' &&
      normalizeKey(box?.lastCheckoutJob) === normalizedJobNumber
        ? 'RESOLVE_ONLY'
        : 'CHECK_OUT';

    seenBoxIds[boxId] = true;
    plan.push({
      action,
      allocationId: trimString(entry?.allocationId),
      boxId
    });
  }

  return plan;
}
