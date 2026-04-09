import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/boxIds', () => ({
  dedupeBoxesByDisplayBoxId: (boxes: unknown[]) => boxes
}));

vi.mock('../lib/offlineInventory', () => ({
  getOfflineBox: vi.fn(),
  replaceOfflineInventoryBoxes: vi.fn(),
  searchOfflineBoxes: vi.fn(),
  upsertOfflineInventoryBox: vi.fn()
}));

vi.mock('./features/sharedClient', () => ({
  assertFeatureAccess: vi.fn(),
  requestReadWithFallback: vi.fn()
}));

import { searchBoxes } from './client';
import { requestReadWithFallback } from './features/sharedClient';

const requestReadWithFallbackMock = vi.mocked(requestReadWithFallback);

describe('inventory API client', () => {
  beforeEach(() => {
    requestReadWithFallbackMock.mockReset();
  });

  it('passes repeated warehouses through GET /boxes/search', async () => {
    requestReadWithFallbackMock.mockResolvedValueOnce([]);

    await searchBoxes({
      warehouses: ['IL1', 'MS1'],
      manufacturer: 'Llumar',
      q: 'RN 07',
      showRetired: false
    });

    expect(requestReadWithFallbackMock).toHaveBeenCalledWith(
      '/boxes/search',
      {
        warehouse: undefined,
        warehouses: ['IL1', 'MS1'],
        manufacturer: 'Llumar',
        q: 'RN 07',
        status: undefined,
        film: undefined,
        width: undefined,
        showRetired: false
      },
      {
        warehouse: undefined,
        warehouses: ['IL1', 'MS1'],
        manufacturer: 'Llumar',
        q: 'RN 07',
        status: undefined,
        film: undefined,
        width: undefined,
        showRetired: false
      }
    );
  });
});
