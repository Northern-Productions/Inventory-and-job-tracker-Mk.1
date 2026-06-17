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

import { getBoxTransferPlan, searchBoxes, suggestNextBoxId } from './client';
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

  it('preserves remote inventory rows beyond the first thousand results', async () => {
    const remoteBoxes = Array.from({ length: 1002 }, (_, index) => ({
      boxId: index === 1000 ? 'IL1-6734' : index === 1001 ? 'IL1-6942' : `IL1-${String(index + 1).padStart(4, '0')}`,
      warehouse: 'IL1',
      manufacturer: '3M',
      filmName: 'Prestige 40',
      widthIn: 60,
      initialFeet: 100,
      feetAvailable: 0,
      allocatableNowFeet: 0,
      allocationPlanningFeet: 0,
      status: 'CHECKED_OUT'
    }));
    requestReadWithFallbackMock.mockResolvedValueOnce(remoteBoxes);

    const boxes = await searchBoxes({ warehouse: 'IL1' });

    expect(boxes).toHaveLength(1002);
    expect(boxes[boxes.length - 2]?.boxId).toBe('IL1-6734');
    expect(boxes[boxes.length - 1]?.boxId).toBe('IL1-6942');
  });

  it('passes transfer-plan query params through GET /boxes/transfer/plan', async () => {
    requestReadWithFallbackMock.mockResolvedValueOnce({
      destinationBoxId: 'MS1-1234-IL1',
      available: true,
      conflictType: null,
      conflictBoxId: null
    });

    await getBoxTransferPlan({
      boxId: 'IL1-1234',
      toWarehouse: 'MS1',
      destinationBoxIdOverride: 'MS1-1234-IL1-2'
    });

    expect(requestReadWithFallbackMock).toHaveBeenCalledWith(
      '/boxes/transfer/plan',
      {
        boxId: 'IL1-1234',
        toWarehouse: 'MS1',
        destinationBoxIdOverride: 'MS1-1234-IL1-2'
      },
      {
        boxId: 'IL1-1234',
        toWarehouse: 'MS1',
        destinationBoxIdOverride: 'MS1-1234-IL1-2'
      }
    );
  });

  it('reads the next collision-safe BoxID suggestion for a warehouse', async () => {
    requestReadWithFallbackMock.mockResolvedValueOnce({
      warehouse: 'il2',
      boxId: 'il2-4'
    });

    const suggestion = await suggestNextBoxId('il2');

    expect(requestReadWithFallbackMock).toHaveBeenCalledWith(
      '/boxes/suggest-next-id',
      { warehouse: 'IL2' },
      { warehouse: 'IL2' }
    );
    expect(suggestion).toEqual({
      warehouse: 'IL2',
      boxId: 'IL2-4'
    });
  });
});
