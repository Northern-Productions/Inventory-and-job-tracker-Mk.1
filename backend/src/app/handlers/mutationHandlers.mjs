// Purpose: Mutation-route dispatch map for the modular backend handler.
import { HttpError, ok } from '../../lib/http.mjs';
import { requireString } from '../core/helpers.mjs';
import { normalizeSchedulePayloadAliases } from '../../../../shared/schedulePayloadAliases.mjs';
import { applyAllocationPlan, checkoutAllJobMaterials } from '../services/allocations.mjs';
import { undoAudit } from '../services/audit.mjs';
import { upsertBoxDealer } from '../services/boxDealers.mjs';
import {
  addCaulkAllocation,
  cancelCaulkTransfer,
  checkinCaulkAllocation,
  checkoutCaulkAllocation,
  receiveCaulkTransfer,
  removeCaulkAllocation,
  updateCaulkAllocation,
} from '../services/caulkAllocations.mjs';
import {
  mutateCaulkStock,
  ownerUpsertCaulkManufacturer,
  transferCaulkStock,
  upsertCaulkProduct,
} from '../services/caulk.mjs';
import { createFilmOrder, deleteFilmOrder, manualFulfillFilmOrder } from '../services/filmOrders.mjs';
import {
  buildJobDetail,
  buildJobDetailById,
  cancelJob,
  completeJob,
  createJob,
  deleteJob,
  clearAllocationPlannerSuppression,
  removeJobBoxAllocation,
  reopenJob,
  setJobRequirementState,
  setJobPhaseLaborState,
  setJobStagedPickup,
  updateJob,
} from '../services/jobs.mjs';
import {
  addBox,
  cancelBoxTransfer,
  deleteBox,
  markLabelsPrinted,
  receiveOrderedBox,
  receiveBoxTransfer,
  setBoxStatus,
  startBoxTransfer,
  updateBox,
} from '../services/boxes.mjs';
import {
  applyAuthenticatedSessionContext,
  approveAccessRequestByUserId,
  approveUsernameChangeRequestByUserId,
  demoteAdminToMemberInternal,
  denyAccessRequestByUserId,
  denyUsernameChangeRequestByUserId,
  promoteAdminToOwnerInternal,
  promoteMemberToAdminInternal,
  requestUsernameChange,
  updateAdminFeaturePermissionsInternal,
  updateMemberFeaturePermissionsInternal,
  updateOwnerNotificationPreferencesInternal,
  updateUserFeaturePermissionsInternal,
  updateUserDefaultWarehouse,
} from '../services/access.mjs';
import { addWarehouse } from '../services/warehouses.mjs';
import { withMutation } from '../../db/client.mjs';
import {
  buildAutoPlannerScope,
  getJobIdentityForPlannerDetailReload,
  getJobNumberForPlannerDetailReload,
  normalizePlannerWarnings,
  reconcileAutoPlannedAllocations,
} from '../services/runtime/runtimeAutoAllocationPlanner.mjs';

