// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
    workflowStatus: 'ACTIVE',
    isPlaceholder: false,
    isWorkflowActive: true,
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
  focusedPhaseId = '',
  requirements = [] as JobRequirementLine[],
  onSetPhaseState = vi.fn(),
  onSetPhaseWorkflowState = vi.fn(),
} = {}) {
  const props = {
    phases,
    focusedPhaseId,
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
    onAutoAllocateRequirement: vi.fn(),
    onAutoAllocateCaulkRequirement: vi.fn(),
    onSetRequirementState: vi.fn(),
    onSetCaulkRequirementState: vi.fn(),
    onSetPhaseState,
    onSetPhaseWorkflowState,
    onResumeAutoPlanning: vi.fn(),
    onResumeCaulkAutoPlanning: vi.fn(),
    onCancelRequirementOrder: vi.fn(),
    onOrderAll: vi.fn(),
  };

  return {
    ...render(<JobPhasesSection {...props} />),
    onSetPhaseState,
    onSetPhaseWorkflowState,
  };
}

describe('JobPhasesSection', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
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
    const { container } = renderPhases({ onSetPhaseState });

    const laborToggle = container.querySelector('.phase-labor-toggle input');
    expect(laborToggle).not.toBeNull();
    fireEvent.click(laborToggle as HTMLInputElement);

    expect(onSetPhaseState).toHaveBeenCalledWith(expect.objectContaining({ phaseId: 'phase-1' }), 'COMPLETE');
  });

  it('toggles phase workflow state between Active and Placeholder', () => {
    const onSetPhaseWorkflowState = vi.fn();
    renderPhases({
      onSetPhaseWorkflowState,
      phases: [
        buildPhase({
          phaseId: 'phase-2',
          phaseNumber: 2,
          workflowStatus: 'PLACEHOLDER',
          isPlaceholder: true,
          isWorkflowActive: false,
          isExpandedByDefault: true,
        }),
      ],
      requirements: [buildRequirement({ phaseId: 'phase-2', phaseNumber: 2 })],
    });

    const toggle = screen.getByRole('group', { name: 'Phase 2 workflow state' });
    expect(within(toggle).getByRole('button', { name: 'Placeholder' }).getAttribute('aria-pressed')).toBe(
      'true'
    );

    fireEvent.click(within(toggle).getByRole('button', { name: 'Active' }));

    expect(onSetPhaseWorkflowState).toHaveBeenCalledWith(
      expect.objectContaining({ phaseId: 'phase-2' }),
      'ACTIVE'
    );
  });

  it('allows phase 1 to switch from Active to Placeholder', () => {
    const onSetPhaseWorkflowState = vi.fn();
    renderPhases({
      onSetPhaseWorkflowState,
      requirements: [buildRequirement()],
    });

    const toggle = screen.getByRole('group', { name: 'Phase 1 workflow state' });
    expect(within(toggle).getByRole('button', { name: 'Active' }).getAttribute('aria-pressed')).toBe(
      'true'
    );

    fireEvent.click(within(toggle).getByRole('button', { name: 'Placeholder' }));

    expect(onSetPhaseWorkflowState).toHaveBeenCalledWith(
      expect.objectContaining({ phaseId: 'phase-1' }),
      'PLACEHOLDER'
    );
  });

  it('expands, scrolls, focuses, and highlights a targeted phase', async () => {
    vi.useFakeTimers();
    const scrollIntoViewMock = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoViewMock,
    });
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    const { container } = renderPhases({
      focusedPhaseId: 'phase-2',
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

    await act(async () => {});
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);

    const targetPhase = container.querySelector('[data-phase-id="phase-2"]');
    expect(targetPhase?.className).toContain('job-phase-card-targeted');
    expect(targetPhase?.getAttribute('id')).toBe('job-phase-phase-2');
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    expect(screen.getAllByRole('button', { name: 'Collapse phase' })).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(2400);
    });

    expect(targetPhase?.className).not.toContain('job-phase-card-targeted');
  });

  it('falls back without scrolling when a targeted phase is missing', () => {
    const scrollIntoViewMock = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoViewMock,
    });

    renderPhases({ focusedPhaseId: 'missing-phase' });

    expect(scrollIntoViewMock).not.toHaveBeenCalled();
    expect(screen.getByText('Phase 1 — Sections 1, 2, 3')).not.toBeNull();
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
        onAutoAllocateRequirement={vi.fn()}
        onAutoAllocateCaulkRequirement={vi.fn()}
        onSetRequirementState={vi.fn()}
        onSetCaulkRequirementState={vi.fn()}
        onSetPhaseState={vi.fn()}
        onSetPhaseWorkflowState={vi.fn()}
        onResumeAutoPlanning={vi.fn()}
        onResumeCaulkAutoPlanning={vi.fn()}
        onCancelRequirementOrder={vi.fn()}
        onOrderAll={vi.fn()}
      />
    );

    expect(screen.getByLabelText('Overused')).not.toBeNull();
  });
});
