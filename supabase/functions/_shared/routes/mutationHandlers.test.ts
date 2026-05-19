import { dispatchMutationWithHandlers } from "./mutationHandlers.ts";
import { resolveEdgeJobMutationTargetById } from "../jobMutationIdentity.ts";

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
    findJobById: async () => null,
    normalizeJobNumberDigits: (value: unknown) => asTrimmedString(value).replace(/[^0-9]/g, ""),
    normalizeJobLifecycleStatus: () => "ACTIVE",
    listAllocationsByIds: async () => [],
    toPublicAllocation: () => ({}),
    findFilmOrderById: async () => null,
    findPlannerSuppressionRequirementById: async () => null,
    toPublicFilmOrder: () => ({}),
    buildPublicFilmOrderLinkedBoxes: async () => [],
    removeJobBoxAllocation: async () => {
      throw new Error("removeJobBoxAllocation should not be used by /allocations/remove-box.");
    },
    buildJobDetail: async () => ({}),
    buildJobDetailById: async () => ({}),
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

Deno.test("job mutation identity resolves jobId using auth-derived org and validates jobNumber", async () => {
  const findJobCalls: Array<Record<string, unknown>> = [];
  const target = await resolveEdgeJobMutationTargetById(
    {},
    "org-from-auth",
    {
      orgId: "request-org-should-be-ignored",
      jobId: "11111111-1111-4111-8111-111111111111",
      jobNumber: "81234",
    },
    {
      normalizeJobNumberDigits: (value: unknown) => asTrimmedString(value).replace(/[^0-9]/g, ""),
      findJobById: async (_client: unknown, orgId: string, jobId: string) => {
        findJobCalls.push({ orgId, jobId });
        return {
          id: jobId,
          jobNumber: "81234",
        };
      },
    },
  );

  assertEquals(
    findJobCalls,
    [{ orgId: "org-from-auth", jobId: "11111111-1111-4111-8111-111111111111" }],
    "Expected jobId lookup to use the authenticated org id.",
  );
  assertEquals(
    { usedJobId: target.usedJobId, jobId: target.jobId, jobNumber: target.jobNumber },
    {
      usedJobId: true,
      jobId: "11111111-1111-4111-8111-111111111111",
      jobNumber: "81234",
    },
    "Expected matching jobId/jobNumber identity to resolve.",
  );
});

Deno.test("/allocations/apply canonical jobId is validated before SQL RPC and request orgId is stripped", async () => {
  const rpcPayloads: Array<Record<string, unknown>> = [];
  const findJobCalls: Array<Record<string, unknown>> = [];

  const response = await dispatchMutationWithHandlers(
    {},
    { orgId: "org-from-auth", actor: "tester", role: "owner" } as any,
    "/allocations/apply",
    {
      orgId: "request-org-ignored",
      jobId: "11111111-1111-4111-8111-111111111111",
      jobNumber: "81234",
      boxId: "IL1-100",
      requestedFeet: 10,
      requirementId: "req-1",
    },
    buildDeps({
      findJobById: async (_client: unknown, orgId: string, jobId: string) => {
        findJobCalls.push({ orgId, jobId });
        return {
          id: jobId,
          jobNumber: "81234",
          lifecycleStatus: "ACTIVE",
        };
      },
      callMutationRpc: async (
        _client: unknown,
        fn: string,
        orgId: string,
        actor: string,
        payload: Record<string, unknown>,
      ) => {
        rpcPayloads.push({ fn, orgId, actor, payload });
        return {
          allocationIds: [],
          remainingUncoveredFeet: 0,
          warnings: [],
        };
      },
    }),
  );

  assertEquals(
    findJobCalls,
    [{ orgId: "org-from-auth", jobId: "11111111-1111-4111-8111-111111111111" }],
    "Expected canonical allocation apply job lookup to use auth-derived org.",
  );
  assertEquals(
    rpcPayloads,
    [
      {
        fn: "api_acl_allocations_apply",
        orgId: "org-from-auth",
        actor: "tester",
        payload: {
          jobId: "11111111-1111-4111-8111-111111111111",
          jobNumber: "81234",
          boxId: "IL1-100",
          requestedFeet: 10,
          requirementId: "req-1",
        },
      },
    ],
    "Expected canonical jobId to be passed to SQL RPC only after validation.",
  );
  assertEquals(
    response.data,
    {
      allocations: [],
      filmOrder: null,
      remainingUncoveredFeet: 0,
    },
    "Expected allocation apply response shape to stay stable.",
  );
});

Deno.test("job mutation identity rejects mismatched jobId and jobNumber", async () => {
  try {
    await resolveEdgeJobMutationTargetById(
      {},
      "org-from-auth",
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        jobNumber: "99999",
      },
      {
        normalizeJobNumberDigits: (value: unknown) => asTrimmedString(value).replace(/[^0-9]/g, ""),
        findJobById: async (_client: unknown, _orgId: string, jobId: string) => ({
          id: jobId,
          jobNumber: "81234",
        }),
      },
    );
  } catch (error) {
    assert(error instanceof Error, "Expected mismatch to throw an Error.");
    const message = error instanceof Error ? error.message : String(error);
    assert(
      message.includes("Job identity mismatch"),
      `Expected mismatch error, received ${message}.`,
    );
    return;
  }

  throw new Error("Expected mismatched jobId/jobNumber to fail.");
});

Deno.test("/jobs/update validates jobId identity before calling the guarded job update RPC", async () => {
  const rpcCalls: Array<Record<string, unknown>> = [];
  const jobIdLookups: Array<Record<string, unknown>> = [];
  const jobDetailByIdCalls: Array<Record<string, unknown>> = [];
  let legacyDetailCallCount = 0;

  const response = await dispatchMutationWithHandlers(
    {},
    { orgId: "org-from-auth", actor: "tester", role: "owner" } as any,
    "/jobs/update",
    {
      orgId: "request-org-ignored",
      jobId: "11111111-1111-4111-8111-111111111111",
      jobNumber: "81234",
      requirements: [],
      caulkRequirements: [],
    },
    buildDeps({
      findJobById: async (_client: unknown, orgId: string, jobId: string) => {
        jobIdLookups.push({ orgId, jobId });
        return {
          id: jobId,
          jobNumber: "81234",
          lifecycleStatus: "ACTIVE",
        };
      },
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
          warnings: ["SQL update completed."],
        };
      },
      buildJobDetailById: async (_client: unknown, orgId: string, jobId: unknown) => {
        jobDetailByIdCalls.push({ orgId, jobId });
        return {
          summary: {
            jobId,
            jobNumber: "81234",
          },
        };
      },
      buildJobDetail: async () => {
        legacyDetailCallCount += 1;
        return {};
      },
    }),
  );

  assertEquals(
    jobIdLookups,
    [{ orgId: "org-from-auth", jobId: "11111111-1111-4111-8111-111111111111" }],
    "Expected update identity lookup to use the authenticated org id.",
  );
  assertEquals(
    rpcCalls,
    [
      {
        fn: "api_acl_jobs_update",
        orgId: "org-from-auth",
        actor: "tester",
        payload: {
          jobId: "11111111-1111-4111-8111-111111111111",
          jobNumber: "81234",
          requirements: [],
          caulkRequirements: [],
        },
      },
    ],
    "Expected guarded update to call the existing RPC only after identity validation.",
  );
  assertEquals(
    jobDetailByIdCalls,
    [{ orgId: "org-from-auth", jobId: "11111111-1111-4111-8111-111111111111" }],
    "Expected canonical update to reload jobId-scoped detail.",
  );
  assertEquals(legacyDetailCallCount, 0, "Expected canonical update not to reload legacy jobNumber detail.");
  assertEquals(
    response,
    {
      ok: true,
      data: {
        summary: {
          jobId: "11111111-1111-4111-8111-111111111111",
          jobNumber: "81234",
        },
      },
      warnings: ["SQL update completed."],
    },
    "Expected canonical update response to preserve the job detail envelope.",
  );
});

Deno.test("/jobs/update rejects mismatched jobId and jobNumber before RPC", async () => {
  let rpcCallCount = 0;

  try {
    await dispatchMutationWithHandlers(
      {},
      { orgId: "org-from-auth", actor: "tester", role: "owner" } as any,
      "/jobs/update",
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        jobNumber: "99999",
      },
      buildDeps({
        findJobById: async (_client: unknown, _orgId: string, jobId: string) => ({
          id: jobId,
          jobNumber: "81234",
          lifecycleStatus: "ACTIVE",
        }),
        callMutationRpc: async () => {
          rpcCallCount += 1;
          return {};
        },
      }),
    );
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("Job identity mismatch"),
      `Expected mismatch error, received ${error instanceof Error ? error.message : error}.`,
    );
    assertEquals(rpcCallCount, 0, "Expected mismatched update identity to fail before RPC.");
    return;
  }

  throw new Error("Expected /jobs/update identity mismatch to fail.");
});

