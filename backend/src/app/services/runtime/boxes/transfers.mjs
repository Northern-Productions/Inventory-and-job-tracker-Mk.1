import {
  HttpError,
  ok,
  queryRow,
  asTrimmedString,
  requireString,
  integerOrZero,
  cloneValue,
  createTransferId,
  toPublicBox,
  toPublicBoxTransfer,
  listWarehouseBoxIdPrefixes,
  findWarehouseEntry,
  planTransferredBoxId,
  findBoxById,
  saveBoxRecord,
  findBoxByRecordId,
  findBoxTransferByTransferId,
  getLatestBoxTransferByBoxId,
  findPendingBoxTransferByBoxRecordId,
  saveBoxTransferRecord,
  appendAuditEntry,
} from '../../runtimeDeps.mjs';
import {
  listActiveAllocationTransferTargetsForBox,
  getTransferStartGuardForBox,
  applyReceivedBoxTransfer,
  findBoxIdConflict,
  releaseReusableBoxIdAlias,
} from '../runtimeTransferUsage.mjs';
import { removeAllocationFromJob } from '../runtimeAllocationCleanup.mjs';

async function getBoxTransferByBox(client, orgId, boxId) {
  const resolved = await getLatestBoxTransferByBoxId(client, orgId, boxId);
  if (!resolved.box) {
    throw new HttpError(404, 'Box not found.');
  }

  return resolved.transfer ? toPublicBoxTransfer(resolved.transfer) : null;
}

function buildTransferDestinationConflictMessage(destinationBoxId, conflict) {
  const normalizedDestinationBoxId = requireString(destinationBoxId, 'DestinationBoxID').toUpperCase();
  if (!conflict) {
    return `Arrival BoxID ${normalizedDestinationBoxId} is not available.`;
  }

  if (conflict.conflictType === 'alias') {
    return `Arrival BoxID ${normalizedDestinationBoxId} is already kept as an alias for ${conflict.conflictBoxId}.`;
  }

  if (conflict.conflictType === 'pending_transfer') {
    return `Arrival BoxID ${normalizedDestinationBoxId} is already reserved by another pending transfer.`;
  }

  return `Arrival BoxID ${normalizedDestinationBoxId} already exists.`;
}

function isPendingTransferReservationConflict(error) {
  return (
    error &&
    typeof error === 'object' &&
    error.code === '23505' &&
    String(error.constraint || '').includes('idx_box_transfers_one_pending_destination_box')
  );
}

async function resolveBoxTransferPlan(client, orgId, payload) {
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

  const warehousePrefixes = await listWarehouseBoxIdPrefixes(client, orgId);
  let destinationBoxId = '';
  try {
    destinationBoxId = planTransferredBoxId(
      box.boxId,
      sourceWarehouse.boxIdPrefix || sourceWarehouse.code,
      destinationWarehouse.boxIdPrefix || destinationWarehouse.code,
      warehousePrefixes,
      payload.destinationBoxIdOverride
    );
  } catch (error) {
    throw new HttpError(
      400,
      error instanceof Error ? error.message : 'Arrival Box ID is not valid for this destination warehouse.'
    );
  }

  const conflict = await findBoxIdConflict(client, orgId, destinationBoxId, {
    excludedBoxRecordId: box.id
  });

  return {
    box,
    sourceWarehouse,
    destinationWarehouse,
    destinationBoxId,
    conflict
  };
}

async function getBoxTransferPlan(client, orgId, payload) {
  const plan = await resolveBoxTransferPlan(client, orgId, payload);
  return {
    destinationBoxId: plan.destinationBoxId,
    available: !plan.conflict,
    conflictType: plan.conflict?.conflictType || null,
    conflictBoxId: plan.conflict?.conflictBoxId || null
  };
}

async function startBoxTransferLegacy(client, orgId, payload, actor) {
  const { box, sourceWarehouse, destinationWarehouse, destinationBoxId, conflict } =
    await resolveBoxTransferPlan(client, orgId, payload);
  if (conflict) {
    throw new HttpError(400, buildTransferDestinationConflictMessage(destinationBoxId, conflict));
  }

  const nowIso = new Date().toISOString();
  let transfer;
  try {
    transfer = await saveBoxTransferRecord(client, orgId, {
      transferId: createTransferId(),
      boxRecordId: box.id,
      sourceBoxId: box.boxId,
      destinationBoxId,
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
  } catch (error) {
    if (isPendingTransferReservationConflict(error)) {
      const raceConflict = await findBoxIdConflict(client, orgId, destinationBoxId, {
        excludedBoxRecordId: box.id
      });
      throw new HttpError(409, buildTransferDestinationConflictMessage(destinationBoxId, raceConflict));
    }
    throw error;
  }

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

async function receiveBoxTransferLegacy(client, orgId, payload, actor) {
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

  const destinationWarehouse = await findWarehouseEntry(client, orgId, transfer.destinationWarehouse, 'ToWarehouse');
  const nextBoxId = requireString(transfer.destinationBoxId, 'DestinationBoxID').toUpperCase();

  const receiveConflict = await findBoxIdConflict(client, orgId, nextBoxId, {
    excludedBoxRecordId: box.id,
    excludedTransferId: transfer.transferId
  });
  if (receiveConflict) {
    throw new HttpError(409, buildTransferDestinationConflictMessage(nextBoxId, receiveConflict));
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

async function cancelBoxTransferLegacy(client, orgId, payload, actor) {
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

async function callCanonicalBoxTransferMutation(client, orgId, actor, payload, functionName) {
  const allowedFunctions = new Set([
    'public.api_acl_box_transfer_start',
    'public.api_acl_box_transfer_receive',
    'public.api_acl_box_transfer_cancel'
  ]);
  if (!allowedFunctions.has(functionName)) {
    throw new HttpError(500, 'Unsupported box transfer mutation.');
  }

  const row = await queryRow(
    client,
    `select ${functionName}($1::uuid, $2::text, $3::jsonb) as result`,
    [orgId, actor, payload || {}]
  );
  const result = row?.result;
  if (!result || typeof result !== 'object') {
    throw new HttpError(500, 'Box transfer mutation did not return a result.');
  }

  return ok(
    {
      box: result.box,
      transfer: result.transfer,
      logId: asTrimmedString(result.logId),
      cancelledAllocationCount: integerOrZero(result.cancelledAllocationCount),
      releasedFeet: integerOrZero(result.releasedFeet)
    },
    Array.isArray(result.warnings) ? result.warnings : []
  );
}

async function startBoxTransfer(client, orgId, payload, actor) {
  return callCanonicalBoxTransferMutation(
    client,
    orgId,
    actor,
    payload,
    'public.api_acl_box_transfer_start'
  );
}

async function receiveBoxTransfer(client, orgId, payload, actor) {
  return callCanonicalBoxTransferMutation(
    client,
    orgId,
    actor,
    payload,
    'public.api_acl_box_transfer_receive'
  );
}

async function cancelBoxTransfer(client, orgId, payload, actor) {
  return callCanonicalBoxTransferMutation(
    client,
    orgId,
    actor,
    payload,
    'public.api_acl_box_transfer_cancel'
  );
}

export {
  getBoxTransferByBox,
  getBoxTransferPlan,
  startBoxTransfer,
  receiveBoxTransfer,
  cancelBoxTransfer,
};
