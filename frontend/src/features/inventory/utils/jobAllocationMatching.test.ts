import { describe, expect, it } from 'vitest';
import type { Box, JobRequirementLine } from '../../../domain';
import { findMatchingBoxesForRequirement } from './jobAllocationMatching';

function buildBox(overrides: Partial<Box> & Pick<Box, 'boxId' | 'manufacturer' | 'filmName' | 'widthIn'>): Box {
  return {
    boxId: overrides.boxId,
    warehouse: overrides.warehouse || 'IL1',
    manufacturer: overrides.manufacturer,
    filmName: overrides.filmName,
    widthIn: overrides.widthIn,
    initialFeet: overrides.initialFeet ?? 100,
    feetAvailable: overrides.feetAvailable ?? 100,
    lotRun: overrides.lotRun || '',
    status: overrides.status || 'IN_STOCK',
    orderDate: overrides.orderDate || '',
    receivedDate: overrides.receivedDate || '',
    initialWeightLbs: overrides.initialWeightLbs ?? null,
    lastRollWeightLbs: overrides.lastRollWeightLbs ?? null,
    lastWeighedDate: overrides.lastWeighedDate || '',
    filmKey: overrides.filmKey || '',
    coreType: overrides.coreType || '',
    coreWeightLbs: overrides.coreWeightLbs ?? null,
    lfWeightLbsPerFt: overrides.lfWeightLbsPerFt ?? null,
    purchaseCost: overrides.purchaseCost ?? null,
    notes: overrides.notes || '',
    hasEverBeenCheckedOut: overrides.hasEverBeenCheckedOut ?? false,
    lastCheckoutJob: overrides.lastCheckoutJob || '',
    lastCheckoutDate: overrides.lastCheckoutDate || '',
    zeroedDate: overrides.zeroedDate || '',
    zeroedReason: overrides.zeroedReason || '',
    zeroedBy: overrides.zeroedBy || ''
  };
}

function buildRequirement(overrides: Partial<JobRequirementLine> = {}): JobRequirementLine {
  return {
    requirementId: overrides.requirementId || 'REQ-1',
    manufacturer: overrides.manufacturer || 'Madico',
    filmName: overrides.filmName || 'Graffiti Free 6MIL',
    widthIn: overrides.widthIn ?? 60,
    requiredFeet: overrides.requiredFeet ?? 85,
    allocatedFeet: overrides.allocatedFeet ?? 0,
    remainingFeet: overrides.remainingFeet ?? 85
  };
}

