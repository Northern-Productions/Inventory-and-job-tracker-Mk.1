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
  reconcileBoxCheckinAllocations,
} from '../../runtimeDeps.mjs';
import { processLinkedFilmOrderReceipt } from '../runtimeAllocationPlanning.mjs';
import { recalculateFilmOrdersForBoxLinks } from '../runtimeAllocationCleanup.mjs';
import { applyReservationMetricsToBox } from '../runtimeAllocationReservations.mjs';
import { allocationReservesCapacity } from '../../../../../../shared/domain/filmAllocationReservations.mjs';
import { recordFilmWeightSampleFromBox } from '../../filmWeightProfiles.mjs';

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

function parseOptionalReceivedFeet(value) {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new HttpError(400, 'CurrentFeetOnRoll must be a valid non-negative number.');
  }

  return Math.floor(parsed);
}

function sumLockedAllocatedFeet(allocations) {
  return (Array.isArray(allocations) ? allocations : []).reduce((total, entry) => {
    if (entry?.status !== 'ACTIVE') {
      return total;
    }

    return total + (allocationReservesCapacity(entry, { status: 'ORDERED' }) ? Number(entry?.allocatedFeet || 0) : 0);
  }, 0);
}

function buildReceiveAuditNote(boxId, receivedWeightLbs, currentFeetOnRoll, lotRun) {
  const details = [];

  if (currentFeetOnRoll !== null) {
    details.push(`with ${currentFeetOnRoll} LF recorded`);
  }

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

function appendFilmWeightProfileWarning(warnings, result, boxId) {
  const decision = asTrimmedString(result?.decision);
  if (decision === 'pending_review') {
    warnings.push(`Film weight sample for box ${boxId} was queued for Weight Chart review.`);
  } else if (decision === 'logging_failed' && asTrimmedString(result?.warning)) {
    warnings.push(asTrimmedString(result.warning));
  }
}

async function reconcileReceivedBoxPhysicalReality(client, orgId, box, actor, warnings) {
  const physicalFeetAfter = Math.max(0, Number(box?.initialFeet || 0) || 0);
  const reconciliationResult = await reconcileBoxCheckinAllocations(
    client,
    orgId,
    {
      boxId: box.boxId,
      physicalFeetAfter,
    },
    actor
  );

  if (Array.isArray(reconciliationResult.warnings) && reconciliationResult.warnings.length > 0) {
    warnings.push(...reconciliationResult.warnings);
  }

  const nextBox = {
    ...cloneValue(box),
    feetAvailable: Math.max(0, Number(reconciliationResult.feetAvailable ?? box.feetAvailable) || 0),
  };

  return saveBoxRecord(client, orgId, nextBox);
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
  const receivedFeet = parseOptionalReceivedFeet(payload.currentFeetOnRoll ?? payload.receivedFeet);
  const requestedLotRun = asTrimmedString(payload.lotRun);
  const requestedCoreType = normalizeCoreType(payload.coreType, true);
  const existingAllocations = await listAllocationsByBox(client, orgId, existing.boxId);
  const lockedAllocatedFeet = sumLockedAllocatedFeet(existingAllocations);
  const receivedDate = todayDateString();
  const updatedBox = cloneValue(existing);

  updatedBox.status = 'IN_STOCK';
  updatedBox.receivedDate = receivedDate;
  if (receivedFeet !== null) {
    updatedBox.initialFeet = receivedFeet;
  }
  updatedBox.feetAvailable = Math.max(updatedBox.initialFeet - lockedAllocatedFeet, 0);
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

  let persistedBox = await saveBoxRecord(client, orgId, updatedBox);
  persistedBox = await reconcileReceivedBoxPhysicalReality(client, orgId, persistedBox, actor, warnings);
  persistedBox = await processLinkedFilmOrderReceipt(client, orgId, persistedBox, actor, warnings);
  persistedBox = await saveBoxRecord(client, orgId, persistedBox);
  persistedBox = await reconcileReceivedBoxPhysicalReality(client, orgId, persistedBox, actor, warnings);
  await recalculateFilmOrdersForBoxLinks(client, orgId, persistedBox.boxId, actor);

  await seedFilmCatalogRecordIfMissing(client, orgId, {
    filmKey: persistedBox.filmKey,
    manufacturer: persistedBox.manufacturer,
    filmName: persistedBox.filmName,
    sourceBoxId: persistedBox.boxId
  });

  appendFilmWeightProfileWarning(
    warnings,
    await recordFilmWeightSampleFromBox(client, orgId, persistedBox.boxId, actor),
    persistedBox.boxId
  );

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
    buildReceiveAuditNote(persistedBox.boxId, receivedWeightLbs, receivedFeet, updatedBox.lotRun)
  );

  return ok({ box: publicAfter, logId }, warnings);
}

export { receiveOrderedBox };
