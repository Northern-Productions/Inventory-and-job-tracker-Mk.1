import type { AuthIdentity } from "../types.ts";

function canReadFeature(identity: AuthIdentity, feature: string) {
  if (identity.role === "owner") {
    return true;
  }

  return Boolean(identity.permissions?.[feature]?.read);
}

function isFilmOrderNeedingAttention(order: Record<string, unknown>) {
  const normalizedStatus = String(order.status || "").trim().toUpperCase();
  if (normalizedStatus !== "FILM_ORDER" && normalizedStatus !== "FILM_ON_THE_WAY") {
    return false;
  }

  return Boolean(String(order.jobDate || "").trim());
}

export async function buildAppAttentionSummary(
  client: any,
  orgId: string,
  identity: AuthIdentity,
  deps: {
    buildJobsList: (
      client: any,
      orgId: string,
      limit: number,
      lifecycleStatus?: unknown,
      jobNumbers?: unknown,
    ) => Promise<Record<string, unknown>[]>;
    buildFilmOrdersList: (client: any, orgId: string) => Promise<Record<string, unknown>[]>;
    rpcOrThrow: <T>(client: any, fn: string, params?: Record<string, unknown>) => Promise<T>;
  },
) {
  const canReadJobs = canReadFeature(identity, "jobs") || canReadFeature(identity, "allocations");
  const canReadFilmOrders = canReadFeature(identity, "film_orders");
  const canReviewAccessRequests = identity.role === "owner";

  const [jobs, filmOrders, accessRequests] = await Promise.all([
    canReadJobs ? deps.buildJobsList(client, orgId, 0, "ACTIVE") : Promise.resolve([]),
    canReadFilmOrders ? deps.buildFilmOrdersList(client, orgId) : Promise.resolve([]),
    canReviewAccessRequests
      ? deps.rpcOrThrow<Record<string, unknown>[]>(client, "api_list_access_requests", {
          p_org_id: orgId,
          p_status: "pending",
        })
      : Promise.resolve([]),
  ]);

  return {
    hasJobsNeedingAllocation: jobs.some(
      (entry) =>
        String(entry.lifecycleStatus || "").trim().toUpperCase() === "ACTIVE" &&
        (Number(entry.remainingFeet || 0) > 0 || Number(entry.remainingTubes || 0) > 0),
    ),
    hasFilmOrdersNeedingAttention: filmOrders.some((entry) => isFilmOrderNeedingAttention(entry)),
    pendingAccessRequests: accessRequests.length > 0,
  };
}
