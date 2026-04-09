import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import {
  approveAccessRequest,
  approveUsernameChangeRequest,
  demoteAdminToMember,
  denyAccessRequest,
  denyUsernameChangeRequest,
  promoteAdminToOwner,
  promoteMemberToAdmin,
  updateAdminFeaturePermissions,
  updateUserFeaturePermissions
} from '../../../../api/features/accessClient';
import { useToast } from '../../../../components/Toast';
import type { AccessRequestEntry, FeatureAccessMap } from '../../../../domain';
import { useAuth } from '../../../auth/AuthContext';
import { sanitizeMemberPermissionsForReadOnly } from './helpers';
import { getPermissionsBaseRole, type PermissionsRoleDraft } from './modalUtils';
import { fetchPermissionsForRole } from './useAdminAccessQueries';

interface UseAdminAccessActionsOptions {
  approveNoteDraft: string;
  approveTargetUserId: string;
  closeApproveNoteModal: () => void;
  closeUserPermissionsModal: (force?: boolean) => void;
  permissionsRoleDraft: PermissionsRoleDraft;
  permissionsTarget: AccessRequestEntry | null;
  setUserPermissionsDraft: React.Dispatch<React.SetStateAction<FeatureAccessMap | null>>;
  userPermissionsDraft: FeatureAccessMap | null;
}

export function useAdminAccessActions({
  approveNoteDraft,
  approveTargetUserId,
  closeApproveNoteModal,
  closeUserPermissionsModal,
  permissionsRoleDraft,
  permissionsTarget,
  setUserPermissionsDraft,
  userPermissionsDraft
}: UseAdminAccessActionsOptions) {
  const auth = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  async function refreshAccessViews(queryKeys: QueryKey[]) {
    await Promise.all([
      ...queryKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      auth.refreshAccessContext()
    ]);
  }

  const approveMutation = useMutation({
    mutationFn: approveAccessRequest,
    onSuccess: async () => {
      toast.push({
        title: 'Request approved',
        description: 'The account is now active.'
      });
      await refreshAccessViews([['access', 'requests']]);
    }
  });

  const denyMutation = useMutation({
    mutationFn: denyAccessRequest,
    onSuccess: async () => {
      toast.push({
        title: 'Request denied',
        description: 'The account remains blocked.'
      });
      await refreshAccessViews([['access', 'requests']]);
    }
  });

  const approveUsernameMutation = useMutation({
    mutationFn: approveUsernameChangeRequest,
    onSuccess: async () => {
      toast.push({
        title: 'Username change approved',
        description: 'The username has been updated.'
      });
      await refreshAccessViews([
        ['access', 'username-requests'],
        ['access', 'requests'],
        ['owner', 'admin-permissions']
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
      await refreshAccessViews([['access', 'username-requests']]);
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
      await refreshAccessViews([
        ['access', 'requests'],
        ['access', 'user-permissions', payload.userId],
        ['owner', 'admin-permissions']
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
      await refreshAccessViews([
        ['access', 'requests'],
        ['access', 'user-permissions', payload.userId],
        ['owner', 'admin-permissions']
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
      await refreshAccessViews([
        ['access', 'requests'],
        ['access', 'user-permissions', payload.userId],
        ['owner', 'admin-permissions']
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

  function handleApproveSubmit() {
    if (!approveTargetUserId) {
      return Promise.resolve();
    }

    return approveMutation.mutateAsync({
      userId: approveTargetUserId,
      note: approveNoteDraft.trim()
    }).then(() => {
      closeApproveNoteModal();
    });
  }

  function handleDeny(userId: string) {
    const note = window.prompt('Denial note (optional):', '') || '';
    return denyMutation.mutateAsync({ userId, note });
  }

  function handleApproveUsernameChange(userId: string) {
    return approveUsernameMutation.mutateAsync({ userId });
  }

  function handleDenyUsernameChange(userId: string) {
    const note = window.prompt('Denial note (optional):', '') || '';
    return denyUsernameMutation.mutateAsync({ userId, note });
  }

  function handleSaveUserPermissions() {
    if (!permissionsTarget) {
      return Promise.resolve();
    }

    const currentRole = getPermissionsBaseRole(permissionsTarget.currentRole);

    if (permissionsRoleDraft !== currentRole) {
      if (!auth.isOwner) {
        toast.push({
          title: 'Owner required',
          description: 'Only owners can change role status.'
        });
        return Promise.resolve();
      }

      if (permissionsRoleDraft === 'owner') {
        if (currentRole !== 'admin') {
          toast.push({
            title: 'Admin required',
            description: 'Only admin accounts can be promoted to owner.'
          });
          return Promise.resolve();
        }

        return promoteToOwnerMutation.mutateAsync({ userId: permissionsTarget.userId });
      }

      if (permissionsRoleDraft === 'admin') {
        return promoteMutation.mutateAsync({ userId: permissionsTarget.userId });
      }

      return demoteMutation.mutateAsync({ userId: permissionsTarget.userId });
    }

    if (!userPermissionsDraft) {
      return Promise.resolve();
    }

    if (currentRole === 'admin') {
      return updateAdminPermissionsMutation.mutateAsync({
        userId: permissionsTarget.userId,
        permissions: userPermissionsDraft
      });
    }

    return updateUserPermissionsMutation.mutateAsync({
      userId: permissionsTarget.userId,
      permissions: sanitizeMemberPermissionsForReadOnly(userPermissionsDraft)
    });
  }

  return {
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
  };
}
