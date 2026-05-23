import { describe, expect, it } from 'vitest';
import { buildAllocationJobRoute } from './jobRoutes';

describe('buildAllocationJobRoute', () => {
  it('prefers the canonical jobId route when jobId is available', () => {
    expect(
      buildAllocationJobRoute({
        jobId: '11111111-1111-4111-8111-111111111111',
        jobNumber: '4953'
      })
    ).toBe('/allocations/jobs/11111111-1111-4111-8111-111111111111');
  });

  it('keeps phase context opt-in on canonical jobId routes', () => {
    expect(
      buildAllocationJobRoute({
        jobId: '11111111-1111-4111-8111-111111111111',
        jobNumber: '4953',
        phaseId: '22222222-2222-4222-8222-222222222222'
      })
    ).toBe('/allocations/jobs/11111111-1111-4111-8111-111111111111');

    expect(
      buildAllocationJobRoute(
        {
          jobId: '11111111-1111-4111-8111-111111111111',
          jobNumber: '4953',
          phaseId: '22222222-2222-4222-8222-222222222222'
        },
        { includePhaseTarget: true }
      )
    ).toBe(
      '/allocations/jobs/11111111-1111-4111-8111-111111111111?phaseId=22222222-2222-4222-8222-222222222222'
    );
  });

  it('falls back to the legacy jobNumber route for older payloads', () => {
    expect(buildAllocationJobRoute({ jobNumber: '4953', phaseId: 'phase-1' })).toBe(
      '/allocations/4953'
    );
  });
});
