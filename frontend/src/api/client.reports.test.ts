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

import {
  __resetJobsApiAvailabilityForTests,
  getOwnerAssetTotalCostReport,
  getReportsSummary,
  setClientAccessContext
} from './client';
import { createDefaultFeatureAccessMap, type EffectiveAccessContext } from '../domain';
import { APIError, request } from './http';

const requestMock = vi.mocked(request);

function buildAccessContext(role: EffectiveAccessContext['role']): EffectiveAccessContext {
  return {
    orgId: 'org-1',
    accessStatus: 'approved',
    role,
    defaultWarehouse: '',
    permissions: createDefaultFeatureAccessMap(),
    isAdminConsoleAllowed: false,
    pendingCount: 0,
    receivesInAppNotifications: false
  };
}

describe('reports API client', () => {
  beforeEach(() => {
    __resetJobsApiAvailabilityForTests();
    setClientAccessContext(null);
    requestMock.mockReset();
  });

  it('loads reports summary via GET /reports/summary', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        availableFeetByWidth: [],
        neverCheckedOut: [],
        zeroedByMonth: [],
        zeroedBoxes: [],
        completedJobs: [
          {
            jobId: '11111111-1111-4111-8111-111111111111',
            workScope: 'Sections 4, 5',
            sections: 'Sections 4, 5',
            jobNumber: '4953',
            warehouse: 'IL1',
            installDate: '2026-04-10',
            crewLeader: 'Crew',
            status: 'COMPLETED',
            lifecycleStatus: 'COMPLETED',
            requiredFeet: 100,
            allocatedFeet: 100,
            remainingFeet: 0,
            closedAt: '2026-04-11T10:00:00Z'
          }
        ],
        cancelledJobs: []
      },
      warnings: []
    });

    const result = await getReportsSummary({ warehouse: 'IL1' });

    expect(result.zeroedBoxes).toEqual([]);
    expect(result.completedJobs[0]?.jobId).toBe('11111111-1111-4111-8111-111111111111');
    expect(result.completedJobs[0]?.workScope).toBe('Sections 4, 5');
    expect(result.completedJobs[0]?.sections).toBe('Sections 4, 5');
    expect(result.completedJobs[0]?.jobNumber).toBe('4953');
    expect(requestMock).toHaveBeenCalledWith('GET', '/reports/summary', {
      query: {
        warehouse: 'IL1',
        manufacturer: undefined,
        film: undefined,
        width: undefined,
        from: undefined,
        to: undefined
      }
    });
  });

  it('loads owner asset total cost via GET /owner/reports/asset-total-cost', async () => {
    setClientAccessContext(buildAccessContext('owner'));
    requestMock.mockResolvedValueOnce({
      data: {
        warehouse: 'IL1',
        includedBoxCount: '8',
        includedFeet: '1200',
        pricedBoxCount: '7',
        pricedFeet: '1000',
        unpricedBoxCount: '1',
        unpricedFeet: '200',
        coveragePercentByFeet: '0.833333',
        totalAssetCost: '3550.5'
      },
      warnings: []
    });

    const result = await getOwnerAssetTotalCostReport({ warehouse: 'IL1' });

    expect(result.totalAssetCost).toBe(3550.5);
    expect(result.pricedFeet).toBe(1000);
    expect(requestMock).toHaveBeenCalledWith('GET', '/owner/reports/asset-total-cost', {
      query: { warehouse: 'IL1' }
    });
  });

  it('rejects owner asset total cost for non-owner context', async () => {
    setClientAccessContext(buildAccessContext('admin'));

    await expect(getOwnerAssetTotalCostReport({ warehouse: 'IL1' })).rejects.toThrow(
      'Owner access is required.'
    );
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('surfaces backend route errors from owner asset total cost endpoint', async () => {
    setClientAccessContext(buildAccessContext('owner'));
    requestMock.mockRejectedValueOnce(new APIError('Route not found: /owner/reports/asset-total-cost'));

    await expect(getOwnerAssetTotalCostReport({ warehouse: 'IL1' })).rejects.toThrow(
      'Route not found: /owner/reports/asset-total-cost'
    );
  });
});
