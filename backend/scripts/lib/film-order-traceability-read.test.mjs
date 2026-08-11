import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  buildBoxFilmOrderOrigins,
  buildFilmOrderDetail,
} from '../../src/app/services/filmOrders.mjs';

const localReadHandlers = readFileSync(
  new URL('../../src/app/handlers/readHandlers.mjs', import.meta.url),
  'utf8'
);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendOriginMigration = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0155_film_order_detail_origin_compat.sql'
);
const supabaseOriginMigration = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260529101000_film_order_detail_origin_compat.sql'
);

test('local read dispatcher projects auth context before ACL-backed film order reads', () => {
  assert.match(localReadHandlers, /import \{ applyAuthenticatedSessionContext \} from '\.\.\/services\/access\.mjs';/);
  assert.match(localReadHandlers, /await client\.query\('BEGIN'\);/);
  assert.match(
    localReadHandlers,
    /await applyAuthenticatedSessionContext\(client, authContext\);\s+const response = await handler\(\{ client, orgId: authContext\.orgId, params, authContext \}\);/s
  );
  assert.match(localReadHandlers, /await client\.query\('COMMIT'\);/);
  assert.match(localReadHandlers, /await client\.query\('ROLLBACK'\);/);
});

test('film order detail origin compatibility migration stays mirrored', () => {
  const backendMigration = readFileSync(backendOriginMigration, 'utf8');
  const supabaseMigration = readFileSync(supabaseOriginMigration, 'utf8');

  assert.equal(supabaseMigration, backendMigration);
  assert.match(backendMigration, /'sourceBoxId', v_order\.source_box_id/);
  assert.match(backendMigration, /when app_api\.trim_text\(v_order\.source_box_id\) = '' then 'MANUAL'/);
  assert.doesNotMatch(backendMigration, /v_order\.origin/);
});

test('buildFilmOrderDetail uses the scoped film order detail RPC', async () => {
  const calls = [];
  const client = {
    async query(text, params) {
      calls.push({ text, params });
      return {
        rows: [
          {
            result: {
              filmOrderId: 'FO-1',
              requestedFeet: 12,
              linkedFeet: 12,
              receivedFeet: 0,
              onTheWayFeet: 12,
              neededFeet: 12,
              fulfilledFeet: 0,
              remainingFeet: 0,
              overageFeet: 0,
              displayStatus: 'FILM_ON_THE_WAY',
              requirementContextStatus: 'HISTORICAL_UNBOUND',
            },
          },
        ],
      };
    },
  };

  const result = await buildFilmOrderDetail(client, '00000000-0000-4000-8000-000000000001', 'FO-1');

  assert.deepEqual(result, {
    filmOrderId: 'FO-1',
    requestedFeet: 12,
    linkedFeet: 12,
    receivedFeet: 0,
    onTheWayFeet: 12,
    neededFeet: 12,
    fulfilledFeet: 0,
    remainingFeet: 0,
    overageFeet: 0,
    displayStatus: 'FILM_ON_THE_WAY',
    requirementContextStatus: 'HISTORICAL_UNBOUND',
    currentRequirement: { availability: 'HISTORICAL_UNBOUND' },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /public\.api_acl_film_orders_get/);
  assert.deepEqual(calls[0].params, ['00000000-0000-4000-8000-000000000001', 'FO-1']);
});

test('buildFilmOrderDetail returns not found for unknown film orders', async () => {
  const client = {
    async query() {
      return { rows: [{ result: null }] };
    },
  };

  await assert.rejects(
    () => buildFilmOrderDetail(client, '00000000-0000-4000-8000-000000000001', 'FO-MISSING'),
    /Film order not found/
  );
});

test('buildBoxFilmOrderOrigins uses the scoped box origin RPC', async () => {
  const client = {
    async query(text, params) {
      assert.match(text, /public\.api_acl_box_film_order_origins/);
      assert.deepEqual(params, ['00000000-0000-4000-8000-000000000001', 'IL1-100']);
      return {
        rows: [
          {
            result: [
              {
                jobId: '11111111-1111-4111-8111-111111111111',
                jobNumber: '4953',
                filmOrderId: 'FO-1',
                phaseNumber: 1,
                workScope: 'Section 1',
                orderedDate: '2026-05-18',
                receivedDate: '2026-05-20',
              },
            ],
          },
        ],
      };
    },
  };

  const result = await buildBoxFilmOrderOrigins(client, '00000000-0000-4000-8000-000000000001', 'IL1-100');

  assert.deepEqual(result, [
    {
      jobId: '11111111-1111-4111-8111-111111111111',
      jobNumber: '4953',
      filmOrderId: 'FO-1',
      phaseNumber: 1,
      workScope: 'Section 1',
      orderedDate: '2026-05-18',
      receivedDate: '2026-05-20',
    },
  ]);
});