Deno.test("/jobs/update preserves legacy jobNumber-only behavior", async () => {
  const rpcCalls: Array<Record<string, unknown>> = [];
  const jobDetailCalls: Array<Record<string, unknown>> = [];
  let jobIdLookupCount = 0;

  const response = await dispatchMutationWithHandlers(
    {},
    { orgId: "org-1", actor: "tester", role: "owner" } as any,
    "/jobs/update",
    {
      jobNumber: "81234",
      requirements: [],
    },
    buildDeps({
      findJobById: async () => {
        jobIdLookupCount += 1;
        return null;
      },
      findJobByNumber: async () => ({
        jobNumber: "81234",
        lifecycleStatus: "ACTIVE",
      }),
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
          warnings: [],
        };
      },
      buildJobDetail: async (_client: unknown, orgId: string, jobNumber: unknown) => {
        jobDetailCalls.push({ orgId, jobNumber });
        return {
          summary: {
            jobNumber,
          },
        };
      },
    }),
  );

  assertEquals(jobIdLookupCount, 0, "Expected legacy update not to perform jobId lookup.");
  assertEquals(
    rpcCalls,
    [
      {
        fn: "api_acl_jobs_update",
        orgId: "org-1",
        actor: "tester",
        payload: {
          jobNumber: "81234",
          requirements: [],
        },
      },
    ],
    "Expected legacy update to preserve its RPC payload.",
  );
  assertEquals(jobDetailCalls, [{ orgId: "org-1", jobNumber: "81234" }], "Expected legacy reload by jobNumber.");
  assertEquals(
    response.data,
    {
      summary: {
        jobNumber: "81234",
      },
    },
    "Expected legacy update response to remain jobNumber-scoped.",
  );
});

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

Deno.test("/allocations/remove-box validates jobId allocation ownership before RPC", async () => {
  const jobIdLookups: Array<Record<string, unknown>> = [];
  const allocationLookups: Array<Record<string, unknown>> = [];
  const rpcCalls: Array<Record<string, unknown>> = [];

  const response = await dispatchMutationWithHandlers(
    {},
    { orgId: "org-from-auth", actor: "tester", role: "owner" } as any,
    "/allocations/remove-box",
    {
      orgId: "request-org-ignored",
      jobId: "11111111-1111-4111-8111-111111111111",
      jobNumber: "4953",
      allocationId: "alloc-6868",
      reason: "Remove selected allocation.",
    },
    buildDeps({
      findJobById: async (_client: unknown, orgId: string, jobId: string) => {
        jobIdLookups.push({ orgId, jobId });
        return {
          id: jobId,
          jobNumber: "4953",
        };
      },
      listAllocationsByIds: async (_client: unknown, orgId: string, allocationIds: string[]) => {
        allocationLookups.push({ orgId, allocationIds });
        return [
          {
            allocationId: "alloc-6868",
            jobId: "11111111-1111-4111-8111-111111111111",
            jobNumber: "4953",
          },
        ];
      },
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
    }),
  );

  assertEquals(
    jobIdLookups,
    [{ orgId: "org-from-auth", jobId: "11111111-1111-4111-8111-111111111111" }],
    "Expected remove-box jobId validation to use auth-derived org.",
  );
  assertEquals(
    allocationLookups,
    [{ orgId: "org-from-auth", allocationIds: ["alloc-6868"] }],
    "Expected remove-box to load the selected allocation before RPC.",
  );
  assertEquals(
    rpcCalls,
    [
      {
        fn: "api_acl_allocations_remove_box",
        orgId: "org-from-auth",
        actor: "tester",
        payload: {
          jobId: "11111111-1111-4111-8111-111111111111",
          jobNumber: "4953",
          allocationId: "alloc-6868",
          reason: "Remove selected allocation.",
        },
      },
    ],
    "Expected remove-box to strip request orgId and call the existing RPC only after validation.",
  );
  assertEquals(
    response.data,
    {
      jobId: "11111111-1111-4111-8111-111111111111",
      jobNumber: "4953",
      allocationId: "alloc-6868",
      boxId: "IL1-6868",
      removedAllocationCount: 1,
      releasedFeet: 60,
    },
    "Expected canonical remove-box response to preserve result fields and include jobId identity.",
  );
});

Deno.test("/allocations/remove-box rejects mismatched jobId and jobNumber before RPC", async () => {
  let allocationLookupCount = 0;
  let rpcCallCount = 0;

  try {
    await dispatchMutationWithHandlers(
      {},
      { orgId: "org-from-auth", actor: "tester", role: "owner" } as any,
      "/allocations/remove-box",
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        jobNumber: "9999",
        allocationId: "alloc-6868",
      },
      buildDeps({
        findJobById: async (_client: unknown, _orgId: string, jobId: string) => ({
          id: jobId,
          jobNumber: "4953",
        }),
        listAllocationsByIds: async () => {
          allocationLookupCount += 1;
          return [];
        },
        callMutationRpc: async () => {
          rpcCallCount += 1;
          return {};
        },
      }),
    );
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("Job identity mismatch"),
      `Expected job identity mismatch, received ${error instanceof Error ? error.message : error}.`,
    );
    assertEquals(allocationLookupCount, 0, "Expected job mismatch to fail before allocation lookup.");
    assertEquals(rpcCallCount, 0, "Expected job mismatch to fail before RPC.");
    return;
  }

  throw new Error("Expected remove-box mismatched job identity to fail.");
});

Deno.test("/allocations/remove-box rejects allocation ownership mismatch before RPC", async () => {
  let rpcCallCount = 0;

  try {
    await dispatchMutationWithHandlers(
      {},
      { orgId: "org-from-auth", actor: "tester", role: "owner" } as any,
      "/allocations/remove-box",
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        jobNumber: "4953",
        allocationId: "alloc-other",
      },
      buildDeps({
        findJobById: async (_client: unknown, _orgId: string, jobId: string) => ({
          id: jobId,
          jobNumber: "4953",
        }),
        listAllocationsByIds: async () => [
          {
            allocationId: "alloc-other",
            jobId: "22222222-2222-4222-8222-222222222222",
            jobNumber: "4953",
          },
        ],
        callMutationRpc: async () => {
          rpcCallCount += 1;
          return {};
        },
      }),
    );
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("belongs to a different job"),
      `Expected allocation ownership mismatch, received ${error instanceof Error ? error.message : error}.`,
    );
    assertEquals(rpcCallCount, 0, "Expected allocation mismatch to fail before RPC.");
    return;
  }

  throw new Error("Expected remove-box allocation ownership mismatch to fail.");
});

Deno.test("/jobs/create delegates planner reconciliation to the SQL RPC and reloads job detail by jobId", async () => {
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
          jobId: "11111111-1111-4111-8111-111111111111",
          jobNumber: "81234",
          warnings: ["SQL planner completed."],
        };
      },
      buildJobDetailById: async (_client: unknown, orgId: string, jobId: unknown) => {
        jobDetailCalls.push({ orgId, jobId });
        return {
          jobId,
          jobNumber: "81234",
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
    [{ orgId: "org-1", jobId: "11111111-1111-4111-8111-111111111111" }],
    "Expected /jobs/create to reload canonical job detail by jobId after SQL create.",
  );
  assertEquals(
    response,
    {
      ok: true,
      data: {
        jobId: "11111111-1111-4111-8111-111111111111",
        jobNumber: "81234",
        plannerSource: "sql",
      },
      warnings: ["SQL planner completed."],
    },
    "Expected /jobs/create response to return reloaded job detail and SQL warnings.",
  );
});

Deno.test("/jobs/create rejects exact Work Scope duplicate job numbers before the SQL create RPC", async () => {
  let rpcCallCount = 0;
  let detailCallCount = 0;

  try {
    await dispatchMutationWithHandlers(
      {},
      { orgId: "org-1", actor: "tester", role: "owner" } as any,
      "/jobs/create",
      {
        jobNumber: "81234",
        warehouse: "IL1",
        workScope: "Sections 4, 5",
        requirements: [],
      },
      buildDeps({
        listJobs: async (_client: unknown, orgId: string) => [
          {
            orgId,
            jobNumber: "81234",
            workScope: "Sections 4, 5",
            sections: "Sections 4, 5",
            lifecycleStatus: "COMPLETED",
          },
        ],
        callMutationRpc: async () => {
          rpcCallCount += 1;
          return {};
        },
        buildJobDetail: async () => {
          detailCallCount += 1;
          return {};
        },
      }),
    );
  } catch (error) {
    assert(
      error instanceof Error && error.message === "Job 81234 already exists.",
      `Expected duplicate create to fail clearly, received ${error instanceof Error ? error.message : error}.`,
    );
    assertEquals(
      {
        exists: (error as any).details?.exists,
        allowed: (error as any).details?.allowed,
        reason: (error as any).details?.reason,
        workScopeKey: (error as any).details?.workScopeKey,
      },
      {
        exists: true,
        allowed: false,
        reason: "SAME_JOB_SCOPE_COMPLETED",
        workScopeKey: "section:4,5",
      },
      "Expected duplicate create conflict to include work-scope diagnostics.",
    );
    assertEquals(rpcCallCount, 0, "Expected duplicate create to stop before the SQL create RPC.");
    assertEquals(detailCallCount, 0, "Expected duplicate create to skip job detail reload.");
    return;
  }

  throw new Error("Expected duplicate /jobs/create to fail.");
});

