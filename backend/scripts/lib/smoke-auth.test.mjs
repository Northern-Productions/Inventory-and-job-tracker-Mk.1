import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSmokeAuthSetupMessage, resolveSmokeAuthToken } from './smoke-auth.mjs';

test('returns configured SMOKE_AUTH_TOKEN without calling fetch', async () => {
  const env = {
    SMOKE_AUTH_TOKEN: 'token-from-env'
  };
  let fetchCalls = 0;

  const result = await resolveSmokeAuthToken({
    env,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('fetch should not be called when SMOKE_AUTH_TOKEN is set');
    }
  });

  assert.deepEqual(result, {
    token: 'token-from-env',
    source: 'SMOKE_AUTH_TOKEN'
  });
  assert.equal(fetchCalls, 0);
});

test('returns missing when no token or smoke user credentials are configured', async () => {
  const result = await resolveSmokeAuthToken({
    env: {}
  });

  assert.deepEqual(result, {
    token: '',
    source: 'missing'
  });
});

test('mints a token from SMOKE_USER_EMAIL and SMOKE_USER_PASSWORD', async () => {
  const env = {
    SUPABASE_URL: 'https://example.supabase.co/',
    SUPABASE_ANON_KEY: 'anon-key',
    SMOKE_USER_EMAIL: 'smoke@example.com',
    SMOKE_USER_PASSWORD: 'smoke-password'
  };
  let request = null;

  const result = await resolveSmokeAuthToken({
    env,
    fetchImpl: async (url, init) => {
      request = { url, init };
      return {
        ok: true,
        async json() {
          return {
            access_token: 'minted-token'
          };
        }
      };
    }
  });

  assert.deepEqual(result, {
    token: 'minted-token',
    source: 'SMOKE_USER_EMAIL'
  });
  assert.equal(env.SMOKE_AUTH_TOKEN, 'minted-token');
  assert.equal(request.url, 'https://example.supabase.co/auth/v1/token?grant_type=password');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers['Content-Type'], 'application/json');
  assert.equal(request.init.headers.apikey, 'anon-key');
  assert.deepEqual(JSON.parse(request.init.body), {
    email: 'smoke@example.com',
    password: 'smoke-password'
  });
});

test('throws a clear setup message when auth is required but not configured', async () => {
  await assert.rejects(
    () =>
      resolveSmokeAuthToken({
        env: {},
        required: true,
        requiredFor: 'live Edge verification'
      }),
    /Set SMOKE_AUTH_TOKEN or configure SMOKE_USER_EMAIL and SMOKE_USER_PASSWORD in backend\/\.env for live Edge verification\./
  );
});

test('buildSmokeAuthSetupMessage mentions the reusable credential fallback', () => {
  assert.equal(
    buildSmokeAuthSetupMessage('authenticated backend smoke routes'),
    'Set SMOKE_AUTH_TOKEN or configure SMOKE_USER_EMAIL and SMOKE_USER_PASSWORD in backend/.env for authenticated backend smoke routes.'
  );
});
