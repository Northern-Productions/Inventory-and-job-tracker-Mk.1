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

  it('normalizes transfer search boxes with pending transfer metadata and planning feet fallback', async () => {
    requestReadWithFallbackMock.mockResolvedValueOnce([
      {
        boxId: 'IL1-6773',
        warehouse: 'IL1',
        manufacturer: 'SOLYX',
        filmName: 'Whiteout SXWF-WO',
        widthIn: 72,
        initialFeet: 96,
        feetAvailable: 48,
        allocationPlanningFeet: null,
        lotRun: '',
        status: 'TRANSFER',
        orderDate: '2026-04-01',
        receivedDate: '2026-04-02',
        initialWeightLbs: null,
        lastRollWeightLbs: null,
        lastWeighedDate: '',
        filmKey: '',
        coreType: '',
        coreWeightLbs: null,
        lfWeightLbsPerFt: null,
        pricePerLf: null,
        purchaseCost: null,
        notes: '',
        hasEverBeenCheckedOut: false,
        lastCheckoutJob: '',
        lastCheckoutDate: '',
        zeroedDate: '',
        zeroedReason: '',
        zeroedBy: '',
        pendingTransfer: {
          transferId: 'TRF-1',
          status: 'pending',
          sourceWarehouse: 'il1',
          destinationWarehouse: 'ms1'
        }
      }
    ]);

    const boxes = await searchBoxes({
      warehouse: 'IL1'
    });

    expect(boxes).toHaveLength(1);
    expect(boxes[0].status).toBe('TRANSFER');
    expect(boxes[0].allocationPlanningFeet).toBe(48);
    expect(boxes[0].pendingTransfer).toEqual({
      transferId: 'TRF-1',
      status: 'PENDING',
      sourceWarehouse: 'IL1',
      destinationWarehouse: 'MS1'
    });
  });
});
