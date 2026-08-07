function normalizeKey(value) {
  return String(value ?? '').trim().toUpperCase();
}

function trimString(value) {
  return String(value ?? '').trim();
}

export const PENDING_TRANSFER_CHECKOUT_BLOCKED_CODE = 'PENDING_TRANSFER_CHECKOUT_BLOCKED';
export const PENDING_TRANSFER_CHECKOUT_BLOCKED_MESSAGE =
  'Checkout is blocked while material is pending transfer. Receive or cancel the transfer, then retry.';
export const PENDING_TRANSFER_CHECKOUT_BLOCKED_STATUS = 409;

const PENDING_TRANSFER_CHECKOUT_ERROR_PATTERNS = [
  /^Box \S+ is pending transfer and must be received before it can be checked out\.$/,
  /^Box \S+ has a pending transfer and can only be received or have the transfer cancelled\.$/,
  /^Box \S+ has a pending transfer and can only be received, cancelled, or have its linked claim released\.$/,
  /^A pending-transfer allocation cannot be fulfilled before receipt\.$/,
  /^Receive or cancel transfer \S+ before checking out this allocation\.$/,
];

function readErrorField(error, field) {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(error, field)) {
    return error[field];
  }
  const details = error.details;
  return details && typeof details === 'object' ? details[field] : undefined;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

export function isPendingTransferCheckoutConflict(error) {
  const code = trimString(readErrorField(error, 'code'));
  if (code === PENDING_TRANSFER_CHECKOUT_BLOCKED_CODE) {
    return true;
  }

  const statusCode = Number(
    readErrorField(error, 'statusCode') ?? readErrorField(error, 'status'),
  );
  if (statusCode !== 400 && statusCode !== 409) {
    return false;
  }

  const message = trimString(readErrorField(error, 'message'));
  return PENDING_TRANSFER_CHECKOUT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function getPendingTransferCheckoutDenial({
  successfullyHandledCount,
  blockedFilmCount,
  blockedCaulkCount,
}) {
  const handledCount = nonNegativeInteger(successfullyHandledCount);
  const blockedCount =
    nonNegativeInteger(blockedFilmCount) + nonNegativeInteger(blockedCaulkCount);
  if (handledCount > 0 || blockedCount === 0) {
    return null;
  }

  return {
    statusCode: PENDING_TRANSFER_CHECKOUT_BLOCKED_STATUS,
    code: PENDING_TRANSFER_CHECKOUT_BLOCKED_CODE,
    message: PENDING_TRANSFER_CHECKOUT_BLOCKED_MESSAGE,
  };
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
