import type {
  AllocationEntry,
  Box,
  Warehouse
} from '../../../../domain';
import {
  dedupeBoxesByDisplayBoxId,
  formatBoxIdWithWarehousePrefix,
  normalizeTrailingLetterBoxId
} from '../../../../lib/boxIds';
import { toDateInputValue, todayDateString } from '../../../../lib/date';
import { deriveCurrentFeetOnRollForBox } from './boxRollTracking';

export const STANDARD_WIDTH_OPTIONS = ['36', '48', '60', '72'] as const;

export interface BoxDraft {
  boxId: string;
  dealer: string;
  manufacturer: string;
  filmName: string;
  widthIn: string;
  initialFeet: string;
  currentFeetOnRoll: string;
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
  currentFeetOnRollManuallyEdited: boolean;
  lastRollWeightLbsManuallyEdited: boolean;
}

export function normalizeCoreTypeValue(value: string): string {
  const trimmed = value.trim();

  if (trimmed === 'Cardboard 3/4"' || trimmed === 'Cardboard 3/4') {
    return 'Cardboard 3/8"';
  }

  return trimmed;
}

export function createEmptyBoxDraft(defaultManufacturer = ''): BoxDraft {
  return {
    boxId: '',
    dealer: '',
    manufacturer: defaultManufacturer,
    filmName: '',
    widthIn: '36',
    initialFeet: '100',
    currentFeetOnRoll: '100',
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
    notes: '',
    currentFeetOnRollManuallyEdited: false,
    lastRollWeightLbsManuallyEdited: false
  };
}

export function createDraftFromBox(
  box: Box,
  allocations: Array<Pick<AllocationEntry, 'status' | 'allocatedFeet'>> | null = null
): BoxDraft {
  const currentFeetOnRoll = deriveCurrentFeetOnRollForBox(box, allocations);

  return {
    boxId: box.boxId,
    dealer: box.dealer || '',
    manufacturer: box.manufacturer,
    filmName: box.filmName,
    widthIn: String(box.widthIn),
    initialFeet: String(box.initialFeet),
    currentFeetOnRoll: String(currentFeetOnRoll ?? Math.max(box.feetAvailable, 0)),
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
    notes: box.notes,
    currentFeetOnRollManuallyEdited: false,
    lastRollWeightLbsManuallyEdited: false
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
  const knownBoxIdentities = dedupeBoxesByDisplayBoxId(
    boxes
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

  for (const box of knownBoxIdentities) {
    const normalizedBoxId = formatBoxIdWithWarehousePrefix(box.boxId, box.warehouse);
    if (!requiredPrefix || !normalizedBoxId.startsWith(requiredPrefix)) {
      continue;
    }

    const localSegment = normalizedBoxId.slice(requiredPrefix.length).split('-')[0] || '';
    const localMatch = localSegment.match(/^(\d+)[A-Z]?$/);
    if (!localMatch) {
      continue;
    }

    const numericValue = Number(localMatch[1]);
    if (!Number.isFinite(numericValue)) {
      continue;
    }

    if (numericValue > bestValue) {
      bestValue = numericValue;
      bestWidth = localMatch[1].length;
    }
  }

  const nextValue = bestValue + 1;
  const nextDigits = String(nextValue).padStart(Math.max(bestWidth, String(nextValue).length), '0');

  return `${requiredPrefix}${nextDigits}`;
}
