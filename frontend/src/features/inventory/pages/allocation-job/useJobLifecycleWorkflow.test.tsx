// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { JobListEntry } from '../../../../domain';
import { useJobLifecycleWorkflow } from './useJobLifecycleWorkflow';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function buildSummary(overrides: Partial<JobListEntry> = {}): JobListEntry {
  return {
    jobId: '11111111-1111-4111-8111-111111111111',
    jobNumber: '000123',
    routeTarget: '/allocations/jobs/11111111-1111-4111-8111-111111111111',
    warehouse: 'IL1',
    sections: 'Section 1',
    workScope: 'Section 1',
    installDate: '2026-05-01',
    crewLeader: 'Crew A',
    status: 'COMPLETED',
    lifecycleStatus: 'COMPLETED',
    isLaborOnly: false,
    isStagedForPickup: false,
    requiredFeet: 0,
    allocatedFeet: 0,
    remainingFeet: 0,
    requiredTubes: 0,
    allocatedTubes: 0,
    remainingTubes: 0,
    requirementCount: 0,
    allocationCount: 0,
    filmOrderCount: 0,
    hasOrderedAllocations: false,
    createdAt: '',
    updatedAt: '',
    notes: '',
    ...overrides
  };
}

function buildWorkflow(overrides: Record<string, unknown> = {}) {
  const reopenJob = vi.fn().mockResolvedValue({ warnings: [] });
  const pushToast = vi.fn();
  const result = renderHook(
    () =>
      useJobLifecycleWorkflow({
        detail: undefined,
        summary: buildSummary(overrides.summary as Partial<JobListEntry> | undefined),
        isReadOnlyJob: false,
        stagingBlockingMessage: '',
        filmTransferAlerts: [],
        caulkTransferAlerts: [],
        isOwner: true,
        isAdmin: true,
        ensureSignedIn: () => true,
        pushToast,
        navigateToAllocations: vi.fn(),
        navigateToJobDetail: vi.fn(),
        updateJob: vi.fn(),
        completeJob: vi.fn(),
        deleteJob: vi.fn(),
        reopenJob,
        canonicalJobId: overrides.canonicalJobId as string | undefined,
        deleteFilmOrder: vi.fn(),
        checkoutAllJobMaterials: vi.fn(),
        setJobStagedForPickup: vi.fn(),
        onUserDrivenFilmCoverageChange: vi.fn()
      }),
    { wrapper: createWrapper() }
  );

  return {
    ...result,
    reopenJob,
    pushToast
  };
}

describe('useJobLifecycleWorkflow reopen identity', () => {
  it('sends jobId and jobNumber from canonical job route context', async () => {
    const workflow = buildWorkflow({
      canonicalJobId: '11111111-1111-4111-8111-111111111111'
    });

    await act(async () => {
      await workflow.result.current.handleReopenJob('Reopen selected job.');
    });

    expect(workflow.reopenJob).toHaveBeenCalledWith({
      jobId: '11111111-1111-4111-8111-111111111111',
      jobNumber: '000123',
      reason: 'Reopen selected job.'
    });
  });

  it('preserves legacy jobNumber-only reopen payload without canonical jobId', async () => {
    const workflow = buildWorkflow();

    await act(async () => {
      await workflow.result.current.handleReopenJob('Legacy reopen.');
    });

    expect(workflow.reopenJob).toHaveBeenCalledWith({
      jobNumber: '000123',
      reason: 'Legacy reopen.'
    });
  });
});
