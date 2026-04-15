import test from 'node:test';
import assert from 'node:assert/strict';

import { applyAuthenticatedSessionContext } from '../../src/app/services/access.mjs';

test('applyAuthenticatedSessionContext projects the authenticated user into the database session', async () => {
  const calls = [];
  const client = {
    async query(text, params) {
      calls.push({ text, params });
      return { rows: [] };
    },
  };

  await applyAuthenticatedSessionContext(client, {
    userId: ' user-123 ',
    email: ' smoke@example.com ',
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /set_config\('request\.jwt\.claim\.sub'/);
  assert.deepEqual(calls[0].params, [
    'user-123',
    'smoke@example.com',
    JSON.stringify({
      sub: 'user-123',
      email: 'smoke@example.com',
      role: 'authenticated',
    }),
  ]);
});

test('applyAuthenticatedSessionContext requires an authenticated identity', async () => {
  const client = {
    async query() {
      throw new Error('query should not run without auth context');
    },
  };

  await assert.rejects(
    () => applyAuthenticatedSessionContext(client, { userId: '', email: '' }),
    (error) => error?.statusCode === 401 && /Authenticated session is required/i.test(error?.message || '')
  );
});
