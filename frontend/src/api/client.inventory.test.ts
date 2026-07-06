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
  getClientOfflineInventoryScope: vi.fn(),
  requestReadWithFallback: vi.fn()
}));

import { getBox, getBoxTransferPlan, searchBoxes, suggestNextBoxId } from './client';
import { APIError } from './http';
import { getOfflineBox, searchOfflineBoxes, upsertOfflineInventoryBox } from '../lib/offlineInventory';
import { getClientOfflineInventoryScope, requestReadWithFallback } from './features/sharedClient';

const requestReadWithFallbackMock = vi.mocked(requestReadWithFallback);
const getClientOfflineInventoryScopeMock = vi.mocked(getClientOfflineInventoryScope);
const searchOfflineBoxesMock = vi.mocked(searchOfflineBoxes);
const getOfflineBoxMock = vi.mocked(getOfflineBox);
const upsertOfflineInventoryBoxMock = vi.mocked(upsertOfflineInventoryBox);
const offlineScope = { userId: 'user-a', orgId: 'org-a' };

function buildBox(overrides: Record<string, unknown> = {}) {
  return {
    boxId: 'IL1-1001',
    warehouse: 'IL1',
    manufacturer: '3M',
    filmName: 'Prestige 40',
    widthIn: 36,
    initialFeet: 100,
    feetAvailable: 100,
    allocationPlanningFeet: 100,
    lotRun: '',
    status: 'IN_STOCK',
    orderDate: '2026-03-01',
    receivedDate: '2026-03-02',
    initialWeightLbs: null,
    lastRollWeightLbs: null,
    lastWeighedDate: '',
    filmKey: '3M|PRESTIGE 40',
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
    ...overrides
  };
}

describe('inventory API client', () => {
  beforeEach(() => {
    requestReadWithFallbackMock.mockReset();
    getClientOfflineInventoryScopeMock.mockReset();
    searchOfflineBoxesMock.mockReset();
    getOfflineBoxMock.mockReset();
    upsertOfflineInventoryBoxMock.mockReset();
    getClientOfflineInventoryScopeMock.mockReturnValue(offlineScope);
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

  it('normalizes checked-out search boxes to use unclaimed LF as planning capacity while preserving physical LF', async () => {
    requestReadWithFallbackMock.mockResolvedValueOnce([
      {
        boxId: 'IL1-7056',
        warehouse: 'IL1',
        manufacturer: '3M',
        filmName: 'S140',
        widthIn: 60,
        initialFeet: 100,
        feetAvailable: 42,
        physicalFeetAvailable: 71,
        allocatedWithInstallDateFeet: 15,
        allocatedWithoutInstallDateFeet: 14,
        allocatableNowFeet: 42,
        allocationPlanningFeet: null,
        status: 'CHECKED_OUT'
      }
    ]);

    const boxes = await searchBoxes({ warehouse: 'IL1' });

    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({
      boxId: 'IL1-7056',
      status: 'CHECKED_OUT',
      feetAvailable: 42,
      physicalFeetAvailable: 71,
      allocatedWithInstallDateFeet: 15,
      allocatedWithoutInstallDateFeet: 14,
      allocatableNowFeet: 42,
      allocationPlanningFeet: 42
    });
  });

  it('falls back to checked-out physical LF minus active claims when allocatableNowFeet is absent', async () => {
    requestReadWithFallbackMock.mockResolvedValueOnce([
      {
        boxId: 'IL1-CHECKED-OUT-FALLBACK',
        warehouse: 'IL1',
        manufacturer: '3M',
        filmName: 'S140',
        widthIn: 60,
        initialFeet: 100,
        feetAvailable: 42,
        physicalFeetAvailable: 71,
        activeAllocatedFeet: 29,
        allocatedWithInstallDateFeet: 15,
        allocatedWithoutInstallDateFeet: 14,
        allocationPlanningFeet: null,
        status: 'CHECKED_OUT'
      }
    ]);

    const boxes = await searchBoxes({ warehouse: 'IL1' });

    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({
      boxId: 'IL1-CHECKED-OUT-FALLBACK',
      status: 'CHECKED_OUT',
      feetAvailable: 42,
      physicalFeetAvailable: 71,
      allocatableNowFeet: 42,
      allocationPlanningFeet: 42
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

  it('uses the current offline scope for unreachable search fallback', async () => {
    requestReadWithFallbackMock.mockRejectedValueOnce(new APIError('The API is unreachable.'));
    searchOfflineBoxesMock.mockResolvedValueOnce([buildBox({ boxId: 'IL1-OFFLINE' }) as never]);

    const boxes = await searchBoxes({ warehouse: 'IL1', q: 'offline' });

    expect(searchOfflineBoxesMock).toHaveBeenCalledWith(offlineScope, {
      warehouse: 'IL1',
      q: 'offline'
    });
    expect(boxes.map((box) => box.boxId)).toEqual(['IL1-OFFLINE']);
  });

  it('does not read unscoped offline search data when auth scope is missing', async () => {
    getClientOfflineInventoryScopeMock.mockReturnValueOnce(null);
    requestReadWithFallbackMock.mockRejectedValueOnce(new APIError('The API is unreachable.'));
    searchOfflineBoxesMock.mockResolvedValueOnce([]);

    const boxes = await searchBoxes({ warehouse: 'IL1' });

    expect(searchOfflineBoxesMock).toHaveBeenCalledWith(null, { warehouse: 'IL1' });
    expect(boxes).toEqual([]);
  });

  it('writes successful box reads to the scoped offline cache', async () => {
    requestReadWithFallbackMock.mockResolvedValueOnce(buildBox({ boxId: 'IL1-REMOTE' }));

    await getBox('IL1-REMOTE');

    expect(upsertOfflineInventoryBoxMock).toHaveBeenCalledWith(
      offlineScope,
      expect.objectContaining({ boxId: 'IL1-REMOTE' })
    );
  });

  it('uses the current offline scope for unreachable box detail fallback', async () => {
    requestReadWithFallbackMock.mockRejectedValueOnce(new APIError('The API is unreachable.'));
    getOfflineBoxMock.mockResolvedValueOnce(buildBox({ boxId: 'IL1-OFFLINE-DETAIL' }) as never);

    const box = await getBox('IL1-OFFLINE-DETAIL');

    expect(getOfflineBoxMock).toHaveBeenCalledWith(offlineScope, 'IL1-OFFLINE-DETAIL');
    expect(box.boxId).toBe('IL1-OFFLINE-DETAIL');
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
