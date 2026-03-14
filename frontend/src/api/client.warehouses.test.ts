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
  searchOfflineBoxes: vi.fn()
}));

import {
  __resetJobsApiAvailabilityForTests,
  listWarehouses,
  syncAllOfflineInventorySnapshots
} from './client';
import { request } from './http';
import { replaceOfflineInventoryBoxes } from '../lib/offlineInventory';

const requestMock = vi.mocked(request);
const replaceOfflineInventoryBoxesMock = vi.mocked(replaceOfflineInventoryBoxes);

describe('warehouse client APIs', () => {
  beforeEach(() => {
    __resetJobsApiAvailabilityForTests();
    requestMock.mockReset();
    replaceOfflineInventoryBoxesMock.mockReset();
  });

  it('maps warehouse entries from /warehouses/list', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        entries: [
          { code: 'il', name: 'Wauconda Illinois', boxIdPrefix: '' },
          { code: 'TX', name: 'Texas', boxIdPrefix: 't' }
        ]
      },
      warnings: []
    });

    const result = await listWarehouses();

    expect(result).toEqual([
      { code: 'IL', name: 'Wauconda Illinois', boxIdPrefix: '' },
      { code: 'TX', name: 'Texas', boxIdPrefix: 'T' }
    ]);
    expect(requestMock).toHaveBeenCalledWith('POST', '/warehouses/list', { body: {} });
  });

  it('syncs offline snapshots for warehouses returned by /warehouses/list', async () => {
    requestMock
      .mockResolvedValueOnce({
        data: {
          entries: [
            { code: 'IL', name: 'Wauconda Illinois', boxIdPrefix: '' },
            { code: 'TX', name: 'Texas', boxIdPrefix: 'T' }
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
      .mockResolvedValueOnce({
        warehouse: 'IL',
        boxCount: 0,
        lastSyncedAt: '2026-03-13T00:00:00.000Z'
      })
      .mockResolvedValueOnce({
        warehouse: 'TX',
        boxCount: 0,
        lastSyncedAt: '2026-03-13T00:00:00.000Z'
      });

    const snapshots = await syncAllOfflineInventorySnapshots();

    expect(requestMock).toHaveBeenNthCalledWith(2, 'POST', '/boxes/search', {
      body: {
        warehouse: 'IL',
        q: undefined,
        status: undefined,
        film: undefined,
        width: undefined,
        showRetired: true
      }
    });
    expect(requestMock).toHaveBeenNthCalledWith(3, 'POST', '/boxes/search', {
      body: {
        warehouse: 'TX',
        q: undefined,
        status: undefined,
        film: undefined,
        width: undefined,
        showRetired: true
      }
    });
    expect(replaceOfflineInventoryBoxesMock).toHaveBeenNthCalledWith(1, 'IL', []);
    expect(replaceOfflineInventoryBoxesMock).toHaveBeenNthCalledWith(2, 'TX', []);
    expect(snapshots.map((entry) => entry.warehouse)).toEqual(['IL', 'TX']);
  });
});
