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
