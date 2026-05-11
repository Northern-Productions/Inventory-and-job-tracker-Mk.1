// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AllocationJobDetailEntry, JobListEntry } from '../../../../domain';
import { useJobFilmWorkflow } from './useJobFilmWorkflow';

vi.mock('../../hooks/useInventoryQueries', () => ({
  useBox: () => ({
    data: null,
    isLoading: false,
    isError: false,
    error: null
  }),
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
      pushToast: vi.fn(),
      removeJobBoxAllocations,
      setBoxStatus: vi.fn()
    })
  );

  return {
    ...result,
    removeJobBoxAllocations
  };
}

describe('useJobFilmWorkflow remove allocation identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