Deno.test("/jobs/create allows same job number when Work Scope differs", async () => {
  const rpcCalls: Array<Record<string, unknown>> = [];
  const response = await dispatchMutationWithHandlers(
    {},
    { orgId: "org-1", actor: "tester", role: "owner" } as any,
    "/jobs/create",
    {
      jobNumber: "81234",
      warehouse: "IL1",
      workScope: "Penthouse",
      requirements: [],
    },
    buildDeps({
      listJobs: async (_client: unknown, orgId: string) => [
        {
          orgId,
          jobNumber: "81234",
          workScope: "Lobby",
          sections: "Lobby",
          workScopeKey: "text:lobby",
          lifecycleStatus: "ACTIVE",
        },
      ],
      callMutationRpc: async (
        _client: unknown,
        fn: string,
        orgId: string,
        actor: string,
        payload: Record<string, unknown>,
      ) => {
        rpcCalls.push({ fn, orgId, actor, payload });
        return {
          jobId: "22222222-2222-4222-8222-222222222222",
          jobNumber: "81234",
          warnings: [],
        };
      },
      buildJobDetailById: async (_client: unknown, orgId: string, jobId: unknown) => ({
        orgId,
        jobId,
        jobNumber: "81234",
      }),
    }),
  );

  assertEquals(rpcCalls.length, 1, "Expected different-scope duplicate job number to call the SQL create RPC.");
  assertEquals(
    response.data,
    {
      orgId: "org-1",
      jobId: "22222222-2222-4222-8222-222222222222",
      jobNumber: "81234",
    },
    "Expected different-scope create to reload by returned jobId.",
  );
});

Deno.test("/jobs/reopen reloads jobId-scoped detail when canonical identity is present", async () => {
  const jobDetailByIdCalls: Array<Record<string, unknown>> = [];
  const plannerCalls: Array<Record<string, unknown>> = [];
  let legacyDetailCallCount = 0;

  const response = await dispatchMutationWithHandlers(
    {},
    { orgId: "org-1", actor: "tester", role: "owner" } as any,
    "/jobs/reopen",
    {
      jobId: "11111111-1111-4111-8111-111111111111",
      jobNumber: "81234",
      reason: "Reopen selected job.",
    },
    buildDeps({
      reopenJob: async () => ({
        ok: true,
        data: {
          summary: {
            jobId: "11111111-1111-4111-8111-111111111111",
            jobNumber: "81234",
          },
        },
        warnings: ["Reopened job 81234."],
      }),
      buildJobDetail: async () => {
        legacyDetailCallCount += 1;
        return {};
      },
      buildJobDetailById: async (_client: unknown, orgId: string, jobId: unknown) => {
        jobDetailByIdCalls.push({ orgId, jobId });
        return {
          summary: {
            jobId,
            jobNumber: "81234",
          },
          source: "by-id",
        };
      },
      reconcileAutoPlannedAllocations: async (
        _client: unknown,
        orgId: string,
        actor: string,
        scope: Record<string, unknown>,
      ) => {
        plannerCalls.push({ orgId, actor, scope });
        return { warnings: ["Planner warning."] };
      },
    }),
  );

  assertEquals(
    jobDetailByIdCalls,
    [{ orgId: "org-1", jobId: "11111111-1111-4111-8111-111111111111" }],
    "Expected canonical reopen to reload detail by jobId.",
  );
  assertEquals(legacyDetailCallCount, 0, "Expected canonical reopen not to reload detail by jobNumber.");
  assertEquals(
    plannerCalls,
    [
      {
        orgId: "org-1",
        actor: "tester",
        scope: {
          jobNumbers: ["81234"],
          jobIds: ["11111111-1111-4111-8111-111111111111"],
        },
      },
    ],
    "Expected canonical reopen to preserve jobId as shadow planner metadata while keeping jobNumber scope.",
  );
  assertEquals(
    response,
    {
      ok: true,
      data: {
        summary: {
          jobId: "11111111-1111-4111-8111-111111111111",
          jobNumber: "81234",
        },
        source: "by-id",
      },
      warnings: ["Reopened job 81234.", "Planner warning."],
    },
    "Expected canonical reopen response to keep warnings and return jobId-scoped detail.",
  );
});

