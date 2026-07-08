import {
  buildAllocationJobList,
  buildJobsList,
  buildPublicCaulkRequirementEntries,
  buildPublicJobRequirementEntries,
  buildJobDetailById,
  canonicalizeMutationPayloadForRoute,
  fetchWarehouseBoxRowsForInventory,
  loadCaulkPlanningByJobContexts,
  maybeLogCaulkFallbackCoverageDecision,
  shouldUseCache,
  statusFromRpcError,
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
    "/film-orders/get",
    "/film-weight/profiles",
    "/film-weight/pending-reviews",
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

Deno.test("Edge RPC status parser preserves app_api.raise_http business denial statuses", () => {
  assertEquals(
    statusFromRpcError({
      message: "This email is already attached to another active or invited organization.",
      details: "status=409",
    }),
    409,
    "Expected Supabase-style details to preserve other-org invite denial status.",
  );
  assertEquals(
    statusFromRpcError({
      message: "Target user is not a member of this organization.",
      detail: "status=404",
    }),
    404,
    "Expected Postgres-style detail to preserve wrong-org target denial status.",
  );
  assertEquals(
    statusFromRpcError({
      message: "At least one active owner must remain in this organization.",
      details: "status=400",
    }),
    400,
    "Expected last-owner denial status to remain a business 4xx.",
  );
  assertEquals(
    statusFromRpcError({ message: "Unexpected low-level failure." }),
    500,
    "Expected unclassified RPC errors to remain 500.",
  );
});

Deno.test("Edge film weight chart read routes delegate to read-model dependencies", async () => {
  const calls: string[] = [];
  const profileResponse = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/film-weight/profiles",
    {},
    {} as any,
    {
      listFilmWeightProfiles: async (_client: unknown, orgId: string) => {
        calls.push(`profiles:${orgId}`);
        return [{ profileId: "profile-1" }];
      },
    } as any,
  );
  const pendingResponse = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/film-weight/pending-reviews",
    {},
    {} as any,
    {
      listOpenFilmWeightPendingReviews: async (_client: unknown, orgId: string) => {
        calls.push(`pending:${orgId}`);
        return [{ reviewId: "review-1" }];
      },
    } as any,
  );

  assertEquals(calls, ["profiles:org-1", "pending:org-1"], "Expected Weight Chart routes to call their dependencies.");
  assertEquals(profileResponse.data, { entries: [{ profileId: "profile-1" }] }, "Expected profile entries envelope.");
  assertEquals(pendingResponse.data, { entries: [{ reviewId: "review-1" }] }, "Expected pending entries envelope.");
});

Deno.test("Edge /audit/list projects structured checkout job identity by jobId only", async () => {
  const jobId = "11111111-1111-4111-8111-111111111111";
  const calls: string[] = [];

  const response = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/audit/list",
    { action: "SET_STATUS" },
    {} as any,
    {
      listAudit: async (_client: unknown, orgId: string, params: Record<string, unknown>) => {
        calls.push(`listAudit:${orgId}:${params.action}`);
        return [
          {
            logId: "audit-1",
            action: "SET_STATUS",
            boxId: "IL1-100",
            date: "2026-05-18T12:00:00Z",
            before: null,
            after: {
              status: "CHECKED_OUT",
              lastCheckoutJobId: jobId,
              lastCheckoutJob: "4953",
            },
            user: "tester",
            notes: "Readable note text",
          },
          {
            logId: "legacy-1",
            action: "SET_STATUS",
            boxId: "IL1-200",
            date: "2026-05-18T13:00:00Z",
            before: null,
            after: {
              status: "CHECKED_OUT",
              lastCheckoutJobId: "",
              lastCheckoutJob: "16242",
            },
            user: "tester",
            notes: "Checked out for job 16242",
          },
        ];
      },
      asTrimmedString: (value: unknown) => String(value || "").trim(),
      findJobById: async (_client: unknown, orgId: string, selectedJobId: string) => {
        calls.push(`findJobById:${orgId}:${selectedJobId}`);
        return {
          warehouse: "IL1",
          workScope: "Sections 4, 5",
          sections: "Sections 4, 5",
        };
      },
    } as any,
  );

  assertEquals(
    calls,
    ["listAudit:org-1:SET_STATUS", `findJobById:org-1:${jobId}`],
    "Expected audit scope lookup by structured jobId only.",
  );
  assertEquals(
    (response.data as { entries: Record<string, unknown>[] }).entries.map((entry) => ({
      logId: entry.logId,
      jobId: entry.jobId,
      jobNumber: entry.jobNumber,
      jobWarehouse: entry.jobWarehouse,
      workScope: entry.workScope,
      sections: entry.sections,
    })),
    [
      {
        logId: "audit-1",
        jobId,
        jobNumber: "4953",
        jobWarehouse: "IL1",
        workScope: "Sections 4, 5",
        sections: "Sections 4, 5",
      },
      {
        logId: "legacy-1",
      },
    ],
    "Expected structured audit rows to be additive while legacy note-only rows remain unchanged.",
  );
});

Deno.test("Edge /audit/by-box projects check-in job identity from structured before snapshot", async () => {
  const jobId = "22222222-2222-4222-8222-222222222222";
  const calls: string[] = [];

  const response = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/audit/by-box",
    { boxId: "IL1-100" },
    {} as any,
    {
      requireString: (value: unknown, fieldName: string) => {
        const text = String(value || "").trim();
        if (!text) {
          throw new Error(`${fieldName} required`);
        }
        return text;
      },
      listAuditEntriesByBox: async (_client: unknown, orgId: string, boxId: string) => {
        calls.push(`listAuditEntriesByBox:${orgId}:${boxId}`);
        return [
          {
            logId: "audit-2",
            action: "SET_STATUS",
            boxId,
            date: "2026-05-18T14:00:00Z",
            before: {
              status: "CHECKED_OUT",
              lastCheckoutJobId: jobId,
              lastCheckoutJob: "16242",
            },
            after: {
              status: "IN_STOCK",
              lastCheckoutJobId: "",
              lastCheckoutJob: "",
            },
            user: "tester",
            notes: "Checked in at 3.34 lbs",
          },
        ];
      },
      asTrimmedString: (value: unknown) => String(value || "").trim(),
      findJobById: async (_client: unknown, orgId: string, selectedJobId: string) => {
        calls.push(`findJobById:${orgId}:${selectedJobId}`);
        return {
          warehouse: "MS1",
          sections: "Lobby Phase",
        };
      },
    } as any,
  );

  assertEquals(
    calls,
    ["listAuditEntriesByBox:org-1:IL1-100", `findJobById:org-1:${jobId}`],
    "Expected /audit/by-box to enrich only the structured before-state jobId.",
  );
  assertEquals(
    (response.data as { entries: Record<string, unknown>[] }).entries[0],
    {
      logId: "audit-2",
      action: "SET_STATUS",
      boxId: "IL1-100",
      date: "2026-05-18T14:00:00Z",
      before: {
        status: "CHECKED_OUT",
        lastCheckoutJobId: jobId,
        lastCheckoutJob: "16242",
      },
      after: {
        status: "IN_STOCK",
        lastCheckoutJobId: "",
        lastCheckoutJob: "",
      },
      user: "tester",
      notes: "Checked in at 3.34 lbs",
      jobId,
      jobNumber: "16242",
      jobWarehouse: "MS1",
      workScope: "Lobby Phase",
      sections: "Lobby Phase",
    },
    "Expected check-in audit projection to preserve raw notes and add optional identity fields.",
  );
});

