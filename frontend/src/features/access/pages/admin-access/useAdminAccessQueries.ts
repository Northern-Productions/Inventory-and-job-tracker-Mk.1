import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getAdminFeaturePermissions,
  getUserFeaturePermissions,
  listAccessRequests,
  listUsernameChangeRequests
} from '../../../../api/features/accessClient';
import { sortAccessRequests, type AccessRequestStatusFilter } from './helpers';

export async function fetchPermissionsForRole(userId: string, role: 'member' | 'admin') {
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

interface UseAdminAccessQueriesOptions {
  canAccessAdminConsole: boolean;
  selectedPermissionsRole: 'member' | 'admin';
  selectedPermissionsUserId: string;
  statusFilter: AccessRequestStatusFilter;
}

export function useAdminAccessQueries({
  canAccessAdminConsole,
  selectedPermissionsRole,
  selectedPermissionsUserId,
  statusFilter
}: UseAdminAccessQueriesOptions) {
  const requestsQuery = useQuery({
    queryKey: ['access', 'requests', statusFilter],
    queryFn: () => listAccessRequests(statusFilter),
    enabled: canAccessAdminConsole
  });

  const usernameRequestsQuery = useQuery({
    queryKey: ['access', 'username-requests', 'pending'],
    queryFn: () => listUsernameChangeRequests('pending'),
    enabled: canAccessAdminConsole
  });

  const sortedAccessRequests = useMemo(() => {
    return sortAccessRequests(requestsQuery.data || [], statusFilter);
  }, [requestsQuery.data, statusFilter]);

  const userPermissionsQuery = useQuery({
    queryKey: ['access', 'user-permissions', selectedPermissionsUserId, selectedPermissionsRole],
    queryFn: async () => {
      if (!selectedPermissionsUserId) {
        throw new Error('No target user selected.');
      }
      return fetchPermissionsForRole(selectedPermissionsUserId, selectedPermissionsRole);
    },
    enabled: canAccessAdminConsole && Boolean(selectedPermissionsUserId),
    refetchOnMount: 'always'
  });

  return {
    requestsQuery,
    sortedAccessRequests,
    userPermissionsQuery,
    usernameRequestsQuery
  };
}
