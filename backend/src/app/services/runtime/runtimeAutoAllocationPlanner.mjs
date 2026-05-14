import { queryRow } from '../../../db/client.mjs';
import { asTrimmedString } from '../runtimeDeps.mjs';

const ORG_WIDE_SCOPE = Object.freeze({});
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PLANNER_MUTATION_ROUTES = new Set([
  '/caulk/mutate',
  '/caulk/transfer',
  '/allocations/caulk/add',
  '/allocations/caulk/update',
  '/allocations/caulk/checkout',
  '/allocations/caulk/checkin',
  '/allocations/caulk/remove',
  '/caulk/transfers/receive',
  '/caulk/transfers/cancel',
  '/boxes/add',
  '/boxes/update',
  '/boxes/delete',
  '/boxes/receive',
  '/boxes/set-status',
  '/boxes/transfer/start',
  '/boxes/transfer/receive',
  '/boxes/transfer/cancel',
  '/allocations/add',
  '/allocations/apply',
  '/allocations/remove-box',
  '/jobs/create',
  '/jobs/update',
  '/jobs/set-staged-pickup',
  '/jobs/checkout-all',
  '/jobs/complete',
  '/jobs/delete',
  '/jobs/reopen',
  '/film-orders/cancel',
  '/film-orders/delete',
  '/audit/undo',
]);

const ORG_WIDE_MUTATION_ROUTES = new Set([
  '/jobs/complete',
  '/jobs/delete',
  '/film-orders/cancel',
  '/audit/undo',
]);

const SQL_PLANNER_HANDLED_ROUTES = new Set([
  '/allocations/caulk/remove',
]);

const JOB_DETAIL_RELOAD_ROUTES = new Set([
  '/jobs/create',
  '/jobs/update',
  '/jobs/set-staged-pickup',
  '/jobs/checkout-all',
  '/jobs/complete',
  '/jobs/reopen',
]);

const JOB_ID_SHADOW_SCOPE_ROUTES = new Set([
  '/allocations/apply',
  '/allocations/remove-box',
  '/jobs/update',
  '/jobs/reopen',
]);

/**
 * PURPOSE:
 * Builds the narrowest safe planner scope available from a mutation request and
 * response so the SQL planner can reconcile stored AUTO_PLANNED reservations.
 *
 * AFFECTS:
 * Job create/edit/lifecycle flows, box mutations, manual film/caulk allocation
 * changes, transfer/receipt flows, and optimistic reload behavior.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * backend mutationHandlers, Supabase Edge mutationHandlers, planner migration
 * scope parsing, and cache invalidation for job detail/allocation views.
 *
 * COMMON FAILURE MODES:
 * Missing a box/job scope leaves stale planned rows; overly broad scopes slow
 * mutations; lifecycle cleanup needs org-wide planning after capacity is freed.
 */
