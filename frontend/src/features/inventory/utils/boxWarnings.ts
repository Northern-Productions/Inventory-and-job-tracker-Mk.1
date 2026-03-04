import type { AddBoxPayload, Box, UpdateBoxPayload } from '../../../domain';
import { deriveFeetAvailableFromRollWeight } from './boxHelpers';

function hasEstablishedWeights(box: Box): boolean {
  return box.initialWeightLbs !== null || box.lastRollWeightLbs !== null || box.lfWeightLbsPerFt !== null;
}

function formatWarningMessage(warnings: string[]): string {
  return ['These values look unusual:', '', ...warnings.map((warning) => `- ${warning}`), '', 'Continue anyway?'].join(
    '\n'
  );
}

export function confirmWarnings(warnings: string[]): boolean {
  if (!warnings.length) {
    return true;
  }

  if (typeof globalThis.confirm === 'function') {
    return globalThis.confirm(formatWarningMessage(warnings));
  }

  return true;
}

export function getAddOrEditWarnings(
  payload: AddBoxPayload | UpdateBoxPayload,
  currentBox?: Box | null
): string[] {
  const warnings: string[] = [];
  const isReceived = Boolean(payload.receivedDate);

  if (payload.receivedDate && payload.orderDate && payload.receivedDate < payload.orderDate) {
    warnings.push('Received Date is earlier than Order Date.');
  }

  if (payload.lastWeighedDate && payload.receivedDate && payload.lastWeighedDate < payload.receivedDate) {
    warnings.push('Last Weighed Date is earlier than Received Date.');
  }

  if (payload.feetAvailable > payload.initialFeet) {
    warnings.push('Available Feet is greater than Initial Feet.');
  }

  if (isReceived && payload.feetAvailable === 0 && (payload.lastRollWeightLbs ?? null) !== null && payload.lastRollWeightLbs! > 0) {
    warnings.push('Available Feet is 0 while Last Roll Weight is still above 0.');
  }

  if (isReceived && payload.lastRollWeightLbs === 0 && payload.feetAvailable > 0) {
    warnings.push('Last Roll Weight is 0 while Available Feet is still above 0.');
  }

  if (
    currentBox &&
    hasEstablishedWeights(currentBox) &&
    currentBox.receivedDate &&
    (currentBox.manufacturer !== payload.manufacturer ||
      currentBox.filmName !== payload.filmName ||
      currentBox.widthIn !== payload.widthIn ||
      currentBox.initialFeet !== payload.initialFeet)
  ) {
    warnings.push('Film identity, width, or initial feet changed after weights were already established.');
  }

  return warnings;
}

export function getCheckoutWarnings(box: Box): string[] {
  const warnings: string[] = [];

  if (box.lastRollWeightLbs === null) {
    warnings.push('This box does not have a current Last Roll Weight saved yet.');
  }

  if (!box.lastWeighedDate) {
    warnings.push('This box does not have a Last Weighed Date saved yet.');
  }

  return warnings;
}

export function getCheckInWarnings(box: Box, nextLastRollWeightLbs: number): string[] {
  const warnings: string[] = [];
  let nextFeetAvailable = box.feetAvailable;

  if (box.lastRollWeightLbs !== null && nextLastRollWeightLbs > box.lastRollWeightLbs) {
    warnings.push('The new Last Roll Weight is greater than the box’s previous Last Roll Weight.');
  }

  if (box.initialWeightLbs !== null && nextLastRollWeightLbs > box.initialWeightLbs) {
    warnings.push('The new Last Roll Weight is greater than the box’s Initial Weight.');
  }

  if (nextLastRollWeightLbs > 0 && box.coreWeightLbs !== null && nextLastRollWeightLbs < box.coreWeightLbs) {
    warnings.push('The new Last Roll Weight is below the derived core weight.');
  }

  if (box.coreWeightLbs !== null && box.lfWeightLbsPerFt !== null && box.lfWeightLbsPerFt > 0) {
    nextFeetAvailable = deriveFeetAvailableFromRollWeight(
      nextLastRollWeightLbs,
      box.coreWeightLbs,
      box.lfWeightLbsPerFt,
      box.initialFeet
    );

    if (nextFeetAvailable > box.feetAvailable) {
      warnings.push('The recalculated Available Feet would increase compared with the current box.');
    }
  }

  if (box.receivedDate && box.feetAvailable > 0 && nextLastRollWeightLbs === 0) {
    warnings.push('This check-in will auto-move the box into zeroed out inventory.');
  }

  return warnings;
}
