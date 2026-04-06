import type {
  AllocationEntry,
  Box,
  CoreType,
  BoxStatus,
  FilmCatalogEntry,
  UpdateBoxPayload,
  Warehouse
} from '../../../domain';
import {
  dedupeBoxesByDisplayBoxId,
  formatBoxIdWithWarehousePrefix,
  getWarehouseBoxIdPrefixToken,
  isWarehousePrefixOnlyBoxId,
  normalizeCreateBoxIdForWarehouse,
  remapCreateBoxIdForWarehouse,
  normalizeTrailingLetterBoxId
} from '../../../lib/boxIds';
import { toDateInputValue, todayDateString } from '../../../lib/date';
import {
  canonicalizeManufacturerLabel,
  normalizeManufacturerLookupKey
} from '../../../lib/manufacturerCanonicalization';

export { canonicalizeManufacturerLabel };
export {
  dedupeBoxesByDisplayBoxId,
  formatBoxIdWithWarehousePrefix,
  getWarehouseBoxIdPrefixToken,
  isWarehousePrefixOnlyBoxId,
  normalizeCreateBoxIdForWarehouse,
  remapCreateBoxIdForWarehouse,
  normalizeTrailingLetterBoxId
};

export const STANDARD_WIDTH_OPTIONS = ['36', '48', '60', '72'] as const;
export const CORE_TYPE_OPTIONS = [
  'White plastic',
  'Red plastic',
  'Cardboard 1/8"',
  'Cardboard 3/8"',
  'SECURITY 1/4" Cardboard',
  'SECURITY White plastic 3/8"'
] as const;
export const CORE_REFERENCE_WIDTH_IN = 72;
export const LOW_STOCK_THRESHOLD_LF = 10;
const ACTIVE_CANONICAL_BOX_STATUSES: readonly BoxStatus[] = ['ORDERED', 'IN_STOCK', 'CHECKED_OUT'];
const CORE_WEIGHT_AT_REFERENCE_WIDTH_LBS: Record<CoreType, number> = {
  'White plastic': 2,
  'Red plastic': 1.85,
  'Cardboard 1/8"': 2.05,
  'Cardboard 3/8"': 6.15,
  'SECURITY 1/4" Cardboard': 11.6,
  'SECURITY White plastic 3/8"': 14.4
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
  pricePerLf: string;
  purchaseCost: string;
  notes: string;
}

function normalizeManufacturerLabel(value: string) {
  return canonicalizeManufacturerLabel(value);
}

function normalizeManufacturerKey(value: string) {
  return normalizeManufacturerLookupKey(value);
}

