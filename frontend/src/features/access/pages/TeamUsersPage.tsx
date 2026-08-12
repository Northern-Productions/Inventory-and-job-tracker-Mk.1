import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  changeTeamUserRole,
  disableTeamUser,
  inviteTeamUser,
  listTeamUsers,
  reenableTeamUser
} from '../../../api/features/accessClient';
import { Button } from '../../../components/Button';
import { DialogSurface } from '../../../components/DialogSurface';
import { Input } from '../../../components/Input';
import { Select } from '../../../components/Select';
import { useToast } from '../../../components/Toast';
import type { Role, TeamUserEntry, TeamUserStatus } from '../../../domain';
import { useAuth } from '../../auth/AuthContext';

const TEAM_USERS_QUERY_KEY = ['owner', 'team', 'users'];
const OWNER_ROLE_OPTIONS: Array<{ label: string; value: Exclude<Role, ''> }> = [
  { label: 'Owner', value: 'owner' },
  { label: 'Admin', value: 'admin' },
  { label: 'Member', value: 'member' }
];
const ADMIN_ROLE_OPTIONS = OWNER_ROLE_OPTIONS.filter((option) => option.value !== 'owner');

interface ReenableConfirmation {
  entry: TeamUserEntry;
  role: Exclude<Role, ''>;
}

function formatStatus(status: TeamUserStatus) {
  if (status === 'invited') {
    return 'Invited';
  }
  if (status === 'disabled') {
    return 'Disabled';
  }
  return 'Active';
}

function statusBadgeClass(status: TeamUserStatus) {
  if (status === 'invited') {
    return 'badge-FILM_ON_THE_WAY';
  }
  if (status === 'disabled') {
    return 'badge-muted';
  }
  return 'badge-IN_STOCK';
}

function formatRole(role: TeamUserEntry['role']) {
  return role === 'owner' ? 'Owner' : role === 'admin' ? 'Admin' : 'Member';
}