Deno.test("Edge /caulk/transfers/list projects jobId and enriches scope by jobId only", async () => {
  const jobId = "11111111-1111-4111-8111-111111111111";
  const calls: string[] = [];

  const response = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/caulk/transfers/list",
    {
      warehouse: "IL1",
      productId: "",
    },
    {} as any,
    {
      rpcOrThrow: async (_client: unknown, rpcName: string, params: Record<string, unknown>) => {
        calls.push(`rpc:${rpcName}:${params.p_org_id}:${params.p_warehouse}`);
        return [
          {
            transfer_id: "TR-1",
            caulk_allocation_id: "CA-1",
            job_number: "4953",
            job_id: jobId,
            job_warehouse: "il1",
            product_id: "product-1",
            manufacturer_id: "manufacturer-1",
            manufacturer: "OSI",
            product_name: "Quad",
            product_code: "Q",
            tubes_per_case: 12,
            source_warehouse: "IL1",
            destination_warehouse: "MS1",
            pending_tubes: 3,
            status: "PENDING",
          },
          {
            transfer_id: "TR-LEGACY",
            caulk_allocation_id: "CA-LEGACY",
            job_number: "16242",
            job_warehouse: "MS1",
            product_id: "product-1",
            manufacturer_id: "manufacturer-1",
            manufacturer: "OSI",
            product_name: "Quad",
            product_code: "Q",
            tubes_per_case: 12,
            source_warehouse: "IL1",
            destination_warehouse: "MS1",
            pending_tubes: 2,
            status: "PENDING",
          },
        ];
      },
      asTrimmedString: (value: unknown) => String(value || "").trim(),
      integerOrZero: (value: unknown) => {
        const numberValue = Number(value);
        return Number.isFinite(numberValue) ? Math.trunc(numberValue) : 0;
      },
      findJobById: async (_client: unknown, orgId: string, selectedJobId: string) => {
        calls.push(`findJobById:${orgId}:${selectedJobId}`);
        return {
          jobNumber: "4953",
          workScope: "Sections 4, 5",
          sections: "Sections 4, 5",
        };
      },
    } as any,
  );

  assertEquals(
    calls,
    [
      "rpc:api_acl_list_caulk_transfers:org-1:IL1",
      `findJobById:org-1:${jobId}`,
    ],
    "Expected one jobId-based scope lookup and no legacy jobNumber lookup.",
  );
  assertEquals(
    (response.data as { entries: Record<string, unknown>[] }).entries.map((entry) => ({
      transferId: entry.transferId,
      jobId: entry.jobId,
      workScope: entry.workScope,
      sections: entry.sections,
    })),
    [
      {
        transferId: "TR-1",
        jobId,
        workScope: "Sections 4, 5",
        sections: "Sections 4, 5",
      },
      {
        transferId: "TR-LEGACY",
      },
    ],
    "Expected scoped transfer rows to be additive while legacy rows remain compatible.",
  );
});

Deno.test("Edge /caulk/transactions/list projects safe transaction identity and leaves generic rows unchanged", async () => {
  const jobId = "22222222-2222-4222-8222-222222222222";
  const calls: string[] = [];

  const response = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/caulk/transactions/list",
    {
      warehouse: "ALL",
      productId: "",
      limit: 50,
    },
    {} as any,
    {
      rpcOrThrow: async (_client: unknown, rpcName: string, params: Record<string, unknown>) => {
        calls.push(`rpc:${rpcName}:${params.p_org_id}:${params.p_warehouse}:${params.p_limit}`);
        return [
          {
            transaction_id: "TX-1",
            product_id: "product-1",
            warehouse: "IL1",
            manufacturer: "OSI",
            product_name: "Quad",
            product_code: "Q",
            action: "TRANSFER_IN",
            delta_tubes: 3,
            resulting_tubes_on_hand: 10,
            tubes_per_case: 12,
            reason: "Transfer",
            transfer_id: "TR-1",
            source_box_id: "",
            job_id: jobId,
            job_number: "4953",
            job_warehouse: "il1",
            created_at: "2026-05-18T00:00:00Z",
            created_by: "tester",
          },
          {
            transaction_id: "TX-GENERIC",
            product_id: "product-1",
            warehouse: "IL1",
            manufacturer: "OSI",
            product_name: "Quad",
            product_code: "Q",
            action: "ADJUST",
            delta_tubes: 1,
            resulting_tubes_on_hand: 11,
            tubes_per_case: 12,
            reason: "Inventory edit",
            transfer_id: "",
            source_box_id: "",
            created_at: "2026-05-18T00:01:00Z",
            created_by: "tester",
          },
        ];
      },
      asTrimmedString: (value: unknown) => String(value || "").trim(),
      integerOrZero: (value: unknown) => {
        const numberValue = Number(value);
        return Number.isFinite(numberValue) ? Math.trunc(numberValue) : 0;
      },
      findJobById: async (_client: unknown, orgId: string, selectedJobId: string) => {
        calls.push(`findJobById:${orgId}:${selectedJobId}`);
        return {
          jobNumber: "4953",
          workScope: "Lobby",
          sections: "Lobby",
        };
      },
    } as any,
  );

  assertEquals(
    calls,
    [
      "rpc:api_acl_list_caulk_transactions:org-1:ALL:50",
      `findJobById:org-1:${jobId}`,
    ],
    "Expected transaction scope enrichment to use only structured jobId.",
  );
  assertEquals(
    (response.data as { entries: Record<string, unknown>[] }).entries.map((entry) => ({
      transactionId: entry.transactionId,
      jobId: entry.jobId,
      jobNumber: entry.jobNumber,
      jobWarehouse: entry.jobWarehouse,
      workScope: entry.workScope,
      sections: entry.sections,
    })),
    [
      {
        transactionId: "TX-1",
        jobId,
        jobNumber: "4953",
        jobWarehouse: "IL1",
        workScope: "Lobby",
        sections: "Lobby",
      },
      {
        transactionId: "TX-GENERIC",
      },
    ],
    "Expected generic caulk transactions without structured identity to remain unchanged.",
  );
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
    sections: "Sections 4, 5",
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
    repositories.toPublicFilmOrder(canonicalEntry, []).workScope,
    "Sections 4, 5",
    "Expected Edge public film order mapper to expose Work Scope when present.",
  );
  assertEquals(
    repositories.toPublicFilmOrder(canonicalEntry, []).sections,
    "Sections 4, 5",
    "Expected Edge public film order mapper to expose sections when present.",
  );
  assertEquals(
    Object.prototype.hasOwnProperty.call(repositories.toPublicFilmOrder(legacyEntry, []), "jobId"),
    false,
    "Expected Edge public film order mapper to omit jobId for legacy rows.",
  );
  assertEquals(
    Object.prototype.hasOwnProperty.call(repositories.toPublicFilmOrder(legacyEntry, []), "workScope"),
    false,
    "Expected Edge public film order mapper to omit Work Scope for legacy rows.",
  );
  assertEquals(
    Object.prototype.hasOwnProperty.call(repositories.toPublicFilmOrder(legacyEntry, []), "sections"),
    false,
    "Expected Edge public film order mapper to omit sections for legacy rows.",
  );
});

