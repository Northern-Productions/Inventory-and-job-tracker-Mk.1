// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BulkOwnershipTransferPage from './BulkOwnershipTransferPage';

const toastPushMock = vi.fn();
const bulkTransferMutationMock = {
  mutateAsync: vi.fn(),
  isPending: false
};
const ownerCompaniesQueryMock = {
  data: [
    {
      ownerCompanyId: 'owner-mgt',
      code: 'MGT',
      displayName: 'MGT',
      lookupKey: 'mgt',
      isActive: true,
      createdAt: '2026-06-26T00:00:00Z',
      createdBy: 'tester',
      updatedAt: '2026-06-26T00:00:00Z',
      updatedBy: 'tester',
      deactivatedAt: '',
      deactivatedBy: ''
    },
    {
      ownerCompanyId: 'owner-edh',
      code: 'EDH',
      displayName: 'Example Display Name',
      lookupKey: 'edh',
      isActive: true,
      createdAt: '2026-06-26T00:00:00Z',
      createdBy: 'tester',
      updatedAt: '2026-06-26T00:00:00Z',
      updatedBy: 'tester',
      deactivatedAt: '',
      deactivatedBy: ''
    }
  ],
  isLoading: false
};

vi.mock('../../../components/Toast', () => ({
  useToast: () => ({ push: toastPushMock })
}));

vi.mock('../../inventory/hooks/useInventoryQueries', () => ({
  useBulkOwnershipTransfer: () => bulkTransferMutationMock,
  useOwnerCompanies: () => ownerCompaniesQueryMock
}));

describe('BulkOwnershipTransferPage', () => {
  beforeEach(() => {
    toastPushMock.mockReset();
    bulkTransferMutationMock.mutateAsync.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('uses clean owner labels in the dropdown and review copy', () => {
    render(<BulkOwnershipTransferPage />);

    const ownerSelect = screen.getByRole('combobox', { name: 'New Owner Company' });
    const optionLabels = within(ownerSelect)
      .getAllByRole('option')
      .map((option) => option.textContent?.trim());

    expect(optionLabels).toEqual([
      'Select owner company',
      'MGT',
      'EDH - Example Display Name'
    ]);
    expect(optionLabels).not.toContain('MGT - MGT');

    fireEvent.change(ownerSelect, { target: { value: 'owner-mgt' } });
    const filmBoxIdsInput = screen.getByText('Film Box IDs').closest('label')?.querySelector('textarea');
    expect(filmBoxIdsInput).toBeTruthy();
    fireEvent.change(filmBoxIdsInput as HTMLTextAreaElement, { target: { value: 'IL1-1001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review Transfer' }));

    expect(screen.getByText(/to MGT\./)).toBeTruthy();
    expect(screen.queryByText(/MGT - MGT/)).toBeNull();
  });
});
