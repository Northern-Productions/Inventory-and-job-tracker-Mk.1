// Paste into Apps Script file: routes.gs

var ROUTES_ = {
  'GET /health': healthService_,
  'GET /boxes/search': searchBoxesService_,
  'GET /boxes/get': getBoxService_,
  'GET /audit/list': listAuditService_,
  'GET /audit/by-box': getAuditByBoxService_,
  'GET /allocations/by-box': getAllocationsByBoxService_,
  'GET /allocations/jobs': getAllocationJobsService_,
  'GET /allocations/by-job': getAllocationByJobService_,
  'GET /allocations/preview': getAllocationPreviewService_,
  'GET /jobs/list': getJobsListService_,
  'GET /jobs/get': getJobService_,
  'GET /film-orders/list': getFilmOrdersService_,
  'GET /film-data/catalog': getFilmCatalogService_,
  'GET /roll-history/by-box': getRollHistoryByBoxService_,
  'GET /reports/summary': getReportsSummaryService_,
  'POST /boxes/search': searchBoxesService_,
  'POST /boxes/get': getBoxService_,
  'POST /audit/list': listAuditService_,
  'POST /audit/by-box': getAuditByBoxService_,
  'POST /allocations/by-box': getAllocationsByBoxService_,
  'POST /allocations/jobs': getAllocationJobsService_,
  'POST /allocations/by-job': getAllocationByJobService_,
  'POST /allocations/preview': getAllocationPreviewService_,
  'POST /allocations/apply': applyAllocationPlanService_,
  'POST /jobs/list': getJobsListService_,
  'POST /jobs/get': getJobService_,
  'POST /jobs/create': createJobService_,
  'POST /jobs/update': updateJobService_,
  'POST /roll-history/by-box': getRollHistoryByBoxService_,
  'POST /film-orders/list': getFilmOrdersService_,
  'POST /film-data/catalog': getFilmCatalogService_,
  'POST /film-orders/create': createFilmOrderService_,
  'POST /film-orders/cancel': cancelJobService_,
  'POST /reports/summary': getReportsSummaryService_,
  'POST /boxes/add': addBoxService_,
  'POST /allocations/add': allocateBoxService_,
  'POST /boxes/update': updateBoxService_,
  'POST /boxes/set-status': setBoxStatusService_,
  'POST /audit/undo': undoAuditService_
};

function routeRequest_(method, e) {
  try {
    var payload = method === 'GET' ? (e.parameter || {}) : parseJsonBody_(e);
    var route = resolveRoute_(e);

    if (method === 'POST' && route === '/' && payload && payload.path) {
      route = String(payload.path);
      if (route.charAt(0) !== '/') {
        route = '/' + route;
      }
    }

    var key = method + ' ' + route;
    var handler = ROUTES_[key];

    if (!handler) {
      return jsonResponse_(errorEnvelope_('Route not found: ' + route));
    }

    var result = handler(payload, e) || {};

    return jsonResponse_(successEnvelope_(result.data, result.warnings));
  } catch (error) {
    return jsonResponse_(
      errorEnvelope_(error && error.message ? error.message : 'Unexpected server error.')
    );
  }
}
