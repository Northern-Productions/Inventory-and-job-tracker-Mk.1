import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('film weight review resolution migration is mirrored and contract-routed', async () => {
  const backendMigrationPath = path.join(
    repoRoot,
    'backend',
    'migrations',
    '0168_film_weight_pending_review_resolution.sql'
  );
  const supabaseMigrationPath = path.join(
    repoRoot,
    'supabase',
    'migrations',
    '20260618104000_film_weight_pending_review_resolution.sql'
  );
  const contractPath = path.join(repoRoot, 'shared', 'domain', 'runtimeContract.mjs');
  const localFallbackPath = path.join(repoRoot, 'backend', 'src', 'routes', 'localFallbackRoutes.mjs');
  const backendHandlersPath = path.join(repoRoot, 'backend', 'src', 'app', 'handlers', 'mutationHandlers.mjs');
  const edgeHandlersPath = path.join(
    repoRoot,
    'supabase',
    'functions',
    '_shared',
    'routes',
    'mutationHandlers.ts'
  );
  const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

  const [
    backendMigration,
    supabaseMigration,
    contract,
    localFallback,
    backendHandlers,
    edgeHandlers,
    schemaCheck,
  ] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
    readFile(contractPath, 'utf8'),
    readFile(localFallbackPath, 'utf8'),
    readFile(backendHandlersPath, 'utf8'),
    readFile(edgeHandlersPath, 'utf8'),
    readFile(schemaCheckPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
  assert.match(backendMigration, /app_api\.resolve_film_weight_pending_review/);
  assert.match(backendMigration, /public\.api_acl_resolve_film_weight_pending_review/);
  assert.match(backendMigration, /acceptance_status = v_sample_status/);
  assert.match(contract, /'\/film-weight\/pending-reviews\/resolve': 'inventory'/);
  assert.match(localFallback, /"\/film-weight\/pending-reviews\/resolve"/);
  assert.match(backendHandlers, /resolveFilmWeightPendingReview/);
  assert.match(edgeHandlers, /api_acl_resolve_film_weight_pending_review/);
  assert.match(schemaCheck, /0187_caulk_owner_transfer_id_uppercase\.sql/);
  assert.match(schemaCheck, /public\.api_acl_resolve_film_weight_pending_review/);
});
