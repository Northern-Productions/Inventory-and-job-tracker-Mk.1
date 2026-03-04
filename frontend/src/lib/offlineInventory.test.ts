import { describe, expect, it } from 'vitest';
import type { Box } from '../domain';
import { filterOfflineBoxes } from './offlineInventory';

function createBox(overrides: Partial<Box>): Box {
  return {
    boxId: '1001',
    warehouse: 'IL',
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
      createBox({ boxId: '1001', manufacturer: '3M' }),
      createBox({ boxId: '1002', status: 'ZEROED' }),
      createBox({ boxId: '1003', status: 'RETIRED' })
    ];

    const result = filterOfflineBoxes(boxes, { warehouse: 'IL' });

    expect(result.map((box) => box.boxId)).toEqual(['1001']);
  });

  it('filters by search text, film, width, and explicit statuses', () => {
    const boxes = [
      createBox({ boxId: '1001', manufacturer: '3M', filmName: 'Night Vision', widthIn: 36 }),
      createBox({ boxId: '1002', manufacturer: 'Llumar', filmName: 'Dual Reflective', widthIn: 48 }),
      createBox({ boxId: '1003', status: 'ZEROED', widthIn: 48 })
    ];

    expect(
      filterOfflineBoxes(boxes, {
        warehouse: 'IL',
        q: 'llumar',
        film: 'dual',
        width: '48',
        status: 'IN_STOCK'
      }).map((box) => box.boxId)
    ).toEqual(['1002']);

    expect(
      filterOfflineBoxes(boxes, {
        warehouse: 'IL',
        status: 'ZEROED'
      }).map((box) => box.boxId)
    ).toEqual(['1003']);
  });

  it('moves low stock boxes to the front when a film filter is used', () => {
    const boxes = [
      createBox({ boxId: '1002', filmName: 'Ceramic 30', feetAvailable: 40 }),
      createBox({ boxId: '1003', filmName: 'Ceramic 30', feetAvailable: 4 }),
      createBox({ boxId: '1001', filmName: 'Ceramic 30', feetAvailable: 7 })
    ];

    const result = filterOfflineBoxes(boxes, {
      warehouse: 'IL',
      film: 'ceramic'
    });

    expect(result.map((box) => box.boxId)).toEqual(['1003', '1001', '1002']);
  });
});
