// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
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

function renderSection(
  entries: AllocationJobDetailEntry[],
  overrides: Partial<ComponentProps<typeof AllocatedBoxesSection>> = {}
) {
  return render(
    <AllocatedBoxesSection
      entries={entries}
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
      {...overrides}
    />
  );
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

  it('groups multiple allocations for the same physical box into one visible row', () => {
    const onRemoveAllocation = vi.fn();
    const entries = [
      buildEntry({
        allocationId: 'alloc-48',
        boxId: 'IL1-6000',
        requirementId: 'req-48',
        allocatedFeet: 10,
        coveredFeet: 10,
        boxStatus: 'IN_STOCK'
      }),
      buildEntry({
        allocationId: 'alloc-60',
        boxId: 'IL1-6000',
        requirementId: 'req-60',
        allocatedFeet: 12,
        coveredFeet: 12,
        boxStatus: 'IN_STOCK'
      })
    ];

    renderSection(entries, { onRemoveAllocation });

    expect(screen.getAllByRole('button', { name: 'IL1-6000' })).toHaveLength(1);
    expect(screen.getByText('Covers 2 requirements')).toBeTruthy();
    expect(screen.getByText('22')).toBeTruthy();
    expect(screen.queryByText('alloc-48')).toBeNull();
    expect(screen.queryByText('Expand to view requirement coverage')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(onRemoveAllocation).toHaveBeenCalledWith(
      expect.objectContaining({
        allocationId: 'alloc-48',
        boxId: 'IL1-6000'
      })
    );
  });

  it('expands grouped boxes to show simplified requirement coverage rows', () => {
    const entries = [
      buildEntry({
        allocationId: 'alloc-48',
        boxId: 'IL1-6000',
        requirementId: 'req-48',
        requirementManufacturer: '3M Solar',
        requirementFilmName: 'Prestige 36',
        requirementWidthIn: 36,
        allocatedFeet: 10,
        coveredFeet: 14,
        boxStatus: 'IN_STOCK'
      }),
      buildEntry({
        allocationId: 'alloc-60',
        boxId: 'IL1-6000',
        requirementId: 'req-60',
        requirementManufacturer: '3M Solar',
        requirementFilmName: 'Prestige 60',
        requirementWidthIn: 60,
        allocatedFeet: 12,
        coveredFeet: 12,
        boxStatus: 'IN_STOCK'
      })
    ];

    renderSection(entries);

    fireEvent.click(screen.getByRole('button', { name: 'Show details' }));

    const details = document.getElementById('allocated-box-details-IL1-6000');
    expect(details).toBeTruthy();
    const detailView = within(details as HTMLElement);
    expect(detailView.getByRole('columnheader', { name: 'Requirement' })).toBeTruthy();
    expect(detailView.getByRole('columnheader', { name: 'Width' })).toBeTruthy();
    expect(detailView.getByRole('columnheader', { name: 'Covered LF' })).toBeTruthy();
    expect(detailView.getByText('3M Solar Prestige 36')).toBeTruthy();
    expect(detailView.getByText('3M Solar Prestige 60')).toBeTruthy();
    expect(detailView.getByText('36')).toBeTruthy();
    expect(detailView.getByText('14')).toBeTruthy();
    expect(screen.queryByText('alloc-48')).toBeNull();
    expect(screen.queryByText('req-48')).toBeNull();
    expect(detailView.queryByRole('columnheader', { name: 'Allocation' })).toBeNull();
    expect(detailView.queryByRole('columnheader', { name: 'Actions' })).toBeNull();
    expect(detailView.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
  });

  it('shows one checkout action for duplicate same-box allocations', () => {
    const onCheckoutAllocation = vi.fn();
    const entries = [
      buildEntry({
        allocationId: 'alloc-1',
        boxId: 'IL1-7000',
        requirementId: 'req-a',
        boxStatus: 'IN_STOCK'
      }),
      buildEntry({
        allocationId: 'alloc-2',
        boxId: 'IL1-7000',
        requirementId: 'req-b',
        boxStatus: 'IN_STOCK'
      })
    ];

    renderSection(entries, { onCheckoutAllocation });

    expect(screen.getAllByRole('button', { name: 'Check Out' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Check Out' }));

    expect(onCheckoutAllocation).toHaveBeenCalledTimes(1);
    expect(onCheckoutAllocation).toHaveBeenCalledWith(
      expect.objectContaining({
        allocationId: 'alloc-1',
        boxId: 'IL1-7000'
      })
    );
  });

  it('does not offer film checkout for placeholder-phase allocations', () => {
    renderSection(
      [
        buildEntry({
          allocationId: 'alloc-placeholder',
          boxId: 'IL1-PLACEHOLDER',
          boxStatus: 'IN_STOCK'
        })
      ],
      {
        isWorkflowActiveAllocation: () => false
      }
    );

    expect(screen.getByText('Placeholder phase')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check Out' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
  });

  it('shows one check-in action for duplicate checked-out same-box allocations', () => {
    const onOpenFilmCheckin = vi.fn();
    const entries = [
      buildEntry({
        allocationId: 'alloc-checked-out-a',
        boxId: 'IL1-8000',
        status: 'FULFILLED',
        resolvedAt: '2026-04-01T14:00:00Z',
        boxStatus: 'CHECKED_OUT',
        checkedOutOnThisJob: true
      }),
      buildEntry({
        allocationId: 'alloc-checked-out-b',
        boxId: 'IL1-8000',
        status: 'FULFILLED',
        resolvedAt: '2026-04-01T14:05:00Z',
        boxStatus: 'CHECKED_OUT',
        checkedOutOnThisJob: true
      })
    ];

    renderSection(entries, { onOpenFilmCheckin });

    expect(screen.getAllByRole('button', { name: 'Check In' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check In' }));

    expect(onOpenFilmCheckin).toHaveBeenCalledTimes(1);
    expect(onOpenFilmCheckin).toHaveBeenCalledWith(
      expect.objectContaining({
        allocationId: 'alloc-checked-out-a',
        boxId: 'IL1-8000'
      })
    );
  });

  it('preserves transfer-needed display and disables checkout for grouped box rows', () => {
    renderSection(
      [
        buildEntry({
          allocationId: 'alloc-transfer',
          boxId: 'IL1-TRANSFER',
          boxStatus: 'IN_STOCK'
        })
      ],
      {
        filmTransferAlertsByBoxId: {
          'IL1-TRANSFER': {
            boxId: 'IL1-TRANSFER',
            sourceWarehouse: 'IL1',
            destinationWarehouse: 'MS1',
            state: 'NEEDS_TRANSFER'
          }
        }
      }
    );

    expect(screen.getByText('Needs Transfer')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check Out' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
  });
});
