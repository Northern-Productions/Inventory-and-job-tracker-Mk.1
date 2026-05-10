import {
  buildPublicCaulkRequirementEntries,
  buildPublicJobRequirementEntries,
  canonicalizeMutationPayloadForRoute,
  fetchWarehouseBoxRowsForInventory,
  maybeLogCaulkFallbackCoverageDecision,
  shouldUseCache,
} from "./api-handler.ts";
import { dispatchReadWithHandlers } from "./routes/readHandlers.ts";

function assertEquals(actual: unknown, expected: unknown, message: string) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}\nExpected: ${expectedJson}\nActual: ${actualJson}`);
  }
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
      findFilmOrderById: async () => ({ filmOrderId: "FO-1", jobNumber: "4953" }),
      toPublicBox: (box: Record<string, unknown>) => ({
        boxId: box.boxId,
        orderedForJobs: box.orderedForJobs,
      }),
    } as any,
  );

  assertEquals(response.data, {
    boxId: "IL1-1234",
    orderedForJobs: [{ jobNumber: "4953", filmOrderId: "FO-1", orderedFeet: 120 }],
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

Deno.test("/jobs/check-duplicate returns org-scoped duplicate summary when a job exists", async () => {
  const response = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/jobs/check-duplicate",
    { jobNumber: " 81234 " },
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
    job: {
      jobId: "11111111-1111-4111-8111-111111111111",
      orgId: "org-1",
      jobNumber: "81234",
      workScope: "Sections 4, 5",
      sections: "Sections 4, 5",
      lifecycleStatus: "ACTIVE",
      status: "READY",
    },
  }, "Expected duplicate check to return the existing job summary.");
});

Deno.test("/jobs/check-duplicate returns exists false when no job exists", async () => {
  const response = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/jobs/check-duplicate",
    { jobNumber: "81235" },
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

  assertEquals(response.data, { exists: false, job: null }, "Expected unique job number to return exists false.");
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
