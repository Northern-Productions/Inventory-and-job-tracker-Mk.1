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

Deno.test("/jobs/update validates jobId identity before calling the existing jobNumber RPC", async () => {
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

Deno.test("/jobs/create rejects duplicate job numbers before the SQL create RPC", async () => {
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
        findJobByNumber: async (_client: unknown, orgId: string, jobNumber: string) => ({
          orgId,
          jobNumber,
          workScope: "Sections 4, 5",
          sections: "Sections 4, 5",
          lifecycleStatus: "COMPLETED",
        }),
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

Deno.test("/jobs/reopen reloads jobId-scoped detail when canonical identity is present", async () => {
  const jobDetailByIdCalls: Array<Record<string, unknown>> = [];
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
      reconcileAutoPlannedAllocations: async () => ({ warnings: ["Planner warning."] }),
    }),
  );

  assertEquals(
    jobDetailByIdCalls,
    [{ orgId: "org-1", jobId: "11111111-1111-4111-8111-111111111111" }],
    "Expected canonical reopen to reload detail by jobId.",
  );
  assertEquals(legacyDetailCallCount, 0, "Expected canonical reopen not to reload detail by jobNumber.");
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
      reconcileAutoPlannedAllocations: async () => ({}),
    }),
  );

  assertEquals(
    legacyDetailCalls,
    [{ orgId: "org-1", jobNumber: "81234" }],
    "Expected legacy reopen to continue reloading detail by jobNumber.",
  );
  assertEquals(jobDetailByIdCallCount, 0, "Expected legacy reopen not to infer jobId from response detail.");
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

Deno.test("/film-orders/delete validates jobId film order ownership before RPC", async () => {
  const jobIdLookups: Array<Record<string, unknown>> = [];
  const filmOrderLookups: Array<Record<string, unknown>> = [];
  const rpcCalls: Array<Record<string, unknown>> = [];

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
