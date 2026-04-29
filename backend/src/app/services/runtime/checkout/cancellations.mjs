import {
  ZEROED_BOX_AUTO_CANCEL_NOTE,
  asTrimmedString,
  normalizeJobNumberKey,
  integerOrZero,
  cloneValue,
  listAllocationsByBox,
  saveAllocationRecord,
} from '../../runtimeDeps.mjs';
import { recalculateFilmOrder } from '../runtimeAllocationPlanning.mjs';

async function cancelActiveAllocationsForCheckInJob(client, orgId, boxId, jobNumber, user, reason = '') {
  const normalizedJobNumber = normalizeJobNumberKey(jobNumber);
  if (!normalizedJobNumber) {
    return { cancelledCount: 0, cancelledFeet: 0 };
  }

  const resolvedAt = new Date().toISOString();
  const resolvedBy = asTrimmedString(user);
  const trimmedReason = asTrimmedString(reason) || `Returned to stock during check-in for job ${jobNumber}.`;
  const affectedFilmOrders = {};
  let cancelledCount = 0;
  let cancelledFeet = 0;
  const entries = await listAllocationsByBox(client, orgId, boxId);

  for (let index = 0; index < entries.length; index += 1) {
    const entry = cloneValue(entries[index]);
    if (entry.status !== 'ACTIVE' || normalizeJobNumberKey(entry.jobNumber) !== normalizedJobNumber) {
      continue;
    }

    entry.status = 'CANCELLED';
    entry.resolvedAt = resolvedAt;
    entry.resolvedBy = resolvedBy;
    entry.notes = trimmedReason;
    await saveAllocationRecord(client, orgId, entry);

    if (entry.filmOrderId) {
      affectedFilmOrders[entry.filmOrderId] = true;
    }

    cancelledCount += 1;
    cancelledFeet += integerOrZero(entry.allocatedFeet);
  }

  for (const filmOrderId of Object.keys(affectedFilmOrders)) {
    await recalculateFilmOrder(client, orgId, filmOrderId, user);
  }

  return { cancelledCount, cancelledFeet };
}

async function reactivateFulfilledAllocationsForUndo(client, orgId, boxId, jobNumber) {
  const entries = await listAllocationsByBox(client, orgId, boxId);
  const checkoutMarkerNote = `Checked out for job ${jobNumber}.`;
  const legacyCheckoutNote = `Fulfilled by checkout for job ${jobNumber}.`;
  let count = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = cloneValue(entries[index]);
    if (
      (entry.status === 'ACTIVE' || entry.status === 'FULFILLED') &&
      normalizeJobNumberKey(entry.jobNumber) === normalizeJobNumberKey(jobNumber) &&
      (entry.notes === checkoutMarkerNote || entry.notes === legacyCheckoutNote)
    ) {
      entry.status = 'ACTIVE';
      entry.resolvedAt = '';
      entry.resolvedBy = '';
      entry.notes = '';
      await saveAllocationRecord(client, orgId, entry);
      count += 1;
    }
  }

  return count;
}

async function reactivateCancelledAllocationsForZeroUndo(client, orgId, boxId) {
  const entries = await listAllocationsByBox(client, orgId, boxId);
  const expectedNote = ZEROED_BOX_AUTO_CANCEL_NOTE;
  let count = 0;
  const affectedFilmOrders = {};

  for (let index = 0; index < entries.length; index += 1) {
    const entry = cloneValue(entries[index]);
    if (entry.status === 'CANCELLED' && entry.notes === expectedNote) {
      entry.status = 'ACTIVE';
      entry.resolvedAt = '';
      entry.resolvedBy = '';
      entry.notes = '';
      await saveAllocationRecord(client, orgId, entry);
      if (entry.filmOrderId) {
        affectedFilmOrders[entry.filmOrderId] = true;
      }
      count += 1;
    }
  }

  for (const filmOrderId of Object.keys(affectedFilmOrders)) {
    await recalculateFilmOrder(client, orgId, filmOrderId, '');
  }

  return count;
}

export {
  cancelActiveAllocationsForCheckInJob,
  reactivateFulfilledAllocationsForUndo,
  reactivateCancelledAllocationsForZeroUndo,
};
