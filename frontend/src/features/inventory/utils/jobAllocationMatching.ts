import type { Box, JobRequirementLine } from '../../../domain';
import { buildJobPlanningFilmKey } from './jobPlanningFilmIdentity';

function compareDates(leftDate: string, rightDate: string) {
  if (leftDate === rightDate) {
    return 0;
  }

  return leftDate < rightDate ? -1 : 1;
}

function getStockDate(box: Pick<Box, 'receivedDate' | 'orderDate'>) {
  return box.receivedDate || box.orderDate || '9999-12-31';
}

function compareBoxesByClosestCompatibleWidth(left: Box, right: Box, minimumWidthIn: number) {
  const leftWidthDelta = left.widthIn - minimumWidthIn;
  const rightWidthDelta = right.widthIn - minimumWidthIn;
  if (leftWidthDelta !== rightWidthDelta) {
    return leftWidthDelta - rightWidthDelta;
  }

  const dateComparison = compareDates(getStockDate(left), getStockDate(right));
  if (dateComparison !== 0) {
    return dateComparison;
  }

  if (left.feetAvailable !== right.feetAvailable) {
    return right.feetAvailable - left.feetAvailable;
  }

  return left.boxId.localeCompare(right.boxId);
}

export function findMatchingBoxesForRequirement(boxes: Box[], requirement: JobRequirementLine): Box[] {
  const requiredPlanningFilmKey = buildJobPlanningFilmKey(requirement.manufacturer, requirement.filmName);
  const requiredWidth = requirement.widthIn;
  const dedupedByBoxId = new Map<string, Box>();

  for (let index = 0; index < boxes.length; index += 1) {
    const candidate = boxes[index];
    const existing = dedupedByBoxId.get(candidate.boxId);
    if (!existing || candidate.feetAvailable > existing.feetAvailable) {
      dedupedByBoxId.set(candidate.boxId, candidate);
    }
  }

  const filtered = Array.from(dedupedByBoxId.values()).filter((box) => {
    const isAllocatableStatus = box.status === 'IN_STOCK' || box.status === 'CHECKED_OUT';
    if (!isAllocatableStatus || box.feetAvailable <= 0) {
      return false;
    }

    if (box.widthIn < requiredWidth) {
      return false;
    }

    if (buildJobPlanningFilmKey(box.manufacturer, box.filmName) !== requiredPlanningFilmKey) {
      return false;
    }

    return true;
  });

  filtered.sort((left, right) => compareBoxesByClosestCompatibleWidth(left, right, requiredWidth));
  return filtered;
}
