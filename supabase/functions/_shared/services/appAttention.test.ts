import { buildAppAttentionSummary } from "./appAttention.ts";

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test("buildAppAttentionSummary uses the lightweight jobs attention dependency", async () => {
  let jobAttentionCalls = 0;
  let filmOrderCalls = 0;
  let accessRequestCalls = 0;

  const summary = await buildAppAttentionSummary(
    {},
    "org-1",
    {
      role: "member",
      permissions: {
        jobs: { read: true },
        allocations: { read: false },
        film_orders: { read: false },
      },
    } as any,
    {
      hasActiveJobsNeedingAllocation: async () => {
        jobAttentionCalls += 1;
        return true;
      },
      buildFilmOrdersList: async () => {
        filmOrderCalls += 1;
        return [];
      },
      rpcOrThrow: async <T>() => {
        accessRequestCalls += 1;
        return [] as T;
      },
    },
  );

  assert(summary.hasJobsNeedingAllocation === true, "Expected jobs attention flag to come from lightweight dependency.");
  assert(jobAttentionCalls === 1, "Expected one lightweight jobs attention call.");
  assert(filmOrderCalls === 0, "Expected film orders to be skipped without film_orders read access.");
  assert(accessRequestCalls === 0, "Expected access requests to be skipped for non-owner users.");
});
