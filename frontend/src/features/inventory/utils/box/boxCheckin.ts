import type { Box, BoxCoreType, SetBoxStatusPayload } from '../../../../domain';
import {
  CORE_TYPE_OPTIONS,
  canDeriveFeetFromSubmittedRollWeight,
  deriveCoreWeightLbs,
  deriveFeetAvailableFromRollWeight,
  deriveReceivedBoxPhysicalFeet
} from './boxRollTracking';

export interface FilmCheckinDraft {
  lastRollWeightLbs: string;
  currentFeetOnRoll: string;
  coreType: BoxCoreType;
}

interface FilmCheckinValidationResult {
  lastRollWeightLbs: number;
  currentFeetOnRoll?: number;
  coreType?: BoxCoreType;
}

const CORE_TYPE_OPTION_SET = new Set<string>(CORE_TYPE_OPTIONS);

function normalizeCoreTypeValue(value: string): BoxCoreType {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  return CORE_TYPE_OPTION_SET.has(trimmed) ? (trimmed as BoxCoreType) : '';
}

function parseNonNegativeNumber(value: string, fieldLabel: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldLabel} is required.`);
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${fieldLabel} must be a valid non-negative number.`);
  }

  return parsed;
}

function parseNonNegativeFeet(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Current Linear Feet is required when this box cannot derive feet from weight alone.');
  }

  if (!/^\d+$/.test(trimmed)) {
    throw new Error('Current Linear Feet must be a whole number greater than or equal to 0.');
  }

  return Number(trimmed);
}

function resolveDraftCoreType(box: Pick<Box, 'coreType'>, draft: Pick<FilmCheckinDraft, 'coreType'>): BoxCoreType {
  return normalizeCoreTypeValue(draft.coreType) || normalizeCoreTypeValue(box.coreType);
}

function resolveDerivedCoreWeight(
  box: Pick<Box, 'coreWeightLbs' | 'coreType' | 'widthIn'>,
  draft: Pick<FilmCheckinDraft, 'coreType'>
) {
  const submittedCoreType = normalizeCoreTypeValue(draft.coreType);
  if (submittedCoreType) {
    return {
      coreType: submittedCoreType,
      coreWeightLbs: deriveCoreWeightLbs(submittedCoreType, box.widthIn)
    };
  }

  const existingCoreType = normalizeCoreTypeValue(box.coreType);
  if (box.coreWeightLbs !== null) {
    return {
      coreType: existingCoreType,
      coreWeightLbs: box.coreWeightLbs
    };
  }

  if (existingCoreType) {
    return {
      coreType: existingCoreType,
      coreWeightLbs: deriveCoreWeightLbs(existingCoreType, box.widthIn)
    };
  }

  return {
    coreType: '',
    coreWeightLbs: null
  };
}

export function checkInNeedsCurrentFeet(
  box: Pick<Box, 'status' | 'receivedDate' | 'directToJobSite' | 'lastRollWeightLbs' | 'coreWeightLbs' | 'lfWeightLbsPerFt'>
) {
  return (
    (Boolean(box.receivedDate) || requiresFirstReturnCalibration(box)) &&
    !canDeriveFeetFromSubmittedRollWeight(box)
  );
}

export function requiresFirstReturnCalibration(
  box: Pick<Box, 'status' | 'receivedDate' | 'directToJobSite' | 'lastRollWeightLbs' | 'coreWeightLbs' | 'lfWeightLbsPerFt'>
) {
  return (
    box.status === 'CHECKED_OUT' &&
    box.directToJobSite === true &&
    !box.receivedDate &&
    box.lastRollWeightLbs === null &&
    !canDeriveFeetFromSubmittedRollWeight(box)
  );
}

export function checkInRequiresCoreType(
  box: Pick<Box, 'status' | 'receivedDate' | 'directToJobSite' | 'lastRollWeightLbs' | 'coreWeightLbs' | 'lfWeightLbsPerFt' | 'coreType'>,
  currentFeetOnRoll: string | null | undefined
) {
  if (!checkInNeedsCurrentFeet(box)) {
    return false;
  }

  if ((currentFeetOnRoll || '').trim() === '') {
    return false;
  }

  const parsedCurrentFeet = Number(currentFeetOnRoll);
  if (!Number.isFinite(parsedCurrentFeet) || parsedCurrentFeet <= 0) {
    return false;
  }

  return box.coreWeightLbs === null && !normalizeCoreTypeValue(box.coreType);
}

export function createFilmCheckinDraft(
  box: Pick<Box, 'lastRollWeightLbs' | 'coreType'>
): FilmCheckinDraft {
  return {
    lastRollWeightLbs:
      typeof box.lastRollWeightLbs === 'number' && Number.isFinite(box.lastRollWeightLbs)
        ? String(box.lastRollWeightLbs)
        : '',
    currentFeetOnRoll: '',
    coreType: normalizeCoreTypeValue(box.coreType)
  };
}

export function buildFilmCheckinAuditNote(lastRollWeightLbs: number, currentFeetOnRoll?: number) {
  if (typeof currentFeetOnRoll === 'number') {
    return `Checked in at ${lastRollWeightLbs} lbs with ${currentFeetOnRoll} LF remaining`;
  }

  return `Checked in at ${lastRollWeightLbs} lbs`;
}

