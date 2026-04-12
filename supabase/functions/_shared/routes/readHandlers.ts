// Purpose: Route-handler map for Edge API read endpoints.
import { HttpError, ok } from "../http.ts";
import type { AuthIdentity } from "../types.ts";

type ReadContext = {
  client: any;
  orgId: string;
  logicalPath: string;
  params: Record<string, unknown>;
  identity: AuthIdentity;
};

type JobContext = {
  jobNumber: string;
  installDate: string;
  crewLeader: string;
};

export type ReadHandlerDeps = {
  buildAppAttentionSummary: (
    client: any,
    orgId: string,
    identity: AuthIdentity,
  ) => Promise<Record<string, unknown>>;
  asTrimmedString: (value: unknown) => string;
  requireString: (value: unknown, fieldName: string) => string;
  integerOrZero: (value: unknown) => number;
  rpcOrThrow: <T>(client: any, fn: string, params?: Record<string, unknown>) => Promise<T>;
  enrichAdminPermissionEntries: (entriesRaw: unknown[]) => Promise<Record<string, unknown>[]>;
  buildSearchBoxes: (client: any, orgId: string, params: Record<string, unknown>) => Promise<unknown>;
  findBoxById: (client: any, orgId: string, boxId: string) => Promise<any>;
  getBoxTransferByBox: (client: any, orgId: string, boxId: string) => Promise<Record<string, unknown>>;
  toPublicBox: (box: any) => Record<string, unknown>;
  listAudit: (client: any, orgId: string, params: Record<string, unknown>) => Promise<unknown[]>;
  listAuditEntriesByBox: (client: any, orgId: string, boxId: string) => Promise<unknown[]>;
  listAllocationsByBox: (client: any, orgId: string, boxId: string) => Promise<unknown[]>;
  toPublicAllocation: (entry: any) => Record<string, unknown>;
  buildAllocationJobList: (client: any, orgId: string) => Promise<unknown[]>;
  buildAllocationJobDetail: (client: any, orgId: string, jobNumber: unknown) => Promise<Record<string, unknown>>;
  buildAllocationPreviewPlan: (
    source: any,
    requestedFeet: unknown,
    jobContext: JobContext,
    options: {
      crossWarehouse: boolean;
      minimumWidthIn?: unknown;
      allBoxes: any[];
      activeAllocationsByBox: Record<string, any[]>;
      selectedRequirement?: any;
      jobWarehouse?: string;
      pendingTransfersByBoxRecordId?: Record<string, any>;
    },
  ) => Record<string, unknown>;
  normalizeOptionalWarehouse: (value: unknown, fieldName?: string) => string;
  resolveAllocationJobWarehouse: (
    client: any,
    orgId: string,
    jobNumber: unknown,
    explicitJobWarehouse: unknown,
  ) => Promise<string>;
  resolveJobContext: (
    client: any,
    orgId: string,
    jobNumber: unknown,
    installDate: unknown,
    crewLeader: unknown,
  ) => Promise<JobContext>;
  parseCrossWarehouseFlag: (value: unknown) => boolean;
  listBoxes: (client: any, orgId: string) => Promise<any[]>;
  buildPendingTransfersByBoxRecordId: (
    client: any,
    orgId: string,
    boxes: any[],
  ) => Promise<Record<string, any>>;
  listJobRequirementsByJob: (client: any, orgId: string, jobNumber: string) => Promise<any[]>;
  buildActiveAllocationsByBoxIndex: (entries: any[]) => Record<string, any[]>;
  listActiveAllocations: (client: any, orgId: string) => Promise<any[]>;
  buildJobsList: (
    client: any,
    orgId: string,
    limit: number,
    lifecycleStatus?: unknown,
    jobNumbers?: unknown,
  ) => Promise<unknown[]>;
  buildJobsCalendar: (
    client: any,
    orgId: string,
    view: unknown,
    anchorDate: unknown,
    month: unknown,
    lifecycleStatus?: unknown
  ) => Promise<unknown[]>;
  buildJobsSearchResults: (
    client: any,
    orgId: string,
    query: unknown,
    limit: number,
    lifecycleStatus?: unknown
  ) => Promise<unknown[]>;
  buildJobDetail: (client: any, orgId: string, jobNumber: unknown) => Promise<Record<string, unknown>>;
  buildFilmOrdersList: (client: any, orgId: string) => Promise<unknown[]>;
  buildFilmCatalog: (client: any, orgId: string) => Promise<unknown[]>;
  listRollHistoryByBox: (client: any, orgId: string, boxId: string) => Promise<unknown[]>;
  buildReportsSummary: (client: any, orgId: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  buildOwnerAssetTotalCost: (
    client: any,
    orgId: string,
    params: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
};

type ReadHandler = (
  context: ReadContext,
  deps: ReadHandlerDeps,
) => Promise<Record<string, unknown>>;

const readHandlers: Record<string, ReadHandler> = {
  "/app/attention-summary": async ({ client, orgId, identity }, deps) => {
    return ok(await deps.buildAppAttentionSummary(client, orgId, identity));
  },
  "/admin/access/requests": async ({ client, orgId, params }, deps) => {
    const status = deps.asTrimmedString(params.status);
    const entries = await deps.rpcOrThrow<any[]>(client, "api_list_access_requests", {
      p_org_id: orgId,
      p_status: status,
    });
    return ok({ entries: Array.isArray(entries) ? entries : [] });
  },
  "/admin/username-requests": async ({ client, orgId, params }, deps) => {
    const status = deps.asTrimmedString(params.status);
    const entries = await deps.rpcOrThrow<any[]>(client, "api_list_username_change_requests", {
      p_org_id: orgId,
      p_status: status,
    });
    return ok({ entries: Array.isArray(entries) ? entries : [] });
  },
  "/admin/member-permissions": async ({ client, orgId }, deps) => {
    const permissions = await deps.rpcOrThrow<Record<string, unknown>>(client, "api_get_member_feature_permissions", {
      p_org_id: orgId,
    });
    return ok({ permissions });
  },
  "/admin/user-permissions": async ({ client, orgId, params }, deps) => {
    const permissions = await deps.rpcOrThrow<Record<string, unknown>>(client, "api_get_user_feature_permissions", {
      p_org_id: orgId,
      p_user_id: deps.requireString(params.userId, "userId"),
    });
    return ok({ permissions });
  },
  "/owner/admin-permissions": async ({ client, orgId }, deps) => {
    const entriesRaw = await deps.rpcOrThrow<any[]>(client, "api_get_admin_feature_permissions", {
      p_org_id: orgId,
    });
    const entries = await deps.enrichAdminPermissionEntries(Array.isArray(entriesRaw) ? entriesRaw : []);
    return ok({ entries });
  },
  "/owner/notification-preferences": async ({ client, orgId }, deps) => {
    const preferences = await deps.rpcOrThrow<Record<string, unknown>>(client, "api_get_owner_notification_preferences", {
      p_org_id: orgId,
    });
    return ok(preferences);
  },
  "/warehouses/list": async ({ client, orgId }, deps) => {
    const entries = await deps.rpcOrThrow<any[]>(client, "api_acl_list_warehouses", {
      p_org_id: orgId,
    });
    return ok({
      entries: (entries || []).map((entry) => ({
        code: deps.asTrimmedString(entry.code).toUpperCase(),
        name: deps.asTrimmedString(entry.name),
        boxIdPrefix: deps.asTrimmedString(entry.box_id_prefix).toUpperCase(),
      })),
    });
  },
  "/caulk/manufacturers/list": async ({ client, orgId }, deps) => {
    const entriesRaw = await deps.rpcOrThrow<any[]>(client, "api_acl_list_caulk_manufacturers", {
      p_org_id: orgId,
    });
    const entries = (entriesRaw || []).map((entry) => ({
      manufacturerId: deps.asTrimmedString(entry.manufacturer_id),
      name: deps.asTrimmedString(entry.name),
      lookupKey: deps.asTrimmedString(entry.lookup_key),
      isActive: entry.is_active === true || String(entry.is_active).toLowerCase() === "true",
      updatedAt: deps.asTrimmedString(entry.updated_at),
    }));
    return ok({ entries });
  },
  "/caulk/products/list": async ({ client, orgId }, deps) => {
    const entriesRaw = await deps.rpcOrThrow<any[]>(client, "api_acl_list_caulk_products", {
      p_org_id: orgId,
    });
    const entries = (entriesRaw || []).map((entry) => ({
      productId: deps.asTrimmedString(entry.product_id),
      manufacturerId: deps.asTrimmedString(entry.manufacturer_id),
      manufacturer: deps.asTrimmedString(entry.manufacturer),
      productName: deps.asTrimmedString(entry.product_name),
      productCode: deps.asTrimmedString(entry.product_code),
      lookupKey: deps.asTrimmedString(entry.lookup_key),
      tubesPerCase: deps.integerOrZero(entry.tubes_per_case),
      isActive: entry.is_active === true || String(entry.is_active).toLowerCase() === "true",
      notes: deps.asTrimmedString(entry.notes),
      updatedAt: deps.asTrimmedString(entry.updated_at),
    }));
    return ok({ entries });
  },
  "/caulk/stock/list": async ({ client, orgId, params }, deps) => {
    const productIdFilter = deps.asTrimmedString(params.productId).toLowerCase();
    const entriesRaw = await deps.rpcOrThrow<any[]>(client, "api_acl_list_caulk_stock", {
      p_org_id: orgId,
      p_warehouse: deps.asTrimmedString(params.warehouse),
      p_manufacturer: deps.asTrimmedString(params.manufacturer),
      p_q: deps.asTrimmedString(params.q),
    });
    const entries = (entriesRaw || []).map((entry) => {
      const tubesOnHand = Math.max(0, deps.integerOrZero(entry.tubes_on_hand));
      const casesOnHand = Math.floor(tubesOnHand / 16);
      const looseTubes = Math.max(0, tubesOnHand - (casesOnHand * 16));
      return {
        warehouse: deps.asTrimmedString(entry.warehouse).toUpperCase(),
        productId: deps.asTrimmedString(entry.product_id),
        manufacturerId: deps.asTrimmedString(entry.manufacturer_id),
        manufacturer: deps.asTrimmedString(entry.manufacturer),
        productName: deps.asTrimmedString(entry.product_name),
        productCode: deps.asTrimmedString(entry.product_code),
        tubesPerCase: deps.integerOrZero(entry.tubes_per_case),
        tubesOnHand,
        casesOnHand,
        looseTubes,
        updatedAt: deps.asTrimmedString(entry.updated_at),
        updatedBy: deps.asTrimmedString(entry.updated_by),
      };
    }).filter((entry) => {
      if (!productIdFilter) {
        return true;
      }

      return entry.productId.toLowerCase() === productIdFilter;
    });
    return ok({ entries });
  },
  "/caulk/transactions/list": async ({ client, orgId, params }, deps) => {
    const entriesRaw = await deps.rpcOrThrow<any[]>(client, "api_acl_list_caulk_transactions", {
      p_org_id: orgId,
      p_warehouse: deps.asTrimmedString(params.warehouse),
      p_product_id: deps.asTrimmedString(params.productId) || null,
      p_limit: deps.integerOrZero(params.limit) > 0 ? deps.integerOrZero(params.limit) : 200,
    });
    const entries = (entriesRaw || []).map((entry) => ({
      transactionId: deps.asTrimmedString(entry.transaction_id),
      productId: deps.asTrimmedString(entry.product_id),
      warehouse: deps.asTrimmedString(entry.warehouse).toUpperCase(),
      manufacturer: deps.asTrimmedString(entry.manufacturer),
      productName: deps.asTrimmedString(entry.product_name),
      productCode: deps.asTrimmedString(entry.product_code),
      action: deps.asTrimmedString(entry.action),
      deltaTubes: deps.integerOrZero(entry.delta_tubes),
      resultingTubesOnHand: deps.integerOrZero(entry.resulting_tubes_on_hand),
      tubesPerCase: deps.integerOrZero(entry.tubes_per_case),
      reason: deps.asTrimmedString(entry.reason),
      notes: deps.asTrimmedString(entry.notes),
      transferId: deps.asTrimmedString(entry.transfer_id),
      sourceBoxId: deps.asTrimmedString(entry.source_box_id),
      createdAt: deps.asTrimmedString(entry.created_at),
      createdBy: deps.asTrimmedString(entry.created_by),
    }));
    return ok({ entries });
  },
  "/boxes/search": async ({ client, orgId, params }, deps) => {
    return ok(await deps.buildSearchBoxes(client, orgId, params));
  },
  "/boxes/get": async ({ client, orgId, params }, deps) => {
    const found = await deps.findBoxById(client, orgId, deps.requireString(params.boxId, "boxId"));
    if (!found) {
      throw new HttpError(404, "Box not found.");
    }
    return ok(deps.toPublicBox(found));
  },
  "/boxes/transfer/by-box": async ({ client, orgId, params }, deps) => {
    return await deps.getBoxTransferByBox(client, orgId, deps.requireString(params.boxId, "boxId"));
  },
  "/audit/list": async ({ client, orgId, params }, deps) => {
    return ok({ entries: await deps.listAudit(client, orgId, params) });
  },
  "/audit/by-box": async ({ client, orgId, params }, deps) => {
    return ok({ entries: await deps.listAuditEntriesByBox(client, orgId, deps.requireString(params.boxId, "boxId")) });
  },
  "/allocations/by-box": async ({ client, orgId, params }, deps) => {
    return ok({
      entries: (await deps.listAllocationsByBox(client, orgId, deps.requireString(params.boxId, "boxId"))).map(
        deps.toPublicAllocation,
      ),
    });
  },
  "/allocations/jobs": async ({ client, orgId }, deps) => {
    return ok({ entries: await deps.buildAllocationJobList(client, orgId) });
  },
  "/allocations/by-job": async ({ client, orgId, params }, deps) => {
    return ok(await deps.buildAllocationJobDetail(client, orgId, params.jobNumber));
  },
  "/allocations/preview": async ({ client, orgId, params }, deps) => {
    const source = await deps.findBoxById(client, orgId, deps.requireString(params.boxId, "BoxID"));
    if (!source) {
      throw new HttpError(404, "Box not found.");
    }
    const jobContext = await deps.resolveJobContext(
      client,
      orgId,
      params.jobNumber,
      params.installDate ?? params.jobDate,
      params.crewLeader,
    );
    const allBoxes = await deps.listBoxes(client, orgId);
    const jobWarehouse = await deps.resolveAllocationJobWarehouse(
      client,
      orgId,
      (jobContext as Record<string, unknown>).jobNumber,
      params.jobWarehouse,
    );
    const requirementId = deps.asTrimmedString(params.requirementId);
    const selectedRequirement = requirementId
      ? (
          await deps.listJobRequirementsByJob(
            client,
            orgId,
            deps.asTrimmedString((jobContext as Record<string, unknown>).jobNumber),
          )
        ).find((entry) => deps.asTrimmedString((entry as Record<string, unknown>).id) === requirementId) || null
      : null;
    if (requirementId && !selectedRequirement) {
      throw new HttpError(
        400,
        `Requirement ${requirementId} does not belong to job ${deps.asTrimmedString((jobContext as Record<string, unknown>).jobNumber)}.`,
      );
    }
    return ok(deps.buildAllocationPreviewPlan(
      source,
      params.requestedFeet,
      jobContext,
      {
        crossWarehouse: deps.parseCrossWarehouseFlag(params.crossWarehouse),
        minimumWidthIn: params.requestedWidthIn,
        allBoxes,
        activeAllocationsByBox: deps.buildActiveAllocationsByBoxIndex(await deps.listActiveAllocations(client, orgId)),
        selectedRequirement,
        jobWarehouse,
        pendingTransfersByBoxRecordId: await deps.buildPendingTransfersByBoxRecordId(client, orgId, [
          source,
          ...allBoxes,
        ]),
      },
    ));
  },
  "/jobs/list": async ({ client, orgId, params }, deps) => {
    const limitValue = Number(params.limit);
    const limit = Number.isFinite(limitValue) && limitValue >= 0 ? Math.floor(limitValue) : 25;
    const jobNumbers = Array.isArray(params.jobNumbers)
      ? params.jobNumbers
      : typeof params.jobNumbers === "string"
      ? [params.jobNumbers]
      : [];
    return ok({ entries: await deps.buildJobsList(client, orgId, limit, params.lifecycleStatus, jobNumbers) });
  },
  "/jobs/calendar": async ({ client, orgId, params }, deps) => {
    return ok({
      entries: await deps.buildJobsCalendar(
        client,
        orgId,
        params.view,
        params.anchorDate,
        params.month,
        params.lifecycleStatus
      )
    });
  },
  "/jobs/search": async ({ client, orgId, params }, deps) => {
    const limitValue = Number(params.limit);
    const limit = Number.isFinite(limitValue) && limitValue > 0 ? Math.floor(limitValue) : 25;
    return ok({
      entries: await deps.buildJobsSearchResults(
        client,
        orgId,
        params.query,
        limit,
        params.lifecycleStatus
      )
    });
  },
  "/jobs/get": async ({ client, orgId, params }, deps) => {
    return ok(await deps.buildJobDetail(client, orgId, params.jobNumber));
  },
  "/film-orders/list": async ({ client, orgId }, deps) => {
    return ok({ entries: await deps.buildFilmOrdersList(client, orgId) });
  },
  "/film-data/catalog": async ({ client, orgId }, deps) => {
    return ok({ entries: await deps.buildFilmCatalog(client, orgId) });
  },
  "/roll-history/by-box": async ({ client, orgId, params }, deps) => {
    return ok({ entries: await deps.listRollHistoryByBox(client, orgId, deps.requireString(params.boxId, "boxId")) });
  },
  "/reports/summary": async ({ client, orgId, params }, deps) => {
    return ok(await deps.buildReportsSummary(client, orgId, params));
  },
  "/owner/reports/asset-total-cost": async ({ client, orgId, params }, deps) => {
    return ok(await deps.buildOwnerAssetTotalCost(client, orgId, params));
  },
};

export async function dispatchReadWithHandlers(
  client: any,
  orgId: string,
  logicalPath: string,
  params: Record<string, unknown>,
  identity: AuthIdentity,
  deps: ReadHandlerDeps,
) {
  const handler = readHandlers[logicalPath];
  if (!handler) {
    throw new HttpError(404, `Route not found: ${logicalPath || "/"}`);
  }
  return await handler({ client, orgId, logicalPath, params, identity }, deps);
}
