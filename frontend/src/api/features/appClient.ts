import type { AppAttentionSummary, AppAttentionSummaryResponse } from '../../domain';
import { requestReadWithFallback } from './sharedClient';

function normalizeAppAttentionSummary(
  value: AppAttentionSummaryResponse | null | undefined
): AppAttentionSummary {
  return {
    hasJobsNeedingAllocation: Boolean(value?.hasJobsNeedingAllocation),
    hasFilmOrdersNeedingAttention: Boolean(value?.hasFilmOrdersNeedingAttention),
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