function buildAutoPlannerScope(logicalPath, params = {}, responseData = {}) {
  if (!PLANNER_MUTATION_ROUTES.has(logicalPath)) {
    return null;
  }

  if (SQL_PLANNER_HANDLED_ROUTES.has(logicalPath)) {
    return null;
  }

  if (logicalPath === '/film-orders/delete') {
    return buildFilmOrderDeletePlannerScope(params, responseData);
  }

  if (ORG_WIDE_MUTATION_ROUTES.has(logicalPath)) {
    return ORG_WIDE_SCOPE;
  }

  const jobIds = new Set();
  const jobNumbers = new Set();
  const boxIds = new Set();
  const caulkProductWarehousePairs = new Map();

  if (JOB_ID_SHADOW_SCOPE_ROUTES.has(logicalPath)) {
    addJobId(jobIds, params.jobId);
  }

  addJobNumber(jobNumbers, params.jobNumber);
  addJobNumber(jobNumbers, responseData.jobNumber);
  addJobNumber(jobNumbers, responseData?.job?.jobNumber);
  addJobNumber(jobNumbers, responseData?.box?.jobNumber);
  addJobNumber(jobNumbers, responseData?.filmOrder?.jobNumber);

  addBoxId(boxIds, params.boxId);
  addBoxId(boxIds, params.sourceBoxId);
  addBoxId(boxIds, params.destinationBoxId);
  addBoxId(boxIds, responseData.boxId);
  addBoxId(boxIds, responseData?.box?.boxId);
  addBoxId(boxIds, responseData?.allocation?.boxId);
  addBoxId(boxIds, responseData?.allocation?.sourceBoxId);

  if (Array.isArray(responseData?.allocations)) {
    for (const allocation of responseData.allocations) {
      addJobNumber(jobNumbers, allocation?.jobNumber);
      addBoxId(boxIds, allocation?.boxId);
    }
  }

  addCaulkProductWarehousePair(caulkProductWarehousePairs, params.productId, params.warehouse);
  addCaulkProductWarehousePair(caulkProductWarehousePairs, params.productId, params.sourceWarehouse);
  addCaulkProductWarehousePair(caulkProductWarehousePairs, params.productId, params.destinationWarehouse);
  addCaulkProductWarehousePair(caulkProductWarehousePairs, responseData.productId, responseData.warehouse);
  addCaulkProductWarehousePair(caulkProductWarehousePairs, responseData.productId, responseData.sourceWarehouse);
  addCaulkProductWarehousePair(caulkProductWarehousePairs, responseData.productId, responseData.destinationWarehouse);

  if (Array.isArray(params.caulkRequirements)) {
    for (const requirement of params.caulkRequirements) {
      addCaulkProductWarehousePair(
        caulkProductWarehousePairs,
        requirement?.productId,
        params.warehouse || responseData?.warehouse || responseData?.job?.warehouse
      );
    }
  }

  const scope = {};
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
 * preserving org-wide fallback if the mutation response cannot prove that job.
 *
 * AFFECTS:
 * Local /film-orders/delete post-write planner cost and timeout risk.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * Supabase Edge mutationHandlers parity, guarded plain-delete SQL, and Film
 * Orders tab delete tests.
 *
 * COMMON FAILURE MODES:
 * Trusting request payload job numbers, skipping planner on missing response
 * data, or applying this scoped behavior to /film-orders/cancel.
 */
function buildFilmOrderDeletePlannerScope(params = {}, responseData = {}) {
  const jobNumber = typeof responseData?.jobNumber === 'string' ? asTrimmedString(responseData.jobNumber) : '';
  if (!jobNumber) {
    return ORG_WIDE_SCOPE;
  }
  const jobIds = normalizeJobIdArray([params?.jobId]);
  return {
    jobNumbers: [jobNumber],
    ...(jobIds.length ? { jobIds } : {}),
  };
}

async function reconcileAutoPlannedAllocations(client, orgId, actor, scope = ORG_WIDE_SCOPE) {
  const row = await queryRow(
    client,
    `
      select app_api.reconcile_auto_planned_allocations($1::uuid, $2::text, $3::jsonb) as result
    `,
    [orgId, asTrimmedString(actor) || 'planner', JSON.stringify(normalizeScope(scope))]
  );

  return row?.result || {
    filmInserted: 0,
    filmUpdated: 0,
    filmCancelled: 0,
    caulkInserted: 0,
    caulkUpdated: 0,
    caulkCancelled: 0,
    warnings: [],
    warningCount: 0,
  };
}

function getJobIdentityForPlannerDetailReload(logicalPath, params = {}, responseData = {}) {
  if (!JOB_DETAIL_RELOAD_ROUTES.has(logicalPath)) {
    return { jobId: '', jobNumber: '' };
  }
  const summary = asRecord(responseData?.summary);
  const job = asRecord(responseData?.job);
  return {
    jobId: asTrimmedString(params?.jobId),
    jobNumber:
      asTrimmedString(responseData?.jobNumber) ||
      asTrimmedString(summary.jobNumber) ||
      asTrimmedString(job.jobNumber) ||
      asTrimmedString(params?.jobNumber),
  };
}

function getJobNumberForPlannerDetailReload(logicalPath, params = {}, responseData = {}) {
  return getJobIdentityForPlannerDetailReload(logicalPath, params, responseData).jobNumber;
}

function normalizePlannerWarnings(result) {
  const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
  return warnings.map((value) => asTrimmedString(value)).filter(Boolean);
}

function normalizeScope(scope) {
  if (!scope || typeof scope !== 'object') {
    return {};
  }

  const jobIds = Array.isArray(scope.jobIds) ? normalizeJobIdArray(scope.jobIds) : [];

  return {
    ...(Array.isArray(scope.jobNumbers) ? { jobNumbers: normalizeStringArray(scope.jobNumbers) } : {}),
    ...(jobIds.length ? { jobIds } : {}),
    ...(Array.isArray(scope.boxIds) ? { boxIds: normalizeStringArray(scope.boxIds) } : {}),
    ...(Array.isArray(scope.caulkProductWarehousePairs)
      ? { caulkProductWarehousePairs: normalizeCaulkPairs(scope.caulkProductWarehousePairs) }
      : {}),
  };
}

function normalizeStringArray(values) {
  return Array.from(new Set(values.map((value) => asTrimmedString(value)).filter(Boolean)));
}

function normalizeJobIdArray(values) {
  return Array.from(new Set(values.map((value) => normalizeJobId(value)).filter(Boolean)));
}

function normalizeJobId(value) {
  const normalized = asTrimmedString(value).toLowerCase();
  return JOB_ID_PATTERN.test(normalized) ? normalized : '';
}

function normalizeCaulkPairs(values) {
  const pairs = new Map();
  for (const value of values) {
    const productId = asTrimmedString(value?.productId);
    const warehouse = asTrimmedString(value?.warehouse).toUpperCase();
    if (!productId || !warehouse) {
      continue;
    }
    pairs.set(`${productId}:${warehouse}`, { productId, warehouse });
  }
  return Array.from(pairs.values());
}

function addJobNumber(target, value) {
  const normalized = asTrimmedString(value);
  if (normalized) {
    target.add(normalized);
  }
}

function addJobId(target, value) {
  const normalized = normalizeJobId(value);
  if (normalized) {
    target.add(normalized);
  }
}

function addBoxId(target, value) {
  const normalized = asTrimmedString(value);
  if (normalized) {
    target.add(normalized);
  }
}

function addCaulkProductWarehousePair(target, productIdValue, warehouseValue) {
  const productId = asTrimmedString(productIdValue);
  const warehouse = asTrimmedString(warehouseValue).toUpperCase();
  if (!productId || !warehouse) {
    return;
  }
  target.set(`${productId}:${warehouse}`, { productId, warehouse });
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export {
  buildAutoPlannerScope,
  getJobIdentityForPlannerDetailReload,
  getJobNumberForPlannerDetailReload,
  normalizePlannerWarnings,
  normalizeScope,
  reconcileAutoPlannedAllocations,
};
