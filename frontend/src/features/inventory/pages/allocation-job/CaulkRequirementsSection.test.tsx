// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { JobCaulkRequirementLine } from '../../../../domain';
import { CaulkRequirementsSection } from './CaulkRequirementsSection';

function buildRequirement(overrides: Partial<JobCaulkRequirementLine> = {}): JobCaulkRequirementLine {
  return {
    requirementId: 'caulk-req-1',
    jobNumber: '5143',
    productId: 'product-1',
    manufacturerId: 'manufacturer-1',
    manufacturer: '3M',
    productName: 'IPA',
    productCode: 'Black',
    tubesPerCase: 12,
    requiredTubes: 8,
    status: 'ACTIVE',
    isComplete: false,
    actualUsedTubes: 0,
    completionResult: '',
    allocatedTubes: 8,
    remainingTubes: 0,
    autoPlanningSuppressed: false,
    notes: '',
    updatedAt: '2026-05-21T00:00:00.000Z',
    ...overrides
  };
}

function renderSection(
  requirement: JobCaulkRequirementLine,
  overrides: Partial<Parameters<typeof CaulkRequirementsSection>[0]> = {}
) {
  return render(
    <CaulkRequirementsSection
      requirements={[requirement]}
      isPhoneLayout={false}
      isReadOnlyJob={false}
      isAuthenticated
      clientIdConfigured
      pendingRequirementStateIds={new Set()}
      isResumeAutoPlanningPending={false}
      onSetRequirementState={vi.fn()}
      onAutoAllocateRequirement={vi.fn()}
      onResumeAutoPlanning={vi.fn()}
      {...overrides}
    />
  );
}

describe('CaulkRequirementsSection actual usage state', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows actual used tubes and hides final judgment while active', () => {
    renderSection(buildRequirement({ actualUsedTubes: 5 }));

    expect(screen.getByText('Actual Used Tubes')).not.toBeNull();
    expect(screen.getByText('5')).not.toBeNull();
    expect(screen.queryByLabelText('On target')).toBeNull();
    expect(screen.queryByLabelText('Overused')).toBeNull();
  });

  it('hides planning-only caulk columns from the visible table', () => {
    renderSection(buildRequirement({ requiredTubes: 8, allocatedTubes: 3, remainingTubes: 5 }));

    expect(screen.queryByText('Code')).toBeNull();
    expect(screen.queryByText('Tubes/Case')).toBeNull();
    expect(screen.queryByText('Required Tubes')).toBeNull();
    expect(screen.queryByText('Required Breakdown')).toBeNull();
    expect(screen.queryByText('Remaining Breakdown')).toBeNull();
    expect(screen.getByText('Allocated Tubes')).not.toBeNull();
    expect(screen.getByText('Actual Used Tubes')).not.toBeNull();
    expect(screen.getByText('Remaining Tubes')).not.toBeNull();
  });

  it('marks completed caulk requirements green when actual use is on target or equal', () => {
    renderSection(
      buildRequirement({
        status: 'COMPLETE',
        isComplete: true,
        actualUsedTubes: 8,
        completionResult: 'ON_TARGET'
      })
    );

    expect(screen.getByLabelText('On target')).not.toBeNull();
  });

  it('marks completed caulk requirements red when actual use exceeds required tubes', () => {
    renderSection(
      buildRequirement({
        status: 'COMPLETE',
        isComplete: true,
        actualUsedTubes: 9,
        completionResult: 'OVERUSED'
      })
    );

    expect(screen.getByLabelText('Overused')).not.toBeNull();
  });

  it('toggles caulk requirement state without changing actual used tubes', () => {
    const setRequirementState = vi.fn();
    const requirement = buildRequirement({ actualUsedTubes: 8 });

    renderSection(requirement, { onSetRequirementState: setRequirementState });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Active' }));

    expect(setRequirementState).toHaveBeenCalledWith(requirement, 'COMPLETE');
    expect(screen.getAllByText('8').length).toBeGreaterThan(0);
  });

  it('only disables the caulk requirement row currently saving', () => {
    const setRequirementState = vi.fn();
    const firstRequirement = buildRequirement({
      requirementId: 'caulk-pending',
      productName: 'Dowsil 795'
    });
    const secondRequirement = buildRequirement({
      requirementId: 'caulk-ready',
      productName: 'Tremco Spectrem 1'
    });

    render(
      <CaulkRequirementsSection
        requirements={[firstRequirement, secondRequirement]}
        isPhoneLayout={false}
        isReadOnlyJob={false}
        isAuthenticated
        clientIdConfigured
        pendingRequirementStateIds={new Set(['caulk-pending'])}
        isResumeAutoPlanningPending={false}
        onSetRequirementState={setRequirementState}
        onAutoAllocateRequirement={vi.fn()}
        onResumeAutoPlanning={vi.fn()}
      />
    );

    const toggles = screen.getAllByRole('checkbox', { name: 'Active' }) as HTMLInputElement[];
    expect(toggles[0].disabled).toBe(true);
    expect(toggles[1].disabled).toBe(false);
    expect(screen.getByText('Saving...')).not.toBeNull();

    fireEvent.click(toggles[1]);

    expect(setRequirementState).toHaveBeenCalledWith(secondRequirement, 'COMPLETE');
  });

  it('keeps complete caulk rows out of resume auto-plan actions', () => {
    renderSection(
      buildRequirement({
        status: 'COMPLETE',
        isComplete: true,
        autoPlanningSuppressed: true,
        remainingTubes: 8
      })
    );

    expect(screen.queryByRole('button', { name: 'Resume auto-plan' })).toBeNull();
  });

  it('auto-allocates active caulk rows from the action column', () => {
    const autoAllocateRequirement = vi.fn();
    const requirement = buildRequirement({ allocatedTubes: 0, remainingTubes: 8 });

    renderSection(requirement, { onAutoAllocateRequirement: autoAllocateRequirement });

    fireEvent.click(screen.getByRole('button', { name: 'Auto Allocate' }));

    expect(autoAllocateRequirement).toHaveBeenCalledWith(requirement);
  });

  it('keeps Auto Allocate visible but disabled for completed caulk rows', () => {
    const autoAllocateRequirement = vi.fn();

    renderSection(
      buildRequirement({
        status: 'COMPLETE',
        isComplete: true,
        allocatedTubes: 0,
        remainingTubes: 8
      }),
      { onAutoAllocateRequirement: autoAllocateRequirement }
    );

    const autoAllocateButton = screen.getByRole('button', { name: 'Auto Allocate' });
    expect((autoAllocateButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(autoAllocateButton);
    expect(autoAllocateRequirement).not.toHaveBeenCalled();
  });
});
