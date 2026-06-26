import { z } from 'zod';
import type {
  AddBoxPayload,
  AllocationEntry,
  SearchBoxesParams,
  Box,
  UpdateBoxPayload
} from '../../../domain';
import { toOptionalNumber } from '../../../lib/number';
import type { BoxDraft } from '../utils/boxHelpers';
import type { WarehouseFilterValue } from '../utils/warehouseOptions';
import {
  CORE_TYPE_OPTIONS,
  deriveCreateFeetAvailable,
  normalizeTrailingLetterBoxId,
  normalizeCoreTypeValue,
  resolveUpdateBoxRollTracking
} from '../utils/boxHelpers';

export interface InventoryFilterValues {
  warehouse: WarehouseFilterValue;
  manufacturer: string;
  q: string;
  status: SearchBoxesParams['status'];
  film: string;
  widths: string[];
  showRetired: boolean;
}

const requiredString = z.string().trim().min(1, 'Required.');
const optionalString = z.string().transform((value) => value.trim());
const addManufacturerString = requiredString;
const optionalCoreTypeString = z
  .string()
  .trim()
  .refine(
    (value) =>
      value === '' ||
      CORE_TYPE_OPTIONS.includes(
        normalizeCoreTypeValue(value) as (typeof CORE_TYPE_OPTIONS)[number]
      ),
    'Select a core type.'
  );
const dateString = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use yyyy-mm-dd.');
const optionalDateString = z
  .string()
  .trim()
  .refine((value) => value === '' || /^\d{4}-\d{2}-\d{2}$/.test(value), 'Use yyyy-mm-dd.');

const addSchema = z.object({
  boxId: requiredString,
  dealer: optionalString,
  manufacturer: addManufacturerString,
  filmName: requiredString,
  ownerCompanyId: requiredString,
  widthIn: z.number().min(0, 'Width must be zero or greater.'),
  initialFeet: z.number().min(0, 'Initial feet must be zero or greater.'),
  feetAvailable: z.number(),
  lotRun: optionalString,
  orderDate: dateString,
  receivedDate: optionalDateString,
  initialWeightLbs: z.number().nullable(),
  lastRollWeightLbs: z.number().nullable(),
  lastWeighedDate: optionalString,
  filmKey: optionalString,
  coreType: optionalCoreTypeString,
  coreWeightLbs: z.number().nullable(),
  lfWeightLbsPerFt: z.number().nullable(),
  pricePerLf: z.number().nullable(),
  purchaseCost: z.number().nullable(),
  notes: optionalString
});

const updateSchema = addSchema.omit({ ownerCompanyId: true }).extend({
  boxId: requiredString,
  manufacturer: requiredString,
  currentFeetOnRoll: z.number().min(0, 'Current feet must be zero or greater.').optional()
});

function parseRequiredNumber(value: string, fieldLabel: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldLabel} must be a number.`);
  }

  return parsed;
}

function parseOptionalNonNegativeNumber(value: string, fieldLabel: string): number | null {
  const parsed = toOptionalNumber(value);

  if (parsed === null) {
    return null;
  }

  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldLabel} must be a number.`);
  }

  if (parsed < 0) {
    throw new Error(`${fieldLabel} must be zero or greater.`);
  }

  return parsed;
}

