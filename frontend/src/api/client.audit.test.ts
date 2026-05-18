import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./http', () => {
  class APIError extends Error {
    warnings: string[];

    constructor(message: string, warnings: string[] = []) {
      super(message);
      this.name = 'APIError';
      this.warnings = warnings;
    }
  }

  return {
    APIError,
    request: vi.fn()
  };
});

import { getRollHistoryByBox } from './client';
import { request } from './http';

const requestMock = vi.mocked(request);

describe('audit API client', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it('preserves optional jobId and Work Scope fields on box roll history', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        entries: [
          {
            logId: 'roll-1',
            boxId: 'IL1-100',
            warehouse: 'IL1',
            jobId: '11111111-1111-4111-8111-111111111111',
            jobNumber: '4953',
            workScope: '',
            sections: ' Sections 4, 5 '
          }
        ]
      },
      warnings: []
    });

    const entries = await getRollHistoryByBox('IL1-100');

    expect(entries[0]).toEqual(
      expect.objectContaining({
        jobId: '11111111-1111-4111-8111-111111111111',
        jobNumber: '4953',
        workScope: 'Sections 4, 5',
        sections: 'Sections 4, 5'
      })
    );
    expect(requestMock).toHaveBeenCalledWith('GET', '/roll-history/by-box', {
      query: { boxId: 'IL1-100' }
    });
  });
});
