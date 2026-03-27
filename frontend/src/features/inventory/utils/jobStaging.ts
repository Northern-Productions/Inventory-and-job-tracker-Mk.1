import type { JobDetail } from '../../../domain';

type StagingDetail = Pick<
  JobDetail,
  'summary' | 'requirements' | 'allocations' | 'caulkRequirements' | 'caulkAllocations' | 'filmOrders'
>;

export function getJobStagingBlockingMessage(detail: StagingDetail | null | undefined) {
  const summary = detail?.summary;
  if (!summary || summary.lifecycleStatus !== 'ACTIVE') {
    return '';
  }

  const requirements = detail?.requirements || [];
  const caulkRequirements = detail?.caulkRequirements || [];
  const hasMaterialRequirements =
    requirements.some((entry) => entry.requiredFeet > 0) ||
    caulkRequirements.some((entry) => entry.requiredTubes > 0);
  if (!hasMaterialRequirements) {
    return '';
  }

  const hasOpenFilmOrders = (detail?.filmOrders || []).some((entry) =>
    entry.status === 'FILM_ORDER' || entry.status === 'FILM_ON_THE_WAY'
  );
  if (hasOpenFilmOrders) {
    return 'Resolve open film orders before staging this job.';
  }

  const hasRemainingFilm = requirements.some((entry) => entry.remainingFeet > 0);
  const hasRemainingCaulk = caulkRequirements.some((entry) => entry.remainingTubes > 0);
  if (hasRemainingFilm || hasRemainingCaulk) {
    return 'Allocate all required film and caulk before staging this job.';
  }

  const hasUncheckedOutFilm = (detail?.allocations || []).some(
    (entry) =>
      entry.status === 'ACTIVE' &&
      entry.allocationKind !== 'EXTRA' &&
      entry.allocatedFeet > 0
  );
  if (hasUncheckedOutFilm) {
    return 'Check out the allocated film before staging this job.';
  }

  const hasUncheckedOutCaulk = (detail?.caulkAllocations || []).some(
    (entry) =>
      entry.status === 'ACTIVE' &&
      entry.allocatedTubes > 0 &&
      entry.reservedTubesRemaining > 0
  );
  if (hasUncheckedOutCaulk) {
    return 'Check out the allocated caulk before staging this job.';
  }

  return '';
}

export function canMarkJobStagedForPickup(detail: StagingDetail | null | undefined) {
  return !getJobStagingBlockingMessage(detail);
}
