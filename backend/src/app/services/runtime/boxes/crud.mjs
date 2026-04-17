import {
  HttpError,
  ok,
  asTrimmedString,
  requireString,
  cloneValue,
  hasPositivePhysicalFeet,
  hasIncompleteBoxHistoryForZeroedEdit,
  hasExplicitZeroFeetAvailableInput,
  stampZeroedMetadata,
  applyAddOrEditWarnings,
  toPublicBox,
  findBoxById,
  listAllocationsByBox,
  saveBoxRecord,
  seedFilmCatalogRecordIfMissing,
  appendAuditEntry,
} from '../../runtimeDeps.mjs';
import { findBoxIdConflict } from '../runtimeTransferUsage.mjs';
import {
  linkBoxToFilmOrder,
  processLinkedFilmOrderReceipt,
} from '../runtimeAllocationPlanning.mjs';
import { hasPositiveReactivationSignal } from '../checkout/checkoutFlow.mjs';
import { cancelAllocationsForZeroedBox } from '../checkout/cancellations.mjs';
import { buildBoxFromPayload } from '../runtimeCollectionsAndBoxes.mjs';
import { applyReservationMetricsToBox } from '../runtimeAllocationReservations.mjs';
import { reconcileReservationShortagesForBox } from '../runtimeAllocationReservationReconciliation.mjs';

async function addBox(client, orgId, payload, actor) {
  const warnings = [];
  const boxId = requireString(payload.boxId, 'BoxID');

  if (await findBoxById(client, orgId, boxId)) {
    throw new HttpError(400, 'A box with this BoxID already exists.');
  }

  const addBoxConflict = await findBoxIdConflict(client, orgId, boxId);
  if (addBoxConflict?.conflictType === 'pending_transfer') {
    throw new HttpError(
      400,
      `BoxID ${boxId.toUpperCase()} is already reserved by a pending transfer and cannot be reused yet.`
    );
  }

  let box = await buildBoxFromPayload(client, orgId, payload, warnings, null);
  applyAddOrEditWarnings(warnings, null, box);
  box = await saveBoxRecord(client, orgId, box);
  await seedFilmCatalogRecordIfMissing(client, orgId, {
    filmKey: box.filmKey,
    manufacturer: box.manufacturer,
    filmName: box.filmName,
    sourceBoxId: box.boxId
  });

  if (asTrimmedString(payload.filmOrderId)) {
    const linkedOrder = await linkBoxToFilmOrder(client, orgId, payload.filmOrderId, box, actor);
    warnings.push(
      `Box ${box.boxId} was linked to Film Order ${linkedOrder.filmOrderId} for job ${linkedOrder.jobNumber}.`
    );

    if (box.receivedDate && box.status === 'IN_STOCK') {
      box = await processLinkedFilmOrderReceipt(client, orgId, cloneValue(box), actor, warnings);
      box = await saveBoxRecord(client, orgId, box);
    }
  }

  const publicBox = toPublicBox(
    applyReservationMetricsToBox(box, await listAllocationsByBox(client, orgId, box.boxId))
  );
  const logId = await appendAuditEntry(
    client,
    orgId,
    'ADD_BOX',
    box.boxId,
    null,
    publicBox,
    actor,
    asTrimmedString(payload.auditNote)
  );

  return ok({ box: publicBox, logId }, warnings);
}

