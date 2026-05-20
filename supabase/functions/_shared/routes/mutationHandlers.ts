// Purpose: Route-handler map for Edge API mutation endpoints.
import { HttpError, ok } from "../http.ts";
import type { AuthIdentity } from "../types.ts";
import { buildBoxReservationSnapshot } from "../../../../shared/domain/filmAllocationReservations.mjs";
import {
  buildJobDuplicateCheckResult,
  getJobDuplicateWorkScopeInput,
} from "../../../../shared/domain/jobDuplicateContract.mjs";
import { validateAllocationJobMutationOwnership } from "../../../../shared/domain/allocationMutationIdentity.mjs";
import { validateFilmOrderJobMutationOwnership } from "../../../../shared/domain/filmOrderMutationIdentity.mjs";
import {
  normalizePlannerSuppressionMaterialType,
  validatePlannerSuppressionRequirementOwnership,
} from "../../../../shared/domain/plannerSuppressionMutationIdentity.mjs";
import { resolveEdgeJobMutationTargetById } from "../jobMutationIdentity.ts";

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
  listAllocationsByBox: (client: any, orgId: string, boxId: string) => Promise<any[]>;
  listJobs: (client: any, orgId: string) => Promise<any[]>;
  toPublicBox: (box: any) => Record<string, unknown>;
  startBoxTransfer: (client: any, identity: AuthIdentity, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  receiveBoxTransfer: (client: any, identity: AuthIdentity, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  cancelBoxTransfer: (client: any, identity: AuthIdentity, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  ensureBoxCheckoutCrewCompatibility: (client: any, orgId: string, payload: Record<string, unknown>) => Promise<void>;
  findJobByNumber: (client: any, orgId: string, jobNumber: string) => Promise<any>;
  findJobById: (client: any, orgId: string, jobId: string) => Promise<any>;
  normalizeJobNumberDigits: (value: unknown, fieldName?: string) => string;
  normalizeJobLifecycleStatus: (value: unknown) => "ACTIVE" | "COMPLETED" | "CANCELLED";
  listAllocationsByIds: (client: any, orgId: string, allocationIds: string[]) => Promise<any[]>;
  toPublicAllocation: (entry: any) => Record<string, unknown>;
  findFilmOrderById: (client: any, orgId: string, filmOrderId: string) => Promise<any>;
  findPlannerSuppressionRequirementById: (
    client: any,
    orgId: string,
    requirementId: string,
    materialType: string,
  ) => Promise<any>;
  toPublicFilmOrder: (entry: any, linkedBoxes: any[]) => Record<string, unknown>;
  buildPublicFilmOrderLinkedBoxes: (client: any, orgId: string, filmOrderId: string) => Promise<any[]>;
  removeJobBoxAllocation: (client: any, identity: AuthIdentity, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  buildJobDetail: (client: any, orgId: string, jobNumber: unknown) => Promise<Record<string, unknown>>;
  buildJobDetailById: (client: any, orgId: string, jobId: unknown) => Promise<Record<string, unknown>>;
  setJobStagedPickup: (client: any, identity: AuthIdentity, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  checkoutAllJobMaterials: (client: any, identity: AuthIdentity, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  completeJob: (client: any, identity: AuthIdentity, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  reopenJob: (client: any, identity: AuthIdentity, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  deleteJob: (client: any, identity: AuthIdentity, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  reconcileAutoPlannedAllocations: (
    client: any,
    orgId: string,
    actor: string,
    scope: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
};

const ORG_WIDE_SCOPE: Record<string, unknown> = {};
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PLANNER_MUTATION_ROUTES = new Set([
  "/caulk/mutate",
  "/caulk/transfer",
  "/allocations/caulk/add",
  "/allocations/caulk/update",
  "/allocations/caulk/checkout",
  "/allocations/caulk/checkin",
  "/allocations/caulk/remove",
  "/caulk/transfers/receive",
  "/caulk/transfers/cancel",
  "/boxes/add",
  "/boxes/update",
  "/boxes/delete",
  "/boxes/receive",
  "/boxes/set-status",
  "/boxes/transfer/start",
  "/boxes/transfer/receive",
  "/boxes/transfer/cancel",
  "/allocations/add",
  "/allocations/apply",
  "/jobs/create",
  "/jobs/update",
  "/jobs/set-staged-pickup",
  "/jobs/checkout-all",
  "/jobs/complete",
  "/jobs/delete",
  "/jobs/reopen",
  "/film-orders/cancel",
  "/film-orders/delete",
  "/audit/undo",
]);

/**
 * PURPOSE:
 * Marks mutation routes where the called SQL RPC already reconciles planner
 * state atomically, so Edge must not run the same planner pass again.
 *
 * AFFECTS:
 * Job, allocation, and box mutation response timing, job detail reloads, and
 * AUTO_PLANNED reconciliation ownership between Edge and database RPCs.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * SQL ACL wrappers such as public.api_acl_jobs_update/api_acl_boxes_update,
 * dispatcher tests, checkout-all subflows, and frontend mutation timeout
 * behavior.
 *
 * COMMON FAILURE MODES:
 * Duplicate planner execution, stale job details if SQL no longer reconciles,
 * or hidden planner skips for routes that still depend on Edge reconciliation.
 */
const SQL_PLANNER_HANDLED_ROUTES = new Set([
  "/allocations/caulk/add",
  "/allocations/caulk/update",
  "/allocations/caulk/checkout",
  "/allocations/caulk/checkin",
  "/allocations/caulk/remove",
  "/caulk/transfers/receive",
  "/caulk/transfers/cancel",
  "/allocations/add",
  "/allocations/apply",
  "/allocations/remove-box",
  "/boxes/set-status",
  "/boxes/update",
  "/jobs/checkout-all",
  "/jobs/create",
  "/jobs/set-staged-pickup",
  "/jobs/update",
]);

const ORG_WIDE_MUTATION_ROUTES = new Set([
  "/jobs/complete",
  "/jobs/delete",
  "/film-orders/cancel",
  "/audit/undo",
]);

const JOB_DETAIL_RELOAD_ROUTES = new Set([
  "/jobs/create",
  "/jobs/update",
  "/jobs/set-staged-pickup",
  "/jobs/checkout-all",
  "/jobs/complete",
  "/jobs/reopen",
]);

const JOB_ID_SHADOW_SCOPE_ROUTES = new Set([
  "/jobs/update",
  "/jobs/reopen",
]);

async function buildPublicBoxWithReservationMetrics(
  client: any,
  orgId: string,
  box: any,
  deps: MutationHandlerDeps,
) {
  const allocations = await deps.listAllocationsByBox(client, orgId, deps.asTrimmedString(box?.boxId));
  const reservationSnapshot = buildBoxReservationSnapshot(box, allocations);
  return deps.toPublicBox({
    ...box,
    physicalFeetAvailable: reservationSnapshot.physicalFeetAvailable,
    feetAvailable: reservationSnapshot.allocatableNowFeet,
    allocatableNowFeet: reservationSnapshot.allocatableNowFeet,
    allocatedWithInstallDateFeet: reservationSnapshot.allocatedWithInstallDateFeet,
    allocatedWithoutInstallDateFeet: reservationSnapshot.allocatedWithoutInstallDateFeet,
    activeAllocatedFeet: reservationSnapshot.activeAllocatedFeet,
    allocationPlanningFeet: reservationSnapshot.allocatableNowFeet,
  });
}

async function buildPublicAllocationsWithReservationMetrics(
  client: any,
  orgId: string,
  allocations: any[],
  deps: MutationHandlerDeps,
) {
  const source = Array.isArray(allocations) ? allocations : [];
  if (!source.length) {
    return [];
  }

  const jobs = await deps.listJobs(client, orgId);
  const jobCreatedAtByJobNumber = Object.fromEntries(
    (Array.isArray(jobs) ? jobs : [])
      .map((job) => [deps.asTrimmedString(job?.jobNumber), deps.asTrimmedString(job?.createdAt)])
      .filter(([jobNumber]) => Boolean(jobNumber))
  );
  const boxIds = Array.from(
    new Set(source.map((entry) => deps.asTrimmedString(entry?.boxId)).filter(Boolean))
  );
  const snapshotsByBoxId: Record<string, any> = {};

  for (const boxId of boxIds) {
    const box = await deps.findBoxById(client, orgId, boxId);
    if (!box) {
      continue;
    }

    snapshotsByBoxId[boxId] = buildBoxReservationSnapshot(
      box,
      await deps.listAllocationsByBox(client, orgId, boxId),
      { jobCreatedAtByJobNumber }
    );
  }

  return source.map((entry) => {
    const reservationSnapshot =
      snapshotsByBoxId[deps.asTrimmedString(entry?.boxId)]?.allocationSnapshotsById?.[
        deps.asTrimmedString(entry?.allocationId)
      ];
    return {
      ...deps.toPublicAllocation(entry),
      backedPhysicalFeet: reservationSnapshot
        ? deps.integerOrZero(reservationSnapshot.backedPhysicalFeet)
        : deps.integerOrZero(entry?.allocatedFeet),
      reservationState: reservationSnapshot
        ? deps.asTrimmedString(reservationSnapshot.reservationState)
        : (deps.asTrimmedString(entry?.installDate) ? "WITH_INSTALL_DATE" : "WITHOUT_INSTALL_DATE"),
    };
  });
}

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
  "/box-dealers/upsert": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(
      client,
      "api_acl_box_dealers_upsert",
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
    return ok(
      { box: await buildPublicBoxWithReservationMetrics(client, orgId, box, deps), logId: deps.asTrimmedString(result.logId) },
      result.warnings || []
    );
  },
  "/boxes/update": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(client, "api_acl_boxes_update", orgId, actor, normalizedPayload);
    const box = await deps.findBoxById(client, orgId, deps.asTrimmedString(result.boxId));
    if (!box) {
      throw new HttpError(500, "Box mutation completed but the updated box could not be reloaded.");
    }
    return ok(
      { box: await buildPublicBoxWithReservationMetrics(client, orgId, box, deps), logId: deps.asTrimmedString(result.logId) },
      result.warnings || []
    );
  },
  "/boxes/receive": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(client, "api_acl_boxes_receive_ordered", orgId, actor, normalizedPayload);
    const box = await deps.findBoxById(client, orgId, deps.asTrimmedString(result.boxId));
    if (!box) {
      throw new HttpError(500, "Box mutation completed but the updated box could not be reloaded.");
    }
    return ok(
      { box: await buildPublicBoxWithReservationMetrics(client, orgId, box, deps), logId: deps.asTrimmedString(result.logId) },
      result.warnings || []
    );
  },
  "/boxes/labels/mark-printed": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(client, "api_acl_boxes_mark_labels_printed", orgId, actor, normalizedPayload);
    const boxIds = Array.isArray(result.boxIds)
      ? result.boxIds.map((value: unknown) => deps.asTrimmedString(value)).filter(Boolean)
      : [];
    const boxes = [];
    for (const boxId of boxIds) {
      const box = await deps.findBoxById(client, orgId, boxId);
      if (!box) {
        throw new HttpError(500, "Label print update completed but an updated box could not be reloaded.");
      }
      boxes.push(await buildPublicBoxWithReservationMetrics(client, orgId, box, deps));
    }

    return ok(
      {
        boxes,
        logIds: Array.isArray(result.logIds)
          ? result.logIds.map((value: unknown) => deps.asTrimmedString(value)).filter(Boolean)
          : [],
      },
      result.warnings || []
    );
  },
  "/boxes/set-status": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    await deps.ensureBoxCheckoutCrewCompatibility(client, orgId, normalizedPayload);
    const result = await deps.callMutationRpc(client, "api_acl_boxes_set_status", orgId, actor, normalizedPayload);
    const box = await deps.findBoxById(client, orgId, deps.asTrimmedString(result.boxId));
    if (!box) {
      throw new HttpError(500, "Box mutation completed but the updated box could not be reloaded.");
    }
    const resultJobId = deps.asTrimmedString(result.jobId);
    const resultJobNumber = deps.asTrimmedString(result.jobNumber);
    return ok(
      {
        box: await buildPublicBoxWithReservationMetrics(client, orgId, box, deps),
        logId: deps.asTrimmedString(result.logId),
        ...(resultJobId ? { jobId: resultJobId } : {}),
        ...(resultJobNumber ? { jobNumber: resultJobNumber } : {}),
      },
      result.warnings || []
    );
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
      ? await buildPublicAllocationsWithReservationMetrics(
        client,
        orgId,
        await deps.listAllocationsByIds(client, orgId, allocationIds),
        deps
      )
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
    const target = await resolveEdgeJobMutationTargetById(client, orgId, normalizedPayload, {
      findJobById: deps.findJobById,
      normalizeJobNumberDigits: deps.normalizeJobNumberDigits,
    });
    const { orgId: _requestOrgId, ...payloadWithoutRequestOrg } = normalizedPayload;
    const jobNumber = target.usedJobId
      ? deps.requireString(target.jobNumber, "JobNumber")
      : deps.requireString(normalizedPayload.jobNumber, "JobNumber");
    const existingJob = target.usedJobId ? target.job : await deps.findJobByNumber(client, orgId, jobNumber);
    if (existingJob && deps.normalizeJobLifecycleStatus(existingJob.lifecycleStatus) !== "ACTIVE") {
      throw new HttpError(400, `Job ${jobNumber} is closed and cannot receive allocations.`);
    }

    const rpcPayload = target.usedJobId
      ? { ...payloadWithoutRequestOrg, jobId: target.jobId, jobNumber }
      : payloadWithoutRequestOrg;
    const result = await deps.callMutationRpc(client, "api_acl_allocations_apply", orgId, actor, rpcPayload);
    const allocationIds = Array.isArray(result.allocationIds)
      ? result.allocationIds.map((value: unknown) => deps.asTrimmedString(value)).filter(Boolean)
      : [];
    const allocations = allocationIds.length
      ? await buildPublicAllocationsWithReservationMetrics(
        client,
        orgId,
        await deps.listAllocationsByIds(client, orgId, allocationIds),
        deps
      )
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
  "/allocations/remove-box": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const target = await resolveEdgeJobMutationTargetById(client, orgId, normalizedPayload, {
      findJobById: deps.findJobById,
      normalizeJobNumberDigits: deps.normalizeJobNumberDigits,
    });
    const jobNumber = target.usedJobId
      ? deps.requireString(target.jobNumber, "JobNumber")
      : deps.requireString(normalizedPayload.jobNumber, "JobNumber");
    const allocationId = deps.requireString(normalizedPayload.allocationId, "AllocationID");
    const { orgId: _requestOrgId, ...payloadWithoutRequestOrg } = normalizedPayload;

    if (target.usedJobId) {
      const allocations = await deps.listAllocationsByIds(client, orgId, [allocationId]);
      const allocation =
        allocations.find((entry) => deps.asTrimmedString(entry?.allocationId) === allocationId) || null;
      const ownership = validateAllocationJobMutationOwnership({
        allocation,
        allocationId,
        target,
        normalizeJobNumberDigits: deps.normalizeJobNumberDigits,
      });
      if (!ownership.ok) {
        throw new HttpError(ownership.status || 409, ownership.message || "Allocation ownership mismatch.");
      }
    }

    // Guarded transition only: remove-box remains SQL-owned so Edge does not
    // run redundant post-planner work; the RPC scopes planner work by jobId
    // only when canonical identity has already been validated.
    const rpcPayload = target.usedJobId
      ? { ...payloadWithoutRequestOrg, jobNumber }
      : payloadWithoutRequestOrg;
    const result = await deps.callMutationRpc(
      client,
      "api_acl_allocations_remove_box",
      orgId,
      actor,
      rpcPayload,
    );
    return ok({
      ...(target.usedJobId ? { jobId: target.jobId } : {}),
      jobNumber: deps.asTrimmedString(result.jobNumber),
      allocationId: deps.asTrimmedString(result.allocationId),
      boxId: deps.asTrimmedString(result.boxId),
      removedAllocationCount: deps.integerOrZero(result.removedAllocationCount),
      releasedFeet: deps.integerOrZero(result.releasedFeet),
    }, Array.isArray(result.warnings) ? result.warnings : []);
  },
  "/allocations/planner-suppression/clear": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const target = await resolveEdgeJobMutationTargetById(client, orgId, normalizedPayload, {
      findJobById: deps.findJobById,
      normalizeJobNumberDigits: deps.normalizeJobNumberDigits,
    });
    const jobNumber = target.usedJobId
      ? deps.requireString(target.jobNumber, "JobNumber")
      : deps.requireString(normalizedPayload.jobNumber, "JobNumber");
    const requirementId = deps.requireString(normalizedPayload.requirementId, "RequirementID");
    const materialType = normalizePlannerSuppressionMaterialType(
      normalizedPayload.materialType !== undefined
        ? normalizedPayload.materialType
        : normalizedPayload.material_type,
    );
    const { orgId: _requestOrgId, ...payloadWithoutRequestOrg } = normalizedPayload;

    if (target.usedJobId) {
      const requirement = await deps.findPlannerSuppressionRequirementById(
        client,
        orgId,
        requirementId,
        materialType,
      );
      const ownership = validatePlannerSuppressionRequirementOwnership({
        requirement,
        requirementId,
        materialType,
        target,
        normalizeJobNumberDigits: deps.normalizeJobNumberDigits,
      });
      if (!ownership.ok) {
        throw new HttpError(ownership.status || 409, ownership.message || "Planner suppression ownership mismatch.");
      }
    }

    // Guarded transition only: canonical identity is validated in Edge before
    // passing jobId through for SQL planner scope; legacy jobNumber remains valid.
    const rpcPayload = target.usedJobId
      ? { ...payloadWithoutRequestOrg, jobNumber, materialType }
      : payloadWithoutRequestOrg;
    const result = await deps.callMutationRpc(
      client,
      "api_acl_clear_allocation_planner_suppression",
      orgId,
      actor,
      rpcPayload,
    );
    const detailJobNumber = deps.asTrimmedString(result.jobNumber || jobNumber);
    const detail = target.usedJobId
      ? await deps.buildJobDetailById(client, orgId, target.jobId)
      : await deps.buildJobDetail(client, orgId, detailJobNumber);
    return ok(detail, [
      `Auto planning resumed for requirement ${requirementId} on job ${detailJobNumber}.`,
    ]);
  },
  "/allocations/caulk/add": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const { orgId: _requestOrgId, ...payloadWithoutRequestOrg } = normalizedPayload;
    const jobId = deps.asTrimmedString(payloadWithoutRequestOrg.jobId);
    let rpcPayload = payloadWithoutRequestOrg;
    if (jobId) {
      if (!JOB_ID_PATTERN.test(jobId)) {
        throw new HttpError(400, "jobId must be a valid UUID.");
      }
      const target = await resolveEdgeJobMutationTargetById(
        client,
        orgId,
        payloadWithoutRequestOrg,
        deps,
      );
      rpcPayload = { ...payloadWithoutRequestOrg, jobId: target.jobId, jobNumber: target.jobNumber };
    }
    const result = await deps.callMutationRpc(
      client,
      "api_acl_allocations_caulk_add",
      orgId,
      actor,
      rpcPayload,
    );
    return ok(result, result.warnings || []);
  },
  "/allocations/caulk/update": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const { orgId: _requestOrgId, ...payloadWithoutRequestOrg } = normalizedPayload;
    const result = await deps.callMutationRpc(
      client,
      "api_acl_allocations_caulk_update",
      orgId,
      actor,
      payloadWithoutRequestOrg,
    );
    return ok(result, result.warnings || []);
  },
  "/allocations/caulk/checkout": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const { orgId: _requestOrgId, ...payloadWithoutRequestOrg } = normalizedPayload;
    const result = await deps.callMutationRpc(
      client,
      "api_acl_allocations_caulk_checkout",
      orgId,
      actor,
      payloadWithoutRequestOrg,
    );
    return ok(result, result.warnings || []);
  },
  "/allocations/caulk/checkin": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const { orgId: _requestOrgId, ...payloadWithoutRequestOrg } = normalizedPayload;
    const result = await deps.callMutationRpc(
      client,
      "api_acl_allocations_caulk_checkin",
      orgId,
      actor,
      payloadWithoutRequestOrg,
    );
    return ok(result, result.warnings || []);
  },
  "/allocations/caulk/remove": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const { orgId: _requestOrgId, ...payloadWithoutRequestOrg } = normalizedPayload;
    const result = await deps.callMutationRpc(
      client,
      "api_acl_allocations_caulk_remove",
      orgId,
      actor,
      payloadWithoutRequestOrg,
    );
    return ok(result, result.warnings || []);
  },
  "/caulk/transfers/receive": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const { orgId: _requestOrgId, ...payloadWithoutRequestOrg } = normalizedPayload;
    const result = await deps.callMutationRpc(
      client,
      "api_acl_caulk_transfer_receive",
      orgId,
      actor,
      payloadWithoutRequestOrg,
    );
    return ok(result, result.warnings || []);
  },
  "/caulk/transfers/cancel": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const { orgId: _requestOrgId, ...payloadWithoutRequestOrg } = normalizedPayload;
    const result = await deps.callMutationRpc(
      client,
      "api_acl_caulk_transfer_cancel",
      orgId,
      actor,
      payloadWithoutRequestOrg,
    );
    return ok(result, result.warnings || []);
  },
  "/jobs/create": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const jobNumber = deps.requireString(
      deps.normalizeJobNumberDigits(normalizedPayload.jobNumber, "Job ID number"),
      "Job ID number"
    );
    const entries = await deps.listJobs(client, orgId);
    const sameJobNumberJobs = entries.filter(
      (entry: any) => deps.asTrimmedString(entry?.jobNumber) === jobNumber
    );
    const duplicateResult = buildJobDuplicateCheckResult({
      jobNumber,
      workScopeInput: getJobDuplicateWorkScopeInput(normalizedPayload),
      existingJob: sameJobNumberJobs[0] || null,
      sameJobNumberJobs,
      duplicatesEnabled: true,
    });
    if (duplicateResult.exactScopeDuplicateExists) {
      throw new HttpError(
        409,
        `Job ${jobNumber} already exists.`,
        [],
        duplicateResult,
      );
    }

    const result = await deps.callMutationRpc(client, "api_acl_jobs_create", orgId, actor, normalizedPayload);
    const jobId = deps.asTrimmedString(result.jobId);
    return ok(
      jobId
        ? await deps.buildJobDetailById(client, orgId, jobId)
        : await deps.buildJobDetail(client, orgId, result.jobNumber),
      result.warnings || []
    );
  },
  "/jobs/update": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const target = await resolveEdgeJobMutationTargetById(client, orgId, normalizedPayload, {
      findJobById: deps.findJobById,
      normalizeJobNumberDigits: deps.normalizeJobNumberDigits,
    });
    const jobNumber = target.usedJobId
      ? deps.requireString(target.jobNumber, "JobNumber")
      : deps.requireString(normalizedPayload.jobNumber, "JobNumber");
    const { orgId: _requestOrgId, ...payloadWithoutRequestOrg } = normalizedPayload;
    const rpcPayload = target.usedJobId ? { ...payloadWithoutRequestOrg, jobNumber } : payloadWithoutRequestOrg;
    if (
      rpcPayload.lifecycleStatus !== undefined &&
      deps.normalizeJobLifecycleStatus(rpcPayload.lifecycleStatus) !== "ACTIVE"
    ) {
      throw new HttpError(400, `Closed lifecycle changes are not allowed here. Use complete/reopen actions for job ${jobNumber}.`);
    }
    const existingJob = target.usedJobId ? target.job : await deps.findJobByNumber(client, orgId, jobNumber);
    if (existingJob && deps.normalizeJobLifecycleStatus(existingJob.lifecycleStatus) !== "ACTIVE") {
      throw new HttpError(400, `Job ${jobNumber} is closed. Reopen it before editing.`);
    }

    // Guarded transition only: api_acl_jobs_update targets exact jobId only
    // after this Edge guard has validated canonical identity.
    const result = await deps.callMutationRpc(client, "api_acl_jobs_update", orgId, actor, rpcPayload);
    return ok(
      target.usedJobId
        ? await deps.buildJobDetailById(client, orgId, target.jobId)
        : await deps.buildJobDetail(client, orgId, result.jobNumber),
      result.warnings || []
    );
  },
  "/jobs/set-staged-pickup": async ({ client, identity, normalizedPayload }, deps) => {
    const result = await deps.setJobStagedPickup(client, identity, normalizedPayload);
    const jobId = deps.asTrimmedString(result.jobId);
    const jobNumber = deps.requireString(result.jobNumber, "JobNumber");
    return ok(
      jobId
        ? await deps.buildJobDetailById(client, identity.orgId, jobId)
        : await deps.buildJobDetail(client, identity.orgId, jobNumber),
      Array.isArray(result.warnings) ? result.warnings : []
    );
  },
  "/jobs/checkout-all": async ({ client, identity, normalizedPayload }, deps) => {
    const result = await deps.checkoutAllJobMaterials(client, identity, normalizedPayload);
    const jobId = deps.asTrimmedString(result.jobId);
    const jobNumber = deps.requireString(result.jobNumber, "JobNumber");
    return ok(
      jobId
        ? await deps.buildJobDetailById(client, identity.orgId, jobId)
        : await deps.buildJobDetail(client, identity.orgId, jobNumber),
      Array.isArray(result.warnings) ? result.warnings : []
    );
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
    const suppliedJobId = deps.asTrimmedString(normalizedPayload.jobId);
    if (suppliedJobId && !JOB_ID_PATTERN.test(suppliedJobId)) {
      throw new HttpError(400, "jobId must be a valid UUID.");
    }

    const target = await resolveEdgeJobMutationTargetById(client, orgId, normalizedPayload, {
      findJobById: deps.findJobById,
      normalizeJobNumberDigits: deps.normalizeJobNumberDigits,
    });
    const { orgId: _requestOrgId, ...payloadWithoutRequestOrg } = normalizedPayload;
    const jobNumber = target.usedJobId
      ? deps.requireString(target.jobNumber, "JobNumber")
      : deps.requireString(normalizedPayload.jobNumber, "JobNumber");
    const existingJob = target.usedJobId
      ? target.job
      : await deps.findJobByNumber(client, orgId, jobNumber);
    if (existingJob && deps.normalizeJobLifecycleStatus(existingJob.lifecycleStatus) !== "ACTIVE") {
      throw new HttpError(400, `Job ${jobNumber} is closed and cannot receive film orders.`);
    }

    if (target.usedJobId && !deps.asTrimmedString(normalizedPayload.requirementId)) {
      throw new HttpError(400, "RequirementID is required when jobId is supplied.");
    }

    const rpcPayload = target.usedJobId
      ? { ...payloadWithoutRequestOrg, jobId: target.jobId, jobNumber }
      : payloadWithoutRequestOrg;
    const result = await deps.callMutationRpc(client, "api_acl_film_orders_create", orgId, actor, rpcPayload);
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
    const { orgId: _requestOrgId, ...payloadWithoutRequestOrg } = normalizedPayload;
    const suppliedJobId = deps.asTrimmedString(payloadWithoutRequestOrg.jobId);
    let rpcPayload = payloadWithoutRequestOrg;
    if (suppliedJobId) {
      if (!JOB_ID_PATTERN.test(suppliedJobId)) {
        throw new HttpError(400, "jobId must be a valid UUID.");
      }
      deps.requireString(payloadWithoutRequestOrg.jobNumber, "JobNumber");
      const target = await resolveEdgeJobMutationTargetById(client, orgId, payloadWithoutRequestOrg, {
        findJobById: deps.findJobById,
        normalizeJobNumberDigits: deps.normalizeJobNumberDigits,
      });
      rpcPayload = { ...payloadWithoutRequestOrg, jobId: target.jobId, jobNumber: target.jobNumber };
    }
    const result = await deps.callMutationRpc(client, "api_acl_film_orders_cancel", orgId, actor, rpcPayload);
    const jobId = deps.asTrimmedString(result.jobId);
    return ok({ ...(jobId ? { jobId } : {}), jobNumber: deps.asTrimmedString(result.jobNumber) }, result.warnings || []);
  },
  "/film-orders/delete": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const filmOrderId = deps.requireString(normalizedPayload.filmOrderId, "FilmOrderID");
    const target = await resolveEdgeJobMutationTargetById(client, orgId, normalizedPayload, {
      findJobById: deps.findJobById,
      normalizeJobNumberDigits: deps.normalizeJobNumberDigits,
    });
    const { orgId: _requestOrgId, ...payloadWithoutRequestOrg } = normalizedPayload;

    if (target.usedJobId) {
      const filmOrder = await deps.findFilmOrderById(client, orgId, filmOrderId);
      const ownership = validateFilmOrderJobMutationOwnership({
        filmOrder,
        filmOrderId,
        target,
        normalizeJobNumberDigits: deps.normalizeJobNumberDigits,
      });
      if (!ownership.ok) {
        throw new HttpError(ownership.status || 409, ownership.message || "Film order ownership mismatch.");
      }
    }

    // Guarded transition only: delete is filmOrderId-targeted, while create,
    // cancel, and post-delete planner scope remain jobNumber-based until a
    // later film-order/planner migration adds true duplicate-ready semantics.
    const rpcPayload = target.usedJobId
      ? { ...payloadWithoutRequestOrg, jobNumber: target.jobNumber }
      : payloadWithoutRequestOrg;
    const result = await deps.callMutationRpc(client, "api_acl_film_orders_delete", orgId, actor, rpcPayload);
    return ok(result.filmOrder || null, result.warnings || []);
  },
  "/audit/undo": async ({ client, orgId, actor, normalizedPayload }, deps) => {
    const result = await deps.callMutationRpc(client, "api_acl_audit_undo", orgId, actor, normalizedPayload);
    const boxId = deps.asTrimmedString(result.boxId);
    const box = result.boxDeleted || !boxId ? null : await deps.findBoxById(client, orgId, boxId);
    return ok(
      {
        box: box ? await buildPublicBoxWithReservationMetrics(client, orgId, box, deps) : null,
        logId: deps.asTrimmedString(result.logId)
      },
      result.warnings || []
    );
  },
};

