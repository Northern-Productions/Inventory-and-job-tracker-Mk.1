import { dispatchMutationWithHandlers } from "./mutationHandlers.ts";

function assertEquals(actual: unknown, expected: unknown, message: string) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}\nExpected: ${expectedJson}\nActual: ${actualJson}`);
  }
}

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function asTrimmedString(value: unknown) {
  return String(value || "").trim();
}

function integerOrZero(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.trunc(numberValue) : 0;
}

function requireString(value: unknown, fieldName: string) {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    throw new Error(`${fieldName} is required.`);
  }
  return trimmed;
}

function buildDeps(overrides: Record<string, unknown> = {}) {
  const deps = {
    asTrimmedString,
    requireString,
    integerOrZero,
    normalizeCaulkCaseMath: () => ({}),
    canonicalizeMutationPayloadForRoute: async (
      _client: unknown,
      _orgId: string,
      _logicalPath: string,
      payload: Record<string, unknown>,
    ) => payload,
    callMutationRpc: async () => {
      throw new Error("Unexpected RPC call.");
    },
    findPendingBoxTransferByDestinationBoxId: async () => null,
    findBoxById: async () => null,
    listAllocationsByBox: async () => [],
    listJobs: async () => [],
    toPublicBox: () => ({}),
    startBoxTransfer: async () => ({}),
    receiveBoxTransfer: async () => ({}),
    cancelBoxTransfer: async () => ({}),
    ensureBoxCheckoutCrewCompatibility: async () => undefined,
    findJobByNumber: async () => null,
    normalizeJobLifecycleStatus: () => "ACTIVE",
    listAllocationsByIds: async () => [],
    toPublicAllocation: () => ({}),
    findFilmOrderById: async () => null,
    toPublicFilmOrder: () => ({}),
    buildPublicFilmOrderLinkedBoxes: async () => [],
    removeJobBoxAllocation: async () => {
      throw new Error("removeJobBoxAllocation should not be used by /allocations/remove-box.");
    },
    buildJobDetail: async () => ({}),
    setJobStagedPickup: async () => ({}),
    checkoutAllJobMaterials: async () => ({}),
    completeJob: async () => ({}),
    reopenJob: async () => ({}),
    deleteJob: async () => ({}),
    reconcileAutoPlannedAllocations: async () => ({}),
    ...overrides,
  };

  return deps as any;
}

Deno.test("/allocations/remove-box delegates to the atomic SQL RPC", async () => {
  const rpcCalls: Array<Record<string, unknown>> = [];
  let plannerCallCount = 0;
  let legacyRemoveCallCount = 0;
  const client = {
    schema() {
      throw new Error("remove-box must not perform direct table mutations.");
    },
  };

  const response = await dispatchMutationWithHandlers(
    client,
    { orgId: "org-1", actor: "tester", role: "owner" } as any,
    "/allocations/remove-box",
    {
      jobNumber: "4953",
      allocationId: "alloc-6868",
      reason: "Remove test allocation.",
    },
    buildDeps({
      callMutationRpc: async (
        _client: unknown,
        fn: string,
        orgId: string,
        actor: string,
        payload: Record<string, unknown>,
      ) => {
        rpcCalls.push({ fn, orgId, actor, payload });
        return {
          jobNumber: "4953",
          allocationId: "alloc-6868",
          boxId: "IL1-6868",
          removedAllocationCount: 1,
          releasedFeet: 60,
          warnings: ["Removed allocation alloc-6868 for box IL1-6868."],
        };
      },
      removeJobBoxAllocation: async () => {
        legacyRemoveCallCount += 1;
        throw new Error("Legacy remove path should not be called.");
      },
      reconcileAutoPlannedAllocations: async () => {
        plannerCallCount += 1;
        return {};
      },
    }),
  );

  assertEquals(
    rpcCalls,
    [
      {
        fn: "api_acl_allocations_remove_box",
        orgId: "org-1",
        actor: "tester",
        payload: {
          jobNumber: "4953",
          allocationId: "alloc-6868",
          reason: "Remove test allocation.",
        },
      },
    ],
    "Expected remove-box to call only the atomic SQL RPC.",
  );
  assertEquals(legacyRemoveCallCount, 0, "Expected legacy remove path to be bypassed.");
  assertEquals(plannerCallCount, 0, "Expected remove-box planner work to stay inside the SQL RPC.");
  assertEquals(
    response,
    {
      ok: true,
      data: {
        jobNumber: "4953",
        allocationId: "alloc-6868",
        boxId: "IL1-6868",
        removedAllocationCount: 1,
        releasedFeet: 60,
      },
      warnings: ["Removed allocation alloc-6868 for box IL1-6868."],
    },
    "Expected remove-box response to normalize the RPC result.",
  );
});

Deno.test("/allocations/remove-box validates allocation id before calling RPC", async () => {
  let rpcCallCount = 0;

  try {
    await dispatchMutationWithHandlers(
      {},
      { orgId: "org-1", actor: "tester", role: "owner" } as any,
      "/allocations/remove-box",
      {
        jobNumber: "4953",
        allocationId: "",
      },
      buildDeps({
        callMutationRpc: async () => {
          rpcCallCount += 1;
          return {};
        },
      }),
    );
  } catch (error) {
    assert(
      error instanceof Error && error.message === "AllocationID is required.",
      `Expected a clear missing AllocationID error, received ${error instanceof Error ? error.message : error}.`,
    );
    assertEquals(rpcCallCount, 0, "Expected missing allocation id to fail before RPC.");
    return;
  }

  throw new Error("Expected remove-box without allocationId to fail.");
});

Deno.test("/jobs/create delegates planner reconciliation to the SQL RPC and reloads job detail", async () => {
  const rpcCalls: Array<Record<string, unknown>> = [];
  const jobDetailCalls: Array<Record<string, unknown>> = [];
  let plannerCallCount = 0;

  const response = await dispatchMutationWithHandlers(
    {},
    { orgId: "org-1", actor: "tester", role: "owner" } as any,
    "/jobs/create",
    {
      jobNumber: "81234",
      warehouse: "IL1",
      requirements: [],
    },
    buildDeps({
      callMutationRpc: async (
        _client: unknown,
        fn: string,
        orgId: string,
        actor: string,
        payload: Record<string, unknown>,
      ) => {
        rpcCalls.push({ fn, orgId, actor, payload });
        return {
          jobNumber: "81234",
          warnings: ["SQL planner completed."],
        };
      },
      buildJobDetail: async (_client: unknown, orgId: string, jobNumber: unknown) => {
        jobDetailCalls.push({ orgId, jobNumber });
        return {
          jobNumber,
          plannerSource: "sql",
        };
      },
      reconcileAutoPlannedAllocations: async () => {
        plannerCallCount += 1;
        return {};
      },
    }),
  );

  assertEquals(
    rpcCalls,
    [
      {
        fn: "api_acl_jobs_create",
        orgId: "org-1",
        actor: "tester",
        payload: {
          jobNumber: "81234",
          warehouse: "IL1",
          requirements: [],
        },
      },
    ],
    "Expected /jobs/create to call the SQL ACL create RPC.",
  );
  assertEquals(plannerCallCount, 0, "Expected /jobs/create to skip the redundant Edge planner pass.");
  assertEquals(
    jobDetailCalls,
    [{ orgId: "org-1", jobNumber: "81234" }],
    "Expected /jobs/create to reload canonical job detail after SQL create.",
  );
  assertEquals(
    response,
    {
      ok: true,
      data: {
        jobNumber: "81234",
        plannerSource: "sql",
      },
      warnings: ["SQL planner completed."],
    },
    "Expected /jobs/create response to return reloaded job detail and SQL warnings.",
  );
});

Deno.test("planner mutation routes still run Edge planner reconciliation when SQL does not own it", async () => {
  const rpcCalls: Array<Record<string, unknown>> = [];
  const plannerCalls: Array<Record<string, unknown>> = [];

  const response = await dispatchMutationWithHandlers(
    {},
    { orgId: "org-1", actor: "tester", role: "owner" } as any,
    "/boxes/delete",
    {
      boxId: "IL1-9000",
      reason: "Wrong box.",
    },
    buildDeps({
      callMutationRpc: async (
        _client: unknown,
        fn: string,
        orgId: string,
        actor: string,
        payload: Record<string, unknown>,
      ) => {
        rpcCalls.push({ fn, orgId, actor, payload });
        return {
          boxId: "IL1-9000",
          logId: "LOG-9000",
        };
      },
      reconcileAutoPlannedAllocations: async (
        _client: unknown,
        orgId: string,
        actor: string,
        scope: Record<string, unknown>,
      ) => {
        plannerCalls.push({ orgId, actor, scope });
        return {
          warnings: ["Planner checked box scope."],
        };
      },
    }),
  );

  assertEquals(
    rpcCalls,
    [
      {
        fn: "api_acl_boxes_delete",
        orgId: "org-1",
        actor: "tester",
        payload: {
          boxId: "IL1-9000",
          reason: "Wrong box.",
        },
      },
    ],
    "Expected /boxes/delete to call its SQL RPC before Edge planner reconciliation.",
  );
  assertEquals(
    plannerCalls,
    [
      {
        orgId: "org-1",
        actor: "tester",
        scope: {
          boxIds: ["IL1-9000"],
        },
      },
    ],
    "Expected /boxes/delete to keep Edge planner reconciliation.",
  );
  assertEquals(
    response,
    {
      ok: true,
      data: {
        boxId: "IL1-9000",
        logId: "LOG-9000",
      },
      warnings: ["Planner checked box scope."],
    },
    "Expected Edge planner warnings to still append for non-SQL-owned planner routes.",
  );
});
