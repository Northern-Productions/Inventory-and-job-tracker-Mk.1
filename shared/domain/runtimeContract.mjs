/**
 * Runtime contract shared by frontend, Edge, and optional Node adapter.
 * Defines canonical routes, feature mapping, route access modes, and core enums.
 */

export const FEATURE_AREAS = Object.freeze([
  'inventory',
  'allocations',
  'jobs',
  'film_orders',
  'activity_history',
  'reports',
  'access_management'
]);

export const BOX_STATUSES = Object.freeze(['ORDERED', 'IN_STOCK', 'CHECKED_OUT', 'TRANSFER', 'ZEROED', 'RETIRED']);
export const FILM_ORDER_STATUSES = Object.freeze(['FILM_ORDER', 'FILM_ON_THE_WAY', 'FULFILLED', 'CANCELLED']);
export const JOB_STATUSES = Object.freeze(['READY', 'ORDERED', 'FILM_ORDER', 'COMPLETED', 'CANCELLED']);
export const ALLOCATION_JOB_STATUSES = Object.freeze(['READY', 'ORDERED', 'FILM_ORDER', 'COMPLETED', 'CANCELLED']);
export const ALLOCATION_SOURCES = Object.freeze([
  'MANUAL',
  'AUTO_PLANNED',
  'FILM_ORDER_RECEIPT',
  'DIRECT_TO_JOB_SITE'
]);

export const WAREHOUSE_CODE_PATTERN = /^[A-Z]{2}[1-9][0-9]{0,6}$/;

export const ROUTE_FEATURE_MAP = Object.freeze({
  '/box-dealers/list': 'inventory',
  '/box-dealers/upsert': 'inventory',
  '/boxes/search': 'inventory',
  '/boxes/get': 'inventory',
  '/boxes/add': 'inventory',
  '/boxes/update': 'inventory',
  '/boxes/delete': 'inventory',
  '/boxes/set-status': 'inventory',
  '/boxes/labels/mark-printed': 'inventory',
  '/boxes/transfer/by-box': 'inventory',
  '/boxes/transfer/plan': 'inventory',
  '/boxes/transfer/start': 'inventory',
  '/boxes/transfer/receive': 'inventory',
  '/boxes/transfer/cancel': 'inventory',
  '/film-data/catalog': 'inventory',
  '/warehouses/list': 'inventory',
  '/owner/warehouses/add': 'inventory',
  '/caulk/manufacturers/list': 'inventory',
  '/caulk/products/list': 'inventory',
  '/caulk/stock/list': 'inventory',
  '/caulk/transactions/list': 'inventory',
  '/caulk/transfers/list': 'inventory',
  '/caulk/products/upsert': 'inventory',
  '/caulk/mutate': 'inventory',
  '/caulk/transfer': 'inventory',
  '/caulk/transfers/receive': 'inventory',
  '/caulk/transfers/cancel': 'inventory',
  '/owner/caulk/manufacturers/upsert': 'inventory',

  '/allocations/by-box': 'allocations',
  '/allocations/jobs': 'allocations',
  '/allocations/by-job': 'allocations',
  '/allocations/preview': 'allocations',
  '/allocations/add': 'allocations',
  '/allocations/apply': 'allocations',
  '/allocations/remove-box': 'allocations',
  '/allocations/planner-suppression/clear': 'allocations',
  '/allocations/caulk/add': 'allocations',
  '/allocations/caulk/update': 'allocations',
  '/allocations/caulk/checkout': 'allocations',
  '/allocations/caulk/checkin': 'allocations',
  '/allocations/caulk/remove': 'allocations',

  '/jobs/list': 'jobs',
  '/jobs/calendar': 'jobs',
  '/jobs/search': 'jobs',
  '/jobs/check-duplicate': 'jobs',
  '/jobs/get': 'jobs',
  '/jobs/get-by-id': 'jobs',
  '/jobs/create': 'jobs',
  '/jobs/update': 'jobs',
  '/jobs/requirement-state': 'jobs',
  '/jobs/set-staged-pickup': 'jobs',
  '/jobs/checkout-all': 'jobs',
  '/jobs/complete': 'jobs',
  '/jobs/delete': 'jobs',
  '/jobs/reopen': 'jobs',

  '/film-orders/list': 'film_orders',
  '/film-orders/create': 'film_orders',
  '/film-orders/cancel': 'film_orders',
  '/film-orders/delete': 'film_orders',

  '/audit/list': 'activity_history',
  '/audit/by-box': 'activity_history',
  '/audit/undo': 'activity_history',
  '/roll-history/by-box': 'activity_history',

  '/reports/summary': 'reports',
  '/owner/reports/asset-total-cost': 'reports',

  '/admin/access/requests': 'access_management',
  '/admin/access/requests/approve': 'access_management',
  '/admin/access/requests/deny': 'access_management',
  '/admin/username-requests': 'access_management',
  '/admin/username-requests/approve': 'access_management',
  '/admin/username-requests/deny': 'access_management',
  '/admin/member-permissions': 'access_management',
  '/admin/user-permissions': 'access_management',
  '/admin/roles/promote-member-to-admin': 'access_management'
});

export const READ_PATHS = Object.freeze([
  '/health',
  '/auth/context',
  '/app/attention-summary',
  '/box-dealers/list',
  '/boxes/search',
  '/boxes/get',
  '/boxes/transfer/by-box',
  '/boxes/transfer/plan',
  '/audit/list',
  '/audit/by-box',
  '/allocations/by-box',
  '/allocations/jobs',
  '/allocations/by-job',
  '/allocations/preview',
  '/jobs/list',
  '/jobs/calendar',
  '/jobs/search',
  '/jobs/check-duplicate',
  '/jobs/get',
  '/jobs/get-by-id',
  '/film-orders/list',
  '/film-data/catalog',
  '/roll-history/by-box',
  '/reports/summary',
  '/owner/reports/asset-total-cost',
  '/warehouses/list',
  '/caulk/manufacturers/list',
  '/caulk/products/list',
  '/caulk/stock/list',
  '/caulk/transactions/list',
  '/caulk/transfers/list',
  '/admin/access/requests',
  '/admin/username-requests',
  '/admin/member-permissions',
  '/admin/user-permissions',
  '/owner/admin-permissions',
  '/owner/notification-preferences'
]);

export const OWNER_ONLY_ROUTES = Object.freeze([
  '/owner/admin-permissions',
  '/owner/roles/demote-admin-to-member',
  '/owner/roles/promote-admin-to-owner',
  '/owner/notification-preferences',
  '/owner/reports/asset-total-cost',
  '/owner/warehouses/add',
  '/owner/caulk/manufacturers/upsert',
  '/jobs/reopen'
]);

const READ_PATH_SET = new Set(READ_PATHS);
const OWNER_ONLY_ROUTE_SET = new Set(OWNER_ONLY_ROUTES);

export function isReadRoute(logicalPath) {
  return READ_PATH_SET.has(String(logicalPath || ''));
}

export function isOwnerOnlyRoute(logicalPath) {
  return OWNER_ONLY_ROUTE_SET.has(String(logicalPath || ''));
}

export function inferFeatureForRoute(logicalPath) {
  return ROUTE_FEATURE_MAP[String(logicalPath || '')] || '';
}

export function inferAccessModeForRoute(method, logicalPath) {
  return method === 'GET' ? 'read' : 'write';
}
