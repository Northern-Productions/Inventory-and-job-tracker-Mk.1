import { describe, expect, it } from 'vitest';
import {
  createDraftFromBox,
  deriveCoreWeightLbs,
  deriveFeetAvailableFromRollWeight,
  deriveFilmKey,
  deriveInitialWeightLbs,
  deriveLfWeightLbsPerFt,
  deriveRemainingFeetFromWeight,
  deriveSqFtWeightLbsPerSqFt,
  getActiveAllocatedFeet,
  getNextBoxIdForWarehouse,
  getRemainingAllocatableFeet,
  getRiskyFieldChanges,
  isLowStockBox,
  isLowStockFeetValue,
  shouldAutoMoveToZeroed
} from './boxHelpers';

describe('boxHelpers', () => {
  it('builds film keys in uppercase', () => {
    expect(deriveFilmKey('SunTek', 'Carbon 35')).toBe('SUNTEK|CARBON 35');
  });

  it('identifies risky inventory edits', () => {
    const risky = getRiskyFieldChanges(
      {
        boxId: 'IL-1',
        warehouse: 'IL',
        manufacturer: 'A',
        filmName: 'B',
        widthIn: 36,
        initialFeet: 100,
        feetAvailable: 80,
        lotRun: '',
      status: 'ORDERED',
      orderDate: '2026-02-25',
      receivedDate: '2026-02-27',
      initialWeightLbs: null,
      lastRollWeightLbs: null,
        lastWeighedDate: '',
        filmKey: 'A|B',
        coreType: '',
      coreWeightLbs: null,
      lfWeightLbsPerFt: null,
      purchaseCost: null,
      notes: '',
      hasEverBeenCheckedOut: false,
      lastCheckoutJob: '',
      lastCheckoutDate: '',
      zeroedDate: '',
      zeroedReason: '',
      zeroedBy: ''
    },
      {
        boxId: 'IL-1',
        manufacturer: 'A',
        filmName: 'B',
        widthIn: 48,
        initialFeet: 120,
        feetAvailable: 70,
        lotRun: '',
        orderDate: '2026-02-25',
        receivedDate: '2026-02-27',
        initialWeightLbs: null,
        lastRollWeightLbs: null,
        lastWeighedDate: '',
        filmKey: 'A|B',
        coreType: '',
        coreWeightLbs: null,
        lfWeightLbsPerFt: null,
        purchaseCost: null,
        notes: ''
      }
    );

    expect(risky).toEqual(['Linear Feet', 'Feet Available', 'Width']);
  });

  it('builds the next suggested box id per warehouse', () => {
    expect(
      getNextBoxIdForWarehouse(
        [
          {
            boxId: 'IL-009',
            warehouse: 'IL',
            manufacturer: '',
            filmName: '',
            widthIn: 36,
            initialFeet: 0,
            feetAvailable: 0,
            lotRun: '',
            status: 'ORDERED',
            orderDate: '',
            receivedDate: '',
            initialWeightLbs: null,
            lastRollWeightLbs: null,
            lastWeighedDate: '',
            filmKey: '',
            coreType: '',
            coreWeightLbs: null,
            lfWeightLbsPerFt: null,
            purchaseCost: null,
            notes: '',
            hasEverBeenCheckedOut: false,
            lastCheckoutJob: '',
            lastCheckoutDate: '',
            zeroedDate: '',
            zeroedReason: '',
            zeroedBy: ''
          }
        ],
        'IL'
      )
    ).toBe('IL-010');

    expect(getNextBoxIdForWarehouse([], 'MS')).toBe('M1');
  });

  it('normalizes loaded dates for edit-form date inputs', () => {
    const orderedAt = new Date(2026, 1, 28).toString();

    const draft = createDraftFromBox({
      boxId: 'IL-2',
      warehouse: 'IL',
      manufacturer: 'A',
      filmName: 'B',
      widthIn: 36,
      initialFeet: 100,
      feetAvailable: 100,
      lotRun: '',
      status: 'IN_STOCK',
      orderDate: orderedAt,
      receivedDate: '',
      initialWeightLbs: null,
      lastRollWeightLbs: null,
      lastWeighedDate: orderedAt,
      filmKey: 'A|B',
      coreType: '',
      coreWeightLbs: null,
      lfWeightLbsPerFt: null,
      purchaseCost: null,
      notes: '',
      hasEverBeenCheckedOut: false,
      lastCheckoutJob: '',
      lastCheckoutDate: '',
      zeroedDate: '',
      zeroedReason: '',
      zeroedBy: ''
    });

    expect(draft.orderDate).toBe('2026-02-28');
    expect(draft.lastWeighedDate).toBe('2026-02-28');
  });

  it('keeps stored ISO dates unchanged in the edit form', () => {
    const draft = createDraftFromBox({
      boxId: '100',
      warehouse: 'IL',
      manufacturer: '3M',
      filmName: 'S800',
      widthIn: 72,
      initialFeet: 100,
      feetAvailable: 0,
      lotRun: '',
      status: 'ORDERED',
      orderDate: '2026-02-28',
      receivedDate: '2026-02-28',
      initialWeightLbs: null,
      lastRollWeightLbs: null,
      lastWeighedDate: '',
      filmKey: '3M|S800',
      coreType: '',
      coreWeightLbs: null,
      lfWeightLbsPerFt: null,
      purchaseCost: null,
      notes: '',
      hasEverBeenCheckedOut: false,
      lastCheckoutJob: '',
      lastCheckoutDate: '',
      zeroedDate: '',
      zeroedReason: '',
      zeroedBy: ''
    });

    expect(draft.orderDate).toBe('2026-02-28');
    expect(draft.receivedDate).toBe('2026-02-28');
  });

  it('derives film and core weights for any width and length', () => {
    const coreWeight = deriveCoreWeightLbs('Red', 48);
    const lfWeight = deriveLfWeightLbsPerFt(0.0625, 48);
    const initialWeight = deriveInitialWeightLbs(lfWeight, 150, coreWeight);
    const sqFtWeight = deriveSqFtWeightLbsPerSqFt(initialWeight, coreWeight, 48, 150);

    expect(coreWeight).toBeCloseTo(1.2333, 4);
    expect(lfWeight).toBe(0.25);
    expect(initialWeight).toBeCloseTo(38.73, 2);
    expect(sqFtWeight).toBeCloseTo(0.0625, 4);
  });

  it('derives remaining feet from the last roll weight', () => {
    expect(deriveRemainingFeetFromWeight(16.2333, 1.2333, 0.25)).toBeCloseTo(60, 1);
  });

  it('derives available feet for check-in by clamping to whole feet', () => {
    expect(deriveFeetAvailableFromRollWeight(16.2333, 1.2333, 0.25, 150)).toBe(60);
    expect(deriveFeetAvailableFromRollWeight(100, 1.2333, 0.25, 150)).toBe(150);
    expect(deriveFeetAvailableFromRollWeight(1, 1.2333, 0.25, 150)).toBe(0);
  });

  it('auto-moves only received boxes when feet or last roll weight hits zero', () => {
    expect(shouldAutoMoveToZeroed('2026-03-02', 25, 25, 0)).toBe(true);
    expect(shouldAutoMoveToZeroed('2026-03-02', 25, 0, 12)).toBe(true);
    expect(shouldAutoMoveToZeroed('2026-03-02', 0, 0, 0)).toBe(false);
    expect(shouldAutoMoveToZeroed('2026-03-02', 10, 10, 12)).toBe(false);
    expect(shouldAutoMoveToZeroed('', 25, 0, 0)).toBe(false);
  });

  it('flags low stock only for positive values below the threshold', () => {
    expect(isLowStockFeetValue(9)).toBe(true);
    expect(isLowStockFeetValue(10)).toBe(false);
    expect(isLowStockFeetValue(0)).toBe(false);
    expect(isLowStockBox({ status: 'IN_STOCK', feetAvailable: 4 })).toBe(true);
    expect(isLowStockBox({ status: 'CHECKED_OUT', feetAvailable: 4 })).toBe(false);
  });

  it('totals only active allocation feet and clamps remaining allocatable feet', () => {
    const allocations = [
      {
        allocationId: 'A-1',
        boxId: 'IL-1',
        warehouse: 'IL' as const,
        jobNumber: 'JOB-1',
        jobDate: '',
        allocatedFeet: 18,
        status: 'ACTIVE' as const,
        createdAt: '',
        createdBy: '',
        resolvedAt: '',
        resolvedBy: '',
        notes: ''
      },
      {
        allocationId: 'A-2',
        boxId: 'IL-1',
        warehouse: 'IL' as const,
        jobNumber: 'JOB-2',
        jobDate: '',
        allocatedFeet: 7,
        status: 'FULFILLED' as const,
        createdAt: '',
        createdBy: '',
        resolvedAt: '',
        resolvedBy: '',
        notes: ''
      },
      {
        allocationId: 'A-3',
        boxId: 'IL-1',
        warehouse: 'IL' as const,
        jobNumber: 'JOB-3',
        jobDate: '',
        allocatedFeet: 9,
        status: 'ACTIVE' as const,
        createdAt: '',
        createdBy: '',
        resolvedAt: '',
        resolvedBy: '',
        notes: ''
      }
    ];

    expect(getActiveAllocatedFeet(allocations)).toBe(27);
    expect(getRemainingAllocatableFeet(40, allocations)).toBe(40);
    expect(getRemainingAllocatableFeet(20, allocations)).toBe(20);
  });
});
