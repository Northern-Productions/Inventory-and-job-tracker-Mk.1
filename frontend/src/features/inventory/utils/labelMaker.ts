import { getPhysicalStockFeetValue, type Box } from '../../../domain';
import { formatBoxIdWithWarehousePrefix } from '../../../lib/boxIds';

export type LabelSlot = 'A' | 'B';
export type LabelTemplateId = 'single' | 'double';

export type LabelDraft = {
  date: string;
  jobId: string;
  weightLbs: string;
  by: string;
  balance: string;
  checked: string;
  filmName: string;
  width: string;
  boxId: string;
  runNumber: string;
};

export const EMPTY_LABEL_DRAFT: LabelDraft = {
  date: '',
  jobId: '',
  weightLbs: '',
  by: '',
  balance: '',
  checked: '',
  filmName: '',
  width: '',
  boxId: '',
  runNumber: ''
};

export const LABEL_SLOTS: LabelSlot[] = ['A', 'B'];
export const LABEL_RESULT_LIMIT = 10;
export const LABEL_SEARCH_DEBOUNCE_MS = 200;
export const LABEL_REQUIRED_DRAFT_FIELDS: Array<keyof LabelDraft> = [
  'date',
  'weightLbs',
  'balance',
  'filmName',
  'width',
  'boxId'
];

const LABEL_REQUIRED_DRAFT_FIELD_LABELS: Record<keyof LabelDraft, string> = {
  date: 'Date',
  jobId: 'Job ID',
  weightLbs: 'Weight lbs',
  by: 'BY',
  balance: 'Balance',
  checked: 'Checked',
  filmName: 'Film Name',
  width: 'Width',
  boxId: 'Box ID',
  runNumber: 'Run Number'
};

function normalizeDraftText(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function formatNumberValue(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '';
  }

  return String(value);
}

function formatLabelDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}/${day}/${date.getFullYear()}`;
}

function formatCurrentFeetValue(box: Box): string {
  return formatNumberValue(getPhysicalStockFeetValue(box));
}

function stripLocalFilmId(displayBoxId: string): string {
  const normalized = normalizeDraftText(displayBoxId).toUpperCase();
  const canonicalMatch = normalized.match(/^[A-Z]{2}[1-9][0-9]*-(.+)$/);
  if (canonicalMatch) {
    return canonicalMatch[1];
  }

  const legacyMatch = normalized.match(/^[A-Z]+-(.+)$/);
  return legacyMatch ? legacyMatch[1] : normalized;
}

export function getLabelJobIdFromBox(box: Box): string {
  const orderedForJobs = Array.isArray(box.orderedForJobs) ? box.orderedForJobs : [];
  const origins = orderedForJobs
    .map((origin) => ({
      jobId: normalizeDraftText(origin.jobId),
      jobNumber: normalizeDraftText(origin.jobNumber),
      workScope: normalizeDraftText(origin.workScope || origin.sections)
    }))
    .filter((origin) => origin.jobNumber);

  if (origins.length > 0) {
    const originKeys = new Set(
      origins.map((origin) => [origin.jobId, origin.jobNumber, origin.workScope].join('|'))
    );
    if (originKeys.size === 1) {
      return origins[0].jobNumber;
    }

    return '';
  }

  return normalizeDraftText(box.lastCheckoutJob);
}

function hasAmbiguousLabelJobOrigin(box: Box): boolean {
  const orderedForJobs = Array.isArray(box.orderedForJobs) ? box.orderedForJobs : [];
  const origins = orderedForJobs
    .map((origin) => ({
      jobId: normalizeDraftText(origin.jobId),
      jobNumber: normalizeDraftText(origin.jobNumber),
      workScope: normalizeDraftText(origin.workScope || origin.sections)
    }))
    .filter((origin) => origin.jobNumber);

  if (origins.length <= 1) {
    return false;
  }

  return new Set(origins.map((origin) => [origin.jobId, origin.jobNumber, origin.workScope].join('|'))).size > 1;
}

export function getLabelDisplayBoxId(box: Pick<Box, 'boxId' | 'warehouse'>): string {
  return formatBoxIdWithWarehousePrefix(box.boxId, box.warehouse);
}

export function getLabelBoxId(box: Pick<Box, 'boxId' | 'warehouse'>): string {
  return stripLocalFilmId(getLabelDisplayBoxId(box));
}

export function todayLabelDateString(): string {
  return formatLabelDate(new Date());
}

export function getMissingRequiredLabelFields(draft: LabelDraft): Array<keyof LabelDraft> {
  return LABEL_REQUIRED_DRAFT_FIELDS.filter((field) => !normalizeDraftText(draft[field]));
}

export function getLabelDraftFieldLabel(field: keyof LabelDraft): string {
  return LABEL_REQUIRED_DRAFT_FIELD_LABELS[field];
}

/**
 * PURPOSE:
 * Owns every Box-to-label field mapping used by the Labels workspace.
 *
 * AFFECTS:
 * Printable labels, label preview, manual draft defaults, and missing-data warnings.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * PrintableLabelSheet, LabelDraftEditor, QR payload tests, and any future /labels deep-link hydration.
 *
 * COMMON FAILURE MODES:
 * Frontend/backend field drift, NaN stock values, lost leading zeros in Box ID, or inconsistent manual defaults.
 */
export function buildLabelDraftFromBox(box: Box): LabelDraft {
  const date = todayLabelDateString();
  const weightLbs = formatNumberValue(box.lastRollWeightLbs);
  const manufacturer = normalizeDraftText(box.manufacturer);
  const filmName = normalizeDraftText(box.filmName);
  const combinedFilmName = [manufacturer, filmName].filter(Boolean).join(' ');
  const width = typeof box.widthIn === 'number' && Number.isFinite(box.widthIn)
    ? `${box.widthIn}"`
    : '';

  return {
    date,
    jobId: getLabelJobIdFromBox(box),
    weightLbs,
    by: '',
    balance: formatCurrentFeetValue(box),
    checked: '',
    filmName: combinedFilmName,
    width,
    boxId: getLabelBoxId(box),
    runNumber: normalizeDraftText(box.lotRun)
  };
}

export function buildLabelDraftWarnings(box: Box, draft: LabelDraft): string[] {
  const warnings: string[] = [];

  if (!draft.width) {
    warnings.push('Width is missing. Confirm the label width before printing.');
  }

  if (!draft.runNumber) {
    warnings.push('Run number is missing.');
  }

  if (!draft.filmName) {
    warnings.push('Film name is missing.');
  }

  if (!draft.boxId) {
    warnings.push('Box ID is missing.');
  }

  if (!draft.jobId && hasAmbiguousLabelJobOrigin(box)) {
    warnings.push('Box is tied to multiple jobs. Enter the Job ID manually.');
  }

  if (!draft.weightLbs) {
    warnings.push("Doesn't have weight.");
  }

  if (!draft.balance) {
    warnings.push('Missing current feet.');
  }

  return warnings;
}
