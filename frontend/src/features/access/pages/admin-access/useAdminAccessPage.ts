import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AccessRequestEntry, FeatureAccessMap, FeatureArea } from '../../../../domain';
import { useAuth } from '../../../auth/AuthContext';
import {
  getInitialPermissionsRoleDraft,
  getPermissionsBaseRole,
  getPermissionsRoleChangeMessage,
  getPermissionsRoleOptions,
  getPermissionsSaveDisabled,
  getPermissionsSaveLabel,
  type PermissionsRoleDraft,
  shouldRenderPermissionsGrid
} from './modalUtils';
import {
  getRequestsSummary,
  sanitizeMemberPermissionsForReadOnly,
  type AccessRequestStatusFilter
} from './helpers';
import { useAdminAccessActions } from './useAdminAccessActions';
import { useAdminAccessQueries } from './useAdminAccessQueries';

export function useAdminAccessPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<AccessRequestStatusFilter>('');
  const [approveTargetUserId, setApproveTargetUserId] = useState('');
  const [approveNoteDraft, setApproveNoteDraft] = useState('');
  const [permissionsTarget, setPermissionsTarget] = useState<AccessRequestEntry | null>(null);
  const [permissionsRoleDraft, setPermissionsRoleDraft] = useState<PermissionsRoleDraft>('member');
  const [userPermissionsDraft, setUserPermissionsDraft] = useState<FeatureAccessMap | null>(null);

  const canWriteAccess = auth.isOwner || auth.hasFeatureAccess('access_management', 'write');
  const selectedPermissionsUserId = permissionsTarget?.userId || '';
  const selectedPermissionsRole = permissionsTarget
    ? getPermissionsBaseRole(permissionsTarget.currentRole)
    : 'member';
  const requestsSummary = getRequestsSummary(statusFilter);

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

  const {
    requestsQuery,
    sortedAccessRequests,
    userPermissionsQuery,
    usernameRequestsQuery
  } = useAdminAccessQueries({
    canAccessAdminConsole: auth.canAccessAdminConsole,
    selectedPermissionsRole,
    selectedPermissionsUserId,
    statusFilter
  });

  const {
    approveMutation,
    approveUsernameMutation,
    demoteMutation,
    denyMutation,
    denyUsernameMutation,
    handleApproveSubmit,
    handleApproveUsernameChange,
    handleDeny,
    handleDenyUsernameChange,
    handleSaveUserPermissions,
    isPermissionsMutationPending,
    promoteMutation,
    promoteToOwnerMutation,
    updateAdminPermissionsMutation,
    updateUserPermissionsMutation
  } = useAdminAccessActions({
    approveNoteDraft,
    approveTargetUserId,
    closeApproveNoteModal,
    closeUserPermissionsModal,
    permissionsRoleDraft,
    permissionsTarget,
    setUserPermissionsDraft,
    userPermissionsDraft
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

  const permissionsBaseRole = permissionsTarget
    ? getPermissionsBaseRole(permissionsTarget.currentRole)
    : 'member';
  const permissionsRoleOptions = permissionsTarget
    ? getPermissionsRoleOptions(permissionsTarget.currentRole, auth.isOwner)
    : [];
  const shouldShowPermissionsEditor = permissionsTarget
    ? shouldRenderPermissionsGrid(
        permissionsTarget.currentRole,
        permissionsRoleDraft,
        Boolean(userPermissionsDraft)
      )
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
  const permissionsSaveDisabled = getPermissionsSaveDisabled({
    hasPermissionsDraft: Boolean(userPermissionsDraft),
    isDemotePending: demoteMutation.isPending,
    isOwner: auth.isOwner,
    isPermissionsLoading: userPermissionsQuery.isLoading,
    isPromotePending: promoteMutation.isPending,
    isPromoteToOwnerPending: promoteToOwnerMutation.isPending,
    isSavePending:
      updateAdminPermissionsMutation.isPending || updateUserPermissionsMutation.isPending,
    permissionsBaseRole,
    permissionsRoleDraft
  });

  return {
    accessRequestsSectionProps: {
      approvePending: approveMutation.isPending,
      canWriteAccess,
      denyPending: denyMutation.isPending,
      error: requestsQuery.isError && requestsQuery.error instanceof Error ? requestsQuery.error : null,
      isOwner: auth.isOwner,
      loading: requestsQuery.isLoading,
      onApprove: openApproveNoteModal,
      onChangePermissions: openUserPermissionsModal,
      onDeny: (userId: string) => void handleDeny(userId),
      onStatusFilterChange: setStatusFilter,
      permissionsMutationPending: isPermissionsMutationPending,
      requests: sortedAccessRequests,
      requestsSummary,
      statusFilter
    },
    approvalNoteDialogProps: {
      canWriteAccess,
      noteDraft: approveNoteDraft,
      onChange: (value: string) => setApproveNoteDraft(value),
      onClose: closeApproveNoteModal,
      onSubmit: () => void handleApproveSubmit(),
      open: Boolean(approveTargetUserId),
      pending: approveMutation.isPending
    },
    userPermissionsDialogProps: {
      authIsOwner: auth.isOwner,
      error:
        permissionsRoleDraft !== 'owner' &&
        userPermissionsQuery.isError &&
        userPermissionsQuery.error instanceof Error
          ? userPermissionsQuery.error
          : null,
      loading: permissionsRoleDraft !== 'owner' && userPermissionsQuery.isLoading,
      mutationPending: isPermissionsMutationPending,
      onClose: () => closeUserPermissionsModal(),
      onRoleDraftChange: (role: PermissionsRoleDraft) => setPermissionsRoleDraft(role),
      onSave: () => void handleSaveUserPermissions(),
      onTogglePermission: toggleUserPermission,
      permissionsDraft: userPermissionsDraft,
      roleDraft: permissionsRoleDraft,
      roleMessage: permissionsRoleMessage,
      roleOptions: permissionsRoleOptions,
      saveDisabled: permissionsSaveDisabled,
      saveLabel: permissionsSaveLabel,
      shouldShowPermissionsEditor,
      target: permissionsTarget
    },
    usernameChangeRequestsSectionProps: {
      approvePending: approveUsernameMutation.isPending,
      canWriteAccess,
      denyPending: denyUsernameMutation.isPending,
      error:
        usernameRequestsQuery.isError && usernameRequestsQuery.error instanceof Error
          ? usernameRequestsQuery.error
          : null,
      loading: usernameRequestsQuery.isLoading,
      onApprove: (userId: string) => void handleApproveUsernameChange(userId),
      onDeny: (userId: string) => void handleDenyUsernameChange(userId),
      requests: usernameRequestsQuery.data || []
    }
  };
}
