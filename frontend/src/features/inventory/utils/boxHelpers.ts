import type { AllocationEntry, Box, CoreType, UpdateBoxPayload, Warehouse } from '../../../domain';
import { toDateInputValue, todayDateString } from '../../../lib/date';

export const STANDARD_WIDTH_OPTIONS = ['36', '48', '60', '72'] as const;
export const MANUFACTURER_OPTIONS = ['3M', '3M Fasara', 'Llumar', 'Solar Gard', 'SOLYX', 'Avery'] as const;
export const CORE_TYPE_OPTIONS = ['White', 'Red', 'Cardboard'] as const;
export const CORE_REFERENCE_WIDTH_IN = 72;
export const LOW_STOCK_THRESHOLD_LF = 10;
const CUSTOM_MANUFACTURERS_STORAGE_KEY = 'inventory.customManufacturers.v1';
let customManufacturerCache: string[] | null = null;
const CORE_WEIGHT_AT_REFERENCE_WIDTH_LBS: Record<CoreType, number> = {
  White: 2,
  Red: 1.85,
  Cardboard: 2.05
};

export interface BoxDraft {
  boxId: string;
  manufacturer: string;
  filmName: string;
  widthIn: string;
  initialFeet: string;
  feetAvailable: string;
  lotRun: string;
  orderDate: string;
  receivedDate: string;
  initialWeightLbs: string;
  lastRollWeightLbs: string;
  lastWeighedDate: string;
  filmKey: string;
  coreType: string;
  coreWeightLbs: string;
  lfWeightLbsPerFt: string;
  purchaseCost: string;
  notes: string;
}

function normalizeManufacturerLabel(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeManufacturerKey(value: string) {
  return normalizeManufacturerLabel(value).toLowerCase();
}

function dedupeManufacturerLabels(values: string[]) {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const label = normalizeManufacturerLabel(value);
    const key = normalizeManufacturerKey(label);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(label);
  }

  return deduped;
}

function canUseLocalStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function readCustomManufacturerOptions() {
  if (customManufacturerCache) {
    return customManufacturerCache;
  }

  if (!canUseLocalStorage()) {
    customManufacturerCache = [];
    return customManufacturerCache;
  }

  try {
    const raw = window.localStorage.getItem(CUSTOM_MANUFACTURERS_STORAGE_KEY);
    if (!raw) {
      customManufacturerCache = [];
      return customManufacturerCache;
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      customManufacturerCache = [];
      return customManufacturerCache;
    }

    customManufacturerCache = dedupeManufacturerLabels(
      parsed.filter((entry): entry is string => typeof entry === 'string')
    );
    return customManufacturerCache;
  } catch (_error) {
    customManufacturerCache = [];
    return customManufacturerCache;
  }
}

function writeCustomManufacturerOptions(values: string[]) {
  const next = dedupeManufacturerLabels(values);
  customManufacturerCache = next;

  if (!canUseLocalStorage()) {
    return;
  }

  try {
    window.localStorage.setItem(CUSTOM_MANUFACTURERS_STORAGE_KEY, JSON.stringify(next));
  } catch (_error) {
    // Keep in-memory cache even if browser storage is blocked.
  }
}

export function getManufacturerOptions() {
  const defaults = [...MANUFACTURER_OPTIONS];
  const merged = dedupeManufacturerLabels([...defaults, ...readCustomManufacturerOptions()]);
  return merged;
}

export function hasManufacturerOption(value: string, options = getManufacturerOptions()) {
  const key = normalizeManufacturerKey(value);
  if (!key) {
    return false;
  }

  return options.some((option) => normalizeManufacturerKey(option) === key);
}

export function addManufacturerOption(value: string) {
  const label = normalizeManufacturerLabel(value);
  const key = normalizeManufacturerKey(label);

  if (!key) {
    return '';
  }

  const options = getManufacturerOptions();
  const existing = options.find((option) => normalizeManufacturerKey(option) === key);
  if (existing) {
    return existing;
  }

  const customOptions = readCustomManufacturerOptions();
  writeCustomManufacturerOptions([...customOptions, label]);
  return label;
}

export function deriveFilmKey(manufacturer: string, filmName: string): string {
  return `${manufacturer.trim().toUpperCase()}|${filmName.trim().toUpperCase()}`;
}

