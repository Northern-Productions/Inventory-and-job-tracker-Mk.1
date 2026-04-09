import type { BoxStatus } from '../../../../domain';
import { todayDateString } from '../../../../lib/date';

export function deriveCreateFeetAvailable(
  initialFeet: number,
  receivedDate: string,
  today = todayDateString()
): number {
  return receivedDate && receivedDate <= today ? initialFeet : 0;
}

export function deriveLifecycleStatus(
  receivedDate: string,
  today = todayDateString()
): Extract<BoxStatus, 'ORDERED' | 'IN_STOCK'> {
  return receivedDate && receivedDate <= today ? 'IN_STOCK' : 'ORDERED';
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
