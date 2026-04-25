// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { JobRequirementLine } from '../../../../domain';
import { FilmRequirementsSection } from './FilmRequirementsSection';

function buildRequirement(overrides: Partial<JobRequirementLine> = {}): JobRequirementLine {
  return {
    requirementId: 'req-1',
    manufacturer: '3M',
    filmName: 'Night Vision 15',
    widthIn: 36,
    requiredFeet: 100,
    allocatedFeet: 60,
    remainingFeet: 40,
    autoPlanningSuppressed: false,
    ...overrides
  };
}

describe('FilmRequirementsSection planner suppression actions', () => {
  afterEach(() => {
    cleanup();
  });

  it('keeps Order available and exposes Resume auto-plan for suppressed unmet requirements', () => {
    const orderRequirement = vi.fn();
    const resumeAutoPlanning = vi.fn();
    const requirement = buildRequirement({ autoPlanningSuppressed: true });

    render(
      <FilmRequirementsSection
        requirements={[requirement]}
        filmOrders={[]}
        isPhoneLayout={false}
        isReadOnlyJob={false}
        isAuthenticated
        clientIdConfigured
        isCreateFilmOrderPending={false}
        isResumeAutoPlanningPending={false}
        pendingDeleteFilmOrderIds={new Set()}
        onOrderRequirement={orderRequirement}
        onResumeAutoPlanning={resumeAutoPlanning}
        onCancelRequirementOrder={vi.fn()}
        onOrderAll={vi.fn()}
      />
    );

    expect(screen.getByText('Auto planning paused')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Order' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resume auto-plan' }));

    expect(orderRequirement).toHaveBeenCalledWith(requirement);
    expect(resumeAutoPlanning).toHaveBeenCalledWith(requirement);
  });
});
