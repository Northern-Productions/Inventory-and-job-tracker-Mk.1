import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');

const BACKEND_PLANNER_SOURCE = path.join(
  repoRoot,
  'backend',
  'src',
  'app',
  'services',
  'runtime',
  'runtimeAutoAllocationPlanner.mjs'
);
const EDGE_MUTATION_HANDLER_SOURCE = path.join(
  repoRoot,
  'supabase',
  'functions',
  '_shared',
  'routes',
  'mutationHandlers.ts'
);

const EXACT_MATCH_ROUTE_SET_NAMES = Object.freeze([
  'PLANNER_MUTATION_ROUTES',
  'ORG_WIDE_MUTATION_ROUTES',
  'JOB_DETAIL_RELOAD_ROUTES',
]);

const EDGE_ONLY_SQL_PLANNER_HANDLED_ROUTES = Object.freeze([
  '/allocations/add',
  '/allocations/apply',
  '/allocations/caulk/checkout',
  '/allocations/remove-box',
  '/boxes/set-status',
  '/boxes/update',
  '/caulk/transfers/cancel',
  '/caulk/transfers/receive',
  '/jobs/checkout-all',
  '/jobs/create',
  '/jobs/phase-state',
  '/jobs/requirement-state',
  '/jobs/set-staged-pickup',
  '/jobs/update',
]);

const BACKEND_ONLY_JOB_ID_SHADOW_SCOPE_ROUTES = Object.freeze([
  '/allocations/apply',
  '/allocations/remove-box',
  '/jobs/checkout-all',
  '/jobs/set-staged-pickup',
]);

function readPlannerSources() {
  return {
    backendSource: fs.readFileSync(BACKEND_PLANNER_SOURCE, 'utf8'),
    edgeSource: fs.readFileSync(EDGE_MUTATION_HANDLER_SOURCE, 'utf8'),
  };
}

function extractRouteSet(source, setName) {
  const escapedName = setName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`const\\s+${escapedName}\\s*=\\s+new\\s+Set\\(\\s*\\[([\\s\\S]*?)\\]\\s*\\)`).exec(
    source
  );
  if (!match) {
    throw new Error(`Unable to find planner route set ${setName}.`);
  }

  return sortRoutes(Array.from(match[1].matchAll(/['"](\/[^'"]+)['"]/g), (entry) => entry[1]));
}

function collectRouteSets(source) {
  return {
    PLANNER_MUTATION_ROUTES: extractRouteSet(source, 'PLANNER_MUTATION_ROUTES'),
    SQL_PLANNER_HANDLED_ROUTES: extractRouteSet(source, 'SQL_PLANNER_HANDLED_ROUTES'),
    ORG_WIDE_MUTATION_ROUTES: extractRouteSet(source, 'ORG_WIDE_MUTATION_ROUTES'),
    JOB_DETAIL_RELOAD_ROUTES: extractRouteSet(source, 'JOB_DETAIL_RELOAD_ROUTES'),
    JOB_ID_SHADOW_SCOPE_ROUTES: extractRouteSet(source, 'JOB_ID_SHADOW_SCOPE_ROUTES'),
  };
}

