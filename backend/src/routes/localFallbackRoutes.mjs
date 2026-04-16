// Purpose: Centralize rollback-host routes that should run through the local parity handler.

export const LOCAL_FALLBACK_MUTATION_PATHS = new Set([
  '/admin/member-permissions',
  '/admin/user-permissions',
  '/owner/admin-permissions',
  '/owner/notification-preferences',
  '/caulk/products/upsert',
  '/caulk/transfers/receive',
  '/caulk/transfers/cancel',
  '/boxes/add',
  '/boxes/update',
  '/allocations/apply',
  '/allocations/remove-box',
  '/allocations/caulk/add',
  '/allocations/caulk/update',
  '/allocations/caulk/checkout',
  '/allocations/caulk/checkin',
  '/allocations/caulk/remove',
  '/jobs/create',
  '/jobs/update',
  '/jobs/set-staged-pickup',
  '/jobs/checkout-all',
  '/jobs/complete',
  '/jobs/delete',
  '/film-orders/create',
  '/film-orders/cancel',
  '/film-orders/delete'
]);

export const LOCAL_FALLBACK_READ_PATHS = new Set([
  '/app/attention-summary',
  '/boxes/search',
  '/boxes/get',
  '/boxes/transfer/plan',
  '/allocations/by-box',
  '/allocations/by-job',
  '/allocations/jobs',
  '/allocations/preview',
  '/owner/reports/asset-total-cost',
  '/jobs/calendar',
  '/jobs/get',
  '/jobs/list',
  '/jobs/search',
  '/caulk/transactions/list',
  '/caulk/transfers/list'
]);

export function shouldUseLocalFallbackRoute(method, logicalPath) {
  return (
    (method === 'GET' && LOCAL_FALLBACK_READ_PATHS.has(logicalPath)) ||
    (method === 'POST' && LOCAL_FALLBACK_MUTATION_PATHS.has(logicalPath))
  );
}
