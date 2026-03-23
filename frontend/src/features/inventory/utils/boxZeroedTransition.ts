import type { Box, UpdateBoxPayload } from '../../../domain';

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

export function shouldPromptZeroedInventoryWarningOnEdit(
  currentBox: Box | null | undefined,
  payload: UpdateBoxPayload
) {
  if (payload.lastRollWeightLbs !== 0) {
    return false;
  }

  return getIncompleteBoxHistoryFieldsForZeroedEdit(currentBox, payload).length > 0;
}

export function buildZeroedInventoryWarningMessage(fieldLabels: string[]) {
  const missingFieldsText = formatFieldList(fieldLabels);
  const historySentence = missingFieldsText
    ? `This box is missing ${missingFieldsText}.`
    : 'This box has incomplete history.';

  return `${historySentence} If you continue, saving a Last Roll Weight of 0 will move the box to zeroed inventory, set Available Feet to 0, and cancel any active allocations tied to this box.`;
}
