import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./http', () => {
  class APIError extends Error {
    warnings: string[];

    constructor(message: string, warnings: string[] = []) {
      super(message);
      this.name = 'APIError';
      this.warnings = warnings;
    }
  }

  return {
    APIError,
    request: vi.fn()
  };
});

vi.mock('../lib/offlineInventory', () => ({
  getOfflineBox: vi.fn(),
  replaceOfflineInventoryBoxes: vi.fn(),
  searchOfflineBoxes: vi.fn(),
  upsertOfflineInventoryBox: vi.fn()
}));

vi.mock('../lib/storage', () => ({
  getStoredAuthSession: vi.fn(() => ({
    token: 'token',
    user: {
      email: 'user@example.com',
      hasProfileName: true,
      name: 'User Example',
      sub: 'user-a'
    },
    issuedAt: 0,
    expiresAt: Date.now() + 60_000
  }))
}));

import {
  __resetJobsApiAvailabilityForTests,
  listWarehouses,
  setClientAccessContext,
  syncAllOfflineInventorySnapshots
} from './client';
import { request } from './http';
import { replaceOfflineInventoryBoxes } from '../lib/offlineInventory';
import { createDefaultFeatureAccessMap } from '../domain';

const requestMock = vi.mocked(request);
const replaceOfflineInventoryBoxesMock = vi.mocked(replaceOfflineInventoryBoxes);
const offlineScope = { userId: 'user-a', orgId: 'org-a' };

function buildOfflineMeta(warehouse: string, lastSyncedAt: string) {
  return {
    warehouse,
    boxCount: 0,
    lastSyncedAt,
    scopeKey: 'v2|user:user-a|org:org-a',
    userId: 'user-a',
    orgId: 'org-a',
    cacheVersion: 2
  };
}

