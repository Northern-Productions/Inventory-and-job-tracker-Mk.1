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
          { code: 'il1', name: 'Wauconda Illinois #1', boxIdPrefix: 'il1' },
          { code: 'TX1', name: 'Texas #1', boxIdPrefix: 'tx1' }
        ]
      },
      warnings: []
    });

    const result = await listWarehouses();

    expect(result).toEqual([
      { code: 'IL1', name: 'Wauconda Illinois #1', boxIdPrefix: 'IL1' },
      { code: 'TX1', name: 'Texas #1', boxIdPrefix: 'TX1' }
    ]);
    expect(requestMock).toHaveBeenCalledWith('POST', '/warehouses/list', { body: {} });
  });

  it('syncs offline snapshots for warehouses returned by /warehouses/list', async () => {
    requestMock
      .mockResolvedValueOnce({
        data: {
          entries: [
            { code: 'IL1', name: 'Wauconda Illinois #1', boxIdPrefix: 'IL1' },
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
      .mockResolvedValueOnce({
        warehouse: 'IL1',
        boxCount: 0,
        lastSyncedAt: '2026-03-13T00:00:00.000Z'
      })
      .mockResolvedValueOnce({
        warehouse: 'TX1',
        boxCount: 0,
        lastSyncedAt: '2026-03-13T00:00:00.000Z'
      });

    const snapshots = await syncAllOfflineInventorySnapshots();

    expect(requestMock).toHaveBeenNthCalledWith(2, 'POST', '/boxes/search', {
      body: {
        warehouse: 'IL1',
        q: undefined,
        status: undefined,
        film: undefined,
        width: undefined,
        showRetired: true
      }
    });
    expect(requestMock).toHaveBeenNthCalledWith(3, 'POST', '/boxes/search', {
      body: {
        warehouse: 'TX1',
        q: undefined,
        status: undefined,
        film: undefined,
        width: undefined,
        showRetired: true
      }
    });
    expect(replaceOfflineInventoryBoxesMock).toHaveBeenNthCalledWith(1, 'IL1', []);
    expect(replaceOfflineInventoryBoxesMock).toHaveBeenNthCalledWith(2, 'TX1', []);
    expect(snapshots.map((entry) => entry.warehouse)).toEqual(['IL1', 'TX1']);
  });
});
