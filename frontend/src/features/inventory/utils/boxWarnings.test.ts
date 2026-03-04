import { describe, expect, it, vi } from 'vitest';
import type { AddBoxPayload, Box } from '../../../domain';
import {
  confirmWarnings,
  getAddOrEditWarnings,
  getCheckInWarnings,
  getCheckoutWarnings
} from './boxWarnings';

function createBox(overrides: Partial<Box> = {}): Box {
  return {
    boxId: '2',
    warehouse: 'IL',
    manufacturer: '3M',
    filmName: 'Prestige 40',
    widthIn: 36,
    initialFeet: 100,
    feetAvailable: 50,
    lotRun: '',
    status: 'IN_STOCK',
    orderDate: '2026-03-01',
    receivedDate: '2026-03-02',
    initialWeightLbs: 20,
    lastRollWeightLbs: 15,
    lastWeighedDate: '2026-03-03',
    filmKey: '3M|PRESTIGE 40',
    coreType: 'White',
    coreWeightLbs: 1,
    lfWeightLbsPerFt: 0.14,
    purchaseCost: 120,
    notes: '',
    hasEverBeenCheckedOut: true,
    lastCheckoutJob: '',
    lastCheckoutDate: '',
    zeroedDate: '',
    zeroedReason: '',
    zeroedBy: '',
    ...overrides
  };
}

describe('boxWarnings', () => {
  it('builds edit warnings for suspicious date and zero mismatches', () => {
    const payload: AddBoxPayload = {
      boxId: '2',
      manufacturer: '3M Fasara',
      filmName: 'Prestige 40',
      widthIn: 36,
      initialFeet: 100,
      feetAvailable: 0,
      lotRun: '',
      orderDate: '2026-03-03',
      receivedDate: '2026-03-02',
      initialWeightLbs: 20,
      lastRollWeightLbs: 5,
      lastWeighedDate: '2026-03-01',
      purchaseCost: 0,
      notes: ''
    };

    const warnings = getAddOrEditWarnings(payload, createBox());

    expect(warnings).toContain('Received Date is earlier than Order Date.');
    expect(warnings).toContain('Last Weighed Date is earlier than Received Date.');
    expect(warnings).toContain('Available Feet is 0 while Last Roll Weight is still above 0.');
    expect(warnings).toContain(
      'Film identity, width, or initial feet changed after weights were already established.'
    );
  });

  it('builds checkout and check-in warnings', () => {
    expect(
      getCheckoutWarnings(createBox({ lastRollWeightLbs: null, lastWeighedDate: '' }))
    ).toEqual([
      'This box does not have a current Last Roll Weight saved yet.',
      'This box does not have a Last Weighed Date saved yet.'
    ]);

    const warnings = getCheckInWarnings(createBox({ feetAvailable: 12 }), 0);
    expect(warnings).toContain('This check-in will auto-move the box into zeroed out inventory.');
  });

  it('uses browser confirmation only when warnings exist', () => {
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmSpy);

    expect(confirmWarnings([])).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();

    expect(confirmWarnings(['Example warning.'])).toBe(true);
    expect(confirmSpy).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });
});
