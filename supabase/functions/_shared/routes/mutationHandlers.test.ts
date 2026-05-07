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

Deno.test("SQL-owned mutation routes skip redundant Edge planner reconciliation", async () => {
  const cases = [
    {
      route: "/jobs/update",
      payload: { jobNumber: "81234", requirements: [] },
      expectedRpc: "api_acl_jobs_update",
    },
    {
      route: "/allocations/add",
      payload: { jobNumber: "81234", boxId: "IL1-100", allocatedFeet: 10 },
      expectedRpc: "api_acl_allocations_apply",
    },
    {
      route: "/allocations/apply",
      payload: { jobNumber: "81234", boxId: "IL1-100", allocatedFeet: 10 },
      expectedRpc: "api_acl_allocations_apply",
    },
    {
      route: "/allocations/caulk/remove",
      payload: { caulkAllocationId: "CAULK-100" },
      expectedRpc: "api_acl_allocations_caulk_remove",
    },
    {
      route: "/boxes/update",
      payload: { boxId: "IL1-100" },
      expectedRpc: "api_acl_boxes_update",
    },
    {
      route: "/boxes/set-status",
      payload: { boxId: "IL1-100", status: "CHECKED_OUT", auditNote: "Checked out for job 81234." },
      expectedRpc: "api_acl_boxes_set_status",
    },
    {
      route: "/jobs/checkout-all",
      payload: { jobNumber: "81234" },
      expectedRpc: "",
    },
    {
      route: "/jobs/set-staged-pickup",
      payload: { jobNumber: "81234", isStagedForPickup: true },
      expectedRpc: "",
    },
  ];

  for (const testCase of cases) {
    const rpcCalls: string[] = [];
    let plannerCallCount = 0;
    let detailCallCount = 0;

    await dispatchMutationWithHandlers(
      {},
      { orgId: "org-1", actor: "tester", role: "owner" } as any,
      testCase.route,
      testCase.payload,
      buildDeps({
        callMutationRpc: async (_client: unknown, fn: string) => {
          rpcCalls.push(fn);
          if (fn === "api_acl_allocations_caulk_remove") {
            return {
              jobNumber: "81234",
              caulkAllocationId: "CAULK-100",
              releasedReservedTubes: 20,
              autoPlanningSuppressed: true,
              warnings: ["SQL planner completed."],
            };
          }
          if (fn.includes("boxes")) {
            return { boxId: "IL1-100", logId: "LOG-100", warnings: ["SQL planner completed."] };
          }
          if (fn.includes("allocations")) {
            return {
              allocationIds: [],
              remainingUncoveredFeet: 0,
              warnings: ["SQL planner completed."],
            };
          }
          return { jobNumber: "81234", warnings: ["SQL planner completed."] };
        },
        findBoxById: async () => ({
          id: "box-record-1",
          boxId: "IL1-100",
          status: "IN_STOCK",
          feetAvailable: 50,
          initialFeet: 50,
        }),
        toPublicBox: (box: Record<string, unknown>) => ({ boxId: box.boxId }),
        buildJobDetail: async () => {
          detailCallCount += 1;
          return { summary: { jobNumber: "81234" } };
        },
        checkoutAllJobMaterials: async () => ({ jobNumber: "81234", warnings: ["Checkout SQL planner completed."] }),
        setJobStagedPickup: async () => ({ jobNumber: "81234", warnings: ["Staged pickup completed."] }),
        reconcileAutoPlannedAllocations: async () => {
          plannerCallCount += 1;
          return {};
        },
      }),
    );

    assertEquals(
      plannerCallCount,
      0,
      `Expected ${testCase.route} to skip the redundant Edge planner pass.`,
    );
    if (testCase.expectedRpc) {
      assertEquals(
        rpcCalls,
        [testCase.expectedRpc],
        `Expected ${testCase.route} to delegate planner ownership to its SQL RPC.`,
      );
    }
    if (testCase.route.startsWith("/jobs/")) {
      assertEquals(detailCallCount, 1, `Expected ${testCase.route} to reload job detail once.`);
    }
  }
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

Deno.test("/film-orders/delete scopes Edge planner to returned film order job and preserves response", async () => {
  const rpcCalls: Array<Record<string, unknown>> = [];
  const plannerCalls: Array<Record<string, unknown>> = [];
  let jobDetailReloadCount = 0;
  let filmOrderDetailReloadCount = 0;
  let filmOrderLinkedBoxesReloadCount = 0;
  let filmOrdersListReloadCount = 0;
  const deletedFilmOrder = {
    filmOrderId: "FO-100",
    jobNumber: "81234",
    warehouse: "IL1",
    status: "FILM_ORDER",
    linkedBoxes: [],
  };

  const response = await dispatchMutationWithHandlers(
    {},
    { orgId: "org-1", actor: "tester", role: "owner" } as any,
    "/film-orders/delete",
    {
      filmOrderId: "FO-100",
      jobNumber: "PAYLOAD-SHOULD-NOT-BE-USED",
      reason: "Deleted from Film Orders.",
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
          filmOrder: deletedFilmOrder,
          warnings: ["Delete RPC warning."],
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
          warnings: ["Planner warning."],
        };
      },
      buildJobDetail: async () => {
        jobDetailReloadCount += 1;
        return {};
      },
      findFilmOrderById: async () => {
        filmOrderDetailReloadCount += 1;
        return null;
      },
      buildPublicFilmOrderLinkedBoxes: async () => {
        filmOrderLinkedBoxesReloadCount += 1;
        return [];
      },
      buildFilmOrdersList: async () => {
        filmOrdersListReloadCount += 1;
        return [];
      },
    }),
  );

  assertEquals(
    rpcCalls,
    [
      {
        fn: "api_acl_film_orders_delete",
        orgId: "org-1",
        actor: "tester",
        payload: {
          filmOrderId: "FO-100",
          jobNumber: "PAYLOAD-SHOULD-NOT-BE-USED",
          reason: "Deleted from Film Orders.",
        },
      },
    ],
    "Expected /film-orders/delete to call the delete RPC once.",
  );
  assertEquals(
    plannerCalls,
    [
      {
        orgId: "org-1",
        actor: "tester",
        scope: { jobNumbers: ["81234"] },
      },
    ],
    "Expected /film-orders/delete to scope planner to the returned film order job.",
  );
  assertEquals(jobDetailReloadCount, 0, "Expected no job detail reload after film order delete.");
  assertEquals(filmOrderDetailReloadCount, 0, "Expected no film order detail reload after delete.");
  assertEquals(filmOrderLinkedBoxesReloadCount, 0, "Expected no linked-box reload after delete.");
  assertEquals(filmOrdersListReloadCount, 0, "Expected no film orders list reload after delete.");
  assertEquals(
    response,
    {
      ok: true,
      data: deletedFilmOrder,
      warnings: ["Delete RPC warning.", "Planner warning."],
    },
    "Expected delete response data shape to stay unchanged and warnings to be preserved.",
  );
});

