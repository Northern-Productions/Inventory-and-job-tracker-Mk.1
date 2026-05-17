// Purpose: Read-route dispatch map for the modular backend handler.
import { HttpError, ok } from '../../lib/http.mjs';
import { requireString } from '../core/helpers.mjs';
import {
  findBoxById,
  findFilmOrderById,
  listAllocationsByBox,
  listFilmOrderLinksByBoxId,
  toPublicAllocation,
  toPublicBox,
} from '../repositories/inventoryRepositories.mjs';
import {
  buildAllocationJobList,
  buildAllocationJobDetail,
  buildReadAllocationJobDetail,
  previewAllocationPlan,
} from '../services/allocations.mjs';
import {
  applyReservationMetricsToBox,
  buildBoxReservationMetrics,
} from '../services/runtime/runtimeAllocationReservations.mjs';
import { listAudit, listAuditEntriesByBox, listRollHistoryByBox } from '../services/audit.mjs';
import { listBoxDealers } from '../services/boxDealers.mjs';
import {
  listCaulkManufacturers,
  listPendingCaulkTransfers,
  listCaulkProducts,
  listCaulkStock,
  listCaulkTransactions,
} from '../services/caulk.mjs';
import { buildFilmOrdersList, buildFilmCatalog } from '../services/filmOrders.mjs';
import {
  buildJobsCalendar,
  buildJobsList,
  buildReadJobDetail,
  buildReadJobDetailById,
  buildJobsSearchResults,
  checkJobDuplicate,
  buildOwnerAssetTotalCost,
  buildReportsSummary,
} from '../services/jobs.mjs';
import { findJobById } from '../repositories/jobsRepository.mjs';
import { buildSearchBoxes, getBoxTransferByBox, getBoxTransferPlan } from '../services/boxes.mjs';
import { buildAppAttentionSummary } from '../services/appShell.mjs';
import { listWarehouses } from '../services/warehouses.mjs';
import {
  getGeneralFeaturePermissions,
  getOwnerNotificationPreferencesInternal,
  getUserFeaturePermissionsInternal,
  listAccessRequests,
  listAdminFeaturePermissions,
  listUsernameChangeRequests,
} from '../services/access.mjs';
import { withReadClient } from '../../db/client.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asOptionalScopeFields(source) {
  const workScope = String(source?.workScope ?? source?.sections ?? '').trim();
  const sections = String(source?.sections ?? source?.workScope ?? '').trim();
  return {
    ...(workScope ? { workScope } : {}),
    ...(sections ? { sections } : {}),
  };
}

function isUuidLike(value) {
  return UUID_PATTERN.test(String(value || '').trim());
}

