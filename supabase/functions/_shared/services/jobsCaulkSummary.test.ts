import {
  listCaulkJobAllocationsSnapshot,
  listJobCaulkRequirementsSnapshot,
  loadJobsCaulkSummary,
  projectJobsCaulkSummary,
} from "./jobsCaulkSummary.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals(actual: unknown, expected: unknown, message: string) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      `${message}\nExpected: ${expectedJson}\nActual: ${actualJson}`,
    );
  }
}

async function assertRejects(
  fn: () => unknown | Promise<unknown>,
  expectedMessage: string,
) {
  try {
    await fn();
  } catch (error) {
    assert(error instanceof Error, "Expected an Error rejection.");
    assertEquals(
      error.message,
      expectedMessage,
      "Unexpected rejection message.",
    );
    return;
  }
  throw new Error("Expected function to reject.");
}

function buildPublicRequirements(
  requirements: any[],
  allocations: any[],
  context: { jobNumber: string },
) {
  return requirements.map((requirement) => {
    const requiredTubes = Math.max(0, Number(requirement.requiredTubes) || 0);
    const actualUsedTubes = Math.max(
      0,
      Number(requirement.actualUsedTubes) || 0,
    );
    const isComplete = requirement.status === "COMPLETE";
    const allocatedTubes = isComplete ? 0 : allocations
      .filter((allocation) =>
        allocation.requirementId === requirement.requirementId
      )
      .reduce(
        (total, allocation) =>
          total + Math.max(0, Number(allocation.allocatedTubes) || 0),
        0,
      );
    return {
      ...requirement,
      jobNumber: requirement.jobNumber || context.jobNumber,
      requiredTubes,
      actualUsedTubes,
      allocatedTubes,
      remainingTubes: isComplete
        ? 0
        : Math.max(0, requiredTubes - actualUsedTubes - allocatedTubes),
    };
  });
}

const CANONICAL_JOB_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_JOB_ID = "22222222-2222-4222-8222-222222222222";

Deno.test("caulk summary projection preserves numeric and nonnumeric legacy jobs", () => {
  const pendingTransfer = {
    transferId: "transfer-test",
    status: "PENDING",
    pendingTubes: 1,
  };
  const result = projectJobsCaulkSummary({
    jobContexts: [
      {
        jobNumber: "10001",
        header: { id: CANONICAL_JOB_ID, jobNumber: "10001", warehouse: "IL1" },
        legacy: false,
      },
      { jobNumber: "LEGACY-ALPHA", header: null, legacy: true },
    ],
    requirements: [
      {
        requirementId: "requirement-numeric",
        jobId: CANONICAL_JOB_ID,
        jobNumber: "10001",
        requiredTubes: 10,
        actualUsedTubes: 2,
        status: "ACTIVE",
      },
      {
        requirementId: "requirement-legacy",
        jobNumber: "LEGACY-ALPHA",
        requiredTubes: 5,
        actualUsedTubes: 1,
        status: "ACTIVE",
      },
    ],
    allocations: [
      {
        requirementId: "requirement-numeric",
        jobId: CANONICAL_JOB_ID,
        jobNumber: "10001",
        allocatedTubes: 3,
        pendingTransfer,
      },
      {
        requirementId: "requirement-legacy",
        jobNumber: "LEGACY-ALPHA",
        allocatedTubes: 2,
      },
    ],
    buildPublicRequirements,
  });

  assertEquals(
    result.requirementsByJobId[CANONICAL_JOB_ID][0],
    {
      requirementId: "requirement-numeric",
      jobId: CANONICAL_JOB_ID,
      jobNumber: "10001",
      requiredTubes: 10,
      actualUsedTubes: 2,
      status: "ACTIVE",
      allocatedTubes: 3,
      remainingTubes: 5,
    },
    "Expected numeric canonical summary fields to remain unchanged.",
  );
  assertEquals(
    result.requirementsByJob["LEGACY-ALPHA"][0],
    {
      requirementId: "requirement-legacy",
      jobNumber: "LEGACY-ALPHA",
      requiredTubes: 5,
      actualUsedTubes: 1,
      status: "ACTIVE",
      allocatedTubes: 2,
      remainingTubes: 2,
    },
    "Expected the nonnumeric legacy summary to remain present and accurate.",
  );
  assertEquals(
    result.allocationsByJobId[CANONICAL_JOB_ID][0].pendingTransfer,
    pendingTransfer,
    "Expected transfer state to survive canonical projection.",
  );
});

