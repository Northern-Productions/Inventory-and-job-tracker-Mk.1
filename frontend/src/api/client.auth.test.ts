import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./http', () => ({
  request: vi.fn()
}));

import { getAuthContext, updateDefaultWarehouse } from './client';
import { request } from './http';

const requestMock = vi.mocked(request);

describe('auth API client', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it('normalizes defaultWarehouse from GET /auth/context', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        orgId: 'org-1',
        accessStatus: 'approved',
        role: 'owner',
        permissions: {},
        isAdminConsoleAllowed: true,
        pendingCount: 0,
        receivesInAppNotifications: true,
        defaultWarehouse: ' ms1 '
      },
      warnings: []
    });

    const context = await getAuthContext();

    expect(context.defaultWarehouse).toBe('MS1');
    expect(requestMock).toHaveBeenCalledWith('GET', '/auth/context');
  });

  it('posts profile default warehouse updates', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        defaultWarehouse: ' ms1 '
      },
      warnings: []
    });

    const result = await updateDefaultWarehouse({ defaultWarehouse: 'MS1' });

    expect(result).toEqual({ defaultWarehouse: 'MS1' });
    expect(requestMock).toHaveBeenCalledWith('POST', '/profile/default-warehouse', {
      body: { defaultWarehouse: 'MS1' }
    });
  });
});
