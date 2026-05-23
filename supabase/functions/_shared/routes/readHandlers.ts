// Purpose: Route-handler map for Edge API read endpoints.
import { HttpError, ok } from "../http.ts";
import type { AuthIdentity } from "../types.ts";
import { buildBoxReservationSnapshot } from "../../../../shared/domain/filmAllocationReservations.mjs";
import {
  buildJobDuplicateCheckResult,
  getJobDuplicateWorkScopeInput,
} from "../../../../shared/domain/jobDuplicateContract.mjs";
import {
  resolveLegacyJobNumberReadTargetFromHeaders,
} from "../../../../shared/domain/legacyJobNumberReadAmbiguity.mjs";

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
  findFilmOrderById: (client: any, orgId: string, filmOrderId: string) => Promise<any>;
  listFilmOrderLinksByBoxId: (client: any, orgId: string, boxId: string) => Promise<any[]>;
  getBoxTransferByBox: (client: any, orgId: string, boxId: string) => Promise<Record<string, unknown>>;
  getBoxTransferPlan: (client: any, orgId: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
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
    selectedJob?: any,
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
  listBoxesByWarehouses: (client: any, orgId: string, warehouses: string[]) => Promise<any[]>;
  buildPendingTransfersByBoxRecordId: (
    client: any,
    orgId: string,
    boxes: any[],
  ) => Promise<Record<string, any>>;
  listJobRequirementsByJob: (client: any, orgId: string, jobNumber: string) => Promise<any[]>;
  listJobRequirementsByJobId: (
    client: any,
    orgId: string,
    jobId: string,
    selectedJob?: any,
  ) => Promise<any[]>;
  buildActiveAllocationsByBoxIndex: (entries: any[]) => Record<string, any[]>;
  listActiveAllocations: (client: any, orgId: string) => Promise<any[]>;
  listJobs: (client: any, orgId: string) => Promise<any[]>;
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
  findJobByNumber: (client: any, orgId: string, jobNumber: string) => Promise<any>;
  findJobById: (client: any, orgId: string, jobId: string) => Promise<any>;
  normalizeJobNumberDigits: (value: unknown, fieldName?: string) => string;
  normalizeJobLifecycleStatus: (value: unknown) => "ACTIVE" | "COMPLETED" | "CANCELLED";
  normalizeDateString: (value: unknown, fieldName: string, allowEmpty: boolean) => string;
  normalizeCrewLeaderKey: (value: unknown) => string;
  buildJobDetail: (client: any, orgId: string, jobNumber: unknown) => Promise<Record<string, unknown>>;
  buildJobDetailById: (client: any, orgId: string, jobId: unknown) => Promise<Record<string, unknown>>;
  buildFilmOrdersList: (client: any, orgId: string) => Promise<unknown[]>;
  buildFilmOrderDetail: (client: any, orgId: string, filmOrderId: unknown) => Promise<Record<string, unknown>>;
  buildBoxFilmOrderOrigins: (client: any, orgId: string, boxId: string) => Promise<any[]>;
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireUuid(value: unknown, fieldName: string) {
  const normalized = String(value || "").trim();
  if (!UUID_PATTERN.test(normalized)) {
    throw new HttpError(400, `${fieldName} must be a valid UUID.`);
  }
  return normalized;
}

function isUuidLike(value: unknown) {
  return UUID_PATTERN.test(String(value || "").trim());
}

function asOptionalScopeFields(source: any, deps: ReadHandlerDeps) {
  const workScope = deps.asTrimmedString(source?.workScope ?? source?.sections);
  const sections = deps.asTrimmedString(source?.sections ?? source?.workScope);
  return {
    ...(workScope ? { workScope } : {}),
    ...(sections ? { sections } : {}),
  };
}

async function assertLegacyJobNumberReadIsUnambiguous(
  client: any,
  orgId: string,
  jobNumber: unknown,
  deps: ReadHandlerDeps,
) {
  const normalizedJobNumber = deps.requireString(jobNumber, "jobNumber");
  const jobs = await deps.listJobs(client, orgId);
  const target = resolveLegacyJobNumberReadTargetFromHeaders(jobs, normalizedJobNumber);

  if (target.kind === "ambiguous") {
    throw new HttpError(
      409,
      `Job number ${normalizedJobNumber} matches multiple jobs. Choose a Work Scope to continue.`,
      [],
      target.details,
    );
  }

  return target;
}

async function resolveAllocationPreviewJobContext(
  client: any,
  orgId: string,
  params: Record<string, unknown>,
  deps: ReadHandlerDeps,
): Promise<{ job: any; jobId: string; jobContext: JobContext }> {
  const jobIdText = deps.asTrimmedString(params.jobId);
  if (!jobIdText) {
    return {
      job: null,
      jobId: "",
      jobContext: await deps.resolveJobContext(
        client,
        orgId,
        params.jobNumber,
        params.installDate ?? params.jobDate,
        params.crewLeader,
      ),
    };
  }

  const jobId = requireUuid(jobIdText, "jobId");
  const job = await deps.findJobById(client, orgId, jobId);
  if (!job) {
    throw new HttpError(404, "Job was not found.");
  }

  const selectedJobNumber = deps.requireString(job.jobNumber, "JobNumber");
  const suppliedJobNumber = deps.requireString(params.jobNumber, "JobNumber");
  if (deps.asTrimmedString(selectedJobNumber).toUpperCase() !== deps.asTrimmedString(suppliedJobNumber).toUpperCase()) {
    throw new HttpError(400, "Job identity mismatch: selected job does not match jobNumber.");
  }

  if (deps.normalizeJobLifecycleStatus(job.lifecycleStatus) !== "ACTIVE") {
    throw new HttpError(400, `Job ${selectedJobNumber} is closed and cannot receive allocations.`);
  }

  const normalizedInstallDate = deps.normalizeDateString(
    params.installDate ?? params.jobDate,
    "Install Date",
    true,
  );
  const normalizedCrewLeader = deps.asTrimmedString(params.crewLeader);
  const existingInstallDate = deps.asTrimmedString(job.installDate);
  const existingCrewLeader = deps.asTrimmedString(job.crewLeader);

  if (existingInstallDate && normalizedInstallDate && existingInstallDate !== normalizedInstallDate) {
    throw new HttpError(400, "Install Date must stay the same for an existing Job Number.");
  }

  if (
    existingCrewLeader &&
    normalizedCrewLeader &&
    deps.normalizeCrewLeaderKey(existingCrewLeader) !== deps.normalizeCrewLeaderKey(normalizedCrewLeader)
  ) {
    throw new HttpError(400, "Crew Leader must stay the same for an existing Job Number.");
  }

  const resolvedInstallDate = normalizedInstallDate || existingInstallDate;
  const resolvedCrewLeader = normalizedCrewLeader || existingCrewLeader;
  if (resolvedInstallDate && !resolvedCrewLeader) {
    throw new HttpError(400, "Crew Leader is required when Install Date is set.");
  }

  return {
    job,
    jobId,
    jobContext: {
      jobNumber: selectedJobNumber,
      installDate: resolvedInstallDate,
      crewLeader: resolvedCrewLeader,
    },
  };
}

async function buildOrderedForJobsForBox(
  client: any,
  orgId: string,
  boxId: string,
  deps: ReadHandlerDeps,
) {
  const links = await deps.listFilmOrderLinksByBoxId(client, orgId, boxId);
  const orderedForJobs = [];
  const seen = new Set<string>();
  const jobHeaderById = new Map<string, any | null>();

  for (const link of Array.isArray(links) ? links : []) {
    const filmOrderId = deps.asTrimmedString(link?.filmOrderId);
    if (!filmOrderId) {
      continue;
    }

    const filmOrder = await deps.findFilmOrderById(client, orgId, filmOrderId);
    const jobId = deps.asTrimmedString(filmOrder?.jobId);
    const jobNumber = deps.asTrimmedString(filmOrder?.jobNumber);
    if (!jobNumber) {
      continue;
    }

    const key = `${filmOrderId}\u0000${jobNumber}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const orderedFeet =
      link?.orderedFeet === null || link?.orderedFeet === undefined || link?.orderedFeet === ""
        ? NaN
        : Number(link.orderedFeet);
    let scopeFields = asOptionalScopeFields(filmOrder, deps);
    if (!scopeFields.workScope && jobId && isUuidLike(jobId)) {
      if (!jobHeaderById.has(jobId)) {
        jobHeaderById.set(jobId, (await deps.findJobById(client, orgId, jobId)) || null);
      }
      scopeFields = asOptionalScopeFields(jobHeaderById.get(jobId), deps);
    }

    orderedForJobs.push({
      ...(jobId ? { jobId } : {}),
      jobNumber,
      ...scopeFields,
      filmOrderId,
      orderedFeet: Number.isFinite(orderedFeet) ? Math.max(0, Math.trunc(orderedFeet)) : null,
    });
  }

  return orderedForJobs;
}

async function buildLastCheckoutScopeForBox(
  client: any,
  orgId: string,
  box: any,
  deps: ReadHandlerDeps,
) {
  const checkoutJobId = deps.asTrimmedString(box?.lastCheckoutJobId);
  if (!checkoutJobId || !isUuidLike(checkoutJobId)) {
    return {};
  }

  return asOptionalScopeFields((await deps.findJobById(client, orgId, checkoutJobId)) || null, deps);
}

async function buildJobScopeFieldsByJobId(
  client: any,
  orgId: string,
  entries: unknown[],
  deps: ReadHandlerDeps,
) {
  const jobIds = [
    ...new Set(
      (Array.isArray(entries) ? entries : [])
        .map((entry) => deps.asTrimmedString((entry as Record<string, unknown>)?.jobId))
        .filter((jobId): jobId is string => Boolean(jobId) && isUuidLike(jobId))
    ),
  ];
  const scopeFieldsByJobId = new Map<string, Record<string, unknown>>();

  for (const jobId of jobIds) {
    scopeFieldsByJobId.set(jobId, asOptionalScopeFields((await deps.findJobById(client, orgId, jobId)) || null, deps));
  }

  return scopeFieldsByJobId;
}

function extractAuditCheckoutJobIdentity(
  entry: unknown,
  deps: ReadHandlerDeps,
): { jobId: string; jobNumber: string } | null {
  const auditEntry = entry as Record<string, unknown>;
  const snapshots = [
    auditEntry?.after as Record<string, unknown> | null | undefined,
    auditEntry?.before as Record<string, unknown> | null | undefined,
  ];

  for (const snapshot of snapshots) {
    const status = deps.asTrimmedString(snapshot?.status).toUpperCase();
    const jobId = deps.asTrimmedString(snapshot?.lastCheckoutJobId);
    const jobNumber = deps.asTrimmedString(snapshot?.lastCheckoutJob);
    if (status === "CHECKED_OUT" && jobId && isUuidLike(jobId) && jobNumber) {
      return { jobId, jobNumber };
    }
  }

  return null;
}

async function enrichAuditEntriesWithCheckoutJobIdentity(
  client: any,
  orgId: string,
  entries: unknown[],
  deps: ReadHandlerDeps,
) {
  const rows = Array.isArray(entries) ? entries : [];
  const identitiesByLogId = new Map<string, { jobId: string; jobNumber: string }>();
  const jobIds = new Set<string>();

  for (const entry of rows) {
    const identity = extractAuditCheckoutJobIdentity(entry, deps);
    if (!identity) {
      continue;
    }

    identitiesByLogId.set(deps.asTrimmedString((entry as Record<string, unknown>)?.logId), identity);
    jobIds.add(identity.jobId);
  }

  const jobHeaderById = new Map<string, any | null>();
  for (const jobId of jobIds) {
    jobHeaderById.set(jobId, (await deps.findJobById(client, orgId, jobId)) || null);
  }

  return rows.map((entry) => {
    const auditEntry = entry as Record<string, unknown>;
    const identity = identitiesByLogId.get(deps.asTrimmedString(auditEntry?.logId));
    if (!identity) {
      return entry;
    }

    const jobHeader = jobHeaderById.get(identity.jobId);
    const jobWarehouse = deps.asTrimmedString(jobHeader?.warehouse);
    return {
      ...auditEntry,
      jobId: identity.jobId,
      jobNumber: identity.jobNumber,
      ...(jobWarehouse ? { jobWarehouse } : {}),
      ...asOptionalScopeFields(jobHeader, deps),
    };
  });
}

const readHandlers: Record<string, ReadHandler> = {
  "/app/attention-summary": async ({ client, orgId, identity }, deps) => {
    const start = Date.now();

    try {
      const dbStart = Date.now();
      const summary = await deps.buildAppAttentionSummary(client, orgId, identity);
      console.log("DB TIME:", Date.now() - dbStart, "ms");

      return ok(summary);
    } catch (err) {
      console.error("ERROR /app/attention-summary:", err);
      throw err;
    } finally {
      console.log("TIMING /app/attention-summary:", Date.now() - start, "ms");
    }
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
  "/box-dealers/list": async ({ client, orgId }, deps) => {
    const entriesRaw = await deps.rpcOrThrow<any[]>(client, "api_acl_list_box_dealers", {
      p_org_id: orgId,
    });
    const entries = (entriesRaw || []).map((entry) => ({
      dealerId: deps.asTrimmedString(entry.dealer_id || entry.id),
      name: deps.asTrimmedString(entry.name),
      lookupKey: deps.asTrimmedString(entry.lookup_key),
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
      ...(deps.asTrimmedString(entry.job_id) ? { jobId: deps.asTrimmedString(entry.job_id) } : {}),
      ...(deps.asTrimmedString(entry.job_number) ? { jobNumber: deps.asTrimmedString(entry.job_number) } : {}),
      ...(deps.asTrimmedString(entry.job_warehouse)
        ? { jobWarehouse: deps.asTrimmedString(entry.job_warehouse).toUpperCase() }
        : {}),
      createdAt: deps.asTrimmedString(entry.created_at),
      createdBy: deps.asTrimmedString(entry.created_by),
    }));
    const scopeFieldsByJobId = await buildJobScopeFieldsByJobId(client, orgId, entries, deps);
    return ok({
      entries: entries.map((entry) => {
        const jobId = deps.asTrimmedString((entry as Record<string, unknown>).jobId);
        return {
          ...entry,
          ...(scopeFieldsByJobId.get(jobId) || {}),
        };
      }),
    });
  },
  "/caulk/transfers/list": async ({ client, orgId, params }, deps) => {
    const entriesRaw = await deps.rpcOrThrow<any[]>(client, "api_acl_list_caulk_transfers", {
      p_org_id: orgId,
      p_warehouse: deps.asTrimmedString(params.warehouse),
      p_product_id: deps.asTrimmedString(params.productId) || null,
    });
    const entries = (entriesRaw || []).map((entry) => ({
      transferId: deps.asTrimmedString(entry.transfer_id),
      caulkAllocationId: deps.asTrimmedString(entry.caulk_allocation_id),
      jobNumber: deps.asTrimmedString(entry.job_number),
      ...(deps.asTrimmedString(entry.job_id) ? { jobId: deps.asTrimmedString(entry.job_id) } : {}),
      jobWarehouse: deps.asTrimmedString(entry.job_warehouse).toUpperCase(),
      productId: deps.asTrimmedString(entry.product_id),
      manufacturerId: deps.asTrimmedString(entry.manufacturer_id),
      manufacturer: deps.asTrimmedString(entry.manufacturer),
      productName: deps.asTrimmedString(entry.product_name),
      productCode: deps.asTrimmedString(entry.product_code),
      tubesPerCase: deps.integerOrZero(entry.tubes_per_case),
      sourceWarehouse: deps.asTrimmedString(entry.source_warehouse).toUpperCase(),
      destinationWarehouse: deps.asTrimmedString(entry.destination_warehouse).toUpperCase(),
      pendingTubes: deps.integerOrZero(entry.pending_tubes),
      status: deps.asTrimmedString(entry.status).toUpperCase(),
      createdAt: deps.asTrimmedString(entry.created_at),
      createdBy: deps.asTrimmedString(entry.created_by),
      receivedAt: deps.asTrimmedString(entry.received_at),
      receivedBy: deps.asTrimmedString(entry.received_by),
      cancelledAt: deps.asTrimmedString(entry.cancelled_at),
      cancelledBy: deps.asTrimmedString(entry.cancelled_by),
      updatedAt: deps.asTrimmedString(entry.updated_at),
      updatedBy: deps.asTrimmedString(entry.updated_by),
      notes: deps.asTrimmedString(entry.notes),
    })).filter((entry) => entry.transferId);
    const scopeFieldsByJobId = await buildJobScopeFieldsByJobId(client, orgId, entries, deps);
    return ok({
      entries: entries.map((entry) => {
        const jobId = deps.asTrimmedString((entry as Record<string, unknown>).jobId);
        return {
          ...entry,
          ...(scopeFieldsByJobId.get(jobId) || {}),
        };
      }),
    });
  },
  "/boxes/search": async ({ client, orgId, params }, deps) => {
    return ok(await deps.buildSearchBoxes(client, orgId, params));
  },
  "/boxes/get": async ({ client, orgId, params }, deps) => {
    const found = await deps.findBoxById(client, orgId, deps.requireString(params.boxId, "boxId"));
    if (!found) {
      throw new HttpError(404, "Box not found.");
    }
    const allocations = await deps.listAllocationsByBox(client, orgId, found.boxId);
    const reservationSnapshot = buildBoxReservationSnapshot(found, allocations);
    const orderedForJobs = await deps.buildBoxFilmOrderOrigins(client, orgId, found.boxId);
    const lastCheckoutScope = await buildLastCheckoutScopeForBox(client, orgId, found, deps);
    return ok(
      deps.toPublicBox({
        ...found,
        orderedForJobs,
        ...((lastCheckoutScope as Record<string, unknown>).workScope
          ? { lastCheckoutWorkScope: (lastCheckoutScope as Record<string, unknown>).workScope }
          : {}),
        ...((lastCheckoutScope as Record<string, unknown>).sections
          ? { lastCheckoutSections: (lastCheckoutScope as Record<string, unknown>).sections }
          : {}),
        physicalFeetAvailable: reservationSnapshot.physicalFeetAvailable,
        feetAvailable: reservationSnapshot.allocatableNowFeet,
        allocatableNowFeet: reservationSnapshot.allocatableNowFeet,
        allocatedWithInstallDateFeet: reservationSnapshot.allocatedWithInstallDateFeet,
        allocatedWithoutInstallDateFeet: reservationSnapshot.allocatedWithoutInstallDateFeet,
        activeAllocatedFeet: reservationSnapshot.activeAllocatedFeet,
        allocationPlanningFeet: reservationSnapshot.allocatableNowFeet,
      }),
    );
  },
  "/boxes/transfer/by-box": async ({ client, orgId, params }, deps) => {
    return await deps.getBoxTransferByBox(client, orgId, deps.requireString(params.boxId, "boxId"));
  },
  "/boxes/transfer/plan": async ({ client, orgId, params }, deps) => {
    return await deps.getBoxTransferPlan(client, orgId, params);
  },
  "/audit/list": async ({ client, orgId, params }, deps) => {
    const entries = await deps.listAudit(client, orgId, params);
    return ok({ entries: await enrichAuditEntriesWithCheckoutJobIdentity(client, orgId, entries, deps) });
  },
  "/audit/by-box": async ({ client, orgId, params }, deps) => {
    const entries = await deps.listAuditEntriesByBox(client, orgId, deps.requireString(params.boxId, "boxId"));
    return ok({ entries: await enrichAuditEntriesWithCheckoutJobIdentity(client, orgId, entries, deps) });
  },
  "/allocations/by-box": async ({ client, orgId, params }, deps) => {
    const boxId = deps.requireString(params.boxId, "boxId");
    const entries = await deps.listAllocationsByBox(client, orgId, boxId);
    const box = await deps.findBoxById(client, orgId, boxId);
    const reservationSnapshot = box ? buildBoxReservationSnapshot(box, entries) : null;
    const scopeFieldsByJobId = await buildJobScopeFieldsByJobId(client, orgId, entries, deps);
    return ok({
      entries: entries.map((entry) => {
        const allocationEntry = entry as Record<string, unknown>;
        const allocationSnapshotsById = (reservationSnapshot as any)?.allocationSnapshotsById || {};
        const allocationSnapshot =
          allocationSnapshotsById[deps.asTrimmedString(allocationEntry.allocationId)] || null;
        const jobId = deps.asTrimmedString(allocationEntry.jobId);
        return {
          ...deps.toPublicAllocation(entry),
          ...(jobId ? { jobId } : {}),
          ...(scopeFieldsByJobId.get(jobId) || {}),
          backedPhysicalFeet: allocationSnapshot
            ? allocationSnapshot.backedPhysicalFeet
            : deps.integerOrZero(allocationEntry.allocatedFeet),
          reservationState: allocationSnapshot ? allocationSnapshot.reservationState : "WITHOUT_INSTALL_DATE",
        };
      }),
    });
  },
  "/allocations/jobs": async ({ client, orgId }, deps) => {
    return ok({ entries: await deps.buildAllocationJobList(client, orgId) });
  },
  "/allocations/by-job": async ({ client, orgId, params }, deps) => {
    await assertLegacyJobNumberReadIsUnambiguous(client, orgId, params.jobNumber, deps);
    return ok(await deps.buildAllocationJobDetail(client, orgId, params.jobNumber));
  },
  "/allocations/preview": async ({ client, orgId, params }, deps) => {
    const source = await deps.findBoxById(client, orgId, deps.requireString(params.boxId, "BoxID"));
    if (!source) {
      throw new HttpError(404, "Box not found.");
    }
    const previewTarget = await resolveAllocationPreviewJobContext(client, orgId, params, deps);
    const jobContext = previewTarget.jobContext;
    const crossWarehouse = deps.parseCrossWarehouseFlag(params.crossWarehouse);
    const sourceWarehouse = deps.asTrimmedString((source as Record<string, unknown>).warehouse).toUpperCase();
    const allBoxes = crossWarehouse || !sourceWarehouse
      ? await deps.listBoxes(client, orgId)
      : await deps.listBoxesByWarehouses(client, orgId, [sourceWarehouse]);
    const jobWarehouse = await deps.resolveAllocationJobWarehouse(
      client,
      orgId,
      (jobContext as Record<string, unknown>).jobNumber,
      params.jobWarehouse,
      previewTarget.job,
    );
    const requirementId = deps.asTrimmedString(params.requirementId);
    const requirements = requirementId
      ? previewTarget.jobId
        ? await deps.listJobRequirementsByJobId(client, orgId, previewTarget.jobId, previewTarget.job)
        : await deps.listJobRequirementsByJob(
            client,
            orgId,
            deps.asTrimmedString((jobContext as Record<string, unknown>).jobNumber),
          )
      : [];
    const selectedRequirement = requirementId
      ? requirements.find((entry) => deps.asTrimmedString((entry as Record<string, unknown>).id) === requirementId) || null
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
        crossWarehouse,
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
    const start = Date.now();

    try {
      const dbStart = Date.now();
      const entries = await deps.buildJobsCalendar(
        client,
        orgId,
        params.view,
        params.anchorDate,
        params.month,
        params.lifecycleStatus
      );
      console.log("DB TIME:", Date.now() - dbStart, "ms");

      return ok({ entries });
    } finally {
      console.log("TIMING /jobs/calendar:", Date.now() - start, "ms");
    }
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
  "/jobs/check-duplicate": async ({ client, orgId, params }, deps) => {
    const jobNumber = deps.requireString(
      deps.normalizeJobNumberDigits(params.jobNumber, "JobNumber"),
      "JobNumber"
    );
    const workScopeInput = getJobDuplicateWorkScopeInput(params);
    const entries = await deps.listJobs(client, orgId);
    const sameJobNumberJobs = entries.filter(
      (entry: any) => deps.asTrimmedString(entry?.jobNumber) === jobNumber
    );
    return ok(buildJobDuplicateCheckResult({
      jobNumber,
      workScopeInput,
      existingJob: sameJobNumberJobs[0] || null,
      sameJobNumberJobs,
      duplicatesEnabled: true,
    }));
  },
  "/jobs/get": async ({ client, orgId, params }, deps) => {
    await assertLegacyJobNumberReadIsUnambiguous(client, orgId, params.jobNumber, deps);
    return ok(await deps.buildJobDetail(client, orgId, params.jobNumber));
  },
  "/jobs/get-by-id": async ({ client, orgId, params }, deps) => {
    return ok(await deps.buildJobDetailById(client, orgId, requireUuid(params.jobId, "jobId")));
  },
  "/film-orders/list": async ({ client, orgId }, deps) => {
    return ok({ entries: await deps.buildFilmOrdersList(client, orgId) });
  },
  "/film-orders/get": async ({ client, orgId, params }, deps) => {
    return ok(await deps.buildFilmOrderDetail(client, orgId, params.filmOrderId));
  },
  "/film-data/catalog": async ({ client, orgId }, deps) => {
    return ok({ entries: await deps.buildFilmCatalog(client, orgId) });
  },
  "/roll-history/by-box": async ({ client, orgId, params }, deps) => {
    const entries = await deps.listRollHistoryByBox(client, orgId, deps.requireString(params.boxId, "boxId"));
    const scopeFieldsByJobId = await buildJobScopeFieldsByJobId(client, orgId, entries, deps);
    return ok({
      entries: entries.map((entry) => {
        const historyEntry = entry as Record<string, unknown>;
        const jobId = deps.asTrimmedString(historyEntry.jobId);
        return {
          ...historyEntry,
          ...(scopeFieldsByJobId.get(jobId) || {}),
        };
      }),
    });
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
