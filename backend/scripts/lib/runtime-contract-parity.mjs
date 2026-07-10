import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OWNER_ONLY_ROUTES,
  READ_PATHS,
  ROUTE_FEATURE_MAP,
} from '../../../shared/domain/runtimeContract.mjs';
import {
  collectPlannerRouteSetParity,
  formatPlannerRouteSetMismatches,
} from './planner-route-set-parity.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');

const EDGE_ROUTE_SOURCES = Object.freeze([
  'supabase/functions/_shared/api-handler.ts',
  'supabase/functions/_shared/routes/readHandlers.ts',
  'supabase/functions/_shared/routes/mutationHandlers.ts',
]);

const BACKEND_ROUTE_SOURCES = Object.freeze([
  'backend/src/app/handlers/readHandlers.mjs',
  'backend/src/app/handlers/mutationHandlers.mjs',
]);

const CONTRACT_ONLY_ROUTES = Object.freeze([
  '/health',
  '/auth/context',
  '/profile/username',
  '/profile/default-warehouse',
]);

const EDGE_ONLY_ROUTE_EXCEPTIONS = Object.freeze([
  '/health',
  '/auth/context',
]);

function sortRoutes(routes) {
  return Array.from(new Set(routes)).sort((left, right) => left.localeCompare(right));
}

function diffRoutes(left, right) {
  const rightSet = new Set(right);
  return sortRoutes(left.filter((entry) => !rightSet.has(entry)));
}

function extractRoutesFromHandlerSource(text) {
  const routes = new Set();
  const patterns = [
    /case\s+['"](\/[^'"]+)['"]\s*:/g,
    /logicalPath\s*===\s*['"](\/[^'"]+)['"]/g,
    /["'](\/[A-Za-z0-9_\-/]+)["']\s*:\s*async/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      routes.add(match[1]);
    }
  }

  return routes;
}

function extractRoutesFromFrontendClient(text) {
  const routes = new Set();
  const patterns = [
    /request(?:<[^>]*>)?\(\s*['"](?:GET|POST)['"]\s*,\s*['"](\/[^'"]+)['"]/g,
    /requestReadWithFallback(?:<[^>]*>)?\(\s*['"](\/[^'"]+)['"]/g,
    /request\([^,]+,\s*['"](\/[^'"]+)['"]/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      routes.add(match[1]);
    }
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

function readRouteSources(root, relativePaths, extractor) {
  const routes = new Set();
  for (const relativePath of relativePaths) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    for (const route of extractor(source)) {
      routes.add(route);
    }
  }
  return sortRoutes(routes);
}

function collectFrontendRoutes(root) {
  const routes = new Set();
  const frontendApiRoot = path.join(root, 'frontend', 'src', 'api');
  for (const frontendPath of collectFrontendApiClientFiles(frontendApiRoot)) {
    const source = fs.readFileSync(frontendPath, 'utf8');
    for (const route of extractRoutesFromFrontendClient(source)) {
      routes.add(route);
    }
  }
  return sortRoutes(routes);
}

function collectContractRoutes() {
  return sortRoutes([
    ...Object.keys(ROUTE_FEATURE_MAP),
    ...READ_PATHS,
    ...OWNER_ONLY_ROUTES,
    ...CONTRACT_ONLY_ROUTES,
  ]);
}

function collectRuntimeContractParity(options = {}) {
  const root = options.repoRoot || repoRoot;
  const contractRoutes = collectContractRoutes();
  const edgeRoutes = readRouteSources(root, EDGE_ROUTE_SOURCES, extractRoutesFromHandlerSource);
  const backendRoutes = readRouteSources(root, BACKEND_ROUTE_SOURCES, extractRoutesFromHandlerSource);
  const clientRoutes = collectFrontendRoutes(root);
  const plannerRouteSetParity = collectPlannerRouteSetParity();

  const edgeOnlyRouteExceptions = new Set(EDGE_ONLY_ROUTE_EXCEPTIONS);
  const missingInEdge = diffRoutes(contractRoutes, edgeRoutes);
  const missingInBackend = diffRoutes(contractRoutes, backendRoutes)
    .filter((route) => !edgeOnlyRouteExceptions.has(route));
  const missingInClient = missingInEdge.filter((route) => clientRoutes.includes(route));
  const clientNotInContract = diffRoutes(clientRoutes, contractRoutes);
  const edgeNotInContract = diffRoutes(edgeRoutes, contractRoutes);
  const backendNotInContract = diffRoutes(backendRoutes, contractRoutes);
  const backendMissingInEdge = diffRoutes(backendRoutes, edgeRoutes);
  const edgeMissingInBackend = diffRoutes(edgeRoutes, backendRoutes)
    .filter((route) => !edgeOnlyRouteExceptions.has(route));

  const mismatches = [];
  if (missingInEdge.length) {
    mismatches.push({ label: 'missing in edge', routes: missingInEdge });
  }
  if (missingInBackend.length) {
    mismatches.push({ label: 'missing in backend handlers', routes: missingInBackend });
  }
  if (missingInClient.length) {
    mismatches.push({ label: 'missing in edge but used by client', routes: missingInClient });
  }
  if (clientNotInContract.length) {
    mismatches.push({ label: 'client routes not in contract', routes: clientNotInContract });
  }
  if (edgeNotInContract.length) {
    mismatches.push({ label: 'edge routes not in contract', routes: edgeNotInContract });
  }
  if (backendNotInContract.length) {
    mismatches.push({ label: 'backend routes not in contract', routes: backendNotInContract });
  }
  if (backendMissingInEdge.length) {
    mismatches.push({ label: 'backend routes missing in edge', routes: backendMissingInEdge });
  }
  if (edgeMissingInBackend.length) {
    mismatches.push({ label: 'edge routes missing in backend handlers', routes: edgeMissingInBackend });
  }

  return {
    contractRoutes,
    edgeRoutes,
    backendRoutes,
    clientRoutes,
    missingInEdge,
    missingInBackend,
    missingInClient,
    clientNotInContract,
    edgeNotInContract,
    backendNotInContract,
    backendMissingInEdge,
    edgeMissingInBackend,
    plannerRouteSetParity,
    mismatches,
  };
}

function formatRuntimeContractMismatches(parity) {
  const details = parity.mismatches.map((entry) => (
    `[contract:parity] ${entry.label}: ${entry.routes.join(', ')}`
  ));

  if (parity.plannerRouteSetParity.mismatches.length) {
    details.push(
      '[contract:parity] planner route-set mismatch:\n' +
        formatPlannerRouteSetMismatches(parity.plannerRouteSetParity.mismatches)
    );
  }

  return details.join('\n');
}

export {
  BACKEND_ROUTE_SOURCES,
  CONTRACT_ONLY_ROUTES,
  EDGE_ONLY_ROUTE_EXCEPTIONS,
  EDGE_ROUTE_SOURCES,
  collectContractRoutes,
  collectRuntimeContractParity,
  extractRoutesFromFrontendClient,
  extractRoutesFromHandlerSource,
  formatRuntimeContractMismatches,
};