/**
 * PURPOSE:
 * Keeps Edge mutations aligned with backend planner reconciliation by deriving
 * the same narrow planner scope after material/job writes.
 *
 * AFFECTS:
 * Supabase job detail responses, allocation apply/remove, box status/receipt,
 * caulk stock/allocation changes, and transfer-triggered replanning.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * backend runtimeAutoAllocationPlanner.mjs, planner migrations 0085/0086,
 * and frontend mutation invalidation around job detail reloads.
 *
 * COMMON FAILURE MODES:
 * Stale AUTO_PLANNED rows after Edge mutations, planner work running too
 * broadly, or job detail being reloaded before planner-created rows exist.
 */
function buildAutoPlannerScope(
  logicalPath: string,
  payload: Record<string, unknown>,
  responseData: Record<string, unknown>,
  deps: MutationHandlerDeps,
) {
  if (!PLANNER_MUTATION_ROUTES.has(logicalPath)) {
    return null;
  }

  if (SQL_PLANNER_HANDLED_ROUTES.has(logicalPath)) {
    return null;
  }

  if (logicalPath === "/film-orders/delete") {
    return buildFilmOrderDeletePlannerScope(payload, responseData, deps);
  }

  if (ORG_WIDE_MUTATION_ROUTES.has(logicalPath)) {
    return ORG_WIDE_SCOPE;
  }

  const jobIds = new Set<string>();
  const jobNumbers = new Set<string>();
  const boxIds = new Set<string>();
  const caulkProductWarehousePairs = new Map<string, Record<string, string>>();

  if (JOB_ID_SHADOW_SCOPE_ROUTES.has(logicalPath)) {
    addJobId(jobIds, payload.jobId, deps);
  }

  addJobNumber(jobNumbers, payload.jobNumber, deps);
  addJobNumber(jobNumbers, responseData.jobNumber, deps);
  addJobNumber(jobNumbers, asRecord(responseData.job)?.jobNumber, deps);
  addJobNumber(jobNumbers, asRecord(responseData.box)?.jobNumber, deps);
  addJobNumber(jobNumbers, asRecord(responseData.filmOrder)?.jobNumber, deps);

  addBoxId(boxIds, payload.boxId, deps);
  addBoxId(boxIds, payload.sourceBoxId, deps);
  addBoxId(boxIds, payload.destinationBoxId, deps);
  addBoxId(boxIds, responseData.boxId, deps);
  addBoxId(boxIds, asRecord(responseData.box)?.boxId, deps);
  addBoxId(boxIds, asRecord(responseData.allocation)?.boxId, deps);
  addBoxId(boxIds, asRecord(responseData.allocation)?.sourceBoxId, deps);

  if (Array.isArray(responseData.allocations)) {
    for (const allocation of responseData.allocations) {
      const entry = asRecord(allocation);
      addJobNumber(jobNumbers, entry.jobNumber, deps);
      addBoxId(boxIds, entry.boxId, deps);
    }
  }

  addCaulkProductWarehousePair(caulkProductWarehousePairs, payload.productId, payload.warehouse, deps);
  addCaulkProductWarehousePair(caulkProductWarehousePairs, payload.productId, payload.sourceWarehouse, deps);
  addCaulkProductWarehousePair(caulkProductWarehousePairs, payload.productId, payload.destinationWarehouse, deps);
  addCaulkProductWarehousePair(caulkProductWarehousePairs, responseData.productId, responseData.warehouse, deps);
  addCaulkProductWarehousePair(caulkProductWarehousePairs, responseData.productId, responseData.sourceWarehouse, deps);
  addCaulkProductWarehousePair(caulkProductWarehousePairs, responseData.productId, responseData.destinationWarehouse, deps);

  if (Array.isArray(payload.caulkRequirements)) {
    const fallbackWarehouse =
      payload.warehouse ||
      responseData.warehouse ||
      asRecord(responseData.job)?.warehouse;
    for (const requirement of payload.caulkRequirements) {
      addCaulkProductWarehousePair(
        caulkProductWarehousePairs,
        asRecord(requirement).productId,
        fallbackWarehouse,
        deps,
      );
    }
  }

  const scope: Record<string, unknown> = {};
  if (jobNumbers.size > 0) {
    scope.jobNumbers = Array.from(jobNumbers);
  }
  if (jobIds.size > 0) {
    scope.jobIds = Array.from(jobIds);
  }
  if (boxIds.size > 0) {
    scope.boxIds = Array.from(boxIds);
  }
  if (caulkProductWarehousePairs.size > 0) {
    scope.caulkProductWarehousePairs = Array.from(caulkProductWarehousePairs.values());
  }
  return Object.keys(scope).length > 0 ? scope : ORG_WIDE_SCOPE;
}

