import type { Box, ReceiveOrderedBoxPayload } from '../../../../domain';

export interface OrderedBoxReceiveDraft {
  receivedWeightLbs: string;
  lotRun: string;
}

function parseOptionalNonNegativeNumber(value: string, fieldLabel: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${fieldLabel} must be a valid non-negative number.`);
  }

  return parsed;
}

export function createOrderedBoxReceiveDraft(
  box: Pick<Box, 'lotRun'>
): OrderedBoxReceiveDraft {
  return {
    receivedWeightLbs: '',
    lotRun: box.lotRun
  };
}

export function validateOrderedBoxReceiveDraft(draft: OrderedBoxReceiveDraft) {
  return {
    receivedWeightLbs: parseOptionalNonNegativeNumber(draft.receivedWeightLbs, 'Weight'),
    lotRun: draft.lotRun.trim()
  };
}

export function buildReceiveOrderedBoxPayload(
  box: Pick<Box, 'boxId'>,
  draft: OrderedBoxReceiveDraft
): ReceiveOrderedBoxPayload {
  const validated = validateOrderedBoxReceiveDraft(draft);
  const payload: ReceiveOrderedBoxPayload = {
    boxId: box.boxId
  };

  if (validated.receivedWeightLbs !== undefined) {
    payload.receivedWeightLbs = validated.receivedWeightLbs;
  }

  if (validated.lotRun) {
    payload.lotRun = validated.lotRun;
  }

  return payload;
}
