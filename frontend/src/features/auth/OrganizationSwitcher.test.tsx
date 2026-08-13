// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrganizationSwitcher } from './OrganizationSwitcher';

const switchOrganizationMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('./AuthContext', () => ({
  useAuth: () => useAuthMock()
}));

function authWithOrganizations(organizations: Array<Record<string, unknown>>, orgId = 'org-1') {
  return {
    accessContext: { orgId, organizations },
    switchOrganization: switchOrganizationMock
  };
}

describe('OrganizationSwitcher', () => {
  beforeEach(() => {
    switchOrganizationMock.mockReset();
    switchOrganizationMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it('stays hidden for a single active organization outside the selection gate', () => {
    useAuthMock.mockReturnValue(
      authWithOrganizations([{ orgId: 'org-1', name: 'One', role: 'member', selected: true }])
    );
    const view = render(<OrganizationSwitcher />);
    expect(view.container.firstChild).toBeNull();
  });

  it('shows organization names and independent roles and switches by exact selection', async () => {
    useAuthMock.mockReturnValue(
      authWithOrganizations([
        { orgId: 'org-1', name: 'One', role: 'member', selected: true },
        { orgId: 'org-2', name: 'Two', role: 'admin', selected: false }
      ])
    );
    render(<OrganizationSwitcher />);

    const selector = screen.getByRole('combobox', { name: 'Organization' });
    expect(screen.getByRole('option', { name: 'One (Member)' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Two (Admin)' })).toBeTruthy();
    fireEvent.change(selector, { target: { value: 'org-2' } });

    await waitFor(() => {
      expect(switchOrganizationMock).toHaveBeenCalledWith('org-2');
    });
    expect((selector as HTMLSelectElement).disabled).toBe(true);
  });

  it('renders an explicit choice in the unresolved organization gate', () => {
    useAuthMock.mockReturnValue(
      authWithOrganizations([
        { orgId: 'org-1', name: 'One', role: 'owner', selected: false },
        { orgId: 'org-2', name: 'Two', role: 'member', selected: false }
      ], '')
    );
    render(<OrganizationSwitcher selectionRequired />);

    const selector = screen.getByRole('combobox', { name: 'Organization' }) as HTMLSelectElement;
    expect(selector.value).toBe('');
    expect(screen.getByRole('option', { name: 'Choose an organization' })).toBeTruthy();
  });
});
