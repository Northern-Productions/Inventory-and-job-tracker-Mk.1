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
let authState = {
  isOwner: true,
  isAdmin: false,
  session: { user: { sub: 'owner-1' } }
};

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

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => authState
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
    authState = {
      isOwner: true,
      isAdmin: false,
      session: { user: { sub: 'owner-1' } }
    };
    inviteTeamUserMock.mockResolvedValue({
      outcome: 'invited_new',
      entry: {
        userId: 'invited-new',
        name: 'New User',
        email: 'new.user@example.com',
        role: 'member',
        status: 'invited',
        createdAt: '2026-07-05T00:00:00Z',
        invitedAt: '2026-07-05T00:00:00Z',
        disabledAt: '',
        updatedAt: '2026-07-05T00:00:00Z'
      }
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
      outcome: 'reenabled',
      entry: {
        ...createTeamUsers()[2],
        status: 'active',
        disabledAt: ''
      }
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

    fireEvent.click(screen.getByRole('button', { name: 'Add Team Member' }));

    expect(inviteTeamUserMock).not.toHaveBeenCalled();
    expect(screen.getByText('A valid email is required.')).toBeTruthy();
  });

  it('normalizes and submits safe invite payloads without accepting an org id from the UI', async () => {
    renderTeamUsersPage();
    await screen.findByText('Owner One');

    fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), {
      target: { value: ' New.User@Example.COM ' }
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Display Name (new accounts)' }), {
      target: { value: ' New User ' }
    });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Team Member' }));

    await waitFor(() => {
      expect(inviteTeamUserMock).toHaveBeenCalledWith({
        email: 'new.user@example.com',
        name: 'New User',
        role: 'admin'
      });
    });
    expect(toastPushMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Invitation sent',
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

  it('routes disable and confirmed re-enable actions through Team mutations', async () => {
    renderTeamUsersPage();
    await screen.findByText('Invited User');

    const invitedRow = screen.getByText('Invited User').closest('tr') as HTMLTableRowElement;
    fireEvent.click(within(invitedRow).getByRole('button', { name: 'Disable' }));

    const disabledRow = screen.getByText('Disabled User').closest('tr') as HTMLTableRowElement;
    fireEvent.click(within(disabledRow).getByRole('button', { name: 'Re-enable' }));
    expect(screen.getByRole('dialog').textContent).toContain('Enable this user again as Admin?');
    fireEvent.click(screen.getByRole('button', { name: 'Yes, Enable User' }));

    await waitFor(() => {
      expect(disableTeamUserMock).toHaveBeenCalledWith({ userId: 'invited-1' });
      expect(reenableTeamUserMock).toHaveBeenCalledWith({ userId: 'disabled-1', role: 'admin' });
    });
  });

  it('shows invite-restored feedback when re-enabling an unaccepted invite', async () => {
    reenableTeamUserMock.mockResolvedValueOnce({
      outcome: 'reenabled',
      entry: {
        ...createTeamUsers()[2],
        status: 'invited',
        disabledAt: ''
      }
    });
    renderTeamUsersPage();
    await screen.findByText('Disabled User');

    const disabledRow = screen.getByText('Disabled User').closest('tr') as HTMLTableRowElement;
    fireEvent.click(within(disabledRow).getByRole('button', { name: 'Re-enable' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, Enable User' }));

    await waitFor(() => {
      expect(toastPushMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Invite restored',
          description: expect.stringContaining('must accept the invite')
        })
      );
    });
  });

  it('allows an existing account add without an inviter-supplied display name', async () => {
    inviteTeamUserMock.mockResolvedValueOnce({
      outcome: 'added_existing',
      entry: createTeamUsers()[1]
    });
    renderTeamUsersPage();
    await screen.findByText('Owner One');

    fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), {
      target: { value: ' EXISTING@Example.com ' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add Team Member' }));

    await waitFor(() => {
      expect(inviteTeamUserMock).toHaveBeenCalledWith({
        email: 'existing@example.com',
        name: '',
        role: 'member'
      });
    });
    expect(toastPushMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'User added', variant: 'success' })
    );
  });

  it('renders invite failures without leaving an unhandled event promise', async () => {
    inviteTeamUserMock.mockRejectedValueOnce(new Error('Invitation provider unavailable.'));
    renderTeamUsersPage();
    await screen.findByText('Owner One');

    fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), {
      target: { value: 'new.user@example.com' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add Team Member' }));

    expect(await screen.findByText('Invitation provider unavailable.')).toBeTruthy();
    expect(toastPushMock).toHaveBeenCalledWith({
      title: 'Unable to add team member',
      description: 'Invitation provider unavailable.',
      variant: 'error'
    });
  });

  it('shows disabled confirmation with a role snapshot and No performs zero mutation', async () => {
    inviteTeamUserMock.mockResolvedValueOnce({
      outcome: 'disabled_confirmation_required',
      entry: createTeamUsers()[2]
    });
    renderTeamUsersPage();
    await screen.findByText('Owner One');

    fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), {
      target: { value: 'disabled@example.com' }
    });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'member' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Team Member' }));

    expect((await screen.findByRole('dialog')).textContent).toContain('Enable this user again as Member?');
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(reenableTeamUserMock).not.toHaveBeenCalled();
  });

  it('submits the role shown by the disabled confirmation even if the form changes later', async () => {
    inviteTeamUserMock.mockResolvedValueOnce({
      outcome: 'disabled_confirmation_required',
      entry: createTeamUsers()[2]
    });
    renderTeamUsersPage();
    await screen.findByText('Owner One');

    fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), {
      target: { value: 'disabled@example.com' }
    });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'member' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Team Member' }));

    expect((await screen.findByRole('dialog')).textContent).toContain('Enable this user again as Member?');
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Yes, Enable User' }));

    await waitFor(() => {
      expect(reenableTeamUserMock).toHaveBeenCalledWith({ userId: 'disabled-1', role: 'member' });
    });
  });

  it('handles a stale re-enable as an authoritative already-active no-op', async () => {
    reenableTeamUserMock.mockResolvedValueOnce({
      outcome: 'already_active',
      entry: { ...createTeamUsers()[2], status: 'active', disabledAt: '' }
    });
    renderTeamUsersPage();
    const disabledRow = (await screen.findByText('Disabled User')).closest('tr') as HTMLTableRowElement;

    fireEvent.click(within(disabledRow).getByRole('button', { name: 'Re-enable' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, Enable User' }));

    await waitFor(() => {
      expect(toastPushMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Already active', variant: 'success' })
      );
    });
  });

  it('prevents delegated Admins from assigning or editing Owner membership', async () => {
    authState = {
      isOwner: false,
      isAdmin: true,
      session: { user: { sub: 'admin-self' } }
    };
    renderTeamUsersPage();
    await screen.findByText('Owner One');

    const addRole = screen.getByLabelText('Role');
    expect(within(addRole).queryByRole('option', { name: 'Owner' })).toBeNull();
    const ownerRole = screen.getByLabelText('Role for owner@example.com') as HTMLSelectElement;
    expect(ownerRole.disabled).toBe(true);
    const ownerRow = ownerRole.closest('tr') as HTMLTableRowElement;
    expect((within(ownerRow).getByRole('button', { name: 'Disable' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
