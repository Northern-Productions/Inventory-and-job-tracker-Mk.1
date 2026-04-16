import fs from 'node:fs';
import path from 'node:path';
import {
  ALLOCATION_JOB_STATUSES,
  BOX_STATUSES,
  FEATURE_AREAS,
  FILM_ORDER_STATUSES,
  JOB_STATUSES,
  OWNER_ONLY_ROUTES,
  READ_PATHS,
  ROUTE_FEATURE_MAP
} from '../../shared/domain/runtimeContract.mjs';

const allRoutes = new Set([
  ...Object.keys(ROUTE_FEATURE_MAP),
  ...READ_PATHS,
  ...OWNER_ONLY_ROUTES,
  '/health',
  '/auth/context',
  '/profile/username'
]);

const routes = [...allRoutes]
  .sort()
  .map((route) => ({
    route,
    feature: ROUTE_FEATURE_MAP[route] || '',
    mode: READ_PATHS.includes(route) ? 'read' : 'write',
    ownerOnly: OWNER_ONLY_ROUTES.includes(route)
  }));

const matrix = {
  generatedAt: new Date().toISOString(),
  features: FEATURE_AREAS,
  statuses: {
    box: BOX_STATUSES,
    filmOrders: FILM_ORDER_STATUSES,
    jobs: JOB_STATUSES,
    allocationJobs: ALLOCATION_JOB_STATUSES
  },
  routes
};

const outputPath = path.resolve('docs/runtime-route-matrix.json');
fs.writeFileSync(outputPath, JSON.stringify(matrix, null, 2));
console.log(`[route-matrix] wrote ${outputPath}`);
