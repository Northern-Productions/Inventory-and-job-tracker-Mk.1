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

function asTrimmedString(value: unknown) {
  return String(value ?? '').trim();
}

function isExplicitZeroNumber(value: unknown) {
  if (value === null || value === undefined) {
    return false;
  }

  const rawValue = asTrimmedString(value);
  if (!rawValue) {
    return false;
  }

  const parsedValue = Number(rawValue);
  return Number.isFinite(parsedValue) && parsedValue <= 0;
}

function hasExplicitLinearFeetZeroSignal(payload: UpdateBoxPayload) {
  const hasSubmittedCurrentFeetOnRoll = Object.prototype.hasOwnProperty.call(
    payload,
    'currentFeetOnRoll'
  );

  if (hasSubmittedCurrentFeetOnRoll) {
    return isExplicitZeroNumber(payload.currentFeetOnRoll);
  }

  return isExplicitZeroNumber(payload.feetAvailable);
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

  if (!Boolean(payload.receivedDate || currentBox?.receivedDate)) {
    return null;
  }

  if (hasExplicitLinearFeetZeroSignal(payload)) {
    return 'linearFeet';
  }

  if (!isExplicitZeroNumber(payload.lastRollWeightLbs)) {
    return null;
  }

  return 'lastRollWeight';
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
      auditNote: 'Confirmed zero Current Linear Feet edit save'
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
  const historySentence = missingFieldsText ? `This box is missing ${missingFieldsText}. ` : '';

  if (trigger === 'linearFeet') {
    return `${historySentence}Saving Current Linear Feet as 0 can move this box to zeroed inventory. Choose Keep Active to save the edit without moving the box, or Move To Zeroed to zero it out and let backend reconciliation update any active reservations tied to this box.`;
  }

  return `${historySentence}Saving a Last Roll Weight of 0 can move this box to zeroed inventory. Choose Keep Active to save the edit without moving the box, or Move To Zeroed to zero it out and let backend reconciliation update any active reservations tied to this box.`;
}
