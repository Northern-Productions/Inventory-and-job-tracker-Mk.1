// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from '../../../domain';
import { formatJobDisplayLabel } from '../../../lib/jobDisplay';
import CheckoutHistoryPage from './CheckoutHistoryPage';

const navigateMock = vi.fn();
const useAuditListMock = vi.fn();

vi.mock('react-router-dom', async () => ({
  useNavigate: () => navigateMock
}));

vi.mock('../hooks/useInventoryQueries', () => ({
  useAuditList: (params: unknown) => useAuditListMock(params)
}));

vi.mock('../../../hooks/useIsPhoneLayout', () => ({
  useIsPhoneLayout: () => false
}));

function buildAuditEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    logId: 'audit-1',
    date: '2026-05-18T12:00:00Z',
    action: 'SET_STATUS',
    boxId: 'IL1-100',
    before: null,
    after: {
      boxId: 'IL1-100',
      warehouse: 'IL1',
      manufacturer: '3M',
      filmName: 'Night Vision 35',
      widthIn: 60,
      initialFeet: 100,
      feetAvailable: 50,
      allocationPlanningFeet: 0,
      lotRun: '',
      status: 'CHECKED_OUT',
      orderDate: '',
      receivedDate: '',
      initialWeightLbs: null,
      lastRollWeightLbs: null,
      lastWeighedDate: '',
      filmKey: '',
      coreType: 'White plastic',
      coreWeightLbs: null,
      lfWeightLbsPerFt: null,
      pricePerLf: null,
      purchaseCost: null,
      notes: '',
      hasEverBeenCheckedOut: true,
      lastCheckoutJobId: '',
      lastCheckoutJob: '',
      lastCheckoutDate: '',
      zeroedDate: '',
      zeroedReason: '',
      zeroedBy: ''
    },
    user: 'tester',
    notes: 'Checked out for job 4953',
    ...overrides
  };
}

describe('CheckoutHistoryPage', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    navigateMock.mockReset();
    useAuditListMock.mockReset();
  });

  it('shows a scoped formatted job label only for structured checkout entries', () => {
    useAuditListMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [
        buildAuditEntry({
          jobId: '11111111-1111-4111-8111-111111111111',
          jobNumber: '4953',
          jobWarehouse: 'IL1',
          workScope: 'Sections 4, 5',
          sections: 'Sections 4, 5',
          notes: 'Readable audit note text'
        })
      ],
      error: null,
      refetch: vi.fn()
    });

    render(<CheckoutHistoryPage />);

    expect(screen.getByText(formatJobDisplayLabel({
      jobNumber: '4953',
      warehouse: 'IL1',
      workScope: 'Sections 4, 5',
      sections: 'Sections 4, 5'
    }))).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
    expect(useAuditListMock).toHaveBeenCalledWith({ action: 'SET_STATUS' });
  });

  it('keeps legacy note-derived checkout rows compatible and unscoped', () => {
    useAuditListMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [
        buildAuditEntry({
          logId: 'legacy-1',
          notes: 'Checked out for job 16242',
          jobId: undefined,
          jobNumber: undefined,
          workScope: undefined,
          sections: undefined
        })
      ],
      error: null,
      refetch: vi.fn()
    });

    render(<CheckoutHistoryPage />);

    expect(screen.getByText('IL1-16242')).toBeTruthy();
    expect(screen.queryByText(/Sections/)).toBeNull();
    expect(screen.queryByText(/Unscoped/)).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('does not show generic SET_STATUS audit rows without structured identity or checkout note text', () => {
    useAuditListMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [
        buildAuditEntry({
          logId: 'generic-1',
          notes: 'Inventory metadata update',
          jobId: undefined,
          jobNumber: undefined
        })
      ],
      error: null,
      refetch: vi.fn()
    });

    render(<CheckoutHistoryPage />);

    expect(screen.getByText('No checkout history yet.')).toBeTruthy();
    expect(screen.queryByText('Inventory metadata update')).toBeNull();
  });
});
