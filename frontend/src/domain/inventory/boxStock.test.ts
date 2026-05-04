import { describe, expect, it } from 'vitest';
import { getAllocatableStockFeet, getPhysicalStockFeet, getPhysicalStockFeetValue } from './boxStock';

describe('inventory stock feet helpers', () => {
  it('prefers Box Details-style roll-weight physical feet over available or allocatable feet', () => {
    const box = {
      feetAvailable: 99,
      physicalFeetAvailable: 99,
      allocatableNowFeet: 99,
      allocationPlanningFeet: 99,
      initialFeet: 100,
      lastRollWeightLbs: 24.65,
      coreWeightLbs: 1.3333,
      lfWeightLbsPerFt: 0.233167
    };

    expect(getPhysicalStockFeet(box)).toBe(100);
    expect(getPhysicalStockFeetValue(box)).toBe(100);
    expect(getAllocatableStockFeet(box)).toBe(99);
  });

  it('keeps physical and allocatable semantics separate when roll weight cannot derive physical feet', () => {
    const box = {
      feetAvailable: 75,
      physicalFeetAvailable: 80,
      allocatableNowFeet: 70,
      allocationPlanningFeet: 70
    };

    expect(getPhysicalStockFeet(box)).toBe(80);
    expect(getAllocatableStockFeet(box)).toBe(70);
  });

  it('returns null for missing physical stock so required label fields can stay blank', () => {
    expect(
      getPhysicalStockFeetValue({
        feetAvailable: Number.NaN,
        physicalFeetAvailable: null,
        initialFeet: 100,
        lastRollWeightLbs: null,
        coreWeightLbs: null,
        lfWeightLbsPerFt: null
      })
    ).toBeNull();
  });
});
