import type { Role } from '../../../../domain';

export type PermissionsBaseRole = 'member' | 'admin';
export type PermissionsRoleDraft = PermissionsBaseRole | 'owner';

interface PermissionsSaveLabelOptions {
  currentRole: Role;
  draftRole: PermissionsRoleDraft;
  isPromotePending?: boolean;
  isPromoteToOwnerPending?: boolean;
  isDemotePending?: boolean;
  isSavePending?: boolean;
}

interface PermissionsSaveDisabledOptions {
  hasPermissionsDraft: boolean;
  isDemotePending?: boolean;
  isOwner: boolean;
  isPermissionsLoading?: boolean;
  isPromotePending?: boolean;
  isPromoteToOwnerPending?: boolean;
  isSavePending?: boolean;
  permissionsBaseRole: PermissionsBaseRole;
  permissionsRoleDraft: PermissionsRoleDraft;
}

export function getPermissionsBaseRole(currentRole: Role): PermissionsBaseRole {
  return currentRole === 'admin' ? 'admin' : 'member';
}

export function getInitialPermissionsRoleDraft(currentRole: Role): PermissionsRoleDraft {
  return getPermissionsBaseRole(currentRole);
}

export function getPermissionsRoleOptions(currentRole: Role, isOwner: boolean): PermissionsRoleDraft[] {
  if (isOwner && getPermissionsBaseRole(currentRole) === 'admin') {
    return ['member', 'admin', 'owner'];
  }

  return ['member', 'admin'];
}

export function getPermissionsRoleChangeMessage(currentRole: Role, draftRole: PermissionsRoleDraft): string {
  const baseRole = getPermissionsBaseRole(currentRole);
  if (draftRole === baseRole) {
    return '';
  }

  if (draftRole === 'owner') {
    return 'This will promote the user to Owner.';
  }

  return draftRole === 'admin'
    ? 'This will promote the user to Admin.'
    : 'This will demote the user to Regular.';
}

export function shouldRenderPermissionsGrid(
  currentRole: Role,
  draftRole: PermissionsRoleDraft,
  hasDraft: boolean
): boolean {
  return draftRole !== 'owner' && getPermissionsBaseRole(currentRole) === draftRole && hasDraft;
}

export function getPermissionsSaveLabel({
  currentRole,
  draftRole,
  isPromotePending = false,
  isPromoteToOwnerPending = false,
  isDemotePending = false,
  isSavePending = false
}: PermissionsSaveLabelOptions): string {
  if (isPromotePending || isPromoteToOwnerPending) {
    return 'Promoting...';
  }

  if (isDemotePending) {
    return 'Demoting...';
  }

  if (isSavePending) {
    return 'Saving...';
  }

  const baseRole = getPermissionsBaseRole(currentRole);
  if (draftRole !== baseRole) {
    if (draftRole === 'owner') {
      return 'Promote to Owner';
    }

    return draftRole === 'admin' ? 'Promote to Admin' : 'Demote to Regular';
  }

  return 'Save Permissions';
}

export function getPermissionsSaveDisabled({
  hasPermissionsDraft,
  isDemotePending = false,
  isOwner,
  isPermissionsLoading = false,
  isPromotePending = false,
  isPromoteToOwnerPending = false,
  isSavePending = false,
  permissionsBaseRole,
  permissionsRoleDraft
}: PermissionsSaveDisabledOptions): boolean {
  if (!isOwner) {
    return true;
  }

  if (isPromotePending || isPromoteToOwnerPending || isDemotePending || isSavePending) {
    return true;
  }

  return (
    permissionsRoleDraft !== 'owner' &&
    permissionsBaseRole === permissionsRoleDraft &&
    (isPermissionsLoading || !hasPermissionsDraft)
  );
}
