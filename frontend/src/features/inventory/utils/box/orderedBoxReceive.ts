import type { Box, BoxCoreType, ReceiveOrderedBoxPayload } from '../../../../domain';
import { normalizeCoreTypeValue } from './boxDrafts';
import { CORE_TYPE_OPTIONS } from './boxRollTracking';

export interface OrderedBoxReceiveDraft {
  receivedWeightLbs: string;
  currentFeetOnRoll: string;
  lotRun: string;
  coreType: string;
}

const CORE_TYPE_OPTION_SET = new Set<string>(CORE_TYPE_OPTIONS);

function parseOptionalNonNegativeNumber(value: string, fieldLabel: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${fieldLabel} must be a valid non-negative number.`);
  }

  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new Error(`${fieldLabel} must be a valid non-negative number with up to 2 decimal places.`);
  }

  return parsed;
}

function normalizeCoreTypeOption(value: string): BoxCoreType {
  const normalized = normalizeCoreTypeValue(value);
  return CORE_TYPE_OPTION_SET.has(normalized) ? (normalized as BoxCoreType) : '';
}

function parseOptionalCoreType(value: string): BoxCoreType {
  const normalized = normalizeCoreTypeValue(value);
  if (!normalized) {
    return '';
  }

  if (!CORE_TYPE_OPTION_SET.has(normalized)) {
    throw new Error('Select a core type.');
  }

  return normalized as BoxCoreType;
}

export function createOrderedBoxReceiveDraft(
  box: Pick<Box, 'initialFeet' | 'lotRun' | 'coreType'>
): OrderedBoxReceiveDraft {
  return {
    receivedWeightLbs: '',
    currentFeetOnRoll: String(Math.max(0, Math.floor(Number(box.initialFeet || 0)))),
    lotRun: box.lotRun,
    coreType: normalizeCoreTypeOption(box.coreType)
  };
}

export function validateOrderedBoxReceiveDraft(draft: OrderedBoxReceiveDraft) {
  return {
    receivedWeightLbs: parseOptionalNonNegativeNumber(draft.receivedWeightLbs, 'Weight'),
    currentFeetOnRoll: parseOptionalNonNegativeNumber(draft.currentFeetOnRoll, 'Current Linear Feet'),
    lotRun: draft.lotRun.trim(),
    coreType: parseOptionalCoreType(draft.coreType)
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

  if (validated.currentFeetOnRoll !== undefined) {
    payload.currentFeetOnRoll = Math.floor(validated.currentFeetOnRoll);
  }

  if (validated.lotRun) {
    payload.lotRun = validated.lotRun;
  }

  if (validated.coreType) {
    payload.coreType = validated.coreType;
  }

  return payload;
}