Deno.test("/jobs/reopen keeps legacy detail reload when payload has no jobId", async () => {
  const legacyDetailCalls: Array<Record<string, unknown>> = [];
  const plannerCalls: Array<Record<string, unknown>> = [];
  let jobDetailByIdCallCount = 0;

  const response = await dispatchMutationWithHandlers(
    {},
    { orgId: "org-1", actor: "tester", role: "owner" } as any,
    "/jobs/reopen",
    {
      jobNumber: "81234",
      reason: "Legacy reopen.",
    },
    buildDeps({
      reopenJob: async () => ({
        ok: true,
        data: {
          summary: {
            jobId: "11111111-1111-4111-8111-111111111111",
            jobNumber: "81234",
          },
        },
      }),
      buildJobDetail: async (_client: unknown, orgId: string, jobNumber: unknown) => {
        legacyDetailCalls.push({ orgId, jobNumber });
        return {
          summary: {
            jobNumber,
          },
          source: "legacy",
        };
      },
      buildJobDetailById: async () => {
        jobDetailByIdCallCount += 1;
        return {};
      },
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
    legacyDetailCalls,
    [{ orgId: "org-1", jobNumber: "81234" }],
    "Expected legacy reopen to continue reloading detail by jobNumber.",
  );
  assertEquals(jobDetailByIdCallCount, 0, "Expected legacy reopen not to infer jobId from response detail.");
  assertEquals(
    plannerCalls,
    [
      {
        orgId: "org-1",
        actor: "tester",
        scope: {
          jobNumbers: ["81234"],
        },
      },
    ],
    "Expected legacy reopen to remain jobNumber-only in planner scope.",
  );
  assertEquals(
    response.data,
    {
      summary: {
        jobNumber: "81234",
      },
      source: "legacy",
    },
    "Expected legacy reopen response to remain jobNumber-scoped.",
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
      route: "/allocations/caulk/add",
      payload: {
        jobNumber: "81234",
        productId: "product-1",
        warehouse: "IL1",
        allocatedTubes: 3,
      },
      expectedRpc: "api_acl_allocations_caulk_add",
    },
    {
      route: "/allocations/caulk/remove",
      payload: { caulkAllocationId: "CAULK-100" },
      expectedRpc: "api_acl_allocations_caulk_remove",
    },
    {
      route: "/allocations/caulk/checkout",
      payload: { caulkAllocationId: "CAULK-100", checkoutTubes: 3 },
      expectedRpc: "api_acl_allocations_caulk_checkout",
    },
    {
      route: "/allocations/caulk/checkin",
      payload: { caulkCheckoutId: "CHK-100", unusedLooseTubes: 1, unusedCases: 0 },
      expectedRpc: "api_acl_allocations_caulk_checkin",
    },
    {
      route: "/caulk/transfers/receive",
      payload: { transferId: "TR-100" },
      expectedRpc: "api_acl_caulk_transfer_receive",
    },
    {
      route: "/caulk/transfers/cancel",
      payload: { transferId: "TR-100", reason: "No longer needed." },
      expectedRpc: "api_acl_caulk_transfer_cancel",
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
          if (fn === "api_acl_allocations_caulk_checkout" || fn === "api_acl_allocations_caulk_checkin") {
            return {
              jobId: "11111111-1111-4111-8111-111111111111",
              jobNumber: "81234",
              caulkAllocationId: "CAULK-100",
              caulkCheckoutId: "CHK-100",
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

Deno.test("/jobs/checkout-all reloads canonical job detail by jobId and keeps SQL planner ownership", async () => {
  const checkoutPayloads: Array<Record<string, unknown>> = [];
  const jobDetailByIdCalls: Array<Record<string, unknown>> = [];
  let legacyDetailCallCount = 0;
  let plannerCallCount = 0;

  const response = await dispatchMutationWithHandlers(
    {},
    { orgId: "org-from-auth", actor: "tester", role: "owner" } as any,
    "/jobs/checkout-all",
    {
      jobId: "11111111-1111-4111-8111-111111111111",
      jobNumber: "81234",
    },
    buildDeps({
      checkoutAllJobMaterials: async (_client: unknown, identity: Record<string, unknown>, payload: Record<string, unknown>) => {
        checkoutPayloads.push({ orgId: identity.orgId, ...payload });
        return {
          jobId: "11111111-1111-4111-8111-111111111111",
          jobNumber: "81234",
          warnings: ["Checkout SQL planner completed."],
        };
      },
      buildJobDetailById: async (_client: unknown, orgId: string, jobId: string) => {
        jobDetailByIdCalls.push({ orgId, jobId });
        return {
          summary: {
            jobId,
            jobNumber: "81234",
          },
        };
      },
      buildJobDetail: async () => {
        legacyDetailCallCount += 1;
        return {};
      },
      reconcileAutoPlannedAllocations: async () => {
        plannerCallCount += 1;
        return {};
      },
    }),
  );

  assertEquals(
    checkoutPayloads,
    [{
      orgId: "org-from-auth",
      jobId: "11111111-1111-4111-8111-111111111111",
      jobNumber: "81234",
    }],
    "Expected checkout-all to receive canonical payload with auth-derived org context.",
  );
  assertEquals(
    jobDetailByIdCalls,
    [{ orgId: "org-from-auth", jobId: "11111111-1111-4111-8111-111111111111" }],
    "Expected canonical checkout-all to reload detail by jobId.",
  );
  assertEquals(legacyDetailCallCount, 0, "Expected canonical checkout-all to avoid legacy jobNumber reload.");
  assertEquals(plannerCallCount, 0, "Expected checkout-all to keep planner ownership in SQL subflows.");
  assertEquals(
    response,
    {
      ok: true,
      data: {
        summary: {
          jobId: "11111111-1111-4111-8111-111111111111",
          jobNumber: "81234",
        },
      },
      warnings: ["Checkout SQL planner completed."],
    },
    "Expected canonical checkout-all response to preserve job detail and warnings.",
  );
});

Deno.test("/jobs/set-staged-pickup reloads canonical job detail by jobId and keeps SQL planner ownership", async () => {
  const stagedPayloads: Array<Record<string, unknown>> = [];
  const jobDetailByIdCalls: Array<Record<string, unknown>> = [];
  let legacyDetailCallCount = 0;
  let plannerCallCount = 0;

  const response = await dispatchMutationWithHandlers(
    {},
    { orgId: "org-from-auth", actor: "tester", role: "owner" } as any,
    "/jobs/set-staged-pickup",
    {
      jobId: "11111111-1111-4111-8111-111111111111",
      jobNumber: "81234",
      isStagedForPickup: true,
      autoCheckoutRemaining: true,
    },
    buildDeps({
      setJobStagedPickup: async (_client: unknown, identity: Record<string, unknown>, payload: Record<string, unknown>) => {
        stagedPayloads.push({ orgId: identity.orgId, ...payload });
        return {
          jobId: "11111111-1111-4111-8111-111111111111",
          jobNumber: "81234",
          warnings: ["Staged pickup completed."],
        };
      },
      buildJobDetailById: async (_client: unknown, orgId: string, jobId: string) => {
        jobDetailByIdCalls.push({ orgId, jobId });
        return {
          summary: {
            jobId,
            jobNumber: "81234",
            isStagedForPickup: true,
          },
        };
      },
      buildJobDetail: async () => {
        legacyDetailCallCount += 1;
        return {};
      },
      reconcileAutoPlannedAllocations: async () => {
        plannerCallCount += 1;
        return {};
      },
    }),
  );

  assertEquals(
    stagedPayloads,
    [{
      orgId: "org-from-auth",
      jobId: "11111111-1111-4111-8111-111111111111",
      jobNumber: "81234",
      isStagedForPickup: true,
      autoCheckoutRemaining: true,
    }],
    "Expected staged pickup to receive canonical payload with auth-derived org context.",
  );
  assertEquals(
    jobDetailByIdCalls,
    [{ orgId: "org-from-auth", jobId: "11111111-1111-4111-8111-111111111111" }],
    "Expected canonical staged pickup to reload detail by jobId.",
  );
  assertEquals(legacyDetailCallCount, 0, "Expected canonical staged pickup to avoid legacy jobNumber reload.");
  assertEquals(plannerCallCount, 0, "Expected staged pickup to keep planner ownership in SQL/subflows.");
  assertEquals(
    response,
    {
      ok: true,
      data: {
        summary: {
          jobId: "11111111-1111-4111-8111-111111111111",
          jobNumber: "81234",
          isStagedForPickup: true,
        },
      },
      warnings: ["Staged pickup completed."],
    },
    "Expected canonical staged pickup response to preserve job detail and warnings.",
  );
});

Deno.test("caulk add canonical jobId is validated before SQL RPC and request orgId is stripped", async () => {
  const rpcPayloads: Array<Record<string, unknown>> = [];
  const findJobCalls: Array<Record<string, unknown>> = [];
  let plannerCallCount = 0;

  await dispatchMutationWithHandlers(
    {},
    { orgId: "org-from-auth", actor: "tester", role: "owner" } as any,
    "/allocations/caulk/add",
    {
      orgId: "request-org-ignored",
      jobId: "11111111-1111-4111-8111-111111111111",
      jobNumber: "81234",
      requirementId: "req-caulk-1",
      productId: "product-1",
      warehouse: "IL1",
      transferFromWarehouse: "MS1",
      allocatedTubes: 3,
      notes: "Canonical add.",
    },
    buildDeps({
      findJobById: async (_client: unknown, orgId: string, jobId: string) => {
        findJobCalls.push({ orgId, jobId });
        return {
          id: jobId,
          jobNumber: "81234",
          lifecycleStatus: "ACTIVE",
        };
      },
      callMutationRpc: async (
        _client: unknown,
        fn: string,
        orgId: string,
        actor: string,
        payload: Record<string, unknown>,
      ) => {
        rpcPayloads.push({ fn, orgId, actor, payload });
        return {
          jobId: "11111111-1111-4111-8111-111111111111",
          jobNumber: "81234",
          caulkAllocationId: "CAULK-100",
          warnings: [],
        };
      },
      reconcileAutoPlannedAllocations: async () => {
        plannerCallCount += 1;
        return {};
      },
    }),
  );

  assertEquals(
    findJobCalls,
    [{ orgId: "org-from-auth", jobId: "11111111-1111-4111-8111-111111111111" }],
    "Expected canonical caulk add job lookup to use auth-derived org.",
  );
  assertEquals(
    rpcPayloads,
    [
      {
        fn: "api_acl_allocations_caulk_add",
        orgId: "org-from-auth",
        actor: "tester",
        payload: {
          jobId: "11111111-1111-4111-8111-111111111111",
          jobNumber: "81234",
          requirementId: "req-caulk-1",
          productId: "product-1",
          warehouse: "IL1",
          transferFromWarehouse: "MS1",
          allocatedTubes: 3,
          notes: "Canonical add.",
        },
      },
    ],
    "Expected canonical caulk add payload to be stripped and validated before SQL RPC.",
  );
  assertEquals(plannerCallCount, 0, "Expected caulk add to leave planner ownership with SQL.");
});

Deno.test("legacy caulk add keeps payload compatible while stripping request orgId", async () => {
  const rpcPayloads: Array<Record<string, unknown>> = [];

  await dispatchMutationWithHandlers(
    {},
    { orgId: "org-from-auth", actor: "tester", role: "owner" } as any,
    "/allocations/caulk/add",
    {
      orgId: "request-org-ignored",
      jobNumber: "81234",
      productId: "product-1",
      warehouse: "IL1",
      allocatedTubes: 3,
    },
    buildDeps({
      callMutationRpc: async (
        _client: unknown,
        fn: string,
        orgId: string,
        actor: string,
        payload: Record<string, unknown>,
      ) => {
        rpcPayloads.push({ fn, orgId, actor, payload });
        return {
          jobNumber: "81234",
          caulkAllocationId: "CAULK-100",
          warnings: [],
        };
      },
    }),
  );

  assertEquals(
    rpcPayloads,
    [
      {
        fn: "api_acl_allocations_caulk_add",
        orgId: "org-from-auth",
        actor: "tester",
        payload: {
          jobNumber: "81234",
          productId: "product-1",
          warehouse: "IL1",
          allocatedTubes: 3,
        },
      },
    ],
    "Expected legacy caulk add to preserve its row payload while dropping request orgId.",
  );
});

Deno.test("caulk remove preserves row-id payload while stripping request orgId", async () => {
  const rpcPayloads: Array<Record<string, unknown>> = [];
  let plannerCallCount = 0;

  await dispatchMutationWithHandlers(
    {},
    { orgId: "org-from-auth", actor: "tester", role: "owner" } as any,
    "/allocations/caulk/remove",
    {
      orgId: "request-org-ignored",
      caulkAllocationId: "CAULK-100",
      reason: "Remove selected row.",
    },
    buildDeps({
      callMutationRpc: async (
        _client: unknown,
        fn: string,
        orgId: string,
        actor: string,
        payload: Record<string, unknown>,
      ) => {
        rpcPayloads.push({ fn, orgId, actor, payload });
        return {
          jobId: "11111111-1111-4111-8111-111111111111",
          jobNumber: "81234",
          caulkAllocationId: "CAULK-100",
          releasedReservedTubes: 3,
          warnings: [],
        };
      },
      reconcileAutoPlannedAllocations: async () => {
        plannerCallCount += 1;
        return {};
      },
    }),
  );

  assertEquals(
    rpcPayloads,
    [
      {
        fn: "api_acl_allocations_caulk_remove",
        orgId: "org-from-auth",
        actor: "tester",
        payload: {
          caulkAllocationId: "CAULK-100",
          reason: "Remove selected row.",
        },
      },
    ],
    "Expected caulk remove to preserve its row payload while dropping request orgId.",
  );
  assertEquals(plannerCallCount, 0, "Expected caulk remove to leave planner ownership with SQL.");
});

Deno.test("caulk checkout/check-in preserve row-id payloads while stripping request orgId", async () => {
  const cases = [
    {
      route: "/allocations/caulk/checkout",
      payload: { orgId: "request-org-ignored", caulkAllocationId: "CAULK-100", checkoutTubes: 3 },
      expectedRpc: "api_acl_allocations_caulk_checkout",
      expectedPayload: { caulkAllocationId: "CAULK-100", checkoutTubes: 3 },
    },
    {
      route: "/allocations/caulk/checkin",
      payload: { orgId: "request-org-ignored", caulkCheckoutId: "CHK-100", unusedLooseTubes: 1, unusedCases: 0 },
      expectedRpc: "api_acl_allocations_caulk_checkin",
      expectedPayload: { caulkCheckoutId: "CHK-100", unusedLooseTubes: 1, unusedCases: 0 },
    },
  ];

  for (const testCase of cases) {
    const rpcPayloads: Array<Record<string, unknown>> = [];
    let plannerCallCount = 0;

    await dispatchMutationWithHandlers(
      {},
      { orgId: "org-from-auth", actor: "tester", role: "owner" } as any,
      testCase.route,
      testCase.payload,
      buildDeps({
        callMutationRpc: async (
          _client: unknown,
          fn: string,
          orgId: string,
          actor: string,
          payload: Record<string, unknown>,
        ) => {
          rpcPayloads.push({ fn, orgId, actor, payload });
          return {
            jobId: "11111111-1111-4111-8111-111111111111",
            jobNumber: "81234",
            caulkAllocationId: "CAULK-100",
            caulkCheckoutId: "CHK-100",
            warnings: [],
          };
        },
        reconcileAutoPlannedAllocations: async () => {
          plannerCallCount += 1;
          return {};
        },
      }),
    );

    assertEquals(
      rpcPayloads,
      [
        {
          fn: testCase.expectedRpc,
          orgId: "org-from-auth",
          actor: "tester",
          payload: testCase.expectedPayload,
        },
      ],
      `Expected ${testCase.route} to strip request orgId before SQL RPC.`,
    );
    assertEquals(plannerCallCount, 0, `Expected ${testCase.route} to leave planner ownership with SQL.`);
  }
});

Deno.test("/boxes/labels/mark-printed marks selected boxes through SQL and reloads public boxes", async () => {
  const rpcCalls: Array<Record<string, unknown>> = [];
  const reloadedBoxIds: string[] = [];

  const response = await dispatchMutationWithHandlers(
    {},
    { orgId: "org-1", actor: "tester", role: "owner" } as any,
    "/boxes/labels/mark-printed",
    { boxIds: ["IL1-100", "IL1-101"] },
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
          boxIds: ["IL1-100", "IL1-101"],
          logIds: ["LOG-100", "LOG-101"],
        };
      },
      findBoxById: async (_client: unknown, _orgId: string, boxId: string) => {
        reloadedBoxIds.push(boxId);
        return {
          id: `record-${boxId}`,
          boxId,
          status: "IN_STOCK",
          hasLabel: true,
          feetAvailable: 50,
          initialFeet: 50,
        };
      },
      toPublicBox: (box: Record<string, unknown>) => ({
        boxId: box.boxId,
        hasLabel: box.hasLabel,
      }),
    }),
  );

  assertEquals(
    rpcCalls,
    [
      {
        fn: "api_acl_boxes_mark_labels_printed",
        orgId: "org-1",
        actor: "tester",
        payload: { boxIds: ["IL1-100", "IL1-101"] },
      },
    ],
    "Expected the label-print route to delegate to the SQL ACL RPC.",
  );
  assertEquals(reloadedBoxIds, ["IL1-100", "IL1-101"], "Expected updated boxes to be reloaded.");
  assertEquals(
    response,
    {
      ok: true,
      data: {
        boxes: [
          { boxId: "IL1-100", hasLabel: true },
          { boxId: "IL1-101", hasLabel: true },
        ],
        logIds: ["LOG-100", "LOG-101"],
      },
      warnings: [],
    },
    "Expected updated public boxes and label audit IDs.",
  );
});

Deno.test("caulk transfer receive/cancel preserve transferId payloads while stripping request orgId", async () => {
  const cases = [
    {
      route: "/caulk/transfers/receive",
      payload: { orgId: "request-org-ignored", transferId: "TR-100" },
      expectedRpc: "api_acl_caulk_transfer_receive",
      expectedPayload: { transferId: "TR-100" },
    },
    {
      route: "/caulk/transfers/cancel",
      payload: { orgId: "request-org-ignored", transferId: "TR-100", reason: "No longer needed." },
      expectedRpc: "api_acl_caulk_transfer_cancel",
      expectedPayload: { transferId: "TR-100", reason: "No longer needed." },
    },
  ];

  for (const testCase of cases) {
    const rpcPayloads: Array<Record<string, unknown>> = [];
    let plannerCallCount = 0;

    await dispatchMutationWithHandlers(
      {},
      { orgId: "org-from-auth", actor: "tester", role: "owner" } as any,
      testCase.route,
      testCase.payload,
      buildDeps({
        callMutationRpc: async (
          _client: unknown,
          fn: string,
          orgId: string,
          actor: string,
          payload: Record<string, unknown>,
        ) => {
          rpcPayloads.push({ fn, orgId, actor, payload });
          return {
            jobId: "11111111-1111-4111-8111-111111111111",
            jobNumber: "81234",
            caulkAllocationId: "CAULK-100",
            transferId: "TR-100",
            productId: "product-1",
            sourceWarehouse: "IL2",
            destinationWarehouse: "IL1",
            warnings: [],
          };
        },
        reconcileAutoPlannedAllocations: async () => {
          plannerCallCount += 1;
          return {};
        },
      }),
    );

    assertEquals(
      rpcPayloads,
      [
        {
          fn: testCase.expectedRpc,
          orgId: "org-from-auth",
          actor: "tester",
          payload: testCase.expectedPayload,
        },
      ],
      `Expected ${testCase.route} to strip request orgId before SQL RPC.`,
    );
    assertEquals(plannerCallCount, 0, `Expected ${testCase.route} to leave planner ownership with SQL.`);
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

Deno.test("/film-orders/create canonical jobId is validated before SQL RPC and request orgId is stripped", async () => {
  const rpcPayloads: Array<Record<string, unknown>> = [];
  const findJobCalls: Array<Record<string, unknown>> = [];
  const jobId = "11111111-1111-4111-8111-111111111111";

  const response = await dispatchMutationWithHandlers(
    {},
    { orgId: "org-from-auth", actor: "tester", role: "owner" } as any,
    "/film-orders/create",
    {
      orgId: "request-org-ignored",
      jobId,
      jobNumber: "81234",
      requirementId: "req-1",
      warehouse: "IL1",
      manufacturer: "3M",
      filmName: "Night Vision 35",
      widthIn: 60,
      requestedFeet: 40,
    },
    buildDeps({
      findJobById: async (_client: unknown, orgId: string, selectedJobId: string) => {
        findJobCalls.push({ orgId, jobId: selectedJobId });
        return {
          id: selectedJobId,
          jobNumber: "81234",
          lifecycleStatus: "ACTIVE",
        };
      },
      callMutationRpc: async (
        _client: unknown,
        fn: string,
        orgId: string,
        actor: string,
        payload: Record<string, unknown>,
      ) => {
        rpcPayloads.push({ fn, orgId, actor, payload });
        return {
          filmOrderId: "FO-100",
          warnings: [],
        };
      },
      findFilmOrderById: async (_client: unknown, orgId: string, filmOrderId: string) => ({
        orgId,
        filmOrderId,
        jobNumber: "81234",
        status: "FILM_ORDER",
      }),
      toPublicFilmOrder: (entry: any) => ({
        filmOrderId: entry.filmOrderId,
        jobNumber: entry.jobNumber,
      }),
    }),
  );

  assertEquals(
    findJobCalls,
    [{ orgId: "org-from-auth", jobId }],
    "Expected canonical film order create job lookup to use auth-derived org.",
  );
  assertEquals(
    rpcPayloads,
    [
      {
        fn: "api_acl_film_orders_create",
        orgId: "org-from-auth",
        actor: "tester",
        payload: {
          jobId,
          jobNumber: "81234",
          requirementId: "req-1",
          warehouse: "IL1",
          manufacturer: "3M",
          filmName: "Night Vision 35",
          widthIn: 60,
          requestedFeet: 40,
        },
      },
    ],
    "Expected canonical film order create to strip request orgId and pass jobId only after validation.",
  );
  assertEquals(
    response.data,
    {
      filmOrderId: "FO-100",
      jobNumber: "81234",
    },
    "Expected film order create response shape to stay stable.",
  );
});

Deno.test("/film-orders/create rejects invalid or mismatched jobId before SQL RPC", async () => {
  let rpcCallCount = 0;
  try {
    await dispatchMutationWithHandlers(
      {},
      { orgId: "org-from-auth", actor: "tester", role: "owner" } as any,
      "/film-orders/create",
      {
        jobId: "not-a-uuid",
        jobNumber: "81234",
        requirementId: "req-1",
      },
      buildDeps({
        callMutationRpc: async () => {
          rpcCallCount += 1;
          return {};
        },
      }),
    );
  } catch (error) {
    assert(error instanceof Error, "Expected invalid jobId to throw.");
    const message = error instanceof Error ? error.message : String(error);
    assert(
      message.includes("jobId must be a valid UUID"),
      `Expected invalid jobId error, received ${message}.`,
    );
  }

  assertEquals(rpcCallCount, 0, "Expected invalid jobId to fail before RPC.");

  try {
    await dispatchMutationWithHandlers(
      {},
      { orgId: "org-from-auth", actor: "tester", role: "owner" } as any,
      "/film-orders/create",
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        jobNumber: "99999",
        requirementId: "req-1",
      },
      buildDeps({
        findJobById: async (_client: unknown, _orgId: string, jobId: string) => ({
          id: jobId,
          jobNumber: "81234",
          lifecycleStatus: "ACTIVE",
        }),
        callMutationRpc: async () => {
          rpcCallCount += 1;
          return {};
        },
      }),
    );
  } catch (error) {
    assert(error instanceof Error, "Expected mismatched job identity to throw.");
    const message = error instanceof Error ? error.message : String(error);
    assert(
      message.includes("Job identity mismatch"),
      `Expected mismatch error, received ${message}.`,
    );
    assertEquals(rpcCallCount, 0, "Expected mismatched jobId to fail before RPC.");
    return;
  }

  throw new Error("Expected film order create mismatched job identity to fail.");
});

Deno.test("/film-orders/create preserves legacy jobNumber-only RPC payload", async () => {
  const rpcPayloads: Array<Record<string, unknown>> = [];
  let findJobByIdCount = 0;

  await dispatchMutationWithHandlers(
    {},
    { orgId: "org-from-auth", actor: "tester", role: "owner" } as any,
    "/film-orders/create",
    {
      orgId: "request-org-ignored",
      jobNumber: "81234",
      warehouse: "IL1",
      manufacturer: "3M",
      filmName: "Night Vision 35",
      widthIn: 60,
      requestedFeet: 40,
    },
    buildDeps({
      findJobById: async () => {
        findJobByIdCount += 1;
        return null;
      },
      callMutationRpc: async (
        _client: unknown,
        fn: string,
        orgId: string,
        actor: string,
        payload: Record<string, unknown>,
      ) => {
        rpcPayloads.push({ fn, orgId, actor, payload });
        return {
          filmOrderId: "FO-LEGACY",
          warnings: [],
        };
      },
      findFilmOrderById: async (_client: unknown, _orgId: string, filmOrderId: string) => ({
        filmOrderId,
        jobNumber: "81234",
      }),
      toPublicFilmOrder: (entry: any) => ({
        filmOrderId: entry.filmOrderId,
        jobNumber: entry.jobNumber,
      }),
    }),
  );

  assertEquals(findJobByIdCount, 0, "Expected legacy create not to resolve jobId.");
  assertEquals(
    rpcPayloads,
    [
      {
        fn: "api_acl_film_orders_create",
        orgId: "org-from-auth",
        actor: "tester",
        payload: {
          jobNumber: "81234",
          warehouse: "IL1",
          manufacturer: "3M",
          filmName: "Night Vision 35",
          widthIn: 60,
          requestedFeet: 40,
        },
      },
    ],
    "Expected legacy film order create to remain jobNumber-only.",
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

Deno.test("/film-orders/delete validates jobId film order ownership before RPC", async () => {
  const jobIdLookups: Array<Record<string, unknown>> = [];
  const filmOrderLookups: Array<Record<string, unknown>> = [];
  const rpcCalls: Array<Record<string, unknown>> = [];
  const plannerCalls: Array<Record<string, unknown>> = [];

  const response = await dispatchMutationWithHandlers(
    {},
    { orgId: "org-from-auth", actor: "tester", role: "owner" } as any,
    "/film-orders/delete",
    {
      orgId: "request-org-ignored",
      jobId: "11111111-1111-4111-8111-111111111111",
      jobNumber: "81234",
      filmOrderId: "FO-100",
      reason: "Delete selected film order.",
    },
    buildDeps({
      findJobById: async (_client: unknown, orgId: string, jobId: string) => {
        jobIdLookups.push({ orgId, jobId });
        return {
          id: jobId,
          jobNumber: "81234",
        };
      },
      findFilmOrderById: async (_client: unknown, orgId: string, filmOrderId: string) => {
        filmOrderLookups.push({ orgId, filmOrderId });
        return {
          filmOrderId,
          jobId: "11111111-1111-4111-8111-111111111111",
          jobNumber: "81234",
        };
      },
      callMutationRpc: async (
        _client: unknown,
        fn: string,
        orgId: string,
        actor: string,
        payload: Record<string, unknown>,
      ) => {
        rpcCalls.push({ fn, orgId, actor, payload });
        return {
          filmOrder: {
            filmOrderId: "FO-100",
            jobNumber: "81234",
            linkedBoxes: [],
          },
          warnings: [],
        };
      },
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
    jobIdLookups,
    [{ orgId: "org-from-auth", jobId: "11111111-1111-4111-8111-111111111111" }],
    "Expected film order delete jobId validation to use auth-derived org.",
  );
  assertEquals(
    filmOrderLookups,
    [{ orgId: "org-from-auth", filmOrderId: "FO-100" }],
    "Expected film order delete to load the selected film order before RPC.",
  );
  assertEquals(
    rpcCalls,
    [
      {
        fn: "api_acl_film_orders_delete",
        orgId: "org-from-auth",
        actor: "tester",
        payload: {
          jobId: "11111111-1111-4111-8111-111111111111",
          jobNumber: "81234",
          filmOrderId: "FO-100",
          reason: "Delete selected film order.",
        },
      },
    ],
    "Expected film order delete to strip request orgId and call the existing RPC only after validation.",
  );
  assertEquals(
    plannerCalls,
    [
      {
        orgId: "org-from-auth",
        actor: "tester",
        scope: {
          jobNumbers: ["81234"],
          jobIds: ["11111111-1111-4111-8111-111111111111"],
        },
      },
    ],
    "Expected canonical film order delete to preserve jobId as shadow planner metadata while keeping jobNumber scope.",
  );
  assertEquals(
    response.data,
    {
      filmOrderId: "FO-100",
      jobNumber: "81234",
      linkedBoxes: [],
    },
    "Expected canonical film order delete response shape to stay unchanged.",
  );
});

Deno.test("/film-orders/delete rejects mismatched jobId and jobNumber before RPC", async () => {
  let filmOrderLookupCount = 0;
  let rpcCallCount = 0;

  try {
    await dispatchMutationWithHandlers(
      {},
      { orgId: "org-from-auth", actor: "tester", role: "owner" } as any,
      "/film-orders/delete",
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        jobNumber: "99999",
        filmOrderId: "FO-100",
      },
      buildDeps({
        findJobById: async (_client: unknown, _orgId: string, jobId: string) => ({
          id: jobId,
          jobNumber: "81234",
        }),
        findFilmOrderById: async () => {
          filmOrderLookupCount += 1;
          return null;
        },
        callMutationRpc: async () => {
          rpcCallCount += 1;
          return {};
        },
      }),
    );
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("Job identity mismatch"),
      `Expected job identity mismatch, received ${error instanceof Error ? error.message : error}.`,
    );
    assertEquals(filmOrderLookupCount, 0, "Expected job mismatch to fail before film order lookup.");
    assertEquals(rpcCallCount, 0, "Expected job mismatch to fail before RPC.");
    return;
  }

  throw new Error("Expected film order delete mismatched job identity to fail.");
});

Deno.test("/film-orders/delete rejects film order ownership mismatch before RPC", async () => {
  let rpcCallCount = 0;

  try {
    await dispatchMutationWithHandlers(
      {},
      { orgId: "org-from-auth", actor: "tester", role: "owner" } as any,
      "/film-orders/delete",
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        jobNumber: "81234",
        filmOrderId: "FO-other",
      },
      buildDeps({
        findJobById: async (_client: unknown, _orgId: string, jobId: string) => ({
          id: jobId,
          jobNumber: "81234",
        }),
        findFilmOrderById: async (_client: unknown, _orgId: string, filmOrderId: string) => ({
          filmOrderId,
          jobId: "22222222-2222-4222-8222-222222222222",
          jobNumber: "81234",
        }),
        callMutationRpc: async () => {
          rpcCallCount += 1;
          return {};
        },
      }),
    );
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("belongs to a different job"),
      `Expected film order ownership mismatch, received ${error instanceof Error ? error.message : error}.`,
    );
    assertEquals(rpcCallCount, 0, "Expected film order mismatch to fail before RPC.");
    return;
  }

  throw new Error("Expected film order ownership mismatch to fail.");
});

Deno.test("/allocations/planner-suppression/clear validates jobId film requirement before RPC", async () => {
  const jobIdLookups: Array<Record<string, unknown>> = [];
  const requirementLookups: Array<Record<string, unknown>> = [];
  const rpcCalls: Array<Record<string, unknown>> = [];
  const detailByIdCalls: Array<Record<string, unknown>> = [];

  const response = await dispatchMutationWithHandlers(
    {},
    { orgId: "org-from-auth", actor: "tester", role: "owner" } as any,
    "/allocations/planner-suppression/clear",
    {
      orgId: "request-org-ignored",
      jobId: "11111111-1111-4111-8111-111111111111",
      jobNumber: "81234",
      requirementId: "req-film-1",
      materialType: "FILM",
      reason: "Resume film planning.",
    },
    buildDeps({
      findJobById: async (_client: unknown, orgId: string, jobId: string) => {
        jobIdLookups.push({ orgId, jobId });
        return {
          id: jobId,
          jobNumber: "81234",
        };
      },
      findPlannerSuppressionRequirementById: async (
        _client: unknown,
        orgId: string,
        requirementId: string,
        materialType: string,
      ) => {
        requirementLookups.push({ orgId, requirementId, materialType });
        return {
          requirementId,
          jobId: "11111111-1111-4111-8111-111111111111",
          jobNumber: "81234",
        };
      },
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
          warnings: ["Clear warning."],
        };
      },
      buildJobDetailById: async (_client: unknown, orgId: string, jobId: string) => {
        detailByIdCalls.push({ orgId, jobId });
        return {
          summary: {
            jobId,
            jobNumber: "81234",
          },
          source: "by-id",
        };
      },
    }),
  );

  assertEquals(
    jobIdLookups,
    [{ orgId: "org-from-auth", jobId: "11111111-1111-4111-8111-111111111111" }],
    "Expected planner suppression clear jobId lookup to use auth-derived org.",
  );
  assertEquals(
    requirementLookups,
    [{ orgId: "org-from-auth", requirementId: "req-film-1", materialType: "FILM" }],
    "Expected planner suppression clear to load the selected film requirement before RPC.",
  );
  assertEquals(
    rpcCalls,
    [
      {
        fn: "api_acl_clear_allocation_planner_suppression",
        orgId: "org-from-auth",
        actor: "tester",
        payload: {
          jobId: "11111111-1111-4111-8111-111111111111",
          jobNumber: "81234",
          requirementId: "req-film-1",
          materialType: "FILM",
          reason: "Resume film planning.",
        },
      },
    ],
    "Expected planner suppression clear to strip request orgId and call the existing RPC after validation.",
  );
  assertEquals(
    detailByIdCalls,
    [{ orgId: "org-from-auth", jobId: "11111111-1111-4111-8111-111111111111" }],
    "Expected canonical planner suppression clear to reload job detail by jobId.",
  );
  assertEquals(
    response,
    {
      ok: true,
      data: {
        summary: {
          jobId: "11111111-1111-4111-8111-111111111111",
          jobNumber: "81234",
        },
        source: "by-id",
      },
      warnings: ["Auto planning resumed for requirement req-film-1 on job 81234."],
    },
    "Expected canonical planner suppression clear to return jobId-scoped detail.",
  );
});

Deno.test("/allocations/planner-suppression/clear validates jobId caulk requirement before RPC", async () => {
  const requirementLookups: Array<Record<string, unknown>> = [];
  const rpcCalls: Array<Record<string, unknown>> = [];

  await dispatchMutationWithHandlers(
    {},
    { orgId: "org-from-auth", actor: "tester", role: "owner" } as any,
    "/allocations/planner-suppression/clear",
    {
      jobId: "11111111-1111-4111-8111-111111111111",
      jobNumber: "81234",
      requirementId: "req-caulk-1",
      materialType: "CAULK",
      reason: "Resume caulk planning.",
    },
    buildDeps({
      findJobById: async (_client: unknown, _orgId: string, jobId: string) => ({
        id: jobId,
        jobNumber: "81234",
      }),
      findPlannerSuppressionRequirementById: async (
        _client: unknown,
        orgId: string,
        requirementId: string,
        materialType: string,
      ) => {
        requirementLookups.push({ orgId, requirementId, materialType });
        return {
          requirementId,
          jobId: "11111111-1111-4111-8111-111111111111",
          jobNumber: "81234",
        };
      },
      callMutationRpc: async (
        _client: unknown,
        fn: string,
        orgId: string,
        actor: string,
        payload: Record<string, unknown>,
      ) => {
        rpcCalls.push({ fn, orgId, actor, payload });
        return { jobNumber: "81234" };
      },
      buildJobDetailById: async () => ({ summary: { jobNumber: "81234" } }),
    }),
  );

  assertEquals(
    requirementLookups,
    [{ orgId: "org-from-auth", requirementId: "req-caulk-1", materialType: "CAULK" }],
    "Expected planner suppression clear to load the selected caulk requirement before RPC.",
  );
  assertEquals(
    rpcCalls.map((entry) => entry.payload),
    [
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        jobNumber: "81234",
        requirementId: "req-caulk-1",
        materialType: "CAULK",
        reason: "Resume caulk planning.",
      },
    ],
    "Expected caulk suppression clear to preserve canonical jobId payload after validation.",
  );
});

Deno.test("/allocations/planner-suppression/clear rejects mismatched jobId and jobNumber before RPC", async () => {
  let requirementLookupCount = 0;
  let rpcCallCount = 0;

  try {
    await dispatchMutationWithHandlers(
      {},
      { orgId: "org-from-auth", actor: "tester", role: "owner" } as any,
      "/allocations/planner-suppression/clear",
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        jobNumber: "99999",
        requirementId: "req-film-1",
        materialType: "FILM",
      },
      buildDeps({
        findJobById: async (_client: unknown, _orgId: string, jobId: string) => ({
          id: jobId,
          jobNumber: "81234",
        }),
        findPlannerSuppressionRequirementById: async () => {
          requirementLookupCount += 1;
          return null;
        },
        callMutationRpc: async () => {
          rpcCallCount += 1;
          return {};
        },
      }),
    );
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("Job identity mismatch"),
      `Expected job identity mismatch, received ${error instanceof Error ? error.message : error}.`,
    );
    assertEquals(requirementLookupCount, 0, "Expected job mismatch to fail before requirement lookup.");
    assertEquals(rpcCallCount, 0, "Expected job mismatch to fail before RPC.");
    return;
  }

  throw new Error("Expected planner suppression clear mismatched job identity to fail.");
});

Deno.test("/allocations/planner-suppression/clear rejects film requirement ownership mismatch before RPC", async () => {
  let rpcCallCount = 0;

  try {
    await dispatchMutationWithHandlers(
      {},
      { orgId: "org-from-auth", actor: "tester", role: "owner" } as any,
      "/allocations/planner-suppression/clear",
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        jobNumber: "81234",
        requirementId: "req-film-other",
        materialType: "FILM",
      },
      buildDeps({
        findJobById: async (_client: unknown, _orgId: string, jobId: string) => ({
          id: jobId,
          jobNumber: "81234",
        }),
        findPlannerSuppressionRequirementById: async (
          _client: unknown,
          _orgId: string,
          requirementId: string,
        ) => ({
          requirementId,
          jobId: "22222222-2222-4222-8222-222222222222",
          jobNumber: "81234",
        }),
        callMutationRpc: async () => {
          rpcCallCount += 1;
          return {};
        },
      }),
    );
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("belongs to a different job"),
      `Expected film requirement ownership mismatch, received ${
        error instanceof Error ? error.message : error
      }.`,
    );
    assertEquals(rpcCallCount, 0, "Expected film requirement mismatch to fail before RPC.");
    return;
  }

  throw new Error("Expected planner suppression clear film ownership mismatch to fail.");
});