Deno.test("Edge public box mapper exposes additive ordered-for and checkout job metadata", () => {
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
    ownerCompanyId: "owner-mgt",
    ownerCompanyCode: "mgt",
    ownerCompanyDisplayName: "MGT",
    ownerCompanyIsActive: true,
    status: "IN_STOCK",
    initialFeet: 500,
    feetAvailable: 420,
    lastCheckoutJobId: "11111111-1111-4111-8111-111111111111",
    lastCheckoutJob: "4953",
    lastCheckoutWorkScope: "Sections 4, 5",
    lastCheckoutSections: "Sections 4, 5",
    orderedForJobs: [
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        jobNumber: "4953",
        workScope: "Sections 4, 5",
        sections: "Sections 4, 5",
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

  assertEquals(publicBox.ownerCompanyId, "owner-mgt", "Expected public box mapper to expose owner id.");
  assertEquals(publicBox.ownerCompanyCode, "MGT", "Expected public box mapper to normalize owner code.");
  assertEquals(publicBox.ownerCompanyDisplayName, "MGT", "Expected public box mapper to expose owner display name.");
  assertEquals(publicBox.ownerCompanyIsActive, true, "Expected public box mapper to expose active owner state.");
  assertEquals(
    publicBox.orderedForJobs,
    [
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        jobNumber: "4953",
        workScope: "Sections 4, 5",
        sections: "Sections 4, 5",
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
  assertEquals(
    publicBox.lastCheckoutWorkScope,
    "Sections 4, 5",
    "Expected Edge public box mapper to expose last-checkout Work Scope when present.",
  );
  assertEquals(
    publicBox.lastCheckoutSections,
    "Sections 4, 5",
    "Expected Edge public box mapper to expose last-checkout sections when present.",
  );
});

Deno.test("Edge box repository preserves raw stored feet separately from public allocatable feet", async () => {
  const repositories = createInventoryRepositories({
    rpcOrThrow: async (_client: unknown, fn: string) => {
      assertEquals(fn, "api_acl_find_box_by_id", "Expected lookup to use the public ACL box read.");
      return {
        boxId: "IL1-P3C2D-S2-05191440",
        owner_company_id: "owner-edh",
        owner_company_code: "edh",
        owner_company_display_name: "Eastside Holdings",
        owner_company_is_active: false,
        status: "CHECKED_OUT",
        initialFeet: 20,
        feetAvailable: 0,
        physicalFeetAvailable: null,
      } as any;
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
    findRawBoxRowByBoxId: async (_orgId: string, boxId: string) => {
      assertEquals(boxId, "IL1-P3C2D-S2-05191440", "Expected raw lookup to use the resolved box id.");
      return {
        box_id: "IL1-P3C2D-S2-05191440",
        feet_available: 12,
      };
    },
  });

  const box = await repositories.findBoxById({} as any, "org-1", "IL1-P3C2D-S2-05191440");

  assertEquals(box?.feetAvailable, 0, "Expected public allocatable feet to remain public availability.");
  assertEquals(box?.storedFeetAvailable, 12, "Expected checked-out physical projection to retain raw stored feet.");
  assertEquals(box?.ownerCompanyId, "owner-edh", "Expected Edge box mapper to preserve owner id.");
  assertEquals(box?.ownerCompanyCode, "EDH", "Expected Edge box mapper to normalize owner code.");
  assertEquals(box?.ownerCompanyDisplayName, "Eastside Holdings", "Expected Edge box mapper to preserve owner display name.");
  assertEquals(box?.ownerCompanyIsActive, false, "Expected Edge box mapper to preserve inactive owner state.");
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

Deno.test("/allocations/preview canonical jobId path uses selected requirement phase schedule", async () => {
  const jobId = "11111111-1111-4111-8111-111111111111";
  const phaseId = "22222222-2222-4222-8222-222222222222";
  const source = {
    boxId: "IL1-SOURCE",
    warehouse: "IL1",
    id: "source-record",
    manufacturer: "Llumar",
    filmName: "RN 07",
    widthIn: 48,
  };

  const response = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/allocations/preview",
    {
      jobId,
      boxId: source.boxId,
      jobNumber: "4803",
      installDate: "2026-06-15",
      crewLeader: "Phase Two",
      requestedFeet: 1,
      requirementId: "req-phase-2",
      crossWarehouse: false,
    },
    {} as any,
    {
      requireString: (value: unknown) => String(value || ""),
      asTrimmedString: (value: unknown) => String(value || "").trim(),
      findBoxById: async () => source,
      findJobById: async () => ({
        id: jobId,
        jobNumber: "4803",
        warehouse: "IL1",
        installDate: "2026-05-01",
        crewLeader: "Phase One",
        lifecycleStatus: "ACTIVE",
      }),
      resolveJobContext: async () => {
        throw new Error("legacy jobNumber context should not be used for canonical preview");
      },
      normalizeDateString: (value: unknown) => String(value || "").trim(),
      normalizeCrewLeaderKey: (value: unknown) => String(value || "").trim().toUpperCase(),
      normalizeJobLifecycleStatus: (value: unknown) => (value || "ACTIVE") as "ACTIVE",
      parseCrossWarehouseFlag: (value: unknown) => value === true || String(value).toLowerCase() === "true",
      listBoxes: async () => [],
      listBoxesByWarehouses: async () => [source],
      resolveAllocationJobWarehouse: async () => "IL1",
      listJobRequirementsByJobId: async () => [
        {
          id: "req-phase-2",
          jobId,
          jobNumber: "4803",
          phaseId,
          phaseNumber: 2,
          phaseInstallDate: "2026-06-15",
          phaseCrewLeader: "Phase Two",
          manufacturer: "Llumar",
          filmName: "RN 07",
          widthIn: 48,
        },
      ],
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
    response.data,
    {
      jobContext: { jobNumber: "4803", installDate: "2026-06-15", crewLeader: "Phase Two" },
      selectedRequirementId: "req-phase-2",
    },
    "Expected canonical preview planning to use the selected requirement phase schedule.",
  );
});

Deno.test("/allocations/preview canonical jobId path keeps placeholder phases unscheduled", async () => {
  const jobId = "11111111-1111-4111-8111-111111111111";
  const phaseId = "33333333-3333-4333-8333-333333333333";
  const source = {
    boxId: "IL1-SOURCE",
    warehouse: "IL1",
    id: "source-record",
    manufacturer: "Llumar",
    filmName: "RN 07",
    widthIn: 48,
  };

  const response = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/allocations/preview",
    {
      jobId,
      boxId: source.boxId,
      jobNumber: "4803",
      installDate: "2026-05-01",
      crewLeader: "Phase One",
      requestedFeet: 1,
      requirementId: "req-placeholder",
      crossWarehouse: false,
    },
    {} as any,
    {
      requireString: (value: unknown) => String(value || ""),
      asTrimmedString: (value: unknown) => String(value || "").trim(),
      findBoxById: async () => source,
      findJobById: async () => ({
        id: jobId,
        jobNumber: "4803",
        warehouse: "IL1",
        installDate: "2026-05-01",
        crewLeader: "Phase One",
        lifecycleStatus: "ACTIVE",
      }),
      resolveJobContext: async () => {
        throw new Error("legacy jobNumber context should not be used for canonical preview");
      },
      normalizeDateString: (value: unknown) => String(value || "").trim(),
      normalizeCrewLeaderKey: (value: unknown) => String(value || "").trim().toUpperCase(),
      normalizeJobLifecycleStatus: (value: unknown) => (value || "ACTIVE") as "ACTIVE",
      parseCrossWarehouseFlag: (value: unknown) => value === true || String(value).toLowerCase() === "true",
      listBoxes: async () => [],
      listBoxesByWarehouses: async () => [source],
      resolveAllocationJobWarehouse: async () => "IL1",
      listJobRequirementsByJobId: async () => [
        {
          id: "req-placeholder",
          jobId,
          jobNumber: "4803",
          phaseId,
          phaseNumber: 3,
          phaseInstallDate: "",
          phaseCrewLeader: "",
          manufacturer: "Llumar",
          filmName: "RN 07",
          widthIn: 48,
        },
      ],
      listJobRequirementsByJob: async () => {
        throw new Error("legacy jobNumber requirements should not be used for canonical preview");
      },
      buildPendingTransfersByBoxRecordId: async () => ({}),
      listActiveAllocations: async () => [],
      buildActiveAllocationsByBoxIndex: () => ({}),
      buildAllocationPreviewPlan: (_source: unknown, _requestedFeet: unknown, jobContext: unknown) => ({
        jobContext,
      }),
    } as any,
  );

  assertEquals(
    response.data,
    {
      jobContext: { jobNumber: "4803", installDate: "", crewLeader: "" },
    },
    "Expected placeholder phase preview planning to stay unscheduled.",
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
        lastCheckoutJobId: "22222222-2222-4222-8222-222222222222",
        lastCheckoutJob: "16242",
      }),
      listAllocationsByBox: async () => [],
      buildBoxFilmOrderOrigins: async () => [
        {
          jobId: "11111111-1111-4111-8111-111111111111",
          jobNumber: "4953",
          workScope: "Sections 4, 5",
          sections: "Sections 4, 5",
          filmOrderId: "FO-1",
          phaseNumber: 1,
          orderedFeet: 120,
          orderedDate: "2026-05-18",
          receivedDate: "2026-05-20",
        },
      ],
      findJobById: async (_client: unknown, _orgId: string, jobId: string) =>
        jobId === "11111111-1111-4111-8111-111111111111"
          ? {
              jobNumber: "4953",
              workScope: "Sections 4, 5",
              sections: "Sections 4, 5",
            }
          : {
              jobNumber: "16242",
              workScope: "Lobby Phase",
              sections: "Lobby Phase",
            },
      toPublicBox: (box: Record<string, unknown>) => ({
        boxId: box.boxId,
        orderedForJobs: box.orderedForJobs,
        lastCheckoutWorkScope: box.lastCheckoutWorkScope,
        lastCheckoutSections: box.lastCheckoutSections,
      }),
    } as any,
  );

  assertEquals(response.data, {
    boxId: "IL1-1234",
    orderedForJobs: [
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        jobNumber: "4953",
        workScope: "Sections 4, 5",
        sections: "Sections 4, 5",
        filmOrderId: "FO-1",
        phaseNumber: 1,
        orderedFeet: 120,
        orderedDate: "2026-05-18",
        receivedDate: "2026-05-20",
      },
    ],
    lastCheckoutWorkScope: "Lobby Phase",
    lastCheckoutSections: "Lobby Phase",
  }, "Expected /boxes/get to include structured ordered-for job data.");
});

Deno.test("/film-orders/get returns scoped film order detail", async () => {
  const response = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/film-orders/get",
    { filmOrderId: "FO-1" },
    {} as any,
    {
      buildFilmOrderDetail: async (_client: unknown, orgId: string, filmOrderId: unknown) => ({
        filmOrderId,
        orgId,
        neededFeet: 230,
        fulfilledFeet: 100,
        remainingFeet: 130,
        overageFeet: 0,
        displayStatus: "INCOMPLETE",
        linkedBoxes: [{ boxId: "IL1-100", initialFeet: 100 }],
        history: [{ eventId: "event-1", eventType: "BOX_LINKED" }],
      }),
    } as any,
  );

  assertEquals(
    response.data,
    {
      filmOrderId: "FO-1",
      orgId: "org-1",
      neededFeet: 230,
      fulfilledFeet: 100,
      remainingFeet: 130,
      overageFeet: 0,
      displayStatus: "INCOMPLETE",
      linkedBoxes: [{ boxId: "IL1-100", initialFeet: 100 }],
      history: [{ eventId: "event-1", eventType: "BOX_LINKED" }],
    },
    "Expected /film-orders/get to return the scoped detail payload.",
  );
});

