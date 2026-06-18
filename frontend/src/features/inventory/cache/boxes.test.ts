import { describe, expect, it } from 'vitest';
import type { Box } from '../../../domain';
import {
  applyPlanningAllocationToCachedBox,
  releasePlanningAllocationFromCachedBox
} from './boxes';

function buildBox(overrides: Partial<Box> = {}): Box {
  return {
    boxId: 'IL1-MAT-FLOW-1',
    warehouse: 'IL1',
    dealer: '',
    manufacturer: '3M',
    filmName: 'Solar Film',
    widthIn: 60,
    initialFeet: 100,
    feetAvailable: 100,
    allocatableNowFeet: 100,
    allocationPlanningFeet: 100,
    lotRun: '',
    status: 'IN_STOCK',
    orderDate: '',
    receivedDate: '2026-06-01',
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
    hasLabel: false,
    hasEverBeenCheckedOut: false,
    lastCheckoutJob: '',
    lastCheckoutDate: '',
    zeroedDate: '',
    zeroedReason: '',
    zeroedBy: '',
    ...overrides
  };
}

describe('box allocation cache material-flow helpers', () => {
  it('applies allocation claims without reducing physical/current LF', () => {
    const updated = applyPlanningAllocationToCachedBox(buildBox(), 40);

    expect(updated.feetAvailable).toBe(100);
    expect(updated.allocatableNowFeet).toBe(60);
    expect(updated.allocationPlanningFeet).toBe(60);
  });

  it('removes allocation claims without increasing physical/current LF', () => {
    const updated = releasePlanningAllocationFromCachedBox(
      buildBox({
        feetAvailable: 100,
        allocatableNowFeet: 60,
        allocationPlanningFeet: 60
      }),
      40
    );

    expect(updated.feetAvailable).toBe(100);
    expect(updated.allocatableNowFeet).toBe(100);
    expect(updated.allocationPlanningFeet).toBe(100);
  });
});