/**
 * PURPOSE:
 * Scopes plain pending film-order deletion to the returned job only, while
 * preserving org-wide fallback if the SQL response cannot prove that job.
 *
 * AFFECTS:
 * /film-orders/delete post-write planner cost and timeout risk.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * public.api_acl_film_orders_delete return shape, guarded plain-delete SQL,
 * local runtimeAutoAllocationPlanner parity, and Film Orders tab delete tests.
 *
 * COMMON FAILURE MODES:
 * Trusting request payload job numbers, skipping planner on missing response
 * data, or applying this scoped behavior to /film-orders/cancel.
 */
function buildFilmOrderDeletePlannerScope(
  payload: Record<string, unknown>,
  responseData: Record<string, unknown>,
  deps: MutationHandlerDeps,
) {
  const jobNumber = typeof responseData.jobNumber === "string"
    ? deps.asTrimmedString(responseData.jobNumber)
    : "";
  if (!jobNumber) {
    return ORG_WIDE_SCOPE;
  }
  const jobIds = normalizeJobIds([payload.jobId], deps);
  return {
    jobNumbers: [jobNumber],
    ...(jobIds.length ? { jobIds } : {}),
  };
}

function getJobNumberForPlannerDetailReload(
  logicalPath: string,
  payload: Record<string, unknown>,
  responseData: Record<string, unknown>,
  deps: MutationHandlerDeps,
) {
  if (!JOB_DETAIL_RELOAD_ROUTES.has(logicalPath)) {
    return "";
  }
  return (
    deps.asTrimmedString(responseData.jobNumber) ||
    deps.asTrimmedString(asRecord(responseData.job)?.jobNumber) ||
    deps.asTrimmedString(payload.jobNumber)
  );
}