Deno.test("/boxes/get reports checked-out physical LF from stored current feet, not initial feet", async () => {
  const response = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/boxes/get",
    { boxId: "IL1-P3C2D-S2-05191440" },
    {} as any,
    {
      requireString: (value: unknown) => String(value || ""),
      asTrimmedString: (value: unknown) => String(value || "").trim(),
      integerOrZero: (value: unknown) => {
        const numberValue = Number(value);
        return Number.isFinite(numberValue) ? Math.trunc(numberValue) : 0;
      },
      findBoxById: async () => ({
        boxId: "IL1-P3C2D-S2-05191440",
        warehouse: "IL1",
        status: "CHECKED_OUT",
        initialFeet: 20,
        feetAvailable: 0,
        storedFeetAvailable: 12,
        lastCheckoutJobId: "4971d840-171f-4969-9bdf-8a79a94e2bc8",
        lastCheckoutJob: "9327001",
      }),
      listAllocationsByBox: async () => [
        {
          allocationId: "alloc-checked-out-fixture",
          boxId: "IL1-P3C2D-S2-05191440",
          jobId: "4971d840-171f-4969-9bdf-8a79a94e2bc8",
          jobNumber: "9327001",
          requirementId: "8457dc46-e538-4e7b-b0ff-678ee0748e4b",
          allocatedFeet: 12,
          status: "ACTIVE",
          installDate: "",
          allocationKind: "REQUIREMENT",
          allocationSource: "AUTO_PLANNED",
        },
      ],
      buildBoxFilmOrderOrigins: async () => [],
      findJobById: async () => ({
        jobNumber: "9327001",
        workScope: "Sections 2",
        sections: "Sections 2",
      }),
      toPublicBox: (box: Record<string, unknown>) => ({
        boxId: box.boxId,
        status: box.status,
        feetAvailable: box.feetAvailable,
        physicalFeetAvailable: box.physicalFeetAvailable,
        allocatedWithoutInstallDateFeet: box.allocatedWithoutInstallDateFeet,
        allocatableNowFeet: box.allocatableNowFeet,
      }),
    } as any,
  );

  assertEquals(response.data, {
    boxId: "IL1-P3C2D-S2-05191440",
    status: "CHECKED_OUT",
    feetAvailable: 0,
    physicalFeetAvailable: 12,
    allocatedWithoutInstallDateFeet: 12,
    allocatableNowFeet: 0,
  }, "Expected checked-out box readback to use the stored current LF, not initialFeet.");
});

