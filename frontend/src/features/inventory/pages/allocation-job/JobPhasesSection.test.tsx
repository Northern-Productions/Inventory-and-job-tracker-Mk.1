// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FilmOrderEntry, JobPhase, JobRequirementLine } from '../../../../domain';
import { JobPhasesSection } from './JobPhasesSection';

function buildPhase(overrides: Partial<JobPhase> = {}): JobPhase {
  return {
    phaseId: 'phase-1',
    phaseNumber: 1,
    workScope: 'Sections 1, 2, 3',
    sections: 'Sections 1, 2, 3',
    installDate: '2026-05-21',
    crewLeader: 'Alexis',
    laborStatus: 'ACTIVE',
    status: 'READY',
    isComplete: false,
    isPrimary: true,
    isNextRelevant: true,
    isExpandedByDefault: true,
    requiredFeet: 0,
    allocatedFeet: 0,
    remainingFeet: 0,
    requiredTubes: 0,
    allocatedTubes: 0,
    remainingTubes: 0,
    requirementCount: 0,
    caulkRequirementCount: 0,
    filmOrderCount: 0,
    allocationCount: 0,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

function buildRequirement(overrides: Partial<JobRequirementLine> = {}): JobRequirementLine {
  return {
    requirementId: 'req-1',
    phaseId: 'phase-1',
    phaseNumber: 1,
    manufacturer: '3M',
    filmName: 'Prestige 40',
    widthIn: 60,
    requiredFeet: 25,
    status: 'ACTIVE',
    isComplete: false,
    actualUsedFeet: 0,
    completionResult: '',
    allocatedFeet: 0,
    remainingFeet: 25,
    autoPlanningSuppressed: false,
    ...overrides,
  };
}

function renderPhases({
  phases = [buildPhase()],
  requirements = [] as JobRequirementLine[],
  onSetPhaseState = vi.fn(),
} = {}) {
  const props = {
    phases,
    requirements,
    caulkRequirements: [],
    filmOrders: [] as FilmOrderEntry[],
    isPhoneLayout: false,
    isReadOnlyJob: false,
    isAuthenticated: true,
    clientIdConfigured: true,
    canOrderAll: false,
    isCreateFilmOrderPending: false,
    isRequirementStatePending: false,
    isPhaseStatePending: false,
    isResumeAutoPlanningPending: false,
    pendingDeleteFilmOrderIds: new Set<string>(),
    onOrderRequirement: vi.fn(),
    onSetRequirementState: vi.fn(),
    onSetCaulkRequirementState: vi.fn(),
    onSetPhaseState,
    onResumeAutoPlanning: vi.fn(),
    onResumeCaulkAutoPlanning: vi.fn(),
    onCancelRequirementOrder: vi.fn(),
    onOrderAll: vi.fn(),
  };

  return {
    ...render(<JobPhasesSection {...props} />),
    onSetPhaseState,
  };
}

describe('JobPhasesSection', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders phase cards and expands the next relevant phase by default', () => {
    renderPhases({
      phases: [
        buildPhase(),
        buildPhase({
          phaseId: 'phase-2',
          phaseNumber: 2,
          workScope: 'Section 7',
          sections: 'Section 7',
          installDate: '2026-06-01',
          isNextRelevant: false,
          isExpandedByDefault: false,
        }),
      ],
    });

    expect(screen.getByText('Phase 1 — Sections 1, 2, 3')).not.toBeNull();
    expect(screen.getByText('Phase 2 — Section 7')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Collapse phase' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Expand phase' })).not.toBeNull();
  });

  it('toggles labor-only phase state without requiring a film requirement', () => {
    const onSetPhaseState = vi.fn();
    renderPhases({ onSetPhaseState });

    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Active' })[0]);

    expect(onSetPhaseState).toHaveBeenCalledWith(expect.objectContaining({ phaseId: 'phase-1' }), 'COMPLETE');
  });

  it('shows the completion result only for completed film requirements', () => {
    const { rerender } = renderPhases({
      requirements: [
        buildRequirement({
          status: 'ACTIVE',
          actualUsedFeet: 28,
          completionResult: '',
        }),
      ],
    });

    expect(screen.queryByLabelText('Overused')).toBeNull();

    rerender(
      <JobPhasesSection
        phases={[buildPhase({ requiredFeet: 25, remainingFeet: 0, requirementCount: 1 })]}
        requirements={[
          buildRequirement({
            status: 'COMPLETE',
            isComplete: true,
            actualUsedFeet: 28,
            remainingFeet: 0,
            completionResult: 'OVERUSED',
          }),
        ]}
        caulkRequirements={[]}
        filmOrders={[]}
        isPhoneLayout={false}
        isReadOnlyJob={false}
        isAuthenticated
        clientIdConfigured
        canOrderAll={false}
        isCreateFilmOrderPending={false}
        isRequirementStatePending={false}
        isPhaseStatePending={false}
        isResumeAutoPlanningPending={false}
        pendingDeleteFilmOrderIds={new Set()}
        onOrderRequirement={vi.fn()}
        onSetRequirementState={vi.fn()}
        onSetCaulkRequirementState={vi.fn()}
        onSetPhaseState={vi.fn()}
        onResumeAutoPlanning={vi.fn()}
        onResumeCaulkAutoPlanning={vi.fn()}
        onCancelRequirementOrder={vi.fn()}
        onOrderAll={vi.fn()}
      />
    );

    expect(screen.getByLabelText('Overused')).not.toBeNull();
  });
});
