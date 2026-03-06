import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/storage', () => ({
  getStoredAuthSession: vi.fn(() => null)
}));

import { request } from './http';

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

describe('http request envelope parsing', () => {
  beforeEach(() => {
    setWindowLocation();
    vi.restoreAllMocks();
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
});
