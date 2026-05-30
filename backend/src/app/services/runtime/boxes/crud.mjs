import {
  HttpError,
  ok,
  asTrimmedString,
  requireString,
  normalizeJobLifecycleStatus,
  todayDateString,
  cloneValue,
  hasPositivePhysicalFeet,
  hasIncompleteBoxHistoryForZeroedEdit,
  hasExplicitZeroFeetAvailableInput,
  stampZeroedMetadata,
  applyAddOrEditWarnings,
  toPublicBox,
  findBoxById,
  findFilmOrderById,
  findJobById,
  findJobByNumber,
  listAllocationsByBox,
  reconcileBoxCheckinAllocations,
  saveBoxRecord,
  seedFilmCatalogRecordIfMissing,
  appendAuditEntry,
} from '../../runtimeDeps.mjs';
import { findBoxIdConflict } from '../runtimeTransferUsage.mjs';
import {
  createAllocationRecord,
  linkBoxToFilmOrder,
  processLinkedFilmOrderReceipt,
} from '../runtimeAllocationPlanning.mjs';
import {
  hasPositiveReactivationSignal,
  resolveAllocationsForCheckout,
} from '../checkout/checkoutFlow.mjs';
import { buildBoxFromPayload } from '../runtimeCollectionsAndBoxes.mjs';
import { recalculateFilmOrdersForBoxLinks } from '../runtimeAllocationCleanup.mjs';
import { applyReservationMetricsToBox } from '../runtimeAllocationReservations.mjs';
import {
  assertDirectToJobSiteFlagIsServerOwned,
  assertNoShipDirectToJobSiteFlag,
  assertNoWarehouseReceiptInputsForDirectToJobSite,
  buildDirectToJobSiteCheckedOutAuditNote,
  buildDirectToJobSiteCreatedAuditNote,
  getDirectToJobSiteAvailableFeet,
  getDirectToJobSiteCommittedFeet,
  parseShipDirectToJobSiteFlag,
} from './directToJobSite.mjs';