export function deriveCreateFeetAvailable(
  initialFeet: number,
  receivedDate: string,
  today = todayDateString()
): number {
  return receivedDate && receivedDate <= today ? initialFeet : 0;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function deriveCoreWeightLbs(coreType: CoreType, widthIn: number): number {
  return roundTo((CORE_WEIGHT_AT_REFERENCE_WIDTH_LBS[coreType] / CORE_REFERENCE_WIDTH_IN) * widthIn, 4);
}

export function deriveLfWeightLbsPerFt(sqFtWeightLbsPerSqFt: number, widthIn: number): number {
  return roundTo(sqFtWeightLbsPerSqFt * (widthIn / 12), 6);
}

export function deriveInitialWeightLbs(
  lfWeightLbsPerFt: number,
  initialFeet: number,
  coreWeightLbs: number
): number {
  return roundTo(lfWeightLbsPerFt * initialFeet + coreWeightLbs, 2);
}

export function deriveSqFtWeightLbsPerSqFt(
  initialWeightLbs: number,
  coreWeightLbs: number,
  widthIn: number,
  initialFeet: number
): number {
  const areaSqFt = (widthIn / 12) * initialFeet;
  if (areaSqFt <= 0) {
    throw new Error('Width and linear feet must be greater than zero to derive film weight.');
  }

  const filmOnlyWeightLbs = initialWeightLbs - coreWeightLbs;
  if (filmOnlyWeightLbs < 0) {
    throw new Error('Initial weight must be greater than or equal to the core weight.');
  }

  return roundTo(filmOnlyWeightLbs / areaSqFt, 8);
}

export function deriveRemainingFeetFromWeight(
  lastRollWeightLbs: number,
  coreWeightLbs: number,
  lfWeightLbsPerFt: number
): number {
  if (lfWeightLbsPerFt <= 0) {
    throw new Error('LF weight per foot must be greater than zero to derive remaining feet.');
  }

  return roundTo((lastRollWeightLbs - coreWeightLbs) / lfWeightLbsPerFt, 2);
}

export function deriveFeetAvailableFromRollWeight(
  lastRollWeightLbs: number,
  coreWeightLbs: number,
  lfWeightLbsPerFt: number,
  initialFeet: number
): number {
  const rawFeet = deriveRemainingFeetFromWeight(lastRollWeightLbs, coreWeightLbs, lfWeightLbsPerFt);
  if (rawFeet <= 0) {
    return 0;
  }

  return Math.min(Math.floor(rawFeet), initialFeet);
}

export function shouldAutoMoveToZeroed(
  receivedDate: string,
  previousFeetAvailable: number,
  nextFeetAvailable: number,
  lastRollWeightLbs: number | null
): boolean {
  return (
    Boolean(receivedDate) &&
    previousFeetAvailable > 0 &&
    (nextFeetAvailable === 0 || lastRollWeightLbs === 0)
  );
}

export function isLowStockFeetValue(feetAvailable: number): boolean {
  return feetAvailable > 0 && feetAvailable < LOW_STOCK_THRESHOLD_LF;
}

export function isLowStockBox(box: Pick<Box, 'status' | 'feetAvailable'>): boolean {
  return box.status === 'IN_STOCK' && isLowStockFeetValue(box.feetAvailable);
}

export function getActiveAllocatedFeet(
  allocations: Array<Pick<AllocationEntry, 'status' | 'allocatedFeet'>>
): number {
  return allocations.reduce((total, entry) => {
    if (entry.status !== 'ACTIVE') {
      return total;
    }

    return total + entry.allocatedFeet;
  }, 0);
}

export function getRemainingAllocatableFeet(
  feetAvailable: number,
  allocations: Array<Pick<AllocationEntry, 'status' | 'allocatedFeet'>>
): number {
  void allocations;
  return Math.max(feetAvailable, 0);
}

export function createEmptyBoxDraft(): BoxDraft {
  return {
    boxId: '',
    manufacturer: MANUFACTURER_OPTIONS[0],
    filmName: '',
    widthIn: '36',
    initialFeet: '100',
    feetAvailable: '100',
    lotRun: '',
    orderDate: todayDateString(),
    receivedDate: '',
    initialWeightLbs: '',
    lastRollWeightLbs: '',
    lastWeighedDate: '',
    filmKey: '',
    coreType: '',
    coreWeightLbs: '',
    lfWeightLbsPerFt: '',
    purchaseCost: '',
    notes: ''
  };
}

export function createDraftFromBox(box: Box): BoxDraft {
  return {
    boxId: box.boxId,
    manufacturer: box.manufacturer,
    filmName: box.filmName,
    widthIn: String(box.widthIn),
    initialFeet: String(box.initialFeet),
    feetAvailable: String(box.feetAvailable),
    lotRun: box.lotRun,
    orderDate: toDateInputValue(box.orderDate),
    receivedDate: toDateInputValue(box.receivedDate),
    initialWeightLbs: box.initialWeightLbs === null ? '' : String(box.initialWeightLbs),
    lastRollWeightLbs: box.lastRollWeightLbs === null ? '' : String(box.lastRollWeightLbs),
    lastWeighedDate: toDateInputValue(box.lastWeighedDate),
    filmKey: box.filmKey,
    coreType: box.coreType,
    coreWeightLbs: box.coreWeightLbs === null ? '' : String(box.coreWeightLbs),
    lfWeightLbsPerFt: box.lfWeightLbsPerFt === null ? '' : String(box.lfWeightLbsPerFt),
    purchaseCost: box.purchaseCost === null ? '' : String(box.purchaseCost),
    notes: box.notes
  };
}

export function getWidthMode(widthIn: string): string {
  return STANDARD_WIDTH_OPTIONS.includes(widthIn as (typeof STANDARD_WIDTH_OPTIONS)[number])
    ? widthIn
    : 'CUSTOM';
}

export function getNextBoxIdForWarehouse(boxes: Box[], warehouse: Warehouse): string {
  let bestValue = 0;
  let bestWidth = 0;
  let bestPrefix = warehouse === 'MS' ? 'M' : '';

  for (const box of boxes) {
    const match = box.boxId.match(/^(.*?)(\d+)$/);
    if (!match) {
      continue;
    }

    const numericValue = Number(match[2]);
    if (!Number.isFinite(numericValue)) {
      continue;
    }

    if (numericValue > bestValue) {
      bestValue = numericValue;
      bestWidth = match[2].length;
      bestPrefix = match[1];
    }
  }

  const nextValue = bestValue + 1;
  const nextDigits = String(nextValue).padStart(Math.max(bestWidth, String(nextValue).length), '0');
  const nextPrefix = bestValue > 0 ? bestPrefix : warehouse === 'MS' ? 'M' : '';

  return `${nextPrefix}${nextDigits}`;
}

export function getRiskyFieldChanges(current: Box, next: UpdateBoxPayload): string[] {
  const risky: string[] = [];

  if (current.initialFeet !== next.initialFeet) {
    risky.push('Linear Feet');
  }

  if (current.feetAvailable !== next.feetAvailable) {
    risky.push('Feet Available');
  }

  if (current.widthIn !== next.widthIn) {
    risky.push('Width');
  }

  return risky;
}
