// @vitest-environment jsdom

import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AllocationJobDetailEntry, Box, JobListEntry } from '../../../domain';
import { JobConfirmationDialogs } from './allocation-job/JobConfirmationDialogs';
import { useJobFilmWorkflow } from './allocation-job/useJobFilmWorkflow';

const useBoxMock = vi.fn();

vi.mock('../hooks/useInventoryQueries', () => ({
  useBox: (boxId: string) => useBoxMock(boxId),
  usePendingSetBoxStatusBoxIds: () => new Set<string>()
}));

function buildFilmBox(overrides: Partial<Box> = {}): Box {
  return {
    boxId: 'MS1-919',
    warehouse: 'MS1',
    manufacturer: '3M Fasara',
    filmName: 'Milano Milky White SH2MAML',
    widthIn: 50,
    initialFeet: 45,
    feetAvailable: 5,
    allocationPlanningFeet: 0,
    lotRun: '108442367A',
    status: 'CHECKED_OUT',
    orderDate: '2023-07-31',
    receivedDate: '2023-07-31',
    initialWeightLbs: null,
    lastRollWeightLbs: null,
    lastWeighedDate: '',
    filmKey: '3M FASARA|MILANO MILKY WHITE SH2MAML',
    coreType: 'Red plastic',
    coreWeightLbs: null,
    lfWeightLbsPerFt: null,
    pricePerLf: null,
    purchaseCost: null,
    notes: '',
    hasEverBeenCheckedOut: true,
    lastCheckoutJob: '4580',
    lastCheckoutDate: '2026-04-15',
    zeroedDate: '',
    zeroedReason: '',
    zeroedBy: '',
    ...overrides
  };
}

function buildFilmAllocationEntry(
  overrides: Partial<AllocationJobDetailEntry> = {}
): AllocationJobDetailEntry {
  return {
    allocationId: 'alloc-1',
    boxId: 'MS1-919',
    warehouse: 'MS1',
    jobNumber: '4580',
    installDate: '2026-04-15',
    crewLeader: 'Crew',
    allocatedFeet: 20,
    coveredFeet: 20,
    status: 'ACTIVE',
    allocationKind: 'REQUIREMENT',
    allocationSource: 'MANUAL',
    createdAt: '2026-04-15T09:00:00Z',
    createdBy: 'tester',
    resolvedAt: '',
    resolvedBy: '',
    filmOrderId: '',
    notes: '',
    manufacturer: '3M Fasara',
    filmName: 'Milano Milky White SH2MAML',
    widthIn: 50,
    boxStatus: 'CHECKED_OUT',
    checkedOutOnThisJob: true,
    ...overrides
  };
}

function buildSummary(overrides: Partial<JobListEntry> = {}): JobListEntry {
  return {
    jobNumber: '4580',
    warehouse: 'MS1',
    sections: null,
    installDate: '2026-04-15',
    crewLeader: 'Crew',
    status: 'READY',
    lifecycleStatus: 'ACTIVE',
    isLaborOnly: false,
    isStagedForPickup: false,
    requiredFeet: 20,
    allocatedFeet: 20,
    remainingFeet: 0,
    requiredTubes: 0,
    allocatedTubes: 0,
    remainingTubes: 0,
    requirementCount: 1,
    allocationCount: 1,
    filmOrderCount: 0,
    hasOrderedAllocations: false,
    createdAt: '2026-04-15T08:00:00Z',
    updatedAt: '2026-04-15T08:00:00Z',
    notes: '',
    ...overrides
  };
}

function renderJobDialogs(onConfirmFilmCheckin = vi.fn()) {
  return render(
    <JobConfirmationDialogs
      jobNumber="4580"
      isDeleteJobConfirmOpen={false}
      deleteJobPending={false}
      onCancelDeleteJob={vi.fn()}
      onConfirmDeleteJob={vi.fn()}
      filmOrderToDelete={null}
      onCancelDeleteFilmOrder={vi.fn()}
      onConfirmDeleteFilmOrder={vi.fn()}
      isOrderAllConfirmOpen={false}
      orderableFilmRequirementCount={0}
      onCancelOrderAll={vi.fn()}
      onConfirmOrderAll={vi.fn()}
      allocationToRemove={null}
      onCancelRemoveAllocation={vi.fn()}
      onConfirmRemoveAllocation={vi.fn()}
      filmCheckinEntry={buildFilmAllocationEntry()}
      filmCheckinBox={buildFilmBox()}
      filmCheckinInitialDraft={null}
      filmCheckinBoxLoading={false}
      filmCheckinBoxError=""
      filmCheckinPending={false}
      filmCheckinReleaseJobNumber="4580"
      onCancelFilmCheckin={vi.fn()}
      onConfirmFilmCheckin={onConfirmFilmCheckin}
      caulkAllocationToRemove={null}
      onCancelRemoveCaulkAllocation={vi.fn()}
      onConfirmRemoveCaulkAllocation={vi.fn()}
      isCompleteConfirmOpen={false}
      onCancelCompleteJob={vi.fn()}
      onConfirmCompleteJob={vi.fn()}
      isReturnCompletePromptOpen={false}
      onCancelReturnCompletePrompt={vi.fn()}
      onConfirmReturnCompletePrompt={vi.fn()}
      isReopenConfirmOpen={false}
      onCancelReopenJob={vi.fn()}
      onConfirmReopenJob={vi.fn()}
    />
  );
}

