import { buildFilmOrdersList } from './filmOrders.mjs';
import { buildJobsList } from './jobs.mjs';
import { listAccessRequests } from './access.mjs';

function canReadFeature(authContext, feature) {
  if (authContext?.role === 'owner') {
    return true;
  }

  return Boolean(authContext?.permissions?.[feature]?.read);
}

function isFilmOrderNeedingAttention(order) {
  const normalizedStatus = String(order?.status || '').trim().toUpperCase();
  if (normalizedStatus !== 'FILM_ORDER' && normalizedStatus !== 'FILM_ON_THE_WAY') {
    return false;
  }

  return Boolean(String(order?.jobDate || '').trim());
}

export async function buildAppAttentionSummary(client, orgId, authContext) {
  const canReadJobs = canReadFeature(authContext, 'jobs') || canReadFeature(authContext, 'allocations');
  const canReadFilmOrders = canReadFeature(authContext, 'film_orders');
  const canReviewAccessRequests = authContext?.role === 'owner';
  const jobs = canReadJobs ? await buildJobsList(client, orgId, 0, 'ACTIVE') : [];
  // Shared pg clients are request-scoped and must not fan out concurrent queries.
  const filmOrders = canReadFilmOrders ? await buildFilmOrdersList(client, orgId) : [];
  const accessRequests = canReviewAccessRequests ? await listAccessRequests(client, orgId, 'pending') : [];

  return {
    hasJobsNeedingAllocation: jobs.some(
      (entry) =>
        entry.lifecycleStatus === 'ACTIVE' &&
        (Number(entry.remainingFeet || 0) > 0 || Number(entry.remainingTubes || 0) > 0)
    ),
    hasFilmOrdersNeedingAttention: filmOrders.some((entry) => isFilmOrderNeedingAttention(entry)),
    pendingAccessRequests: accessRequests.length > 0
  };
}
