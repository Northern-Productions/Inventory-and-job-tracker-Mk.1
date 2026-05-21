import {
  STANDARD_WIDTH_OPTIONS,
  canonicalizeManufacturerLabel
} from '../../utils/boxHelpers';
import type {
  CaulkRequirementDraftLine,
  JobCaulkRequirementEditorLine,
  JobPhaseEditorLine,
  JobRequirementEditorLine,
  RequirementDraftLine
} from './types';

export const EMPTY_REQUIREMENT_LINES: JobRequirementEditorLine[] = [];
export const EMPTY_CAULK_REQUIREMENT_LINES: JobCaulkRequirementEditorLine[] = [];
export const EMPTY_PHASE_LINES: JobPhaseEditorLine[] = [];
export const WIDTH_BUTTON_VALUES = [...STANDARD_WIDTH_OPTIONS, 'CUSTOM'] as const;
export type WidthButtonValue = (typeof WIDTH_BUTTON_VALUES)[number];
export const CUSTOM_MANUFACTURER_OPTION = '__custom_manufacturer__';

function makeRequirementLineId() {
  return `job-req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createDraftLine(entry?: JobRequirementEditorLine): RequirementDraftLine {
  const phaseKey = entry?.phaseId || (entry?.phaseNumber ? `number:${entry.phaseNumber}` : 'primary');
  return {
    id: makeRequirementLineId(),
    requirementId: entry?.requirementId || '',
    phaseKey,
    manufacturer: canonicalizeManufacturerLabel(entry?.manufacturer || ''),
    filmName: entry?.filmName || '',
    widthIn: entry ? String(entry.widthIn) : '',
    requiredFeet: entry ? String(entry.requiredFeet) : ''
  };
}

export function createCaulkDraftLine(
  entry?: JobCaulkRequirementEditorLine
): CaulkRequirementDraftLine {
  const phaseKey = entry?.phaseId || (entry?.phaseNumber ? `number:${entry.phaseNumber}` : 'primary');
  return {
    id: makeRequirementLineId(),
    requirementId: entry?.requirementId || '',
    phaseKey,
    productId: entry?.productId || '',
    requiredTubes: entry ? String(entry.requiredTubes) : ''
  };
}

export function getSectionsInputValue(value: string | number | null | undefined) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value);
}

export function buildRequirementLineKey(manufacturer: string, filmName: string, widthIn: number) {
  return `${canonicalizeManufacturerLabel(manufacturer).toLowerCase()}|${filmName
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')}|${widthIn}`;
}

export function mergeRequirementLines(lines: JobRequirementEditorLine[]) {
  const merged = new Map<string, JobRequirementEditorLine>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const key = `${line.phaseId || line.phaseNumber || 'primary'}|${buildRequirementLineKey(
      line.manufacturer,
      line.filmName,
      line.widthIn
    )}`;
    const existing = merged.get(key);

    if (!existing) {
      merged.set(key, { ...line });
      continue;
    }

    existing.requiredFeet += line.requiredFeet;
  }

  return Array.from(merged.values());
}

export function makeNewRequirementDraftLine({
  phaseKey = 'primary',
  manufacturer,
  filmName,
  widthIn,
  requiredFeet
}: {
  phaseKey?: string;
  manufacturer: string;
  filmName: string;
  widthIn: number;
  requiredFeet: number;
}): RequirementDraftLine {
  return {
    id: makeRequirementLineId(),
    requirementId: '',
    phaseKey,
    manufacturer: manufacturer.trim(),
    filmName: filmName.trim(),
    widthIn: String(widthIn),
    requiredFeet: String(requiredFeet)
  };
}

export function makeNewCaulkDraftLine({
  phaseKey = 'primary',
  productId,
  requiredTubes
}: {
  phaseKey?: string;
  productId: string;
  requiredTubes: number;
}): CaulkRequirementDraftLine {
  return {
    id: makeRequirementLineId(),
    requirementId: '',
    phaseKey,
    productId,
    requiredTubes: String(requiredTubes)
  };
}
