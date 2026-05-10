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

  it('falls back to the legacy jobNumber route for older payloads', () => {
    expect(buildAllocationJobRoute({ jobNumber: '4953' })).toBe('/allocations/4953');
  });
});
