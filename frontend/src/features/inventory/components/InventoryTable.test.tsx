// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Box } from '../../../domain';
import { InventoryTable } from './InventoryTable';

const useIsPhoneLayoutMock = vi.fn();

vi.mock('../../../hooks/useIsPhoneLayout', () => ({
  useIsPhoneLayout: () => useIsPhoneLayoutMock()
}));

afterEach(() => {
  cleanup();
});

function buildBox(overrides: Partial<Box> = {}): Box {
  return {
    boxId: 'IL1-2001',
    warehouse: 'IL1',
    dealer: 'Eastman Performance Films',
    manufacturer: '3M Solar',
    filmName: 'Prestige 60',
    widthIn: 60,
    initialFeet: 100,
    feetAvailable: 75,
    allocationPlanningFeet: 75,
    lotRun: '',
    status: 'IN_STOCK',
    orderDate: '2026-04-01',
    receivedDate: '2026-04-02',
    initialWeightLbs: null,
    lastRollWeightLbs: null,
    lastWeighedDate: '2026-04-03',
    filmKey: '',
    coreType: '',
    coreWeightLbs: null,
    lfWeightLbsPerFt: null,
    pricePerLf: null,
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

describe('InventoryTable', () => {
  beforeEach(() => {
    useIsPhoneLayoutMock.mockReset();
  });

  it('renders the dealer column on desktop to the right of Last Weighed', () => {
    useIsPhoneLayoutMock.mockReturnValue(false);

    render(<InventoryTable boxes={[buildBox()]} onSelect={vi.fn()} />);

    expect(
      screen.getAllByRole('columnheader').map((header) => header.textContent?.trim())
    ).toEqual([
      'BoxID',
      'Manufacturer',
      'Film',
      'Width',
      'On HandLinear Ft',
      'Available Linear Ft',
      'Status',
      'Last Weighed',
      'Dealer'
    ]);
    expect(screen.getByText('Eastman Performance Films')).toBeTruthy();
  });

  it('renders dealer on the mobile card layout', () => {
    useIsPhoneLayoutMock.mockReturnValue(true);

    render(<InventoryTable boxes={[buildBox({ dealer: 'Accent' })]} onSelect={vi.fn()} />);

    expect(screen.getByText('Dealer')).toBeTruthy();
    expect(screen.getByText('Accent')).toBeTruthy();
  });
});