async function updateBox(client, orgId, payload, actor) {
  const warnings = [];
  const requestedMoveToZeroed = payload.moveToZeroed === true || String(payload.moveToZeroed) === 'true';
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
    const requestedReactivateFromZeroed =
      payload.reactivateFromZeroed === true || String(payload.reactivateFromZeroed) === 'true';
    let updatedBox = await buildBoxFromPayload(client, orgId, payload, warnings, existing);
    const shouldReactivate = hasPositiveReactivationSignal(updatedBox) && requestedReactivateFromZeroed;

    if (hasPositiveReactivationSignal(updatedBox) && !requestedReactivateFromZeroed) {
      throw new HttpError(
        400,
        'Zeroed boxes with new active inventory values must be confirmed before moving back to IN_STOCK.'
      );
    }

    if (shouldReactivate) {
      updatedBox.status = 'IN_STOCK';
      updatedBox.zeroedDate = '';
      updatedBox.zeroedReason = '';
      updatedBox.zeroedBy = '';
      warnings.push(`Box ${updatedBox.boxId} was moved back to active IN_STOCK inventory.`);
    }

    applyAddOrEditWarnings(warnings, existing, updatedBox);
    updatedBox = await saveBoxRecord(client, orgId, updatedBox);
    const publicBefore = toPublicBox(
      applyReservationMetricsToBox(existing, await listAllocationsByBox(client, orgId, existing.boxId))
    );
    const publicAfter = toPublicBox(
      applyReservationMetricsToBox(updatedBox, await listAllocationsByBox(client, orgId, updatedBox.boxId))
    );
    const logId = await appendAuditEntry(
      client,
      orgId,
      shouldReactivate ? 'SET_STATUS' : 'UPDATE_BOX',
      updatedBox.boxId,
      publicBefore,
      publicAfter,
      actor,
      asTrimmedString(payload.auditNote)
    );

    return ok({ box: publicAfter, logId }, warnings);
  }

  let updatedBox = await buildBoxFromPayload(client, orgId, payload, warnings, existing);

  applyAddOrEditWarnings(warnings, existing, updatedBox);

  let auditAction = 'UPDATE_BOX';
  const confirmedExplicitFeetMoveToZeroed =
    requestedMoveToZeroed &&
    Boolean(existing.receivedDate) &&
    hasPositivePhysicalFeet(existing) &&
    hasExplicitZeroFeetAvailableInput(payload);

  if (confirmedExplicitFeetMoveToZeroed) {
    updatedBox.feetAvailable = 0;
  }

  const confirmedExplicitWeightMoveToZeroed =
    requestedMoveToZeroed &&
    Boolean(existing.receivedDate) &&
    hasPositivePhysicalFeet(existing) &&
    updatedBox.lastRollWeightLbs === 0;
  const confirmedIncompleteHistoryMoveToZeroed =
    requestedMoveToZeroed &&
    updatedBox.lastRollWeightLbs === 0 &&
    (hasIncompleteBoxHistoryForZeroedEdit(existing) || hasIncompleteBoxHistoryForZeroedEdit(updatedBox));
  const moveToZeroed =
    confirmedIncompleteHistoryMoveToZeroed ||
    confirmedExplicitFeetMoveToZeroed ||
    confirmedExplicitWeightMoveToZeroed;

  if (moveToZeroed) {
    if (
      !confirmedIncompleteHistoryMoveToZeroed &&
      !confirmedExplicitFeetMoveToZeroed &&
      !confirmedExplicitWeightMoveToZeroed
    ) {
      throw new HttpError(
        400,
        'Received boxes move to zeroed out inventory only after they have had Available Feet above 0 and then reach 0 Available Feet or 0 Last Roll Weight.'
      );
    }

    stampZeroedMetadata(updatedBox, actor, payload.auditNote);
    const cancelledAllocationCount = await cancelAllocationsForZeroedBox(
      client,
      orgId,
      updatedBox.boxId,
      actor
    );
    updatedBox = await saveBoxRecord(client, orgId, updatedBox);
    auditAction = 'ZERO_OUT_BOX';

    if (confirmedIncompleteHistoryMoveToZeroed) {
      warnings.push(
        'Box was moved to zeroed out inventory after confirming a 0 Last Roll Weight save on a box with incomplete history.'
      );
    } else if (confirmedExplicitFeetMoveToZeroed) {
      warnings.push(
        'Box was moved to zeroed out inventory after confirming a Current Linear Feet value of 0 on a received box with recorded physical feet.'
      );
    } else if (confirmedExplicitWeightMoveToZeroed) {
      warnings.push(
        'Box was moved to zeroed out inventory after confirming a Last Roll Weight value of 0 on a received box with recorded physical feet.'
      );
    }

    if (cancelledAllocationCount > 0) {
      warnings.push(
        `${cancelledAllocationCount} allocation${cancelledAllocationCount === 1 ? ' was' : 's were'} cancelled because the box moved to zeroed out inventory.`
      );
    }
  } else {
    updatedBox = await processLinkedFilmOrderReceipt(client, orgId, updatedBox, actor, warnings);
    updatedBox = await saveBoxRecord(client, orgId, updatedBox);
  }

  if (updatedBox.status === 'IN_STOCK' || updatedBox.status === 'TRANSFER') {
    const shortageReconciliation = await reconcileReservationShortagesForBox(
      client,
      orgId,
      updatedBox.boxId,
      actor,
      { allowPlaceholderShortages: true }
    );
    if (shortageReconciliation.createdCount > 0) {
      warnings.push(
        `Created ${shortageReconciliation.createdCount} shortage film order${shortageReconciliation.createdCount === 1 ? '' : 's'} after confirming the updated box footage.`
      );
    }
    if (shortageReconciliation.deletedCount > 0) {
      warnings.push(
        `Removed ${shortageReconciliation.deletedCount} stale shortage film order${shortageReconciliation.deletedCount === 1 ? '' : 's'} after confirming the updated box footage.`
      );
    }
  }

  await seedFilmCatalogRecordIfMissing(client, orgId, {
    filmKey: updatedBox.filmKey,
    manufacturer: updatedBox.manufacturer,
    filmName: updatedBox.filmName,
    sourceBoxId: updatedBox.boxId
  });

  const publicBefore = toPublicBox(
    applyReservationMetricsToBox(existing, await listAllocationsByBox(client, orgId, existing.boxId))
  );
  const publicAfter = toPublicBox(
    applyReservationMetricsToBox(updatedBox, await listAllocationsByBox(client, orgId, updatedBox.boxId))
  );
  const logId = await appendAuditEntry(
    client,
    orgId,
    auditAction,
    updatedBox.boxId,
    publicBefore,
    publicAfter,
    actor,
    asTrimmedString(payload.auditNote)
  );

  return ok({ box: publicAfter, logId }, warnings);
}

export {
  addBox,
  updateBox,
};