describe('warehouse client APIs', () => {
  beforeEach(() => {
    __resetJobsApiAvailabilityForTests();
    setClientAccessContext({
      orgId: 'org-a',
      accessStatus: 'approved',
      role: 'owner',
      permissions: createDefaultFeatureAccessMap(),
      isAdminConsoleAllowed: true,
      pendingCount: 0,
      receivesInAppNotifications: true,
      defaultWarehouse: ''
    });
    requestMock.mockReset();
    replaceOfflineInventoryBoxesMock.mockReset();
  });

  it('maps warehouse entries from /warehouses/list', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        entries: [
          { code: 'il1', name: 'Wauconda IL1', boxIdPrefix: 'il1' },
          { code: 'TX1', name: 'Texas #1', boxIdPrefix: 'tx1' }
        ]
      },
      warnings: []
    });

    const result = await listWarehouses();

    expect(result).toEqual([
      { code: 'IL1', name: 'Wauconda IL1', boxIdPrefix: 'IL1' },
      { code: 'TX1', name: 'Texas #1', boxIdPrefix: 'TX1' }
    ]);
    expect(requestMock).toHaveBeenCalledWith('GET', '/warehouses/list', { query: {} });
  });

  it('syncs offline snapshots for warehouses returned by /warehouses/list', async () => {
    requestMock
      .mockResolvedValueOnce({
        data: {
          entries: [
            { code: 'IL1', name: 'Wauconda IL1', boxIdPrefix: 'IL1' },
            { code: 'TX1', name: 'Texas #1', boxIdPrefix: 'TX1' }
          ]
        },
        warnings: []
      })
      .mockResolvedValueOnce({
        data: [],
        warnings: []
      })
      .mockResolvedValueOnce({
        data: [],
        warnings: []
      });

    replaceOfflineInventoryBoxesMock
      .mockResolvedValueOnce(buildOfflineMeta('IL1', '2026-03-13T00:00:00.000Z') as never)
      .mockResolvedValueOnce(buildOfflineMeta('TX1', '2026-03-13T00:00:00.000Z') as never);

    const snapshots = await syncAllOfflineInventorySnapshots();

    expect(requestMock).toHaveBeenNthCalledWith(2, 'GET', '/boxes/search', {
      query: {
        warehouse: 'IL1',
        q: undefined,
        status: undefined,
        film: undefined,
        width: undefined,
        showRetired: true
      }
    });
    expect(requestMock).toHaveBeenNthCalledWith(3, 'GET', '/boxes/search', {
      query: {
        warehouse: 'TX1',
        q: undefined,
        status: undefined,
        film: undefined,
        width: undefined,
        showRetired: true
      }
    });
    expect(replaceOfflineInventoryBoxesMock).toHaveBeenNthCalledWith(1, offlineScope, 'IL1', []);
    expect(replaceOfflineInventoryBoxesMock).toHaveBeenNthCalledWith(2, offlineScope, 'TX1', []);
    expect(snapshots.map((entry) => entry.warehouse)).toEqual(['IL1', 'TX1']);
  });

  it('syncs the selected warehouse first and then refreshes remaining warehouses sequentially', async () => {
    requestMock
      .mockResolvedValueOnce({
        data: {
          entries: [
            { code: 'IL1', name: 'Wauconda IL1', boxIdPrefix: 'IL1' },
            { code: 'MO1', name: 'St. Louis MO1', boxIdPrefix: 'MO1' },
            { code: 'MS1', name: 'Ridgeland MS1', boxIdPrefix: 'MS1' }
          ]
        },
        warnings: []
      })
      .mockResolvedValueOnce({
        data: [],
        warnings: []
      })
      .mockResolvedValueOnce({
        data: [],
        warnings: []
      })
      .mockResolvedValueOnce({
        data: [],
        warnings: []
      });

    replaceOfflineInventoryBoxesMock
      .mockResolvedValueOnce(buildOfflineMeta('MO1', '2026-04-24T00:00:00.000Z') as never)
      .mockResolvedValueOnce(buildOfflineMeta('IL1', '2026-04-24T00:00:01.000Z') as never)
      .mockResolvedValueOnce(buildOfflineMeta('MS1', '2026-04-24T00:00:02.000Z') as never);

    const snapshots = await syncAllOfflineInventorySnapshots('MO1');

    expect(requestMock).toHaveBeenNthCalledWith(2, 'GET', '/boxes/search', {
      query: {
        warehouse: 'MO1',
        q: undefined,
        status: undefined,
        film: undefined,
        width: undefined,
        showRetired: true
      }
    });
    expect(requestMock).toHaveBeenNthCalledWith(3, 'GET', '/boxes/search', {
      query: {
        warehouse: 'IL1',
        q: undefined,
        status: undefined,
        film: undefined,
        width: undefined,
        showRetired: true
      }
    });
    expect(requestMock).toHaveBeenNthCalledWith(4, 'GET', '/boxes/search', {
      query: {
        warehouse: 'MS1',
        q: undefined,
        status: undefined,
        film: undefined,
        width: undefined,
        showRetired: true
      }
    });
    expect(replaceOfflineInventoryBoxesMock).toHaveBeenNthCalledWith(1, offlineScope, 'MO1', []);
    expect(replaceOfflineInventoryBoxesMock).toHaveBeenNthCalledWith(2, offlineScope, 'IL1', []);
    expect(replaceOfflineInventoryBoxesMock).toHaveBeenNthCalledWith(3, offlineScope, 'MS1', []);
    expect(snapshots.map((entry) => entry.warehouse)).toEqual(['MO1', 'IL1', 'MS1']);
  });

  it('does not fall back to static internal warehouses when the warehouse list cannot be loaded', async () => {
    requestMock.mockRejectedValueOnce(new Error('warehouses unavailable'));

    const snapshots = await syncAllOfflineInventorySnapshots();

    expect(snapshots).toEqual([]);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(replaceOfflineInventoryBoxesMock).not.toHaveBeenCalled();
  });
});
