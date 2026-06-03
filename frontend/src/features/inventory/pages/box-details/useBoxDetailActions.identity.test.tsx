// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Box } from '../../../../domain';
import { useBoxDetailActions } from './useBoxDetailActions';

function box(overrides: Partial<Box> = {}): Box {
  return {
    boxId: 'IL1-P3C2D-S1',
    warehouse: 'IL1',
    dealer: '',
    manufacturer: '3M',
    filmName: 'Acid Etch SXC-314',
    widthIn: 36,
    initialFeet: 20,
    feetAvailable: 8,
    allocationPlanningFeet: 8,
    lotRun: '',
    status: 'IN_STOCK',
    orderDate: '2026-05-20',
    receivedDate: '2026-05-20',
    initialWeightLbs: 6,
    lastRollWeightLbs: 5,
    lastWeighedDate: '2026-05-20',
    filmKey: '3m-acid-etch-sxc-314',
    coreType: 'Cardboard 3/8"',
    coreWeightLbs: 0.5,
    lfWeightLbsPerFt: 0.1,
    pricePerLf: null,
    purchaseCost: null,
    notes: '',
    hasLabel: true,
    hasEverBeenCheckedOut: false,
    lastCheckoutJob: '',
    lastCheckoutJobId: '',
    lastCheckoutDate: '',
    zeroedDate: '',
    zeroedReason: '',
    zeroedBy: '',
    ...overrides
  };
}

function renderActions(overrides: Partial<Parameters<typeof useBoxDetailActions>[0]> = {}) {
  const setBoxStatus = vi.fn().mockResolvedValue({
    result: {
      box: box({ status: 'CHECKED_OUT' }),
      logId: 'log-1'
    },
    warnings: []
  });

  const args: Parameters<typeof useBoxDetailActions>[0] = {
    box: box(),
    boxId: 'IL1-P3C2D-S1',
    allocations: [],
    allocationsLoading: false,
    allocationsError: false,
    dealerEntries: [],
    checkoutJobOptions: [
      {
        label: 'IL1-9327001 / Sections 1',
        value: 'job:11111111-1111-4111-8111-111111111111',
        jobId: '11111111-1111-4111-8111-111111111111',
        jobNumber: '9327001'
      }
    ],
    ensureSignedIn: vi.fn(() => true),
    navigate: vi.fn(),
    pushToast: vi.fn(),
    onEditComplete: vi.fn(),
    updateBox: vi.fn(),
    deleteBox: vi.fn(),
    setBoxStatus,
    receiveOrderedBox: vi.fn(),
    undoAudit: vi.fn(),
    upsertDealer: vi.fn(),
    ...overrides
  };

  return {
    setBoxStatus,
    hook: renderHook(() => useBoxDetailActions(args))
  };
}

describe('useBoxDetailActions checkout identity', () => {
  it('submits canonical jobId when an allocated duplicate-job option is selected', async () => {
    const { hook, setBoxStatus } = renderActions();

    act(() => {
      hook.result.current.handleStatusChange('CHECKED_OUT');
    });

    await act(async () => {
      await hook.result.current.handleConfirm('job:11111111-1111-4111-8111-111111111111');
    });

    expect(setBoxStatus).toHaveBeenCalledWith({
      boxId: 'IL1-P3C2D-S1',
      status: 'CHECKED_OUT',
      jobId: '11111111-1111-4111-8111-111111111111',
      jobNumber: '9327001',
      auditNote: 'Checked out for job 9327001'
    });
  });

  it('preserves custom job-number fallback when no allocated option matches', async () => {
    const { hook, setBoxStatus } = renderActions();

    act(() => {
      hook.result.current.handleStatusChange('CHECKED_OUT');
    });

    await act(async () => {
      await hook.result.current.handleConfirm('7777');
    });

    expect(setBoxStatus).toHaveBeenCalledWith({
      boxId: 'IL1-P3C2D-S1',
      status: 'CHECKED_OUT',
      jobNumber: '7777',
      auditNote: 'Checked out for job 7777'
    });
  });

  it('does not block zeroed film check-in behind a native browser confirmation', async () => {
    const checkInBox = box({
      status: 'CHECKED_OUT',
      receivedDate: '2026-05-20',
      lastRollWeightLbs: 5,
      coreWeightLbs: 0.5,
      lfWeightLbsPerFt: 0.1,
      initialFeet: 20,
      lastCheckoutJob: '9327001',
      lastCheckoutJobId: '11111111-1111-4111-8111-111111111111'
    });
    const { hook, setBoxStatus } = renderActions({
      box: checkInBox
    });
    setBoxStatus.mockResolvedValueOnce({
      result: {
        box: box({
          ...checkInBox,
          status: 'ZEROED',
          lastRollWeightLbs: 0,
          feetAvailable: 0
        }),
        logId: 'log-1'
      },
      warnings: ['This check-in will auto-move the box into zeroed out inventory.']
    });
    const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(false);

    try {
      await act(async () => {
        await hook.result.current.handleFilmCheckinConfirm({
          lastRollWeightLbs: '0',
          currentFeetOnRoll: '',
          coreType: ''
        });
      });

      expect(confirmSpy).not.toHaveBeenCalled();
      expect(setBoxStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          boxId: 'IL1-P3C2D-S1',
          status: 'IN_STOCK',
          lastRollWeightLbs: 0
        })
      );
    } finally {
      confirmSpy.mockRestore();
    }
  });
});
