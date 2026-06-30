// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccessRequestEntry, FeatureAccessMap } from '../../../../domain';
import { useAdminAccessActions } from './useAdminAccessActions';

const toastPushMock = vi.fn();
const refreshAccessContextMock = vi.fn();
let isOwnerMock = false;

vi.mock('../../../../components/Toast', () => ({
  useToast: () => ({ push: toastPushMock })
}));

vi.mock('../../../auth/AuthContext', () => ({
  useAuth: () => ({
    isOwner: isOwnerMock,
    refreshAccessContext: refreshAccessContextMock
  })
}));

function renderAdminActions({
  permissionsRoleDraft,
  permissionsTarget
}: {
  permissionsRoleDraft: 'member' | 'admin' | 'owner';
  permissionsTarget: AccessRequestEntry;
}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const setUserPermissionsDraft = vi.fn();

  return renderHook(
    () =>
      useAdminAccessActions({
        approveNoteDraft: '',
        approveTargetUserId: '',
        closeApproveNoteModal: vi.fn(),
        closeUserPermissionsModal: vi.fn(),
        permissionsRoleDraft,
        permissionsTarget,
        setUserPermissionsDraft,
        userPermissionsDraft: {} as FeatureAccessMap
      }),
    { wrapper }
  );
}

describe('useAdminAccessActions toast variants', () => {
  afterEach(() => {
    toastPushMock.mockReset();
    refreshAccessContextMock.mockReset();
    isOwnerMock = false;
  });

  it('shows the owner-required blocker as a warning toast', async () => {
    const permissionsTarget = {
      userId: 'member-1',
      currentRole: 'member'
    } as AccessRequestEntry;
    const { result } = renderAdminActions({
      permissionsRoleDraft: 'admin',
      permissionsTarget
    });

    await act(async () => {
      await result.current.handleSaveUserPermissions();
    });

    expect(toastPushMock).toHaveBeenCalledWith({
      title: 'Owner required',
      description: 'Only owners can change role status.',
      variant: 'warning'
    });
  });

  it('shows the admin-required owner promotion blocker as a warning toast', async () => {
    isOwnerMock = true;
    const permissionsTarget = {
      userId: 'member-1',
      currentRole: 'member'
    } as AccessRequestEntry;
    const { result } = renderAdminActions({
      permissionsRoleDraft: 'owner',
      permissionsTarget
    });

    await act(async () => {
      await result.current.handleSaveUserPermissions();
    });

    expect(toastPushMock).toHaveBeenCalledWith({
      title: 'Admin required',
      description: 'Only admin accounts can be promoted to owner.',
      variant: 'warning'
    });
  });
});
