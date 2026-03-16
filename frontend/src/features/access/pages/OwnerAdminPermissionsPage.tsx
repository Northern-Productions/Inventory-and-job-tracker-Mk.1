import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  demoteAdminToMember,
  getAdminFeaturePermissions,
  promoteAdminToOwner,
  updateAdminFeaturePermissions
} from '../../../api/features/accessClient';
import { Button } from '../../../components/Button';
import { useToast } from '../../../components/Toast';
import type { FeatureAccessMap, FeatureArea } from '../../../domain';

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

function deriveNameFromEmail(email: string) {
  const localPart = String(email || '').split('@')[0] || '';
  const normalized = localPart.replace(/[._-]+/g, ' ').trim();
  return normalized || '';
}

export default function OwnerAdminPermissionsPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draftPermissionsByAdmin, setDraftPermissionsByAdmin] = useState<Record<string, FeatureAccessMap>>({});

  const adminPermissionsQuery = useQuery({
    queryKey: ['owner', 'admin-permissions'],
    queryFn: () => getAdminFeaturePermissions()
  });

  useEffect(() => {
    if (!adminPermissionsQuery.data) {
      return;
    }
    const next: Record<string, FeatureAccessMap> = {};
    adminPermissionsQuery.data.forEach((entry) => {
      next[entry.userId] = entry.permissions;
    });
    setDraftPermissionsByAdmin(next);
  }, [adminPermissionsQuery.data]);

  const updateAdminPermissionMutation = useMutation({
    mutationFn: updateAdminFeaturePermissions,
    onSuccess: async () => {
      toast.push({
        title: 'Admin permissions saved',
        description: 'Per-admin feature overrides were updated.'
      });
      await queryClient.invalidateQueries({ queryKey: ['owner', 'admin-permissions'] });
    }
  });

  const demoteMutation = useMutation({
    mutationFn: demoteAdminToMember,
    onSuccess: async () => {
      toast.push({
        title: 'Admin demoted',
        description: 'The account now has member access.'
      });
      await queryClient.invalidateQueries({ queryKey: ['owner', 'admin-permissions'] });
    }
  });

  const promoteToOwnerMutation = useMutation({
    mutationFn: promoteAdminToOwner,
    onSuccess: async () => {
      toast.push({
        title: 'Admin promoted',
        description: 'The account is now an owner.'
      });
      await queryClient.invalidateQueries({ queryKey: ['owner', 'admin-permissions'] });
    }
  });

  function togglePermission(userId: string, feature: FeatureArea, mode: 'read' | 'write') {
    setDraftPermissionsByAdmin((current) => {
      const currentPermissions = current[userId];
      if (!currentPermissions) {
        return current;
      }

      return {
        ...current,
        [userId]: {
          ...currentPermissions,
          [feature]: {
            ...currentPermissions[feature],
            [mode]: !currentPermissions[feature][mode]
          }
        }
      };
    });
  }

  async function handleSavePermissions(userId: string) {
    const draft = draftPermissionsByAdmin[userId];
    if (!draft) {
      return;
    }

    await updateAdminPermissionMutation.mutateAsync({
      userId,
      permissions: draft
    });
  }

  async function handleDemote(userId: string) {
    await demoteMutation.mutateAsync({ userId });
  }

  async function handlePromoteToOwner(userId: string) {
    await promoteToOwnerMutation.mutateAsync({ userId });
  }

  return (
    <section className="panel">
      <div className="panel-title-row">
        <div>
          <h2>Admin Feature Overrides</h2>
          <p className="muted-text">
            Owners can allow or deny individual features for each admin account.
          </p>
        </div>
      </div>

      {adminPermissionsQuery.isLoading ? <p className="muted-text">Loading admins...</p> : null}
      {adminPermissionsQuery.isError ? (
        <p className="error-text">
          {adminPermissionsQuery.error instanceof Error
            ? adminPermissionsQuery.error.message
            : 'Admin permissions could not be loaded.'}
        </p>
      ) : null}

      {!adminPermissionsQuery.isLoading && !adminPermissionsQuery.isError ? (
        <div className="stack">
          {(adminPermissionsQuery.data || []).length === 0 ? (
            <p className="muted-text">No admin accounts found.</p>
          ) : (
            (adminPermissionsQuery.data || []).map((entry) => {
              const draft = draftPermissionsByAdmin[entry.userId];
              const displayName = entry.name || deriveNameFromEmail(entry.email) || entry.userId;
              return (
                <article key={entry.userId} className="panel panel-subtle">
                  <div className="panel-title-row">
                    <div>
                      <strong>{displayName}</strong>
                      {entry.email ? <p className="muted-text">{entry.email}</p> : null}
                      <p className="muted-text">Role: {entry.role}</p>
                    </div>
                    <div className="page-actions">
                      <Button
                        type="button"
                        onClick={() => void handleSavePermissions(entry.userId)}
                        disabled={!draft || updateAdminPermissionMutation.isPending}
                      >
                        Save Overrides
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => void handleDemote(entry.userId)}
                        disabled={demoteMutation.isPending}
                      >
                        Demote to Member
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => void handlePromoteToOwner(entry.userId)}
                        disabled={promoteToOwnerMutation.isPending}
                      >
                        Promote to Owner
                      </Button>
                    </div>
                  </div>

                  {draft ? (
                    <div className="feature-grid">
                      {ADMIN_FEATURES.map((feature) => (
                        <div key={`${entry.userId}-${feature}`} className="feature-row">
                          <span className="feature-label">{formatFeatureLabel(feature)}</span>
                          <label className="field-checkbox">
                            <input
                              type="checkbox"
                              checked={Boolean(draft[feature]?.read)}
                              onChange={() => togglePermission(entry.userId, feature, 'read')}
                            />
                            Read
                          </label>
                          <label className="field-checkbox">
                            <input
                              type="checkbox"
                              checked={Boolean(draft[feature]?.write)}
                              onChange={() => togglePermission(entry.userId, feature, 'write')}
                            />
                            Write
                          </label>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </article>
              );
            })
          )}
        </div>
      ) : null}
    </section>
  );
}
