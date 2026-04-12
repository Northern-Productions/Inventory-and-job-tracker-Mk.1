import { describe, expect, it } from 'vitest';
import type { Box, JobRequirementLine } from '../../../domain';
import { findCompatibleRequirementsForBox, findMatchingBoxesForRequirement } from './jobAllocationMatching';

function buildBox(overrides: Partial<Box> & Pick<Box, 'boxId' | 'manufacturer' | 'filmName' | 'widthIn'>): Box {
  return {
    boxId: overrides.boxId,
    warehouse: overrides.warehouse || 'IL1',
    manufacturer: overrides.manufacturer,
    filmName: overrides.filmName,
    widthIn: overrides.widthIn,
    initialFeet: overrides.initialFeet ?? 100,
    feetAvailable: overrides.feetAvailable ?? 100,
    allocationPlanningFeet: overrides.allocationPlanningFeet ?? overrides.feetAvailable ?? 100,
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
    pricePerLf: overrides.pricePerLf ?? null,
    purchaseCost: overrides.purchaseCost ?? null,
    notes: overrides.notes || '',
    hasEverBeenCheckedOut: overrides.hasEverBeenCheckedOut ?? false,
    lastCheckoutJob: overrides.lastCheckoutJob || '',
    lastCheckoutDate: overrides.lastCheckoutDate || '',
    zeroedDate: overrides.zeroedDate || '',
    zeroedReason: overrides.zeroedReason || '',
    zeroedBy: overrides.zeroedBy || '',
    pendingTransfer: overrides.pendingTransfer ?? null
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
  it('matches eligible in-stock and ordered boxes, using planning feet and preferring in-stock first', () => {
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
          status: 'ORDERED',
          feetAvailable: 0,
          allocationPlanningFeet: 55
        })
      ],
      requirement
    );

    expect(matching.map((box) => box.boxId)).toEqual(['IL1-60-A', 'IL1-72-A', 'IL1-60-C']);
  });

  it('includes matching-destination transfer boxes between in-stock and ordered candidates', () => {
    const requirement = buildRequirement({ manufacturer: 'SOLYX', filmName: 'Whiteout SXWF-WO', widthIn: 72 });
    const matching = findMatchingBoxesForRequirement(
      [
        buildBox({
          boxId: 'MS1-IN-STOCK',
          warehouse: 'MS1',
          manufacturer: 'SOLYX',
          filmName: 'Whiteout SXWF-WO',
          widthIn: 72,
          status: 'IN_STOCK',
          feetAvailable: 40,
          allocationPlanningFeet: 40
        }),
        buildBox({
          boxId: 'IL1-TRANSFER',
          warehouse: 'IL1',
          manufacturer: 'SOLYX',
          filmName: 'Whiteout SXWF-WO',
          widthIn: 72,
          status: 'TRANSFER',
          feetAvailable: 96,
          allocationPlanningFeet: 96,
          pendingTransfer: {
            transferId: 'TRF-1',
            status: 'PENDING',
            sourceWarehouse: 'IL1',
            destinationWarehouse: 'MS1'
          }
        }),
        buildBox({
          boxId: 'MS1-ORDERED',
          warehouse: 'MS1',
          manufacturer: 'SOLYX',
          filmName: 'Whiteout SXWF-WO',
          widthIn: 72,
          status: 'ORDERED',
          feetAvailable: 0,
          allocationPlanningFeet: 120
        })
      ],
      requirement,
      'MS1'
    );

    expect(matching.map((box) => box.boxId)).toEqual(['MS1-IN-STOCK', 'IL1-TRANSFER', 'MS1-ORDERED']);
  });

  it('excludes transfer boxes without a matching destination warehouse', () => {
    const requirement = buildRequirement({ manufacturer: 'SOLYX', filmName: 'Whiteout SXWF-WO', widthIn: 72 });
    const matching = findMatchingBoxesForRequirement(
      [
        buildBox({
          boxId: 'IL1-TRANSFER-WRONG',
          warehouse: 'IL1',
          manufacturer: 'SOLYX',
          filmName: 'Whiteout SXWF-WO',
          widthIn: 72,
          status: 'TRANSFER',
          feetAvailable: 96,
          allocationPlanningFeet: 96,
          pendingTransfer: {
            transferId: 'TRF-2',
            status: 'PENDING',
            sourceWarehouse: 'IL1',
            destinationWarehouse: 'TX1'
          }
        }),
        buildBox({
          boxId: 'IL1-TRANSFER-MISSING',
          warehouse: 'IL1',
          manufacturer: 'SOLYX',
          filmName: 'Whiteout SXWF-WO',
          widthIn: 72,
          status: 'TRANSFER',
          feetAvailable: 96,
          allocationPlanningFeet: 96
        })
      ],
      requirement,
      'MS1'
    );

    expect(matching).toHaveLength(0);
  });

  it('treats legacy manufacturer aliases as equivalent for matching', () => {
    const requirement = buildRequirement({ manufacturer: '3M', filmName: 'Prestige 40', widthIn: 60 });
    const matching = findMatchingBoxesForRequirement(
      [buildBox({ boxId: 'IL1-3M', manufacturer: '3M Solar', filmName: 'Prestige 40', widthIn: 60 })],
      requirement
    );

    expect(matching.map((box) => box.boxId)).toEqual(['IL1-3M']);
  });

  it('treats Night Vision family variants as the same planning film', () => {
    const requirement = buildRequirement({
      manufacturer: '3M Solar',
      filmName: 'Night Vision 15',
      widthIn: 36
    });
    const matching = findMatchingBoxesForRequirement(
      [
        buildBox({
          boxId: 'IL1-NV15',
          manufacturer: '3M Solar',
          filmName: 'Night Vision 15 (NV15)',
          widthIn: 36
        }),
        buildBox({
          boxId: 'IL1-SNV25',
          manufacturer: '3M Solar',
          filmName: 'Ultra SNV25',
          widthIn: 36
        })
      ],
      requirement
    );

    expect(matching.map((box) => box.boxId)).toEqual(['IL1-NV15']);
  });

  it('includes shorthand RN07-family variants and keeps exact or base matches ahead of descriptive ones', () => {
    const requirement = buildRequirement({
      manufacturer: 'Llumar',
      filmName: 'RN 07',
      widthIn: 48
    });
    const matching = findMatchingBoxesForRequirement(
      [
        buildBox({
          boxId: 'IL1-REFL',
          manufacturer: 'Llumar',
          filmName: 'RN 07 Refl. One Way Mirror',
          widthIn: 48,
          receivedDate: '2026-01-01'
        }),
        buildBox({
          boxId: 'IL1-LEGACY',
          manufacturer: 'Llumar',
          filmName: 'Llumar RN07',
          widthIn: 48,
          receivedDate: '2026-01-03'
        }),
        buildBox({
          boxId: 'IL1-BASE',
          manufacturer: 'Llumar',
          filmName: 'RN07',
          widthIn: 48,
          receivedDate: '2026-01-02'
        }),
        buildBox({
          boxId: 'IL1-OTHER-MAKER',
          manufacturer: 'SOLYX',
          filmName: 'RN07',
          widthIn: 48,
          receivedDate: '2026-01-01'
        })
      ],
      requirement
    );

    expect(matching.map((box) => box.boxId)).toEqual(['IL1-BASE', 'IL1-LEGACY', 'IL1-REFL']);
  });

  it('includes both interior and exterior boxes for non-exterior requirements and prefers interior first', () => {
    const requirement = buildRequirement({
      manufacturer: '3M Solar',
      filmName: 'Prestige 60',
      widthIn: 60
    });
    const matching = findMatchingBoxesForRequirement(
      [
        buildBox({
          boxId: 'IL1-EXT',
          manufacturer: '3M Solar',
          filmName: 'Prestige 60 Exterior',
          widthIn: 60,
          receivedDate: '2026-01-01'
        }),
        buildBox({
          boxId: 'IL1-INT',
          manufacturer: '3M Solar',
          filmName: 'Prestige 60',
          widthIn: 60,
          receivedDate: '2026-02-01'
        })
      ],
      requirement
    );

    expect(matching.map((box) => box.boxId)).toEqual(['IL1-INT', 'IL1-EXT']);
  });

  it('keeps exterior requirements limited to exterior-compatible boxes', () => {
    const requirement = buildRequirement({
      manufacturer: '3M Solar',
      filmName: 'Prestige 60 Exterior',
      widthIn: 60
    });
    const matching = findMatchingBoxesForRequirement(
      [
        buildBox({
          boxId: 'IL1-INT',
          manufacturer: '3M Solar',
          filmName: 'Prestige 60',
          widthIn: 60
        }),
        buildBox({
          boxId: 'IL1-EXT',
          manufacturer: '3M Solar',
          filmName: 'Prestige 60 Exterior',
          widthIn: 60
        })
      ],
      requirement
    );

    expect(matching.map((box) => box.boxId)).toEqual(['IL1-EXT']);
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

  it('keeps exact 36 first, then 72 split stock, then other wider fallback widths for 36-inch requirements', () => {
    const requirement = buildRequirement({ widthIn: 36 });
    const matching = findMatchingBoxesForRequirement(
      [
        buildBox({
          boxId: 'IL1-60-A',
          manufacturer: 'Madico',
          filmName: 'Graffiti Free 6MIL',
          widthIn: 60
        }),
        buildBox({
          boxId: 'IL1-72-A',
          manufacturer: 'Madico',
          filmName: 'Graffiti Free 6MIL',
          widthIn: 72
        }),
        buildBox({
          boxId: 'IL1-36-A',
          manufacturer: 'Madico',
          filmName: 'Graffiti Free 6MIL',
          widthIn: 36
        }),
        buildBox({
          boxId: 'IL1-48-A',
          manufacturer: 'Madico',
          filmName: 'Graffiti Free 6MIL',
          widthIn: 48
        })
      ],
      requirement
    );

    expect(matching.map((box) => box.boxId)).toEqual(['IL1-36-A', 'IL1-72-A', 'IL1-48-A', 'IL1-60-A']);
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

describe('findCompatibleRequirementsForBox', () => {
  it('returns unmet requirement lines for the same film when the box width meets or exceeds the requirement', () => {
    const compatible = findCompatibleRequirementsForBox(
      [
        buildRequirement({
          requirementId: 'req-50',
          manufacturer: '3M Solar',
          filmName: 'Affinity 15',
          widthIn: 50,
          requiredFeet: 2,
          allocatedFeet: 0,
          remainingFeet: 2
        }),
        buildRequirement({
          requirementId: 'req-72',
          manufacturer: '3M Solar',
          filmName: 'Affinity 15',
          widthIn: 72,
          requiredFeet: 12,
          allocatedFeet: 0,
          remainingFeet: 12
        }),
        buildRequirement({
          requirementId: 'req-other-film',
          manufacturer: '3M Solar',
          filmName: 'Night Vision 15',
          widthIn: 50,
          requiredFeet: 4,
          allocatedFeet: 0,
          remainingFeet: 4
        }),
        buildRequirement({
          requirementId: 'req-complete',
          manufacturer: '3M Solar',
          filmName: 'Affinity 15',
          widthIn: 36,
          requiredFeet: 8,
          allocatedFeet: 8,
          remainingFeet: 0
        })
      ],
      buildBox({
        boxId: 'IL1-6502',
        manufacturer: '3M Solar',
        filmName: 'Affinity 15',
        widthIn: 72
      })
    );

    expect(compatible.map((entry) => entry.requirementId)).toEqual(['req-50', 'req-72']);
  });

  it('keeps only requirement lines that the box can physically cover', () => {
    const compatible = findCompatibleRequirementsForBox(
      [
        buildRequirement({
          requirementId: 'req-36',
          manufacturer: '3M Fasara',
          filmName: 'Milano Milky White SH2MAML',
          widthIn: 36,
          requiredFeet: 10,
          allocatedFeet: 0,
          remainingFeet: 10
        }),
        buildRequirement({
          requirementId: 'req-72',
          manufacturer: '3M Fasara',
          filmName: 'Milano Milky White SH2MAML',
          widthIn: 72,
          requiredFeet: 10,
          allocatedFeet: 0,
          remainingFeet: 10
        })
      ],
      buildBox({
        boxId: 'IL1-6076',
        manufacturer: '3M Fasara',
        filmName: 'Milano Milky White SH2MAML',
        widthIn: 60
      })
    );

    expect(compatible.map((entry) => entry.requirementId)).toEqual(['req-36']);
  });

  it('lets exterior boxes satisfy both exterior and non-exterior requirement lines in the same family', () => {
    const compatible = findCompatibleRequirementsForBox(
      [
        buildRequirement({
          requirementId: 'req-int',
          manufacturer: '3M Solar',
          filmName: 'Prestige 60',
          widthIn: 60,
          remainingFeet: 20
        }),
        buildRequirement({
          requirementId: 'req-ext',
          manufacturer: '3M Solar',
          filmName: 'Prestige 60 Exterior',
          widthIn: 60,
          remainingFeet: 20
        })
      ],
      buildBox({
        boxId: 'IL1-EXT',
        manufacturer: '3M Solar',
        filmName: 'Prestige 60 Exterior',
        widthIn: 60
      })
    );

    expect(compatible.map((entry) => entry.requirementId)).toEqual(['req-int', 'req-ext']);
  });

  it('keeps interior boxes from satisfying exterior requirements', () => {
    const compatible = findCompatibleRequirementsForBox(
      [
        buildRequirement({
          requirementId: 'req-int',
          manufacturer: '3M Solar',
          filmName: 'Prestige 60',
          widthIn: 60,
          remainingFeet: 20
        }),
        buildRequirement({
          requirementId: 'req-ext',
          manufacturer: '3M Solar',
          filmName: 'Prestige 60 Exterior',
          widthIn: 60,
          remainingFeet: 20
        })
      ],
      buildBox({
        boxId: 'IL1-INT',
        manufacturer: '3M Solar',
        filmName: 'Prestige 60',
        widthIn: 60
      })
    );

    expect(compatible.map((entry) => entry.requirementId)).toEqual(['req-int']);
  });
});
