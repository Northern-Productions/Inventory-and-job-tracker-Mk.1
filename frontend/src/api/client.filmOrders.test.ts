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

import { cancelJob, createFilmOrder, deleteFilmOrder, getFilmOrderDetail, getFilmOrders } from './client';
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

  it('passes warehouse to GET /film-orders/list when provided', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        entries: [
          {
            filmOrderId: 'FO-1',
            jobNumber: '1234',
            warehouse: 'MS1',
            linkedBoxes: []
          }
        ]
      },
      warnings: []
    });

    const entries = await getFilmOrders({ warehouse: 'MS1' });

    expect(entries[0]?.warehouse).toBe('MS1');
    expect(requestMock).toHaveBeenCalledWith('GET', '/film-orders/list', {
      query: { warehouse: 'MS1' }
    });
  });

  it('passes filmOrderId as a GET query param for detail reads', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        filmOrderId: 'FO-DETAIL',
        linkedBoxes: [],
        history: []
      },
      warnings: []
    });

    const detail = await getFilmOrderDetail('FO-DETAIL');

    expect(detail.filmOrderId).toBe('FO-DETAIL');
    expect(requestMock).toHaveBeenCalledWith('GET', '/film-orders/get', {
      query: { filmOrderId: 'FO-DETAIL' }
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

  it('posts canonical cancel payloads with jobId and jobNumber', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        jobId: '11111111-1111-4111-8111-111111111111',
        jobNumber: '1234'
      },
      warnings: []
    });

    await cancelJob({
      jobId: '11111111-1111-4111-8111-111111111111',
      jobNumber: '1234',
      reason: 'Cancel selected job.'
    });

    expect(requestMock).toHaveBeenCalledWith('POST', '/film-orders/cancel', {
      body: {
        jobId: '11111111-1111-4111-8111-111111111111',
        jobNumber: '1234',
        reason: 'Cancel selected job.'
      }
    });
  });

  it('preserves legacy/global cancel payloads without requiring jobId', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        jobNumber: '1234'
      },
      warnings: []
    });

    await cancelJob({
      jobNumber: '1234',
      reason: 'Cancel from film orders.'
    });

    expect(requestMock).toHaveBeenCalledWith('POST', '/film-orders/cancel', {
      body: {
        jobNumber: '1234',
        reason: 'Cancel from film orders.'
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
