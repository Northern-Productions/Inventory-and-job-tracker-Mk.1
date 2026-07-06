import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LEGACY_API_RUNTIME_CACHE_NAMES,
  clearLegacyApiRuntimeCaches
} from './browserTenantCaches';

describe('browser tenant cache cleanup', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('deletes the legacy Workbox API runtime cache by exact cache name', async () => {
    const deleteMock = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('caches', {
      delete: deleteMock
    });

    await clearLegacyApiRuntimeCaches();

    expect(LEGACY_API_RUNTIME_CACHE_NAMES).toEqual(['api-cache']);
    expect(deleteMock).toHaveBeenCalledWith('api-cache');
  });

  it('does not configure Workbox runtime caching for authenticated API responses', () => {
    const viteConfig = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8');

    expect(viteConfig).not.toContain("pathname.startsWith('/api')");
    expect(viteConfig).not.toContain("cacheName: 'api-cache'");
  });
});
