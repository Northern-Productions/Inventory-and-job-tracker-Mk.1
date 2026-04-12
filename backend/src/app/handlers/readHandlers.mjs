// Purpose: Read-route dispatch map for the modular backend handler.
import { HttpError, ok } from '../../lib/http.mjs';
import { requireString } from '../core/helpers.mjs';
import { findBoxById, listAllocationsByBox, toPublicAllocation, toPublicBox } from '../repositories/inventoryRepositories.mjs';
import {
  buildAllocationJobList,
  buildAllocationJobDetail,
  previewAllocationPlan,
} from '../services/allocations.mjs';
import { listAudit, listAuditEntriesByBox, listRollHistoryByBox } from '../services/audit.mjs';
import {
  listCaulkManufacturers,
  listCaulkProducts,
  listCaulkStock,
  listCaulkTransactions,
} from '../services/caulk.mjs';
import { buildFilmOrdersList, buildFilmCatalog } from '../services/filmOrders.mjs';
import {
  buildJobDetail,
  buildJobsCalendar,
  buildJobsList,
  buildJobsSearchResults,
  buildOwnerAssetTotalCost,
  buildReportsSummary,
} from '../services/jobs.mjs';
import { buildSearchBoxes, getBoxTransferByBox, getBoxTransferPlan } from '../services/boxes.mjs';
import { buildAppAttentionSummary } from '../services/appShell.mjs';
import {
  getGeneralFeaturePermissions,
  getOwnerNotificationPreferencesInternal,
  getUserFeaturePermissionsInternal,
  listAccessRequests,
  listAdminFeaturePermissions,
  listUsernameChangeRequests,
} from '../services/access.mjs';
import { withReadClient } from '../../db/client.mjs';

const readHandlers = {
  '/app/attention-summary': async ({ client, orgId, authContext }) =>
    ok(await buildAppAttentionSummary(client, orgId, authContext)),
  '/admin/access/requests': async ({ client, orgId, params }) =>
    ok({ entries: await listAccessRequests(client, orgId, params.status) }),
  '/admin/username-requests': async ({ client, orgId, params }) =>
    ok({ entries: await listUsernameChangeRequests(client, orgId, params.status) }),
  '/admin/member-permissions': async ({ client, orgId }) =>
    ok(await getGeneralFeaturePermissions(client, orgId)),
  '/admin/user-permissions': async ({ client, orgId, params }) =>
    ok({ permissions: await getUserFeaturePermissionsInternal(client, orgId, params) }),
  '/owner/admin-permissions': async ({ client, orgId }) =>
    ok({ entries: await listAdminFeaturePermissions(client, orgId) }),
  '/owner/notification-preferences': async ({ client, orgId, authContext }) =>
    ok(await getOwnerNotificationPreferencesInternal(client, orgId, authContext.userId)),
  '/boxes/search': async ({ client, orgId, params }) => ok(await buildSearchBoxes(client, orgId, params)),
  '/boxes/get': async ({ client, orgId, params }) => {
    const found = await findBoxById(client, orgId, params.boxId);
    if (!found) {
      throw new HttpError(404, 'Box not found.');
    }
    return ok(toPublicBox(found));
  },
  '/boxes/transfer/by-box': async ({ client, orgId, params }) =>
    ok(await getBoxTransferByBox(client, orgId, params.boxId)),
  '/boxes/transfer/plan': async ({ client, orgId, params }) =>
    ok(await getBoxTransferPlan(client, orgId, params)),
  '/audit/list': async ({ client, orgId, params }) =>
    ok({ entries: await listAudit(client, orgId, params) }),
  '/audit/by-box': async ({ client, orgId, params }) =>
    ok({ entries: await listAuditEntriesByBox(client, orgId, requireString(params.boxId, 'boxId')) }),
  '/allocations/by-box': async ({ client, orgId, params }) =>
    ok({
      entries: (await listAllocationsByBox(client, orgId, requireString(params.boxId, 'boxId'))).map(
        toPublicAllocation
      ),
    }),
  '/allocations/jobs': async ({ client, orgId }) =>
    ok({ entries: await buildAllocationJobList(client, orgId) }),
  '/allocations/by-job': async ({ client, orgId, params }) =>
    ok(await buildAllocationJobDetail(client, orgId, params.jobNumber)),
  '/allocations/preview': async ({ client, orgId, params }) =>
    ok(await previewAllocationPlan(client, orgId, normalizeLegacyScheduleParams(params))),
  '/jobs/list': async ({ client, orgId, params }) => {
    const limitValue = Number(params && params.limit);
    const limit = Number.isFinite(limitValue) && limitValue >= 0 ? Math.floor(limitValue) : 25;
    const jobNumbers = Array.isArray(params?.jobNumbers)
      ? params.jobNumbers
      : typeof params?.jobNumbers === 'string'
        ? [params.jobNumbers]
        : [];
    return ok({
      entries: await buildJobsList(client, orgId, limit, params && params.lifecycleStatus, jobNumbers),
    });
  },
  '/jobs/calendar': async ({ client, orgId, params }) =>
    ok({
      entries: await buildJobsCalendar(
        client,
        orgId,
        params && params.view,
        params && params.anchorDate,
        params && params.month,
        params && params.lifecycleStatus
      ),
    }),
  '/jobs/search': async ({ client, orgId, params }) => {
    const limitValue = Number(params && params.limit);
    const limit = Number.isFinite(limitValue) && limitValue > 0 ? Math.floor(limitValue) : 25;
    return ok({
      entries: await buildJobsSearchResults(client, orgId, params && params.query, limit, params && params.lifecycleStatus),
    });
  },
  '/jobs/get': async ({ client, orgId, params }) => ok(await buildJobDetail(client, orgId, params.jobNumber)),
  '/film-orders/list': async ({ client, orgId }) => ok({ entries: await buildFilmOrdersList(client, orgId) }),
  '/film-data/catalog': async ({ client, orgId }) => ok({ entries: await buildFilmCatalog(client, orgId) }),
  '/roll-history/by-box': async ({ client, orgId, params }) =>
    ok({ entries: await listRollHistoryByBox(client, orgId, requireString(params.boxId, 'boxId')) }),
  '/reports/summary': async ({ client, orgId, params }) => ok(await buildReportsSummary(client, orgId, params)),
  '/owner/reports/asset-total-cost': async ({ client, orgId, params }) =>
    ok(await buildOwnerAssetTotalCost(client, orgId, params)),
  '/caulk/manufacturers/list': async ({ client, orgId }) =>
    ok({ entries: await listCaulkManufacturers(client, orgId) }),
  '/caulk/products/list': async ({ client, orgId }) =>
    ok({ entries: await listCaulkProducts(client, orgId) }),
  '/caulk/stock/list': async ({ client, orgId, params }) =>
    ok({ entries: await listCaulkStock(client, orgId, params) }),
  '/caulk/transactions/list': async ({ client, orgId, params }) =>
    ok({ entries: await listCaulkTransactions(client, orgId, params) }),
};

function normalizeLegacyScheduleParams(params) {
  if (!params || typeof params !== 'object') {
    return {};
  }

  if (params.installDate !== undefined || params.jobDate === undefined) {
    return params;
  }

  return {
    ...params,
    installDate: params.jobDate
  };
}

export async function dispatchReadWithHandlers(logicalPath, params, authContext) {
  return withReadClient(async (client) => {
    const handler = readHandlers[logicalPath];
    if (!handler) {
      throw new HttpError(404, `Route not found: ${logicalPath || '/'}`);
    }

    return handler({ client, orgId: authContext.orgId, params, authContext });
  });
}