function roundToDecimals(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function resolvePricePerLfForDraft(
  initialFeet: number,
  purchaseCost: number | null,
  submittedPricePerLfRaw: string
): number | null {
  if (purchaseCost !== null) {
    if (initialFeet <= 0) {
      throw new Error('PurchaseCost requires InitialFeet > 0 to derive PricePerLf.');
    }

    return roundToDecimals(purchaseCost / initialFeet, 4);
  }

  return parseOptionalNonNegativeNumber(submittedPricePerLfRaw, 'Price per LF');
}

function parseCoreType(value: string): AddBoxPayload['coreType'] {
  return normalizeCoreTypeValue(value) as AddBoxPayload['coreType'];
}

export function parseAddBoxDraft(draft: BoxDraft): AddBoxPayload {
  const initialFeet = parseRequiredNumber(draft.initialFeet, 'Initial linear feet');
  const purchaseCost = parseOptionalNonNegativeNumber(draft.purchaseCost, 'Purchase cost');
  const resolvedPricePerLf = resolvePricePerLfForDraft(initialFeet, purchaseCost, draft.pricePerLf);

  return addSchema.parse({
    boxId: normalizeTrailingLetterBoxId(draft.boxId),
    dealer: draft.dealer,
    manufacturer: draft.manufacturer,
    filmName: draft.filmName,
    ownerCompanyId: draft.ownerCompanyId,
    widthIn: parseRequiredNumber(draft.widthIn, 'Width'),
    initialFeet,
    feetAvailable: deriveCreateFeetAvailable(initialFeet, draft.receivedDate),
    lotRun: draft.lotRun,
    orderDate: draft.orderDate,
    receivedDate: draft.receivedDate,
    initialWeightLbs: parseOptionalNonNegativeNumber(draft.initialWeightLbs, 'Initial weight'),
    lastRollWeightLbs: parseOptionalNonNegativeNumber(
      draft.lastRollWeightLbs,
      'Last roll weight'
    ),
    lastWeighedDate: draft.lastWeighedDate.trim(),
    filmKey: '',
    coreType: parseCoreType(draft.coreType),
    coreWeightLbs: parseOptionalNonNegativeNumber(draft.coreWeightLbs, 'Core weight'),
    lfWeightLbsPerFt: parseOptionalNonNegativeNumber(
      draft.lfWeightLbsPerFt,
      'LF weight per foot'
    ),
    pricePerLf: resolvedPricePerLf,
    purchaseCost,
    notes: draft.notes
  }) as AddBoxPayload;
}

export function parseUpdateBoxDraft(
  draft: BoxDraft,
  currentBox?: Box | null,
  allocations: Array<Pick<AllocationEntry, 'status' | 'allocatedFeet'>> = []
): UpdateBoxPayload {
  const storedInitialFeet = parseRequiredNumber(draft.initialFeet, 'Initial linear feet');
  const currentFeetOnRoll = parseRequiredNumber(
    draft.currentFeetOnRoll || draft.initialFeet,
    'Current linear feet'
  );
  const purchaseCost = parseOptionalNonNegativeNumber(draft.purchaseCost, 'Purchase cost');
  const nextRollTracking = resolveUpdateBoxRollTracking(
    currentBox,
    {
      receivedDate: draft.receivedDate,
      initialFeet: currentBox?.receivedDate && draft.receivedDate ? storedInitialFeet : currentFeetOnRoll,
      currentFeetOnRoll,
      lastRollWeightLbs: parseOptionalNonNegativeNumber(
        draft.lastRollWeightLbs,
        'Last roll weight'
      ),
      coreWeightLbs: parseOptionalNonNegativeNumber(draft.coreWeightLbs, 'Core weight'),
      lfWeightLbsPerFt: parseOptionalNonNegativeNumber(
        draft.lfWeightLbsPerFt,
        'LF weight per foot'
      ),
      currentFeetOnRollManuallyEdited: draft.currentFeetOnRollManuallyEdited,
      lastRollWeightLbsManuallyEdited: draft.lastRollWeightLbsManuallyEdited
    },
    allocations
  );
  const resolvedPricePerLf = resolvePricePerLfForDraft(
    nextRollTracking.initialFeet,
    purchaseCost,
    draft.pricePerLf
  );
  const nextValues = {
    receivedDate: draft.receivedDate,
    initialFeet: nextRollTracking.initialFeet,
    currentFeetOnRoll: nextRollTracking.currentFeetOnRoll,
    lastRollWeightLbs: nextRollTracking.lastRollWeightLbs,
    coreWeightLbs: parseOptionalNonNegativeNumber(draft.coreWeightLbs, 'Core weight'),
    lfWeightLbsPerFt: parseOptionalNonNegativeNumber(draft.lfWeightLbsPerFt, 'LF weight per foot')
  };

  return updateSchema.parse({
    boxId: normalizeTrailingLetterBoxId(draft.boxId),
    dealer: draft.dealer,
    manufacturer: draft.manufacturer,
    filmName: draft.filmName,
    widthIn: parseRequiredNumber(draft.widthIn, 'Width'),
    initialFeet: nextValues.initialFeet,
    currentFeetOnRoll: nextValues.currentFeetOnRoll,
    feetAvailable: nextRollTracking.feetAvailable,
    lotRun: draft.lotRun,
    orderDate: draft.orderDate,
    receivedDate: draft.receivedDate,
    initialWeightLbs: parseOptionalNonNegativeNumber(draft.initialWeightLbs, 'Initial weight'),
    lastRollWeightLbs: nextValues.lastRollWeightLbs,
    lastWeighedDate: draft.lastWeighedDate.trim(),
    filmKey: '',
    coreType: parseCoreType(draft.coreType),
    coreWeightLbs: nextValues.coreWeightLbs,
    lfWeightLbsPerFt: nextValues.lfWeightLbsPerFt,
    pricePerLf: resolvedPricePerLf,
    purchaseCost,
    notes: draft.notes
  }) as UpdateBoxPayload;
}
