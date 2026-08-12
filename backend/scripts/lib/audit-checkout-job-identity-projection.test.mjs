import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

import { enrichAuditEntriesWithCheckoutJobIdentity } from '../../src/app/handlers/readHandlers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const localReadHandlersPath = path.join(repoRoot, 'backend', 'src', 'app', 'handlers', 'readHandlers.mjs');
const edgeReadHandlersPath = path.join(repoRoot, 'supabase', 'functions', '_shared', 'routes', 'readHandlers.ts');
const checkoutHistoryPagePath = path.join(
  repoRoot,
  'frontend',
  'src',
  'features',
  'inventory',
  'pages',
  'CheckoutHistoryPage.tsx'
);
const migrationsPath = path.join(repoRoot, 'backend', 'migrations');
const supabaseMigrationsPath = path.join(repoRoot, 'supabase', 'migrations');
const schemaLatestPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');
const baseSchemaPath = path.join(repoRoot, 'backend', 'migrations', '0001_supabase_inventory_schema.sql');
const duplicateGuardPath = path.join(repoRoot, 'backend', 'migrations', '0117_duplicate_job_creation_guard.sql');

function buildAuditEntry(overrides = {}) {
  return {
    logId: 'audit-1',
    action: 'SET_STATUS',
    boxId: 'IL1-100',
    date: '2026-05-18T12:00:00Z',
    before: null,
    after: null,
    user: 'tester',
    notes: '',
    ...overrides,
  };
}

test('audit checkout projection enriches structured checkout snapshots by jobId only', async () => {
  const calls = [];
  const entries = await enrichAuditEntriesWithCheckoutJobIdentity(
    {},
    'org-1',
    [
      buildAuditEntry({
        after: {
          status: 'CHECKED_OUT',
          lastCheckoutJobId: '11111111-1111-4111-8111-111111111111',
          lastCheckoutJob: '4953',
        },
        notes: 'Any readable audit note',
      }),
    ],
    {
      findJobById: async (_client, orgId, jobId) => {
        calls.push(`findJobById:${orgId}:${jobId}`);
        return {
          jobNumber: '4953',
          warehouse: 'IL1',
          workScope: 'Sections 4, 5',
          sections: 'Sections 4, 5',
        };
      },
    }
  );

  assert.deepEqual(calls, ['findJobById:org-1:11111111-1111-4111-8111-111111111111']);
  assert.deepEqual(entries[0], {
    logId: 'audit-1',
    action: 'SET_STATUS',
    boxId: 'IL1-100',
    date: '2026-05-18T12:00:00Z',
    before: null,
    after: {
      status: 'CHECKED_OUT',
      lastCheckoutJobId: '11111111-1111-4111-8111-111111111111',
      lastCheckoutJob: '4953',
    },
    user: 'tester',
    notes: 'Any readable audit note',
    jobId: '11111111-1111-4111-8111-111111111111',
    jobNumber: '4953',
    jobWarehouse: 'IL1',
    workScope: 'Sections 4, 5',
    sections: 'Sections 4, 5',
  });
});

test('audit checkout projection enriches structured check-in snapshots from before state', async () => {
  const entries = await enrichAuditEntriesWithCheckoutJobIdentity(
    {},
    'org-1',
    [
      buildAuditEntry({
        before: {
          status: 'CHECKED_OUT',
          lastCheckoutJobId: '22222222-2222-4222-8222-222222222222',
          lastCheckoutJob: '16242',
        },
        after: {
          status: 'IN_STOCK',
          lastCheckoutJobId: '',
          lastCheckoutJob: '',
        },
      }),
    ],
    {
      findJobById: async () => ({
        warehouse: 'MS1',
        sections: 'Lobby Phase',
      }),
    }
  );

  assert.equal(entries[0].jobId, '22222222-2222-4222-8222-222222222222');
  assert.equal(entries[0].jobNumber, '16242');
  assert.equal(entries[0].jobWarehouse, 'MS1');
  assert.equal(entries[0].workScope, 'Lobby Phase');
  assert.equal(entries[0].sections, 'Lobby Phase');
});

test('audit checkout projection leaves legacy note-only rows unchanged', async () => {
  let lookupCount = 0;
  const legacyEntry = buildAuditEntry({
    logId: 'legacy-1',
    notes: 'Checked out for job 4953',
    after: {
      status: 'CHECKED_OUT',
      lastCheckoutJobId: '',
      lastCheckoutJob: '4953',
    },
  });

  const entries = await enrichAuditEntriesWithCheckoutJobIdentity(
    {},
    'org-1',
    [legacyEntry],
    {
      findJobById: async () => {
        lookupCount += 1;
        return null;
      },
    }
  );

  assert.equal(lookupCount, 0);
  assert.deepEqual(entries[0], legacyEntry);
  assert.equal(Object.hasOwn(entries[0], 'jobId'), false);
  assert.equal(Object.hasOwn(entries[0], 'workScope'), false);
});

test('audit checkout projection source avoids note parsing, migrations, and duplicate behavior changes', async () => {
  const [localReadHandlers, edgeReadHandlers, checkoutHistoryPage, baseSchema, duplicateGuard, schemaLatest] =
    await Promise.all([
      readFile(localReadHandlersPath, 'utf8'),
      readFile(edgeReadHandlersPath, 'utf8'),
      readFile(checkoutHistoryPagePath, 'utf8'),
      readFile(baseSchemaPath, 'utf8'),
      readFile(duplicateGuardPath, 'utf8'),
      readFile(schemaLatestPath, 'utf8'),
    ]);

  for (const source of [localReadHandlers, edgeReadHandlers]) {
    assert.match(source, /enrichAuditEntriesWithCheckoutJobIdentity/);
    assert.match(source, /lastCheckoutJobId/);
    assert.match(source, /findJobById/);
    assert.doesNotMatch(source, /findJobByNumber.*audit/i);
    assert.doesNotMatch(source, /notes\.match|match\(\s*\/\^Checked out for job/i);
  }

  assert.match(checkoutHistoryPage, /formatJobDisplayLabel/);
  assert.match(checkoutHistoryPage, /hasStructuredCheckoutJob/);
  assert.doesNotMatch(checkoutHistoryPage, /<Link|navigate\(`\/allocations\/jobs/);
  assert.match(baseSchema, /unique\s*\(\s*org_id\s*,\s*job_number\s*\)/i);
  assert.match(duplicateGuard, /Job %s already exists/);



  const backendMigrations = await readdir(migrationsPath);
  const supabaseMigrations = await readdir(supabaseMigrationsPath);

  assert.ok(backendMigrations.includes('0162_prevent_box_id_alias_collisions.sql'));

  assert.ok(
    supabaseMigrations.includes('20260617100000_prevent_box_id_alias_collisions.sql')
  );
});
