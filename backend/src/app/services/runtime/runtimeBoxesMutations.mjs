// Purpose: Box mutation and transfer runtime workflows.
import {
  HttpError,
  ok,
  asTrimmedString,
  requireString,
  coerceNonNegativeNumber,
  assertBoxStatus,
  integerOrZero,
  cloneValue,
  createTransferId,
  roundToDecimals,
  todayDateString,
  deriveLifecycleStatus,
  deriveFeetAvailableFromRollWeight,
  hasPositivePhysicalFeet,
  hasIncompleteBoxHistoryForZeroedEdit,
  hasExplicitZeroFeetAvailableInput,
  stampZeroedMetadata,
  applyAddOrEditWarnings,
  applyCheckoutWarnings,
  applyCheckInWarnings,
  toPublicBox,
  toPublicBoxTransfer,
  findWarehouseEntry,
  buildTransferredBoxId,
  findBoxById,
  saveBoxRecord,
  findBoxByRecordId,
  findBoxTransferByTransferId,
  getLatestBoxTransferByBoxId,
  findPendingBoxTransferByBoxRecordId,
  saveBoxTransferRecord,
  listAllocationsByBox,
  seedFilmCatalogRecordIfMissing,
  appendAuditEntry,
  appendRollHistoryEntry,
} from '../runtimeDeps.mjs';
import {
  listActiveAllocationTransferTargetsForBox,
  getTransferStartGuardForBox,
  applyReceivedBoxTransfer,
  boxIdOrAliasExists,
  releaseReusableBoxIdAlias,
} from './runtimeTransferUsage.mjs';
import {
  linkBoxToFilmOrder,
  processLinkedFilmOrderReceipt,
} from './runtimeAllocationPlanning.mjs';
import {
  removeAllocationFromJob,
} from './runtimeAllocationCleanup.mjs';
import {
  listCheckoutCrewConflictJobsForBox,
  autoLinkRemainingJobFeetToCheckedOutBox,
} from './runtimeAllocationLinks.mjs';
import {
  hasPositiveReactivationSignal,
  resolveAllocationsForCheckout,
  cancelAllocationsForZeroedBox,
  findLatestCheckoutAuditEntryByBoxId,
  getCheckoutJobNumberFromAuditNotes,
} from './runtimeCheckoutOperations.mjs';
import {
  buildBoxFromPayload,
} from './runtimeCollectionsAndBoxes.mjs';