const mutationHandlers = {
  '/profile/username': async ({ client, orgId, authContext, params }) =>
    ok(await requestUsernameChange(client, orgId, authContext, params)),
  '/profile/default-warehouse': async ({ client, orgId, authContext, params }) => {
    const result = await updateUserDefaultWarehouse(client, orgId, authContext, params);
    authContext.defaultWarehouse = result.defaultWarehouse || '';
    return ok(result);
  },
  '/admin/access/requests/approve': async ({ client, orgId, authContext, params }) =>
    ok(await approveAccessRequestByUserId(client, orgId, authContext.actor, params, authContext.userId)),
  '/admin/access/requests/deny': async ({ client, orgId, authContext, params }) =>
    ok(await denyAccessRequestByUserId(client, orgId, authContext.actor, params, authContext.userId)),
  '/admin/username-requests/approve': async ({ client, orgId, authContext, params }) =>
    ok(await approveUsernameChangeRequestByUserId(client, orgId, authContext.actor, params, authContext.userId)),
  '/admin/username-requests/deny': async ({ client, orgId, authContext, params }) =>
    ok(await denyUsernameChangeRequestByUserId(client, orgId, authContext.actor, params, authContext.userId)),
  '/admin/member-permissions': async ({ client, orgId, authContext, params }) =>
    ok({ permissions: await updateMemberFeaturePermissionsInternal(client, orgId, authContext.actor, params) }),
  '/admin/user-permissions': async ({ client, orgId, authContext, params }) =>
    ok({ permissions: await updateUserFeaturePermissionsInternal(client, orgId, authContext.actor, params) }),
  '/owner/admin-permissions': async ({ client, orgId, authContext, params }) =>
    ok({ permissions: await updateAdminFeaturePermissionsInternal(client, orgId, authContext.actor, params) }),
  '/admin/roles/promote-member-to-admin': async ({ client, orgId, authContext, params }) =>
    ok(await promoteMemberToAdminInternal(client, orgId, authContext.actor, params, authContext.userId)),
  '/owner/roles/demote-admin-to-member': async ({ client, orgId, params }) =>
    ok(await demoteAdminToMemberInternal(client, orgId, params)),
  '/owner/roles/promote-admin-to-owner': async ({ client, orgId, authContext, params }) =>
    ok(await promoteAdminToOwnerInternal(client, orgId, authContext.actor, params)),
  '/owner/notification-preferences': async ({ client, orgId, authContext, params }) =>
    ok(
      await updateOwnerNotificationPreferencesInternal(
        client,
        orgId,
        authContext.userId,
        authContext.actor,
        params
      )
    ),
  '/owner/warehouses/add': async ({ client, orgId, authContext, params }) =>
    ok(await addWarehouse(client, orgId, authContext.actor, params)),
  '/owner/caulk/manufacturers/upsert': async ({ client, orgId, authContext, params }) =>
    ok(await ownerUpsertCaulkManufacturer(client, orgId, authContext.actor, params)),
  '/box-dealers/upsert': async ({ client, orgId, authContext, params }) =>
    ok(await upsertBoxDealer(client, orgId, authContext.actor, params)),
  '/caulk/products/upsert': async ({ client, orgId, authContext, params }) =>
    ok(await upsertCaulkProduct(client, orgId, authContext.actor, params)),
  '/caulk/mutate': async ({ client, orgId, authContext, params }) =>
    ok(await mutateCaulkStock(client, orgId, authContext.actor, params)),
  '/caulk/transfer': async ({ client, orgId, authContext, params }) =>
    ok(await transferCaulkStock(client, orgId, authContext.actor, params)),
  '/allocations/caulk/add': async ({ client, orgId, authContext, params }) => {
    const response = await addCaulkAllocation(client, orgId, authContext.actor, params);
    return ok(response.result, response.warnings);
  },
  '/allocations/caulk/update': async ({ client, orgId, authContext, params }) => {
    const response = await updateCaulkAllocation(client, orgId, authContext.actor, params);
    return ok(response.result, response.warnings);
  },
  '/allocations/caulk/checkout': async ({ client, orgId, authContext, params }) => {
    const response = await checkoutCaulkAllocation(client, orgId, authContext.actor, params);
    return ok(response.result, response.warnings);
  },
  '/allocations/caulk/checkin': async ({ client, orgId, authContext, params }) => {
    const response = await checkinCaulkAllocation(client, orgId, authContext.actor, params);
    return ok(response.result, response.warnings);
  },
  '/allocations/caulk/remove': async ({ client, orgId, authContext, params }) => {
    const response = await removeCaulkAllocation(client, orgId, authContext.actor, params);
    return ok(response.result, response.warnings);
  },
  '/caulk/transfers/receive': async ({ client, orgId, authContext, params }) => {
    const response = await receiveCaulkTransfer(client, orgId, authContext.actor, params);
    return ok(response.result, response.warnings);
  },
  '/caulk/transfers/cancel': async ({ client, orgId, authContext, params }) => {
    const response = await cancelCaulkTransfer(client, orgId, authContext.actor, params);
    return ok(response.result, response.warnings);
  },
  '/boxes/add': async ({ client, orgId, authContext, params }) =>
    addBox(client, orgId, params, authContext.actor),
  '/boxes/transfer/start': async ({ client, orgId, authContext, params }) =>
    startBoxTransfer(client, orgId, params, authContext.actor),
  '/boxes/transfer/receive': async ({ client, orgId, authContext, params }) =>
    receiveBoxTransfer(client, orgId, params, authContext.actor),
  '/boxes/transfer/cancel': async ({ client, orgId, authContext, params }) =>
    cancelBoxTransfer(client, orgId, params, authContext.actor),
  '/allocations/add': async ({ client, orgId, authContext, params }) =>
    applyAllocationPlan(
      client,
      orgId,
      normalizeLegacySchedulePayload('/allocations/add', params),
      authContext.actor
    ),
  '/allocations/apply': async ({ client, orgId, authContext, params }) =>
    applyAllocationPlan(
      client,
      orgId,
      normalizeLegacySchedulePayload('/allocations/apply', params),
      authContext.actor
    ),
  '/allocations/remove-box': async ({ client, orgId, authContext, params }) =>
    removeJobBoxAllocation(client, orgId, params, authContext.actor),
  '/allocations/planner-suppression/clear': async ({ client, orgId, authContext, params }) =>
    clearAllocationPlannerSuppression(client, orgId, params, authContext.actor),
  '/jobs/create': async ({ client, orgId, authContext, params }) =>
    createJob(client, orgId, normalizeLegacySchedulePayload('/jobs/create', params), authContext.actor),
  '/jobs/update': async ({ client, orgId, authContext, params }) =>
    updateJob(client, orgId, normalizeLegacySchedulePayload('/jobs/update', params), authContext.actor),
  '/jobs/requirement-state': async ({ client, orgId, authContext, params }) =>
    setJobRequirementState(client, orgId, params, authContext.actor),
  '/jobs/phase-state': async ({ client, orgId, authContext, params }) =>
    setJobPhaseLaborState(client, orgId, params, authContext.actor),
  '/jobs/set-staged-pickup': async ({ client, orgId, authContext, params }) => {
    const jobNumber = requireString(params.jobNumber, 'JobNumber');
    const result = await setJobStagedPickup(
      client,
      orgId,
      jobNumber,
      params && params.isStagedForPickup,
      authContext.actor,
      params
    );
    if (!result) {
      throw new HttpError(500, 'Job staged pickup update failed.');
    }
    return ok(
      result.jobId
        ? await buildJobDetailById(client, orgId, result.jobId)
        : await buildJobDetail(client, orgId, jobNumber),
      result.warnings || []
    );
  },
  '/jobs/checkout-all': async ({ client, orgId, authContext, params }) => {
    const jobNumber = requireString(params.jobNumber, 'JobNumber');
    const result = await applyCheckoutAllJobMaterials(client, orgId, params, authContext.actor);
    if (!result) {
      throw new HttpError(500, 'Job checkout-all update failed.');
    }
    return ok(
      result.jobId
        ? await buildJobDetailById(client, orgId, result.jobId)
        : await buildJobDetail(client, orgId, jobNumber),
      result.warnings || []
    );
  },
  '/jobs/complete': async ({ client, orgId, authContext, params }) =>
    completeJob(client, orgId, params, authContext.actor),
  '/jobs/delete': async ({ client, orgId, authContext, params }) =>
    deleteJob(client, orgId, params, authContext.actor, authContext.role),
  '/jobs/reopen': async ({ client, orgId, authContext, params }) =>
    reopenJob(client, orgId, params, authContext.actor),
  '/film-orders/create': async ({ client, orgId, authContext, params }) =>
    createFilmOrder(client, orgId, params, authContext.actor),
  '/film-orders/cancel': async ({ client, orgId, authContext, params }) =>
    cancelJob(client, orgId, params, authContext.actor),
  '/film-orders/delete': async ({ client, orgId, authContext, params }) =>
    deleteFilmOrder(client, orgId, params, authContext.actor),
  '/film-orders/manual-fulfill': async ({ client, orgId, authContext, params }) =>
    manualFulfillFilmOrder(client, orgId, params, authContext.actor),
  '/boxes/update': async ({ client, orgId, authContext, params }) =>
    updateBox(client, orgId, params, authContext.actor),
  '/boxes/delete': async ({ client, orgId, authContext, params }) =>
    deleteBox(client, orgId, params, authContext.actor),
  '/boxes/receive': async ({ client, orgId, authContext, params }) =>
    receiveOrderedBox(client, orgId, params, authContext.actor),
  '/boxes/labels/mark-printed': async ({ client, orgId, authContext, params }) =>
    markLabelsPrinted(client, orgId, params, authContext.actor),
  '/boxes/set-status': async ({ client, orgId, authContext, params }) =>
    setBoxStatus(client, orgId, params, authContext.actor),
  '/audit/undo': async ({ client, orgId, authContext, params }) =>
    undoAudit(client, orgId, params, authContext.actor),
};

