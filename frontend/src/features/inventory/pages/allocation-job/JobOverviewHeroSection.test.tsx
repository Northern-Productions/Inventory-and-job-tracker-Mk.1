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
  render(
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

  it('omits the ON ORDER pill when there are no ordered allocations', () => {
    renderHero({ hasOrderedAllocations: false });

    expect(screen.queryByText('ON ORDER')).toBeNull();
  });
});
