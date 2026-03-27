import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  approveAccessRequest,
  approveUsernameChangeRequest,
  demoteAdminToMember,
  denyAccessRequest,
  denyUsernameChangeRequest,
  getAdminFeaturePermissions,
  getUserFeaturePermissions,
  listAccessRequests,
  listUsernameChangeRequests,
  promoteAdminToOwner,
  promoteMemberToAdmin,
  updateAdminFeaturePermissions,
  updateUserFeaturePermissions
} from '../../../api/features/accessClient';
import { Button } from '../../../components/Button';
import { DialogSurface } from '../../../components/DialogSurface';
import { useToast } from '../../../components/Toast';
import type { AccessRequestEntry, FeatureAccessMap, FeatureArea } from '../../../domain';
import { useAuth } from '../../auth/AuthContext';
import {
  getInitialPermissionsRoleDraft,
  getPermissionsBaseRole,
  getPermissionsRoleChangeMessage,
  getPermissionsRoleOptions,
  getPermissionsSaveLabel,
  shouldRenderPermissionsGrid,
  type PermissionsRoleDraft
} from './adminAccessModalUtils';

const MEMBER_FEATURES: FeatureArea[] = [
  'inventory',
  'allocations',
  'jobs',
  'film_orders',
  'activity_history',
  'reports'
];

const ADMIN_FEATURES: FeatureArea[] = [
  'inventory',
  'allocations',
  'jobs',
  'film_orders',
  'activity_history',
  'reports',
  'access_management'
];