function formatDate(value: string) {
  if (!value) {
    return '--';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString();
}

export default function TeamUsersPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Exclude<Role, ''>>('member');
  const [formError, setFormError] = useState('');
  const [roleDrafts, setRoleDrafts] = useState<Record<string, Exclude<Role, ''>>>({});
  const [reenableConfirmation, setReenableConfirmation] = useState<ReenableConfirmation | null>(null);
  const roleOptions = auth.isOwner ? OWNER_ROLE_OPTIONS : ADMIN_ROLE_OPTIONS;

  const usersQuery = useQuery({
    queryKey: TEAM_USERS_QUERY_KEY,
    queryFn: listTeamUsers
  });

  const teamUsers = usersQuery.data || [];
  const roleByUserId = useMemo(() => {
    const next: Record<string, Exclude<Role, ''>> = {};
    teamUsers.forEach((entry) => {
      next[entry.userId] = entry.role;
    });
    return next;
  }, [teamUsers]);

  function refreshTeamUsers() {
    return queryClient.invalidateQueries({ queryKey: TEAM_USERS_QUERY_KEY });
  }

  const inviteMutation = useMutation({
    mutationFn: inviteTeamUser,
    onSuccess: async (result) => {
      setFormError('');
      if (result.outcome === 'disabled_confirmation_required' && result.entry) {
        setReenableConfirmation({ entry: result.entry, role });
        return;
      }
      if (result.outcome === 'account_unavailable') {
        const message = 'This account is not available for organization access. Contact support if this is unexpected.';
        setFormError(message);
        toast.push({ title: 'Account unavailable', description: message, variant: 'error' });
        return;
      }

      const messageByOutcome = {
        added_existing: {
          title: 'User added',
          description: 'User added to this organization.'
        },
        already_active: {
          title: 'Already a member',
          description: 'This user is already a member of this organization.'
        },
        already_invited: {
          title: 'Invitation pending',
          description: 'An invitation is already pending for this user.'
        },
        invited_new: {
          title: 'Invitation sent',
          description: 'Invitation sent.'
        },
        invited_existing_unconfirmed: {
          title: 'Invitation sent',
          description: 'The pending account invitation was sent for this organization.'
        }
      } as const;
      const message = messageByOutcome[result.outcome as keyof typeof messageByOutcome];
      if (!message) {
        return;
      }
      if (result.outcome === 'added_existing' || result.outcome.startsWith('invited_')) {
        setEmail('');
        setName('');
        setRole('member');
        await refreshTeamUsers();
      }
      toast.push({ ...message, variant: 'success' });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'The team member could not be added.';
      setFormError(message);
      toast.push({ title: 'Unable to add team member', description: message, variant: 'error' });
    }
  });

  const changeRoleMutation = useMutation({
    mutationFn: changeTeamUserRole,
    onSuccess: async (entry) => {
      await refreshTeamUsers();
      toast.push({
        title: 'Role updated',
        description: `${entry.email || entry.name} is now ${formatRole(entry.role)}.`,
        variant: 'success'
      });
    },
    onError: (error) => {
      toast.push({
        title: 'Unable to update role',
        description: error instanceof Error ? error.message : 'The role was not changed.',
        variant: 'error'
      });
    }
  });

  const disableMutation = useMutation({
    mutationFn: disableTeamUser,
    onSuccess: async (entry) => {
      await refreshTeamUsers();
      toast.push({
        title: 'User disabled',
        description: `${entry.email || entry.name} can no longer access this workspace.`,
        variant: 'success'
      });
    },
    onError: (error) => {
      toast.push({
        title: 'Unable to disable user',
        description: error instanceof Error ? error.message : 'The user was not disabled.',
        variant: 'error'
      });
    }
  });

  const reenableMutation = useMutation({
    mutationFn: reenableTeamUser,
    onSuccess: async (result) => {
      const entry = result.entry;
      setReenableConfirmation(null);
      await refreshTeamUsers();
      if (result.outcome === 'already_active') {
        toast.push({
          title: 'Already active',
          description: 'This user is already a member of this organization.',
          variant: 'success'
        });
        return;
      }
      if (result.outcome === 'already_invited') {
        toast.push({
          title: 'Invitation pending',
          description: 'An invitation is already pending for this user.',
          variant: 'success'
        });
        return;
      }
      const restoredInvite = entry.status === 'invited';
      toast.push({
        title: restoredInvite ? 'Invite restored' : 'User re-enabled',
        description: restoredInvite
          ? `${entry.email || entry.name} must accept the invite before accessing this workspace.`
          : `${entry.email || entry.name} can access this workspace again.`,
        variant: 'success'
      });
    },
    onError: (error) => {
      toast.push({
        title: 'Unable to re-enable user',
        description: error instanceof Error ? error.message : 'The user was not re-enabled.',
        variant: 'error'
      });
    }
  });

  async function handleInvite() {
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedName = name.trim();
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      setFormError('A valid email is required.');
      return;
    }
    setFormError('');
    await inviteMutation.mutateAsync({
      email: normalizedEmail,
      name: normalizedName,
      role
    });
  }

  async function handleRoleChange(entry: TeamUserEntry) {
    const nextRole = roleDrafts[entry.userId] || entry.role;
    if (nextRole === entry.role) {
      return;
    }
    const confirmed = window.confirm(`Change ${entry.email || entry.name} to ${formatRole(nextRole)}?`);
    if (!confirmed) {
      setRoleDrafts((current) => ({ ...current, [entry.userId]: entry.role }));
      return;
    }
    await changeRoleMutation.mutateAsync({
      userId: entry.userId,
      role: nextRole
    });
  }

  async function handleDisable(entry: TeamUserEntry) {
    if (!window.confirm(`Disable access for ${entry.email || entry.name}?`)) {
      return;
    }
    await disableMutation.mutateAsync({ userId: entry.userId });
  }

  function handleReenable(entry: TeamUserEntry) {
    const selectedRole = roleDrafts[entry.userId] || entry.role;
    setReenableConfirmation({ entry, role: selectedRole });
  }

  async function confirmReenable() {
    if (!reenableConfirmation) {
      return;
    }
    await reenableMutation.mutateAsync({
      userId: reenableConfirmation.entry.userId,
      role: reenableConfirmation.role
    });
  }

  const actionPending =
    inviteMutation.isPending ||
    changeRoleMutation.isPending ||
    disableMutation.isPending ||
    reenableMutation.isPending;

  return (
    <>
      <section className="panel">
        <div className="panel-title-row">
          <div>
            <p className="eyebrow">Team Management</p>
            <h2>Team / Users</h2>
            <p className="muted-text">
              Add existing accounts immediately, or invite new users to create an account.
            </p>
          </div>
        </div>

        <div className="form-grid">
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@example.com"
          />
          <Input
            label="Display Name (new accounts)"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Jane Smith"
          />
          <Select
            label="Role"
            value={role}
            onChange={(event) => setRole(event.target.value as Exclude<Role, ''>)}
            options={roleOptions}
          />
        </div>
        {formError ? <p className="error-text">{formError}</p> : null}
        <div className="detail-actions">
          <Button
            type="button"
            onClick={() => void handleInvite()}
            loading={inviteMutation.isPending}
            loadingLabel="Adding..."
          >
            Add Team Member
          </Button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title-row">
          <h2>Current Team</h2>
          <span className="muted-text">{teamUsers.length} users</span>
        </div>
        {usersQuery.isLoading ? <p className="muted-text">Loading team users...</p> : null}
        {usersQuery.isError ? (
          <p className="error-text">
            {usersQuery.error instanceof Error ? usersQuery.error.message : 'Team users could not be loaded.'}
          </p>
        ) : null}
        <div className="table-wrap team-users-table-wrap">
          <table className="inventory-table team-users-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Status</th>
                <th>Role</th>
                <th>Invited</th>
                <th>Disabled</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {teamUsers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="muted-text">
                    No team users are available yet.
                  </td>
                </tr>
              ) : (
                teamUsers.map((entry) => {
                  const draftRole = roleDrafts[entry.userId] || roleByUserId[entry.userId] || entry.role;
                  const roleChanged = draftRole !== entry.role;
                  const ownerTargetBlocked = auth.isAdmin && entry.role === 'owner';
                  const selfTargetBlocked = auth.isAdmin && entry.userId === auth.session?.user?.sub;
                  const targetBlocked = ownerTargetBlocked || selfTargetBlocked;
                  return (
                    <tr key={entry.userId}>
                      <td>
                        <strong>{entry.name || entry.email || entry.userId}</strong>
                        <br />
                        <span className="muted-text">{entry.email || entry.userId}</span>
                      </td>
                      <td>
                        <span className={`badge ${statusBadgeClass(entry.status)}`}>
                          {formatStatus(entry.status)}
                        </span>
                      </td>
                      <td>
                        <select
                          aria-label={`Role for ${entry.email || entry.name}`}
                          className="table-inline-select"
                          value={draftRole}
                          disabled={targetBlocked || actionPending}
                          onChange={(event) =>
                            setRoleDrafts((current) => ({
                              ...current,
                              [entry.userId]: event.target.value as Exclude<Role, ''>
                            }))
                          }
                        >
                          {OWNER_ROLE_OPTIONS.map((option) => (
                            <option
                              key={option.value}
                              value={option.value}
                              disabled={auth.isAdmin && option.value === 'owner'}
                            >
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>{formatDate(entry.invitedAt || entry.createdAt)}</td>
                      <td>{formatDate(entry.disabledAt)}</td>
                      <td>
                        <div className="table-action-row">
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={() => void handleRoleChange(entry)}
                            disabled={!roleChanged || actionPending || targetBlocked}
                            loading={changeRoleMutation.isPending && roleChanged}
                            loadingLabel="Saving..."
                          >
                            Save Role
                          </Button>
                          {entry.status === 'disabled' ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              onClick={() => handleReenable(entry)}
                              disabled={actionPending || targetBlocked}
                            >
                              Re-enable
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              variant="danger"
                              onClick={() => void handleDisable(entry)}
                              disabled={actionPending || targetBlocked}
                              loading={disableMutation.isPending}
                              loadingLabel="Disabling..."
                            >
                              Disable
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
      <DialogSurface
        open={Boolean(reenableConfirmation)}
        onClose={() => {
          if (!reenableMutation.isPending) {
            setReenableConfirmation(null);
          }
        }}
        titleId="reenable-team-member-title"
        descriptionId="reenable-team-member-description"
      >
        <div className="dialog-header">
          <h2 id="reenable-team-member-title">Enable Team Member</h2>
        </div>
        <p id="reenable-team-member-description" className="muted-text">
          This account already exists but is currently disabled in this organization. Enable this user again as{' '}
          <strong>{reenableConfirmation ? formatRole(reenableConfirmation.role) : ''}</strong>?
        </p>
        <div className="dialog-actions">
          <Button
            type="button"
            variant="ghost"
            disabled={reenableMutation.isPending}
            onClick={() => setReenableConfirmation(null)}
          >
            No
          </Button>
          <Button
            type="button"
            loading={reenableMutation.isPending}
            loadingLabel="Enabling..."
            onClick={() => void confirmReenable()}
          >
            Yes, Enable User
          </Button>
        </div>
      </DialogSurface>
    </>
  );
}
