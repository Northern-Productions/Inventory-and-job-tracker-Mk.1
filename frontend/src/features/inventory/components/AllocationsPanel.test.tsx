// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AllocationEntry } from '../../../domain';
import { AllocationsPanel } from './AllocationsPanel';

const useBoxAllocationsMock = vi.fn();

vi.mock('../hooks/useInventoryQueries', () => ({
  useBoxAllocations: (boxId: string) => useBoxAllocationsMock(boxId)
}));

vi.mock('../../../hooks/useIsPhoneLayout', () => ({
  useIsPhoneLayout: () => false
}));

function buildAllocationEntry(overrides: Partial<AllocationEntry> = {}): AllocationEntry {
  return {
    allocationId: 'alloc-1',
    boxId: 'IL1-100',
    warehouse: 'IL1',
    jobNumber: '4953',
    installDate: '2026-04-22',
    crewLeader: 'Taylor',
    allocatedFeet: 24,
    coveredFeet: 0,
    backedPhysicalFeet: 24,
    reservationState: 'WITHOUT_INSTALL_DATE',
    allocationKind: 'REQUIREMENT',
    allocationSource: 'MANUAL',
    status: 'ACTIVE',
    createdAt: '2026-04-22T10:00:00Z',
    createdBy: 'warehouse',
    resolvedAt: '',
    resolvedBy: '',
    filmOrderId: '',
    notes: '',
    ...overrides
  };
}

function renderPanel(props: ComponentProps<typeof AllocationsPanel>) {
  return render(
    <MemoryRouter>
      <AllocationsPanel {...props} />
    </MemoryRouter>
  );
}

describe('AllocationsPanel', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    useBoxAllocationsMock.mockReset();
  });

  it('displays formatted allocation job labels with Work Scope when available', () => {
    useBoxAllocationsMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [
        buildAllocationEntry({
          jobId: '11111111-1111-4111-8111-111111111111',
          workScope: 'Sections 4, 5',
          sections: 'Sections 4, 5'
        })
      ],
      error: null
    });

    renderPanel({ boxId: 'IL1-100' });

    expect(
      screen.getByRole('link', { name: 'IL1-4953 / Sections 4, 5' }).getAttribute('href')
    ).toBe('/allocations/jobs/11111111-1111-4111-8111-111111111111');
  });

  it('falls back to job number only when allocation Work Scope is missing', () => {
    useBoxAllocationsMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [
        buildAllocationEntry({
          allocationId: 'alloc-legacy',
          jobNumber: '16242'
        })
      ],
      error: null
    });

    renderPanel({ boxId: 'IL1-100' });

    expect(screen.getByText('IL1-16242')).toBeTruthy();
    expect(screen.queryByText(/Sections/)).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows only active user-facing allocation columns', () => {
    useBoxAllocationsMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [
        buildAllocationEntry({
          allocationId: 'active-alloc',
          jobNumber: '4953',
          allocatedFeet: 24
        }),
        buildAllocationEntry({
          allocationId: 'cancelled-alloc',
          jobNumber: '9999',
          allocatedFeet: 12,
          status: 'CANCELLED'
        })
      ],
      error: null
    });

    renderPanel({ boxId: 'IL1-100' });

    expect(screen.getByText('Job')).toBeTruthy();
    expect(screen.getByText('Install Date')).toBeTruthy();
    expect(screen.getByText('Work Scope')).toBeTruthy();
    expect(screen.getByText('LF Claimed')).toBeTruthy();
    expect(screen.getByText('Planning State')).toBeTruthy();
    expect(screen.getByText('24 LF')).toBeTruthy();
    expect(screen.getByText('Scheduled')).toBeTruthy();
    expect(screen.queryByText('IL1-9999')).toBeNull();
    expect(screen.queryByText('Reservation')).toBeNull();
    expect(screen.queryByText('Status')).toBeNull();
    expect(screen.queryByText('Created')).toBeNull();
    expect(screen.queryByText('Resolved')).toBeNull();
  });

  it('supports the default-collapsed Box Details card state', () => {
    useBoxAllocationsMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [buildAllocationEntry()],
      error: null
    });

    renderPanel({ boxId: 'IL1-100', collapsed: true, onToggle: vi.fn() });

    expect(screen.getByRole('button', { name: 'Expand allocations' }).getAttribute('aria-expanded')).toBe(
      'false'
    );
    expect(document.getElementById('allocations-panel-body-IL1-100')?.hidden).toBe(true);
  });
});
