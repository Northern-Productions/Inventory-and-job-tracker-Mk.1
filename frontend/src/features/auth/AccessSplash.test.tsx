// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessSplash } from './AccessSplash';

const refreshAccessContextMock = vi.fn();
const signOutMock = vi.fn();
const switchOrganizationMock = vi.fn();

vi.mock('./AuthContext', () => ({
  useAuth: () => ({
    refreshAccessContext: refreshAccessContextMock,
    signOut: signOutMock,
    switchOrganization: switchOrganizationMock,
    accessContext: {
      orgId: '',
      organizations: [
        { orgId: 'org-1', name: 'First Organization', role: 'admin', selected: false },
        { orgId: 'org-2', name: 'Second Organization', role: 'member', selected: false }
      ]
    }
  })
}));

vi.mock('./UsernameChangeControl', () => ({
  UsernameChangeControl: () => <button type="button">Username</button>
}));

describe('AccessSplash', () => {
  beforeEach(() => {
    refreshAccessContextMock.mockReset();
    signOutMock.mockReset();
    switchOrganizationMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('explains the org selection required state without username-change actions', () => {
    render(<AccessSplash mode="org_selection_required" />);

    expect(screen.getByText('Organization Selection Needed')).toBeTruthy();
    expect(screen.getByText(/Choose the organization you want to open/i)).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Organization' })).toBeTruthy();
    expect(screen.queryByText('Username')).toBeNull();
    fireEvent.click(screen.getByText('Sign Out'));
    expect(signOutMock).toHaveBeenCalled();
  });

  it('explains the no-access state without implying default-org pending approval', () => {
    render(<AccessSplash mode="no_access" />);

    expect(screen.getByText('No Organization Access')).toBeTruthy();
    expect(screen.getByText(/No approved or pending organization access/i)).toBeTruthy();
    expect(screen.queryByText('Username')).toBeNull();
  });

  it('keeps existing pending access actions available', () => {
    render(<AccessSplash mode="pending" />);

    expect(screen.getByText('Account Pending Approval')).toBeTruthy();
    expect(screen.getByText('Username')).toBeTruthy();
    fireEvent.click(screen.getByText('Refresh Status'));
    expect(refreshAccessContextMock).toHaveBeenCalled();
  });
});
