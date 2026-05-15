// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { FilmOrderEntry, JobDetail, JobListEntry } from '../../../../domain';
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

function buildDetail(summary = buildSummary()): JobDetail {
  return {
    summary,
    requirements: [],
    allocations: [],
    usage: [],
    usageTimeline: [],
    caulkRequirements: [],
    caulkAllocations: [],
    caulkCheckouts: [],
    filmOrders: [],
    filmTransferAlerts: [],
    caulkTransferAlerts: []
  };
}

function buildWorkflow(overrides: Record<string, unknown> = {}) {
  const reopenJob = vi.fn().mockResolvedValue({ warnings: [] });
  const deleteFilmOrder = vi.fn().mockResolvedValue({ warnings: [] });
  const checkoutAllJobMaterials = vi.fn().mockResolvedValue({ warnings: [] });
  const summary = buildSummary(overrides.summary as Partial<JobListEntry> | undefined);
  const detail = overrides.detail === undefined ? buildDetail(summary) : (overrides.detail as JobDetail | undefined);
  const updateJob = vi.fn().mockResolvedValue({ result: detail || buildDetail(summary), warnings: [] });
  const pushToast = vi.fn();
  const result = renderHook(
    () =>
      useJobLifecycleWorkflow({
        detail,
        summary,
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
        updateJob,
        completeJob: vi.fn(),
        deleteJob: vi.fn(),
        reopenJob,
        canonicalJobId: overrides.canonicalJobId as string | undefined,
        deleteFilmOrder,
        checkoutAllJobMaterials,
        setJobStagedForPickup: vi.fn(),
        onUserDrivenFilmCoverageChange: vi.fn()
      }),
    { wrapper: createWrapper() }
  );

  return {
    ...result,
    updateJob,
    reopenJob,
    deleteFilmOrder,
    checkoutAllJobMaterials,
    pushToast
  };
}

function buildFilmOrder(overrides: Partial<FilmOrderEntry> = {}): FilmOrderEntry {
  return {
    filmOrderId: 'FO-1',
    requirementId: 'req-1',
    jobNumber: '000123',
    warehouse: 'IL1',
    manufacturer: '3M',
    filmName: 'Night Vision 35',
    widthIn: 60,
    requestedFeet: 100,
    coveredFeet: 0,
    orderedFeet: 0,
    remainingToOrderFeet: 100,
    installDate: '2026-05-01',
    crewLeader: 'Crew A',
    status: 'FILM_ORDER',
    sourceBoxId: '',
    origin: 'MANUAL',
    createdAt: '',
    createdBy: 'tester',
    resolvedAt: '',
    resolvedBy: '',
    notes: '',
    linkedBoxes: [],
    ...overrides
  };
}

const editPayload = {
  jobNumber: '000123',
  warehouse: 'IL1' as const,
  workScope: 'Section 2',
  sections: 'Section 2',
  installDate: '2026-05-02',
  crewLeader: 'Crew B',
  requirements: [],
  caulkRequirements: []
};

describe('useJobLifecycleWorkflow update identity', () => {
  it('sends jobId and jobNumber from canonical job route context', async () => {
    const workflow = buildWorkflow({
      canonicalJobId: '11111111-1111-4111-8111-111111111111',
      summary: { lifecycleStatus: 'ACTIVE', status: 'FILM_ORDER' }
    });

    await act(async () => {
      workflow.result.current.submitUpdateJob(editPayload, false);
    });

    expect(workflow.updateJob).toHaveBeenCalledWith({
      jobId: '11111111-1111-4111-8111-111111111111',
      jobNumber: '000123',
      warehouse: 'IL1',
      workScope: 'Section 2',
      sections: 'Section 2',
      installDate: '2026-05-02',
      crewLeader: 'Crew B',
      requirements: [],
      caulkRequirements: [],
      isLaborOnly: false
    });
  });

  it('preserves legacy jobNumber-only update payload without canonical jobId', async () => {
    const workflow = buildWorkflow({
      summary: { lifecycleStatus: 'ACTIVE', status: 'FILM_ORDER' }
    });

    await act(async () => {
      workflow.result.current.submitUpdateJob(editPayload, false);
    });

    expect(workflow.updateJob).toHaveBeenCalledWith({
      jobNumber: '000123',
      warehouse: 'IL1',
      workScope: 'Section 2',
      sections: 'Section 2',
      installDate: '2026-05-02',
      crewLeader: 'Crew B',
      requirements: [],
      caulkRequirements: [],
      isLaborOnly: false
    });
  });
});

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

describe('useJobLifecycleWorkflow film order delete identity', () => {
  it('sends jobId and jobNumber from canonical job route context', async () => {
    const workflow = buildWorkflow({
      canonicalJobId: '11111111-1111-4111-8111-111111111111',
      summary: { lifecycleStatus: 'ACTIVE', status: 'FILM_ORDER' }
    });

    await act(async () => {
      await workflow.result.current.handleDeleteFilmOrder(buildFilmOrder(), 'Delete selected order.');
    });

    expect(workflow.deleteFilmOrder).toHaveBeenCalledWith({
      jobId: '11111111-1111-4111-8111-111111111111',
      filmOrderId: 'FO-1',
      jobNumber: '000123',
      reason: 'Delete selected order.'
    });
  });

  it('preserves legacy jobNumber-only film order delete payload without canonical jobId', async () => {
    const workflow = buildWorkflow({
      summary: { lifecycleStatus: 'ACTIVE', status: 'FILM_ORDER' }
    });

    await act(async () => {
      await workflow.result.current.handleDeleteFilmOrder(buildFilmOrder(), 'Legacy delete.');
    });

    expect(workflow.deleteFilmOrder).toHaveBeenCalledWith({
      filmOrderId: 'FO-1',
      jobNumber: '000123',
      reason: 'Legacy delete.'
    });
  });
});

describe('useJobLifecycleWorkflow checkout-all identity', () => {
  it('sends jobId and jobNumber from canonical job route context', async () => {
    const workflow = buildWorkflow({
      canonicalJobId: '11111111-1111-4111-8111-111111111111',
      summary: { lifecycleStatus: 'ACTIVE', status: 'READY' }
    });

    await act(async () => {
      await workflow.result.current.handleCheckoutAllMaterials();
    });

    expect(workflow.checkoutAllJobMaterials).toHaveBeenCalledWith({
      jobId: '11111111-1111-4111-8111-111111111111',
      jobNumber: '000123'
    });
  });

  it('preserves legacy jobNumber-only checkout-all payload without canonical jobId', async () => {
    const workflow = buildWorkflow({
      summary: { lifecycleStatus: 'ACTIVE', status: 'READY' }
    });

    await act(async () => {
      await workflow.result.current.handleCheckoutAllMaterials();
    });

    expect(workflow.checkoutAllJobMaterials).toHaveBeenCalledWith({
      jobNumber: '000123'
    });
  });
});
