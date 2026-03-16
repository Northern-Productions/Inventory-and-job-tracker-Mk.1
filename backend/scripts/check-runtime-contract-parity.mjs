import fs from 'node:fs';
import path from 'node:path';
import {
  OWNER_ONLY_ROUTES,
  READ_PATHS,
  ROUTE_FEATURE_MAP
} from '../../frontend/src/domain/runtimeContract.mjs';

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
  const direct = text.matchAll(/request(?:ReadWithFallback)?<[^>]*>\(\s*['\"](\/[^'\"]+)['\"]/g);
  for (const match of direct) {
    routes.add(match[1]);
  }
  const generic = text.matchAll(/request\([^,]+,\s*['\"](\/[^'\"]+)['\"]/g);
  for (const match of generic) {
    routes.add(match[1]);
  }
  return routes;
}

const edgePaths = [
  path.resolve('..', 'supabase/functions/_shared/api-handler.ts'),
  path.resolve('..', 'supabase/functions/_shared/routes/readHandlers.ts'),
  path.resolve('..', 'supabase/functions/_shared/routes/mutationHandlers.ts')
];
const frontendPath = path.resolve('..', 'frontend/src/api/client.ts');
const clientSource = fs.readFileSync(frontendPath, 'utf8');

const contractRoutes = new Set([
  ...Object.keys(ROUTE_FEATURE_MAP),
  ...READ_PATHS,
  ...OWNER_ONLY_ROUTES,
  '/health',
  '/auth/context',
  '/profile/username'
]);

const edgeRoutes = new Set();
for (const edgePath of edgePaths) {
  const edgeSource = fs.readFileSync(edgePath, 'utf8');
  const discovered = extractRoutesFromEdgeHandler(edgeSource);
  for (const route of discovered) {
    edgeRoutes.add(route);
  }
}
const clientRoutes = extractRoutesFromFrontendClient(clientSource);

const missingInEdge = [...contractRoutes].filter((route) => !edgeRoutes.has(route)).sort();
const missingInClient = [...contractRoutes].filter((route) => !edgeRoutes.has(route) && clientRoutes.has(route)).sort();
const clientNotInContract = [...clientRoutes].filter((route) => !contractRoutes.has(route)).sort();

if (missingInEdge.length || missingInClient.length || clientNotInContract.length) {
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
  process.exit(1);
}

console.log('[contract:parity] OK');
