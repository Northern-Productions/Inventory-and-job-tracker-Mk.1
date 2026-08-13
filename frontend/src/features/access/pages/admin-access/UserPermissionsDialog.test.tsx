// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultFeatureAccessMap } from '../../../../domain';
import { UserPermissionsDialog } from './UserPermissionsDialog';

describe('UserPermissionsDialog', () => {
  afterEach(() => cleanup());

  it('renders Manage Team Members as one owner-controlled permission', () => {
    const onTogglePermission = vi.fn();
    const permissions = createDefaultFeatureAccessMap();
    permissions.team_management = { read: false, write: false };

    render(
      <UserPermissionsDialog
        authIsOwner
        loading={false}
        mutationPending={false}
        permissionsDraft={permissions}
        roleDraft="admin"
        roleMessage=""
        roleOptions={['member', 'admin']}
        saveDisabled={false}
        saveLabel="Save Permissions"
        shouldShowPermissionsEditor
        target={{
          userId: 'admin-1',
          name: 'Admin One',
          email: 'admin@example.com',
          status: 'approved',
          currentRole: 'admin',
          requestedAt: '',
          decidedAt: '',
          decidedByActor: '',
          decisionNote: ''
        }}
        error={null}
        onClose={vi.fn()}
        onRoleDraftChange={vi.fn()}
        onSave={vi.fn()}
        onTogglePermission={onTogglePermission}
      />
    );

    const row = screen.getByText('Team Management').closest('.feature-row') as HTMLElement;
    expect(within(row).getAllByRole('checkbox')).toHaveLength(1);
    fireEvent.click(within(row).getByRole('checkbox', { name: 'Enabled' }));
    expect(onTogglePermission).toHaveBeenCalledWith('team_management', 'read');
  });
});