Deno.test("/film-orders/delete trims returned film order job number before scoping planner", async () => {
  const plannerCalls: Array<Record<string, unknown>> = [];

  await dispatchMutationWithHandlers(
    {},
    { orgId: "org-1", actor: "tester", role: "owner" } as any,
    "/film-orders/delete",
    {
      filmOrderId: "FO-TRIM",
      jobNumber: "PAYLOAD-SHOULD-NOT-BE-USED",
    },
    buildDeps({
      callMutationRpc: async () => ({
        filmOrder: {
          filmOrderId: "FO-TRIM",
          jobNumber: " 81234 ",
        },
        warnings: [],
      }),
      reconcileAutoPlannedAllocations: async (
        _client: unknown,
        orgId: string,
        actor: string,
        scope: Record<string, unknown>,
      ) => {
        plannerCalls.push({ orgId, actor, scope });
        return {};
      },
    }),
  );

  assertEquals(
    plannerCalls,
    [
      {
        orgId: "org-1",
        actor: "tester",
        scope: { jobNumbers: ["81234"] },
      },
    ],
    "Expected returned film order job number to be trimmed before planner scoping.",
  );
});

Deno.test("/film-orders/delete falls back to org-wide planner when returned job number is missing", async () => {
  const cases = [
    { label: "missing", filmOrder: { filmOrderId: "FO-MISSING" } },
    { label: "null", filmOrder: { filmOrderId: "FO-NULL", jobNumber: null } },
    { label: "empty string", filmOrder: { filmOrderId: "FO-EMPTY", jobNumber: "" } },
    { label: "whitespace", filmOrder: { filmOrderId: "FO-WHITESPACE", jobNumber: " " } },
    { label: "non-string", filmOrder: { filmOrderId: "FO-NONSTRING", jobNumber: 81234 } },
    { label: "null film order", filmOrder: null },
  ];

  for (const testCase of cases) {
    const plannerCalls: Array<Record<string, unknown>> = [];

    await dispatchMutationWithHandlers(
      {},
      { orgId: "org-1", actor: "tester", role: "owner" } as any,
      "/film-orders/delete",
      {
        filmOrderId: `FO-${testCase.label}`,
        jobNumber: "PAYLOAD-SHOULD-NOT-BE-USED",
      },
      buildDeps({
        callMutationRpc: async () => ({
          filmOrder: testCase.filmOrder,
          warnings: [],
        }),
        reconcileAutoPlannedAllocations: async (
          _client: unknown,
          orgId: string,
          actor: string,
          scope: Record<string, unknown>,
        ) => {
          plannerCalls.push({ orgId, actor, scope });
          return {};
        },
      }),
    );

    assertEquals(
      plannerCalls,
      [
        {
          orgId: "org-1",
          actor: "tester",
          scope: {},
        },
      ],
      `Expected ${testCase.label} returned job number to fall back to org-wide planning.`,
    );
  }
});

