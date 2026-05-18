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

import { getRollHistoryByBox, listAudit } from './client';
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

  it('preserves optional structured checkout identity fields on audit entries', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        entries: [
          {
            logId: 'audit-1',
            date: '2026-05-18T12:00:00Z',
            action: 'SET_STATUS',
            boxId: 'IL1-100',
            before: null,
            after: null,
            user: 'tester',
            notes: 'Readable audit note text',
            jobId: '11111111-1111-4111-8111-111111111111',
            jobNumber: '4953',
            jobWarehouse: 'IL1',
            workScope: 'Sections 4, 5',
            sections: 'Sections 4, 5'
          }
        ]
      },
      warnings: []
    });

    const entries = await listAudit({ action: 'SET_STATUS' });

    expect(entries[0]).toEqual(
      expect.objectContaining({
        jobId: '11111111-1111-4111-8111-111111111111',
        jobNumber: '4953',
        jobWarehouse: 'IL1',
        workScope: 'Sections 4, 5',
        sections: 'Sections 4, 5',
        notes: 'Readable audit note text'
      })
    );
    expect(requestMock).toHaveBeenCalledWith('GET', '/audit/list', {
      query: {
        from: undefined,
        to: undefined,
        user: undefined,
        action: 'SET_STATUS'
      }
    });
  });
});
