import {
  HttpError,
  ok,
  asTrimmedString,
  cloneValue,
  toPublicBox,
  findBoxById,
  listAllocationsByBox,
  saveBoxRecord,
  appendAuditEntry,
} from '../../runtimeDeps.mjs';
import { applyReservationMetricsToBox } from '../runtimeAllocationReservations.mjs';

function normalizeLabelBoxIds(value) {
  if (!Array.isArray(value)) {
    throw new HttpError(400, 'BoxIDs must be a non-empty array.');
  }

  const boxIds = [];
  const seen = new Set();
  for (const entry of value) {
    const boxId = asTrimmedString(entry).toUpperCase();
    if (!boxId || seen.has(boxId)) {
      continue;
    }

    seen.add(boxId);
    boxIds.push(boxId);
  }

  if (boxIds.length === 0) {
    throw new HttpError(400, 'BoxIDs must include at least one box.');
  }

  return boxIds;
}

async function buildPublicBox(client, orgId, box) {
  const allocations = await listAllocationsByBox(client, orgId, box.boxId);
  return toPublicBox(applyReservationMetricsToBox(box, allocations));
}

async function markLabelsPrinted(client, orgId, payload, actor) {
  const boxIds = normalizeLabelBoxIds(payload?.boxIds);
  const boxes = [];
  const logIds = [];

  for (const boxId of boxIds) {
    const existing = await findBoxById(client, orgId, boxId);
    if (!existing) {
      throw new HttpError(404, `Box ${boxId} was not found.`);
    }

    const before = await buildPublicBox(client, orgId, existing);
    const nextBox = cloneValue(existing);
    nextBox.hasLabel = true;

    const savedBox = await saveBoxRecord(client, orgId, nextBox);
    const after = await buildPublicBox(client, orgId, savedBox);
    const logId = await appendAuditEntry(
      client,
      orgId,
      'UPDATE_BOX',
      savedBox.boxId,
      before,
      after,
      actor,
      `Label printed for box ${savedBox.boxId}.`
    );

    boxes.push(after);
    logIds.push(logId);
  }

  return ok({ boxes, logIds });
}

export { markLabelsPrinted };
