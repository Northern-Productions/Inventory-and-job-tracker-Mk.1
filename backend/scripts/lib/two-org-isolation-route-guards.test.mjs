import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const localReadHandlersPath = path.join(repoRoot, 'backend', 'src', 'app', 'handlers', 'readHandlers.mjs');
const edgeReadHandlersPath = path.join(repoRoot, 'supabase', 'functions', '_shared', 'routes', 'readHandlers.ts');
const edgeMutationHandlersPath = path.join(repoRoot, 'supabase', 'functions', '_shared', 'routes', 'mutationHandlers.ts');

const HIGH_RISK_READ_ROUTES = [
  '/boxes/get',
  '/boxes/search',
  '/jobs/get-by-id',
  '/jobs/list',
  '/film-orders/get',
  '/film-orders/list',
  '/warehouses/list',
  '/owner-companies/list',
  '/reports/summary',
  '/film-weight/profiles',
  '/film-weight/pending-reviews',
  '/audit/by-box',
  '/allocations/by-box',
  '/allocations/preview',
];

const HIGH_RISK_MUTATION_ROUTES = [
  '/boxes/delete',
  '/allocations/apply',
  '/jobs/create',
  '/film-orders/create',
];

function assertRouteIsPresent(source, route) {
  assert.match(source, new RegExp(`['"]${route.replaceAll('/', '\\/')}['"]`), `Expected route ${route} to be registered.`);
}

test('local backend read dispatcher uses resolved auth org instead of client-supplied org params', async () => {
  const source = await readFile(localReadHandlersPath, 'utf8');

  assert.match(
    source,
    /orgId:\s*authContext\.orgId/,
    'Expected local read dispatcher to derive orgId only from authContext.',
  );
  assert.match(
    source,
    /applyAuthenticatedSessionContext\(client,\s*authContext\)/,
    'Expected local read transactions to project authenticated user claims before RLS-backed reads.',
  );
  assert.doesNotMatch(
    source,
    /orgId:\s*params\.orgId|orgId:\s*params\.organizationId|params\.orgId\s*\|\||params\.organizationId\s*\|\|/,
    'Local read dispatcher must not accept orgId/organizationId from request params.',
  );

  for (const route of HIGH_RISK_READ_ROUTES) {
    assertRouteIsPresent(source, route);
  }
});

test('Edge read dispatcher keeps tenant routes on resolved org context only', async () => {
  const source = await readFile(edgeReadHandlersPath, 'utf8');

  assert.match(
    source,
    /handler\(\{\s*client,\s*orgId,\s*logicalPath,\s*params,\s*identity\s*\},\s*deps\)/s,
    'Expected Edge read dispatcher to pass the resolved orgId into route handlers.',
  );
  assert.doesNotMatch(
    source,
    /orgId:\s*params\.orgId|orgId:\s*params\.organizationId|params\.orgId\s*\|\||params\.organizationId\s*\|\|/,
    'Edge read dispatcher must not accept orgId/organizationId from request params.',
  );

  for (const route of HIGH_RISK_READ_ROUTES) {
    assertRouteIsPresent(source, route);
  }
});

test('Edge mutation dispatcher canonicalizes and writes with resolved auth org only', async () => {
  const source = await readFile(edgeMutationHandlersPath, 'utf8');

  assert.match(
    source,
    /const orgId = identity\.orgId;/,
    'Expected Edge mutation dispatcher to derive orgId only from the authenticated identity.',
  );
  assert.match(
    source,
    /canonicalizeMutationPayloadForRoute\(client,\s*orgId,\s*logicalPath,\s*payload\)/,
    'Expected mutation canonicalization to receive the resolved orgId.',
  );
  assert.doesNotMatch(
    source,
    /orgId:\s*payload\.orgId|orgId:\s*payload\.organizationId|payload\.orgId\s*\|\||payload\.organizationId\s*\|\|/,
    'Edge mutation dispatcher must not accept orgId/organizationId from request payloads.',
  );

  for (const route of HIGH_RISK_MUTATION_ROUTES) {
    assertRouteIsPresent(source, route);
  }
});
