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

import { createFilmOrder, deleteFilmOrder } from './client';
import { request } from './http';

const requestMock = vi.mocked(request);

describe('film orders API client identity payloads', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it('posts canonical create payloads with jobId, jobNumber, and requirementId', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        filmOrderId: 'FO-1',
        jobNumber: '1234',
        linkedBoxes: []
      },
      warnings: []
    });

    await createFilmOrder({
      jobId: '11111111-1111-4111-8111-111111111111',
      jobNumber: '1234',
      requirementId: 'req-1',
      warehouse: 'IL1',
      manufacturer: '3M',
      filmName: 'Night Vision 35',
      widthIn: 60,
      requestedFeet: 40
    });

    expect(requestMock).toHaveBeenCalledWith('POST', '/film-orders/create', {
      body: {
        jobId: '11111111-1111-4111-8111-111111111111',
        jobNumber: '1234',
        requirementId: 'req-1',
        warehouse: 'IL1',
        manufacturer: '3M',
        filmName: 'Night Vision 35',
        widthIn: 60,
        requestedFeet: 40
      }
    });
  });

  it('preserves legacy/global create payloads without requiring jobId', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        filmOrderId: 'FO-1',
        jobNumber: '1234',
        linkedBoxes: []
      },
      warnings: []
    });

    await createFilmOrder({
      jobNumber: '1234',
      warehouse: 'IL1',
      manufacturer: '3M',
      filmName: 'Night Vision 35',
      widthIn: 60,
      requestedFeet: 40
    });

    expect(requestMock).toHaveBeenCalledWith('POST', '/film-orders/create', {
      body: {
        jobNumber: '1234',
        warehouse: 'IL1',
        manufacturer: '3M',
        filmName: 'Night Vision 35',
        widthIn: 60,
        requestedFeet: 40
      }
    });
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