Deno.test("/boxes/get reports unclaimed allocatable LF for partially claimed checked-out boxes", async () => {
  const response = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/boxes/get",
    { boxId: "IL1-7056" },
    {} as any,
    {
      requireString: (value: unknown) => String(value || ""),
      asTrimmedString: (value: unknown) => String(value || "").trim(),
      integerOrZero: (value: unknown) => {
        const numberValue = Number(value);
        return Number.isFinite(numberValue) ? Math.trunc(numberValue) : 0;
      },
      findBoxById: async () => ({
        boxId: "IL1-7056",
        warehouse: "IL1",
        status: "CHECKED_OUT",
        initialFeet: 100,
        feetAvailable: 42,
        storedFeetAvailable: 71,
        lastCheckoutJobId: "4971d840-171f-4969-9bdf-8a79a94e2bc8",
        lastCheckoutJob: "9327001",
      }),
      listAllocationsByBox: async () => [
        {
          allocationId: "alloc-scheduled",
          boxId: "IL1-7056",
          jobId: "4971d840-171f-4969-9bdf-8a79a94e2bc8",
          jobNumber: "9327001",
          requirementId: "8457dc46-e538-4e7b-b0ff-678ee0748e4b",
          allocatedFeet: 15,
          status: "ACTIVE",
          installDate: "2026-06-25",
          allocationKind: "REQUIREMENT",
          allocationSource: "MANUAL",
        },
        {
          allocationId: "alloc-placeholder",
          boxId: "IL1-7056",
          jobId: "5c708501-f4c5-413b-8eb8-3a9627f3f20b",
          jobNumber: "9327002",
          requirementId: "af075476-2024-446c-a827-1847972d6844",
          allocatedFeet: 14,
          status: "ACTIVE",
          installDate: "",
          allocationKind: "REQUIREMENT",
          allocationSource: "AUTO_PLANNED",
        },
      ],
      buildBoxFilmOrderOrigins: async () => [],
      findJobById: async () => null,
      toPublicBox: (box: Record<string, unknown>) => ({
        boxId: box.boxId,
        status: box.status,
        feetAvailable: box.feetAvailable,
        physicalFeetAvailable: box.physicalFeetAvailable,
        allocatedWithInstallDateFeet: box.allocatedWithInstallDateFeet,
        allocatedWithoutInstallDateFeet: box.allocatedWithoutInstallDateFeet,
        allocatableNowFeet: box.allocatableNowFeet,
      }),
    } as any,
  );

  assertEquals(response.data, {
    boxId: "IL1-7056",
    status: "CHECKED_OUT",
    feetAvailable: 42,
    physicalFeetAvailable: 71,
    allocatedWithInstallDateFeet: 15,
    allocatedWithoutInstallDateFeet: 14,
    allocatableNowFeet: 42,
  }, "Expected checked-out box readback to expose 71 - 15 - 14 = 42 LF as unclaimed planning capacity.");
});

Deno.test("/allocations/by-box enriches allocation history scope by job id only", async () => {
  const jobLookups: string[] = [];
  const response = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/allocations/by-box",
    { boxId: "IL1-1234" },
    {} as any,
    {
      requireString: (value: unknown) => String(value || "").trim(),
      asTrimmedString: (value: unknown) => String(value || "").trim(),
      integerOrZero: (value: unknown) => {
        const numberValue = Number(value);
        return Number.isFinite(numberValue) ? Math.trunc(numberValue) : 0;
      },
      listAllocationsByBox: async () => [
        {
          allocationId: "alloc-1",
          jobId: "11111111-1111-4111-8111-111111111111",
          jobNumber: "4953",
          warehouse: "IL1",
          allocatedFeet: 24,
        },
        {
          allocationId: "alloc-legacy",
          jobNumber: "16242",
          warehouse: "IL1",
          allocatedFeet: 10,
        },
      ],
      findBoxById: async () => null,
      findJobById: async (_client: unknown, _orgId: string, jobId: string) => {
        jobLookups.push(jobId);
        return {
          jobNumber: "4953",
          workScope: "Sections 4, 5",
          sections: "Sections 4, 5",
        };
      },
      toPublicAllocation: (entry: Record<string, unknown>) => ({
        allocationId: entry.allocationId,
        jobNumber: entry.jobNumber,
        warehouse: entry.warehouse,
        allocatedFeet: entry.allocatedFeet,
      }),
    } as any,
  );

  assertEquals(jobLookups, ["11111111-1111-4111-8111-111111111111"], "Expected only jobId-based scope lookup.");
  assertEquals(
    (response.data as any).entries,
    [
      {
        allocationId: "alloc-1",
        jobNumber: "4953",
        warehouse: "IL1",
        allocatedFeet: 24,
        jobId: "11111111-1111-4111-8111-111111111111",
        workScope: "Sections 4, 5",
        sections: "Sections 4, 5",
        backedPhysicalFeet: 24,
        reservationState: "WITHOUT_INSTALL_DATE",
      },
      {
        allocationId: "alloc-legacy",
        jobNumber: "16242",
        warehouse: "IL1",
        allocatedFeet: 10,
        backedPhysicalFeet: 10,
        reservationState: "WITHOUT_INSTALL_DATE",
      },
    ],
    "Expected /allocations/by-box to add scope only to rows with jobId.",
  );
});

Deno.test("/roll-history/by-box enriches roll history scope by job id only", async () => {
  const jobLookups: string[] = [];
  const response = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/roll-history/by-box",
    { boxId: "IL1-1234" },
    {} as any,
    {
      requireString: (value: unknown) => String(value || "").trim(),
      asTrimmedString: (value: unknown) => String(value || "").trim(),
      listRollHistoryByBox: async () => [
        {
          logId: "roll-1",
          jobId: "22222222-2222-4222-8222-222222222222",
          jobNumber: "4803",
          warehouse: "MS1",
        },
        {
          logId: "roll-legacy",
          jobId: null,
          jobNumber: "4953",
          warehouse: "IL1",
        },
      ],
      findJobById: async (_client: unknown, _orgId: string, jobId: string) => {
        jobLookups.push(jobId);
        return {
          jobNumber: "4803",
          sections: "Lobby Phase",
        };
      },
    } as any,
  );

  assertEquals(jobLookups, ["22222222-2222-4222-8222-222222222222"], "Expected only jobId-based scope lookup.");
  assertEquals(
    (response.data as any).entries,
    [
      {
        logId: "roll-1",
        jobId: "22222222-2222-4222-8222-222222222222",
        jobNumber: "4803",
        warehouse: "MS1",
        workScope: "Lobby Phase",
        sections: "Lobby Phase",
      },
      {
        logId: "roll-legacy",
        jobId: null,
        jobNumber: "4953",
        warehouse: "IL1",
      },
    ],
    "Expected /roll-history/by-box to add scope only to rows with jobId.",
  );
});

