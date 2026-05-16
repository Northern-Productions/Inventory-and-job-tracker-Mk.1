import {
  buildPublicCaulkRequirementEntries,
  buildPublicJobRequirementEntries,
  buildJobDetailById,
  canonicalizeMutationPayloadForRoute,
  fetchWarehouseBoxRowsForInventory,
  maybeLogCaulkFallbackCoverageDecision,
  shouldUseCache,
} from "./api-handler.ts";
import { createInventoryRepositories } from "./repositories/inventoryRepositories.ts";
import { dispatchReadWithHandlers } from "./routes/readHandlers.ts";

function assertEquals(actual: unknown, expected: unknown, message: string) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}\nExpected: ${expectedJson}\nActual: ${actualJson}`);
  }
}

async function assertRejectsWithMessage(
  fn: () => Promise<unknown>,
  expectedMessage: string,
  message: string,
) {
  try {
    await fn();
  } catch (error) {
    const actualMessage = error instanceof Error ? error.message : String(error);
    if (!actualMessage.includes(expectedMessage)) {
      throw new Error(`${message}\nExpected message containing: ${expectedMessage}\nActual: ${actualMessage}`);
    }
    return;
  }

  throw new Error(`${message}\nExpected function to reject.`);
}

Deno.test("Edge response cache bypasses mutation-sensitive operational reads", () => {
  const operationalRoutes = [
    "/jobs/get",
    "/jobs/get-by-id",
    "/jobs/list",
    "/jobs/search",
    "/jobs/calendar",
    "/jobs/check-duplicate",
    "/allocations/by-job",
    "/allocations/jobs",
    "/app/attention-summary",
  ];

  for (const route of operationalRoutes) {
    assertEquals(
      shouldUseCache("GET", route),
      false,
      `Expected ${route} to bypass isolate-local cache after inventory/job mutations.`,
    );
  }
});

Deno.test("Edge response cache remains allowlisted for stable reference reads only", () => {
  const cacheableReferenceRoutes = [
    "/warehouses/list",
    "/box-dealers/list",
    "/caulk/manufacturers/list",
    "/caulk/products/list",
    "/film-data/catalog",
  ];

  for (const route of cacheableReferenceRoutes) {
    assertEquals(
      shouldUseCache("GET", route),
      true,
      `Expected ${route} to remain cacheable as a stable reference read.`,
    );
  }

  assertEquals(shouldUseCache("POST", "/allocations/caulk/add"), false, "Expected mutations to bypass cache.");
  assertEquals(shouldUseCache("GET", "/boxes/transfer/plan"), false, "Expected dynamic planning reads to bypass cache.");
});

Deno.test("Edge public film order mapper exposes additive jobId only when present", () => {
  const repositories = createInventoryRepositories({
    rpcOrThrow: async () => {
      throw new Error("Unexpected RPC call.");
    },
    asTrimmedString: (value: unknown) => String(value || "").trim(),
    numericOrNull: (value: unknown) => {
      const numberValue = Number(value);
      return Number.isFinite(numberValue) ? numberValue : null;
    },
    integerOrZero: (value: unknown) => {
      const numberValue = Number(value);
      return Number.isFinite(numberValue) ? Math.trunc(numberValue) : 0;
    },
    integerOrNull: (value: unknown) => {
      const numberValue = Number(value);
      return Number.isFinite(numberValue) ? Math.trunc(numberValue) : null;
    },
    formatDateValue: (value: unknown) => String(value || "").trim(),
    formatTimestamp: (value: unknown) => String(value || "").trim(),
    listInternalBoxRecordIdsByBoxId: async () => ({}),
  });

  const canonicalEntry = repositories.mapDbFilmOrderRow({
    id: "row-job-id",
    org_id: "org-1",
    film_order_id: "FO-JOB-ID",
    job_id: "11111111-1111-4111-8111-111111111111",
    job_number: "4447",
    warehouse: "IL1",
    manufacturer: "Security",
    film_name: "3M Ultra S800",
    width_in: 60,
    requested_feet: 100,
    covered_feet: 0,
    ordered_feet: 0,
    remaining_to_order_feet: 100,
    status: "FILM_ORDER",
    source_box_id: "",
    created_at: "2026-04-16T15:47:48.884Z",
    created_by: "tester",
  });
  const legacyEntry = repositories.mapDbFilmOrderRow({
    id: "row-legacy",
    org_id: "org-1",
    film_order_id: "FO-LEGACY",
    job_id: null,
    job_number: "4447",
    warehouse: "IL1",
    manufacturer: "Security",
    film_name: "3M Ultra S800",
    width_in: 60,
    requested_feet: 100,
    covered_feet: 0,
    ordered_feet: 0,
    remaining_to_order_feet: 100,
    status: "FILM_ORDER",
    source_box_id: "",
    created_at: "2026-04-16T15:47:48.884Z",
    created_by: "tester",
  });

  assertEquals(
    repositories.toPublicFilmOrder(canonicalEntry, []).jobId,
    "11111111-1111-4111-8111-111111111111",
    "Expected Edge public film order mapper to expose jobId when present.",
  );
  assertEquals(
    Object.prototype.hasOwnProperty.call(repositories.toPublicFilmOrder(legacyEntry, []), "jobId"),
    false,
    "Expected Edge public film order mapper to omit jobId for legacy rows.",
  );
});

Deno.test("Edge public box mapper exposes additive ordered-for jobId only when present", () => {
  const repositories = createInventoryRepositories({
    rpcOrThrow: async () => {
      throw new Error("Unexpected RPC call.");
    },
    asTrimmedString: (value: unknown) => String(value || "").trim(),
    numericOrNull: (value: unknown) => {
      const numberValue = Number(value);
      return Number.isFinite(numberValue) ? numberValue : null;
    },
    integerOrZero: (value: unknown) => {
      const numberValue = Number(value);
      return Number.isFinite(numberValue) ? Math.trunc(numberValue) : 0;
    },
    integerOrNull: (value: unknown) => {
      const numberValue = Number(value);
      return Number.isFinite(numberValue) ? Math.trunc(numberValue) : null;
    },
    formatDateValue: (value: unknown) => String(value || "").trim(),
    formatTimestamp: (value: unknown) => String(value || "").trim(),
    listInternalBoxRecordIdsByBoxId: async () => ({}),
  });

  const publicBox = repositories.toPublicBox({
    boxId: "IL1-1234",
    warehouse: "IL1",
    status: "IN_STOCK",
    initialFeet: 500,
    feetAvailable: 420,
    orderedForJobs: [
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        jobNumber: "4953",
        filmOrderId: "FO-1",
        orderedFeet: "120.9",
      },
      {
        jobId: "",
        jobNumber: "16242",
        filmOrderId: "FO-2",
        orderedFeet: 48,
      },
    ],
  }) as any;

  assertEquals(
    publicBox.orderedForJobs,
    [
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        jobNumber: "4953",
        filmOrderId: "FO-1",
        orderedFeet: 120,
      },
      {
        jobNumber: "16242",
        filmOrderId: "FO-2",
        orderedFeet: 48,
      },
    ],
    "Expected Edge public box mapper to expose ordered-for jobId additively.",
  );
});

Deno.test("/boxes/receive canonicalization trims optional lot run and core type", async () => {
  const payload = await canonicalizeMutationPayloadForRoute({} as any, "org-1", "/boxes/receive", {
    boxId: "IL1-1234",
    lotRun: "  LOT-42  ",
    coreType: "  Red plastic  ",
  });

  assertEquals(
    payload,
    {
      boxId: "IL1-1234",
      lotRun: "LOT-42",
      coreType: "Red plastic",
    },
    "Expected receive payload canonicalization to trim optional core type with lot run.",
  );
});

Deno.test("fetchWarehouseBoxRowsForInventory pages warehouse box reads past the first capped page", async () => {
  const pages = [
    [
      { box_id: "IL1-0001", warehouse: "IL1" },
      { box_id: "IL1-0002", warehouse: "IL1" },
      { box_id: "IL1-0003", warehouse: "IL1" },
    ],
    [
      { box_id: "IL1-6734", warehouse: "IL1" },
      { box_id: "IL1-6942", warehouse: "IL1" },
    ],
  ];
  const ranges: Array<[number, number]> = [];

  const client = {
    schema(schemaName: string) {
      assertEquals(schemaName, "app", "Expected inventory read to use the app schema.");
      return {
        from(tableName: string) {
          assertEquals(tableName, "boxes", "Expected inventory read to query app.boxes.");
          const query = {
            select() {
              return query;
            },
            eq() {
              return query;
            },
            in() {
              return query;
            },
            order() {
              return query;
            },
            range(from: number, to: number) {
              ranges.push([from, to]);
              return Promise.resolve({ data: pages.shift() || [], error: null });
            },
          };
          return query;
        },
      };
    },
  };

  const rows = await fetchWarehouseBoxRowsForInventory(client, "org-1", ["IL1"], 3);

  assertEquals(
    rows.map((row) => row.box_id),
    ["IL1-0001", "IL1-0002", "IL1-0003", "IL1-6734", "IL1-6942"],
    "Expected warehouse inventory to include rows from later pages.",
  );
  assertEquals(ranges, [[0, 2], [3, 5]], "Expected range pagination to continue until a short page.");
});

Deno.test("buildPublicCaulkRequirementEntries applies unbound caulk coverage in stable requirement order", () => {
  const requirements = [
    {
      requirementId: "caulk-req-a",
      jobNumber: "19413",
      productId: "product-1",
      manufacturer: "3M",
      productName: "IPA Black",
      productCode: "",
      requiredTubes: 10,
    },
    {
      requirementId: "caulk-req-b",
      jobNumber: "19413",
      productId: "product-1",
      manufacturer: "3M",
      productName: "IPA Black",
      productCode: "",
      requiredTubes: 10,
    },
  ];

  const rows = buildPublicCaulkRequirementEntries(
    requirements,
    [
      {
        caulkAllocationId: "fallback-1",
        requirementId: "",
        jobNumber: "19413",
        productId: "product-1",
        warehouse: "IL1",
        status: "ACTIVE",
        allocatedTubes: 15,
        reservedTubesRemaining: 15,
        createdAt: "2026-05-06T10:00:00Z",
      },
    ],
    { jobNumber: "19413", jobWarehouse: "IL1" },
  );

  assertEquals(
    rows.map((row) => ({
      requirementId: row.requirementId,
      allocatedTubes: row.allocatedTubes,
      remainingTubes: row.remainingTubes,
    })),
    [
      { requirementId: "caulk-req-a", allocatedTubes: 10, remainingTubes: 0 },
      { requirementId: "caulk-req-b", allocatedTubes: 5, remainingTubes: 5 },
    ],
    "Expected one unbound allocation to cover same-product requirements deterministically.",
  );
});

Deno.test("buildPublicJobRequirementEntries credits only unambiguous stale same-job film allocations", () => {
  const singleRequirementRows = buildPublicJobRequirementEntries(
    [
      {
        requirementId: "req-current",
        jobNumber: "19413",
        manufacturer: "Security",
        filmName: "Madico Safetyshield 800",
        widthIn: 60,
        requiredFeet: 40,
      },
    ],
    [
      {
        allocationId: "alloc-stale",
        boxId: "IL1-CHECKED-OUT",
        jobNumber: "19413",
        requirementId: "req-stale",
        status: "ACTIVE",
        allocationKind: "REQUIREMENT",
        allocatedFeet: 40,
        coveredFeet: 40,
        resolvedAt: "2026-04-10T10:00:00Z",
      },
    ],
    {
      "IL1-CHECKED-OUT": {
        boxId: "IL1-CHECKED-OUT",
        status: "CHECKED_OUT",
        lastCheckoutJob: "19413",
        manufacturer: "Security",
        filmName: "Madico Safetyshield 800",
        widthIn: 60,
      },
    },
  );

  assertEquals(
    singleRequirementRows.map((row) => ({
      requirementId: row.requirementId,
      allocatedFeet: row.allocatedFeet,
      remainingFeet: row.remainingFeet,
    })),
    [{ requirementId: "req-current", allocatedFeet: 40, remainingFeet: 0 }],
    "Expected one unambiguous stale requirement allocation to count.",
  );

  const ambiguousRows = buildPublicJobRequirementEntries(
    [
      {
        requirementId: "req-48",
        jobNumber: "19413",
        manufacturer: "Security",
        filmName: "Madico Safetyshield 800",
        widthIn: 48,
        requiredFeet: 20,
      },
      {
        requirementId: "req-60",
        jobNumber: "19413",
        manufacturer: "Security",
        filmName: "Madico Safetyshield 800",
        widthIn: 60,
        requiredFeet: 20,
      },
    ],
    [
      {
        allocationId: "alloc-ambiguous",
        boxId: "IL1-WIDE",
        jobNumber: "19413",
        requirementId: "req-stale",
        status: "ACTIVE",
        allocationKind: "REQUIREMENT",
        allocatedFeet: 40,
        coveredFeet: 40,
      },
    ],
    {
      "IL1-WIDE": {
        boxId: "IL1-WIDE",
        status: "CHECKED_OUT",
        lastCheckoutJob: "19413",
        manufacturer: "Security",
        filmName: "Madico Safetyshield 800",
        widthIn: 60,
      },
    },
  );

  assertEquals(
    ambiguousRows.map((row) => ({
      requirementId: row.requirementId,
      allocatedFeet: row.allocatedFeet,
      remainingFeet: row.remainingFeet,
    })),
    [
      { requirementId: "req-48", allocatedFeet: 0, remainingFeet: 20 },
      { requirementId: "req-60", allocatedFeet: 0, remainingFeet: 20 },
    ],
    "Expected ambiguous stale requirement coverage to stay uncredited.",
  );
});

Deno.test("caulk fallback debug logging is opt-in and blocked for PROD", () => {
  const logs: unknown[] = [];

  const entry = maybeLogCaulkFallbackCoverageDecision(
    {
      allocationId: "alloc-1",
      jobNumber: "19413",
      productId: "product-1",
      product: "3M IPA Black",
      tubesApplied: 6,
      requirementIdsFulfilled: ["caulk-req-1"],
    },
    {
      env: {
        DEV_CAULK_FALLBACK_DEBUG_LOGS: "true",
        SUPABASE_URL: "https://uxiltcpbhthhinonttrc.supabase.co",
      },
      logger: (message) => logs.push(JSON.parse(message)),
    },
  );

  assertEquals(entry?.msg, "caulk_fallback_coverage", "Expected DEV debug flag to emit a structured log.");
  assertEquals(
    logs,
    [
      {
        level: "debug",
        msg: "caulk_fallback_coverage",
        runtime: "supabase-edge",
        allocationId: "alloc-1",
        jobNumber: "19413",
        productId: "product-1",
        product: "3M IPA Black",
        tubesApplied: 6,
        requirementIdsFulfilled: ["caulk-req-1"],
      },
    ],
    "Expected sanitized fallback coverage fields only.",
  );

  const prodEntry = maybeLogCaulkFallbackCoverageDecision(
    {
      allocationId: "alloc-prod",
      jobNumber: "19413",
      productId: "product-1",
      product: "3M IPA Black",
      tubesApplied: 6,
      requirementIdsFulfilled: ["caulk-req-1"],
    },
    {
      env: {
        DEV_CAULK_FALLBACK_DEBUG_LOGS: "true",
        SUPABASE_URL: "https://tiwpulgvxtwlmqdnyuzd.supabase.co",
      },
      logger: (message) => logs.push(JSON.parse(message)),
    },
  );

  assertEquals(prodEntry, null, "Expected PROD project ref to hard-block fallback debug logs.");
  assertEquals(logs.length, 1, "Expected no extra PROD log entry.");

  const prodEnvEntry = maybeLogCaulkFallbackCoverageDecision(
    {
      allocationId: "alloc-prod-env",
      jobNumber: "19413",
      productId: "product-1",
      product: "3M IPA Black",
      tubesApplied: 6,
      requirementIdsFulfilled: ["caulk-req-1"],
    },
    {
      env: {
        DEV_CAULK_FALLBACK_DEBUG_LOGS: "true",
        VERCEL_ENV: "production",
        SUPABASE_URL: "https://uxiltcpbhthhinonttrc.supabase.co",
      },
      logger: (message) => logs.push(JSON.parse(message)),
    },
  );

  assertEquals(prodEnvEntry, null, "Expected PROD env markers to hard-block fallback debug logs.");
  assertEquals(logs.length, 1, "Expected no PROD env marker log entry.");
});

Deno.test("/allocations/preview uses source-warehouse boxes when crossWarehouse is false", async () => {
  const calls: string[] = [];
  const source = { boxId: "IL1-SOURCE", warehouse: "IL1", id: "source-record" };

  const response = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/allocations/preview",
    {
      boxId: source.boxId,
      jobNumber: "4803",
      requestedFeet: 1,
      crossWarehouse: false,
    },
    {} as any,
    {
      requireString: (value: unknown) => String(value || ""),
      asTrimmedString: (value: unknown) => String(value || "").trim(),
      findBoxById: async () => source,
      resolveJobContext: async () => ({ jobNumber: "4803", installDate: "", crewLeader: "" }),
      parseCrossWarehouseFlag: (value: unknown) => value === true || String(value).toLowerCase() === "true",
      listBoxes: async () => {
        calls.push("listBoxes");
        return [{ boxId: "MS1-CANDIDATE", warehouse: "MS1" }];
      },
      listBoxesByWarehouses: async (_client: unknown, orgId: string, warehouses: string[]) => {
        calls.push(`listBoxesByWarehouses:${orgId}:${warehouses.join(",")}`);
        return [source, { boxId: "IL1-CANDIDATE", warehouse: "IL1", id: "candidate-record" }];
      },
      resolveAllocationJobWarehouse: async () => "IL1",
      listJobRequirementsByJob: async () => [],
      buildPendingTransfersByBoxRecordId: async () => ({}),
      listActiveAllocations: async () => [],
      buildActiveAllocationsByBoxIndex: () => ({}),
      buildAllocationPreviewPlan: (_source: unknown, _requestedFeet: unknown, _jobContext: unknown, options: any) => ({
        allBoxIds: options.allBoxes.map((box: any) => box.boxId),
        crossWarehouse: options.crossWarehouse,
      }),
    } as any,
  );

  assertEquals(
    calls,
    ["listBoxesByWarehouses:org-1:IL1"],
    "Expected non-cross preview to avoid the full-org box read.",
  );
  assertEquals(
    response.data,
    { allBoxIds: ["IL1-SOURCE", "IL1-CANDIDATE"], crossWarehouse: false },
    "Expected route to pass warehouse-scoped boxes into the planner.",
  );
});

Deno.test("/allocations/preview canonical jobId path validates identity and loads requirements by job_id", async () => {
  const calls: string[] = [];
  const jobId = "11111111-1111-4111-8111-111111111111";
  const source = { boxId: "IL1-SOURCE", warehouse: "IL1", id: "source-record" };

  const response = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/allocations/preview",
    {
      orgId: "request-org",
      jobId,
      boxId: source.boxId,
      jobNumber: "4803",
      requestedFeet: 1,
      requirementId: "req-1",
      crossWarehouse: false,
    },
    {} as any,
    {
      requireString: (value: unknown) => String(value || ""),
      asTrimmedString: (value: unknown) => String(value || "").trim(),
      findBoxById: async () => source,
      findJobById: async (_client: unknown, orgId: string, selectedJobId: string) => {
        calls.push(`findJobById:${orgId}:${selectedJobId}`);
        return {
          id: selectedJobId,
          jobNumber: "4803",
          warehouse: "IL1",
          installDate: "",
          crewLeader: "",
          lifecycleStatus: "ACTIVE",
        };
      },
      resolveJobContext: async () => {
        throw new Error("legacy jobNumber context should not be used for canonical preview");
      },
      normalizeDateString: (value: unknown) => String(value || "").trim(),
      normalizeCrewLeaderKey: (value: unknown) => String(value || "").trim().toUpperCase(),
      normalizeJobLifecycleStatus: (value: unknown) => (value || "ACTIVE") as "ACTIVE",
      parseCrossWarehouseFlag: (value: unknown) => value === true || String(value).toLowerCase() === "true",
      listBoxes: async () => [],
      listBoxesByWarehouses: async () => [source],
      resolveAllocationJobWarehouse: async (_client: unknown, orgId: string, jobNumber: unknown, _warehouse: unknown, selectedJob: any) => {
        calls.push(`resolveWarehouse:${orgId}:${jobNumber}:${selectedJob?.id}`);
        return "IL1";
      },
      listJobRequirementsByJobId: async (_client: unknown, orgId: string, selectedJobId: string) => {
        calls.push(`listRequirementsByJobId:${orgId}:${selectedJobId}`);
        return [{ id: "req-1", jobId: selectedJobId, jobNumber: "4803", manufacturer: "Llumar", filmName: "RN 07", widthIn: 48 }];
      },
      listJobRequirementsByJob: async () => {
        throw new Error("legacy jobNumber requirements should not be used for canonical preview");
      },
      buildPendingTransfersByBoxRecordId: async () => ({}),
      listActiveAllocations: async () => [],
      buildActiveAllocationsByBoxIndex: () => ({}),
      buildAllocationPreviewPlan: (_source: unknown, _requestedFeet: unknown, jobContext: unknown, options: any) => ({
        jobContext,
        selectedRequirementId: options.selectedRequirement?.id,
      }),
    } as any,
  );

  assertEquals(
    calls,
    [
      `findJobById:org-1:${jobId}`,
      `resolveWarehouse:org-1:4803:${jobId}`,
      `listRequirementsByJobId:org-1:${jobId}`,
    ],
    "Expected canonical preview to use auth org and job_id-owned requirement loading.",
  );
  assertEquals(
    response.data,
    {
      jobContext: { jobNumber: "4803", installDate: "", crewLeader: "" },
      selectedRequirementId: "req-1",
    },
    "Expected canonical preview to pass the selected job context into preview planning.",
  );
});

Deno.test("/allocations/preview rejects invalid, missing, and mismatched canonical jobId", async () => {
  const source = { boxId: "IL1-SOURCE", warehouse: "IL1", id: "source-record" };
  const baseDeps = {
    requireString: (value: unknown) => String(value || ""),
    asTrimmedString: (value: unknown) => String(value || "").trim(),
    findBoxById: async () => source,
    normalizeDateString: (value: unknown) => String(value || "").trim(),
    normalizeCrewLeaderKey: (value: unknown) => String(value || "").trim().toUpperCase(),
    normalizeJobLifecycleStatus: (value: unknown) => (value || "ACTIVE") as "ACTIVE",
  };

  await assertRejectsWithMessage(
    () => dispatchReadWithHandlers(
      {},
      "org-1",
      "/allocations/preview",
      { jobId: "not-a-uuid", boxId: source.boxId, jobNumber: "4803", requestedFeet: 1 },
      {} as any,
      baseDeps as any,
    ),
    "jobId must be a valid UUID.",
    "Expected invalid canonical preview jobId to reject.",
  );

  await assertRejectsWithMessage(
    () => dispatchReadWithHandlers(
      {},
      "org-1",
      "/allocations/preview",
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        boxId: source.boxId,
        jobNumber: "4803",
        requestedFeet: 1,
      },
      {} as any,
      {
        ...baseDeps,
        findJobById: async () => null,
      } as any,
    ),
    "Job was not found.",
    "Expected missing canonical preview job target to reject.",
  );

  await assertRejectsWithMessage(
    () => dispatchReadWithHandlers(
      {},
      "org-1",
      "/allocations/preview",
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        boxId: source.boxId,
        jobNumber: "4803",
        requestedFeet: 1,
      },
      {} as any,
      {
        ...baseDeps,
        findJobById: async () => ({
          id: "11111111-1111-4111-8111-111111111111",
          jobNumber: "9999",
          warehouse: "IL1",
          lifecycleStatus: "ACTIVE",
        }),
      } as any,
    ),
    "Job identity mismatch: selected job does not match jobNumber.",
    "Expected mismatched canonical preview job identity to reject.",
  );
});

Deno.test("/boxes/get includes ordered-for job data from linked film orders", async () => {
  const response = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/boxes/get",
    { boxId: "IL1-1234" },
    {} as any,
    {
      requireString: (value: unknown) => String(value || ""),
      asTrimmedString: (value: unknown) => String(value || "").trim(),
      integerOrZero: (value: unknown) => {
        const numberValue = Number(value);
        return Number.isFinite(numberValue) ? Math.trunc(numberValue) : 0;
      },
      findBoxById: async () => ({
        boxId: "IL1-1234",
        warehouse: "IL1",
        status: "IN_STOCK",
        initialFeet: 500,
        feetAvailable: 420,
      }),
      listAllocationsByBox: async () => [],
      listFilmOrderLinksByBoxId: async () => [
        { filmOrderId: "FO-1", orderedFeet: 120 },
      ],
      findFilmOrderById: async () => ({
        filmOrderId: "FO-1",
        jobId: "11111111-1111-4111-8111-111111111111",
        jobNumber: "4953",
      }),
      toPublicBox: (box: Record<string, unknown>) => ({
        boxId: box.boxId,
        orderedForJobs: box.orderedForJobs,
      }),
    } as any,
  );

  assertEquals(response.data, {
    boxId: "IL1-1234",
    orderedForJobs: [
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        jobNumber: "4953",
        filmOrderId: "FO-1",
        orderedFeet: 120,
      },
    ],
  }, "Expected /boxes/get to include structured ordered-for job data.");
});

Deno.test("/jobs/get-by-id dispatches through the by-id job detail builder", async () => {
  const response = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/jobs/get-by-id",
    { jobId: "11111111-1111-4111-8111-111111111111" },
    {} as any,
    {
      buildJobDetailById: async (_client: unknown, orgId: string, jobId: unknown) => ({
        summary: {
          jobId,
          jobNumber: "4953",
          orgId,
        },
      }),
    } as any,
  );

  assertEquals(response.data, {
    summary: {
      jobId: "11111111-1111-4111-8111-111111111111",
      jobNumber: "4953",
      orgId: "org-1",
    },
  }, "Expected /jobs/get-by-id to return the same detail envelope shape.");
});

Deno.test("/jobs/get-by-id implementation does not delegate to job-number detail aggregation", async () => {
  const byIdImplementation = buildJobDetailById.toString();

  if (byIdImplementation.includes("buildJobDetail(client, orgId, header.jobNumber)")) {
    throw new Error("Expected buildJobDetailById to aggregate by jobId instead of delegating through jobNumber.");
  }

  for (const expectedCall of [
    "listAllocationsByJobIdDirect",
    "listFilmOrdersByJobIdDirect",
    "listJobRequirementsByJobIdDirect",
    "listJobCaulkRequirementsByJobIdDirect",
    "listCaulkJobAllocationsByJobIdDirect",
    "listCaulkJobCheckoutsByJobIdDirect",
    "listRollHistoryForJobAllocations",
  ]) {
    if (!byIdImplementation.includes(expectedCall)) {
      throw new Error(`Expected buildJobDetailById to use ${expectedCall}.`);
    }
  }
});

Deno.test("/jobs/get guards ambiguous legacy jobNumber reads before building detail", async () => {
  const jobNumber = "81234";
  let detailBuilt = false;

  try {
    await dispatchReadWithHandlers(
      {},
      "org-1",
      "/jobs/get",
      { jobNumber },
      {} as any,
      {
        requireString: (value: unknown) => String(value || "").trim(),
        asTrimmedString: (value: unknown) => String(value || "").trim(),
        listJobs: async () => [
          {
            id: "11111111-1111-4111-8111-111111111111",
            jobNumber,
            warehouse: "IL1",
            sections: "Phase A",
            installDate: "2026-05-01",
            crewLeader: "Crew A",
            lifecycleStatus: "ACTIVE",
            updatedAt: "2026-05-01T12:00:00Z",
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            jobNumber,
            warehouse: "MS1",
            sections: "Phase B",
            installDate: "2026-05-02",
            crewLeader: "Crew B",
            lifecycleStatus: "COMPLETED",
            updatedAt: "2026-05-02T12:00:00Z",
          },
        ],
        buildJobDetail: async () => {
          detailBuilt = true;
          return {};
        },
      } as any,
    );
  } catch (error) {
    assertEquals((error as any).statusCode, 409, "Expected ambiguous /jobs/get to return HTTP 409.");
    assertEquals((error as any).details?.code, "JOB_NUMBER_AMBIGUOUS", "Expected structured ambiguity code.");
    assertEquals((error as any).details?.jobNumber, jobNumber, "Expected ambiguity jobNumber.");
    assertEquals(
      (error as any).details?.candidates?.map((candidate: any) => ({
        jobId: candidate.jobId,
        jobNumber: candidate.jobNumber,
        routeTarget: candidate.routeTarget,
        workScope: candidate.workScope,
        warehouse: candidate.warehouse,
        installDate: candidate.installDate,
        crewLeader: candidate.crewLeader,
        lifecycleStatus: candidate.lifecycleStatus,
        updatedAt: candidate.updatedAt,
      })),
      [
        {
          jobId: "11111111-1111-4111-8111-111111111111",
          jobNumber,
          routeTarget: "/allocations/jobs/11111111-1111-4111-8111-111111111111",
          workScope: "Phase A",
          warehouse: "IL1",
          installDate: "2026-05-01",
          crewLeader: "Crew A",
          lifecycleStatus: "ACTIVE",
          updatedAt: "2026-05-01T12:00:00Z",
        },
        {
          jobId: "22222222-2222-4222-8222-222222222222",
          jobNumber,
          routeTarget: "/allocations/jobs/22222222-2222-4222-8222-222222222222",
          workScope: "Phase B",
          warehouse: "MS1",
          installDate: "2026-05-02",
          crewLeader: "Crew B",
          lifecycleStatus: "COMPLETED",
          updatedAt: "2026-05-02T12:00:00Z",
        },
      ],
      "Expected ambiguity candidates to include canonical route and job metadata.",
    );
    assertEquals(detailBuilt, false, "Expected ambiguous /jobs/get to reject before detail aggregation.");
    return;
  }

  throw new Error("Expected ambiguous /jobs/get to reject.");
});

Deno.test("/jobs/get preserves one-match and zero-header legacy read behavior", async () => {
  const oneMatchResponse = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/jobs/get",
    { jobNumber: "81234" },
    {} as any,
    {
      requireString: (value: unknown) => String(value || "").trim(),
      asTrimmedString: (value: unknown) => String(value || "").trim(),
      listJobs: async () => [{ id: "11111111-1111-4111-8111-111111111111", jobNumber: "81234" }],
      buildJobDetail: async (_client: unknown, orgId: string, jobNumber: unknown) => ({
        source: "legacy-detail",
        orgId,
        jobNumber,
      }),
    } as any,
  );
  assertEquals(
    oneMatchResponse.data,
    { source: "legacy-detail", orgId: "org-1", jobNumber: "81234" },
    "Expected one matching header to preserve legacy successful detail shape.",
  );

  const zeroMatchResponse = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/jobs/get",
    { jobNumber: "81234" },
    {} as any,
    {
      requireString: (value: unknown) => String(value || "").trim(),
      asTrimmedString: (value: unknown) => String(value || "").trim(),
      listJobs: async () => [],
      buildJobDetail: async (_client: unknown, orgId: string, jobNumber: unknown) => ({
        source: "legacy-orphan-detail",
        orgId,
        jobNumber,
      }),
    } as any,
  );
  assertEquals(
    zeroMatchResponse.data,
    { source: "legacy-orphan-detail", orgId: "org-1", jobNumber: "81234" },
    "Expected zero matching headers to preserve legacy orphan/no-header fallback.",
  );
});

Deno.test("/allocations/by-job mirrors legacy read ambiguity behavior", async () => {
  const jobNumber = "81234";
  let detailBuilt = false;

  try {
    await dispatchReadWithHandlers(
      {},
      "org-1",
      "/allocations/by-job",
      { jobNumber },
      {} as any,
      {
        requireString: (value: unknown) => String(value || "").trim(),
        asTrimmedString: (value: unknown) => String(value || "").trim(),
        listJobs: async () => [
          { id: "11111111-1111-4111-8111-111111111111", jobNumber, sections: "Phase A" },
          { id: "22222222-2222-4222-8222-222222222222", jobNumber, sections: "Phase B" },
        ],
        buildAllocationJobDetail: async () => {
          detailBuilt = true;
          return {};
        },
      } as any,
    );
  } catch (error) {
    assertEquals((error as any).statusCode, 409, "Expected ambiguous /allocations/by-job to return HTTP 409.");
    assertEquals((error as any).details?.code, "JOB_NUMBER_AMBIGUOUS", "Expected structured ambiguity code.");
    assertEquals((error as any).details?.candidates?.length, 2, "Expected two ambiguity candidates.");
    assertEquals(detailBuilt, false, "Expected ambiguous /allocations/by-job to reject before detail aggregation.");
    return;
  }

  throw new Error("Expected ambiguous /allocations/by-job to reject.");
});

Deno.test("/allocations/by-job preserves one-match and zero-header legacy read behavior", async () => {
  const oneMatchResponse = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/allocations/by-job",
    { jobNumber: "81234" },
    {} as any,
    {
      requireString: (value: unknown) => String(value || "").trim(),
      asTrimmedString: (value: unknown) => String(value || "").trim(),
      listJobs: async () => [{ id: "11111111-1111-4111-8111-111111111111", jobNumber: "81234" }],
      buildAllocationJobDetail: async (_client: unknown, orgId: string, jobNumber: unknown) => ({
        source: "legacy-allocation-detail",
        orgId,
        jobNumber,
      }),
    } as any,
  );
  assertEquals(
    oneMatchResponse.data,
    { source: "legacy-allocation-detail", orgId: "org-1", jobNumber: "81234" },
    "Expected one matching header to preserve legacy allocation detail shape.",
  );

  const zeroMatchResponse = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/allocations/by-job",
    { jobNumber: "81234" },
    {} as any,
    {
      requireString: (value: unknown) => String(value || "").trim(),
      asTrimmedString: (value: unknown) => String(value || "").trim(),
      listJobs: async () => [],
      buildAllocationJobDetail: async (_client: unknown, orgId: string, jobNumber: unknown) => ({
        source: "legacy-orphan-allocation-detail",
        orgId,
        jobNumber,
      }),
    } as any,
  );
  assertEquals(
    zeroMatchResponse.data,
    { source: "legacy-orphan-allocation-detail", orgId: "org-1", jobNumber: "81234" },
    "Expected zero matching headers to preserve legacy allocation orphan/no-header fallback.",
  );
});

Deno.test("/jobs/check-duplicate returns org-scoped duplicate summary when a job exists", async () => {
  const response = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/jobs/check-duplicate",
    { jobNumber: " 81234 ", workScope: "Sections 4, 5" },
    {} as any,
    {
      asTrimmedString: (value: unknown) => String(value || "").trim(),
      requireString: (value: unknown, fieldName: string) => {
        const trimmed = String(value || "").trim();
        if (!trimmed) {
          throw new Error(`${fieldName} is required.`);
        }
        return trimmed;
      },
      normalizeJobNumberDigits: (value: unknown) => String(value || "").replace(/[^0-9]/g, ""),
      normalizeJobLifecycleStatus: () => "ACTIVE",
      findJobByNumber: async (_client: unknown, orgId: string, jobNumber: string) => ({
        id: "11111111-1111-4111-8111-111111111111",
        orgId,
        jobNumber,
        warehouse: "IL1",
        workScope: "Sections 4, 5",
        lifecycleStatus: "ACTIVE",
      }),
      buildJobsList: async (_client: unknown, orgId: string, _limit: number, _status: unknown, jobNumbers: unknown) => [
        {
          jobId: "11111111-1111-4111-8111-111111111111",
          orgId,
          jobNumber: Array.isArray(jobNumbers) ? jobNumbers[0] : "",
          workScope: "Sections 4, 5",
          sections: "Sections 4, 5",
          lifecycleStatus: "ACTIVE",
          status: "READY",
        },
      ],
    } as any,
  );

  assertEquals(response.data, {
    exists: true,
    allowed: false,
    reason: "SAME_JOB_SCOPE_ACTIVE",
    jobNumber: "81234",
    workScope: "Sections 4, 5",
    workScopeKey: "section:4,5",
    job: {
      jobId: "11111111-1111-4111-8111-111111111111",
      orgId: "org-1",
      jobNumber: "81234",
      workScope: "Sections 4, 5",
      sections: "Sections 4, 5",
      lifecycleStatus: "ACTIVE",
      status: "READY",
      workScopeKey: "section:4,5",
      routeTarget: "/allocations/jobs/11111111-1111-4111-8111-111111111111",
    },
    existingJob: {
      jobId: "11111111-1111-4111-8111-111111111111",
      orgId: "org-1",
      jobNumber: "81234",
      workScope: "Sections 4, 5",
      sections: "Sections 4, 5",
      lifecycleStatus: "ACTIVE",
      status: "READY",
      workScopeKey: "section:4,5",
      routeTarget: "/allocations/jobs/11111111-1111-4111-8111-111111111111",
    },
    sameJobNumberJobs: [{
      jobId: "11111111-1111-4111-8111-111111111111",
      orgId: "org-1",
      jobNumber: "81234",
      workScope: "Sections 4, 5",
      sections: "Sections 4, 5",
      lifecycleStatus: "ACTIVE",
      status: "READY",
      workScopeKey: "section:4,5",
      routeTarget: "/allocations/jobs/11111111-1111-4111-8111-111111111111",
    }],
  }, "Expected duplicate check to return the existing job summary.");
});

Deno.test("/jobs/check-duplicate returns exists false when no job exists", async () => {
  const response = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/jobs/check-duplicate",
    { jobNumber: "81235", workScope: "Section 1" },
    {} as any,
    {
      asTrimmedString: (value: unknown) => String(value || "").trim(),
      requireString: (value: unknown, fieldName: string) => {
        const trimmed = String(value || "").trim();
        if (!trimmed) {
          throw new Error(`${fieldName} is required.`);
        }
        return trimmed;
      },
      normalizeJobNumberDigits: (value: unknown) => String(value || "").replace(/[^0-9]/g, ""),
      normalizeJobLifecycleStatus: () => "ACTIVE",
      findJobByNumber: async () => null,
      buildJobsList: async () => {
        throw new Error("Duplicate check should not load summaries when no job exists.");
      },
    } as any,
  );

  assertEquals(response.data, {
    exists: false,
    allowed: true,
    reason: "NO_MATCH",
    jobNumber: "81235",
    workScope: "Section 1",
    workScopeKey: "section:1",
    job: null,
    existingJob: null,
    sameJobNumberJobs: [],
  }, "Expected unique job number to return exists false.");
});

Deno.test("/jobs/check-duplicate blocks different work scope until duplicate job numbers are enabled", async () => {
  const response = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/jobs/check-duplicate",
    { jobNumber: "81234", workScope: "Sections 4, 5" },
    {} as any,
    {
      asTrimmedString: (value: unknown) => String(value || "").trim(),
      requireString: (value: unknown, fieldName: string) => {
        const trimmed = String(value || "").trim();
        if (!trimmed) {
          throw new Error(`${fieldName} is required.`);
        }
        return trimmed;
      },
      normalizeJobNumberDigits: (value: unknown) => String(value || "").replace(/[^0-9]/g, ""),
      normalizeJobLifecycleStatus: () => "ACTIVE",
      findJobByNumber: async (_client: unknown, orgId: string, jobNumber: string) => ({
        id: "11111111-1111-4111-8111-111111111111",
        orgId,
        jobNumber,
        warehouse: "IL1",
        workScope: "Section 1",
        lifecycleStatus: "ACTIVE",
      }),
      buildJobsList: async () => [{
        jobId: "11111111-1111-4111-8111-111111111111",
        jobNumber: "81234",
        workScope: "Section 1",
        sections: "Section 1",
        lifecycleStatus: "ACTIVE",
        status: "READY",
      }],
    } as any,
  );

  assertEquals(
    (response.data as Record<string, unknown>).reason,
    "SAME_JOB_NUMBER_BLOCKED_UNTIL_SCOPE_DUPLICATES_ENABLED",
    "Expected same-number different-scope checks to stay blocked in Phase 3A-2.",
  );
});

Deno.test("/jobs/check-duplicate uses workScope before legacy sections", async () => {
  const response = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/jobs/check-duplicate",
    { jobNumber: "81234", workScope: "Section 1", sections: "Sections 4, 5" },
    {} as any,
    {
      asTrimmedString: (value: unknown) => String(value || "").trim(),
      requireString: (value: unknown, fieldName: string) => {
        const trimmed = String(value || "").trim();
        if (!trimmed) {
          throw new Error(`${fieldName} is required.`);
        }
        return trimmed;
      },
      normalizeJobNumberDigits: (value: unknown) => String(value || "").replace(/[^0-9]/g, ""),
      normalizeJobLifecycleStatus: () => "COMPLETED",
      findJobByNumber: async (_client: unknown, orgId: string, jobNumber: string) => ({
        id: "11111111-1111-4111-8111-111111111111",
        orgId,
        jobNumber,
        warehouse: "IL1",
        workScope: "Sections 01",
        lifecycleStatus: "COMPLETED",
      }),
      buildJobsList: async () => [{
        jobId: "11111111-1111-4111-8111-111111111111",
        jobNumber: "81234",
        workScope: "Sections 01",
        sections: "Sections 01",
        lifecycleStatus: "COMPLETED",
        status: "COMPLETED",
      }],
    } as any,
  );

  assertEquals(
    {
      reason: (response.data as Record<string, unknown>).reason,
      workScope: (response.data as Record<string, unknown>).workScope,
      workScopeKey: (response.data as Record<string, unknown>).workScopeKey,
    },
    {
      reason: "SAME_JOB_SCOPE_COMPLETED",
      workScope: "Section 1",
      workScopeKey: "section:1",
    },
    "Expected workScope to take precedence over legacy sections.",
  );
});

Deno.test("/allocations/preview keeps full-org boxes when crossWarehouse is true", async () => {
  const calls: string[] = [];
  const source = { boxId: "IL1-SOURCE", warehouse: "IL1", id: "source-record" };

  const response = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/allocations/preview",
    {
      boxId: source.boxId,
      jobNumber: "4803",
      requestedFeet: 1,
      crossWarehouse: true,
    },
    {} as any,
    {
      requireString: (value: unknown) => String(value || ""),
      asTrimmedString: (value: unknown) => String(value || "").trim(),
      findBoxById: async () => source,
      resolveJobContext: async () => ({ jobNumber: "4803", installDate: "", crewLeader: "" }),
      parseCrossWarehouseFlag: (value: unknown) => value === true || String(value).toLowerCase() === "true",
      listBoxes: async () => {
        calls.push("listBoxes");
        return [source, { boxId: "MS1-CANDIDATE", warehouse: "MS1", id: "candidate-record" }];
      },
      listBoxesByWarehouses: async () => {
        calls.push("listBoxesByWarehouses");
        return [];
      },
      resolveAllocationJobWarehouse: async () => "IL1",
      listJobRequirementsByJob: async () => [],
      buildPendingTransfersByBoxRecordId: async () => ({}),
      listActiveAllocations: async () => [],
      buildActiveAllocationsByBoxIndex: () => ({}),
      buildAllocationPreviewPlan: (_source: unknown, _requestedFeet: unknown, _jobContext: unknown, options: any) => ({
        allBoxIds: options.allBoxes.map((box: any) => box.boxId),
        crossWarehouse: options.crossWarehouse,
      }),
    } as any,
  );

  assertEquals(calls, ["listBoxes"], "Expected cross-warehouse preview to keep the full-org box read.");
  assertEquals(
    response.data,
    { allBoxIds: ["IL1-SOURCE", "MS1-CANDIDATE"], crossWarehouse: true },
    "Expected route to pass full-org boxes into the planner.",
  );
});
