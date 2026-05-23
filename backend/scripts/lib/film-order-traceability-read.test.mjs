import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBoxFilmOrderOrigins,
  buildFilmOrderDetail,
} from '../../src/app/services/filmOrders.mjs';

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
              neededFeet: 230,
              fulfilledFeet: 100,
              remainingFeet: 130,
              overageFeet: 0,
              displayStatus: 'INCOMPLETE',
            },
          },
        ],
      };
    },
  };

  const result = await buildFilmOrderDetail(client, '00000000-0000-4000-8000-000000000001', 'FO-1');

  assert.deepEqual(result, {
    filmOrderId: 'FO-1',
    neededFeet: 230,
    fulfilledFeet: 100,
    remainingFeet: 130,
    overageFeet: 0,
    displayStatus: 'INCOMPLETE',
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
