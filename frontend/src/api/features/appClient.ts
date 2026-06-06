import type { AppAttentionSummary, AppAttentionSummaryResponse } from '../../domain';
import { requestReadWithFallback } from './sharedClient';

function normalizeAppAttentionSummary(
  value: AppAttentionSummaryResponse | null | undefined
): AppAttentionSummary {
  return {
    hasJobsNeedingAllocation: Boolean(value?.hasJobsNeedingAllocation),
    hasFilmOrdersNeedingAttention: Boolean(value?.hasFilmOrdersNeedingAttention),
    hasFilmWeightPendingReviews: Boolean(value?.hasFilmWeightPendingReviews),
    filmWeightPendingReviewCount: Math.max(
      0,
      Math.trunc(Number(value?.filmWeightPendingReviewCount || 0) || 0)
    ),
    pendingAccessRequests: Boolean(value?.pendingAccessRequests)
  };
}

export async function getAppAttentionSummary(): Promise<AppAttentionSummary> {
  const data = await requestReadWithFallback<AppAttentionSummaryResponse>(
    '/app/attention-summary',
    {},
    {}
  );
  return normalizeAppAttentionSummary(data);
}