Deno.test("/film-orders/cancel remains org-wide planner scoped", async () => {
  const plannerCalls: Array<Record<string, unknown>> = [];

  const response = await dispatchMutationWithHandlers(
    {},
    { orgId: "org-1", actor: "tester", role: "owner" } as any,
    "/film-orders/cancel",
    {
      jobNumber: "81234",
      reason: "Cancel job film orders.",
    },
    buildDeps({
      callMutationRpc: async () => ({
        jobNumber: "81234",
        warnings: ["Cancel RPC warning."],
      }),
      reconcileAutoPlannedAllocations: async (
        _client: unknown,
        orgId: string,
        actor: string,
        scope: Record<string, unknown>,
      ) => {
        plannerCalls.push({ orgId, actor, scope });
        return {
          warnings: ["Planner warning."],
        };
      },
    }),
  );

  assertEquals(
    plannerCalls,
    [
      {
        orgId: "org-1",
        actor: "tester",
        scope: {},
      },
    ],
    "Expected /film-orders/cancel to keep org-wide planner reconciliation.",
  );
  assertEquals(
    response,
    {
      ok: true,
      data: { jobNumber: "81234" },
      warnings: ["Cancel RPC warning.", "Planner warning."],
    },
    "Expected /film-orders/cancel response shape and warnings to stay unchanged.",
  );
});

Deno.test("/jobs/complete keeps existing org-wide planner and detail reload behavior", async () => {
  const plannerCalls: Array<Record<string, unknown>> = [];
  const detailCalls: Array<Record<string, unknown>> = [];

  const response = await dispatchMutationWithHandlers(
    {},
    { orgId: "org-1", actor: "tester", role: "owner" } as any,
    "/jobs/complete",
    {
      jobNumber: "81234",
    },
    buildDeps({
      completeJob: async () => ({
        ok: true,
        data: { jobNumber: "81234", detailSource: "completeJob" },
        warnings: ["Complete warning."],
      }),
      reconcileAutoPlannedAllocations: async (
        _client: unknown,
        orgId: string,
        actor: string,
        scope: Record<string, unknown>,
      ) => {
        plannerCalls.push({ orgId, actor, scope });
        return {
          warnings: ["Planner warning."],
        };
      },
      buildJobDetail: async (_client: unknown, orgId: string, jobNumber: unknown) => {
        detailCalls.push({ orgId, jobNumber });
        return { jobNumber, detailSource: "postPlannerReload" };
      },
    }),
  );

  assertEquals(
    plannerCalls,
    [
      {
        orgId: "org-1",
        actor: "tester",
        scope: {},
      },
    ],
    "Expected /jobs/complete to remain org-wide planner scoped.",
  );
  assertEquals(
    detailCalls,
    [{ orgId: "org-1", jobNumber: "81234" }],
    "Expected /jobs/complete to keep existing post-planner job detail reload behavior.",
  );
  assertEquals(
    response,
    {
      ok: true,
      data: { jobNumber: "81234", detailSource: "postPlannerReload" },
      warnings: ["Complete warning.", "Planner warning."],
    },
    "Expected /jobs/complete response behavior to stay unchanged.",
  );
});
