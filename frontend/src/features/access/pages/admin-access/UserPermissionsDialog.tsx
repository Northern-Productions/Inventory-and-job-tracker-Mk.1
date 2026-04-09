import { Button } from '../../../../components/Button';
import { DialogSurface } from '../../../../components/DialogSurface';
import type { AccessRequestEntry, FeatureAccessMap, FeatureArea } from '../../../../domain';
import { type PermissionsRoleDraft } from './modalUtils';
import { formatFeatureLabel } from './helpers';

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

interface UserPermissionsDialogProps {
  authIsOwner: boolean;
  loading: boolean;
  mutationPending: boolean;
  permissionsDraft: FeatureAccessMap | null;
  roleDraft: PermissionsRoleDraft;
  roleMessage: string;
  roleOptions: PermissionsRoleDraft[];
  saveDisabled: boolean;
  saveLabel: string;
  shouldShowPermissionsEditor: boolean;
  target: AccessRequestEntry | null;
  error: Error | null;
  onClose: () => void;
  onRoleDraftChange: (role: PermissionsRoleDraft) => void;
  onSave: () => void;
  onTogglePermission: (feature: FeatureArea, mode: 'read' | 'write') => void;
}

export function UserPermissionsDialog({
  authIsOwner,
  loading,
  mutationPending,
  permissionsDraft,
  roleDraft,
  roleMessage,
  roleOptions,
  saveDisabled,
  saveLabel,
  shouldShowPermissionsEditor,
  target,
  error,
  onClose,
  onRoleDraftChange,
  onSave,
  onTogglePermission
}: UserPermissionsDialogProps) {
  if (!target) {
    return null;
  }

  return (
    <DialogSurface
      open
      onClose={onClose}
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
          onClick={onClose}
          disabled={mutationPending}
        >
          X
        </button>
      </div>
      <p>
        <strong>{target.name || target.email || target.userId}</strong>
      </p>
      {target.email ? <p className="muted-text">{target.email}</p> : null}
      <p id="change-user-permissions-description" className="muted-text">
        Set feature access for this account.
      </p>
      <label className="field">
        <span className="field-label">Role</span>
        <select
          className="field-input"
          value={roleDraft}
          onChange={(event) =>
            onRoleDraftChange(
              event.target.value === 'owner' ? 'owner' : event.target.value === 'admin' ? 'admin' : 'member'
            )
          }
          disabled={!authIsOwner || mutationPending}
        >
          {roleOptions.map((roleOption) => (
            <option key={roleOption} value={roleOption}>
              {roleOption === 'member' ? 'Regular' : roleOption === 'admin' ? 'Admin' : 'Owner'}
            </option>
          ))}
        </select>
      </label>
      {!authIsOwner ? (
        <p className="muted-text">Only owners can manage permissions and role changes from this modal.</p>
      ) : null}
      {roleMessage ? <p className="muted-text">{roleMessage}</p> : null}
      {roleDraft === 'owner' ? (
        <p className="muted-text">
          Owners always have full workspace access, access-management controls, and owner-only settings.
        </p>
      ) : null}
      {roleDraft !== 'owner' && loading ? <p className="muted-text">Loading permissions...</p> : null}
      {roleDraft !== 'owner' && error ? (
        <p className="error-text">{error.message || 'User permissions could not be loaded.'}</p>
      ) : null}
      {shouldShowPermissionsEditor && permissionsDraft ? (
        <div className="feature-grid permissions-feature-grid">
          {(roleDraft === 'admin' ? ADMIN_FEATURES : MEMBER_FEATURES).map((feature) => (
            <div
              key={`${target.userId}-${feature}`}
              className={`feature-row ${roleDraft === 'member' ? 'feature-row-read-only' : ''}`.trim()}
            >
              <span className="feature-label">{formatFeatureLabel(feature)}</span>
              <label className="field-checkbox">
                <input
                  type="checkbox"
                  checked={Boolean(permissionsDraft[feature]?.read)}
                  disabled={!authIsOwner || mutationPending}
                  onChange={() => onTogglePermission(feature, 'read')}
                />
                Read
              </label>
              {roleDraft === 'admin' ? (
                <label className="field-checkbox">
                  <input
                    type="checkbox"
                    checked={Boolean(permissionsDraft[feature]?.write)}
                    disabled={!authIsOwner || mutationPending}
                    onChange={() => onTogglePermission(feature, 'write')}
                  />
                  Write
                </label>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <div className="dialog-actions permissions-dialog-actions">
        <Button type="button" variant="ghost" onClick={onClose} disabled={mutationPending}>
          Cancel
        </Button>
        <Button type="button" onClick={onSave} disabled={saveDisabled}>
          {saveLabel}
        </Button>
      </div>
    </DialogSurface>
  );
}
