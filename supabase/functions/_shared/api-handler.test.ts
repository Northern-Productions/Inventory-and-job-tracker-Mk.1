import { fetchWarehouseBoxRowsForInventory } from "./api-handler.ts";
import { dispatchReadWithHandlers } from "./routes/readHandlers.ts";

function assertEquals(actual: unknown, expected: unknown, message: string) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}\nExpected: ${expectedJson}\nActual: ${actualJson}`);
  }
}

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
