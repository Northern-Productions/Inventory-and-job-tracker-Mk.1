import fs from 'node:fs';
import path from 'node:path';
import {
  OWNER_ONLY_ROUTES,
  READ_PATHS,
  ROUTE_FEATURE_MAP
} from '../../shared/domain/runtimeContract.mjs';
import {
  collectPlannerRouteSetParity,
  formatPlannerRouteSetMismatches,
} from './lib/planner-route-set-parity.mjs';

function extractRoutesFromEdgeHandler(text) {
  const routes = new Set();
  const caseMatches = text.matchAll(/case\s+['\"](\/[^'\"]+)['\"]\s*:/g);
  for (const match of caseMatches) {
    routes.add(match[1]);
  }
  const conditionalMatches = text.matchAll(/logicalPath\s*===\s*['\"](\/[^'\"]+)['\"]/g);
  for (const match of conditionalMatches) {
    routes.add(match[1]);
  }
  const mapKeyMatches = text.matchAll(/["'](\/[^"']+)["']\s*:\s*async/g);
  for (const match of mapKeyMatches) {
    routes.add(match[1]);
  }
  return routes;
}

function extractRoutesFromFrontendClient(text) {
  const routes = new Set();
  const direct = text.matchAll(
    /request(?:ReadWithFallback)?(?:<[^>]*>)?\(\s*['\"](?:GET|POST)['\"]\s*,\s*['\"](\/[^'\"]+)['\"]/g
  );
  for (const match of direct) {
    routes.add(match[1]);
  }
  const generic = text.matchAll(/request\([^,]+,\s*['\"](\/[^'\"]+)['\"]/g);
  for (const match of generic) {
    routes.add(match[1]);
  }
  return routes;
}

function collectFrontendApiClientFiles(rootDir) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFrontendApiClientFiles(entryPath));
      continue;
    }

    if (/\.tsx?$/.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

const edgePaths = [
  path.resolve('..', 'supabase/functions/_shared/api-handler.ts'),
  path.resolve('..', 'supabase/functions/_shared/routes/readHandlers.ts'),
  path.resolve('..', 'supabase/functions/_shared/routes/mutationHandlers.ts')
];
const frontendApiPaths = collectFrontendApiClientFiles(path.resolve('..', 'frontend/src/api'));

const contractRoutes = new Set([
  ...Object.keys(ROUTE_FEATURE_MAP),
  ...READ_PATHS,
  ...OWNER_ONLY_ROUTES,
  '/health',
  '/auth/context',
  '/profile/username',
  '/profile/default-warehouse'
]);

const edgeRoutes = new Set();
for (const edgePath of edgePaths) {
  const edgeSource = fs.readFileSync(edgePath, 'utf8');
  const discovered = extractRoutesFromEdgeHandler(edgeSource);
  for (const route of discovered) {
    edgeRoutes.add(route);
  }
}
const clientRoutes = new Set();
for (const frontendPath of frontendApiPaths) {
  const clientSource = fs.readFileSync(frontendPath, 'utf8');
  const discovered = extractRoutesFromFrontendClient(clientSource);
  for (const route of discovered) {
    clientRoutes.add(route);
  }
}

const missingInEdge = [...contractRoutes].filter((route) => !edgeRoutes.has(route)).sort();
const missingInClient = [...contractRoutes].filter((route) => !edgeRoutes.has(route) && clientRoutes.has(route)).sort();
const clientNotInContract = [...clientRoutes].filter((route) => !contractRoutes.has(route)).sort();
const plannerRouteSetParity = collectPlannerRouteSetParity();

if (
  missingInEdge.length ||
  missingInClient.length ||
  clientNotInContract.length ||
  plannerRouteSetParity.mismatches.length
) {
  console.error('[contract:parity] parity check failed');
  if (missingInEdge.length) {
    console.error('[contract:parity] missing in edge:', missingInEdge);
  }
  if (missingInClient.length) {
    console.error('[contract:parity] missing in edge but used by client:', missingInClient);
  }
  if (clientNotInContract.length) {
    console.error('[contract:parity] client routes not in contract:', clientNotInContract);
  }
  if (plannerRouteSetParity.mismatches.length) {
    console.error(
      '[contract:parity] planner route-set mismatch:\n' +
        formatPlannerRouteSetMismatches(plannerRouteSetParity.mismatches)
    );
  }
  process.exit(1);
}

console.log('[contract:parity] OK');