function getJobIdentityForPlannerDetailReload(
  logicalPath: string,
  payload: Record<string, unknown>,
  responseData: Record<string, unknown>,
  deps: MutationHandlerDeps,
) {
  if (!JOB_DETAIL_RELOAD_ROUTES.has(logicalPath)) {
    return { jobId: "", jobNumber: "" };
  }
  const summary = asRecord(responseData.summary);
  const job = asRecord(responseData.job);
  return {
    jobId: deps.asTrimmedString(payload.jobId),
    jobNumber:
      deps.asTrimmedString(responseData.jobNumber) ||
      deps.asTrimmedString(summary.jobNumber) ||
      deps.asTrimmedString(job.jobNumber) ||
      deps.asTrimmedString(payload.jobNumber),
  };
}

function appendPlannerWarnings(response: Record<string, unknown>, plannerResult: Record<string, unknown>, deps: MutationHandlerDeps) {
  const warnings = Array.isArray(plannerResult.warnings)
    ? plannerResult.warnings.map((value) => deps.asTrimmedString(value)).filter(Boolean)
    : [];
  if (!warnings.length) {
    return response;
  }
  const existingWarnings = Array.isArray(response.warnings) ? response.warnings : [];
  return {
    ...response,
    warnings: [...existingWarnings, ...warnings],
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function addJobNumber(target: Set<string>, value: unknown, deps: MutationHandlerDeps) {
  const normalized = deps.asTrimmedString(value);
  if (normalized) {
    target.add(normalized);
  }
}

function normalizeJobIds(values: unknown[], deps: MutationHandlerDeps) {
  return Array.from(
    new Set(
      values
        .map((value) => deps.asTrimmedString(value).toLowerCase())
        .filter((value) => JOB_ID_PATTERN.test(value)),
    ),
  );
}

function addJobId(target: Set<string>, value: unknown, deps: MutationHandlerDeps) {
  const [normalized] = normalizeJobIds([value], deps);
  if (normalized) {
    target.add(normalized);
  }
}

function addBoxId(target: Set<string>, value: unknown, deps: MutationHandlerDeps) {
  const normalized = deps.asTrimmedString(value);
  if (normalized) {
    target.add(normalized);
  }
}

function addCaulkProductWarehousePair(
  target: Map<string, Record<string, string>>,
  productIdValue: unknown,
  warehouseValue: unknown,
  deps: MutationHandlerDeps,
) {
  const productId = deps.asTrimmedString(productIdValue);
  const warehouse = deps.asTrimmedString(warehouseValue).toUpperCase();
  if (!productId || !warehouse) {
    return;
  }
  target.set(`${productId}:${warehouse}`, { productId, warehouse });
}

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
  let response = await handler({ client, identity, orgId, actor, logicalPath, payload, normalizedPayload }, deps);
  const responseData = asRecord(response.data);
  const scope = buildAutoPlannerScope(logicalPath, normalizedPayload, responseData, deps);

  if (scope) {
    const plannerResult = await deps.reconcileAutoPlannedAllocations(client, orgId, actor, scope);
    const detailIdentity = getJobIdentityForPlannerDetailReload(logicalPath, normalizedPayload, responseData, deps);
    const detailJobNumber =
      detailIdentity.jobNumber ||
      getJobNumberForPlannerDetailReload(logicalPath, normalizedPayload, responseData, deps);

    if (detailIdentity.jobId) {
      response = {
        ...response,
        data: await deps.buildJobDetailById(client, orgId, detailIdentity.jobId),
      };
    } else if (detailJobNumber) {
      response = {
        ...response,
        data: await deps.buildJobDetail(client, orgId, detailJobNumber),
      };
    }

    response = appendPlannerWarnings(response, plannerResult, deps);
  }

  return response;
}
