import type {
  AllocationEntry,
  Box,
  BoxStatus,
  CoreType
} from '../../../../domain';
import { deriveCreateFeetAvailable } from './boxLifecycle';

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

const CORE_WEIGHT_AT_REFERENCE_WIDTH_LBS: Record<CoreType, number> = {
  'White plastic': 2,
  'Red plastic': 1.85,
  'Cardboard 1/8"': 2.05,
  'Cardboard 3/8"': 6.15,
  'SECURITY 1/4" Cardboard': 11.6,
  'SECURITY White plastic 3/8"': 14.4
};

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

export function deriveLastRollWeightLbsFromCurrentFeet(
  currentFeetOnRoll: number,
  coreWeightLbs: number,
  lfWeightLbsPerFt: number
): number {
  return roundTo(lfWeightLbsPerFt * currentFeetOnRoll + coreWeightLbs, 2);
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

export function getActiveLockedAllocatedFeet(
  allocations: Array<Pick<AllocationEntry, 'status' | 'allocatedFeet' | 'reservationState'>>
): number {
  return allocations.reduce((total, entry) => {
    if (entry.status !== 'ACTIVE' || entry.reservationState !== 'WITH_INSTALL_DATE') {
      return total;
    }

    return total + entry.allocatedFeet;
  }, 0);
}

function clampFeetAvailable(feetAvailable: number, initialFeet: number): number {
  return Math.min(Math.max(Math.floor(feetAvailable), 0), initialFeet);
}

export interface RollTrackingResolutionContext {
  receivedDate: string;
  initialFeet: number;
  currentFeetOnRoll: number | null;
  lastRollWeightLbs: number | null;
  coreWeightLbs: number | null;
  lfWeightLbsPerFt: number | null;
  currentFeetOnRollManuallyEdited?: boolean;
  lastRollWeightLbsManuallyEdited?: boolean;
}

export function canDeriveFeetFromSubmittedRollWeight(context: Pick<
  RollTrackingResolutionContext,
  'coreWeightLbs' | 'lfWeightLbsPerFt'
>): boolean {
  return (
    context.coreWeightLbs !== null &&
    context.lfWeightLbsPerFt !== null &&
    context.lfWeightLbsPerFt > 0
  );
}

export function hasStoredRollWeightMetadata(context: Pick<
  RollTrackingResolutionContext,
  'lastRollWeightLbs' | 'coreWeightLbs' | 'lfWeightLbsPerFt'
>): boolean {
  return (
    context.lastRollWeightLbs !== null && canDeriveFeetFromSubmittedRollWeight(context)
  );
}

function canDeriveRollWeightFromCurrentFeet(context: Pick<
  RollTrackingResolutionContext,
  'coreWeightLbs' | 'lfWeightLbsPerFt'
>): boolean {
  return canDeriveFeetFromSubmittedRollWeight(context);
}

export function boxNeedsAllocationsToResolveCurrentFeet(
  box: Pick<Box, 'receivedDate' | 'lastRollWeightLbs' | 'coreWeightLbs' | 'lfWeightLbsPerFt'>
): boolean {
  return Boolean(box.receivedDate) && !hasStoredRollWeightMetadata(box);
}

export function shouldRecalculateReceivedBoxFeet(
  currentBox: Pick<
    Box,
    'status' | 'receivedDate' | 'initialFeet' | 'lastRollWeightLbs' | 'coreWeightLbs' | 'lfWeightLbsPerFt'
  > | null | undefined,
  nextValues: RollTrackingResolutionContext
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
  nextValues: Pick<
    RollTrackingResolutionContext,
    'initialFeet' | 'lastRollWeightLbs' | 'coreWeightLbs' | 'lfWeightLbsPerFt'
  >
): number | null {
  if (!hasStoredRollWeightMetadata(nextValues)) {
    return null;
  }

  return deriveFeetAvailableFromRollWeight(
    nextValues.lastRollWeightLbs!,
    nextValues.coreWeightLbs!,
    nextValues.lfWeightLbsPerFt!,
    nextValues.initialFeet
  );
}

export function deriveCurrentFeetOnRollForBox(
  box: Pick<
    Box,
    | 'receivedDate'
    | 'initialFeet'
    | 'feetAvailable'
    | 'physicalFeetAvailable'
    | 'lastRollWeightLbs'
    | 'coreWeightLbs'
    | 'lfWeightLbsPerFt'
  >,
  allocations: Array<Pick<AllocationEntry, 'status' | 'allocatedFeet' | 'reservationState'>> | null = null
): number | null {
  if (!box.receivedDate) {
    return clampFeetAvailable(box.initialFeet, box.initialFeet);
  }

  const derivedFromWeight = deriveReceivedBoxPhysicalFeet({
    initialFeet: box.initialFeet,
    lastRollWeightLbs: box.lastRollWeightLbs,
    coreWeightLbs: box.coreWeightLbs,
    lfWeightLbsPerFt: box.lfWeightLbsPerFt
  });

  if (derivedFromWeight !== null) {
    return derivedFromWeight;
  }

  if (box.physicalFeetAvailable !== undefined && box.physicalFeetAvailable !== null) {
    return clampFeetAvailable(box.physicalFeetAvailable, box.initialFeet);
  }

  if (allocations !== null) {
    return clampFeetAvailable(box.feetAvailable + getActiveLockedAllocatedFeet(allocations), box.initialFeet);
  }

  if (boxNeedsAllocationsToResolveCurrentFeet(box)) {
    return null;
  }

  return clampFeetAvailable(box.feetAvailable, box.initialFeet);
}

export function resolveEditedReceivedBoxFeetAvailable(
  currentBox: Pick<
    Box,
    | 'status'
    | 'receivedDate'
    | 'initialFeet'
    | 'feetAvailable'
    | 'physicalFeetAvailable'
    | 'lastRollWeightLbs'
    | 'coreWeightLbs'
    | 'lfWeightLbsPerFt'
  > | null | undefined,
  nextValues: RollTrackingResolutionContext,
  allocations: Array<Pick<AllocationEntry, 'status' | 'allocatedFeet' | 'reservationState'>> = []
): number {
  return resolveUpdateBoxRollTracking(currentBox, nextValues, allocations).feetAvailable;
}

function getCurrentFeetEditFallback(
  currentBox: Pick<
    Box,
    | 'receivedDate'
    | 'initialFeet'
    | 'feetAvailable'
    | 'physicalFeetAvailable'
    | 'lastRollWeightLbs'
    | 'coreWeightLbs'
    | 'lfWeightLbsPerFt'
  > | null | undefined,
  nextValues: RollTrackingResolutionContext,
  allocations: Array<Pick<AllocationEntry, 'status' | 'allocatedFeet' | 'reservationState'>>
) {
  if (!currentBox) {
    return clampFeetAvailable(nextValues.currentFeetOnRoll ?? nextValues.initialFeet, nextValues.initialFeet);
  }

  const derivedFeet = deriveCurrentFeetOnRollForBox(
    {
      ...currentBox,
      initialFeet: nextValues.initialFeet,
      lastRollWeightLbs: nextValues.lastRollWeightLbs,
      coreWeightLbs: nextValues.coreWeightLbs,
      lfWeightLbsPerFt: nextValues.lfWeightLbsPerFt
    },
    allocations
  );

  if (derivedFeet !== null) {
    return clampFeetAvailable(derivedFeet, nextValues.initialFeet);
  }

  return clampFeetAvailable(currentBox.feetAvailable, nextValues.initialFeet);
}

export function resolveUpdateBoxRollTracking(
  currentBox: Pick<
    Box,
    | 'status'
    | 'receivedDate'
    | 'initialFeet'
    | 'feetAvailable'
    | 'physicalFeetAvailable'
    | 'lastRollWeightLbs'
    | 'coreWeightLbs'
    | 'lfWeightLbsPerFt'
  > | null | undefined,
  nextValues: RollTrackingResolutionContext,
  allocations: Array<Pick<AllocationEntry, 'status' | 'allocatedFeet' | 'reservationState'>> = []
) {
  const currentFeetInput =
    nextValues.currentFeetOnRoll === null
      ? null
      : clampFeetAvailable(nextValues.currentFeetOnRoll, nextValues.initialFeet);
  const currentFeetOnRollManuallyEdited = nextValues.currentFeetOnRollManuallyEdited ?? false;
  const lastRollWeightLbsManuallyEdited = nextValues.lastRollWeightLbsManuallyEdited ?? false;

  if (!nextValues.receivedDate) {
    const initialFeet = clampFeetAvailable(currentFeetInput ?? nextValues.initialFeet, currentFeetInput ?? nextValues.initialFeet);
    return {
      initialFeet,
      currentFeetOnRoll: initialFeet,
      feetAvailable: currentBox
        ? clampFeetAvailable(currentBox.feetAvailable, initialFeet)
        : deriveCreateFeetAvailable(initialFeet, nextValues.receivedDate),
      lastRollWeightLbs: null
    };
  }

  if (!currentBox || !currentBox.receivedDate) {
    const initialFeet = clampFeetAvailable(currentFeetInput ?? nextValues.initialFeet, currentFeetInput ?? nextValues.initialFeet);
    return {
      initialFeet,
      currentFeetOnRoll: initialFeet,
      feetAvailable: clampFeetAvailable(initialFeet - getActiveLockedAllocatedFeet(allocations), initialFeet),
      lastRollWeightLbs: nextValues.lastRollWeightLbs
    };
  }

  const activeAllocatedFeet = getActiveLockedAllocatedFeet(allocations);
  const fallbackCurrentFeet = getCurrentFeetEditFallback(currentBox, nextValues, allocations);
  const manuallyEditedBothRollTrackingFields =
    currentFeetOnRollManuallyEdited && lastRollWeightLbsManuallyEdited;

  if (manuallyEditedBothRollTrackingFields && currentFeetInput !== null) {
    return {
      initialFeet: nextValues.initialFeet,
      currentFeetOnRoll: currentFeetInput,
      feetAvailable: clampFeetAvailable(currentFeetInput - activeAllocatedFeet, nextValues.initialFeet),
      lastRollWeightLbs: nextValues.lastRollWeightLbs
    };
  }

  if (lastRollWeightLbsManuallyEdited && hasStoredRollWeightMetadata(nextValues)) {
    const currentFeetOnRoll = clampFeetAvailable(
      deriveFeetAvailableFromRollWeight(
        nextValues.lastRollWeightLbs!,
        nextValues.coreWeightLbs!,
        nextValues.lfWeightLbsPerFt!,
        nextValues.initialFeet
      ),
      nextValues.initialFeet
    );

    return {
      initialFeet: nextValues.initialFeet,
      currentFeetOnRoll,
      feetAvailable: clampFeetAvailable(currentFeetOnRoll - activeAllocatedFeet, nextValues.initialFeet),
      lastRollWeightLbs: nextValues.lastRollWeightLbs
    };
  }

  if (currentFeetOnRollManuallyEdited && currentFeetInput !== null) {
    return {
      initialFeet: nextValues.initialFeet,
      currentFeetOnRoll: currentFeetInput,
      feetAvailable: clampFeetAvailable(currentFeetInput - activeAllocatedFeet, nextValues.initialFeet),
      lastRollWeightLbs: canDeriveRollWeightFromCurrentFeet(nextValues)
        ? deriveLastRollWeightLbsFromCurrentFeet(
            currentFeetInput,
            nextValues.coreWeightLbs!,
            nextValues.lfWeightLbsPerFt!
          )
        : nextValues.lastRollWeightLbs
    };
  }

  return {
    initialFeet: nextValues.initialFeet,
    currentFeetOnRoll: fallbackCurrentFeet,
    feetAvailable: clampFeetAvailable(fallbackCurrentFeet - activeAllocatedFeet, nextValues.initialFeet),
    lastRollWeightLbs: nextValues.lastRollWeightLbs
  };
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
