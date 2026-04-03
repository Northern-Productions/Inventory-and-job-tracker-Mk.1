import type { Box, UpdateBoxPayload } from '../../../domain';

export type ZeroedInventoryEditTrigger = 'lastRollWeight' | 'linearFeet';
export const ZEROED_BOX_REACTIVATION_PROMPT =
  'Do you want to move this box back to the active IN_STOCK inventory?';

type BoxHistorySnapshot = Pick<
  Box | UpdateBoxPayload,
  'receivedDate' | 'initialWeightLbs' | 'coreWeightLbs' | 'lastWeighedDate'
>;

const BOX_HISTORY_FIELD_LABELS = {
  receivedDate: 'Received Date',
  initialWeightLbs: 'Initial Weight',
  coreWeightLbs: 'Core Weight',
  lastWeighedDate: 'Last Weighed Date'
} as const;

function getIncompleteHistoryFields(snapshot: BoxHistorySnapshot | null | undefined) {
  if (!snapshot) {
    return [] as string[];
  }

  const incompleteFields: string[] = [];

  if (!String(snapshot.receivedDate || '').trim()) {
    incompleteFields.push(BOX_HISTORY_FIELD_LABELS.receivedDate);
  }

  if (snapshot.initialWeightLbs === null || snapshot.initialWeightLbs === undefined) {
    incompleteFields.push(BOX_HISTORY_FIELD_LABELS.initialWeightLbs);
  }

  if (snapshot.coreWeightLbs === null || snapshot.coreWeightLbs === undefined) {
    incompleteFields.push(BOX_HISTORY_FIELD_LABELS.coreWeightLbs);
  }

  if (!String(snapshot.lastWeighedDate || '').trim()) {
    incompleteFields.push(BOX_HISTORY_FIELD_LABELS.lastWeighedDate);
  }

  return incompleteFields;
}

function formatFieldList(fieldLabels: string[]) {
  if (fieldLabels.length <= 1) {
    return fieldLabels[0] || '';
  }

  if (fieldLabels.length === 2) {
    return `${fieldLabels[0]} and ${fieldLabels[1]}`;
  }

  return `${fieldLabels.slice(0, -1).join(', ')}, and ${fieldLabels[fieldLabels.length - 1]}`;
}

export function getIncompleteBoxHistoryFieldsForZeroedEdit(
  currentBox: Box | null | undefined,
  payload: UpdateBoxPayload
) {
  return Array.from(
    new Set([...getIncompleteHistoryFields(currentBox), ...getIncompleteHistoryFields(payload)])
  );
}

export function getZeroedInventoryEditTrigger(
  currentBox: Box | null | undefined,
  payload: UpdateBoxPayload
): ZeroedInventoryEditTrigger | null {
  if (currentBox?.status === 'ZEROED') {
    return null;
  }

  if (
    currentBox &&
    currentBox.initialFeet > 0 &&
    Boolean(currentBox.receivedDate) &&
    payload.initialFeet === 0
  ) {
    return 'linearFeet';
  }

  if (payload.lastRollWeightLbs !== 0) {
    return null;
  }

  return getIncompleteBoxHistoryFieldsForZeroedEdit(currentBox, payload).length > 0
    ? 'lastRollWeight'
    : null;
}

export function shouldPromptZeroedInventoryWarningOnEdit(
  currentBox: Box | null | undefined,
  payload: UpdateBoxPayload
) {
  return getZeroedInventoryEditTrigger(currentBox, payload) !== null;
}

export function buildZeroedInventoryPayloadForEdit(
  currentBox: Box | null | undefined,
  payload: UpdateBoxPayload,
  trigger: ZeroedInventoryEditTrigger
): UpdateBoxPayload {
  if (trigger === 'linearFeet') {
    return {
      ...payload,
      initialFeet: currentBox?.initialFeet ?? payload.initialFeet,
      feetAvailable: 0,
      moveToZeroed: true,
      auditNote: 'Confirmed zero Linear Feet edit save'
    };
  }

  return {
    ...payload,
    moveToZeroed: true,
    auditNote: 'Confirmed zero Last Roll Weight edit save'
  };
}

export function shouldPromptZeroedInventoryReactivationOnEdit(
  currentBox: Box | null | undefined,
  payload: UpdateBoxPayload
) {
  if (currentBox?.status !== 'ZEROED') {
    return false;
  }

  return Number(payload.feetAvailable ?? 0) > 0 || Number(payload.lastRollWeightLbs ?? 0) > 0;
}

export function buildZeroedInventoryReactivationPayloadForEdit(
  payload: UpdateBoxPayload
): UpdateBoxPayload {
  return {
    ...payload,
    reactivateFromZeroed: true,
    auditNote: 'Confirmed zeroed box reactivation edit save'
  };
}

export function buildZeroedInventoryWarningMessage(
  fieldLabels: string[],
  trigger: ZeroedInventoryEditTrigger = 'lastRollWeight'
) {
  const missingFieldsText = formatFieldList(fieldLabels);
  const historySentence = missingFieldsText
    ? `This box is missing ${missingFieldsText}.`
    : 'This box has incomplete history.';

  if (trigger === 'linearFeet') {
    return `${historySentence} If you continue, saving Linear Feet as 0 will move the box to zeroed inventory, preserve its original starting footage for history, set Available Feet to 0, and cancel any active allocations tied to this box.`;
  }

  return `${historySentence} If you continue, saving a Last Roll Weight of 0 will move the box to zeroed inventory, set Available Feet to 0, and cancel any active allocations tied to this box.`;
}