function collectPlannerRouteSetParity() {
  const { backendSource, edgeSource } = readPlannerSources();
  const backend = collectRouteSets(backendSource);
  const edge = collectRouteSets(edgeSource);
  const mismatches = [];

  for (const setName of EXACT_MATCH_ROUTE_SET_NAMES) {
    const diff = diffRouteSets(backend[setName], edge[setName]);
    if (diff.missingInEdge.length || diff.missingInBackend.length) {
      mismatches.push({
        label: `${setName} must match between backend runtime and Edge mutation handler`,
        missingInEdge: diff.missingInEdge,
        missingInBackend: diff.missingInBackend,
      });
    }
  }

  const sqlDiff = diffRouteSets(backend.SQL_PLANNER_HANDLED_ROUTES, edge.SQL_PLANNER_HANDLED_ROUTES);
  const unexpectedSqlMissingInEdge = sqlDiff.missingInEdge;
  const unexpectedEdgeOnlySqlRoutes = diffArrays(sqlDiff.missingInBackend, EDGE_ONLY_SQL_PLANNER_HANDLED_ROUTES);
  const missingDocumentedEdgeOnlySqlRoutes = diffArrays(
    EDGE_ONLY_SQL_PLANNER_HANDLED_ROUTES,
    sqlDiff.missingInBackend
  );
  if (
    unexpectedSqlMissingInEdge.length ||
    unexpectedEdgeOnlySqlRoutes.length ||
    missingDocumentedEdgeOnlySqlRoutes.length
  ) {
    mismatches.push({
      label: 'SQL_PLANNER_HANDLED_ROUTES may differ only by documented Edge-only SQL-owned routes',
      missingInEdge: unexpectedSqlMissingInEdge,
      unexpectedEdgeOnly: unexpectedEdgeOnlySqlRoutes,
      missingDocumentedEdgeOnly: missingDocumentedEdgeOnlySqlRoutes,
    });
  }

  const shadowDiff = diffRouteSets(backend.JOB_ID_SHADOW_SCOPE_ROUTES, edge.JOB_ID_SHADOW_SCOPE_ROUTES);
  const unexpectedShadowMissingInBackend = shadowDiff.missingInBackend;
  const unexpectedBackendOnlyShadowRoutes = diffArrays(
    shadowDiff.missingInEdge,
    BACKEND_ONLY_JOB_ID_SHADOW_SCOPE_ROUTES
  );
  const missingDocumentedBackendOnlyShadowRoutes = diffArrays(
    BACKEND_ONLY_JOB_ID_SHADOW_SCOPE_ROUTES,
    shadowDiff.missingInEdge
  );
  if (
    unexpectedShadowMissingInBackend.length ||
    unexpectedBackendOnlyShadowRoutes.length ||
    missingDocumentedBackendOnlyShadowRoutes.length
  ) {
    mismatches.push({
      label: 'JOB_ID_SHADOW_SCOPE_ROUTES may differ only by documented backend-only non-SQL-owned routes',
      missingInBackend: unexpectedShadowMissingInBackend,
      unexpectedBackendOnly: unexpectedBackendOnlyShadowRoutes,
      missingDocumentedBackendOnly: missingDocumentedBackendOnlyShadowRoutes,
    });
  }

  mismatches.push(...collectSubsetMismatches(backend, 'backend runtime'));
  mismatches.push(...collectSubsetMismatches(edge, 'Edge mutation handler'));

  return { backend, edge, mismatches };
}

function collectSubsetMismatches(routeSets, label) {
  const mismatches = [];
  const plannerRoutes = routeSets.PLANNER_MUTATION_ROUTES;
  const subsets = [
    ['SQL_PLANNER_HANDLED_ROUTES', routeSets.SQL_PLANNER_HANDLED_ROUTES],
    ['ORG_WIDE_MUTATION_ROUTES', routeSets.ORG_WIDE_MUTATION_ROUTES],
    ['JOB_DETAIL_RELOAD_ROUTES', routeSets.JOB_DETAIL_RELOAD_ROUTES],
    ['JOB_ID_SHADOW_SCOPE_ROUTES', routeSets.JOB_ID_SHADOW_SCOPE_ROUTES],
  ];

  for (const [setName, routes] of subsets) {
    const outsidePlannerRoutes = diffArrays(routes, plannerRoutes);
    if (outsidePlannerRoutes.length) {
      mismatches.push({
        label: `${label} ${setName} must be a subset of PLANNER_MUTATION_ROUTES`,
        outsidePlannerRoutes,
      });
    }
  }

  return mismatches;
}

function diffRouteSets(backendRoutes, edgeRoutes) {
  return {
    missingInEdge: diffArrays(backendRoutes, edgeRoutes),
    missingInBackend: diffArrays(edgeRoutes, backendRoutes),
  };
}

function diffArrays(left, right) {
  const rightSet = new Set(right);
  return sortRoutes(left.filter((entry) => !rightSet.has(entry)));
}

function sortRoutes(routes) {
  return Array.from(new Set(routes)).sort((a, b) => a.localeCompare(b));
}

function formatPlannerRouteSetMismatches(mismatches) {
  if (!mismatches.length) {
    return '';
  }

  return mismatches
    .map((entry) => {
      const details = Object.entries(entry)
        .filter(([key]) => key !== 'label')
        .filter(([, value]) => Array.isArray(value) && value.length > 0)
        .map(([key, value]) => `${key}: ${value.join(', ')}`)
        .join('; ');
      return `${entry.label}${details ? ` (${details})` : ''}`;
    })
    .join('\n');
}

export {
  BACKEND_ONLY_JOB_ID_SHADOW_SCOPE_ROUTES,
  EDGE_ONLY_SQL_PLANNER_HANDLED_ROUTES,
  collectPlannerRouteSetParity,
  extractRouteSet,
  formatPlannerRouteSetMismatches,
};
