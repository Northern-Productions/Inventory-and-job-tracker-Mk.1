// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobDetail } from '../../../../domain';
import { JobOverviewHeroSection } from './JobOverviewHeroSection';

function buildSummary(overrides: Partial<JobDetail['summary']> = {}): JobDetail['summary'] {
  return {
    jobNumber: '000123',
    warehouse: 'IL1',
    workScope: null,
    sections: null,
    installDate: '2026-04-01',
    crewLeader: 'Crew',
    status: 'READY',
    lifecycleStatus: 'ACTIVE',
    isLaborOnly: false,
    isStagedForPickup: false,
    requiredFeet: 40,
    allocatedFeet: 40,
    remainingFeet: 0,
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

function renderHero(summaryOverrides: Partial<JobDetail['summary']> = {}) {
  return render(
    <JobOverviewHeroSection
      summary={buildSummary(summaryOverrides)}
      isReadOnlyJob={false}
      isLaborOnlyDisplayJob={false}
      stagingBlockingMessage=""
      canEditStagedPickup={false}
      canMarkStagedPickup={false}
      hasCheckoutableMaterials={false}
      filmTransferAlerts={[]}
      caulkTransferAlerts={[]}
      isOwner={true}
      reopenPending={false}
      checkoutAllPending={false}
      stagedPickupPending={false}
      statusPending={false}
      caulkCheckoutPending={false}
      onOpenEdit={vi.fn()}
      onOpenReopenConfirm={vi.fn()}
      onBack={vi.fn()}
      onCheckoutAll={vi.fn()}
      onToggleStagedPickup={vi.fn()}
      onOpenTransferBox={vi.fn()}
    />
  );
}

describe('JobOverviewHeroSection', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders a secondary ON ORDER pill when the summary reports ordered allocations', () => {
    renderHero({ hasOrderedAllocations: true, workScope: 'Sections 4, 5' });

    expect(screen.getByRole('heading', { name: 'JOB ID IL1-000123 / Sections 4, 5' })).toBeTruthy();
    expect(screen.getByText('Work Scope')).toBeTruthy();
    expect(screen.getByText('Sections 4, 5')).toBeTruthy();
    expect(screen.getByText('READY')).toBeTruthy();
    expect(screen.getByText('ON ORDER')).toBeTruthy();
  });

  it('keeps only the requested overview fields in the summary grid', () => {
    renderHero({
      workScope: 'Lobby',
      crewLeader: 'Crew A',
      requiredFeet: 120,
      allocatedFeet: 40,
      remainingFeet: 80,
      requiredTubes: 12,
      allocatedTubes: 4,
      remainingTubes: 8
    });

    expect(screen.getByText('Install Date')).toBeTruthy();
    expect(screen.getByText('Warehouse')).toBeTruthy();
    expect(screen.getByText('Work Scope')).toBeTruthy();
    expect(screen.getByText('Crew Leader')).toBeTruthy();
    expect(screen.queryByText('Required LF')).toBeNull();
    expect(screen.queryByText('Allocated LF')).toBeNull();
    expect(screen.queryByText('Remaining LF')).toBeNull();
    expect(screen.queryByText('Required Tubes')).toBeNull();
    expect(screen.queryByText('Allocated Tubes')).toBeNull();
    expect(screen.queryByText('Remaining Tubes')).toBeNull();
  });

  it('uses a stable title and action layout for long job labels', () => {
    const { container } = renderHero({
      jobNumber: '12345678901234567890',
      workScope: 'A very long work scope name that should wrap before it pushes the action buttons away from the header'
    });

    expect(container.querySelector('.job-overview-title-row')).toBeTruthy();
    expect(container.querySelector('.job-overview-title-copy')).toBeTruthy();
    expect(container.querySelector('.job-overview-actions')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
  });

  it('omits the ON ORDER pill when there are no ordered allocations', () => {
    renderHero({ hasOrderedAllocations: false });

    expect(screen.queryByText('ON ORDER')).toBeNull();
  });

  it('renders the Needs Allocation status label for uncovered material with no active order', () => {
    renderHero({ status: 'NEEDS_ALLOCATION', remainingFeet: 20 });

    expect(screen.getByText('Needs Allocation')).toBeTruthy();
  });
});
