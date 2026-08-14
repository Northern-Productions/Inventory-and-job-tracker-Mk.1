import assert from 'node:assert/strict';
import test from 'node:test';

import { correctFilmOrderReceipt } from '../../src/app/services/filmOrders.mjs';

test('local receipt correction delegates exact tenant, actor, and payload to the guarded RPC', async () => {
  const calls = [];
  const payload = {
    filmOrderId: 'FO-1',
    linkId: 'link-1',
    boxId: 'IL1-100',
    correctedReceivedFeet: 52,
    reason: 'Receiving footage entered incorrectly.',
  };
  const client = {
    async query(text, params) {
      calls.push({ text: String(text), params });
      return {
        rows: [
          {
            result: {
              filmOrderId: 'FO-1',
              linkId: 'link-1',
              boxId: 'IL1-100',
              previousReceivedFeet: 60,
              correctedReceivedFeet: 52,
              warnings: ['Receipt history corrected.'],
            },
          },
        ],
      };
    },
  };

  const response = await correctFilmOrderReceipt(client, 'org-1', payload, 'authorized-user');

  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /public\.api_acl_film_orders_correct_received_lf/);
  assert.deepEqual(calls[0].params, ['org-1', 'authorized-user', JSON.stringify(payload)]);
  assert.deepEqual(response, {
    ok: true,
    data: {
      filmOrderId: 'FO-1',
      linkId: 'link-1',
      boxId: 'IL1-100',
      previousReceivedFeet: 60,
      correctedReceivedFeet: 52,
      warnings: ['Receipt history corrected.'],
    },
    warnings: ['Receipt history corrected.'],
  });
});
