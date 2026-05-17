// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
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

    render(<AllocationsPanel boxId="IL1-100" feetAvailable={120} />);

    expect(screen.getByText('IL1-4953 · Sections 4, 5')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
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

    render(<AllocationsPanel boxId="IL1-100" feetAvailable={120} />);

    expect(screen.getByText('IL1-16242')).toBeTruthy();
    expect(screen.queryByText(/Sections/)).toBeNull();
  });
});
