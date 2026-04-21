import type { Box, JobRequirementLine } from '../../../domain';
import { isSplitCoveragePair } from '../../../domain/allocationCoverageContract.mjs';
import {
  compareJobPlanningFilmMatches,
  canJobPlanningFilmSatisfyRequirement,
  describeJobPlanningFilm,
  getJobPlanningFilmMatch
} from './jobPlanningFilmIdentity';

function getBoxPlanningFeet(box: Pick<Box, 'status' | 'initialFeet' | 'feetAvailable' | 'allocationPlanningFeet'>) {
  if (Number.isFinite(Number(box.allocationPlanningFeet))) {
    return Math.max(0, Number(box.allocationPlanningFeet || 0));
  }

  if (box.status === 'IN_STOCK' || box.status === 'TRANSFER') {
    return Math.max(0, Number(box.feetAvailable || 0));
  }

  if (box.status === 'ORDERED') {
    return Math.max(0, Number(box.initialFeet || 0));
  }

  return 0;
}

function getAllocationStatusRank(status: Box['status']) {
  if (status === 'IN_STOCK') {
    return 0;
  }

  if (status === 'TRANSFER') {
    return 1;
  }

  if (status === 'ORDERED') {
    return 2;
  }

  return 3;
}

function isTransferAllocatableForJob(box: Pick<Box, 'status'>, _jobWarehouse: string) {
  if (box.status !== 'TRANSFER') {
    return false;
  }

  return true;
}

function compareDates(leftDate: string, rightDate: string) {
  if (leftDate === rightDate) {
    return 0;
  }

  return leftDate < rightDate ? -1 : 1;
}

function getStockDate(box: Pick<Box, 'receivedDate' | 'orderDate'>) {
  return box.receivedDate || box.orderDate || '9999-12-31';
}

function compareBoxesByClosestCompatibleWidth(
  left: Box,
  right: Box,
  requirement: Pick<JobRequirementLine, 'manufacturer' | 'filmName' | 'widthIn'>
) {
  const leftStatusRank = getAllocationStatusRank(left.status);
  const rightStatusRank = getAllocationStatusRank(right.status);
  if (leftStatusRank !== rightStatusRank) {
    return leftStatusRank - rightStatusRank;
  }

  const minimumWidthIn = requirement.widthIn;
  const leftIsExactMatch = left.widthIn === minimumWidthIn;
  const rightIsExactMatch = right.widthIn === minimumWidthIn;
  if (leftIsExactMatch !== rightIsExactMatch) {
    return leftIsExactMatch ? -1 : 1;
  }

  const leftIsPreferredSplitMatch = isSplitCoveragePair(left.widthIn, minimumWidthIn);
  const rightIsPreferredSplitMatch = isSplitCoveragePair(right.widthIn, minimumWidthIn);
  if (leftIsPreferredSplitMatch !== rightIsPreferredSplitMatch) {
    return leftIsPreferredSplitMatch ? -1 : 1;
  }

  const leftWidthDelta = left.widthIn - minimumWidthIn;
  const rightWidthDelta = right.widthIn - minimumWidthIn;
  if (leftWidthDelta !== rightWidthDelta) {
    return leftWidthDelta - rightWidthDelta;
  }

  const requirementFilm = describeJobPlanningFilm(requirement.manufacturer, requirement.filmName);
  if (!requirementFilm.isExterior) {
    const leftIsExterior = describeJobPlanningFilm(left.manufacturer, left.filmName).isExterior;
    const rightIsExterior = describeJobPlanningFilm(right.manufacturer, right.filmName).isExterior;
    if (leftIsExterior !== rightIsExterior) {
      return leftIsExterior ? 1 : -1;
    }
  }

  const dateComparison = compareDates(getStockDate(left), getStockDate(right));
  if (dateComparison !== 0) {
    return dateComparison;
  }

  const leftPlanningFeet = getBoxPlanningFeet(left);
  const rightPlanningFeet = getBoxPlanningFeet(right);
  if (leftPlanningFeet !== rightPlanningFeet) {
    return rightPlanningFeet - leftPlanningFeet;
  }

  return left.boxId.localeCompare(right.boxId);
}

export function findMatchingBoxesForRequirement(
  boxes: Box[],
  requirement: JobRequirementLine,
  jobWarehouse = ''
): Box[] {
  const requiredWidth = requirement.widthIn;
  const dedupedByBoxId = new Map<string, Box>();

  for (let index = 0; index < boxes.length; index += 1) {
    const candidate = boxes[index];
    const existing = dedupedByBoxId.get(candidate.boxId);
    if (!existing || getBoxPlanningFeet(candidate) > getBoxPlanningFeet(existing)) {
      dedupedByBoxId.set(candidate.boxId, candidate);
    }
  }

  const rankedMatches = Array.from(dedupedByBoxId.values()).flatMap((box) => {
    const isAllocatableStatus =
      box.status === 'IN_STOCK' ||
      box.status === 'ORDERED' ||
      isTransferAllocatableForJob(box, jobWarehouse);
    if (!isAllocatableStatus || getBoxPlanningFeet(box) <= 0) {
      return [];
    }

    if (box.widthIn < requiredWidth) {
      return [];
    }

    const filmMatch = getJobPlanningFilmMatch(
      box.manufacturer,
      box.filmName,
      requirement.manufacturer,
      requirement.filmName
    );
    if (!filmMatch) {
      return [];
    }

    return [
      {
        box,
        filmMatch
      }
    ];
  });

  rankedMatches.sort(
    (left, right) =>
      getAllocationStatusRank(left.box.status) - getAllocationStatusRank(right.box.status) ||
      compareJobPlanningFilmMatches(left.filmMatch, right.filmMatch) ||
      compareBoxesByClosestCompatibleWidth(left.box, right.box, requirement)
  );

  return rankedMatches.map((entry) => entry.box);
}

export function findCompatibleRequirementsForBox(
  requirements: JobRequirementLine[],
  box: Pick<Box, 'manufacturer' | 'filmName' | 'widthIn'>
): JobRequirementLine[] {
  const boxWidth = Number(box.widthIn) || 0;

  return requirements.filter((requirement) => {
    if ((Number(requirement.remainingFeet) || 0) <= 0) {
      return false;
    }

    if ((Number(requirement.widthIn) || 0) > boxWidth) {
      return false;
    }

    return canJobPlanningFilmSatisfyRequirement(
      box.manufacturer,
      box.filmName,
      requirement.manufacturer,
      requirement.filmName
    );
  });
}
