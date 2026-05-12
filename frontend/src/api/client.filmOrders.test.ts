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

import { deleteFilmOrder } from './client';
import { request } from './http';

const requestMock = vi.mocked(request);

describe('film orders API client identity payloads', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it('posts canonical delete payloads with jobId, jobNumber, and filmOrderId', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        filmOrderId: 'FO-1',
        jobNumber: '1234',
        linkedBoxes: []
      },
      warnings: []
    });

    await deleteFilmOrder({
      jobId: '11111111-1111-4111-8111-111111111111',
      jobNumber: '1234',
      filmOrderId: 'FO-1',
      reason: 'Delete selected film order.'
    });

    expect(requestMock).toHaveBeenCalledWith('POST', '/film-orders/delete', {
      body: {
        jobId: '11111111-1111-4111-8111-111111111111',
        jobNumber: '1234',
        filmOrderId: 'FO-1',
        reason: 'Delete selected film order.'
      }
    });
  });

  it('preserves legacy/global delete payloads without requiring jobId', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        filmOrderId: 'FO-1',
        jobNumber: '1234',
        linkedBoxes: []
      },
      warnings: []
    });

    await deleteFilmOrder({
      jobNumber: '1234',
      filmOrderId: 'FO-1',
      reason: 'Delete from Film Orders.'
    });

    expect(requestMock).toHaveBeenCalledWith('POST', '/film-orders/delete', {
      body: {
        jobNumber: '1234',
        filmOrderId: 'FO-1',
        reason: 'Delete from Film Orders.'
      }
    });
  });
});
