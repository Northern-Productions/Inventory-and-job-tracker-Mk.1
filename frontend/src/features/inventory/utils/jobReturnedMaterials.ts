import type {
  AllocationJobDetailEntry,
  CaulkJobCheckoutEntry,
  JobDetail
} from '../../../domain';

type ReturnedMaterialsDetail = Pick<JobDetail, 'allocations' | 'caulkCheckouts'>;

export function getCheckedOutFilmAllocations(
  allocations: AllocationJobDetailEntry[] | undefined
) {
  return (allocations || []).filter(
    (entry) => entry.checkedOutOnThisJob && entry.boxStatus === 'CHECKED_OUT'
  );
}

export function getOpenCaulkCheckouts(
  caulkCheckouts: CaulkJobCheckoutEntry[] | undefined
) {
  return (caulkCheckouts || []).filter((entry) => entry.status === 'OPEN');
}

export function summarizeReturnedMaterials(detail: ReturnedMaterialsDetail | null | undefined) {
  const checkedOutFilmAllocations = getCheckedOutFilmAllocations(detail?.allocations);
  const openCaulkCheckouts = getOpenCaulkCheckouts(detail?.caulkCheckouts);

  return {
    checkedOutFilmAllocations,
    openCaulkCheckouts,
    checkedOutFilmCount: checkedOutFilmAllocations.length,
    openCaulkCheckoutCount: openCaulkCheckouts.length,
    hasOutstandingMaterials:
      checkedOutFilmAllocations.length > 0 || openCaulkCheckouts.length > 0
  };
}

export function getDeleteJobBlockingMessage(detail: ReturnedMaterialsDetail | null | undefined) {
  const summary = summarizeReturnedMaterials(detail);
  const { checkedOutFilmCount, openCaulkCheckoutCount } = summary;

  if (checkedOutFilmCount > 0 && openCaulkCheckoutCount > 0) {
    return `Return ${checkedOutFilmCount} checked-out box${checkedOutFilmCount === 1 ? '' : 'es'} and close ${openCaulkCheckoutCount} open caulk checkout${openCaulkCheckoutCount === 1 ? '' : 's'} before deleting this job.`;
  }

  if (checkedOutFilmCount > 0) {
    return `Return ${checkedOutFilmCount} checked-out box${checkedOutFilmCount === 1 ? '' : 'es'} before deleting this job.`;
  }

  if (openCaulkCheckoutCount > 0) {
    return `Close ${openCaulkCheckoutCount} open caulk checkout${openCaulkCheckoutCount === 1 ? '' : 's'} before deleting this job.`;
  }

  return '';
}

export function shouldPromptForCompletedJobAfterReturns({
  previousHasOutstandingMaterials,
  currentHasOutstandingMaterials,
  isLaborOnly,
  lifecycleStatus
}: {
  previousHasOutstandingMaterials: boolean;
  currentHasOutstandingMaterials: boolean;
  isLaborOnly: boolean;
  lifecycleStatus?: string;
}) {
  return (
    lifecycleStatus === 'ACTIVE' &&
    !isLaborOnly &&
    previousHasOutstandingMaterials &&
    !currentHasOutstandingMaterials
  );
}

export function deriveCaulkCheckinTotals({
  checkoutTubes,
  tubesPerCase,
  unusedLooseTubes,
  unusedCases
}: {
  checkoutTubes: number;
  tubesPerCase: number;
  unusedLooseTubes: number;
  unusedCases: number;
}) {
  const totalReturnedTubes = unusedLooseTubes + unusedCases * tubesPerCase;

  return {
    totalReturnedTubes,
    usedTubes: checkoutTubes - totalReturnedTubes
  };
}

export function getCaulkCheckinValidationError({
  checkoutTubes,
  tubesPerCase,
  unusedLooseTubes,
  unusedCases
}: {
  checkoutTubes: number;
  tubesPerCase: number;
  unusedLooseTubes: number;
  unusedCases: number;
}) {
  if (!Number.isInteger(unusedLooseTubes) || unusedLooseTubes < 0) {
    return 'Unused loose tubes must be zero or greater.';
  }

  if (!Number.isInteger(unusedCases) || unusedCases < 0) {
    return 'Unused full cases must be zero or greater.';
  }

  if (!Number.isInteger(tubesPerCase) || tubesPerCase <= 0) {
    return 'This caulk product is missing a valid tubes-per-case value.';
  }

  if (unusedLooseTubes >= tubesPerCase) {
    return `Unused loose tubes must be less than ${tubesPerCase}.`;
  }

  const { totalReturnedTubes } = deriveCaulkCheckinTotals({
    checkoutTubes,
    tubesPerCase,
    unusedLooseTubes,
    unusedCases
  });

  if (totalReturnedTubes > checkoutTubes) {
    return 'Returned caulk cannot exceed checked-out tubes.';
  }

  return '';
}
