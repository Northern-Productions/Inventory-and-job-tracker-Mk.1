import type { AuthIdentity } from "../types.ts";

function canReadFeature(identity: AuthIdentity, feature: string) {
  if (identity.role === "owner") {
    return true;
  }

  return Boolean(identity.permissions?.[feature]?.read);
}

function isFilmOrderNeedingAttention(order: Record<string, unknown>) {
  const normalizedStatus = String(order.status || "").trim().toUpperCase();
  if (normalizedStatus !== "FILM_ORDER") {
    return false;
  }

  if (!String(order.installDate ?? order.jobDate ?? "").trim()) {
    return false;
  }

  const remainingToOrderFeet = Number(
    order.remainingToOrderFeet ?? order.remaining_to_order_feet,
  );
  return Number.isFinite(remainingToOrderFeet) ? remainingToOrderFeet > 0 : true;
}

export async function buildAppAttentionSummary(
  client: any,
  orgId: string,
  identity: AuthIdentity,
  deps: {
    hasActiveJobsNeedingAllocation: (
      client: any,
      orgId: string,
    ) => Promise<boolean>;
    buildFilmOrdersList: (client: any, orgId: string) => Promise<Record<string, unknown>[]>;
    hasFilmOrdersNeedingAttention?: (client: any, orgId: string) => Promise<boolean>;
    countOpenFilmWeightPendingReviews?: (client: any, orgId: string) => Promise<number>;
    rpcOrThrow: <T>(client: any, fn: string, params?: Record<string, unknown>) => Promise<T>;
  },
) {
  const canReadJobs = canReadFeature(identity, "jobs") || canReadFeature(identity, "allocations");
  const canReadFilmOrders = canReadFeature(identity, "film_orders");
  const canReadInventory = canReadFeature(identity, "inventory");
  const canReviewAccessRequests = identity.role === "owner";

  const [hasJobsNeedingAllocation, hasFilmOrdersNeedingAttention, pendingWeightReviews, accessRequests] = await Promise.all([
    canReadJobs ? deps.hasActiveJobsNeedingAllocation(client, orgId) : Promise.resolve(false),
    canReadFilmOrders
      ? deps.hasFilmOrdersNeedingAttention
        ? deps.hasFilmOrdersNeedingAttention(client, orgId)
        : deps.buildFilmOrdersList(client, orgId).then((orders) => orders.some((entry) => isFilmOrderNeedingAttention(entry)))
      : Promise.resolve(false),
    canReadInventory
      ? deps.countOpenFilmWeightPendingReviews
        ? deps.countOpenFilmWeightPendingReviews(client, orgId)
        : deps.rpcOrThrow<number>(client, "api_acl_get_film_weight_pending_review_count", {
            p_org_id: orgId,
          })
      : Promise.resolve(0),
    canReviewAccessRequests
      ? deps.rpcOrThrow<Record<string, unknown>[]>(client, "api_list_access_requests", {
          p_org_id: orgId,
          p_status: "pending",
        })
      : Promise.resolve([]),
  ]);

  return {
    hasJobsNeedingAllocation,
    hasFilmOrdersNeedingAttention,
    hasFilmWeightPendingReviews: Number(pendingWeightReviews || 0) > 0,
    filmWeightPendingReviewCount: Math.max(0, Number(pendingWeightReviews || 0) || 0),
    pendingAccessRequests: accessRequests.length > 0,
  };
}
