import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getStoredAuthSession, setStoredAuthSession } from './storage';

type MemoryStore = Map<string, string>;

function createMemoryWindow(initialStore?: MemoryStore): Window {
  const store = initialStore ?? new Map<string, string>();

  const localStorage = {
    getItem(key: string): string | null {
      return store.has(key) ? store.get(key) ?? null : null;
    },
    setItem(key: string, value: string): void {
      store.set(key, String(value));
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    clear(): void {
      store.clear();
    },
    key(index: number): string | null {
      return [...store.keys()][index] ?? null;
    },
    get length(): number {
      return store.size;
    }
  };

  return { localStorage } as unknown as Window;
}

function encodeBase64Url_(value: string): string {
  return globalThis.btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function buildSupabaseLikeToken_(): string {
  const header = encodeBase64Url_('{"alg":"HS256","typ":"JWT"}');
  const payload = encodeBase64Url_(
    '{"iss":"https://example.supabase.co/auth/v1","role":"authenticated","email":"rob@example.com"}'
  );
  return `${header}.${payload}.signature`;
}

describe('storage auth session validation', () => {
  beforeEach(() => {
    vi.stubGlobal('window', createMemoryWindow());
  });

  it('returns a persisted session when token shape is valid and not expired', () => {
    const session = {
      token: buildSupabaseLikeToken_(),
      issuedAt: Date.now() - 1000,
      expiresAt: Date.now() + 60_000,
      user: {
        email: 'rob@example.com',
        hasProfileName: true,
        name: 'Rob',
        picture: '',
        sub: '123'
      }
    };

    setStoredAuthSession(session);
    expect(getStoredAuthSession()).toEqual(session);
  });

  it('clears persisted session when token is not a JWT', () => {
    const session = {
      token: 'legacy-token',
      issuedAt: Date.now() - 1000,
      expiresAt: Date.now() + 60_000,
      user: {
        email: 'rob@example.com',
        hasProfileName: true,
        name: 'Rob',
        picture: '',
        sub: '123'
      }
    };

    setStoredAuthSession(session);
    expect(getStoredAuthSession()).toBeNull();
  });

  it('clears persisted session when token is expired', () => {
    const session = {
      token: buildSupabaseLikeToken_(),
      issuedAt: Date.now() - 20_000,
      expiresAt: Date.now() - 10_000,
      user: {
        email: 'rob@example.com',
        hasProfileName: true,
        name: 'Rob',
        picture: '',
        sub: '123'
      }
    };

    setStoredAuthSession(session);
    expect(getStoredAuthSession()).toBeNull();
  });
});
