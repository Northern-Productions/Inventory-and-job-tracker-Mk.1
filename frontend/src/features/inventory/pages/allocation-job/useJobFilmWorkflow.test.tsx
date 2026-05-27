// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AllocationJobDetailEntry, JobListEntry } from '../../../../domain';
import { useJobFilmWorkflow } from './useJobFilmWorkflow';

const boxQueryState = vi.hoisted(() => ({
  current: {
    data: null as unknown,
    isLoading: false,
    isError: false,
    error: null
  }
}));

vi.mock('../../hooks/useInventoryQueries', () => ({
  useBox: () => boxQueryState.current,
  usePendingSetBoxStatusBoxIds: () => new Set<string>()
}));

const JOB_ID = '11111111-1111-4111-8111-111111111111';

function buildSummary(overrides: Partial<JobListEntry> = {}): JobListEntry {
  return {
    jobId: JOB_ID,
    jobNumber: '000123',
    routeTarget: `/allocations/jobs/${JOB_ID}`,
    warehouse: 'IL1',
    sections: 'Section 1',
    workScope: 'Section 1',
    installDate: '2026-05-01',
    crewLeader: 'Crew A',
    status: 'READY',
    lifecycleStatus: 'ACTIVE',
    isLaborOnly: false,
    isStagedForPickup: false,
    requiredFeet: 100,
    allocatedFeet: 60,
    allocatedWithInstallDateFeet: 60,
    allocatedWithoutInstallDateFeet: 0,
    remainingFeet: 40,
    requiredTubes: 0,
    allocatedTubes: 0,
    remainingTubes: 0,
    requirementCount: 1,
    allocationCount: 1,
    filmOrderCount: 0,
    hasOrderedAllocations: false,
    createdAt: '',
    updatedAt: '',
    notes: '',
    ...overrides
  };
}

function buildAllocation(overrides: Partial<AllocationJobDetailEntry> = {}): AllocationJobDetailEntry {
  return {
    allocationId: 'alloc-1',
    boxId: 'IL1-100',
    warehouse: 'IL1',
    jobNumber: '000123',
    installDate: '2026-05-01',
    crewLeader: 'Crew A',
    allocatedFeet: 60,
    coveredFeet: 60,
    requirementId: 'req-1',
    allocationKind: 'REQUIREMENT',
    allocationSource: 'MANUAL',
    status: 'ACTIVE',
    createdAt: '',
    createdBy: 'tester',
    resolvedAt: '',
    resolvedBy: '',
    filmOrderId: '',
    notes: '',
    manufacturer: '3M',
    filmName: 'Night Vision 35',
    widthIn: 60,
    boxStatus: 'IN_STOCK',
    checkedOutOnThisJob: false,
    ...overrides
  };
}

function renderWorkflow({
  canonicalJobId,
  summary = buildSummary()
}: {
  canonicalJobId?: string;
  summary?: JobListEntry;
} = {}) {
  const pushToast = vi.fn();
  const removeJobBoxAllocations = vi.fn().mockResolvedValue({
    result: {
      jobId: canonicalJobId,
      jobNumber: summary.jobNumber,
      allocationId: 'alloc-1',
      boxId: 'IL1-100',
      removedAllocationCount: 1,
      releasedFeet: 60
    },
    warnings: []
  });
  const setBoxStatus = vi.fn().mockResolvedValue({
    result: {
      box: {
        boxId: 'IL1-100',
        status: 'IN_STOCK',
        lastRollWeightLbs: 10,
        feetAvailable: 40,
        coreWeightLbs: 1,
        lfWeightLbsPerFt: 0.1,
        initialFeet: 100,
        coreType: ''
      }
    },
    warnings: []
  });

  const result = renderHook(() =>
    useJobFilmWorkflow({
      summary,
      isReadOnlyJob: false,
      previousHasOutstandingMaterials: false,
      filmTransferAlertsByBoxId: {},
      pendingRemoveJobBoxAllocationIds: new Set(),
      canonicalJobId,
      filmCoverageSnapshot: null,
      ensureSignedIn: () => true,
      maybeOpenReturnCompletionPrompt: vi.fn(),
      onUserDrivenFilmCoverageChange: vi.fn(),
      pushToast,
      removeJobBoxAllocations,
      setBoxStatus
    })
  );

  return {
    ...result,
    pushToast,
    removeJobBoxAllocations,
    setBoxStatus
  };
}

describe('useJobFilmWorkflow remove allocation identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    boxQueryState.current = {
      data: null,
      isLoading: false,
      isError: false,
      error: null
    };
  });

  it('sends jobId, jobNumber, and allocationId from canonical job route context', async () => {
    const workflow = renderWorkflow({ canonicalJobId: JOB_ID });

    await act(async () => {
      await workflow.result.current.handleRemoveAllocation(buildAllocation(), 'Remove selected row.');
    });

    expect(workflow.removeJobBoxAllocations).toHaveBeenCalledWith({
      jobId: JOB_ID,
      jobNumber: '000123',
      allocationId: 'alloc-1',
      reason: 'Remove selected row.'
    });
  });

  it('preserves legacy jobNumber-only remove payload without canonical jobId', async () => {
    const workflow = renderWorkflow();

    await act(async () => {
      await workflow.result.current.handleRemoveAllocation(buildAllocation(), 'Remove legacy row.');
    });

    expect(workflow.removeJobBoxAllocations).toHaveBeenCalledWith({
      jobNumber: '000123',
      allocationId: 'alloc-1',
      reason: 'Remove legacy row.'
    });
  });

  it('blocks checked-out allocation removal with a business-level toast before calling the API', async () => {
    const workflow = renderWorkflow({ canonicalJobId: JOB_ID });

    await act(async () => {
      await workflow.result.current.handleRemoveAllocation(
        buildAllocation({
          boxStatus: 'CHECKED_OUT',
          checkedOutOnThisJob: true
        }),
        'Remove checked-out row.'
      );
    });

    expect(workflow.removeJobBoxAllocations).not.toHaveBeenCalled();
    expect(workflow.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Cannot remove checked-out allocation',
        description: expect.stringContaining('Check it in first.'),
        variant: 'error'
      })
    );
  });

  it('sends canonical job identity with film check-in payloads for cache invalidation', async () => {
    boxQueryState.current = {
      data: {
        boxId: 'IL1-100',
        status: 'CHECKED_OUT',
        receivedDate: '2026-04-01',
        directToJobSite: false,
        lastRollWeightLbs: 15,
        coreWeightLbs: 1,
        lfWeightLbsPerFt: 0.1,
        coreType: '',
        widthIn: 60,
        initialFeet: 100
      },
      isLoading: false,
      isError: false,
      error: null
    };
    const workflow = renderWorkflow({ canonicalJobId: JOB_ID });

    await act(async () => {
      workflow.result.current.setFilmCheckinEntry(
        buildAllocation({
          boxStatus: 'CHECKED_OUT',
          checkedOutOnThisJob: true
        })
      );
    });
    await act(async () => {
      workflow.result.current.handleFilmCheckinConfirm({
        lastRollWeightLbs: '10',
        currentFeetOnRoll: '',
        coreType: ''
      });
    });

    await waitFor(() => expect(workflow.setBoxStatus).toHaveBeenCalled());
    expect(workflow.setBoxStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        boxId: 'IL1-100',
        status: 'IN_STOCK',
        jobId: JOB_ID,
        jobNumber: '000123',
        lastRollWeightLbs: 10
      })
    );
  });
});