async function addBox(client, orgId, payload, actor) {
  const warnings = [];
  const boxId = requireString(payload.boxId, 'BoxID');

  if (await findBoxById(client, orgId, boxId)) {
    throw new HttpError(400, 'A box with this BoxID already exists.');
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

  const publicBox = toPublicBox(box);
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
    const publicBefore = toPublicBox(existing);
    const publicAfter = toPublicBox(updatedBox);
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

  await seedFilmCatalogRecordIfMissing(client, orgId, {
    filmKey: updatedBox.filmKey,
    manufacturer: updatedBox.manufacturer,
    filmName: updatedBox.filmName,
    sourceBoxId: updatedBox.boxId
  });

  const publicBefore = toPublicBox(existing);
  const publicAfter = toPublicBox(updatedBox);
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

async function setBoxStatus(client, orgId, payload, actor) {
  const warnings = [];
  const status = assertBoxStatus(payload.status);

  if (status === 'ORDERED') {
    throw new HttpError(400, 'ORDERED is derived from ReceivedDate and cannot be set manually.');
  }

  if (status === 'RETIRED') {
    throw new HttpError(400, 'RETIRED status is no longer supported.');
  }

  if (status === 'ZEROED') {
    throw new HttpError(400, 'ZEROED status is assigned automatically when a received box reaches 0.');
  }

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

  if (deriveLifecycleStatus(existing.receivedDate) === 'ORDERED') {
    throw new HttpError(400, 'Add a ReceivedDate on or before today before changing status.');
  }

  if (existing.status === 'ZEROED') {
    throw new HttpError(400, 'Zeroed boxes cannot change status directly. Use audit undo instead.');
  }

  if (existing.status === 'RETIRED') {
    throw new HttpError(400, 'Retired boxes cannot change status directly. Use audit undo instead.');
  }

  let updatedBox = cloneValue(existing);
  let auditAction = 'SET_STATUS';

  if (status === 'CHECKED_OUT') {
    const jobNumber = getCheckoutJobNumberFromAuditNotes(payload.auditNote);
    if (!jobNumber) {
      throw new HttpError(400, 'A checkout job number is required.');
    }

    const crewConflictJobs = await listCheckoutCrewConflictJobsForBox(
      client,
      orgId,
      existing.boxId,
      jobNumber
    );
    if (crewConflictJobs.length > 0) {
      throw new HttpError(
        400,
        `Box ${existing.boxId} is still allocated to ${crewConflictJobs.join(', ')} with a different crew leader. Clear those allocations before checkout.`
      );
    }

    updatedBox.status = 'CHECKED_OUT';
    updatedBox.hasEverBeenCheckedOut = true;
    updatedBox.lastCheckoutJob = jobNumber;
    updatedBox.lastCheckoutDate = todayDateString();
    updatedBox.zeroedDate = '';
    updatedBox.zeroedReason = '';
    updatedBox.zeroedBy = '';
    applyCheckoutWarnings(warnings, existing);

    const autoLinkResult = await autoLinkRemainingJobFeetToCheckedOutBox(
      client,
      orgId,
      updatedBox,
      jobNumber,
      actor,
      'checkout'
    );
    if (autoLinkResult.created) {
      warnings.push(
        `Auto-linked ${autoLinkResult.allocatedFeet} LF from ${updatedBox.boxId} to job ${jobNumber} at checkout.`
      );
    } else if (autoLinkResult.skippedReason === 'NO_REQUIREMENTS') {
      warnings.push(`No job requirements were found for job ${jobNumber}, so no LF was auto-linked.`);
    }

    const allocationResolution = await resolveAllocationsForCheckout(
      client,
      orgId,
      updatedBox.boxId,
      jobNumber,
      actor
    );
    if (allocationResolution.fulfilledCount > 0) {
      warnings.push(
        `Kept ${allocationResolution.fulfilledCount} allocation${allocationResolution.fulfilledCount === 1 ? '' : 's'} totaling ${allocationResolution.fulfilledFeet} LF linked to job ${jobNumber} after checkout.`
      );
    }

    if (allocationResolution.otherJobs.length > 0) {
      warnings.push(`This box still has active allocations for ${allocationResolution.otherJobs.join(', ')}.`);
    }

    updatedBox = await saveBoxRecord(client, orgId, updatedBox);
  } else {
    updatedBox.status = 'IN_STOCK';
    updatedBox.lastRollWeightLbs = coerceNonNegativeNumber(payload.lastRollWeightLbs, 'LastRollWeightLbs');
    updatedBox.lastWeighedDate = todayDateString();
    let physicalFeetAvailable = updatedBox.feetAvailable;

    if (
      updatedBox.coreWeightLbs !== null &&
      updatedBox.lfWeightLbsPerFt !== null &&
      updatedBox.lfWeightLbsPerFt > 0
    ) {
      physicalFeetAvailable = deriveFeetAvailableFromRollWeight(
        updatedBox.lastRollWeightLbs,
        updatedBox.coreWeightLbs,
        updatedBox.lfWeightLbsPerFt,
        updatedBox.initialFeet
      );
    } else {
      warnings.push(
        'Available Feet could not be recalculated because this box is missing core or LF weight metadata.'
      );
    }

    const existingAllocations = await listAllocationsByBox(client, orgId, updatedBox.boxId);
    let activeAllocatedFeetAfterCheckIn = 0;
    for (let index = 0; index < existingAllocations.length; index += 1) {
      if (existingAllocations[index].status === 'ACTIVE') {
        activeAllocatedFeetAfterCheckIn += existingAllocations[index].allocatedFeet;
      }
    }

    if (activeAllocatedFeetAfterCheckIn > physicalFeetAvailable) {
      throw new HttpError(
        400,
        `Received physical LF cannot be lower than the box's active allocated feet (${activeAllocatedFeetAfterCheckIn}).`
      );
    }

    updatedBox.feetAvailable = Math.max(physicalFeetAvailable - activeAllocatedFeetAfterCheckIn, 0);
    const willAutoZero =
      Boolean(updatedBox.receivedDate) &&
      existing.initialFeet > 0 &&
      (physicalFeetAvailable === 0 || updatedBox.lastRollWeightLbs === 0);

    applyCheckInWarnings(warnings, existing, updatedBox, willAutoZero);
    if (activeAllocatedFeetAfterCheckIn > 0 && updatedBox.feetAvailable === 0) {
      warnings.push('All remaining LF on this box is reserved by active allocations.');
    }

    const checkoutAudit = await findLatestCheckoutAuditEntryByBoxId(client, orgId, updatedBox.boxId);
    let checkoutJob = asTrimmedString(existing.lastCheckoutJob);
    let checkoutDate = asTrimmedString(existing.lastCheckoutDate);
    let checkoutUser = '';

    if (checkoutAudit) {
      if (!checkoutJob) {
        checkoutJob = getCheckoutJobNumberFromAuditNotes(checkoutAudit.notes);
      }

      if (!checkoutDate) {
        checkoutDate = asTrimmedString(checkoutAudit.date);
      }

      checkoutUser = asTrimmedString(checkoutAudit.user);
    }

    if (!checkoutJob) {
      checkoutJob = 'UNKNOWN';
      warnings.push('Roll history was logged with UNKNOWN job number because no checkout job was saved.');
    }

    if (!checkoutDate) {
      checkoutDate = todayDateString();
    }

    const checkedOutWeight = existing.lastRollWeightLbs;
    const weightDelta =
      checkedOutWeight === null ? null : roundToDecimals(checkedOutWeight - updatedBox.lastRollWeightLbs, 2);

    if (checkedOutWeight === null) {
      warnings.push(
        'Roll history was logged without an outbound weight because no Last Roll Weight was saved at checkout.'
      );
    }

    await appendRollHistoryEntry(client, orgId, {
      logId: '',
      boxId: updatedBox.boxId,
      warehouse: updatedBox.warehouse,
      manufacturer: updatedBox.manufacturer,
      filmName: updatedBox.filmName,
      widthIn: updatedBox.widthIn,
      jobNumber: checkoutJob,
      checkedOutAt: checkoutDate,
      checkedOutBy: checkoutUser,
      checkedOutWeightLbs: checkedOutWeight,
      checkedInAt: new Date().toISOString(),
      checkedInBy: actor,
      checkedInWeightLbs: updatedBox.lastRollWeightLbs,
      weightDeltaLbs: weightDelta,
      feetBefore: existing.feetAvailable,
      feetAfter: updatedBox.feetAvailable,
      notes: asTrimmedString(payload.auditNote)
    });

    updatedBox.lastCheckoutJob = '';
    updatedBox.lastCheckoutDate = '';

    const reachedZeroState =
      Boolean(updatedBox.receivedDate) &&
      (physicalFeetAvailable === 0 || updatedBox.lastRollWeightLbs === 0);
    const autoMoveToZeroed = willAutoZero;

    if (autoMoveToZeroed) {
      stampZeroedMetadata(updatedBox, actor, payload.auditNote);
      const cancelledAllocationCount = await cancelAllocationsForZeroedBox(
        client,
        orgId,
        updatedBox.boxId,
        actor
      );
      updatedBox = await saveBoxRecord(client, orgId, updatedBox);
      auditAction = 'ZERO_OUT_BOX';
      warnings.push(
        'Box was automatically moved to zeroed out inventory because Available Feet or Last Roll Weight reached 0.'
      );

      if (cancelledAllocationCount > 0) {
        warnings.push(
          `${cancelledAllocationCount} allocation${cancelledAllocationCount === 1 ? ' was' : 's were'} cancelled because the box moved to zeroed out inventory.`
        );
      }
    } else {
      if (reachedZeroState && existing.feetAvailable <= 0) {
        warnings.push('Box stayed in active inventory because it has not had Available Feet above 0 yet.');
      }

      updatedBox = await saveBoxRecord(client, orgId, updatedBox);
    }
  }

  const publicBefore = toPublicBox(existing);
  const publicAfter = toPublicBox(updatedBox);
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

async function getBoxTransferByBox(client, orgId, boxId) {
  const resolved = await getLatestBoxTransferByBoxId(client, orgId, boxId);
  if (!resolved.box) {
    throw new HttpError(404, 'Box not found.');
  }

  return toPublicBoxTransfer(resolved.transfer);
}

async function startBoxTransfer(client, orgId, payload, actor) {
  const box = await findBoxById(client, orgId, payload.boxId);
  if (!box) {
    throw new HttpError(404, 'Box not found.');
  }

  if (box.status !== 'IN_STOCK') {
    throw new HttpError(400, `Only in-stock boxes can start a transfer. Box ${box.boxId} is ${box.status}.`);
  }

  const existingPendingTransfer = await findPendingBoxTransferByBoxRecordId(client, orgId, box.id);
  if (existingPendingTransfer) {
    throw new HttpError(
      400,
      `Box ${box.boxId} already has a pending transfer to ${existingPendingTransfer.destinationWarehouse}.`
    );
  }

  const sourceWarehouse = await findWarehouseEntry(client, orgId, box.warehouse, 'FromWarehouse');
  const destinationWarehouse = await findWarehouseEntry(client, orgId, payload.toWarehouse, 'ToWarehouse');
  if (destinationWarehouse.code === sourceWarehouse.code) {
    throw new HttpError(400, 'Transfer destination must be different from the current warehouse.');
  }

  const activeTargets = await listActiveAllocationTransferTargetsForBox(client, orgId, box.boxId);
  const transferGuard = getTransferStartGuardForBox(box, activeTargets);
  if (transferGuard.blockingMessage) {
    throw new HttpError(400, transferGuard.blockingMessage);
  }

  if (
    transferGuard.suggestedDestinationWarehouse &&
    transferGuard.suggestedDestinationWarehouse !== destinationWarehouse.code
  ) {
    throw new HttpError(
      400,
      `Box ${box.boxId} is currently allocated to a ${transferGuard.suggestedDestinationWarehouse} job and must be transferred there.`
    );
  }

  const nowIso = new Date().toISOString();
  const transfer = await saveBoxTransferRecord(client, orgId, {
    transferId: createTransferId(),
    boxRecordId: box.id,
    sourceBoxId: box.boxId,
    destinationBoxId: buildTransferredBoxId(
      box.boxId,
      sourceWarehouse.boxIdPrefix || sourceWarehouse.code,
      destinationWarehouse.boxIdPrefix || destinationWarehouse.code
    ),
    sourceWarehouse: sourceWarehouse.code,
    destinationWarehouse: destinationWarehouse.code,
    status: 'PENDING',
    notes: asTrimmedString(payload.notes),
    createdAt: nowIso,
    createdBy: actor,
    receivedAt: '',
    receivedBy: '',
    cancelledAt: '',
    cancelledBy: '',
    updatedAt: nowIso,
    updatedBy: actor
  });

  const beforeState = toPublicBox(box);
  const nextBox = await saveBoxRecord(client, orgId, {
    ...cloneValue(box),
    status: 'TRANSFER'
  });
  const afterState = toPublicBox(nextBox);
  const logId = await appendAuditEntry(
    client,
    orgId,
    'START_TRANSFER',
    nextBox.boxId,
    beforeState,
    afterState,
    actor,
    asTrimmedString(payload.notes) || `Started transfer from ${sourceWarehouse.code} to ${destinationWarehouse.code}.`
  );

  return ok(
    {
      box: afterState,
      transfer: toPublicBoxTransfer(transfer),
      logId,
      cancelledAllocationCount: 0,
      releasedFeet: 0
    },
    []
  );
}

async function receiveBoxTransfer(client, orgId, payload, actor) {
  const transfer = await findBoxTransferByTransferId(client, orgId, payload.transferId);
  if (!transfer) {
    throw new HttpError(404, 'Transfer not found.');
  }

  if (transfer.status !== 'PENDING') {
    throw new HttpError(400, `Transfer ${transfer.transferId} is already ${transfer.status}.`);
  }

  const box = await findBoxByRecordId(client, orgId, transfer.boxRecordId);
  if (!box) {
    throw new HttpError(404, 'Box not found for this transfer.');
  }

  if (box.status !== 'TRANSFER') {
    throw new HttpError(
      400,
      `Box ${box.boxId} is no longer pending transfer and cannot be received from this workflow.`
    );
  }

  const sourceWarehouse = await findWarehouseEntry(client, orgId, transfer.sourceWarehouse, 'FromWarehouse');
  const destinationWarehouse = await findWarehouseEntry(client, orgId, transfer.destinationWarehouse, 'ToWarehouse');
  const nextBoxId = buildTransferredBoxId(
    transfer.sourceBoxId,
    sourceWarehouse.boxIdPrefix || sourceWarehouse.code,
    destinationWarehouse.boxIdPrefix || destinationWarehouse.code
  );

  if (await boxIdOrAliasExists(client, orgId, nextBoxId, box.id)) {
    throw new HttpError(
      400,
      `Transfer cannot be received because BoxID ${nextBoxId} already exists or is reserved by an alias.`
    );
  }

  await releaseReusableBoxIdAlias(client, orgId, nextBoxId, box.id);

  const beforeState = toPublicBox(box);
  const receivedBox = await applyReceivedBoxTransfer(
    client,
    orgId,
    box,
    destinationWarehouse.code,
    nextBoxId,
    actor
  );
  if (!receivedBox) {
    throw new HttpError(500, 'Transfer was received but the updated box could not be reloaded.');
  }

  const nowIso = new Date().toISOString();
  const savedTransfer = await saveBoxTransferRecord(client, orgId, {
    ...transfer,
    destinationBoxId: nextBoxId,
    status: 'RECEIVED',
    receivedAt: nowIso,
    receivedBy: actor,
    updatedAt: nowIso,
    updatedBy: actor
  });

  const afterState = toPublicBox(receivedBox);
  const logId = await appendAuditEntry(
    client,
    orgId,
    'RECEIVE_TRANSFER',
    receivedBox.boxId,
    beforeState,
    afterState,
    actor,
    `Received transfer from ${transfer.sourceWarehouse} into ${transfer.destinationWarehouse}.`
  );

  return ok(
    {
      box: afterState,
      transfer: toPublicBoxTransfer(savedTransfer),
      logId,
      cancelledAllocationCount: 0,
      releasedFeet: 0
    },
    []
  );
}

async function cancelBoxTransfer(client, orgId, payload, actor) {
  const transfer = await findBoxTransferByTransferId(client, orgId, payload.transferId);
  if (!transfer) {
    throw new HttpError(404, 'Transfer not found.');
  }

  if (transfer.status !== 'PENDING') {
    throw new HttpError(400, `Transfer ${transfer.transferId} is already ${transfer.status}.`);
  }

  const box = await findBoxByRecordId(client, orgId, transfer.boxRecordId);
  if (!box) {
    throw new HttpError(404, 'Box not found for this transfer.');
  }

  if (box.status !== 'TRANSFER') {
    throw new HttpError(
      400,
      `Box ${box.boxId} is no longer pending transfer and cannot be cancelled from this workflow.`
    );
  }

  const activeTargets = await listActiveAllocationTransferTargetsForBox(client, orgId, box.boxId);
  const cancelReason =
    asTrimmedString(payload.reason) ||
    `Cancelled transfer from ${transfer.sourceWarehouse} to ${transfer.destinationWarehouse}.`;
  let cancelledAllocationCount = 0;
  let releasedFeet = 0;

  for (let index = 0; index < activeTargets.length; index += 1) {
    const target = activeTargets[index];
    if (target.jobWarehouse !== transfer.destinationWarehouse) {
      continue;
    }

    const removal = await removeAllocationFromJob(
      client,
      orgId,
      target.jobNumber,
      target.allocationId,
      actor,
      cancelReason
    );
    cancelledAllocationCount += integerOrZero(removal.removedAllocationCount);
    releasedFeet += integerOrZero(removal.releasedFeet);
  }

  const refreshedBox = await findBoxByRecordId(client, orgId, transfer.boxRecordId);
  if (!refreshedBox) {
    throw new HttpError(404, 'Box not found for this transfer.');
  }

  const beforeState = toPublicBox(refreshedBox);
  const savedBox = await saveBoxRecord(client, orgId, {
    ...cloneValue(refreshedBox),
    status: 'IN_STOCK'
  });

  const nowIso = new Date().toISOString();
  const savedTransfer = await saveBoxTransferRecord(client, orgId, {
    ...transfer,
    status: 'CANCELLED',
    notes: cancelReason,
    cancelledAt: nowIso,
    cancelledBy: actor,
    updatedAt: nowIso,
    updatedBy: actor
  });

  const afterState = toPublicBox(savedBox);
  const logId = await appendAuditEntry(
    client,
    orgId,
    'CANCEL_TRANSFER',
    savedBox.boxId,
    beforeState,
    afterState,
    actor,
    cancelReason
  );

  return ok(
    {
      box: afterState,
      transfer: toPublicBoxTransfer(savedTransfer),
      logId,
      cancelledAllocationCount,
      releasedFeet
    },
    []
  );
}

export {
  addBox,
  updateBox,
  setBoxStatus,
  getBoxTransferByBox,
  startBoxTransfer,
  receiveBoxTransfer,
  cancelBoxTransfer,
};