export async function buildOrderedForJobsForBox(client, orgId, boxId, deps = {}) {
  const listLinks = deps.listFilmOrderLinksByBoxId || listFilmOrderLinksByBoxId;
  const findOrder = deps.findFilmOrderById || findFilmOrderById;
  const findJob = deps.findJobById || findJobById;
  const links = await listLinks(client, orgId, boxId);
  const orderedForJobs = [];
  const seen = new Set();
  const jobHeaderById = new Map();

  for (const link of Array.isArray(links) ? links : []) {
    const filmOrderId = String(link?.filmOrderId || '').trim();
    if (!filmOrderId) {
      continue;
    }

    const filmOrder = await findOrder(client, orgId, filmOrderId);
    const jobId = String(filmOrder?.jobId || '').trim();
    const jobNumber = String(filmOrder?.jobNumber || '').trim();
    if (!jobNumber) {
      continue;
    }

    const key = `${filmOrderId}\u0000${jobNumber}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const orderedFeet =
      link?.orderedFeet === null || link?.orderedFeet === undefined || link?.orderedFeet === ''
        ? NaN
        : Number(link.orderedFeet);
    let scopeFields = asOptionalScopeFields(filmOrder);
    if (!scopeFields.workScope && jobId && isUuidLike(jobId)) {
      if (!jobHeaderById.has(jobId)) {
        jobHeaderById.set(jobId, (await findJob(client, orgId, jobId)) || null);
      }
      scopeFields = asOptionalScopeFields(jobHeaderById.get(jobId));
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

export async function buildLastCheckoutScopeForBox(client, orgId, box, deps = {}) {
  const checkoutJobId = String(box?.lastCheckoutJobId || '').trim();
  if (!checkoutJobId || !isUuidLike(checkoutJobId)) {
    return {};
  }

  const findJob = deps.findJobById || findJobById;
  return asOptionalScopeFields((await findJob(client, orgId, checkoutJobId)) || null);
}

export async function buildJobScopeFieldsByJobId(client, orgId, entries, deps = {}) {
  const findJob = deps.findJobById || findJobById;
  const jobIds = [
    ...new Set(
      (Array.isArray(entries) ? entries : [])
        .map((entry) => String(entry?.jobId || '').trim())
        .filter((jobId) => jobId && isUuidLike(jobId))
    ),
  ];
  const scopeFieldsByJobId = new Map();

  for (const jobId of jobIds) {
    const job = await findJob(client, orgId, jobId);
    scopeFieldsByJobId.set(jobId, asOptionalScopeFields(job || null));
  }

  return scopeFieldsByJobId;
}

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
  '/warehouses/list': async ({ client, orgId, authContext }) =>
    ok({ entries: await listWarehouses(client, orgId, authContext) }),
  '/boxes/search': async ({ client, orgId, params }) => ok(await buildSearchBoxes(client, orgId, params)),
  '/boxes/get': async ({ client, orgId, params }) => {
    const found = await findBoxById(client, orgId, params.boxId);
    if (!found) {
      throw new HttpError(404, 'Box not found.');
    }
    const allocations = await listAllocationsByBox(client, orgId, found.boxId);
    const orderedForJobs = await buildOrderedForJobsForBox(client, orgId, found.boxId);
    const lastCheckoutScope = await buildLastCheckoutScopeForBox(client, orgId, found);
    return ok(
      toPublicBox(
        applyReservationMetricsToBox(
          {
            ...found,
            orderedForJobs,
            ...(lastCheckoutScope.workScope ? { lastCheckoutWorkScope: lastCheckoutScope.workScope } : {}),
            ...(lastCheckoutScope.sections ? { lastCheckoutSections: lastCheckoutScope.sections } : {}),
          },
          allocations
        )
      )
    );
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
    (() => {
      const normalizedBoxId = requireString(params.boxId, 'boxId');
      return listAllocationsByBox(client, orgId, normalizedBoxId).then(async (entries) => {
        const box = await findBoxById(client, orgId, normalizedBoxId);
        const reservationMetrics = box ? buildBoxReservationMetrics(box, entries) : null;
        const scopeFieldsByJobId = await buildJobScopeFieldsByJobId(client, orgId, entries);
        return ok({
          entries: entries.map((entry) => {
            const reservationSnapshot =
              reservationMetrics?.allocationSnapshotsById?.[entry.allocationId] || null;
            const jobId = String(entry?.jobId || '').trim();
            return {
              ...toPublicAllocation(entry),
              ...(jobId ? { jobId } : {}),
              ...(scopeFieldsByJobId.get(jobId) || {}),
              backedPhysicalFeet: reservationSnapshot ? reservationSnapshot.backedPhysicalFeet : entry.allocatedFeet,
              reservationState: reservationSnapshot ? reservationSnapshot.reservationState : 'WITHOUT_INSTALL_DATE',
            };
          }),
        });
      });
    })(),
  '/allocations/jobs': async ({ client, orgId }) =>
    ok({ entries: await buildAllocationJobList(client, orgId) }),
  '/allocations/by-job': async ({ orgId, params }) =>
    ok(await buildReadAllocationJobDetail(orgId, params.jobNumber)),
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
  '/jobs/check-duplicate': async ({ client, orgId, params }) =>
    ok(await checkJobDuplicate(client, orgId, params || {})),
  '/jobs/get': async ({ orgId, params }) => ok(await buildReadJobDetail(orgId, params.jobNumber)),
  '/jobs/get-by-id': async ({ orgId, params }) => ok(await buildReadJobDetailById(orgId, params.jobId)),
  '/film-orders/list': async ({ client, orgId }) => ok({ entries: await buildFilmOrdersList(client, orgId) }),
  '/film-data/catalog': async ({ client, orgId }) => ok({ entries: await buildFilmCatalog(client, orgId) }),
  '/roll-history/by-box': async ({ client, orgId, params }) => {
    const entries = await listRollHistoryByBox(client, orgId, requireString(params.boxId, 'boxId'));
    const scopeFieldsByJobId = await buildJobScopeFieldsByJobId(client, orgId, entries);
    return ok({
      entries: entries.map((entry) => {
        const jobId = String(entry?.jobId || '').trim();
        return {
          ...entry,
          ...(scopeFieldsByJobId.get(jobId) || {}),
        };
      }),
    });
  },
  '/reports/summary': async ({ client, orgId, params }) => ok(await buildReportsSummary(client, orgId, params)),
  '/owner/reports/asset-total-cost': async ({ client, orgId, params }) =>
    ok(await buildOwnerAssetTotalCost(client, orgId, params)),
  '/caulk/manufacturers/list': async ({ client, orgId }) =>
    ok({ entries: await listCaulkManufacturers(client, orgId) }),
  '/box-dealers/list': async ({ client, orgId }) =>
    ok({ entries: await listBoxDealers(client, orgId) }),
  '/caulk/products/list': async ({ client, orgId }) =>
    ok({ entries: await listCaulkProducts(client, orgId) }),
  '/caulk/stock/list': async ({ client, orgId, params }) =>
    ok({ entries: await listCaulkStock(client, orgId, params) }),
  '/caulk/transactions/list': async ({ client, orgId, params }) =>
    ok({ entries: await listCaulkTransactions(client, orgId, params) }),
  '/caulk/transfers/list': async ({ client, orgId, params }) =>
    ok({ entries: await listPendingCaulkTransfers(client, orgId, params) }),
};

const POOLED_READ_HANDLERS = new Set([
  '/allocations/by-job',
  '/allocations/jobs',
  '/jobs/calendar',
  '/jobs/get',
  '/jobs/get-by-id',
  '/jobs/list',
  '/jobs/search',
  '/reports/summary',
]);

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
  const handler = readHandlers[logicalPath];
  if (!handler) {
    throw new HttpError(404, `Route not found: ${logicalPath || '/'}`);
  }

  if (POOLED_READ_HANDLERS.has(logicalPath)) {
    return handler({ client: null, orgId: authContext.orgId, params, authContext });
  }

  return withReadClient(async (client) =>
    handler({ client, orgId: authContext.orgId, params, authContext })
  );
}
