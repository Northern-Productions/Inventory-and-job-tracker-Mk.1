// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamUserEntry } from '../../../domain';
import TeamUsersPage from './TeamUsersPage';

const toastPushMock = vi.fn();
const listTeamUsersMock = vi.fn();
const inviteTeamUserMock = vi.fn();
const changeTeamUserRoleMock = vi.fn();
const disableTeamUserMock = vi.fn();
const reenableTeamUserMock = vi.fn();

vi.mock('../../../components/Toast', () => ({
  useToast: () => ({ push: toastPushMock })
}));

vi.mock('../../../api/features/accessClient', () => ({
  listTeamUsers: () => listTeamUsersMock(),
  inviteTeamUser: (payload: unknown) => inviteTeamUserMock(payload),
  changeTeamUserRole: (payload: unknown) => changeTeamUserRoleMock(payload),
  disableTeamUser: (payload: unknown) => disableTeamUserMock(payload),
  reenableTeamUser: (payload: unknown) => reenableTeamUserMock(payload)
}));

function createTeamUsers(): TeamUserEntry[] {
  return [
    {
      userId: 'owner-1',
      name: 'Owner One',
      email: 'owner@example.com',
      role: 'owner',
      status: 'active',
      createdAt: '2026-07-01T00:00:00Z',
      invitedAt: '',
      disabledAt: '',
      updatedAt: '2026-07-01T00:00:00Z'
    },
    {
      userId: 'invited-1',
      name: 'Invited User',
      email: 'invited@example.com',
      role: 'member',
      status: 'invited',
      createdAt: '2026-07-02T00:00:00Z',
      invitedAt: '2026-07-02T00:00:00Z',
      disabledAt: '',
      updatedAt: '2026-07-02T00:00:00Z'
    },
    {
      userId: 'disabled-1',
      name: 'Disabled User',
      email: 'disabled@example.com',
      role: 'admin',
      status: 'disabled',
      createdAt: '2026-07-03T00:00:00Z',
      invitedAt: '',
      disabledAt: '2026-07-04T00:00:00Z',
      updatedAt: '2026-07-04T00:00:00Z'
    }
  ];
}

function renderTeamUsersPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });

  render(
    <QueryClientProvider client={queryClient}>
      <TeamUsersPage />
    </QueryClientProvider>
  );

  return queryClient;
}

describe('TeamUsersPage', () => {
  beforeEach(() => {
    toastPushMock.mockReset();
    listTeamUsersMock.mockReset();
    inviteTeamUserMock.mockReset();
    changeTeamUserRoleMock.mockReset();
    disableTeamUserMock.mockReset();
    reenableTeamUserMock.mockReset();
    listTeamUsersMock.mockResolvedValue(createTeamUsers());
    inviteTeamUserMock.mockResolvedValue({
      userId: 'invited-new',
      name: 'New User',
      email: 'new.user@example.com',
      role: 'member',
      status: 'invited',
      createdAt: '2026-07-05T00:00:00Z',
      invitedAt: '2026-07-05T00:00:00Z',
      disabledAt: '',
      updatedAt: '2026-07-05T00:00:00Z'
    });
    changeTeamUserRoleMock.mockResolvedValue({
      ...createTeamUsers()[1],
      role: 'admin'
    });
    disableTeamUserMock.mockResolvedValue({
      ...createTeamUsers()[1],
      status: 'disabled',
      disabledAt: '2026-07-06T00:00:00Z'
    });
    reenableTeamUserMock.mockResolvedValue({
      ...createTeamUsers()[2],
      status: 'active',
      disabledAt: ''
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('lists active, invited, and disabled current-org users without hiding inactive statuses', async () => {
    renderTeamUsersPage();

    expect(await screen.findByText('Owner One')).toBeTruthy();
    expect(screen.getByText('Invited User')).toBeTruthy();
    expect(screen.getByText('Disabled User')).toBeTruthy();

    const table = screen.getByRole('table');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((header) => header.textContent);

    expect(headers).toEqual(['User', 'Status', 'Role', 'Invited', 'Disabled', 'Actions']);
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getAllByText('Invited').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Disabled').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('button', { name: 'Re-enable' })).toBeTruthy();
  });

  it('validates invite form input before calling the invite mutation', async () => {
    renderTeamUsersPage();
    await screen.findByText('Owner One');

    fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));

    expect(inviteTeamUserMock).not.toHaveBeenCalled();
    expect(screen.getByText('A valid email is required.')).toBeTruthy();
  });

  it('normalizes and submits safe invite payloads without accepting an org id from the UI', async () => {
    renderTeamUsersPage();
    await screen.findByText('Owner One');

    fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), {
      target: { value: ' New.User@Example.COM ' }
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Display Name' }), {
      target: { value: ' New User ' }
    });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));

    await waitFor(() => {
      expect(inviteTeamUserMock).toHaveBeenCalledWith({
        email: 'new.user@example.com',
        name: 'New User',
        role: 'admin'
      });
    });
    expect(toastPushMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Invite sent',
        variant: 'success'
      })
    );
  });

  it('saves role changes and keeps unchanged role rows disabled', async () => {
    renderTeamUsersPage();
    await screen.findByText('Invited User');

    const invitedRole = screen.getByLabelText('Role for invited@example.com') as HTMLSelectElement;
    fireEvent.change(invitedRole, { target: { value: 'admin' } });
    const row = invitedRole.closest('tr') as HTMLTableRowElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Save Role' }));

    await waitFor(() => {
      expect(changeTeamUserRoleMock).toHaveBeenCalledWith({
        userId: 'invited-1',
        role: 'admin'
      });
    });
    expect(window.confirm).toHaveBeenCalledWith('Change invited@example.com to Admin?');
  });

  it('routes disable and re-enable actions through owner-only team mutations', async () => {
    renderTeamUsersPage();
    await screen.findByText('Invited User');

    const invitedRow = screen.getByText('Invited User').closest('tr') as HTMLTableRowElement;
    fireEvent.click(within(invitedRow).getByRole('button', { name: 'Disable' }));

    const disabledRow = screen.getByText('Disabled User').closest('tr') as HTMLTableRowElement;
    fireEvent.click(within(disabledRow).getByRole('button', { name: 'Re-enable' }));

    await waitFor(() => {
      expect(disableTeamUserMock).toHaveBeenCalledWith({ userId: 'invited-1' });
      expect(reenableTeamUserMock).toHaveBeenCalledWith({ userId: 'disabled-1' });
    });
  });

  it('shows invite-restored feedback when re-enabling an unaccepted invite', async () => {
    reenableTeamUserMock.mockResolvedValueOnce({
      ...createTeamUsers()[2],
      status: 'invited',
      disabledAt: ''
    });
    renderTeamUsersPage();
    await screen.findByText('Disabled User');

    const disabledRow = screen.getByText('Disabled User').closest('tr') as HTMLTableRowElement;
    fireEvent.click(within(disabledRow).getByRole('button', { name: 'Re-enable' }));

    await waitFor(() => {
      expect(toastPushMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Invite restored',
          description: expect.stringContaining('must accept the invite')
        })
      );
    });
  });
});
