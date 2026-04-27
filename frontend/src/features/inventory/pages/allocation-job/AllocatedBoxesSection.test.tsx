// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AllocationJobDetailEntry } from '../../../../domain';
import { AllocatedBoxesSection } from './AllocatedBoxesSection';

function buildEntry(overrides: Partial<AllocationJobDetailEntry> = {}): AllocationJobDetailEntry {
  return {
    allocationId: 'alloc-1',
    boxId: 'IL1-ORDERED',
    warehouse: 'IL1',
    jobNumber: '000123',
    installDate: '2026-04-01',
    crewLeader: 'Crew',
    allocatedFeet: 40,
    coveredFeet: 40,
    requirementId: 'req-1',
    allocationKind: 'REQUIREMENT',
    allocationSource: 'MANUAL',
    status: 'ACTIVE',
    createdAt: '2026-04-01T12:00:00Z',
    createdBy: 'tester',
    resolvedAt: '',
    resolvedBy: '',
    filmOrderId: '',
    notes: '',
    manufacturer: '3M Solar',
    filmName: 'Prestige 60',
    widthIn: 60,
    boxStatus: 'ORDERED',
    checkedOutOnThisJob: false,
    ...overrides
  };
}

describe('AllocatedBoxesSection', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows ordered allocations as waiting for receipt with no checkout action', () => {
    render(
      <AllocatedBoxesSection
        entries={[buildEntry()]}
        isPhoneLayout={false}
        isReadOnlyJob={false}
        canOpenAllocateDialog={true}
        allocateButtonLabel="Allocate Film"
        isAuthenticated={true}
        clientIdConfigured={true}
        isStatusMutationPending={() => false}
        filmTransferAlertsByBoxId={{}}
        onOpenAllocateDialog={vi.fn()}
        onOpenBox={vi.fn()}
        onOpenFilmCheckin={vi.fn()}
        onCheckoutAllocation={vi.fn()}
        onRemoveAllocation={vi.fn()}
        isAllocationRemovalPending={() => false}
      />
    );

    expect(screen.getByText('ORDERED')).toBeTruthy();
    expect(screen.getByText('Waiting for receipt')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check Out' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
  });

  it('passes the allocation row to remove handlers for IL1-6868 style rows', () => {
    const onRemoveAllocation = vi.fn();
    const entry = buildEntry({
      allocationId: 'alloc-6868',
      boxId: 'IL1-6868',
      jobNumber: '4953'
    });

    render(
      <AllocatedBoxesSection
        entries={[entry]}
        isPhoneLayout={false}
        isReadOnlyJob={false}
        canOpenAllocateDialog={true}
        allocateButtonLabel="Allocate Film"
        isAuthenticated={true}
        clientIdConfigured={true}
        isStatusMutationPending={() => false}
        filmTransferAlertsByBoxId={{}}
        onOpenAllocateDialog={vi.fn()}
        onOpenBox={vi.fn()}
        onOpenFilmCheckin={vi.fn()}
        onCheckoutAllocation={vi.fn()}
        onRemoveAllocation={onRemoveAllocation}
        isAllocationRemovalPending={() => false}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(onRemoveAllocation).toHaveBeenCalledWith(
      expect.objectContaining({
        allocationId: 'alloc-6868',
        boxId: 'IL1-6868'
      })
    );
  });
});
