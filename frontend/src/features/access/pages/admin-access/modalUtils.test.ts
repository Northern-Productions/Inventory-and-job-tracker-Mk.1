import { describe, expect, it } from 'vitest';
import {
  getPermissionsRoleOptions,
  getPermissionsSaveDisabled,
  getPermissionsSaveLabel,
  shouldRenderPermissionsGrid
} from './modalUtils';

describe('modalUtils', () => {
  it('shows Owner as a selectable role only for owner-managed admin accounts', () => {
    expect(getPermissionsRoleOptions('admin', true)).toEqual(['member', 'admin', 'owner']);
  });

  it('does not show Owner as a selectable role for member accounts', () => {
    expect(getPermissionsRoleOptions('member', true)).toEqual(['member', 'admin']);
  });

  it('resolves the owner promotion call to action label', () => {
    expect(
      getPermissionsSaveLabel({
        currentRole: 'admin',
        draftRole: 'owner'
      })
    ).toBe('Promote to Owner');
  });

  it('hides the permissions grid when the owner draft is selected', () => {
    expect(shouldRenderPermissionsGrid('admin', 'owner', true)).toBe(false);
    expect(shouldRenderPermissionsGrid('admin', 'admin', true)).toBe(true);
  });

  it('disables save while the current role is loading its unchanged permissions draft', () => {
    expect(
      getPermissionsSaveDisabled({
        hasPermissionsDraft: false,
        isOwner: true,
        isPermissionsLoading: true,
        permissionsBaseRole: 'admin',
        permissionsRoleDraft: 'admin'
      })
    ).toBe(true);
  });
});
