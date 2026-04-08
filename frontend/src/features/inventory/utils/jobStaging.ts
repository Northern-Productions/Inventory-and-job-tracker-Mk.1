import type { JobDetail } from '../../../domain';

type StagingDetail = Pick<
  JobDetail,
  | 'summary'
  | 'requirements'
  | 'allocations'
  | 'caulkRequirements'
  | 'caulkAllocations'
  | 'filmOrders'
  | 'filmTransferAlerts'
>;

export function getJobStagingBlockingMessage(detail: StagingDetail | null | undefined) {
  return getJobStagingBlockingMessageWithOptions(detail);
}

export function getJobStagingBlockingMessageWithOptions(
  detail: StagingDetail | null | undefined,
  options: { allowAutoCheckout?: boolean } = {}
) {
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

  const hasRemainingFilm = requirements.some((entry) => entry.remainingFeet > 0);
  const hasRemainingCaulk = caulkRequirements.some((entry) => entry.remainingTubes > 0);
  if (hasRemainingFilm || hasRemainingCaulk) {
    return 'Allocate all required film and caulk before staging this job.';
  }

  if ((detail?.filmTransferAlerts || []).length > 0) {
    return 'Receive transferred film before staging this job.';
  }

  if (options.allowAutoCheckout) {
    return '';
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
  return !getJobStagingBlockingMessageWithOptions(detail);
}

export function canMarkJobStagedForPickupWithAutoCheckout(detail: StagingDetail | null | undefined) {
  return !getJobStagingBlockingMessageWithOptions(detail, { allowAutoCheckout: true });
}

export function isLaborOnlyJob(detail: StagingDetail | null | undefined) {
  const summary = detail?.summary;
  if (!summary || summary.lifecycleStatus !== 'ACTIVE') {
    return false;
  }

  if (summary.isLaborOnly) {
    return true;
  }

  return Number(summary.requiredFeet || 0) <= 0 && Number(summary.requiredTubes || 0) <= 0;
}