describe('findMatchingBoxesForRequirement', () => {
  it('matches manufacturer and film name while allowing widths that meet or exceed the requirement', () => {
    const requirement = buildRequirement({ widthIn: 60 });
    const matching = findMatchingBoxesForRequirement(
      [
        buildBox({ boxId: 'IL1-60-A', manufacturer: '  Madico ', filmName: 'Graffiti   Free 6MIL', widthIn: 60 }),
        buildBox({ boxId: 'IL1-72-A', manufacturer: 'Madico', filmName: 'Graffiti Free 6MIL', widthIn: 72 }),
        buildBox({
          boxId: 'IL1-72-CHECKED',
          manufacturer: 'Madico',
          filmName: 'Graffiti Free 6MIL',
          widthIn: 72,
          status: 'CHECKED_OUT',
          feetAvailable: 12
        }),
        buildBox({ boxId: 'IL1-48-A', manufacturer: 'Madico', filmName: 'Graffiti Free 6MIL', widthIn: 48 }),
        buildBox({ boxId: 'IL1-60-B', manufacturer: 'Another', filmName: 'Graffiti Free 6MIL', widthIn: 60 }),
        buildBox({
          boxId: 'IL1-60-C',
          manufacturer: 'Madico',
          filmName: 'Graffiti Free 6MIL',
          widthIn: 60,
          status: 'ORDERED'
        })
      ],
      requirement
    );

    expect(matching.map((box) => box.boxId)).toEqual(['IL1-60-A', 'IL1-72-A', 'IL1-72-CHECKED']);
  });

  it('excludes checked-out rolls when available LF is 0', () => {
    const requirement = buildRequirement({ widthIn: 60 });
    const matching = findMatchingBoxesForRequirement(
      [
        buildBox({
          boxId: 'IL1-72-CHECKED-ZERO',
          manufacturer: 'Madico',
          filmName: 'Graffiti Free 6MIL',
          widthIn: 72,
          status: 'CHECKED_OUT',
          feetAvailable: 0
        })
      ],
      requirement
    );

    expect(matching).toHaveLength(0);
  });

  it('prioritizes the closest compatible width before wider alternatives', () => {
    const requirement = buildRequirement({ widthIn: 60 });
    const matching = findMatchingBoxesForRequirement(
      [
        buildBox({
          boxId: 'IL1-72-A',
          manufacturer: 'Madico',
          filmName: 'Graffiti Free 6MIL',
          widthIn: 72,
          receivedDate: '2026-01-01'
        }),
        buildBox({
          boxId: 'IL1-60-NEW',
          manufacturer: 'Madico',
          filmName: 'Graffiti Free 6MIL',
          widthIn: 60,
          receivedDate: '2026-02-01'
        }),
        buildBox({
          boxId: 'IL1-60-OLD',
          manufacturer: 'Madico',
          filmName: 'Graffiti Free 6MIL',
          widthIn: 60,
          receivedDate: '2026-01-15'
        })
      ],
      requirement
    );

    expect(matching.map((box) => box.boxId)).toEqual(['IL1-60-OLD', 'IL1-60-NEW', 'IL1-72-A']);
  });

  it('dedupes repeated box ids by keeping the highest available feet snapshot', () => {
    const requirement = buildRequirement({ widthIn: 60 });
    const matching = findMatchingBoxesForRequirement(
      [
        buildBox({
          boxId: 'IL1-60-A',
          manufacturer: 'Madico',
          filmName: 'Graffiti Free 6MIL',
          widthIn: 60,
          feetAvailable: 10
        }),
        buildBox({
          boxId: 'IL1-60-A',
          manufacturer: 'Madico',
          filmName: 'Graffiti Free 6MIL',
          widthIn: 60,
          feetAvailable: 25
        })
      ],
      requirement
    );

    expect(matching).toHaveLength(1);
    expect(matching[0].boxId).toBe('IL1-60-A');
    expect(matching[0].feetAvailable).toBe(25);
  });

  it('covers 85 LF using two 60-inch rolls first, then a wider 72-inch roll for the remainder', () => {
    const requirement = buildRequirement({ widthIn: 60, requiredFeet: 85, remainingFeet: 85 });
    const matching = findMatchingBoxesForRequirement(
      [
        buildBox({
          boxId: 'IL1-60-A',
          manufacturer: 'Madico',
          filmName: 'Graffiti Free 6MIL',
          widthIn: 60,
          feetAvailable: 25,
          receivedDate: '2026-01-10'
        }),
        buildBox({
          boxId: 'IL1-60-B',
          manufacturer: 'Madico',
          filmName: 'Graffiti Free 6MIL',
          widthIn: 60,
          feetAvailable: 25,
          receivedDate: '2026-01-11'
        }),
        buildBox({
          boxId: 'IL1-72-A',
          manufacturer: 'Madico',
          filmName: 'Graffiti Free 6MIL',
          widthIn: 72,
          feetAvailable: 80,
          receivedDate: '2026-01-01'
        })
      ],
      requirement
    );

    expect(matching.map((box) => box.boxId)).toEqual(['IL1-60-A', 'IL1-60-B', 'IL1-72-A']);

    let remaining = 85;
    const plannedAllocations = matching.map((box) => {
      const allocatedFeet = Math.min(box.feetAvailable, remaining);
      remaining -= allocatedFeet;
      return {
        boxId: box.boxId,
        allocatedFeet
      };
    });

    expect(plannedAllocations).toEqual([
      { boxId: 'IL1-60-A', allocatedFeet: 25 },
      { boxId: 'IL1-60-B', allocatedFeet: 25 },
      { boxId: 'IL1-72-A', allocatedFeet: 35 }
    ]);
    expect(remaining).toBe(0);
  });
});
