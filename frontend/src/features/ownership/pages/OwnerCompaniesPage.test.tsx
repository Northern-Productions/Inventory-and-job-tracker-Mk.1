// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
function createOwnerCompanies() {
  return [
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
      displayName: 'EDH',
      lookupKey: 'edh',
      isActive: true,
      createdAt: '2026-06-26T00:00:00Z',
      createdBy: 'tester',
      updatedAt: '2026-06-26T00:00:00Z',
      updatedBy: 'tester',
      deactivatedAt: '',
      deactivatedBy: ''
    },
    {
      ownerCompanyId: 'owner-kam',
      code: 'KAM',
      displayName: 'KAM',
      lookupKey: 'kam',
      isActive: false,
      createdAt: '2026-06-26T00:00:00Z',
      createdBy: 'tester',
      updatedAt: '2026-06-26T00:00:00Z',
      updatedBy: 'tester',
      deactivatedAt: '2026-06-27T00:00:00Z',
      deactivatedBy: 'tester'
    }
  ];
}

const ownerCompaniesQueryMock = {
  data: createOwnerCompanies(),
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
    ownerCompaniesQueryMock.data = createOwnerCompanies();
    ownerCompaniesQueryMock.isError = false;
    ownerCompaniesQueryMock.error = null;
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

  it('shows one company name field and hides internal code/display-name fields', () => {
    render(<OwnerCompaniesPage />);

    expect(screen.getByRole('textbox', { name: 'Company Name' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Code' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Display Name' })).toBeNull();
  });

  it('renders the simplified companies table without internal code or updated columns', () => {
    render(<OwnerCompaniesPage />);

    const table = screen.getByRole('table');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((header) => header.textContent);

    expect(headers).toEqual(['Name', 'Status', 'Action']);
    expect(within(table).queryByRole('columnheader', { name: 'Code' })).toBeNull();
    expect(within(table).queryByRole('columnheader', { name: 'Updated' })).toBeNull();
    expect(screen.getByText('MGT')).toBeTruthy();
    expect(screen.getByText('EDH')).toBeTruthy();
    expect(screen.getByText('KAM')).toBeTruthy();
  });

  it('derives the hidden owner company code from the entered company name', async () => {
    upsertMutationMock.mutateAsync.mockResolvedValueOnce({
      ownerCompanyId: 'owner-new-company',
      code: 'NEWCOMPANY',
      displayName: 'New Company',
      lookupKey: 'newcompany',
      isActive: true
    });
    render(<OwnerCompaniesPage />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Company Name' }), {
      target: { value: ' New Company ' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Owner Company' }));

    await waitFor(() => {
      expect(upsertMutationMock.mutateAsync).toHaveBeenCalledWith({
        code: 'NEWCOMPANY',
        displayName: 'New Company'
      });
    });
    expect(toastPushMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Owner company saved',
        description: 'New Company is available for inventory ownership.'
      })
    );
  });

  it('blocks blank company names before submitting', () => {
    render(<OwnerCompaniesPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Save Owner Company' }));

    expect(upsertMutationMock.mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText('Company name is required.')).toBeTruthy();
  });

  it('blocks company names that cannot produce a safe internal code', () => {
    render(<OwnerCompaniesPage />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Company Name' }), {
      target: { value: ' !!! ' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Owner Company' }));

    expect(upsertMutationMock.mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText('Company name must include at least one letter or number.')).toBeTruthy();
  });

  it('keeps the active deactivate action wired to the owner company mutation', async () => {
    deactivateMutationMock.mutateAsync.mockResolvedValueOnce({});
    vi.mocked(window.prompt).mockReturnValueOnce('No longer active');
    render(<OwnerCompaniesPage />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Deactivate' })[1]);

    await waitFor(() => {
      expect(deactivateMutationMock.mutateAsync).toHaveBeenCalledWith({
        ownerCompanyId: 'owner-edh',
        note: 'No longer active'
      });
    });
    expect(screen.getByText('Archived')).toBeTruthy();
  });
});
