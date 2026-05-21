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
      totalRequiredCaulkTubes={0}
      totalAllocatedCaulkTubes={0}
      totalRemainingCaulkTubes={0}
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

  it('omits the ON ORDER pill when there are no ordered allocations', () => {
    renderHero({ hasOrderedAllocations: false });

    expect(screen.queryByText('ON ORDER')).toBeNull();
  });
});