export function validateFilmCheckinDraft(
  box: Pick<Box, 'status' | 'receivedDate' | 'directToJobSite' | 'lastRollWeightLbs' | 'coreWeightLbs' | 'lfWeightLbsPerFt' | 'coreType' | 'widthIn' | 'initialFeet'>,
  draft: FilmCheckinDraft
): FilmCheckinValidationResult {
  const lastRollWeightLbs = parseNonNegativeNumber(draft.lastRollWeightLbs, 'Last Roll Weight');
  const requiresCurrentFeet = checkInNeedsCurrentFeet(box);

  if (!requiresCurrentFeet) {
    return {
      lastRollWeightLbs
    };
  }

  const currentFeetOnRoll = parseNonNegativeFeet(draft.currentFeetOnRoll);
  if (currentFeetOnRoll > box.initialFeet) {
    throw new Error(`Current Linear Feet cannot be greater than this box's Initial Feet (${box.initialFeet}).`);
  }

  if (currentFeetOnRoll === 0) {
    if (lastRollWeightLbs > 0) {
      throw new Error('Current Linear Feet cannot be 0 while Last Roll Weight is still above 0.');
    }

    return {
      lastRollWeightLbs,
      currentFeetOnRoll
    };
  }

  const derivedCore = resolveDerivedCoreWeight(box, draft);
  if (derivedCore.coreWeightLbs === null) {
    throw new Error('Core Type is required before this return can establish future weight-based LF math.');
  }

  if (lastRollWeightLbs <= derivedCore.coreWeightLbs) {
    throw new Error('Last Roll Weight must be greater than the core weight when Current Linear Feet is above 0.');
  }

  return {
    lastRollWeightLbs,
    currentFeetOnRoll,
    coreType: derivedCore.coreType || undefined
  };
}

export function buildFilmCheckinPayload(
  box: Pick<Box, 'boxId' | 'status' | 'receivedDate' | 'directToJobSite' | 'lastRollWeightLbs' | 'coreWeightLbs' | 'lfWeightLbsPerFt' | 'coreType' | 'widthIn' | 'initialFeet'>,
  draft: FilmCheckinDraft
): SetBoxStatusPayload {
  const validated = validateFilmCheckinDraft(box, draft);
  const payload: SetBoxStatusPayload = {
    boxId: box.boxId,
    status: 'IN_STOCK',
    lastRollWeightLbs: validated.lastRollWeightLbs,
    auditNote: buildFilmCheckinAuditNote(validated.lastRollWeightLbs, validated.currentFeetOnRoll)
  };

  if (validated.currentFeetOnRoll !== undefined) {
    payload.currentFeetOnRoll = validated.currentFeetOnRoll;
  }

  const submittedCoreType = normalizeCoreTypeValue(draft.coreType);
  const existingCoreType = normalizeCoreTypeValue(box.coreType);
  if (submittedCoreType && submittedCoreType !== existingCoreType) {
    payload.coreType = submittedCoreType;
  } else if (submittedCoreType && !existingCoreType) {
    payload.coreType = submittedCoreType;
  }

  return payload;
}

export function didPersistFilmCheckinRollTracking(
  submittedPayload: Pick<SetBoxStatusPayload, 'lastRollWeightLbs' | 'currentFeetOnRoll' | 'coreType'>,
  returnedBox: Pick<Box, 'status' | 'lastRollWeightLbs' | 'feetAvailable' | 'coreWeightLbs' | 'lfWeightLbsPerFt' | 'initialFeet' | 'coreType'>
) {
  if (returnedBox.lastRollWeightLbs !== submittedPayload.lastRollWeightLbs) {
    return false;
  }

  if (typeof submittedPayload.currentFeetOnRoll === 'number') {
    if (submittedPayload.currentFeetOnRoll === 0) {
      return returnedBox.status === 'ZEROED' || returnedBox.feetAvailable === 0;
    }

    if (
      returnedBox.coreWeightLbs === null ||
      returnedBox.lfWeightLbsPerFt === null ||
      returnedBox.lfWeightLbsPerFt <= 0
    ) {
      return false;
    }

    if (submittedPayload.coreType && returnedBox.coreType !== submittedPayload.coreType) {
      return false;
    }

    return returnedBox.feetAvailable <= submittedPayload.currentFeetOnRoll;
  }

  if (
    returnedBox.coreWeightLbs !== null &&
    returnedBox.lfWeightLbsPerFt !== null &&
    returnedBox.lfWeightLbsPerFt > 0 &&
    typeof submittedPayload.lastRollWeightLbs === 'number'
  ) {
    return (
      returnedBox.feetAvailable <=
      deriveFeetAvailableFromRollWeight(
        submittedPayload.lastRollWeightLbs,
        returnedBox.coreWeightLbs,
        returnedBox.lfWeightLbsPerFt,
        returnedBox.initialFeet
      )
    );
  }

  return true;
}

export interface CheckInWarningOptions {
  currentFeetOnRoll?: number;
  coreType?: BoxCoreType;
}

export function getPhysicalFeetBeforeCheckInForWarning(
  box: Pick<Box, 'initialFeet' | 'feetAvailable' | 'lastRollWeightLbs' | 'coreWeightLbs' | 'lfWeightLbsPerFt'>
) {
  return deriveReceivedBoxPhysicalFeet({
    initialFeet: box.initialFeet,
    lastRollWeightLbs: box.lastRollWeightLbs,
    coreWeightLbs: box.coreWeightLbs,
    lfWeightLbsPerFt: box.lfWeightLbsPerFt
  });
}

export function resolveEffectiveCheckInCoreWeight(
  box: Pick<Box, 'coreWeightLbs' | 'coreType' | 'widthIn'>,
  coreTypeOverride?: BoxCoreType
) {
  const nextCoreType = normalizeCoreTypeValue(coreTypeOverride || '') || normalizeCoreTypeValue(box.coreType);
  if (!nextCoreType) {
    return null;
  }

  if (nextCoreType === normalizeCoreTypeValue(box.coreType) && box.coreWeightLbs !== null) {
    return box.coreWeightLbs;
  }

  return deriveCoreWeightLbs(nextCoreType, box.widthIn);
}
