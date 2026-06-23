import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  resolveCheckoutSnapshotAllocationFeet,
} from '../../src/app/services/runtime/runtimeAllocationLinks.mjs';

test('local runtime allocation links imports the checkout audit helper used by checked-out box reconciliation', async () => {
  const source = await readFile(
    new URL('../../src/app/services/runtime/runtimeAllocationLinks.mjs', import.meta.url),
    'utf8'
  );

  assert.match(
    source,
    /import\s*\{\s*findLatestCheckoutAuditEntryByBoxId\s*\}\s*from\s*['"]\.\/checkout\/audit\.mjs['"]/,
    'runtimeAllocationLinks must import the checkout audit helper it calls for Box Details allocation reconciliation'
  );
  assert.match(
    source,
    /await\s+findLatestCheckoutAuditEntryByBoxId\(client,\s*orgId,\s*box\.boxId\)/,
    'checked-out box reconciliation should continue using the latest checkout audit snapshot'
  );
});

test('local runtime allocation links imports the planning film compatibility helper used by checkout auto-linking', async () => {
  const source = await readFile(
    new URL('../../src/app/services/runtime/runtimeAllocationLinks.mjs', import.meta.url),
    'utf8'
  );

  assert.match(
    source,
    /planningFilmCanSatisfyRequirement/,
    'runtimeAllocationLinks should import the planning film compatibility helper it calls during checked-out auto-linking'
  );
  assert.match(
    source,
    /import\s*\{[\s\S]*planningFilmCanSatisfyRequirement[\s\S]*\}\s*from\s*['"]\.\/runtimeAllocationCoverage\.mjs['"]/,
    'checked-out auto-linking should not rely on an undefined planningFilmCanSatisfyRequirement reference'
  );
});

test('checkout snapshot allocation feet falls back safely when no checkout audit entry exists', () => {
  assert.equal(
    resolveCheckoutSnapshotAllocationFeet(null, { feetAvailable: 42 }),
    42
  );
});

test('checkout snapshot allocation feet prefers the audit after state when present', () => {
  assert.equal(
    resolveCheckoutSnapshotAllocationFeet(
      { before: { feetAvailable: 67 }, after: { feetAvailable: 31 } },
      { feetAvailable: 99 }
    ),
    31
  );
});
