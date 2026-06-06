import { buildFilmOrdersList } from './filmOrders.mjs';
import { buildJobsList } from './jobs.mjs';
import { listAccessRequests } from './access.mjs';
import { countOpenFilmWeightPendingReviews } from './filmWeightProfiles.mjs';
import { isFilmOrderNeedingAttention } from './runtime/runtimeFilmOrderSchedule.mjs';

function canReadFeature(authContext, feature) {
  if (authContext?.role === 'owner') {
    return true;
  }

  return Boolean(authContext?.permissions?.[feature]?.read);
}

export function isJobNeedingAllocationAttention(entry) {
  const status = String(entry?.status || '').trim().toUpperCase();
  return Boolean(
    entry?.lifecycleStatus === 'ACTIVE' &&
    String(entry?.installDate || '').trim() &&
    (status === 'FILM_ORDER' || status === 'ORDERED') &&
    (Number(entry?.remainingFeet || 0) > 0 || Number(entry?.remainingTubes || 0) > 0)
  );
}

export async function buildAppAttentionSummary(client, orgId, authContext) {
  const canReadJobs = canReadFeature(authContext, 'jobs') || canReadFeature(authContext, 'allocations');
  const canReadFilmOrders = canReadFeature(authContext, 'film_orders');
  const canReadInventory = canReadFeature(authContext, 'inventory');
  const canReviewAccessRequests = authContext?.role === 'owner';
  const jobs = canReadJobs ? await buildJobsList(client, orgId, 0, 'ACTIVE') : [];
  // Shared pg clients are request-scoped and must not fan out concurrent queries.
  const filmOrders = canReadFilmOrders ? await buildFilmOrdersList(client, orgId) : [];
  const openFilmWeightPendingReviews = canReadInventory
    ? await countOpenFilmWeightPendingReviews(client, orgId)
    : 0;
  const accessRequests = canReviewAccessRequests ? await listAccessRequests(client, orgId, 'pending') : [];

  return {
    hasJobsNeedingAllocation: jobs.some((entry) => isJobNeedingAllocationAttention(entry)),
    hasFilmOrdersNeedingAttention: filmOrders.some((entry) => isFilmOrderNeedingAttention(entry)),
    hasFilmWeightPendingReviews: openFilmWeightPendingReviews > 0,
    filmWeightPendingReviewCount: openFilmWeightPendingReviews,
    pendingAccessRequests: accessRequests.length > 0
  };
}