Deno.test("caulk summary projection handles empty, unallocated, and caulk-only jobs", () => {
  const result = projectJobsCaulkSummary({
    jobContexts: [
      {
        jobNumber: "20001",
        header: { id: CANONICAL_JOB_ID, jobNumber: "20001" },
        legacy: false,
      },
      {
        jobNumber: "20002",
        header: { id: SECOND_JOB_ID, jobNumber: "20002" },
        legacy: false,
      },
    ],
    requirements: [
      {
        requirementId: "requirement-unallocated",
        jobId: SECOND_JOB_ID,
        jobNumber: "20002",
        requiredTubes: 4,
        actualUsedTubes: 0,
        status: "ACTIVE",
      },
      {
        requirementId: "requirement-caulk-only",
        jobNumber: "LEGACY-CAULK-ONLY",
        requiredTubes: 2,
        actualUsedTubes: 0,
        status: "ACTIVE",
      },
    ],
    allocations: [],
    buildPublicRequirements,
  });

  assertEquals(
    result.requirementsByJobId[CANONICAL_JOB_ID],
    [],
    "Expected no-caulk jobs to have an empty summary.",
  );
  assertEquals(
    result.requirementsByJobId[SECOND_JOB_ID][0].remainingTubes,
    4,
    "Expected a requirement without allocations to remain fully outstanding.",
  );
  assert(
    result.jobContexts.some((context) =>
      context.jobNumber === "LEGACY-CAULK-ONLY" && context.legacy
    ),
    "Expected a caulk-only legacy job to remain in the projected contexts.",
  );
});

Deno.test("caulk summary projection groups duplicate display numbers by canonical UUID", () => {
  const result = projectJobsCaulkSummary({
    jobContexts: [
      {
        jobNumber: "30001",
        header: { id: CANONICAL_JOB_ID, jobNumber: "30001" },
        legacy: false,
      },
      {
        jobNumber: "30001",
        header: { id: SECOND_JOB_ID, jobNumber: "30001" },
        legacy: false,
      },
    ],
    requirements: [
      {
        requirementId: "requirement-a",
        jobId: CANONICAL_JOB_ID,
        jobNumber: "30001",
        requiredTubes: 2,
      },
      {
        requirementId: "requirement-b",
        jobId: SECOND_JOB_ID,
        jobNumber: "30001",
        requiredTubes: 7,
      },
    ],
    allocations: [],
    buildPublicRequirements,
  });

  assertEquals(
    result.requirementsByJobId[CANONICAL_JOB_ID][0].requirementId,
    "requirement-a",
    "Expected the first canonical job to receive only its own requirement.",
  );
  assertEquals(
    result.requirementsByJobId[SECOND_JOB_ID][0].requirementId,
    "requirement-b",
    "Expected the second canonical job to receive only its own requirement.",
  );
});

Deno.test("caulk summary projection rejects ambiguous and unmappable rows", async () => {
  const duplicateContexts = [
    {
      jobNumber: "30001",
      header: { id: CANONICAL_JOB_ID, jobNumber: "30001" },
      legacy: false,
    },
    {
      jobNumber: "30001",
      header: { id: SECOND_JOB_ID, jobNumber: "30001" },
      legacy: false,
    },
  ];
  await assertRejects(
    () =>
      projectJobsCaulkSummary({
        jobContexts: duplicateContexts,
        requirements: [{ requirementId: "ambiguous", jobNumber: "30001" }],
        allocations: [],
        buildPublicRequirements,
      }),
    "Unable to map jobs caulk requirement summary row to a unique canonical job.",
  );
  await assertRejects(
    () =>
      projectJobsCaulkSummary({
        jobContexts: [],
        requirements: [],
        allocations: [{
          id: "internal-row-id",
          caulkAllocationId: "unmappable",
        }],
        buildPublicRequirements,
      }),
    "Unable to map jobs caulk allocation summary row to a job.",
  );
});

Deno.test("caulk summary loaders are bounded, org-scoped, and propagate read failures", async () => {
  let requirementCalls = 0;
  let allocationCalls = 0;
  const contexts = Array.from({ length: 250 }, (_, index) => ({
    jobNumber: String(40000 + index),
    header: {
      id: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
      jobNumber: String(40000 + index),
    },
    legacy: false,
  }));
  const result = await loadJobsCaulkSummary("org-safe", contexts, [], {
    loadRequirements: async (orgId) => {
      requirementCalls += 1;
      assertEquals(
        orgId,
        "org-safe",
        "Expected auth org to reach the requirement loader.",
      );
      return [];
    },
    loadAllocations: async (orgId) => {
      allocationCalls += 1;
      assertEquals(
        orgId,
        "org-safe",
        "Expected auth org to reach the allocation loader.",
      );
      return [];
    },
    buildPublicRequirements,
  });

  assertEquals(
    requirementCalls,
    1,
    "Expected one requirement snapshot load for N jobs.",
  );
  assertEquals(
    allocationCalls,
    1,
    "Expected one allocation snapshot load for N jobs.",
  );
  assertEquals(
    result.jobContexts.length,
    250,
    "Expected all canonical contexts to remain present.",
  );

  await assertRejects(
    () =>
      loadJobsCaulkSummary("org-safe", [], [], {
        loadRequirements: async () => {
          throw new Error("synthetic read failure");
        },
        loadAllocations: async () => [],
        buildPublicRequirements,
      }),
    "synthetic read failure",
  );
});

