// Purpose: Route-handler map for Edge API mutation endpoints.
import { HttpError, ok } from "../http.ts";
import type { AuthIdentity } from "../types.ts";

type MutationContext = {
  client: any;
  identity: AuthIdentity;
  orgId: string;
  actor: string;
  logicalPath: string;
  payload: Record<string, unknown>;
  normalizedPayload: Record<string, unknown>;
};

export type MutationHandlerDeps = {
  asTrimmedString: (value: unknown) => string;
  requireString: (value: unknown, fieldName: string) => string;
  integerOrZero: (value: unknown) => number;
  normalizeCaulkCaseMath: (result: unknown) => Record<string, unknown>;
  canonicalizeMutationPayloadForRoute: (
    client: any,
    orgId: string,
    logicalPath: string,
    payload: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  callMutationRpc: (
    client: any,
    fn: string,
    orgId: string,
    actor: string,
    payload: Record<string, unknown>,
  ) => Promise<any>;
  findPendingBoxTransferByDestinationBoxId: (
    client: any,
    orgId: string,
    destinationBoxId: string
  ) => Promise<any>;
  findBoxById: (client: any, orgId: string, boxId: string) => Promise<any>;
  toPublicBox: (box: any) => Record<string, unknown>;
  startBoxTransfer: (client: any, identity: AuthIdentity, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  receiveBoxTransfer: (client: any, identity: AuthIdentity, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  cancelBoxTransfer: (client: any, identity: AuthIdentity, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  ensureBoxCheckoutCrewCompatibility: (client: any, orgId: string, payload: Record<string, unknown>) => Promise<void>;
  findJobByNumber: (client: any, orgId: string, jobNumber: string) => Promise<any>;
  normalizeJobLifecycleStatus: (value: unknown) => "ACTIVE" | "COMPLETED" | "CANCELLED";
  listAllocationsByIds: (client: any, orgId: string, allocationIds: string[]) => Promise<any[]>;
  toPublicAllocation: (entry: any) => Record<string, unknown>;
  findFilmOrderById: (client: any, orgId: string, filmOrderId: string) => Promise<any>;
  toPublicFilmOrder: (entry: any, linkedBoxes: any[]) => Record<string, unknown>;
  buildPublicFilmOrderLinkedBoxes: (client: any, orgId: string, filmOrderId: string) => Promise<any[]>;
  removeJobBoxAllocation: (client: any, identity: AuthIdentity, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  buildJobDetail: (client: any, orgId: string, jobNumber: unknown) => Promise<Record<string, unknown>>;
  setJobStagedPickup: (client: any, identity: AuthIdentity, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  checkoutAllJobMaterials: (client: any, identity: AuthIdentity, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  completeJob: (client: any, identity: AuthIdentity, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  reopenJob: (client: any, identity: AuthIdentity, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  deleteJob: (client: any, identity: AuthIdentity, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

type MutationHandler = (
  context: MutationContext,
  deps: MutationHandlerDeps,
) => Promise<Record<string, unknown>>;

const mutationHandlers: Record<string, MutationHandler> = {
  "/profile/username": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(client, "api_request_username_change", orgId, actor, normalizedPayload);
    return ok(result);
  },
  "/admin/access/requests/approve": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(client, "api_approve_access_request", orgId, actor, normalizedPayload);
    return ok(result);
  },
  "/admin/access/requests/deny": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(client, "api_deny_access_request", orgId, actor, normalizedPayload);
    return ok(result);
  },
  "/admin/username-requests/approve": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(
      client,
      "api_approve_username_change_request",
      orgId,
      actor,
      normalizedPayload,
    );
    return ok(result);
  },
  "/admin/username-requests/deny": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(client, "api_deny_username_change_request", orgId, actor, normalizedPayload);
    return ok(result);
  },
  "/admin/member-permissions": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const permissions = await deps.callMutationRpc(
      client,
      "api_update_member_feature_permissions",
      orgId,
      actor,
      normalizedPayload,
    );
    return ok({ permissions });
  },
  "/admin/user-permissions": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const permissions = await deps.callMutationRpc(
      client,
      "api_update_user_feature_permissions",
      orgId,
      actor,
      normalizedPayload,
    );
    return ok({ permissions });
  },
  "/owner/admin-permissions": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const permissions = await deps.callMutationRpc(
      client,
      "api_update_admin_feature_permissions",
      orgId,
      actor,
      normalizedPayload,
    );
    return ok({ permissions });
  },
  "/admin/roles/promote-member-to-admin": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(client, "api_promote_member_to_admin", orgId, actor, normalizedPayload);
    return ok(result);
  },
  "/owner/roles/demote-admin-to-member": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(client, "api_demote_admin_to_member", orgId, actor, normalizedPayload);
    return ok(result);
  },
  "/owner/roles/promote-admin-to-owner": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(client, "api_promote_admin_to_owner", orgId, actor, normalizedPayload);
    return ok(result);
  },
  "/owner/notification-preferences": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(
      client,
      "api_update_owner_notification_preferences",
      orgId,
      actor,
      normalizedPayload,
    );
    return ok(result);
  },
  "/owner/caulk/manufacturers/upsert": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(
      client,
      "api_acl_owner_upsert_caulk_manufacturer",
      orgId,
      actor,
      normalizedPayload,
    );
    return ok(result);
  },
  "/caulk/products/upsert": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(
      client,
      "api_acl_caulk_upsert_product",
      orgId,
      actor,
      normalizedPayload,
    );
    return ok(result);
  },
  "/caulk/mutate": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(
      client,
      "api_acl_caulk_mutate_stock",
      orgId,
      actor,
      normalizedPayload,
    );
    return ok(deps.normalizeCaulkCaseMath(result));
  },
  "/caulk/transfer": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(
      client,
      "api_acl_caulk_transfer_stock",
      orgId,
      actor,
      normalizedPayload,
    );
    const transfer = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
    return ok({
      ...transfer,
      from: deps.normalizeCaulkCaseMath(transfer.from),
      to: deps.normalizeCaulkCaseMath(transfer.to),
    });
  },
  "/owner/warehouses/add": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(client, "api_acl_add_warehouse", orgId, actor, normalizedPayload);
    return ok(result);
  },
  "/boxes/add": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const reservedTransfer = await deps.findPendingBoxTransferByDestinationBoxId(
      client,
      orgId,
      deps.requireString(normalizedPayload.boxId, "BoxID")
    );
    if (reservedTransfer) {
      throw new HttpError(
        400,
        `BoxID ${deps.requireString(normalizedPayload.boxId, "BoxID").toUpperCase()} is already reserved by a pending transfer and cannot be reused yet.`
      );
    }
    const result = await deps.callMutationRpc(client, "api_acl_boxes_add", orgId, actor, normalizedPayload);
    const box = await deps.findBoxById(client, orgId, deps.asTrimmedString(result.boxId));
    if (!box) {
      throw new HttpError(500, "Box mutation completed but the updated box could not be reloaded.");
    }
    return ok({ box: deps.toPublicBox(box), logId: deps.asTrimmedString(result.logId) }, result.warnings || []);
  },
  "/boxes/update": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(client, "api_acl_boxes_update", orgId, actor, normalizedPayload);
    const box = await deps.findBoxById(client, orgId, deps.asTrimmedString(result.boxId));
    if (!box) {
      throw new HttpError(500, "Box mutation completed but the updated box could not be reloaded.");
    }
    return ok({ box: deps.toPublicBox(box), logId: deps.asTrimmedString(result.logId) }, result.warnings || []);
  },
  "/boxes/set-status": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    await deps.ensureBoxCheckoutCrewCompatibility(client, orgId, normalizedPayload);
    const result = await deps.callMutationRpc(client, "api_acl_boxes_set_status", orgId, actor, normalizedPayload);
    const box = await deps.findBoxById(client, orgId, deps.asTrimmedString(result.boxId));
    if (!box) {
      throw new HttpError(500, "Box mutation completed but the updated box could not be reloaded.");
    }
    return ok({ box: deps.toPublicBox(box), logId: deps.asTrimmedString(result.logId) }, result.warnings || []);
  },
  "/boxes/delete": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(client, "api_acl_boxes_delete", orgId, actor, normalizedPayload);
    return ok(
      {
        boxId: deps.asTrimmedString(result.boxId),
        logId: deps.asTrimmedString(result.logId),
      },
      result.warnings || [],
    );
  },
  "/boxes/transfer/start": async ({ client, identity, normalizedPayload }, deps) => {
    return await deps.startBoxTransfer(client, identity, normalizedPayload);
  },
  "/boxes/transfer/receive": async ({ client, identity, normalizedPayload }, deps) => {
    return await deps.receiveBoxTransfer(client, identity, normalizedPayload);
  },
  "/boxes/transfer/cancel": async ({ client, identity, normalizedPayload }, deps) => {
    return await deps.cancelBoxTransfer(client, identity, normalizedPayload);
  },
  "/allocations/add": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const jobNumber = deps.requireString(normalizedPayload.jobNumber, "JobNumber");
    const existingJob = await deps.findJobByNumber(client, orgId, jobNumber);
    if (existingJob && deps.normalizeJobLifecycleStatus(existingJob.lifecycleStatus) !== "ACTIVE") {
      throw new HttpError(400, `Job ${jobNumber} is closed and cannot receive allocations.`);
    }

    const result = await deps.callMutationRpc(client, "api_acl_allocations_apply", orgId, actor, normalizedPayload);
    const allocationIds = Array.isArray(result.allocationIds)
      ? result.allocationIds.map((value: unknown) => deps.asTrimmedString(value)).filter(Boolean)
      : [];
    const allocations = allocationIds.length
      ? (await deps.listAllocationsByIds(client, orgId, allocationIds)).map(deps.toPublicAllocation)
      : [];
    const filmOrderId = deps.asTrimmedString(result.filmOrderId);
    let filmOrder = null;
    if (filmOrderId) {
      const found = await deps.findFilmOrderById(client, orgId, filmOrderId);
      if (found) {
        filmOrder = deps.toPublicFilmOrder(found, await deps.buildPublicFilmOrderLinkedBoxes(client, orgId, filmOrderId));
      }
    }
    return ok({
      allocations,
      filmOrder,
      remainingUncoveredFeet: deps.integerOrZero(result.remainingUncoveredFeet),
    }, result.warnings || []);
  },
  "/allocations/apply": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const jobNumber = deps.requireString(normalizedPayload.jobNumber, "JobNumber");
    const existingJob = await deps.findJobByNumber(client, orgId, jobNumber);
    if (existingJob && deps.normalizeJobLifecycleStatus(existingJob.lifecycleStatus) !== "ACTIVE") {
      throw new HttpError(400, `Job ${jobNumber} is closed and cannot receive allocations.`);
    }

    const result = await deps.callMutationRpc(client, "api_acl_allocations_apply", orgId, actor, normalizedPayload);
    const allocationIds = Array.isArray(result.allocationIds)
      ? result.allocationIds.map((value: unknown) => deps.asTrimmedString(value)).filter(Boolean)
      : [];
    const allocations = allocationIds.length
      ? (await deps.listAllocationsByIds(client, orgId, allocationIds)).map(deps.toPublicAllocation)
      : [];
    const filmOrderId = deps.asTrimmedString(result.filmOrderId);
    let filmOrder = null;
    if (filmOrderId) {
      const found = await deps.findFilmOrderById(client, orgId, filmOrderId);
      if (found) {
        filmOrder = deps.toPublicFilmOrder(found, await deps.buildPublicFilmOrderLinkedBoxes(client, orgId, filmOrderId));
      }
    }
    return ok({
      allocations,
      filmOrder,
      remainingUncoveredFeet: deps.integerOrZero(result.remainingUncoveredFeet),
    }, result.warnings || []);
  },
  "/allocations/remove-box": async ({ client, identity, payload }, deps) => {
    return await deps.removeJobBoxAllocation(client, identity, payload);
  },
  "/allocations/caulk/add": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(
      client,
      "api_acl_allocations_caulk_add",
      orgId,
      actor,
      normalizedPayload,
    );
    return ok(result, result.warnings || []);
  },
  "/allocations/caulk/update": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(
      client,
      "api_acl_allocations_caulk_update",
      orgId,
      actor,
      normalizedPayload,
    );
    return ok(result, result.warnings || []);
  },
  "/allocations/caulk/checkout": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(
      client,
      "api_acl_allocations_caulk_checkout",
      orgId,
      actor,
      normalizedPayload,
    );
    return ok(result, result.warnings || []);
  },
  "/allocations/caulk/checkin": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(
      client,
      "api_acl_allocations_caulk_checkin",
      orgId,
      actor,
      normalizedPayload,
    );
    return ok(result, result.warnings || []);
  },
  "/allocations/caulk/remove": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(
      client,
      "api_acl_allocations_caulk_remove",
      orgId,
      actor,
      normalizedPayload,
    );
    return ok(result, result.warnings || []);
  },
  "/jobs/create": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(client, "api_acl_jobs_create", orgId, actor, normalizedPayload);
    return ok(await deps.buildJobDetail(client, orgId, result.jobNumber), result.warnings || []);
  },
  "/jobs/update": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const jobNumber = deps.requireString(normalizedPayload.jobNumber, "JobNumber");
    if (
      normalizedPayload.lifecycleStatus !== undefined &&
      deps.normalizeJobLifecycleStatus(normalizedPayload.lifecycleStatus) !== "ACTIVE"
    ) {
      throw new HttpError(400, `Closed lifecycle changes are not allowed here. Use complete/reopen actions for job ${jobNumber}.`);
    }
    const existingJob = await deps.findJobByNumber(client, orgId, jobNumber);
    if (existingJob && deps.normalizeJobLifecycleStatus(existingJob.lifecycleStatus) !== "ACTIVE") {
      throw new HttpError(400, `Job ${jobNumber} is closed. Reopen it before editing.`);
    }

    const result = await deps.callMutationRpc(client, "api_acl_jobs_update", orgId, actor, normalizedPayload);
    return ok(await deps.buildJobDetail(client, orgId, result.jobNumber), result.warnings || []);
  },
  "/jobs/set-staged-pickup": async ({ client, identity, normalizedPayload }, deps) => {
    return await deps.setJobStagedPickup(client, identity, normalizedPayload);
  },
  "/jobs/checkout-all": async ({ client, identity, normalizedPayload }, deps) => {
    return await deps.checkoutAllJobMaterials(client, identity, normalizedPayload);
  },
  "/jobs/complete": async ({ client, identity, payload }, deps) => {
    return await deps.completeJob(client, identity, payload);
  },
  "/jobs/reopen": async ({ client, identity, payload }, deps) => {
    return await deps.reopenJob(client, identity, payload);
  },
  "/jobs/delete": async ({ client, identity, payload }, deps) => {
    return await deps.deleteJob(client, identity, payload);
  },
  "/film-orders/create": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const jobNumber = deps.requireString(normalizedPayload.jobNumber, "JobNumber");
    const existingJob = await deps.findJobByNumber(client, orgId, jobNumber);
    if (existingJob && deps.normalizeJobLifecycleStatus(existingJob.lifecycleStatus) !== "ACTIVE") {
      throw new HttpError(400, `Job ${jobNumber} is closed and cannot receive film orders.`);
    }

    const result = await deps.callMutationRpc(client, "api_acl_film_orders_create", orgId, actor, normalizedPayload);
    const filmOrder = await deps.findFilmOrderById(client, orgId, result.filmOrderId);
    if (!filmOrder) {
      throw new HttpError(500, "Film order was created but could not be reloaded.");
    }
    return ok(
      deps.toPublicFilmOrder(filmOrder, await deps.buildPublicFilmOrderLinkedBoxes(client, orgId, filmOrder.filmOrderId)),
      result.warnings || [],
    );
  },
  "/film-orders/cancel": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(client, "api_acl_film_orders_cancel", orgId, actor, normalizedPayload);
    return ok({ jobNumber: deps.asTrimmedString(result.jobNumber) }, result.warnings || []);
  },
  "/film-orders/delete": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(client, "api_acl_film_orders_delete", orgId, actor, normalizedPayload);
    return ok(result.filmOrder || null, result.warnings || []);
  },
  "/audit/undo": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(client, "api_acl_audit_undo", orgId, actor, normalizedPayload);
    const boxId = deps.asTrimmedString(result.boxId);
    const box = result.boxDeleted || !boxId ? null : await deps.findBoxById(client, orgId, boxId);
    return ok({ box: box ? deps.toPublicBox(box) : null, logId: deps.asTrimmedString(result.logId) }, result.warnings || []);
  },
};

export async function dispatchMutationWithHandlers(
  client: any,
  identity: AuthIdentity,
  logicalPath: string,
  payload: Record<string, unknown>,
  deps: MutationHandlerDeps,
) {
  const orgId = identity.orgId;
  const actor = identity.actor;
  const normalizedPayload = await deps.canonicalizeMutationPayloadForRoute(client, orgId, logicalPath, payload);
  const handler = mutationHandlers[logicalPath];
  if (!handler) {
    throw new HttpError(404, `Route not found: ${logicalPath || "/"}`);
  }
  return await handler({ client, identity, orgId, actor, logicalPath, payload, normalizedPayload }, deps);
}