describe('Allocation job film returns', () => {
  beforeEach(() => {
    useBoxMock.mockReset();
    useBoxMock.mockImplementation((boxId: string) => ({
      data: boxId ? buildFilmBox() : null,
      isLoading: false,
      isError: false,
      error: null
    }));
  });

  it('renders the dedicated return dialog for checked-out allocations that need current feet', async () => {
    const onConfirmFilmCheckin = vi.fn();
    renderJobDialogs(onConfirmFilmCheckin);

    const dialog = await screen.findByRole('dialog', { name: 'Check In MS1-919' });
    expect(within(dialog).getByLabelText(/Current Linear Feet/i)).toBeTruthy();
    expect(within(dialog).getByText(/close the current checkout for job 4580/i)).toBeTruthy();

    fireEvent.change(within(dialog).getByRole('spinbutton', { name: /Last Roll Weight/i }), {
      target: { value: '3.34' }
    });
    fireEvent.change(within(dialog).getByLabelText(/Current Linear Feet/i), {
      target: { value: '19' }
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check In' }));

    await waitFor(() =>
      expect(onConfirmFilmCheckin).toHaveBeenCalledWith(
        expect.objectContaining({
          lastRollWeightLbs: '3.34',
          currentFeetOnRoll: '19',
          coreType: 'Red plastic'
        })
      )
    );
  });

  it('submits fulfilled checked-out rows through the allocation-job workflow without resending an unchanged core type', async () => {
    const pushToast = vi.fn();
    const maybeOpenReturnCompletionPrompt = vi.fn();
    const setBoxStatus = vi.fn().mockResolvedValue({
      result: {
        box: buildFilmBox({
          status: 'IN_STOCK',
          feetAvailable: 19,
          lastRollWeightLbs: 3.34,
          lastWeighedDate: '2026-04-15',
          coreWeightLbs: 1.2847,
          lfWeightLbsPerFt: 0.108174,
          lastCheckoutJob: '',
          lastCheckoutDate: ''
        }),
        logId: 'log-1'
      },
      warnings: []
    });

    const { result } = renderHook(() =>
      useJobFilmWorkflow({
        summary: buildSummary(),
        isReadOnlyJob: false,
        previousHasOutstandingMaterials: true,
        filmTransferAlertsByBoxId: {},
        pendingRemoveJobBoxAllocationIds: new Set(),
        ensureSignedIn: () => true,
        maybeOpenReturnCompletionPrompt,
        pushToast,
        removeJobBoxAllocations: vi.fn(),
        setBoxStatus
      })
    );

    act(() => {
      result.current.openFilmCheckinDialog(
        buildFilmAllocationEntry({
          status: 'FULFILLED',
          resolvedAt: '2026-04-15T09:30:00Z',
          notes: 'Checked out for job 4580.'
        })
      );
    });

    act(() => {
      result.current.handleFilmCheckinConfirm({
        lastRollWeightLbs: '3.34',
        currentFeetOnRoll: '19',
        coreType: 'Red plastic'
      });
    });

    await waitFor(() =>
      expect(setBoxStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          boxId: 'MS1-919',
          status: 'IN_STOCK',
          lastRollWeightLbs: 3.34,
          currentFeetOnRoll: 19,
          auditNote: 'Checked in at 3.34 lbs with 19 LF remaining'
        })
      )
    );

    const submittedPayload = setBoxStatus.mock.calls[0]?.[0];
    expect(submittedPayload).not.toHaveProperty('coreType');
    expect(result.current.filmCheckinEntry).toBeNull();

    await waitFor(() => {
      expect(maybeOpenReturnCompletionPrompt).toHaveBeenCalledWith(true);
      expect(pushToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Checked in MS1-919',
          variant: 'success'
        })
      );
    });
  });

  it('surfaces the same-day crew conflict checkout error from the backend', async () => {
    const pushToast = vi.fn();
    const setBoxStatus = vi.fn().mockRejectedValue(
      new Error(
        'Box MS1-919 is already allocated to 4449 on the same install date for a different crew leader. Clear that same-day crew conflict before checkout.'
      )
    );

    const { result } = renderHook(() =>
      useJobFilmWorkflow({
        summary: buildSummary(),
        isReadOnlyJob: false,
        previousHasOutstandingMaterials: true,
        filmTransferAlertsByBoxId: {},
        pendingRemoveJobBoxAllocationIds: new Set(),
        ensureSignedIn: () => true,
        maybeOpenReturnCompletionPrompt: vi.fn(),
        pushToast,
        removeJobBoxAllocations: vi.fn(),
        setBoxStatus
      })
    );

    await act(async () => {
      await result.current.handleCheckoutAllocation(
        buildFilmAllocationEntry({
          boxStatus: 'IN_STOCK',
          checkedOutOnThisJob: false
        })
      );
    });

    await waitFor(() =>
      expect(pushToast).toHaveBeenCalledWith({
        title: 'Unable to check out box',
        description:
          'Box MS1-919 is already allocated to 4449 on the same install date for a different crew leader. Clear that same-day crew conflict before checkout.',
        variant: 'error'
      })
    );
  });
});