async function addBox(client, orgId, payload, actor) {
  const warnings = [];
  const boxId = requireString(payload.boxId, 'BoxID');
  const filmOrderId = asTrimmedString(payload.filmOrderId);
  const shipDirectToJobSite = parseShipDirectToJobSiteFlag(payload);
  let directToJobSiteOrder = null;
  let directToJobSiteJob = null;

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

  assertDirectToJobSiteFlagIsServerOwned(payload, 'Add Box');

  if (shipDirectToJobSite) {
    if (!filmOrderId) {
      throw new HttpError(
        400,
        'Ship Directly to Job Site is only available when adding a box through Film Order fulfillment.'
      );
    }

    assertNoWarehouseReceiptInputsForDirectToJobSite(payload);

    directToJobSiteOrder = await findFilmOrderById(client, orgId, filmOrderId);
    if (!directToJobSiteOrder) {
      throw new HttpError(404, 'Film Order not found.');
    }

    if (directToJobSiteOrder.status === 'CANCELLED') {
      throw new HttpError(400, 'Cancelled Film Orders cannot receive new boxes.');
    }

    if (!asTrimmedString(directToJobSiteOrder.jobNumber)) {
      throw new HttpError(
        400,
        `Film Order ${directToJobSiteOrder.filmOrderId} must stay linked to a job before Ship Directly to Job Site can be used.`
      );
    }

    if (!asTrimmedString(directToJobSiteOrder.installDate)) {
      throw new HttpError(
        400,
        `Film Order ${directToJobSiteOrder.filmOrderId} must have an Install Date before Ship Directly to Job Site can be used.`
      );
    }

    const directToJobSiteJobId = asTrimmedString(directToJobSiteOrder.jobId);
    directToJobSiteJob = directToJobSiteJobId
      ? await findJobById(client, orgId, directToJobSiteJobId)
      : await findJobByNumber(client, orgId, directToJobSiteOrder.jobNumber);
    if (!directToJobSiteJob) {
      throw new HttpError(
        400,
        `Film Order ${directToJobSiteOrder.filmOrderId} must stay linked to an active job before Ship Directly to Job Site can be used.`
      );
    }

    if (
      normalizeJobLifecycleStatus(directToJobSiteJob.lifecycleStatus) === 'ACTIVE' &&
      asTrimmedString(directToJobSiteJob.jobNumber) !== asTrimmedString(directToJobSiteOrder.jobNumber)
    ) {
      throw new HttpError(
        400,
        `Film Order ${directToJobSiteOrder.filmOrderId} is linked to a different job than its displayed job number.`
      );
    }

    if (normalizeJobLifecycleStatus(directToJobSiteJob.lifecycleStatus) !== 'ACTIVE') {
      throw new HttpError(
        400,
        `Job ${directToJobSiteOrder.jobNumber} is closed and cannot receive direct-to-job-site film.`
      );
    }
  }

  let box = await buildBoxFromPayload(client, orgId, payload, warnings, null);
  if (shipDirectToJobSite) {
    box.status = 'ORDERED';
    box.receivedDate = '';
    box.initialWeightLbs = null;
    box.lastRollWeightLbs = null;
    box.lastWeighedDate = '';
    box.coreType = '';
    box.coreWeightLbs = null;
    box.lfWeightLbsPerFt = null;
    box.feetAvailable = 0;
    box.directToJobSite = true;
  }
  applyAddOrEditWarnings(warnings, null, box);
  box = await saveBoxRecord(client, orgId, box);
  await seedFilmCatalogRecordIfMissing(client, orgId, {
    filmKey: box.filmKey,
    manufacturer: box.manufacturer,
    filmName: box.filmName,
    sourceBoxId: box.boxId
  });

  let addLogId = '';
  if (shipDirectToJobSite && directToJobSiteOrder) {
    const createdPublicBox = toPublicBox(
      applyReservationMetricsToBox(box, await listAllocationsByBox(client, orgId, box.boxId))
    );
    addLogId = await appendAuditEntry(
      client,
      orgId,
      'ADD_BOX',
      box.boxId,
      null,
      createdPublicBox,
      actor,
      buildDirectToJobSiteCreatedAuditNote({
        filmOrderId: directToJobSiteOrder.filmOrderId,
        jobNumber: directToJobSiteOrder.jobNumber,
        userNote: payload.auditNote
      })
    );
  }

  if (filmOrderId) {
    const linkedOrder = await linkBoxToFilmOrder(client, orgId, filmOrderId, box, actor);
    warnings.push(
      `Box ${box.boxId} was linked to Film Order ${linkedOrder.filmOrderId} for job ${linkedOrder.jobNumber}.`
    );

    if (shipDirectToJobSite) {
      const committedFeet = getDirectToJobSiteCommittedFeet(linkedOrder, box.initialFeet);
      if (committedFeet > 0) {
        await createAllocationRecord(
          client,
          orgId,
          box,
          {
            jobId: asTrimmedString(linkedOrder.jobId || directToJobSiteOrder.jobId || directToJobSiteJob?.id),
            jobNumber: linkedOrder.jobNumber,
            installDate: linkedOrder.installDate,
            crewLeader: asTrimmedString(linkedOrder.crewLeader) || asTrimmedString(directToJobSiteJob?.crewLeader)
          },
          committedFeet,
          committedFeet,
          actor,
          linkedOrder.filmOrderId
        );
      }

      const checkedOutBox = {
        ...cloneValue(box),
        status: 'CHECKED_OUT',
        directToJobSite: true,
        feetAvailable: getDirectToJobSiteAvailableFeet(box.initialFeet, committedFeet),
        hasEverBeenCheckedOut: true,
        lastCheckoutJobId: asTrimmedString(linkedOrder.jobId || directToJobSiteOrder.jobId || directToJobSiteJob?.id),
        lastCheckoutJob: linkedOrder.jobNumber,
        lastCheckoutDate: todayDateString(),
        zeroedDate: '',
        zeroedReason: '',
        zeroedBy: ''
      };
      const publicBeforeCheckout = toPublicBox(
        applyReservationMetricsToBox(box, await listAllocationsByBox(client, orgId, box.boxId))
      );
      box = await saveBoxRecord(client, orgId, checkedOutBox);
      const allocationResolution = await resolveAllocationsForCheckout(
        client,
        orgId,
        box.boxId,
        linkedOrder.jobNumber,
        actor
      );
      if (allocationResolution.fulfilledCount > 0) {
        warnings.push(
          `Kept ${allocationResolution.fulfilledCount} allocation${allocationResolution.fulfilledCount === 1 ? '' : 's'} totaling ${allocationResolution.fulfilledFeet} LF linked to job ${linkedOrder.jobNumber} after direct-to-site checkout.`
        );
      }

      if (allocationResolution.otherJobs.length > 0) {
        warnings.push(`This box still has active allocations for ${allocationResolution.otherJobs.join(', ')}.`);
      }

      await recalculateFilmOrdersForBoxLinks(client, orgId, box.boxId, actor);
      const publicAfterCheckout = toPublicBox(
        applyReservationMetricsToBox(box, await listAllocationsByBox(client, orgId, box.boxId))
      );
      await appendAuditEntry(
        client,
        orgId,
        'SET_STATUS',
        box.boxId,
        publicBeforeCheckout,
        publicAfterCheckout,
        actor,
        buildDirectToJobSiteCheckedOutAuditNote({
          filmOrderId: linkedOrder.filmOrderId,
          jobNumber: linkedOrder.jobNumber
        })
      );

      return ok({ box: publicAfterCheckout, logId: addLogId }, warnings);
    }

    if (box.receivedDate && box.status === 'IN_STOCK') {
      box = await processLinkedFilmOrderReceipt(client, orgId, cloneValue(box), actor, warnings);
      box = await saveBoxRecord(client, orgId, box);
      await recalculateFilmOrdersForBoxLinks(client, orgId, box.boxId, actor);
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
  assertDirectToJobSiteFlagIsServerOwned(payload, 'Update Box');
  assertNoShipDirectToJobSiteFlag(payload, 'Update Box');
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
    const reconciliationResult = await reconcileBoxCheckinAllocations(
      client,
      orgId,
      {
        boxId: updatedBox.boxId,
        physicalFeetAfter: 0
      },
      actor
    );
    if (Array.isArray(reconciliationResult.warnings) && reconciliationResult.warnings.length > 0) {
      warnings.push(...reconciliationResult.warnings);
    }
    updatedBox.feetAvailable = Math.max(0, Number(reconciliationResult.feetAvailable ?? 0) || 0);
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

  } else {
    updatedBox = await processLinkedFilmOrderReceipt(client, orgId, updatedBox, actor, warnings);
    updatedBox = await saveBoxRecord(client, orgId, updatedBox);
    await recalculateFilmOrdersForBoxLinks(client, orgId, updatedBox.boxId, actor);
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