export function normalizeCoreTypeValue(value: string): string {
  const trimmed = value.trim();

  if (trimmed === 'Cardboard 3/4"' || trimmed === 'Cardboard 3/4') {
    return 'Cardboard 3/8"';
  }

  return trimmed;
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

function compareManufacturerLabels(left: string, right: string) {
  return left.localeCompare(right, undefined, { sensitivity: 'base' });
}

export function getManufacturerOptions(catalogEntries?: FilmCatalogEntry[]) {
  if (!catalogEntries || catalogEntries.length === 0) {
    return [];
  }

  const catalogManufacturers: string[] = [];
  for (let index = 0; index < catalogEntries.length; index += 1) {
    const label = normalizeManufacturerLabel(catalogEntries[index].manufacturer || '');
    if (label) {
      catalogManufacturers.push(label);
    }
  }

  return dedupeManufacturerLabels(catalogManufacturers).sort(compareManufacturerLabels);
}

export function getManufacturerOptionsWithCatalog(catalogEntries?: FilmCatalogEntry[]) {
  return getManufacturerOptions(catalogEntries);
}

export function hasManufacturerOption(value: string, options: string[] = []) {
  const key = normalizeManufacturerKey(value);
  if (!key) {
    return false;
  }

  return options.some((option) => normalizeManufacturerKey(option) === key);
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

function clampFeetAvailable(feetAvailable: number, initialFeet: number): number {
  return Math.min(Math.max(Math.floor(feetAvailable), 0), initialFeet);
}

export interface ReceivedFeetResolutionContext {
  receivedDate: string;
  initialFeet: number;
  lastRollWeightLbs: number | null;
  coreWeightLbs: number | null;
  lfWeightLbsPerFt: number | null;
}

function hasReceivedFeetMetadata(context: ReceivedFeetResolutionContext): boolean {
  return (
    context.lastRollWeightLbs !== null &&
    context.coreWeightLbs !== null &&
    context.lfWeightLbsPerFt !== null &&
    context.lfWeightLbsPerFt > 0
  );
}

export function shouldRecalculateReceivedBoxFeet(
  currentBox: Pick<
    Box,
    'status' | 'receivedDate' | 'initialFeet' | 'lastRollWeightLbs' | 'coreWeightLbs' | 'lfWeightLbsPerFt'
  > | null | undefined,
  nextValues: ReceivedFeetResolutionContext
): boolean {
  if (!nextValues.receivedDate) {
    return false;
  }

  if (!currentBox || !currentBox.receivedDate) {
    return true;
  }

  if (currentBox.status === 'ZEROED') {
    return true;
  }

  return (
    currentBox.initialFeet !== nextValues.initialFeet ||
    currentBox.lastRollWeightLbs !== nextValues.lastRollWeightLbs ||
    currentBox.coreWeightLbs !== nextValues.coreWeightLbs ||
    currentBox.lfWeightLbsPerFt !== nextValues.lfWeightLbsPerFt
  );
}

export function deriveReceivedBoxPhysicalFeet(
  nextValues: ReceivedFeetResolutionContext
): number | null {
  if (!hasReceivedFeetMetadata(nextValues)) {
    return null;
  }

  return deriveFeetAvailableFromRollWeight(
    nextValues.lastRollWeightLbs!,
    nextValues.coreWeightLbs!,
    nextValues.lfWeightLbsPerFt!,
    nextValues.initialFeet
  );
}

export function resolveEditedReceivedBoxFeetAvailable(
  currentBox: Pick<
    Box,
    'status' | 'receivedDate' | 'initialFeet' | 'feetAvailable' | 'lastRollWeightLbs' | 'coreWeightLbs' | 'lfWeightLbsPerFt'
  > | null | undefined,
  nextValues: ReceivedFeetResolutionContext,
  allocations: Array<Pick<AllocationEntry, 'status' | 'allocatedFeet'>> = []
): number {
  if (!currentBox) {
    return clampFeetAvailable(nextValues.initialFeet, nextValues.initialFeet);
  }

  if (!nextValues.receivedDate) {
    return clampFeetAvailable(currentBox.feetAvailable, nextValues.initialFeet);
  }

  if (!currentBox.receivedDate) {
    return clampFeetAvailable(
      nextValues.initialFeet - getActiveAllocatedFeet(allocations),
      nextValues.initialFeet
    );
  }

  const physicalFeetAvailable = deriveReceivedBoxPhysicalFeet(nextValues);
  const shouldRepairStaleFeet =
    currentBox.feetAvailable <= 0 &&
    physicalFeetAvailable !== null &&
    physicalFeetAvailable > 0;

  if (!shouldRecalculateReceivedBoxFeet(currentBox, nextValues) && !shouldRepairStaleFeet) {
    return clampFeetAvailable(currentBox.feetAvailable, nextValues.initialFeet);
  }

  if (physicalFeetAvailable === null) {
    return clampFeetAvailable(currentBox.feetAvailable, nextValues.initialFeet);
  }

  const activeAllocatedFeet = getActiveAllocatedFeet(allocations);
  return clampFeetAvailable(physicalFeetAvailable - activeAllocatedFeet, nextValues.initialFeet);
}

export function getDisplayedAllocatedFeetForBox(
  box: Pick<Box, 'status' | 'lastCheckoutJob'>,
  allocations: Array<Pick<AllocationEntry, 'status' | 'allocatedFeet' | 'jobNumber'>>
): number {
  const checkoutJob = box.lastCheckoutJob.trim();
  if (box.status !== 'CHECKED_OUT' || !checkoutJob) {
    return getActiveAllocatedFeet(allocations);
  }

  const checkoutJobKey = checkoutJob.toUpperCase();
  return allocations.reduce((total, entry) => {
    if (entry.jobNumber.trim().toUpperCase() !== checkoutJobKey) {
      return total;
    }

    if (entry.status !== 'ACTIVE' && entry.status !== 'FULFILLED') {
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

export function createEmptyBoxDraft(defaultManufacturer = ''): BoxDraft {
  return {
    boxId: '',
    manufacturer: defaultManufacturer,
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
    pricePerLf: '',
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
    initialWeightLbs: box.initialWeightLbs == null ? '' : String(box.initialWeightLbs),
    lastRollWeightLbs: box.lastRollWeightLbs == null ? '' : String(box.lastRollWeightLbs),
    lastWeighedDate: toDateInputValue(box.lastWeighedDate),
    filmKey: box.filmKey,
    coreType: normalizeCoreTypeValue(box.coreType),
    coreWeightLbs: box.coreWeightLbs == null ? '' : String(box.coreWeightLbs),
    lfWeightLbsPerFt: box.lfWeightLbsPerFt == null ? '' : String(box.lfWeightLbsPerFt),
    pricePerLf: box.pricePerLf == null ? '' : String(box.pricePerLf),
    purchaseCost: box.purchaseCost == null ? '' : String(box.purchaseCost),
    notes: box.notes
  };
}

export function getWidthMode(widthIn: string): string {
  return STANDARD_WIDTH_OPTIONS.includes(widthIn as (typeof STANDARD_WIDTH_OPTIONS)[number])
    ? widthIn
    : 'CUSTOM';
}

export function getNextBoxIdForWarehouse(
  boxes: Box[],
  warehouse: Warehouse,
  warehousePrefix = warehouse
): string {
  const normalizedPrefix = String(warehousePrefix || warehouse).trim().toUpperCase().replace(/-+$/, '');
  const requiredPrefix = normalizedPrefix ? `${normalizedPrefix}-` : '';
  const activeCanonicalBoxes = dedupeBoxesByDisplayBoxId(
    boxes
      .filter((box) => ACTIVE_CANONICAL_BOX_STATUSES.includes(box.status))
      .map((box) => ({
        ...box,
        boxId: normalizeTrailingLetterBoxId(box.boxId)
      }))
  ).filter((box) => {
    if (!requiredPrefix) {
      return true;
    }

    const canonicalBoxId = formatBoxIdWithWarehousePrefix(box.boxId, box.warehouse);
    return canonicalBoxId.startsWith(requiredPrefix);
  });
  let bestValue = 0;
  let bestWidth = 0;

  for (const box of activeCanonicalBoxes) {
    const normalizedBoxId = formatBoxIdWithWarehousePrefix(box.boxId, box.warehouse);
    const match = normalizedBoxId.match(/^[A-Z0-9]+-(\d+)$/);
    if (!match) {
      continue;
    }

    const numericValue = Number(match[1]);
    if (!Number.isFinite(numericValue)) {
      continue;
    }

    if (numericValue > bestValue) {
      bestValue = numericValue;
      bestWidth = match[1].length;
    }
  }

  const nextValue = bestValue + 1;
  const nextDigits = String(nextValue).padStart(Math.max(bestWidth, String(nextValue).length), '0');

  return `${requiredPrefix}${nextDigits}`;
}

export function getRiskyFieldChanges(current: Box, next: UpdateBoxPayload): string[] {
  const risky: string[] = [];

  if (current.initialFeet !== next.initialFeet) {
    risky.push('Linear Feet');
  }

  if (current.widthIn !== next.widthIn) {
    risky.push('Width');
  }

  return risky;
}
