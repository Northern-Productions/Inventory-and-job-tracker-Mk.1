import { beforeEach, describe, expect, it, vi } from 'vitest';

const getStoredAuthSessionMock = vi.fn<() => any>(() => null);
const getSupabaseClientMock = vi.fn<() => any>(() => null);

vi.mock('../lib/storage', () => ({
  getStoredAuthSession: () => getStoredAuthSessionMock()
}));

vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => getSupabaseClientMock()
}));

import {
  __resetRequestAuthContextCacheForTests,
  request,
  resolveApiBaseUrlFromConfig
} from './http';

function setWindowLocation() {
  Object.defineProperty(globalThis, 'window', {
    value: {
      location: {
        hostname: 'localhost',
        origin: 'http://localhost:5173'
      }
    },
    configurable: true,
    writable: true
  });
}

function buildJwt(payload: Record<string, unknown>) {
  const encode = (value: Record<string, unknown>) =>
    globalThis
      .btoa(JSON.stringify(value))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');

  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

function buildStoredAuthSession(token: string) {
  return {
    token,
    expiresAt: Date.now() + 60 * 60 * 1000,
    user: {
      email: 'crew@example.com',
      hasProfileName: true,
      name: 'Crew Lead',
      picture: '',
      sub: 'user-1'
    }
  };
}

function buildSupabaseSession(token: string) {
  return {
    access_token: token,
    expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
    user: {
      id: 'user-1',
      email: 'crew@example.com',
      user_metadata: {
        full_name: 'Crew Lead'
      }
    }
  };
}

describe('http request envelope parsing', () => {
  beforeEach(() => {
    setWindowLocation();
    vi.restoreAllMocks();
    getStoredAuthSessionMock.mockReset();
    getStoredAuthSessionMock.mockReturnValue(null);
    getSupabaseClientMock.mockReset();
    getSupabaseClientMock.mockReturnValue(null);
    __resetRequestAuthContextCacheForTests();
  });

  it('uses the JSON fast path when the response body is valid JSON', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, data: { value: 42 }, warnings: [] }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        })
      );

    const result = await request<{ value: number }>('GET', '/health');

    expect(result.data.value).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to text parsing if response.clone().json() fails', async () => {
    const responseLike = {
      ok: true,
      clone: () => ({
        json: async () => {
          throw new Error('json parse failed');
        }
      }),
      text: async () => JSON.stringify({ ok: true, data: { value: 7 }, warnings: [] })
    } as unknown as Response;

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(responseLike);

    const result = await request<{ value: number }>('GET', '/health');

    expect(result.data.value).toBe(7);
  });

  it('throws a readable error when fallback text is HTML', async () => {
    const responseLike = {
      ok: true,
      clone: () => ({
        json: async () => {
          throw new Error('json parse failed');
        }
      }),
      text: async () => '<html><body>Proxy error</body></html>'
    } as unknown as Response;

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(responseLike);

    await expect(request('GET', '/health')).rejects.toMatchObject({
      name: 'APIError',
      message: expect.stringContaining('The API returned HTML instead of JSON.')
    });
  });

  it('preserves structured job-number ambiguity metadata from error envelopes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error: 'Job number 81234 matches multiple jobs.',
          warnings: [],
          code: 'JOB_NUMBER_AMBIGUOUS',
          jobNumber: '81234',
          candidates: [
            {
              jobId: '11111111-1111-4111-8111-111111111111',
              jobNumber: '81234',
              routeTarget: '/allocations/jobs/11111111-1111-4111-8111-111111111111',
              workScope: 'Phase A',
              warehouse: 'IL1',
              installDate: '2026-05-01',
              crewLeader: 'Crew A',
              lifecycleStatus: 'ACTIVE',
              updatedAt: '2026-05-01T12:00:00Z'
            }
          ]
        }),
        {
          status: 409,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      )
    );

    await expect(request('GET', '/jobs/get')).rejects.toMatchObject({
      name: 'APIError',
      code: 'JOB_NUMBER_AMBIGUOUS',
      jobNumber: '81234',
      candidates: [
        {
          jobId: '11111111-1111-4111-8111-111111111111',
          jobNumber: '81234',
          routeTarget: '/allocations/jobs/11111111-1111-4111-8111-111111111111',
          workScope: 'Phase A',
          warehouse: 'IL1'
        }
      ]
    });
  });

  it('serializes repeated query values for array params', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, data: { value: 1 }, warnings: [] }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        })
      );

    await request<{ value: number }>('GET', '/boxes/search', {
      query: {
        warehouses: ['IL1', 'MS1'],
        manufacturer: 'Llumar'
      }
    });

    const requestUrl = String(fetchMock.mock.calls[0]?.[0] || '');
    expect(requestUrl).toContain('warehouses=IL1');
    expect(requestUrl).toContain('warehouses=MS1');
    expect(requestUrl).toContain('manufacturer=Llumar');
  });

  it('reuses one in-flight auth lookup for concurrent requests', async () => {
    const token = buildJwt({
      iss: '/auth/v1/project',
      exp: Math.floor(Date.now() / 1000) + 60 * 60
    });
    const getSessionMock = vi.fn().mockResolvedValue({
      data: {
        session: buildSupabaseSession(token)
      },
      error: null
    });

    getStoredAuthSessionMock.mockReturnValue(buildStoredAuthSession(token));
    getSupabaseClientMock.mockReturnValue({
      auth: {
        getSession: getSessionMock,
        refreshSession: vi.fn()
      }
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ ok: true, data: { value: 42 }, warnings: [] }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    });

    await Promise.all([
      request<{ value: number }>('GET', '/health'),
      request<{ value: number }>('GET', '/health')
    ]);

    expect(getSessionMock).toHaveBeenCalledTimes(1);
  });

  it('invalidates the auth lookup cache when the stored token changes', async () => {
    const tokenA = buildJwt({
      iss: '/auth/v1/project-a',
      exp: Math.floor(Date.now() / 1000) + 60 * 60
    });
    const tokenB = buildJwt({
      iss: '/auth/v1/project-b',
      exp: Math.floor(Date.now() / 1000) + 60 * 60
    });
    let storedToken = tokenA;
    let activeToken = tokenA;
    const getSessionMock = vi.fn().mockImplementation(async () => ({
      data: {
        session: buildSupabaseSession(activeToken)
      },
      error: null
    }));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ ok: true, data: { value: 1 }, warnings: [] }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    });

    getStoredAuthSessionMock.mockImplementation(() => buildStoredAuthSession(storedToken));
    getSupabaseClientMock.mockReturnValue({
      auth: {
        getSession: getSessionMock,
        refreshSession: vi.fn()
      }
    });

    await request<{ value: number }>('GET', '/health');

    storedToken = tokenB;
    activeToken = tokenB;

    await request<{ value: number }>('GET', '/health');

    expect(getSessionMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('resolveApiBaseUrlFromConfig', () => {
  it('keeps the local proxy path on localhost when a proxy target is configured', () => {
    expect(
      resolveApiBaseUrlFromConfig({
        configuredApiBaseUrl: '/api',
        proxyTarget: 'http://localhost:3000',
        supabaseUrl: 'https://example.supabase.co',
        hostname: 'localhost'
      })
    ).toBe('/api');
  });

  it('keeps the local proxy path on dev LAN hosts when a proxy target is configured', () => {
    expect(
      resolveApiBaseUrlFromConfig({
        configuredApiBaseUrl: 'https://example.supabase.co/functions/v1/api',
        proxyTarget: 'http://localhost:3000',
        supabaseUrl: 'https://example.supabase.co',
        hostname: '192.168.1.20',
        isDev: true
      })
    ).toBe('/api');
  });

  it('falls back to the Supabase edge function on non-local hosts when api base is blank', () => {
    expect(
      resolveApiBaseUrlFromConfig({
        configuredApiBaseUrl: '',
        proxyTarget: '',
        supabaseUrl: 'https://example.supabase.co/',
        hostname: 'inventorymk1.vercel.app'
      })
    ).toBe('https://example.supabase.co/functions/v1/api');
  });

  it('falls back to the Supabase edge function on non-local hosts when api base is still /api', () => {
    expect(
      resolveApiBaseUrlFromConfig({
        configuredApiBaseUrl: '/api',
        proxyTarget: '',
        supabaseUrl: 'https://example.supabase.co',
        hostname: 'inventorymk1.vercel.app'
      })
    ).toBe('https://example.supabase.co/functions/v1/api');
  });
});
