import { describe, expect, it } from 'vitest';
import {
  MANUFACTURER_OPTIONS,
  canonicalizeManufacturerLabel,
  createDraftFromBox,
  deriveCoreWeightLbs,
  deriveFeetAvailableFromRollWeight,
  deriveFilmKey,
  deriveInitialWeightLbs,
  deriveLfWeightLbsPerFt,
  deriveRemainingFeetFromWeight,
  deriveSqFtWeightLbsPerSqFt,
  getActiveAllocatedFeet,
  getDisplayedAllocatedFeetForBox,
  getManufacturerOptionsWithCatalog,
  getNextBoxIdForWarehouse,
  getRemainingAllocatableFeet,
  getRiskyFieldChanges,
  isLowStockBox,
  isLowStockFeetValue,
  normalizeTrailingLetterBoxId,
  shouldAutoMoveToZeroed
} from './boxHelpers';

describe('boxHelpers', () => {
  it('canonicalizes legacy manufacturer aliases while preserving 3M Fasara', () => {
    expect(canonicalizeManufacturerLabel('3M')).toBe('3M Solar');
    expect(canonicalizeManufacturerLabel('Fasara')).toBe('3M Fasara');
    expect(canonicalizeManufacturerLabel('Avery')).toBe('Avery Dennison');
    expect(canonicalizeManufacturerLabel('Solar Guard')).toBe('Solar Gard');
    expect(canonicalizeManufacturerLabel('3M Fasara')).toBe('3M Fasara');
  });

  it('builds film keys in uppercase', () => {
    expect(deriveFilmKey('SunTek', 'Carbon 35')).toBe('SUNTEK|CARBON 35');
  });

  it('identifies risky inventory edits', () => {
    const risky = getRiskyFieldChanges(
      {
        boxId: 'IL1-1',
        warehouse: 'IL1',
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
        boxId: 'IL1-1',
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

    expect(risky).toEqual(['Linear Feet', 'Width']);
  });

  it('builds the next suggested box id per warehouse', () => {
    expect(
      getNextBoxIdForWarehouse(
        [
          {
            boxId: 'IL1-009',
            warehouse: 'IL1',
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
        'IL1'
      )
    ).toBe('IL1-010');

    expect(getNextBoxIdForWarehouse([], 'MS1')).toBe('MS1-1');
    expect(
      getNextBoxIdForWarehouse(
        [
          {
            boxId: 'CA1-009',
            warehouse: 'CA1',
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
        'CA1',
        'CA1'
      )
    ).toBe('CA1-010');
    expect(getNextBoxIdForWarehouse([], 'CA1', 'CA1')).toBe('CA1-1');
  });

  it('normalizes trailing-letter box ids to numeric canonical ids', () => {
    expect(normalizeTrailingLetterBoxId('IL1-3194A')).toBe('IL1-3194');
    expect(normalizeTrailingLetterBoxId('ms1-214b')).toBe('MS1-214');
    expect(normalizeTrailingLetterBoxId('CA1-1002')).toBe('CA1-1002');
    expect(normalizeTrailingLetterBoxId('IL1-ABC')).toBe('IL1-ABC');
  });

  it('merges hardcoded manufacturer options with film catalog manufacturers', () => {
    const options = getManufacturerOptionsWithCatalog([
      { filmKey: 'MADICO|GRAFFITI FREE', manufacturer: 'Madico', filmName: 'Graffiti Free', updatedAt: '' },
      { filmKey: '3M|S80', manufacturer: '3M', filmName: 'S80', updatedAt: '' },
      { filmKey: 'MADICO|GRAFFITI FREE 2', manufacturer: '  madico  ', filmName: 'Graffiti Free 2', updatedAt: '' }
    ]);

    expect(options.slice(0, MANUFACTURER_OPTIONS.length)).toEqual([...MANUFACTURER_OPTIONS]);
    expect(options).toContain('Madico');
    expect(options.filter((entry) => entry.toLowerCase() === 'madico')).toHaveLength(1);
  });

  it('normalizes loaded dates for edit-form date inputs', () => {
    const orderedAt = new Date(2026, 1, 28).toString();

    const draft = createDraftFromBox({
      boxId: 'IL1-2',
      warehouse: 'IL1',
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
      warehouse: 'IL1',
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
    const coreWeight = deriveCoreWeightLbs('Red plastic', 48);
    const lfWeight = deriveLfWeightLbsPerFt(0.0625, 48);
    const initialWeight = deriveInitialWeightLbs(lfWeight, 150, coreWeight);
    const sqFtWeight = deriveSqFtWeightLbsPerSqFt(initialWeight, coreWeight, 48, 150);

    expect(coreWeight).toBeCloseTo(1.2333, 4);
    expect(lfWeight).toBe(0.25);
    expect(initialWeight).toBeCloseTo(38.73, 2);
    expect(sqFtWeight).toBeCloseTo(0.0625, 4);
  });

  it('derives Cardboard 3/4" as 3x Cardboard 1/8" at the same width', () => {
    const cardboardWeight = deriveCoreWeightLbs('Cardboard 1/8"', 72);
    const thickCardboardWeight = deriveCoreWeightLbs('Cardboard 3/4"', 72);

    expect(thickCardboardWeight).toBeCloseTo(cardboardWeight * 3, 4);
    expect(thickCardboardWeight).toBe(6.15);
  });

  it('derives SECURITY 1/4" Cardboard at the 72-inch reference width', () => {
    const securityCoreWeight = deriveCoreWeightLbs('SECURITY 1/4" Cardboard', 72);

    expect(securityCoreWeight).toBe(11.6);
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
        boxId: 'IL1-1',
        warehouse: 'IL1' as const,
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
        boxId: 'IL1-1',
        warehouse: 'IL1' as const,
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
        boxId: 'IL1-1',
        warehouse: 'IL1' as const,
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

  it('shows checkout-job allocated feet on checked-out boxes (active + fulfilled only)', () => {
    const displayed = getDisplayedAllocatedFeetForBox(
      {
        status: 'CHECKED_OUT',
        lastCheckoutJob: ' 17643 '
      },
      [
        { jobNumber: '17643', status: 'ACTIVE', allocatedFeet: 25 },
        { jobNumber: '17643', status: 'FULFILLED', allocatedFeet: 10 },
        { jobNumber: '17643', status: 'CANCELLED', allocatedFeet: 8 },
        { jobNumber: '19034', status: 'ACTIVE', allocatedFeet: 12 }
      ]
    );

    expect(displayed).toBe(35);
  });

  it('falls back to active-only totals when not checked out', () => {
    const displayed = getDisplayedAllocatedFeetForBox(
      {
        status: 'IN_STOCK',
        lastCheckoutJob: '17643'
      },
      [
        { jobNumber: '17643', status: 'ACTIVE', allocatedFeet: 25 },
        { jobNumber: '17643', status: 'FULFILLED', allocatedFeet: 10 },
        { jobNumber: '19034', status: 'ACTIVE', allocatedFeet: 12 }
      ]
    );

    expect(displayed).toBe(37);
  });
});
