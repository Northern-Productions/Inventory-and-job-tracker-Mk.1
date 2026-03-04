import { z } from 'zod';
import type {
  AddBoxPayload,
  SearchBoxesParams,
  UpdateBoxPayload
} from '../../../domain';
import { toOptionalNumber } from '../../../lib/number';
import type { BoxDraft } from '../utils/boxHelpers';
import {
  CORE_TYPE_OPTIONS,
  deriveCreateFeetAvailable,
  MANUFACTURER_OPTIONS
} from '../utils/boxHelpers';

export interface InventoryFilterValues {
  warehouse: SearchBoxesParams['warehouse'];
  q: string;
  status: SearchBoxesParams['status'];
  film: string;
  width: string;
  showRetired: boolean;
}

const requiredString = z.string().trim().min(1, 'Required.');
const optionalString = z.string().transform((value) => value.trim());
const addManufacturerString = requiredString.refine(
  (value) => MANUFACTURER_OPTIONS.includes(value as (typeof MANUFACTURER_OPTIONS)[number]),
  'Select a manufacturer.'
);
const optionalCoreTypeString = z
  .string()
  .trim()
  .refine(
    (value) => value === '' || CORE_TYPE_OPTIONS.includes(value as (typeof CORE_TYPE_OPTIONS)[number]),
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
  manufacturer: addManufacturerString,
  filmName: requiredString,
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
  purchaseCost: z.number().nullable(),
  notes: optionalString
});

const updateSchema = addSchema.extend({
  boxId: requiredString,
  manufacturer: requiredString
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

function parseCoreType(value: string): AddBoxPayload['coreType'] {
  return value.trim() as AddBoxPayload['coreType'];
}

export function parseAddBoxDraft(draft: BoxDraft): AddBoxPayload {
  const initialFeet = parseRequiredNumber(draft.initialFeet, 'Linear feet');

  return addSchema.parse({
    boxId: draft.boxId,
    manufacturer: draft.manufacturer,
    filmName: draft.filmName,
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
    purchaseCost: parseOptionalNonNegativeNumber(draft.purchaseCost, 'Purchase cost'),
    notes: draft.notes
  }) as AddBoxPayload;
}

export function parseUpdateBoxDraft(draft: BoxDraft): UpdateBoxPayload {
  return updateSchema.parse({
    boxId: draft.boxId,
    manufacturer: draft.manufacturer,
    filmName: draft.filmName,
    widthIn: parseRequiredNumber(draft.widthIn, 'Width'),
    initialFeet: parseRequiredNumber(draft.initialFeet, 'Linear feet'),
    feetAvailable: parseRequiredNumber(draft.feetAvailable, 'Feet available'),
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
    purchaseCost: parseOptionalNonNegativeNumber(draft.purchaseCost, 'Purchase cost'),
    notes: draft.notes
  }) as UpdateBoxPayload;
}
