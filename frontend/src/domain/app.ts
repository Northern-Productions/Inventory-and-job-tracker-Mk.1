export interface AppAttentionSummary {
  hasJobsNeedingAllocation: boolean;
  hasFilmOrdersNeedingAttention: boolean;
  hasFilmWeightPendingReviews: boolean;
  filmWeightPendingReviewCount: number;
  pendingAccessRequests: boolean;
}
