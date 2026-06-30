import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BACKEND_ONLY_JOB_ID_SHADOW_SCOPE_ROUTES,
  EDGE_ONLY_SQL_PLANNER_HANDLED_ROUTES,
  collectPlannerRouteSetParity,
  extractRouteSet,
  formatPlannerRouteSetMismatches,
} from './planner-route-set-parity.mjs';

test('planner route-set parity guard accepts current backend and Edge metadata', () => {
  const parity = collectPlannerRouteSetParity();

  assert.deepEqual(parity.mismatches, []);
  assert.deepEqual(parity.backend.PLANNER_MUTATION_ROUTES, parity.edge.PLANNER_MUTATION_ROUTES);
  assert.deepEqual(parity.backend.ORG_WIDE_MUTATION_ROUTES, parity.edge.ORG_WIDE_MUTATION_ROUTES);
  assert.deepEqual(parity.backend.JOB_DETAIL_RELOAD_ROUTES, parity.edge.JOB_DETAIL_RELOAD_ROUTES);
});

test('planner route-set parity guard documents intentional surface-specific differences', () => {
  const parity = collectPlannerRouteSetParity();
  const backendSqlRoutes = new Set(parity.backend.SQL_PLANNER_HANDLED_ROUTES);
  const edgeSqlRoutes = new Set(parity.edge.SQL_PLANNER_HANDLED_ROUTES);
  const backendShadowRoutes = new Set(parity.backend.JOB_ID_SHADOW_SCOPE_ROUTES);
  const edgeShadowRoutes = new Set(parity.edge.JOB_ID_SHADOW_SCOPE_ROUTES);

  assert.deepEqual(
    parity.edge.SQL_PLANNER_HANDLED_ROUTES.filter((route) => !backendSqlRoutes.has(route)),
    EDGE_ONLY_SQL_PLANNER_HANDLED_ROUTES
  );
  assert.deepEqual(
    parity.backend.JOB_ID_SHADOW_SCOPE_ROUTES.filter((route) => !edgeShadowRoutes.has(route)),
    BACKEND_ONLY_JOB_ID_SHADOW_SCOPE_ROUTES
  );
  assert.deepEqual(
    parity.backend.SQL_PLANNER_HANDLED_ROUTES.filter((route) => !edgeSqlRoutes.has(route)),
    []
  );
  assert.deepEqual(
    parity.edge.JOB_ID_SHADOW_SCOPE_ROUTES.filter((route) => !backendShadowRoutes.has(route)),
    []
  );
});

test('planner route-set parser extracts route constants independent of quote style', () => {
  const routes = extractRouteSet(
    `
      const SQL_PLANNER_HANDLED_ROUTES = new Set([
        '/allocations/apply',
        "/jobs/update",
      ]);
    `,
    'SQL_PLANNER_HANDLED_ROUTES'
  );

  assert.deepEqual(routes, ['/allocations/apply', '/jobs/update']);
});

test('planner route-set parity failure message identifies route differences', () => {
  const message = formatPlannerRouteSetMismatches([
    {
      label: 'PLANNER_MUTATION_ROUTES must match',
      missingInEdge: ['/boxes/update'],
      missingInBackend: ['/jobs/update'],
    },
  ]);

  assert.match(message, /PLANNER_MUTATION_ROUTES must match/);
  assert.match(message, /missingInEdge: \/boxes\/update/);
  assert.match(message, /missingInBackend: \/jobs\/update/);
});