Deno.test("caulk-only legacy contexts honor exact job-number filters", () => {
  const result = projectJobsCaulkSummary({
    jobContexts: [],
    requirements: [{
      requirementId: "filtered",
      jobNumber: "LEGACY-OUTSIDE",
      requiredTubes: 1,
    }],
    allocations: [],
    buildPublicRequirements,
    jobNumberFilters: ["LEGACY-IN-SCOPE"],
  });
  assertEquals(
    result.jobContexts,
    [],
    "Expected filtered snapshot rows not to create unrelated legacy contexts.",
  );
});

type QueryLog = { table: string; filters: Array<[string, unknown]> };

class FakeQuery {
  filters: Array<[string, unknown]> = [];

  constructor(
    private readonly table: string,
    private readonly rows: any[],
    private readonly logs: QueryLog[],
  ) {}

  select(_columns: string) {
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push([column, value]);
    return this;
  }

  in(_column: string, _values: unknown[]) {
    return this;
  }

  order(_column: string, _options: unknown) {
    return this;
  }

  range(_from: number, _to: number) {
    return this;
  }

  then(
    resolve: (value: { data: any[]; error: null }) => unknown,
    reject: (reason: unknown) => unknown,
  ) {
    this.logs.push({ table: this.table, filters: [...this.filters] });
    return Promise.resolve({ data: this.rows, error: null }).then(
      resolve,
      reject,
    );
  }
}

function createFakeClient(
  rowsByTable: Record<string, any[]>,
  logs: QueryLog[],
) {
  return {
    schema(schemaName: string) {
      assertEquals(
        schemaName,
        "app",
        "Expected snapshots to query only the app schema.",
      );
      return {
        from(table: string) {
          return new FakeQuery(table, rowsByTable[table] || [], logs);
        },
      };
    },
  };
}

Deno.test("snapshot queries scope every app table to the authenticated org", async () => {
  const logs: QueryLog[] = [];
  const client = createFakeClient(
    {
      job_caulk_requirements: [{
        id: "requirement",
        job_id: CANONICAL_JOB_ID,
        product_id: "product",
        required_tubes: 3,
      }],
      jobs: [{ id: CANONICAL_JOB_ID, job_number: "50001", warehouse: "IL1" }],
      job_phases: [],
      caulk_job_allocations: [{
        id: "allocation-row",
        caulk_allocation_id: "allocation",
        job_id: CANONICAL_JOB_ID,
        job_number: "50001",
        product_id: "product",
      }],
      caulk_job_checkouts: [],
      caulk_transfers: [],
    },
    logs,
  );
  const baseOptions = {
    client,
    orgId: "org-safe",
    pageSize: 10,
    batchSize: 10,
    throwOnError(error: unknown, message: string) {
      if (error) {
        throw new Error(message);
      }
    },
    loadProductsById: async (orgId: string) => {
      assertEquals(
        orgId,
        "org-safe",
        "Expected product enrichment to retain auth org scope.",
      );
      return {
        product: { name: "Synthetic", code: "TEST", tubes_per_case: 12 },
      };
    },
  };

  await Promise.all([
    listJobCaulkRequirementsSnapshot({
      ...baseOptions,
      loadSuppressionSignaturesByJobId: async (orgId, jobIds) => {
        assertEquals(
          orgId,
          "org-safe",
          "Expected suppression enrichment to retain auth org scope.",
        );
        assertEquals(
          jobIds,
          [CANONICAL_JOB_ID],
          "Expected suppression lookup to use canonical job UUIDs.",
        );
        return {};
      },
      buildPlannerSignature: () => "signature",
      hasPlannerSuppression: () => false,
      mapRequirementRow: (row) => ({
        jobId: row.job_id,
        jobNumber: row.job_number,
      }),
    }),
    listCaulkJobAllocationsSnapshot({
      ...baseOptions,
      mapAllocationRow: (row) => ({
        jobId: row.job_id,
        jobNumber: row.job_number,
      }),
    }),
  ]);

  assert(
    logs.length >= 6,
    "Expected all snapshot and enrichment tables to be queried.",
  );
  for (const log of logs) {
    assert(
      log.filters.some(([column, value]) =>
        column === "org_id" && value === "org-safe"
      ),
      `Expected ${log.table} to be scoped to the authenticated org.`,
    );
  }
});

Deno.test("requirement snapshot rejects a canonical job outside the org-scoped header result", async () => {
  const logs: QueryLog[] = [];
  const client = createFakeClient(
    {
      job_caulk_requirements: [{
        id: "requirement",
        job_id: CANONICAL_JOB_ID,
        product_id: "product",
      }],
      jobs: [],
      job_phases: [],
    },
    logs,
  );
  await assertRejects(
    () =>
      listJobCaulkRequirementsSnapshot({
        client,
        orgId: "org-safe",
        pageSize: 10,
        batchSize: 10,
        throwOnError: () => {},
        loadProductsById: async () => ({}),
        loadSuppressionSignaturesByJobId: async () => ({}),
        buildPlannerSignature: () => "",
        hasPlannerSuppression: () => false,
        mapRequirementRow: (row) => row,
      }),
    "Unable to map jobs caulk requirement summary row to its canonical job.",
  );
});