function normalizeLegacySchedulePayload(logicalPath, params) {
  return normalizeSchedulePayloadAliases(logicalPath, params);
}

async function applyCheckoutAllJobMaterials(client, orgId, payload, actor) {
  return checkoutAllJobMaterials(client, orgId, payload, actor);
}

export async function dispatchMutationWithHandlers(logicalPath, params, authContext) {
  return withMutation(async (client) => {
    await applyAuthenticatedSessionContext(client, authContext);

    const handler = mutationHandlers[logicalPath];
    if (!handler) {
      throw new HttpError(404, `Route not found: ${logicalPath || '/'}`);
    }

    let response = await handler({ client, orgId: authContext.orgId, params, authContext });
    const normalizedParams = normalizeLegacySchedulePayload(logicalPath, params);
    const responseData = response?.data && typeof response.data === 'object' ? response.data : {};
    const scope = buildAutoPlannerScope(logicalPath, normalizedParams, responseData);

    if (scope) {
      const plannerResult = await reconcileAutoPlannedAllocations(
        client,
        authContext.orgId,
        authContext.actor,
        scope
      );
      const plannerWarnings = normalizePlannerWarnings(plannerResult);
      const detailIdentity = getJobIdentityForPlannerDetailReload(logicalPath, normalizedParams, responseData);
      const detailJobNumber =
        detailIdentity.jobNumber || getJobNumberForPlannerDetailReload(logicalPath, normalizedParams, responseData);

      if (detailIdentity.jobId) {
        response = {
          ...response,
          data: await buildJobDetailById(client, authContext.orgId, detailIdentity.jobId),
        };
      } else if (detailJobNumber) {
        response = {
          ...response,
          data: await buildJobDetail(client, authContext.orgId, detailJobNumber),
        };
      }

      if (plannerWarnings.length > 0) {
        response = {
          ...response,
          warnings: [...(Array.isArray(response?.warnings) ? response.warnings : []), ...plannerWarnings],
        };
      }
    }

    return response;
  });
}
