import { describe, expect, it } from 'vitest';
import {
  deriveCaulkCheckinTotals,
  getDeleteJobBlockingMessage,
  getCaulkCheckinValidationError,
  shouldPromptForCompletedJobAfterReturns,
  summarizeReturnedMaterials
} from './jobReturnedMaterials';

function buildAllocation(overrides: Record<string, unknown> = {}) {
  const allocatedFeet = Number(overrides.allocatedFeet ?? 0);
  return {
    allocationId: 'alloc-1',
    boxId: 'IL1-100',
    warehouse: 'IL1',
    jobNumber: '000123',
    installDate: '2026-03-20',
    crewLeader: 'Crew',
    allocatedFeet,
    coveredFeet: Number(overrides.coveredFeet ?? allocatedFeet),
    status: 'ACTIVE' as const,
    allocationKind: 'REQUIREMENT' as const,
    createdAt: '',
    createdBy: '',
    resolvedAt: '',
    resolvedBy: '',
    filmOrderId: '',
    notes: '',
    manufacturer: '3M',
    filmName: 'Ultra 70',
    widthIn: 60,
    boxStatus: 'IN_STOCK' as const,
    checkedOutOnThisJob: false,
    ...overrides
  };
}

describe('jobReturnedMaterials', () => {
  it('counts checked-out film boxes and open caulk checkout cycles', () => {
    const summary = summarizeReturnedMaterials({
      allocations: [
        buildAllocation({
          allocatedFeet: 50,
          coveredFeet: 50,
          boxStatus: 'CHECKED_OUT',
          checkedOutOnThisJob: true
        }),
        buildAllocation({
          allocationId: 'alloc-2',
          boxId: 'IL1-101',
          allocatedFeet: 60,
          coveredFeet: 60,
          filmName: 'Night Vision 35'
        })
      ],
      caulkCheckouts: [
        {
          caulkCheckoutId: 'checkout-1',
          caulkAllocationId: 'caulk-1',
          productId: 'product-1',
          manufacturerId: 'manufacturer-1',
          manufacturer: 'DOW',
          productName: '790 Black',
          productCode: '790-BLK',
          tubesPerCase: 12,
          warehouse: 'IL1',
          checkoutTubes: 12,
          overageTubes: 0,
          status: 'OPEN',
          checkedOutAt: '',
          checkedOutBy: '',
          checkedInAt: '',
          checkedInBy: '',
          unusedTubes: 0,
          usedTubes: 0,
          notes: ''
        }
      ]
    });

    expect(summary.checkedOutFilmCount).toBe(1);
    expect(summary.openCaulkCheckoutCount).toBe(1);
    expect(summary.hasOutstandingMaterials).toBe(true);
  });

  it('formats delete blockers for checked-out film and open caulk checkouts', () => {
    expect(
      getDeleteJobBlockingMessage({
        allocations: [
          buildAllocation({
            allocatedFeet: 50,
            coveredFeet: 50,
            boxStatus: 'CHECKED_OUT',
            checkedOutOnThisJob: true
          })
        ],
        caulkCheckouts: [
          {
            caulkCheckoutId: 'checkout-1',
            caulkAllocationId: 'caulk-1',
            productId: 'product-1',
            manufacturerId: 'manufacturer-1',
            manufacturer: 'DOW',
            productName: '790 Black',
            productCode: '790-BLK',
            tubesPerCase: 12,
            warehouse: 'IL1',
            checkoutTubes: 12,
            overageTubes: 0,
            status: 'OPEN',
            checkedOutAt: '',
            checkedOutBy: '',
            checkedInAt: '',
            checkedInBy: '',
            unusedTubes: 0,
            usedTubes: 0,
            notes: ''
          }
        ]
      })
    ).toBe('Return 1 checked-out box and close 1 open caulk checkout before deleting this job.');

    expect(
      getDeleteJobBlockingMessage({
        allocations: [
          buildAllocation({
            allocatedFeet: 50,
            coveredFeet: 50,
            boxStatus: 'CHECKED_OUT',
            checkedOutOnThisJob: true
          })
        ],
        caulkCheckouts: []
      })
    ).toBe('Return 1 checked-out box before deleting this job.');

    expect(
      getDeleteJobBlockingMessage({
        allocations: [],
        caulkCheckouts: [
          {
            caulkCheckoutId: 'checkout-1',
            caulkAllocationId: 'caulk-1',
            productId: 'product-1',
            manufacturerId: 'manufacturer-1',
            manufacturer: 'DOW',
            productName: '790 Black',
            productCode: '790-BLK',
            tubesPerCase: 12,
            warehouse: 'IL1',
            checkoutTubes: 12,
            overageTubes: 0,
            status: 'OPEN',
            checkedOutAt: '',
            checkedOutBy: '',
            checkedInAt: '',
            checkedInBy: '',
            unusedTubes: 0,
            usedTubes: 0,
            notes: ''
          }
        ]
      })
    ).toBe('Close 1 open caulk checkout before deleting this job.');

    expect(
      getDeleteJobBlockingMessage({
        allocations: [],
        caulkCheckouts: []
      })
    ).toBe('');
  });

  it('computes caulk returned totals from loose tubes and full cases', () => {
    expect(
      deriveCaulkCheckinTotals({
        checkoutTubes: 18,
        tubesPerCase: 12,
        unusedLooseTubes: 5,
        unusedCases: 1
      })
    ).toEqual({
      totalReturnedTubes: 17,
      usedTubes: 1
    });
  });

  it('validates caulk check-in values against case size and checkout count', () => {
    expect(
      getCaulkCheckinValidationError({
        checkoutTubes: 12,
        tubesPerCase: 12,
        unusedLooseTubes: 12,
        unusedCases: 0
      })
    ).toBe('Unused loose tubes must be less than 12.');

    expect(
      getCaulkCheckinValidationError({
        checkoutTubes: 12,
        tubesPerCase: 12,
        unusedLooseTubes: 1,
        unusedCases: 1
      })
    ).toBe('Returned caulk cannot exceed checked-out tubes.');
  });

  it('prompts to complete the job only after outstanding materials clear on an active non-labor job', () => {
    expect(
      shouldPromptForCompletedJobAfterReturns({
        previousHasOutstandingMaterials: true,
        currentHasOutstandingMaterials: false,
        isLaborOnly: false,
        lifecycleStatus: 'ACTIVE'
      })
    ).toBe(true);

    expect(
      shouldPromptForCompletedJobAfterReturns({
        previousHasOutstandingMaterials: false,
        currentHasOutstandingMaterials: false,
        isLaborOnly: false,
        lifecycleStatus: 'ACTIVE'
      })
    ).toBe(false);
  });
});
