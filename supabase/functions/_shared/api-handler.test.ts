import {
  buildAllocationJobList,
  buildJobListEntry,
  buildJobsList,
  buildPublicCaulkRequirementEntries,
  buildPublicJobRequirementEntries,
  buildJobDetailById,
  canonicalizeMutationPayloadForRoute,
  fetchWarehouseBoxRowsForInventory,
  loadCheckedOutJobBoxRows,
  loadCaulkPlanningByJobContexts,
  maybeLogCaulkFallbackCoverageDecision,
  shouldUseCache,
  statusFromRpcError,
  toSafeDeleteJobError,
} from "./api-handler.ts";
import { HttpError } from "./http.ts";
import { createInventoryRepositories } from "./repositories/inventoryRepositories.ts";
import { dispatchReadWithHandlers } from "./routes/readHandlers.ts";

function assertEquals(actual: unknown, expected: unknown, message: string) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}\nExpected: ${expectedJson}\nActual: ${actualJson}`);
  }
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          canonicalizeJsonValue((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  return value;
}

async function hashCanonicalJson(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalizeJsonValue(value)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (entry) => entry.toString(16).padStart(2, "0")).join("");
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

Deno.test("Delete Job preflight loads only tenant-scoped checked-out box identity columns", async () => {
  const calls: Array<[string, ...unknown[]]> = [];
  const rows = [{
    box_id: "box-category-only",
    status: "CHECKED_OUT",
    last_checkout_job: "000123",
    last_checkout_job_id: null,
  }];
  const query = {
    select(columns: string) {
      calls.push(["select", columns]);
      return this;
    },
    eq(column: string, value: unknown) {
      calls.push(["eq", column, value]);
      return this;
    },
    then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    },
  };
  const serviceClient = {
    schema(schemaName: string) {
      calls.push(["schema", schemaName]);
      return {
        from(tableName: string) {
          calls.push(["from", tableName]);
          return query;
        },
      };
    },
  };

  const result = await loadCheckedOutJobBoxRows(serviceClient, "tenant-category-only");

  assertEquals(result, rows, "Expected the bounded preflight rows to pass through unchanged.");
  assertEquals(calls, [
    ["schema", "app"],
    ["from", "boxes"],
    ["select", "box_id, status, last_checkout_job, last_checkout_job_id"],
    ["eq", "org_id", "tenant-category-only"],
    ["eq", "status", "CHECKED_OUT"],
  ], "Expected Delete Job preflight to avoid the full box-list projection.");
});

Deno.test("Delete Job failure boundary preserves business denials and redacts storage details", () => {
  const businessDenial = new HttpError(400, "Checked-out material must be accounted for first.");
  assertEquals(
    toSafeDeleteJobError(businessDenial),
    businessDenial,
    "Expected intentional 4xx denials to retain their public contract.",
  );

  const storageFailure = new HttpError(500, "canceling statement due to statement timeout");
  const safeFailure = toSafeDeleteJobError(storageFailure);
  assertEquals(safeFailure.statusCode, 500, "Expected unexpected Delete Job failures to remain HTTP 500.");
  assertEquals(
    safeFailure.message,
    "The job could not be deleted. Refresh the job and try again.",
    "Expected a stable public Delete Job failure message.",
  );
  assertEquals(
    safeFailure.name,
    "DeleteJobOperationError",
    "Expected categorical internal timing evidence without storage details.",
  );
  if (safeFailure.message.includes("statement timeout")) {
    throw new Error("Delete Job storage details must not cross the public error boundary.");
  }
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

Deno.test("Edge allocation preview repository performs one bounded ACL RPC and preserves canonical state", async () => {
  const calls: Array<{ fn: string; params: Record<string, unknown> }> = [];
  const repositories = createInventoryRepositories({
    rpcOrThrow: async <T>(
      _client: unknown,
      fn: string,
      params: Record<string, unknown> = {},
    ): Promise<T> => {
      calls.push({ fn, params });
      return {
        source: {
          id: "source-record",
          orgId: "org-1",
          boxId: "IL1-SOURCE",
          warehouse: "IL1",
          manufacturer: "Llumar",
          filmName: "RN 07",
          widthIn: 48,
          status: "IN_STOCK",
          feetAvailable: 20,
          physicalFeetAvailable: 20,
          allocatableNowFeet: 20,
        },
        boxes: [{
          id: "candidate-record",
          orgId: "org-1",
          boxId: "MS1-CANDIDATE",
          warehouse: "MS1",
          manufacturer: "Llumar",
          filmName: "RN 07",
          widthIn: 48,
          status: "IN_STOCK",
          feetAvailable: 50,
          physicalFeetAvailable: 50,
          allocatableNowFeet: 50,
        }],
        allocations: [{ allocationId: "ALLOC-1", boxId: "IL1-SOURCE", status: "ACTIVE" }],
        pendingTransfersByBoxRecordId: {},
        candidateMetadata: [{ boxId: "MS1-CANDIDATE", eligible: true, requiresTransfer: true, reason: "" }],
        context: { jobWarehouse: "IL1", requestedFeet: 70, crossWarehouse: true },
        scope: { coarseCandidateCount: 1, candidateCount: 1 },
      } as T;
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
  const payload = {
    boxId: "IL1-SOURCE",
    jobId: "11111111-1111-4111-8111-111111111111",
    requestedFeet: 70,
    crossWarehouse: true,
  };

  const snapshot = await repositories.loadAllocationPreviewCandidateSnapshot(
    {} as any,
    "org-1",
    payload,
  );

  assertEquals(
    calls,
    [{
      fn: "api_acl_allocation_preview_candidates",
      params: { p_org_id: "org-1", p_payload: payload },
    }],
    "Expected one bounded ACL RPC with the authenticated org.",
  );
  assertEquals(snapshot.source.boxId, "IL1-SOURCE", "Expected the canonical source box.");
  assertEquals(snapshot.boxes.map((entry: any) => entry.boxId), ["MS1-CANDIDATE"], "Expected bounded candidates.");
  assertEquals(snapshot.scope, { coarseCandidateCount: 1, candidateCount: 1 }, "Expected safe scope metadata.");
});

Deno.test("Edge repositories use bounded job-header and summary RPCs", async () => {
  const calls: Array<{ fn: string; params: Record<string, unknown> }> = [];
  const repositories = createInventoryRepositories({
    rpcOrThrow: async <T>(_client: unknown, fn: string, params: Record<string, unknown> = {}) => {
      calls.push({ fn, params });
      if (fn === "api_acl_list_jobs_by_ids") {
        return [{ id: "11111111-1111-4111-8111-111111111111", job_number: "4953" }] as T;
      }
      if (fn === "api_acl_job_summary_snapshot") {
        return {
          allocations: [{ allocation_id: "allocation-safe", job_number: "4953", allocated_feet: 10 }],
          filmOrders: [],
          phases: [],
          requirements: [],
        } as T;
      }
      if (fn === "api_acl_has_film_orders_needing_attention") {
        return true as T;
      }
      return [] as T;
    },
    asTrimmedString: (value: unknown) => String(value || "").trim(),
    numericOrNull: (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : null,
    integerOrZero: (value: unknown) => Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0,
    integerOrNull: (value: unknown) => Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : null,
    formatDateValue: (value: unknown) => String(value || "").trim(),
    formatTimestamp: (value: unknown) => String(value || "").trim(),
    listInternalBoxRecordIdsByBoxId: async () => ({}),
  });

  const jobs = await repositories.listJobsByIds({}, "org-1", [
    "11111111-1111-4111-8111-111111111111",
    "11111111-1111-4111-8111-111111111111",
  ]);
  const snapshot = await repositories.loadJobSummarySnapshot(
    {},
    "org-1",
    ["11111111-1111-4111-8111-111111111111"],
    { includeLegacy: true, legacyJobNumbers: ["4953"], includePhases: false },
  );
  const attention = await repositories.hasFilmOrdersNeedingAttention({}, "org-1");

  assertEquals(jobs.map((entry: any) => entry.jobNumber), ["4953"], "Expected mapped bounded job headers.");
  assertEquals(
    snapshot.allocations.map((entry: any) => entry.allocationId),
    ["allocation-safe"],
    "Expected mapped bounded summary rows.",
  );
  assertEquals(attention, true, "Expected the boolean attention result.");
  assertEquals(calls, [
    {
      fn: "api_acl_list_jobs_by_ids",
      params: {
        p_org_id: "org-1",
        p_job_ids: ["11111111-1111-4111-8111-111111111111"],
      },
    },
    {
      fn: "api_acl_job_summary_snapshot",
      params: {
        p_org_id: "org-1",
        p_job_ids: ["11111111-1111-4111-8111-111111111111"],
        p_include_legacy: true,
        p_legacy_job_numbers: ["4953"],
        p_include_phases: false,
      },
    },
    {
      fn: "api_acl_has_film_orders_needing_attention",
      params: { p_org_id: "org-1" },
    },
  ], "Expected exact authenticated bounded RPC calls.");
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

Deno.test("fetchWarehouseBoxRowsForInventory pushes exact status exclusions into PostgREST", async () => {
  const filters: Array<[string, string, unknown]> = [];
  const client = {
    schema() {
      return {
        from() {
          const query = {
            select() {
              return query;
            },
            eq(column: string, value: unknown) {
              filters.push(["eq", column, value]);
              return query;
            },
            neq(column: string, value: unknown) {
              filters.push(["neq", column, value]);
              return query;
            },
            in() {
              return query;
            },
            order() {
              return query;
            },
            range() {
              return Promise.resolve({ data: [], error: null });
            },
          };
          return query;
        },
      };
    },
  };

  await fetchWarehouseBoxRowsForInventory(client, "org-1", ["IL1"], 1000, {
    excludeStatuses: ["ZEROED", "RETIRED", "ZEROED"],
  });
  assertEquals(
    filters,
    [
      ["eq", "org_id", "org-1"],
      ["neq", "status", "ZEROED"],
      ["neq", "status", "RETIRED"],
    ],
    "Expected inactive statuses to be removed before rows cross the database boundary.",
  );
});

Deno.test("Edge scope enrichment batches canonical job headers", async () => {
  const jobIds = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ];
  const calls: string[] = [];
  const response = await dispatchReadWithHandlers(
    {},
    "org-1",
    "/caulk/transfers/list",
    { warehouse: "ALL" },
    {} as any,
    {
      rpcOrThrow: async () => jobIds.map((jobId, index) => ({
        transfer_id: `TR-${index + 1}`,
        job_id: jobId,
        job_number: String(index + 1),
        job_warehouse: "IL1",
      })),
      asTrimmedString: (value: unknown) => String(value || "").trim(),
      integerOrZero: (value: unknown) => Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0,
      listJobsByIds: async (_client: unknown, orgId: string, selectedIds: string[]) => {
        calls.push(`batch:${orgId}:${selectedIds.length}`);
        return selectedIds.map((id, index) => ({ id, sections: `Scope ${index + 1}` }));
      },
      findJobById: async () => {
        throw new Error("Per-job lookup must not run when the batch reader is available.");
      },
    } as any,
  );

  assertEquals(calls, ["batch:org-1:2"], "Expected one canonical job-header batch.");
  assertEquals(
    (response.data as any).entries.map((entry: any) => entry.workScope),
    ["Scope 1", "Scope 2"],
    "Expected each batched header to enrich its matching row.",
  );
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

Deno.test("/allocations/preview uses one bounded candidate snapshot when crossWarehouse is false", async () => {
  const calls: string[] = [];
  const source = { boxId: "IL1-SOURCE", warehouse: "IL1", id: "source-record" };
  const candidate = { boxId: "IL1-CANDIDATE", warehouse: "IL1", id: "candidate-record" };

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
      asTrimmedString: (value: unknown) => String(value || "").trim(),
      loadAllocationPreviewCandidateSnapshot: async (
        _client: unknown,
        orgId: string,
        payload: Record<string, unknown>,
      ) => {
        calls.push(`boundedSnapshot:${orgId}:${String(payload.crossWarehouse)}`);
        return {
          source,
          boxes: [candidate],
          allocations: [],
          pendingTransfersByBoxRecordId: {},
          context: {
            requestedFeet: 1,
            requestedWidthIn: 48,
            crossWarehouse: false,
            jobWarehouse: "IL1",
            jobContext: { jobNumber: "4803", jobDate: "", crewLeader: "" },
            requirementState: {},
            phaseState: {},
          },
        };
      },
      buildCapacityAllocationsByBoxIndex: () => ({}),
      buildAllocationPreviewPlan: (_source: unknown, _requestedFeet: unknown, _jobContext: unknown, options: any) => ({
        allBoxIds: options.allBoxes.map((box: any) => box.boxId),
        crossWarehouse: options.crossWarehouse,
      }),
    } as any,
  );

  assertEquals(
    calls,
    ["boundedSnapshot:org-1:false"],
    "Expected non-cross preview to use one auth-scoped bounded snapshot.",
  );
  assertEquals(
    response.data,
    { allBoxIds: ["IL1-CANDIDATE"], crossWarehouse: false },
    "Expected route to pass only bounded candidates into the planner.",
  );
});

Deno.test("/allocations/preview uses canonical jobId and requirement context returned by the bounded RPC", async () => {
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
      asTrimmedString: (value: unknown) => String(value || "").trim(),
      loadAllocationPreviewCandidateSnapshot: async (
        _client: unknown,
        orgId: string,
        payload: Record<string, unknown>,
      ) => {
        calls.push(`boundedSnapshot:${orgId}:${String(payload.jobId)}`);
        return {
          source,
          boxes: [],
          allocations: [],
          pendingTransfersByBoxRecordId: {},
          context: {
            requestedFeet: 1,
            requestedWidthIn: 48,
            crossWarehouse: false,
            jobWarehouse: "IL1",
            jobContext: { jobId, jobNumber: "4803", jobDate: "", crewLeader: "" },
            requirementState: {
              id: "req-1",
              jobId,
              manufacturer: "Llumar",
              filmName: "RN 07",
              widthIn: 48,
            },
            phaseState: {},
          },
        };
      },
      buildCapacityAllocationsByBoxIndex: () => ({}),
      buildAllocationPreviewPlan: (_source: unknown, _requestedFeet: unknown, jobContext: unknown, options: any) => ({
        jobContext,
        selectedRequirementId: options.selectedRequirement?.id,
      }),
    } as any,
  );

  assertEquals(
    calls,
    [`boundedSnapshot:org-1:${jobId}`],
    "Expected canonical preview to delegate auth-org job identity resolution to the bounded RPC.",
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
      asTrimmedString: (value: unknown) => String(value || "").trim(),
      loadAllocationPreviewCandidateSnapshot: async () => ({
        source,
        boxes: [],
        allocations: [],
        pendingTransfersByBoxRecordId: {},
        context: {
          requestedFeet: 1,
          requestedWidthIn: 48,
          crossWarehouse: false,
          jobWarehouse: "IL1",
          jobContext: { jobId, jobNumber: "4803", jobDate: "2026-06-15", crewLeader: "Phase Two" },
          requirementState: {
            id: "req-phase-2",
            jobId,
            phaseId,
            manufacturer: "Llumar",
            filmName: "RN 07",
            widthIn: 48,
          },
          phaseState: {
            id: phaseId,
            installDate: "2026-06-15",
            crewLeader: "Phase Two",
          },
        },
      }),
      buildCapacityAllocationsByBoxIndex: () => ({}),
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
      asTrimmedString: (value: unknown) => String(value || "").trim(),
      loadAllocationPreviewCandidateSnapshot: async () => ({
        source,
        boxes: [],
        allocations: [],
        pendingTransfersByBoxRecordId: {},
        context: {
          requestedFeet: 1,
          requestedWidthIn: 48,
          crossWarehouse: false,
          jobWarehouse: "IL1",
          jobContext: { jobId, jobNumber: "4803", jobDate: "", crewLeader: "" },
          requirementState: {
            id: "req-placeholder",
            jobId,
            phaseId,
            manufacturer: "Llumar",
            filmName: "RN 07",
            widthIn: 48,
          },
          phaseState: { id: phaseId, installDate: "", crewLeader: "" },
        },
      }),
      buildCapacityAllocationsByBoxIndex: () => ({}),
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

Deno.test("/allocations/preview preserves canonical bounded-RPC job identity denials", async () => {
  const sourceBoxId = "IL1-SOURCE";
  const rejectingDeps = (message: string) => ({
    asTrimmedString: (value: unknown) => String(value || "").trim(),
    loadAllocationPreviewCandidateSnapshot: async () => {
      throw new Error(message);
    },
  });

  await assertRejectsWithMessage(
    () => dispatchReadWithHandlers(
      {},
      "org-1",
      "/allocations/preview",
      { jobId: "not-a-uuid", boxId: sourceBoxId, jobNumber: "4803", requestedFeet: 1 },
      {} as any,
      rejectingDeps("jobId must be a valid UUID.") as any,
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
        boxId: sourceBoxId,
        jobNumber: "4803",
        requestedFeet: 1,
      },
      {} as any,
      rejectingDeps("Job was not found.") as any,
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
        boxId: sourceBoxId,
        jobNumber: "4803",
        requestedFeet: 1,
      },
      {} as any,
      rejectingDeps("Job identity mismatch: selected job does not match jobNumber.") as any,
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

Deno.test("Edge job summaries use the bounded org snapshot caulk loader", () => {
  const buildJobsListSource = buildJobsList.toString();
  const caulkPlanningSource = loadCaulkPlanningByJobContexts.toString();

  if (!caulkPlanningSource) {
    throw new Error("Expected Edge caulk planning helper for canonical job contexts to be present.");
  }
  if (!/loadJobsCaulkSummary\(orgId, jobContexts, jobNumberFilters/.test(caulkPlanningSource)) {
    throw new Error("Expected Edge /jobs/list caulk summaries to use the focused snapshot projector.");
  }
  if (!/loadRequirements:.*listJobCaulkRequirementsSnapshot\(/s.test(caulkPlanningSource)) {
    throw new Error("Expected Edge /jobs/list caulk requirements to use the org snapshot loader.");
  }
  if (!/loadAllocations:.*listCaulkJobAllocationsSnapshot\(/s.test(caulkPlanningSource)) {
    throw new Error("Expected Edge /jobs/list caulk allocations to use the org snapshot loader.");
  }
  if (/listJobCaulkRequirementsByJob\(|listCaulkJobAllocationsByJob\(|\.map\(async/.test(caulkPlanningSource)) {
    throw new Error("Expected Edge /jobs/list caulk planning not to issue per-job caulk queries.");
  }
  if (!/loadCaulkPlanningByJobContexts\(\s*client,\s*orgId,\s*jobContexts,\s*Array\.from\(jobNumberFilterSet\)/.test(buildJobsListSource)) {
    throw new Error("Expected Edge /jobs/list to pass canonical contexts and filters to caulk summary planning.");
  }
  if (!/jobContexts\s*=\s*caulkPlanning\.jobContexts/.test(buildJobsListSource)) {
    throw new Error("Expected Edge /jobs/list to preserve caulk-only legacy contexts from the bulk snapshot.");
  }
  if (!/contextJobId\s*\?\s*caulkPlanning\.requirementsByJobId\[contextJobId\]/.test(buildJobsListSource)) {
    throw new Error("Expected Edge /jobs/list to project caulk requirements by context jobId.");
  }
});

Deno.test("Edge jobs list keeps canonical allocation ownership separate from legacy fallback", () => {
  const buildJobsListSource = buildJobsList.toString();

  for (const expectedCall of [
    "groupEntriesByCanonicalJobId(allAllocations)",
    "groupEntriesByJobNumberFallback(allAllocations)",
    "getRowsForJobHeader(context.header, allocationsByJobId, legacyAllocationsByJobNumber",
  ]) {
    if (!buildJobsListSource.includes(expectedCall)) {
      throw new Error(`Expected Edge jobs list canonical ownership call: ${expectedCall}.`);
    }
  }

  if (/allAllocationsByJobNumber\[jobNumber\]/.test(buildJobsListSource)) {
    throw new Error("Expected canonical Edge job summaries not to read all job-number allocations directly.");
  }
});

Deno.test("Edge allocation job summaries preserve duplicate job-number rows by canonical job id", () => {
  const buildAllocationJobListSource = buildAllocationJobList.toString();

  if (!/let jobContexts = jobHeaders\.map/.test(buildAllocationJobListSource)) {
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

Deno.test("/allocations/preview keeps cross-warehouse reads bounded by the candidate RPC", async () => {
  const calls: string[] = [];
  const source = { boxId: "IL1-SOURCE", warehouse: "IL1", id: "source-record" };
  const candidate = { boxId: "MS1-CANDIDATE", warehouse: "MS1", id: "candidate-record" };

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
      asTrimmedString: (value: unknown) => String(value || "").trim(),
      loadAllocationPreviewCandidateSnapshot: async (_client: unknown, orgId: string) => {
        calls.push(`boundedSnapshot:${orgId}`);
        return {
          source,
          boxes: [candidate],
          allocations: [],
          pendingTransfersByBoxRecordId: {},
          context: {
            requestedFeet: 1,
            requestedWidthIn: 48,
            crossWarehouse: true,
            jobWarehouse: "IL1",
            jobContext: { jobNumber: "4803", jobDate: "", crewLeader: "" },
            requirementState: {},
            phaseState: {},
          },
        };
      },
      buildCapacityAllocationsByBoxIndex: () => ({}),
      buildAllocationPreviewPlan: (_source: unknown, _requestedFeet: unknown, _jobContext: unknown, options: any) => ({
        allBoxIds: options.allBoxes.map((box: any) => box.boxId),
        crossWarehouse: options.crossWarehouse,
      }),
    } as any,
  );

  assertEquals(calls, ["boundedSnapshot:org-1"], "Expected one auth-scoped bounded candidate read.");
  assertEquals(
    response.data,
    { allBoxIds: ["MS1-CANDIDATE"], crossWarehouse: true },
    "Expected route to pass the bounded cross-warehouse candidates into the planner.",
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
    buildCapacityAllocationsByBoxIndex: () => ({}),
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
    loadAllocationPreviewCandidateSnapshot: async (_client: unknown, orgId: string) => {
      record("loadAllocationPreviewCandidateSnapshot", orgId);
      return {
        source: sourceBox,
        boxes: [],
        allocations: [],
        pendingTransfersByBoxRecordId: {},
        context: {
          requestedFeet: 10,
          requestedWidthIn: 36,
          crossWarehouse: false,
          jobWarehouse: "IL1",
          jobContext: { jobNumber: "81234", jobDate: "", crewLeader: "" },
          requirementState: {},
          phaseState: {},
        },
      };
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
        "loadAllocationPreviewCandidateSnapshot:org-from-auth",
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

Deno.test("Edge Jobs summaries retain exact pre-refactor public shape and values", async () => {
  const header = (overrides: Record<string, unknown> = {}) => ({
    id: "job-1",
    jobNumber: "1234",
    warehouse: "IL1",
    workScope: "Area A",
    sections: "Area A",
    installDate: "",
    crewLeader: "Header Crew",
    lifecycleStatus: "ACTIVE",
    isLaborOnly: true,
    isStagedForPickup: false,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    notes: "",
    ...overrides,
  });
  const phase = (overrides: Record<string, unknown> = {}) => ({
    phaseId: "phase-1",
    phaseNumber: 1,
    workScope: "Area A",
    sections: "Area A",
    installDate: "2999-01-01",
    crewLeader: "",
    laborStatus: "ACTIVE",
    workflowStatus: "ACTIVE",
    isPrimary: true,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    ...overrides,
  });
  const build = ({
    job = header(),
    phases = [phase()],
    requirements = [],
    caulkRequirements = [],
    allocations = [],
    filmOrders = [],
  }: {
    job?: Record<string, unknown>;
    phases?: Array<Record<string, unknown>>;
    requirements?: any[];
    caulkRequirements?: any[];
    allocations?: any[];
    filmOrders?: any[];
  } = {}) => buildJobListEntry(
    job,
    requirements,
    allocations,
    filmOrders,
    caulkRequirements,
    {},
    { phases },
  );
  const cases = {
    currentPhase: build(),
    completion: build({
      phases: [
        phase({ laborStatus: "COMPLETE" }),
        phase({ phaseId: "phase-2", phaseNumber: 2, installDate: "2999-02-01" }),
      ],
    }),
    phaseCrew: build({ phases: [phase({ crewLeader: "Phase Crew" })] }),
    missingCrew: build({ job: header({ crewLeader: "" }) }),
    multipleSameDate: build({
      phases: [
        phase({ phaseId: "phase-2", phaseNumber: 2 }),
        phase({ phaseId: "phase-1", phaseNumber: 1 }),
      ],
    }),
    legacyFallback: build({
      job: header({ crewLeader: "" }),
      allocations: [{
        allocationId: "alloc-1",
        boxId: "IL1-1",
        jobNumber: "1234",
        status: "ACTIVE",
        allocationKind: "EXTRA",
        allocatedFeet: 1,
        installDate: "",
        crewLeader: "Legacy Crew",
      }],
    }),
  };
  const actual: Record<string, string> = {};
  for (const [name, value] of Object.entries(cases)) {
    actual[name] = await hashCanonicalJson(value);
  }
  assertEquals(actual, {
    currentPhase: "c79047c1be895752a930cac61429215c5a3c33a5055b09a96d63493d268e4742",
    completion: "64bd35e97a9b7d07c45eb266e5ed4d7a26e8340eb5ffaa3a94d54067b4d9a142",
    phaseCrew: "0d16f74e4ddbd28289ad933ac3374cb8a96fa4fb3f31c0067d1e5c7f96bc5b6b",
    missingCrew: "d2e68b10dfd34218aa50de13c86b0222c36d27e17ec7fcd806d298c9f34314c1",
    multipleSameDate: "d8b0603cee2841996c9309447619e258fbf8f2668fa02f17d85a29c06bb1745a",
    legacyFallback: "98c71bbe32bb66ef2140ec47f6b94b314a141d55a63262fca1d07aaae6425f23",
  }, "Expected exact canonical Jobs-summary parity.");
});