Deno.test("/allocations/planner-suppression/clear rejects caulk requirement ownership mismatch before RPC", async () => {
  let rpcCallCount = 0;

  try {
    await dispatchMutationWithHandlers(
      {},
      { orgId: "org-from-auth", actor: "tester", role: "owner" } as any,
      "/allocations/planner-suppression/clear",
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        jobNumber: "81234",
        requirementId: "req-caulk-other",
        materialType: "CAULK",
      },
      buildDeps({
        findJobById: async (_client: unknown, _orgId: string, jobId: string) => ({
          id: jobId,
          jobNumber: "81234",
        }),
        findPlannerSuppressionRequirementById: async (
          _client: unknown,
          _orgId: string,
          requirementId: string,
        ) => ({
          requirementId,
          jobId: "22222222-2222-4222-8222-222222222222",
          jobNumber: "81234",
        }),
        callMutationRpc: async () => {
          rpcCallCount += 1;
          return {};
        },
      }),
    );
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("belongs to a different job"),
      `Expected caulk requirement ownership mismatch, received ${
        error instanceof Error ? error.message : error
      }.`,
    );
    assertEquals(rpcCallCount, 0, "Expected caulk requirement mismatch to fail before RPC.");
    return;
  }

  throw new Error("Expected planner suppression clear caulk ownership mismatch to fail.");
});

