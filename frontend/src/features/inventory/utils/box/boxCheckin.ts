import type { Box, BoxCoreType, SetBoxStatusPayload } from '../../../../domain';
import {
  CORE_TYPE_OPTIONS,
  deriveCoreWeightLbs,
  deriveFeetAvailableFromRollWeight,
  deriveReceivedBoxPhysicalFeet
} from './boxRollTracking';

export interface FilmCheckinDraft {
  lastRollWeightLbs: string;
}

interface FilmCheckinValidationResult {
  lastRollWeightLbs: number;
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

export function createFilmCheckinDraft(
  _box: Pick<Box, 'lastRollWeightLbs'>
): FilmCheckinDraft {
  return {
    lastRollWeightLbs: ''
  };
}

export function buildFilmCheckinAuditNote(lastRollWeightLbs: number) {
  return `Checked in at ${lastRollWeightLbs} lbs`;
}

export function validateFilmCheckinDraft(
  _box: Pick<Box, 'boxId'>,
  draft: FilmCheckinDraft
): FilmCheckinValidationResult {
  return {
    lastRollWeightLbs: parseNonNegativeNumber(draft.lastRollWeightLbs, 'Returned Roll Weight')
  };
}

export function buildFilmCheckinPayload(
  box: Pick<Box, 'boxId'>,
  draft: FilmCheckinDraft
): SetBoxStatusPayload {
  const validated = validateFilmCheckinDraft(box, draft);
  return {
    boxId: box.boxId,
    status: 'IN_STOCK',
    lastRollWeightLbs: validated.lastRollWeightLbs,
    auditNote: buildFilmCheckinAuditNote(validated.lastRollWeightLbs)
  };
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
