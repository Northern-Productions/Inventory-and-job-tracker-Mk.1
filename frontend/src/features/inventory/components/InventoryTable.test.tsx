// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

  it('renders reserved boxes with physical stock, zero allocatable availability, and working links', () => {
    useIsPhoneLayoutMock.mockReturnValue(false);
    const onSelect = vi.fn();

    render(
      <InventoryTable
        boxes={[
          buildBox({
            boxId: '5130',
            dealer: 'Llumar Select Pro',
            feetAvailable: 0,
            physicalFeetAvailable: 6,
            allocatableNowFeet: 0,
            allocationPlanningFeet: 0,
            initialFeet: 700
          })
        ]}
        onSelect={onSelect}
      />
    );

    const boxLink = screen.getByRole('button', { name: 'IL1-5130' });
    const row = boxLink.closest('tr');
    expect(row).toBeTruthy();
    expect(within(row as HTMLTableRowElement).getByText('6')).toBeTruthy();
    expect(within(row as HTMLTableRowElement).getByText('0')).toBeTruthy();
    expect(within(row as HTMLTableRowElement).getByText('LOW STOCK')).toBeTruthy();
    expect(within(row as HTMLTableRowElement).getByText('IN_STOCK')).toBeTruthy();
    expect(within(row as HTMLTableRowElement).getByText('Llumar Select Pro')).toBeTruthy();

    fireEvent.click(boxLink);

    expect(onSelect).toHaveBeenCalledWith('IL1-5130');
  });

  it('shows derived physical on-hand feet while keeping available feet allocatable', () => {
    useIsPhoneLayoutMock.mockReturnValue(false);

    render(
      <InventoryTable
        boxes={[
          buildBox({
            boxId: '6890',
            feetAvailable: 99,
            physicalFeetAvailable: 99,
            allocatableNowFeet: 99,
            allocationPlanningFeet: 99,
            initialFeet: 100,
            lastRollWeightLbs: 24.65,
            coreWeightLbs: 1.3333,
            lfWeightLbsPerFt: 0.233167
          })
        ]}
        onSelect={vi.fn()}
      />
    );

    const row = screen.getByRole('button', { name: 'IL1-6890' }).closest('tr');
    expect(row).toBeTruthy();
    expect(within(row as HTMLTableRowElement).getByText('100')).toBeTruthy();
    expect(within(row as HTMLTableRowElement).getByText('99')).toBeTruthy();
  });

  it('renders dealer on the mobile card layout', () => {
    useIsPhoneLayoutMock.mockReturnValue(true);

    render(<InventoryTable boxes={[buildBox({ dealer: 'Accent' })]} onSelect={vi.fn()} />);

    expect(screen.getByText('Dealer')).toBeTruthy();
    expect(screen.getByText('Accent')).toBeTruthy();
  });

  it('does not rebuild a retained mobile card when the result array narrows', () => {
    useIsPhoneLayoutMock.mockReturnValue(true);
    let filmNameReads = 0;
    const retainedBox = buildBox({ boxId: 'IL1-2001' });
    const onSelect = vi.fn();

    Object.defineProperty(retainedBox, 'filmName', {
      configurable: true,
      get() {
        filmNameReads += 1;
        return 'Prestige 60';
      }
    });

    const rendered = render(
      <InventoryTable
        boxes={[retainedBox, buildBox({ boxId: 'IL1-2002' })]}
        onSelect={onSelect}
      />
    );
    const initialReads = filmNameReads;

    rendered.rerender(
      <InventoryTable
        boxes={[retainedBox]}
        onSelect={onSelect}
      />
    );

    expect(screen.getByRole('button', { name: 'IL1-2001' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'IL1-2002' })).toBeNull();
    expect(filmNameReads).toBe(initialReads);
  });
});
