import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./http', () => ({
  request: vi.fn()
}));

import { getAppAttentionSummary } from './client';
import { request } from './http';

const requestMock = vi.mocked(request);

describe('app API client', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it('loads app attention summary through GET /app/attention-summary', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        hasJobsNeedingAllocation: true,
        hasFilmOrdersNeedingAttention: false,
        pendingAccessRequests: true
      },
      warnings: []
    });

    const summary = await getAppAttentionSummary();

    expect(summary).toEqual({
      hasJobsNeedingAllocation: true,
      hasFilmOrdersNeedingAttention: false,
      pendingAccessRequests: true
    });
    expect(requestMock).toHaveBeenCalledWith('GET', '/app/attention-summary', {
      query: {}
    });
  });
});