Deno.test("/reports/summary preserves additive closed-job work scope fields", async () => {
  const response = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/reports/summary",
    { warehouse: "IL1" },
    {} as any,
    {
      buildReportsSummary: async () => ({
        availableFeetByWidth: [],
        neverCheckedOut: [],
        zeroedByMonth: [],
        zeroedBoxes: [],
        completedJobs: [
          {
            jobId: "11111111-1111-4111-8111-111111111111",
            jobNumber: "4953",
            workScope: "Sections 4, 5",
            sections: "Sections 4, 5",
            warehouse: "IL1",
          },
        ],
        cancelledJobs: [
          {
            jobNumber: "81234",
            warehouse: "MS1",
          },
        ],
      }),
    } as any,
  );

  assertEquals(
    {
      completedWorkScope: (response.data as any).completedJobs[0].workScope,
      completedSections: (response.data as any).completedJobs[0].sections,
      legacyHasWorkScope: Object.prototype.hasOwnProperty.call((response.data as any).cancelledJobs[0], "workScope"),
    },
    {
      completedWorkScope: "Sections 4, 5",
      completedSections: "Sections 4, 5",
      legacyHasWorkScope: false,
    },
    "Expected /reports/summary to keep additive scope fields without requiring them on legacy rows.",
  );
});

Deno.test("/jobs/list preserves same-number rows returned by the list builder", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const response = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/jobs/list",
    { jobNumbers: ["9327001"] },
    {} as any,
    {
      buildJobsList: async (
        _client: unknown,
        orgId: string,
        limit: number,
        lifecycleStatus: unknown,
        jobNumbers: unknown,
      ) => {
        calls.push({ orgId, limit, lifecycleStatus, jobNumbers });
        return [
          {
            jobId: "11111111-1111-4111-8111-111111111111",
            jobNumber: "9327001",
            workScope: "Sections 1",
            workScopeKey: "section:1",
          },
          {
            jobId: "22222222-2222-4222-8222-222222222222",
            jobNumber: "9327001",
            workScope: "Sections 2",
            workScopeKey: "section:2",
          },
        ];
      },
    } as any,
  );

  assertEquals(
    calls,
    [{ orgId: "org-1", limit: 25, lifecycleStatus: undefined, jobNumbers: ["9327001"] }],
    "Expected /jobs/list to pass the job-number filter through without deduping it.",
  );
  assertEquals(
    (response.data as any).entries.map((entry: any) => ({
      jobId: entry.jobId,
      jobNumber: entry.jobNumber,
      workScopeKey: entry.workScopeKey,
    })),
    [
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        jobNumber: "9327001",
        workScopeKey: "section:1",
      },
      {
        jobId: "22222222-2222-4222-8222-222222222222",
        jobNumber: "9327001",
        workScopeKey: "section:2",
      },
    ],
    "Expected /jobs/list to return distinct same-number rows from the builder.",
  );
});

