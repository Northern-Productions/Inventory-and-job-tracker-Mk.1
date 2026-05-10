import {
  HttpError,
  ok,
  asTrimmedString,
  cloneValue,
  deriveCoreWeightLbs,
  normalizeCoreType,
  roundToDecimals,
  todayDateString,
  toPublicBox,
  findBoxById,
  listAllocationsByBox,
  saveBoxRecord,
  seedFilmCatalogRecordIfMissing,
  appendAuditEntry,
} from '../../runtimeDeps.mjs';
import { processLinkedFilmOrderReceipt } from '../runtimeAllocationPlanning.mjs';
import { recalculateFilmOrdersForBoxLinks } from '../runtimeAllocationCleanup.mjs';
import { applyReservationMetricsToBox } from '../runtimeAllocationReservations.mjs';
import { getAllocationReservationState } from '../../../../../../shared/domain/filmAllocationReservations.mjs';

function parseOptionalReceivedWeight(value) {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new HttpError(400, 'ReceivedWeightLbs must be a valid non-negative number.');
  }

  return roundToDecimals(parsed, 2);
}

function sumLockedAllocatedFeet(allocations) {
  return (Array.isArray(allocations) ? allocations : []).reduce((total, entry) => {
    if (entry?.status !== 'ACTIVE') {
      return total;
    }

    return total + (getAllocationReservationState(entry) === 'WITH_INSTALL_DATE' ? Number(entry?.allocatedFeet || 0) : 0);
  }, 0);
}

function buildReceiveAuditNote(boxId, receivedWeightLbs, lotRun) {
  const details = [];

  if (receivedWeightLbs !== null) {
    details.push(`at ${receivedWeightLbs} lbs`);
  }

  if (lotRun) {
    details.push(`lot run ${lotRun}`);
  }

  return details.length > 0
    ? `Received ordered box ${boxId} ${details.join(' with ')}`
    : `Received ordered box ${boxId}`;
}

async function receiveOrderedBox(client, orgId, payload, actor) {
  const warnings = [];
  const existing = await findBoxById(client, orgId, payload.boxId);

  if (!existing) {
    throw new HttpError(404, 'Box not found.');
  }

  if (existing.status === 'TRANSFER') {
    throw new HttpError(
      400,
      `Box ${existing.boxId} has a pending transfer and can only be received or have the transfer cancelled.`
    );
  }

  if (existing.status === 'ZEROED') {
    throw new HttpError(400, 'Zeroed boxes cannot be received as ordered inventory.');
  }

  if (existing.status === 'RETIRED') {
    throw new HttpError(400, 'Retired boxes cannot be received as ordered inventory.');
  }

  if (existing.status !== 'ORDERED') {
    throw new HttpError(400, `Only boxes currently in ORDERED status can be received. ${existing.boxId} is ${existing.status}.`);
  }

  if (existing.receivedDate) {
    throw new HttpError(400, `Box ${existing.boxId} already has a received date and cannot be received again.`);
  }

  const receivedWeightLbs = parseOptionalReceivedWeight(payload.receivedWeightLbs);
  const requestedLotRun = asTrimmedString(payload.lotRun);
  const requestedCoreType = normalizeCoreType(payload.coreType, true);
  const existingAllocations = await listAllocationsByBox(client, orgId, existing.boxId);
  const lockedAllocatedFeet = sumLockedAllocatedFeet(existingAllocations);
  const receivedDate = todayDateString();
  const updatedBox = cloneValue(existing);

  updatedBox.status = 'IN_STOCK';
  updatedBox.receivedDate = receivedDate;
  updatedBox.feetAvailable = Math.max(existing.initialFeet - lockedAllocatedFeet, 0);
  updatedBox.lotRun = requestedLotRun || existing.lotRun;
  updatedBox.hasLabel = false;

  if (requestedCoreType) {
    updatedBox.coreType = requestedCoreType;
    updatedBox.coreWeightLbs = deriveCoreWeightLbs(requestedCoreType, updatedBox.widthIn);
  }

  if (receivedWeightLbs !== null) {
    updatedBox.initialWeightLbs = receivedWeightLbs;
    updatedBox.lastRollWeightLbs = receivedWeightLbs;
    updatedBox.lastWeighedDate = receivedDate;
  }

  let persistedBox = await processLinkedFilmOrderReceipt(client, orgId, updatedBox, actor, warnings);
  persistedBox = await saveBoxRecord(client, orgId, persistedBox);
  await recalculateFilmOrdersForBoxLinks(client, orgId, persistedBox.boxId, actor);

  await seedFilmCatalogRecordIfMissing(client, orgId, {
    filmKey: persistedBox.filmKey,
    manufacturer: persistedBox.manufacturer,
    filmName: persistedBox.filmName,
    sourceBoxId: persistedBox.boxId
  });

  const publicBefore = toPublicBox(applyReservationMetricsToBox(existing, existingAllocations));
  const publicAfter = toPublicBox(
    applyReservationMetricsToBox(persistedBox, await listAllocationsByBox(client, orgId, persistedBox.boxId))
  );
  const logId = await appendAuditEntry(
    client,
    orgId,
    'SET_STATUS',
    persistedBox.boxId,
    publicBefore,
    publicAfter,
    actor,
    buildReceiveAuditNote(persistedBox.boxId, receivedWeightLbs, updatedBox.lotRun)
  );

  return ok({ box: publicAfter, logId }, warnings);
}

export { receiveOrderedBox };