function formatFeatureLabel(feature: FeatureArea) {
  return feature.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatRoleLabel(role: string) {
  const normalized = String(role || '').trim().toLowerCase();
  if (normalized === 'owner') {
    return 'owner';
  }
  if (normalized === 'admin') {
    return 'admin';
  }
  if (normalized === 'member') {
    return 'regular';
  }
  return 'no membership';
}

function getRolePillClassName(role: string) {
  const normalized = String(role || '').trim().toLowerCase();
  if (normalized === 'owner') {
    return 'access-role-pill access-role-pill-owner';
  }
  if (normalized === 'admin') {
    return 'access-role-pill access-role-pill-admin';
  }
  if (normalized === 'member') {
    return 'access-role-pill access-role-pill-regular';
  }
  return 'access-role-pill';
}

function parseRequestTimestamp(value: string) {
  const parsed = Date.parse(String(value || '').trim());
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function sanitizeMemberPermissionsForReadOnly(source: FeatureAccessMap): FeatureAccessMap {
  return {
    ...source,
    inventory: { read: Boolean(source.inventory?.read), write: false },
    allocations: { read: Boolean(source.allocations?.read), write: false },
    jobs: { read: Boolean(source.jobs?.read), write: false },
    film_orders: { read: Boolean(source.film_orders?.read), write: false },
    activity_history: { read: Boolean(source.activity_history?.read), write: false },
    reports: { read: Boolean(source.reports?.read), write: false },
    access_management: { read: false, write: false }
  };
}

export default function AdminAccessPage() {
  const auth = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<'' | 'pending' | 'approved' | 'denied'>('');
  const [approveTargetUserId, setApproveTargetUserId] = useState('');
  const [approveNoteDraft, setApproveNoteDraft] = useState('');
  const [permissionsTarget, setPermissionsTarget] = useState<AccessRequestEntry | null>(null);
  const [permissionsRoleDraft, setPermissionsRoleDraft] = useState<PermissionsRoleDraft>('member');
  const [userPermissionsDraft, setUserPermissionsDraft] = useState<FeatureAccessMap | null>(null);

  const canWriteAccess = auth.isOwner || auth.hasFeatureAccess('access_management', 'write');
  const selectedPermissionsUserId = permissionsTarget?.userId || '';
  const selectedPermissionsRole = getPermissionsBaseRole(permissionsTarget?.currentRole || '');
  const requestsSummary =
    statusFilter === 'pending'
      ? 'Pending requests stay in this queue until approved or denied.'
      : statusFilter === 'approved'
        ? 'Showing approved accounts.'
        : statusFilter === 'denied'
          ? 'Showing denied accounts.'
          : 'Showing all access requests. If Create Account says "User already registered", the user is usually in Approved or Denied.';

  async function fetchPermissionsForRole(userId: string, role: 'member' | 'admin') {
    if (role === 'admin') {
      const entries = await getAdminFeaturePermissions();
      const found = entries.find((entry) => entry.userId === userId);
      if (!found) {
        throw new Error('Admin permissions could not be loaded for this user.');
      }
      return found.permissions;
    }

    return getUserFeaturePermissions(userId);
  }

  const requestsQuery = useQuery({
    queryKey: ['access', 'requests', statusFilter],
    queryFn: () => listAccessRequests(statusFilter),
    enabled: auth.canAccessAdminConsole
  });

  const usernameRequestsQuery = useQuery({
    queryKey: ['access', 'username-requests', 'pending'],
    queryFn: () => listUsernameChangeRequests('pending'),
    enabled: auth.canAccessAdminConsole
  });
  const sortedAccessRequests = useMemo(() => {
    const entries = [...(requestsQuery.data || [])];

    entries.sort((left, right) => {
      if (statusFilter === '') {
        const leftPending = left.status === 'pending';
        const rightPending = right.status === 'pending';
        if (leftPending !== rightPending) {
          return leftPending ? -1 : 1;
        }
      }

      const requestedCompare = parseRequestTimestamp(left.requestedAt) - parseRequestTimestamp(right.requestedAt);
      if (requestedCompare !== 0) {
        return requestedCompare;
      }

      return left.userId.localeCompare(right.userId);
    });

    return entries;
  }, [requestsQuery.data, statusFilter]);

  const userPermissionsQuery = useQuery({
    queryKey: ['access', 'user-permissions', selectedPermissionsUserId, selectedPermissionsRole],
    queryFn: async () => {
      if (!selectedPermissionsUserId) {
        throw new Error('No target user selected.');
      }
      return fetchPermissionsForRole(selectedPermissionsUserId, selectedPermissionsRole);
    },
    enabled: auth.canAccessAdminConsole && Boolean(selectedPermissionsUserId),
    refetchOnMount: 'always'
  });

  useEffect(() => {
    if (permissionsRoleDraft !== 'owner' && userPermissionsQuery.data) {
      setUserPermissionsDraft(
        permissionsRoleDraft === 'member'
          ? sanitizeMemberPermissionsForReadOnly(userPermissionsQuery.data)
          : userPermissionsQuery.data
      );
    }
  }, [permissionsRoleDraft, userPermissionsQuery.data]);

  const approveMutation = useMutation({
    mutationFn: approveAccessRequest,
    onSuccess: async () => {
      toast.push({
        title: 'Request approved',
        description: 'The account is now active.'
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['access', 'requests'] }),
        auth.refreshAccessContext()
      ]);
    }
  });

  const denyMutation = useMutation({
    mutationFn: denyAccessRequest,
    onSuccess: async () => {
      toast.push({
        title: 'Request denied',
        description: 'The account remains blocked.'
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['access', 'requests'] }),
        auth.refreshAccessContext()
      ]);
    }
  });

  const approveUsernameMutation = useMutation({
    mutationFn: approveUsernameChangeRequest,
    onSuccess: async () => {
      toast.push({
        title: 'Username change approved',
        description: 'The username has been updated.'
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['access', 'username-requests'] }),
        queryClient.invalidateQueries({ queryKey: ['access', 'requests'] }),
        queryClient.invalidateQueries({ queryKey: ['owner', 'admin-permissions'] }),
        auth.refreshAccessContext()
      ]);
    }
  });

  const denyUsernameMutation = useMutation({
    mutationFn: denyUsernameChangeRequest,
    onSuccess: async () => {
      toast.push({
        title: 'Username change denied',
        description: 'The current username remains unchanged.'
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['access', 'username-requests'] }),
        auth.refreshAccessContext()
      ]);
    }
  });

  const promoteMutation = useMutation({
    mutationFn: promoteMemberToAdmin,
    onSuccess: async (_, payload) => {
      closeUserPermissionsModal(true);
      toast.push({
        title: 'Member promoted',
        description: 'The user is now an admin.'
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['access', 'requests'] }),
        queryClient.invalidateQueries({ queryKey: ['access', 'user-permissions', payload.userId] }),
        queryClient.invalidateQueries({ queryKey: ['owner', 'admin-permissions'] }),
        auth.refreshAccessContext()
      ]);
    }
  });

  const demoteMutation = useMutation({
    mutationFn: demoteAdminToMember,
    onSuccess: async (_, payload) => {
      closeUserPermissionsModal(true);
      toast.push({
        title: 'Admin demoted',
        description: 'The user is now a regular member.'
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['access', 'requests'] }),
        queryClient.invalidateQueries({ queryKey: ['access', 'user-permissions', payload.userId] }),
        queryClient.invalidateQueries({ queryKey: ['owner', 'admin-permissions'] }),
        auth.refreshAccessContext()
      ]);
    }
  });

  const promoteToOwnerMutation = useMutation({
    mutationFn: promoteAdminToOwner,
    onSuccess: async (_, payload) => {
      closeUserPermissionsModal(true);
      toast.push({
        title: 'Admin promoted',
        description: 'The user is now an owner.'
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['access', 'requests'] }),
        queryClient.invalidateQueries({ queryKey: ['access', 'user-permissions', payload.userId] }),
        queryClient.invalidateQueries({ queryKey: ['owner', 'admin-permissions'] }),
        auth.refreshAccessContext()
      ]);
    }
  });

  const updateUserPermissionsMutation = useMutation({
    mutationFn: updateUserFeaturePermissions,
    onSuccess: async (nextPermissions, payload) => {
      const sanitizedPermissions = sanitizeMemberPermissionsForReadOnly(nextPermissions);
      const memberQueryKey = ['access', 'user-permissions', payload.userId, 'member'] as const;
      closeUserPermissionsModal(true);
      setUserPermissionsDraft(sanitizedPermissions);
      queryClient.setQueryData(memberQueryKey, sanitizedPermissions);
      toast.push({
        title: 'Permissions saved',
        description: 'Per-user member permissions were updated.'
      });
      const refreshMemberPermissionsPromise = queryClient
        .fetchQuery({
          queryKey: memberQueryKey,
          queryFn: () => fetchPermissionsForRole(payload.userId, 'member'),
          staleTime: 0
        })
        .catch(() => undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['access', 'requests'] }),
        queryClient.invalidateQueries({ queryKey: ['access', 'user-permissions', payload.userId] }),
        queryClient.invalidateQueries({ queryKey: ['owner', 'admin-permissions'] }),
        refreshMemberPermissionsPromise,
        auth.refreshAccessContext()
      ]);
    }
  });

  const updateAdminPermissionsMutation = useMutation({
    mutationFn: updateAdminFeaturePermissions,
    onSuccess: async (nextPermissions, payload) => {
      const adminQueryKey = ['access', 'user-permissions', payload.userId, 'admin'] as const;
      closeUserPermissionsModal(true);
      setUserPermissionsDraft(nextPermissions);
      queryClient.setQueryData(adminQueryKey, nextPermissions);
      toast.push({
        title: 'Admin permissions saved',
        description: 'Per-admin feature overrides were updated.'
      });
      const refreshAdminPermissionsPromise = queryClient
        .fetchQuery({
          queryKey: adminQueryKey,
          queryFn: () => fetchPermissionsForRole(payload.userId, 'admin'),
          staleTime: 0
        })
        .catch(() => undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['access', 'requests'] }),
        queryClient.invalidateQueries({ queryKey: ['access', 'user-permissions', payload.userId] }),
        queryClient.invalidateQueries({ queryKey: ['owner', 'admin-permissions'] }),
        refreshAdminPermissionsPromise,
        auth.refreshAccessContext()
      ]);
    }
  });

  const isPermissionsMutationPending =
    updateUserPermissionsMutation.isPending ||
    updateAdminPermissionsMutation.isPending ||
    promoteMutation.isPending ||
    promoteToOwnerMutation.isPending ||
    demoteMutation.isPending;
  const permissionsBaseRole = permissionsTarget ? getPermissionsBaseRole(permissionsTarget.currentRole) : 'member';
  const permissionsRoleOptions = permissionsTarget ? getPermissionsRoleOptions(permissionsTarget.currentRole, auth.isOwner) : [];
  const shouldShowPermissionsEditor = permissionsTarget
    ? shouldRenderPermissionsGrid(permissionsTarget.currentRole, permissionsRoleDraft, Boolean(userPermissionsDraft))
    : false;
  const permissionsRoleMessage = permissionsTarget
    ? getPermissionsRoleChangeMessage(permissionsTarget.currentRole, permissionsRoleDraft)
    : '';
  const permissionsSaveLabel = permissionsTarget
    ? getPermissionsSaveLabel({
        currentRole: permissionsTarget.currentRole,
        draftRole: permissionsRoleDraft,
        isPromotePending: promoteMutation.isPending,
        isPromoteToOwnerPending: promoteToOwnerMutation.isPending,
        isDemotePending: demoteMutation.isPending,
        isSavePending: updateAdminPermissionsMutation.isPending || updateUserPermissionsMutation.isPending
      })
    : 'Save Permissions';

  function toggleUserPermission(feature: FeatureArea, mode: 'read' | 'write') {
    setUserPermissionsDraft((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        [feature]: {
          ...current[feature],
          [mode]: !current[feature][mode]
        }
      };
    });
  }

  function openUserPermissionsModal(entry: AccessRequestEntry) {
    setPermissionsTarget(entry);
    setPermissionsRoleDraft(getInitialPermissionsRoleDraft(entry.currentRole));
    setUserPermissionsDraft(null);
    void queryClient.invalidateQueries({
      queryKey: ['access', 'user-permissions', entry.userId, getPermissionsBaseRole(entry.currentRole)],
      exact: true
    });
  }

  function closeUserPermissionsModal(force = false) {
    if (
      !force &&
      (
        updateUserPermissionsMutation.isPending ||
        updateAdminPermissionsMutation.isPending ||
        promoteMutation.isPending ||
        promoteToOwnerMutation.isPending ||
        demoteMutation.isPending
      )
    ) {
      return;
    }
    setPermissionsTarget(null);
    setPermissionsRoleDraft('member');
    setUserPermissionsDraft(null);
  }

  function openApproveNoteModal(userId: string) {
    setApproveTargetUserId(userId);
    setApproveNoteDraft('');
  }

  function closeApproveNoteModal() {
    if (approveMutation.isPending) {
      return;
    }
    setApproveTargetUserId('');
    setApproveNoteDraft('');
  }

  async function handleApproveSubmit() {
    if (!approveTargetUserId) {
      return;
    }

    await approveMutation.mutateAsync({
      userId: approveTargetUserId,
      note: approveNoteDraft.trim()
    });

    closeApproveNoteModal();
  }

  async function handleDeny(userId: string) {
    const note = window.prompt('Denial note (optional):', '') || '';
    await denyMutation.mutateAsync({ userId, note });
  }

  async function handleApproveUsernameChange(userId: string) {
    await approveUsernameMutation.mutateAsync({ userId });
  }

  async function handleDenyUsernameChange(userId: string) {
    const note = window.prompt('Denial note (optional):', '') || '';
    await denyUsernameMutation.mutateAsync({ userId, note });
  }

  async function handleSaveUserPermissions() {
    if (!permissionsTarget) {
      return;
    }

    const currentRole = getPermissionsBaseRole(permissionsTarget.currentRole);

    if (permissionsRoleDraft !== currentRole) {
      if (!auth.isOwner) {
        toast.push({
          title: 'Owner required',
          description: 'Only owners can change role status.'
        });
        return;
      }

      if (permissionsRoleDraft === 'owner') {
        if (currentRole !== 'admin') {
          toast.push({
            title: 'Admin required',
            description: 'Only admin accounts can be promoted to owner.'
          });
          return;
        }

        await promoteToOwnerMutation.mutateAsync({ userId: permissionsTarget.userId });
        return;
      }

      if (permissionsRoleDraft === 'admin') {
        await promoteMutation.mutateAsync({ userId: permissionsTarget.userId });
        return;
      }

      await demoteMutation.mutateAsync({ userId: permissionsTarget.userId });
      return;
    }

    if (!userPermissionsDraft) {
      return;
    }

    if (currentRole === 'admin') {
      await updateAdminPermissionsMutation.mutateAsync({
        userId: permissionsTarget.userId,
        permissions: userPermissionsDraft
      });
      return;
    }

    await updateUserPermissionsMutation.mutateAsync({
      userId: permissionsTarget.userId,
      permissions: sanitizeMemberPermissionsForReadOnly(userPermissionsDraft)
    });
  }

  return (
    <>
      <section className="panel">
        <div className="panel-title-row">
          <div>
            <h2>Access Requests</h2>
            <p className="muted-text">{requestsSummary}</p>
          </div>
          <div className="page-actions">
            <Button
              type="button"
              variant={statusFilter === '' ? 'primary' : 'ghost'}
              onClick={() => setStatusFilter('')}
            >
              All
            </Button>
            <Button
              type="button"
              variant={statusFilter === 'pending' ? 'primary' : 'ghost'}
              onClick={() => setStatusFilter('pending')}
            >
              Pending
            </Button>
            <Button
              type="button"
              variant={statusFilter === 'approved' ? 'primary' : 'ghost'}
              onClick={() => setStatusFilter('approved')}
            >
              Approved
            </Button>
            <Button
              type="button"
              variant={statusFilter === 'denied' ? 'primary' : 'ghost'}
              onClick={() => setStatusFilter('denied')}
            >
              Denied
            </Button>
          </div>
        </div>

        {requestsQuery.isLoading ? <p className="muted-text">Loading access requests...</p> : null}
        {requestsQuery.isError ? (
          <p className="error-text">
            {requestsQuery.error instanceof Error
              ? requestsQuery.error.message
              : 'Access requests could not be loaded.'}
          </p>
        ) : null}

        {!requestsQuery.isLoading && !requestsQuery.isError ? (
          <div className="stack access-requests-list">
            {sortedAccessRequests.length === 0 ? (
              <p className="muted-text">No access requests found.</p>
            ) : (
              sortedAccessRequests.map((entry) => {
                const isPending = entry.status === 'pending';
                const canChangePermissions =
                  auth.isOwner &&
                  entry.status === 'approved' &&
                  (entry.currentRole === 'member' || entry.currentRole === 'admin');
                const displayName = entry.name || entry.email || entry.userId;
                return (
                  <article key={entry.userId} className="panel panel-subtle">
                    <div className="panel-title-row">
                      <div>
                        <strong>{displayName}</strong>
                        {entry.email ? <p className="muted-text">{entry.email}</p> : null}
                        <p className="muted-text access-request-meta">
                          <span>{entry.userId}</span>
                          <span>- {entry.status.toUpperCase()} -</span>
                          <span className={getRolePillClassName(entry.currentRole)}>
                            {formatRoleLabel(entry.currentRole)}
                          </span>
                        </p>
                        <p className="muted-text">
                          Requested: {entry.requestedAt || '--'} {entry.decidedAt ? `- Decided: ${entry.decidedAt}` : ''}
                        </p>
                        {entry.decisionNote ? <p className="muted-text">Note: {entry.decisionNote}</p> : null}
                      </div>
                      <div className="page-actions access-request-actions">
                        {isPending ? (
                          <>
                            <Button
                              type="button"
                              onClick={() => openApproveNoteModal(entry.userId)}
                              disabled={!canWriteAccess || approveMutation.isPending}
                            >
                              Approve
                            </Button>
                            <Button
                              type="button"
                              variant="secondary"
                              onClick={() => void handleDeny(entry.userId)}
                              disabled={!canWriteAccess || denyMutation.isPending}
                            >
                              Deny
                            </Button>
                          </>
                        ) : null}
                        {canChangePermissions ? (
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() => openUserPermissionsModal(entry)}
                            disabled={isPermissionsMutationPending}
                          >
                            Change Permissions
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </article>
                );
              })
            )}
          </div>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-title-row">
          <div>
            <h2>Username Change Requests</h2>
            <p className="muted-text">Non-admin username changes require approval.</p>
          </div>
        </div>
        {usernameRequestsQuery.isLoading ? (
          <p className="muted-text">Loading username change requests...</p>
        ) : null}
        {usernameRequestsQuery.isError ? (
          <p className="error-text">
            {usernameRequestsQuery.error instanceof Error
              ? usernameRequestsQuery.error.message
              : 'Username change requests could not be loaded.'}
          </p>
        ) : null}
        {!usernameRequestsQuery.isLoading && !usernameRequestsQuery.isError ? (
          <div className="stack access-requests-list">
            {(usernameRequestsQuery.data || []).length === 0 ? (
              <p className="muted-text">No pending username changes.</p>
            ) : (
              (usernameRequestsQuery.data || []).map((entry) => (
                <article key={entry.userId} className="panel panel-subtle">
                  <div className="panel-title-row">
                    <div>
                      <strong>{entry.currentName || entry.email || entry.userId}</strong>
                      {entry.email ? <p className="muted-text">{entry.email}</p> : null}
                      <p className="muted-text">
                        Requested username: <strong>{entry.requestedName || '--'}</strong>
                      </p>
                      <p className="muted-text access-request-meta">
                        <span>{entry.userId}</span>
                        <span>- {entry.status.toUpperCase()} -</span>
                        <span className={getRolePillClassName(entry.currentRole)}>
                          {formatRoleLabel(entry.currentRole)}
                        </span>
                      </p>
                      <p className="muted-text">
                        Requested: {entry.requestedAt || '--'} {entry.decidedAt ? `- Decided: ${entry.decidedAt}` : ''}
                      </p>
                      {entry.decisionNote ? <p className="muted-text">Note: {entry.decisionNote}</p> : null}
                    </div>
                    <div className="page-actions access-request-actions">
                      <Button
                        type="button"
                        onClick={() => void handleApproveUsernameChange(entry.userId)}
                        disabled={!canWriteAccess || approveUsernameMutation.isPending}
                      >
                        Approve
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => void handleDenyUsernameChange(entry.userId)}
                        disabled={!canWriteAccess || denyUsernameMutation.isPending}
                      >
                        Deny
                      </Button>
                    </div>
                  </div>
                </article>
              ))
            )}
          </div>
        ) : null}
      </section>

      {permissionsTarget ? (
        <DialogSurface
          open
          onClose={() => closeUserPermissionsModal()}
          titleId="change-user-permissions-title"
          descriptionId="change-user-permissions-description"
          className="permissions-dialog"
          closeOnBackdrop
        >
          <div className="dialog-header">
            <h2 id="change-user-permissions-title">Change Permissions</h2>
            <button
              type="button"
              className="dialog-close"
              aria-label="Close"
              onClick={() => closeUserPermissionsModal()}
              disabled={isPermissionsMutationPending}
            >
              X
            </button>
          </div>
          <p>
            <strong>{permissionsTarget.name || permissionsTarget.email || permissionsTarget.userId}</strong>
          </p>
          {permissionsTarget.email ? <p className="muted-text">{permissionsTarget.email}</p> : null}
          <p id="change-user-permissions-description" className="muted-text">
            Set feature access for this account.
          </p>
          <label className="field">
            <span className="field-label">Role</span>
            <select
              className="field-input"
              value={permissionsRoleDraft}
              onChange={(event) =>
                setPermissionsRoleDraft(
                  event.target.value === 'owner' ? 'owner' : event.target.value === 'admin' ? 'admin' : 'member'
                )
              }
              disabled={!auth.isOwner || isPermissionsMutationPending}
            >
              {permissionsRoleOptions.map((roleOption) => (
                <option key={roleOption} value={roleOption}>
                  {roleOption === 'member' ? 'Regular' : roleOption === 'admin' ? 'Admin' : 'Owner'}
                </option>
              ))}
            </select>
          </label>
          {!auth.isOwner ? (
            <p className="muted-text">
              Only owners can manage permissions and role changes from this modal.
            </p>
          ) : null}
          {permissionsRoleMessage ? <p className="muted-text">{permissionsRoleMessage}</p> : null}
          {permissionsRoleDraft === 'owner' ? (
            <p className="muted-text">
              Owners always have full workspace access, access-management controls, and owner-only settings.
            </p>
          ) : null}
          {permissionsRoleDraft !== 'owner' && userPermissionsQuery.isLoading ? (
            <p className="muted-text">Loading permissions...</p>
          ) : null}
          {permissionsRoleDraft !== 'owner' && userPermissionsQuery.isError ? (
            <p className="error-text">
              {userPermissionsQuery.error instanceof Error
                ? userPermissionsQuery.error.message
                : 'User permissions could not be loaded.'}
            </p>
          ) : null}
          {shouldShowPermissionsEditor && userPermissionsDraft ? (
            <div className="feature-grid permissions-feature-grid">
              {(permissionsRoleDraft === 'admin' ? ADMIN_FEATURES : MEMBER_FEATURES).map((feature) => (
                <div
                  key={`${permissionsTarget.userId}-${feature}`}
                  className={`feature-row ${permissionsRoleDraft === 'member' ? 'feature-row-read-only' : ''}`.trim()}
                >
                  <span className="feature-label">{formatFeatureLabel(feature)}</span>
                  <label className="field-checkbox">
                    <input
                      type="checkbox"
                      checked={Boolean(userPermissionsDraft[feature]?.read)}
                      disabled={!auth.isOwner || isPermissionsMutationPending}
                      onChange={() => toggleUserPermission(feature, 'read')}
                    />
                    Read
                  </label>
                  {permissionsRoleDraft === 'admin' ? (
                    <label className="field-checkbox">
                      <input
                        type="checkbox"
                        checked={Boolean(userPermissionsDraft[feature]?.write)}
                        disabled={!auth.isOwner || isPermissionsMutationPending}
                        onChange={() => toggleUserPermission(feature, 'write')}
                      />
                      Write
                    </label>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          <div className="dialog-actions permissions-dialog-actions">
            <Button
              type="button"
              variant="ghost"
              onClick={() => closeUserPermissionsModal()}
              disabled={isPermissionsMutationPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void handleSaveUserPermissions()}
              disabled={
                !auth.isOwner ||
                promoteMutation.isPending ||
                promoteToOwnerMutation.isPending ||
                demoteMutation.isPending ||
                updateAdminPermissionsMutation.isPending ||
                updateUserPermissionsMutation.isPending ||
                (permissionsRoleDraft !== 'owner' &&
                  permissionsBaseRole === permissionsRoleDraft &&
                  (userPermissionsQuery.isLoading || !userPermissionsDraft))
              }
            >
              {permissionsSaveLabel}
            </Button>
          </div>
        </DialogSurface>
      ) : null}

      {approveTargetUserId ? (
        <div className="dialog-backdrop" role="presentation" onClick={closeApproveNoteModal}>
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="approval-note-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="approval-note-title">Approval note</h2>
            <label className="field">
              <span className="field-label">Note</span>
              <textarea
                className="field-input field-textarea"
                value={approveNoteDraft}
                onChange={(event) => setApproveNoteDraft(event.target.value)}
                rows={4}
                placeholder="Optional note"
                autoFocus
              />
            </label>
            <div className="dialog-actions">
              <Button
                type="button"
                onClick={() => void handleApproveSubmit()}
                disabled={!canWriteAccess || approveMutation.isPending}
              >
                {approveMutation.isPending ? 'Submitting...' : 'Submit'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