Deno.test("/allocations/planner-suppression/clear preserves legacy jobNumber behavior", async () => {
  const rpcCalls: Array<Record<string, unknown>> = [];
  const legacyDetailCalls: Array<Record<string, unknown>> = [];
  let jobIdLookupCount = 0;
  let requirementLookupCount = 0;

  await dispatchMutationWithHandlers(
    {},
    { orgId: "org-1", actor: "tester", role: "owner" } as any,
    "/allocations/planner-suppression/clear",
    {
      jobNumber: "81234",
      requirementId: "req-film-1",
      materialType: "FILM",
      reason: "Legacy resume.",
    },
    buildDeps({
      findJobById: async () => {
        jobIdLookupCount += 1;
        return null;
      },
      findPlannerSuppressionRequirementById: async () => {
        requirementLookupCount += 1;
        return null;
      },
      callMutationRpc: async (
        _client: unknown,
        fn: string,
        orgId: string,
        actor: string,
        payload: Record<string, unknown>,
      ) => {
        rpcCalls.push({ fn, orgId, actor, payload });
        return { jobNumber: "81234" };
      },
      buildJobDetail: async (_client: unknown, orgId: string, jobNumber: string) => {
        legacyDetailCalls.push({ orgId, jobNumber });
        return { summary: { jobNumber }, source: "legacy" };
      },
    }),
  );

  assertEquals(jobIdLookupCount, 0, "Expected legacy suppression clear not to resolve jobId.");
  assertEquals(requirementLookupCount, 0, "Expected legacy suppression clear not to prevalidate ownership.");
  assertEquals(
    rpcCalls,
    [
      {
        fn: "api_acl_clear_allocation_planner_suppression",
        orgId: "org-1",
        actor: "tester",
        payload: {
          jobNumber: "81234",
          requirementId: "req-film-1",
          materialType: "FILM",
          reason: "Legacy resume.",
        },
      },
    ],
    "Expected legacy suppression clear to keep the jobNumber RPC payload.",
  );
  assertEquals(
    legacyDetailCalls,
    [{ orgId: "org-1", jobNumber: "81234" }],
    "Expected legacy suppression clear to reload detail by jobNumber.",
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

Deno.test("/film-orders/cancel validates canonical jobId before RPC and keeps org-wide planner", async () => {
  const findJobCalls: Array<Record<string, unknown>> = [];
  const rpcCalls: Array<Record<string, unknown>> = [];
  const plannerCalls: Array<Record<string, unknown>> = [];

  const response = await dispatchMutationWithHandlers(
    {},
    { orgId: "org-from-auth", actor: "tester", role: "owner" } as any,
    "/film-orders/cancel",
    {
      orgId: "request-org-ignored",
      jobId: "11111111-1111-4111-8111-111111111111",
      jobNumber: "81234",
      reason: "Cancel selected job.",
    },
    buildDeps({
      findJobById: async (_client: unknown, orgId: string, jobId: string) => {
        findJobCalls.push({ orgId, jobId });
        return {
          id: jobId,
          jobNumber: "81234",
        };
      },
      callMutationRpc: async (
        _client: unknown,
        fn: string,
        orgId: string,
        actor: string,
        payload: Record<string, unknown>,
      ) => {
        rpcCalls.push({ fn, orgId, actor, payload });
        return {
          jobId: "11111111-1111-4111-8111-111111111111",
          jobNumber: "81234",
          warnings: ["Cancel RPC warning."],
        };
      },
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
    findJobCalls,
    [{ orgId: "org-from-auth", jobId: "11111111-1111-4111-8111-111111111111" }],
    "Expected canonical cancel job lookup to use the authenticated org.",
  );
  assertEquals(
    rpcCalls,
    [
      {
        fn: "api_acl_film_orders_cancel",
        orgId: "org-from-auth",
        actor: "tester",
        payload: {
          jobId: "11111111-1111-4111-8111-111111111111",
          jobNumber: "81234",
          reason: "Cancel selected job.",
        },
      },
    ],
    "Expected canonical cancel to pass validated jobId/jobNumber to SQL without request orgId.",
  );
  assertEquals(
    plannerCalls,
    [{ orgId: "org-from-auth", actor: "tester", scope: {} }],
    "Expected canonical cancel to preserve org-wide route-owned planner reconciliation.",
  );
  assertEquals(
    response,
    {
      ok: true,
      data: { jobId: "11111111-1111-4111-8111-111111111111", jobNumber: "81234" },
      warnings: ["Cancel RPC warning."],
    },
    "Expected canonical cancel to return additive jobId without changing warnings.",
  );
});

Deno.test("/film-orders/cancel rejects mismatched jobId and jobNumber before RPC", async () => {
  let rpcCallCount = 0;

  try {
    await dispatchMutationWithHandlers(
      {},
      { orgId: "org-from-auth", actor: "tester", role: "owner" } as any,
      "/film-orders/cancel",
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        jobNumber: "99999",
      },
      buildDeps({
        findJobById: async (_client: unknown, _orgId: string, jobId: string) => ({
          id: jobId,
          jobNumber: "81234",
        }),
        callMutationRpc: async () => {
          rpcCallCount += 1;
          return {};
        },
      }),
    );
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("Job identity mismatch"),
      `Expected job identity mismatch, received ${error instanceof Error ? error.message : error}.`,
    );
    assertEquals(rpcCallCount, 0, "Expected job mismatch to fail before RPC.");
    return;
  }

  throw new Error("Expected film order cancel mismatched job identity to fail.");
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

Deno.test("/jobs/complete reloads canonical detail by jobId after route-owned planner", async () => {
  const plannerCalls: Array<Record<string, unknown>> = [];
  const detailByIdCalls: Array<Record<string, unknown>> = [];
  const detailByNumberCalls: Array<Record<string, unknown>> = [];
  const jobId = "11111111-1111-4111-8111-111111111111";

  const response = await dispatchMutationWithHandlers(
    {},
    { orgId: "org-1", actor: "tester", role: "owner" } as any,
    "/jobs/complete",
    {
      jobId,
      jobNumber: "81234",
    },
    buildDeps({
      completeJob: async (_client: unknown, _identity: unknown, payload: Record<string, unknown>) => ({
        ok: true,
        data: { summary: { jobId: payload.jobId, jobNumber: payload.jobNumber }, detailSource: "completeJob" },
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
      buildJobDetailById: async (_client: unknown, orgId: string, receivedJobId: unknown) => {
        detailByIdCalls.push({ orgId, jobId: receivedJobId });
        return { jobId: receivedJobId, detailSource: "postPlannerReloadById" };
      },
      buildJobDetail: async (_client: unknown, orgId: string, jobNumber: unknown) => {
        detailByNumberCalls.push({ orgId, jobNumber });
        return { jobNumber, detailSource: "postPlannerReloadByNumber" };
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
    "Expected canonical /jobs/complete to preserve route-owned org-wide planning.",
  );
  assertEquals(
    detailByIdCalls,
    [{ orgId: "org-1", jobId }],
    "Expected canonical /jobs/complete to reload by jobId.",
  );
  assertEquals(
    detailByNumberCalls,
    [],
    "Expected canonical /jobs/complete to avoid legacy jobNumber detail reload.",
  );
  assertEquals(
    response,
    {
      ok: true,
      data: { jobId, detailSource: "postPlannerReloadById" },
      warnings: ["Complete warning.", "Planner warning."],
    },
    "Expected canonical /jobs/complete to reload by jobId after planner reconciliation.",
  );
});