Deno.test("Edge job summaries load caulk counts by canonical job id when a header exists", async () => {
  const buildJobsListSource = buildJobsList.toString();
  const caulkPlanningSource = loadCaulkPlanningByJobContexts.toString();

  if (!caulkPlanningSource) {
    throw new Error("Expected Edge caulk planning helper for canonical job contexts to be present.");
  }
  if (!/listJobCaulkRequirementsByJobIdsDirect\(orgId, canonicalHeadersByJobId\)/.test(caulkPlanningSource)) {
    throw new Error("Expected Edge /jobs/list caulk requirements to load through the batched jobId direct path.");
  }
  if (!/listCaulkJobAllocationsByJobIdsDirect\(orgId, canonicalJobIds\)/.test(caulkPlanningSource)) {
    throw new Error("Expected Edge /jobs/list caulk allocations to load through the batched jobId direct path.");
  }
  if (/canonicalContexts\.map\(async/.test(caulkPlanningSource)) {
    throw new Error("Expected Edge /jobs/list caulk planning not to issue per-job caulk queries.");
  }
  if (!/loadCaulkPlanningByJobContexts\(client, orgId, jobContexts\)/.test(buildJobsListSource)) {
    throw new Error("Expected Edge /jobs/list to build caulk summaries from canonical job contexts.");
  }
  if (!/contextJobId\s*\?\s*caulkPlanning\.requirementsByJobId\[contextJobId\]/.test(buildJobsListSource)) {
    throw new Error("Expected Edge /jobs/list to project caulk requirements by context jobId.");
  }
});

Deno.test("Edge allocation job summaries preserve duplicate job-number rows by canonical job id", () => {
  const buildAllocationJobListSource = buildAllocationJobList.toString();

  if (!/const jobContexts = jobHeaders\.map/.test(buildAllocationJobListSource)) {
    throw new Error("Expected Edge /allocations/jobs to build one canonical context per job header.");
  }
  if (!/loadCaulkPlanningByJobContexts\(client, orgId, jobContexts\)/.test(buildAllocationJobListSource)) {
    throw new Error("Expected Edge /allocations/jobs to load caulk planning through canonical job contexts.");
  }
  if (!/getRowsForJobHeader\(context\.header, allocationsByJobId/.test(buildAllocationJobListSource)) {
    throw new Error("Expected Edge /allocations/jobs allocations to be projected by context jobId.");
  }
  if (!/contextJobId\s*\?\s*caulkPlanning\.requirementsByJobId\[contextJobId\]/.test(buildAllocationJobListSource)) {
    throw new Error("Expected Edge /allocations/jobs caulk requirements to be projected by context jobId.");
  }
  if (!/contextJobId\s*\?\s*caulkPlanning\.allocationsByJobId\[contextJobId\]/.test(buildAllocationJobListSource)) {
    throw new Error("Expected Edge /allocations/jobs caulk allocations to be projected by context jobId.");
  }
  if (/loadCaulkPlanningByJobNumbers\(client, orgId, Object\.keys\(jobNumbers\)/.test(buildAllocationJobListSource)) {
    throw new Error("Expected Edge /allocations/jobs not to use jobNumber-only caulk summary planning.");
  }
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
      listJobs: async (_client: unknown, orgId: string) => [
        {
          jobId: "11111111-1111-4111-8111-111111111111",
          orgId,
          jobNumber: "81234",
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
    canCreate: false,
    duplicatesEnabled: true,
    reason: "SAME_JOB_SCOPE_ACTIVE",
    blockingReason: "SAME_JOB_SCOPE_ACTIVE",
    duplicateScopeMode: "EXACT_SCOPE",
    jobNumber: "81234",
    workScope: "Sections 4, 5",
    workScopeKey: "section:4,5",
    requestedWorkScope: "Sections 4, 5",
    requestedWorkScopeKey: "section:4,5",
    exactScopeDuplicateExists: true,
    sameJobNumberDifferentScopeExists: false,
    futureCanCreateAfterEnablement: false,
    exactScopeJobs: [{
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
    differentScopeJobs: [],
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
      listJobs: async () => [],
    } as any,
  );

  assertEquals(response.data, {
    exists: false,
    allowed: true,
    canCreate: true,
    duplicatesEnabled: true,
    reason: "NO_MATCH",
    blockingReason: null,
    duplicateScopeMode: "NO_MATCH",
    jobNumber: "81235",
    workScope: "Section 1",
    workScopeKey: "section:1",
    requestedWorkScope: "Section 1",
    requestedWorkScopeKey: "section:1",
    exactScopeDuplicateExists: false,
    sameJobNumberDifferentScopeExists: false,
    futureCanCreateAfterEnablement: false,
    exactScopeJobs: [],
    differentScopeJobs: [],
    job: null,
    existingJob: null,
    sameJobNumberJobs: [],
  }, "Expected unique job number to return exists false.");
});

Deno.test("/jobs/check-duplicate allows different work scope after duplicate job numbers are enabled", async () => {
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
      listJobs: async () => [{
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
    "NO_MATCH",
    "Expected same-number different-scope checks to be allowed after enablement.",
  );
  assertEquals((response.data as Record<string, unknown>).canCreate, true, "Expected different-scope same-number candidate to be create-eligible.");
  assertEquals((response.data as Record<string, unknown>).allowed, true, "Expected different-scope same-number candidate to be allowed.");
  assertEquals((response.data as Record<string, unknown>).blockingReason, null, "Expected no blocking reason for different-scope same-number candidate.");
  assertEquals((response.data as Record<string, unknown>).futureCanCreateAfterEnablement, false, "Expected future eligibility flag to be cleared after enablement.");
  assertEquals((response.data as Record<string, unknown>).exactScopeDuplicateExists, false, "Expected no exact-scope match.");
  assertEquals((response.data as Record<string, unknown>).sameJobNumberDifferentScopeExists, true, "Expected different-scope match to be reported.");
});

Deno.test("/jobs/check-duplicate preserves all same-number candidates across scope groups", async () => {
  const response = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/jobs/check-duplicate",
    { jobNumber: "81234", workScope: "Sections 01" },
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
      normalizeJobLifecycleStatus: (value: unknown) => String(value || "ACTIVE").trim().toUpperCase(),
      listJobs: async () => [
        {
          jobId: "22222222-2222-4222-8222-222222222222",
          jobNumber: "81234",
          workScope: "Sections 4, 5",
          sections: "Sections 4, 5",
          workScopeKey: "section:4,5",
          lifecycleStatus: "ACTIVE",
          status: "READY",
        },
        {
          jobId: "33333333-3333-4333-8333-333333333333",
          jobNumber: "81234",
          workScope: "Section 1",
          sections: "Section 1",
          workScopeKey: "section:1",
          lifecycleStatus: "ACTIVE",
          status: "READY",
        },
      ],
    } as any,
  );

  const data = response.data as Record<string, any>;
  assertEquals(data.reason, "SAME_JOB_SCOPE_ACTIVE", "Expected exact-scope match to take priority.");
  assertEquals(data.duplicateScopeMode, "MIXED_SCOPE", "Expected mixed scope mode.");
  assertEquals(data.canCreate, false, "Expected creation to remain blocked.");
  assertEquals(data.duplicatesEnabled, true, "Expected duplicate enablement flag to be true.");
  assertEquals(data.futureCanCreateAfterEnablement, false, "Expected exact-scope duplicate to prevent future-create eligibility.");
  assertEquals(data.sameJobNumberJobs.length, 2, "Expected all same-number candidates to be preserved.");
  assertEquals(data.exactScopeJobs.length, 1, "Expected one exact-scope candidate.");
  assertEquals(data.exactScopeJobs[0].jobId, "33333333-3333-4333-8333-333333333333", "Expected exact-scope job identity to be preserved.");
  assertEquals(data.differentScopeJobs.length, 1, "Expected one different-scope candidate.");
  assertEquals(data.differentScopeJobs[0].jobId, "22222222-2222-4222-8222-222222222222", "Expected different-scope job identity to be preserved.");
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
      listJobs: async () => [{
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

Deno.test("Edge read routes ignore client-supplied org IDs and use the authenticated org", async () => {
  const orgFromAuth = "org-from-auth";
  const orgFromParams = "org-from-params";
  const jobId = "11111111-1111-4111-8111-111111111111";
  const calls: string[] = [];
  const sourceBox = {
    id: "source-record",
    boxId: "ORG-B-BOX",
    warehouse: "IL1",
    status: "IN_STOCK",
    feetAvailable: 100,
    physicalFeetAvailable: 100,
    widthIn: 36,
  };

  function record(label: string, orgId: string) {
    calls.push(`${label}:${orgId}`);
    if (orgId !== orgFromAuth) {
      throw new Error(`Expected ${label} to use authenticated org ${orgFromAuth}, received ${orgId}.`);
    }
  }

  const deps = {
    asTrimmedString: (value: unknown) => String(value || "").trim(),
    requireString: (value: unknown, fieldName: string) => {
      const trimmed = String(value || "").trim();
      if (!trimmed) {
        throw new Error(`${fieldName} is required.`);
      }
      return trimmed;
    },
    integerOrZero: (value: unknown) => {
      const numberValue = Number(value);
      return Number.isFinite(numberValue) ? Math.trunc(numberValue) : 0;
    },
    normalizeDateString: (value: unknown) => String(value || "").trim(),
    normalizeCrewLeaderKey: (value: unknown) => String(value || "").trim().toLowerCase(),
    normalizeJobNumberDigits: (value: unknown) => String(value || "").replace(/[^0-9]/g, ""),
    normalizeJobLifecycleStatus: () => "ACTIVE",
    parseCrossWarehouseFlag: (value: unknown) => value === true || String(value || "").toLowerCase() === "true",
    buildActiveAllocationsByBoxIndex: () => ({}),
    buildSearchBoxes: async (_client: unknown, orgId: string, params: Record<string, unknown>) => {
      record("buildSearchBoxes", orgId);
      return { entries: [{ boxId: params.q }] };
    },
    findBoxById: async (_client: unknown, orgId: string, boxIdValue: string) => {
      record(`findBoxById:${boxIdValue}`, orgId);
      return { ...sourceBox, boxId: boxIdValue };
    },
    listAllocationsByBox: async (_client: unknown, orgId: string, boxIdValue: string) => {
      record(`listAllocationsByBox:${boxIdValue}`, orgId);
      return [];
    },
    buildBoxFilmOrderOrigins: async (_client: unknown, orgId: string, boxIdValue: string) => {
      record(`buildBoxFilmOrderOrigins:${boxIdValue}`, orgId);
      return [];
    },
    toPublicBox: (box: Record<string, unknown>) => ({ boxId: box.boxId }),
    toPublicAllocation: (entry: Record<string, unknown>) => entry,
    buildJobDetailById: async (_client: unknown, orgId: string, jobIdValue: unknown) => {
      record(`buildJobDetailById:${String(jobIdValue)}`, orgId);
      return { jobId: jobIdValue };
    },
    buildJobsList: async (_client: unknown, orgId: string) => {
      record("buildJobsList", orgId);
      return [{ jobId: "org-a-job" }];
    },
    buildFilmOrdersList: async (_client: unknown, orgId: string) => {
      record("buildFilmOrdersList", orgId);
      return [{ filmOrderId: "org-a-film-order" }];
    },
    buildFilmOrderDetail: async (_client: unknown, orgId: string, filmOrderId: unknown) => {
      record(`buildFilmOrderDetail:${String(filmOrderId)}`, orgId);
      return { filmOrderId };
    },
    listFilmWeightProfiles: async (_client: unknown, orgId: string) => {
      record("listFilmWeightProfiles", orgId);
      return [{ profileId: "org-a-profile" }];
    },
    listOpenFilmWeightPendingReviews: async (_client: unknown, orgId: string) => {
      record("listOpenFilmWeightPendingReviews", orgId);
      return [{ reviewId: "org-a-review" }];
    },
    buildReportsSummary: async (_client: unknown, orgId: string, params: Record<string, unknown>) => {
      record("buildReportsSummary", orgId);
      return { reportType: params.reportType || "most-used-film" };
    },
    listAuditEntriesByBox: async (_client: unknown, orgId: string, boxIdValue: string) => {
      record(`listAuditEntriesByBox:${boxIdValue}`, orgId);
      return [];
    },
    rpcOrThrow: async (_client: unknown, fn: string, params: Record<string, unknown>) => {
      record(`rpcOrThrow:${fn}:${String(params.p_org_id)}`, String(params.p_org_id));
      if (fn === "api_acl_list_warehouses") {
        return [{ code: "IL1", name: "Wauconda IL1", box_id_prefix: "IL1" }];
      }
      if (fn === "api_acl_owner_companies_list") {
        return [{
          owner_company_id: "owner-a",
          code: "OWN",
          display_name: "Owner A",
          lookup_key: "owner-a",
          is_active: true,
        }];
      }
      return [];
    },
    resolveJobContext: async (_client: unknown, orgId: string, jobNumber: unknown) => {
      record(`resolveJobContext:${String(jobNumber)}`, orgId);
      return { jobNumber: String(jobNumber || ""), installDate: "", crewLeader: "" };
    },
    resolveAllocationJobWarehouse: async (_client: unknown, orgId: string, jobNumber: unknown) => {
      record(`resolveAllocationJobWarehouse:${String(jobNumber)}`, orgId);
      return "IL1";
    },
    listBoxes: async (_client: unknown, orgId: string) => {
      record("listBoxes", orgId);
      return [sourceBox];
    },
    listBoxesByWarehouses: async (_client: unknown, orgId: string, warehouses: string[]) => {
      record(`listBoxesByWarehouses:${warehouses.join(",")}`, orgId);
      return [sourceBox];
    },
    listJobRequirementsByJob: async (_client: unknown, orgId: string, jobNumber: string) => {
      record(`listJobRequirementsByJob:${jobNumber}`, orgId);
      return [];
    },
    listJobRequirementsByJobId: async (_client: unknown, orgId: string, selectedJobId: string) => {
      record(`listJobRequirementsByJobId:${selectedJobId}`, orgId);
      return [];
    },
    listActiveAllocations: async (_client: unknown, orgId: string) => {
      record("listActiveAllocations", orgId);
      return [];
    },
    buildPendingTransfersByBoxRecordId: async (_client: unknown, orgId: string) => {
      record("buildPendingTransfersByBoxRecordId", orgId);
      return {};
    },
    buildAllocationPreviewPlan: (_source: unknown, _requestedFeet: unknown, jobContext: unknown, options: any) => ({
      jobContext,
      allBoxIds: options.allBoxes.map((box: Record<string, unknown>) => box.boxId),
    }),
  } as any;

  const routeCases = [
    {
      route: "/boxes/search",
      params: { q: "ORG-B-BOX", orgId: orgFromParams, organizationId: orgFromParams },
      expectedCalls: ["buildSearchBoxes:org-from-auth"],
    },
    {
      route: "/boxes/get",
      params: { boxId: "ORG-B-BOX", orgId: orgFromParams, organizationId: orgFromParams },
      expectedCalls: [
        "findBoxById:ORG-B-BOX:org-from-auth",
        "listAllocationsByBox:ORG-B-BOX:org-from-auth",
        "buildBoxFilmOrderOrigins:ORG-B-BOX:org-from-auth",
      ],
    },
    {
      route: "/jobs/get-by-id",
      params: { jobId, orgId: orgFromParams, organizationId: orgFromParams },
      expectedCalls: [`buildJobDetailById:${jobId}:org-from-auth`],
    },
    {
      route: "/jobs/list",
      params: { orgId: orgFromParams, organizationId: orgFromParams },
      expectedCalls: ["buildJobsList:org-from-auth"],
    },
    {
      route: "/film-orders/list",
      params: { orgId: orgFromParams, organizationId: orgFromParams },
      expectedCalls: ["buildFilmOrdersList:org-from-auth"],
    },
    {
      route: "/film-orders/get",
      params: { filmOrderId: "ORG-B-ORDER", orgId: orgFromParams, organizationId: orgFromParams },
      expectedCalls: ["buildFilmOrderDetail:ORG-B-ORDER:org-from-auth"],
    },
    {
      route: "/warehouses/list",
      params: { orgId: orgFromParams, organizationId: orgFromParams },
      expectedCalls: ["rpcOrThrow:api_acl_list_warehouses:org-from-auth:org-from-auth"],
    },
    {
      route: "/owner-companies/list",
      params: { orgId: orgFromParams, organizationId: orgFromParams, includeInactive: true },
      expectedCalls: ["rpcOrThrow:api_acl_owner_companies_list:org-from-auth:org-from-auth"],
    },
    {
      route: "/reports/summary",
      params: { reportType: "most-used-film", orgId: orgFromParams, organizationId: orgFromParams },
      expectedCalls: ["buildReportsSummary:org-from-auth"],
    },
    {
      route: "/film-weight/profiles",
      params: { orgId: orgFromParams, organizationId: orgFromParams },
      expectedCalls: ["listFilmWeightProfiles:org-from-auth"],
    },
    {
      route: "/film-weight/pending-reviews",
      params: { orgId: orgFromParams, organizationId: orgFromParams },
      expectedCalls: ["listOpenFilmWeightPendingReviews:org-from-auth"],
    },
    {
      route: "/audit/by-box",
      params: { boxId: "ORG-B-BOX", orgId: orgFromParams, organizationId: orgFromParams },
      expectedCalls: ["listAuditEntriesByBox:ORG-B-BOX:org-from-auth"],
    },
    {
      route: "/allocations/by-box",
      params: { boxId: "ORG-B-BOX", orgId: orgFromParams, organizationId: orgFromParams },
      expectedCalls: [
        "listAllocationsByBox:ORG-B-BOX:org-from-auth",
        "findBoxById:ORG-B-BOX:org-from-auth",
      ],
    },
    {
      route: "/allocations/preview",
      params: {
        boxId: "ORG-B-BOX",
        jobNumber: "81234",
        requestedFeet: 10,
        orgId: orgFromParams,
        organizationId: orgFromParams,
      },
      expectedCalls: [
        "findBoxById:ORG-B-BOX:org-from-auth",
        "resolveJobContext:81234:org-from-auth",
        "resolveAllocationJobWarehouse:81234:org-from-auth",
        "listBoxesByWarehouses:IL1:org-from-auth",
        "listActiveAllocations:org-from-auth",
        "buildPendingTransfersByBoxRecordId:org-from-auth",
      ],
    },
  ];

  for (const routeCase of routeCases) {
    calls.length = 0;
    await dispatchReadWithHandlers(
      {},
      orgFromAuth,
      routeCase.route,
      routeCase.params,
      { orgId: orgFromAuth, actor: "tester", role: "owner" } as any,
      deps,
    );
    assertEquals(calls, routeCase.expectedCalls, `Expected ${routeCase.route} to use only the auth-derived org.`);
  }
});
