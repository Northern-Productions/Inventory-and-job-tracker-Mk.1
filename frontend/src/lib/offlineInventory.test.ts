import { describe, expect, it } from 'vitest';
import type { Box } from '../domain';
import { filterOfflineBoxes } from './offlineInventory';

function createBox(overrides: Partial<Box>): Box {
  return {
    boxId: 'IL1-1001',
    warehouse: 'IL1',
    manufacturer: '3M',
    filmName: 'Prestige 40',
    widthIn: 36,
    initialFeet: 100,
    feetAvailable: 100,
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

describe('offline inventory filters', () => {
  it('matches the default inventory behavior and hides retired or zeroed boxes', () => {
    const boxes = [
      createBox({ boxId: 'IL1-1001', manufacturer: '3M' }),
      createBox({ boxId: 'IL1-1002', status: 'ZEROED' }),
      createBox({ boxId: 'IL1-1003', status: 'RETIRED' })
    ];

    const result = filterOfflineBoxes(boxes, { warehouse: 'IL1' });

    expect(result.map((box) => box.boxId)).toEqual(['IL1-1001']);
  });

  it('filters by search text, manufacturer, film, width, and explicit statuses', () => {
    const boxes = [
      createBox({ boxId: 'IL1-1001', manufacturer: '3M Fasara', filmName: 'Night Vision', widthIn: 36 }),
      createBox({ boxId: 'IL1-1002', manufacturer: 'Llumar', filmName: 'Dual Reflective', widthIn: 48 }),
      createBox({ boxId: 'IL1-1003', status: 'ZEROED', widthIn: 48 })
    ];

    expect(
      filterOfflineBoxes(boxes, {
        warehouse: 'IL1',
        manufacturer: '  llumar  ',
        q: 'llumar',
        film: 'dual',
        width: '48',
        status: 'IN_STOCK'
      }).map((box) => box.boxId)
    ).toEqual(['IL1-1002']);

    expect(
      filterOfflineBoxes(boxes, {
        warehouse: 'IL1',
        status: 'ZEROED'
      }).map((box) => box.boxId)
    ).toEqual(['IL1-1003']);
  });

  it('matches manufacturers exactly after normalizing case and whitespace', () => {
    const boxes = [
      createBox({ boxId: 'IL1-1001', manufacturer: '3M Fasara' }),
      createBox({ boxId: 'IL1-1002', manufacturer: '3M' }),
      createBox({ boxId: 'IL1-1003', manufacturer: '3M  FASARA' })
    ];

    const result = filterOfflineBoxes(boxes, {
      warehouse: 'IL1',
      manufacturer: ' 3m fasara '
    });

    expect(result.map((box) => box.boxId)).toEqual(['IL1-1001', 'IL1-1003']);
  });

  it('moves low stock boxes to the front when a film filter is used', () => {
    const boxes = [
      createBox({ boxId: 'IL1-1002', filmName: 'Ceramic 30', feetAvailable: 40 }),
      createBox({ boxId: 'IL1-1003', filmName: 'Ceramic 30', feetAvailable: 4 }),
      createBox({ boxId: 'IL1-1001', filmName: 'Ceramic 30', feetAvailable: 7 })
    ];

    const result = filterOfflineBoxes(boxes, {
      warehouse: 'IL1',
      film: 'ceramic'
    });

    expect(result.map((box) => box.boxId)).toEqual(['IL1-1003', 'IL1-1001', 'IL1-1002']);
  });

  it('keeps boxes from all warehouses when the warehouse filter is all', () => {
    const boxes = [
      createBox({ boxId: 'IL1-1001', warehouse: 'IL1' }),
      createBox({ boxId: 'MS1-2001', warehouse: 'MS1' })
    ];

    const result = filterOfflineBoxes(boxes, {
      warehouse: '',
      showRetired: true
    });

    expect(result.map((box) => box.boxId)).toEqual(['IL1-1001', 'MS1-2001']);
  });
});
