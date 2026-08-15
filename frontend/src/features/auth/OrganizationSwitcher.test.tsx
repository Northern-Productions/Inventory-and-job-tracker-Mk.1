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

  it('shows a visible account-menu label and keeps a long current organization selected', () => {
    const longName = 'Main Safe Test Film Lock Priority 2026-04-16T22-58';
    useAuthMock.mockReturnValue(
      authWithOrganizations([
        { orgId: 'org-1', name: longName, role: 'owner', selected: true },
        { orgId: 'org-2', name: 'Second', role: 'member', selected: false }
      ])
    );

    const view = render(<OrganizationSwitcher presentation="account-menu" />);
    const selector = screen.getByRole('combobox', { name: 'Organization' }) as HTMLSelectElement;

    expect(screen.getByText('Organization')).toBeTruthy();
    expect(screen.getByRole('option', { name: `${longName} (Owner)` })).toBeTruthy();
    expect(selector.value).toBe('org-1');
    expect(view.container.querySelector('.organization-picker-menu-select')).toBeTruthy();
  });

  it('re-enables the selector after a redacted organization-switch failure', async () => {
    switchOrganizationMock.mockRejectedValueOnce(new Error('Unable to switch'));
    useAuthMock.mockReturnValue(
      authWithOrganizations([
        { orgId: 'org-1', name: 'One', role: 'owner', selected: true },
        { orgId: 'org-2', name: 'Two', role: 'member', selected: false }
      ])
    );
    render(<OrganizationSwitcher presentation="account-menu" />);

    const selector = screen.getByRole('combobox', { name: 'Organization' }) as HTMLSelectElement;
    fireEvent.change(selector, { target: { value: 'org-2' } });

    await waitFor(() => expect(selector.disabled).toBe(false));
    expect(switchOrganizationMock).toHaveBeenCalledWith('org-2');
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
