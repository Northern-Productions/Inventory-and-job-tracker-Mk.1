// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OwnerCompaniesPage from './OwnerCompaniesPage';

const toastPushMock = vi.fn();
const deactivateMutationMock = {
  mutateAsync: vi.fn(),
  isPending: false
};
const upsertMutationMock = {
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
  isError: false,
  error: null
};

vi.mock('../../../components/Toast', () => ({
  useToast: () => ({ push: toastPushMock })
}));

vi.mock('../../inventory/hooks/useInventoryQueries', () => ({
  useDeactivateOwnerCompany: () => deactivateMutationMock,
  useOwnerCompanies: () => ownerCompaniesQueryMock,
  useUpsertOwnerCompany: () => upsertMutationMock
}));

describe('OwnerCompaniesPage', () => {
  beforeEach(() => {
    toastPushMock.mockReset();
    deactivateMutationMock.mutateAsync.mockReset();
    upsertMutationMock.mutateAsync.mockReset();
    vi.spyOn(window, 'prompt').mockReturnValue('');
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('uses clean owner labels for management prompts', () => {
    render(<OwnerCompaniesPage />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Deactivate' })[0]);

    expect(window.prompt).toHaveBeenCalledWith('Deactivate MGT? Optional note:', '');
    expect(screen.queryByText('MGT - MGT')).toBeNull();
  });
});
