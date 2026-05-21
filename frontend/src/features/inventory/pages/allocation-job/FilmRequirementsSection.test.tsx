// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { FilmOrderEntry, JobRequirementLine } from '../../../../domain';
import { FilmRequirementsSection } from './FilmRequirementsSection';

function buildRequirement(overrides: Partial<JobRequirementLine> = {}): JobRequirementLine {
  return {
    requirementId: 'req-1',
    manufacturer: '3M',
    filmName: 'Night Vision 15',
    widthIn: 36,
    requiredFeet: 100,
    status: 'ACTIVE',
    isComplete: false,
    actualUsedFeet: 0,
    completionResult: '',
    allocatedFeet: 60,
    remainingFeet: 40,
    autoPlanningSuppressed: false,
    ...overrides
  };
}

function buildFilmOrder(overrides: Partial<FilmOrderEntry> = {}): FilmOrderEntry {
  return {
    filmOrderId: 'FO-1',
    jobNumber: '4803',
    warehouse: 'IL1',
    manufacturer: '3M',
    filmName: 'Night Vision 15',
    widthIn: 36,
    requestedFeet: 40,
    coveredFeet: 0,
    orderedFeet: 0,
    remainingToOrderFeet: 40,
    installDate: '2026-04-25',
    crewLeader: 'Crew',
    status: 'FILM_ORDER',
    sourceBoxId: '',
    createdAt: '2026-04-25T00:00:00.000Z',
    createdBy: 'tester',
    resolvedAt: '',
    resolvedBy: '',
    notes: '',
    linkedBoxes: [],
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
        isRequirementStatePending={false}
        isResumeAutoPlanningPending={false}
        pendingDeleteFilmOrderIds={new Set()}
        onOrderRequirement={orderRequirement}
        onSetRequirementState={vi.fn()}
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

  it('labels the unresolved film-order row action as Cancel Order', () => {
    const cancelRequirementOrder = vi.fn();
    const requirement = buildRequirement();
    const order = buildFilmOrder();

    render(
      <FilmRequirementsSection
        requirements={[requirement]}
        filmOrders={[order]}
        isPhoneLayout={false}
        isReadOnlyJob={false}
        isAuthenticated
        clientIdConfigured
        isCreateFilmOrderPending={false}
        isRequirementStatePending={false}
        isResumeAutoPlanningPending={false}
        pendingDeleteFilmOrderIds={new Set()}
        onOrderRequirement={vi.fn()}
        onSetRequirementState={vi.fn()}
        onResumeAutoPlanning={vi.fn()}
        onCancelRequirementOrder={cancelRequirementOrder}
        onOrderAll={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel Order' }));

    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(cancelRequirementOrder).toHaveBeenCalledWith(order);
  });

  it('shows actual used LF and hides final judgment while active', () => {
    render(
      <FilmRequirementsSection
        requirements={[buildRequirement({ actualUsedFeet: 20 })]}
        filmOrders={[]}
        isPhoneLayout={false}
        isReadOnlyJob={false}
        isAuthenticated
        clientIdConfigured
        isCreateFilmOrderPending={false}
        isRequirementStatePending={false}
        isResumeAutoPlanningPending={false}
        pendingDeleteFilmOrderIds={new Set()}
        onOrderRequirement={vi.fn()}
        onSetRequirementState={vi.fn()}
        onResumeAutoPlanning={vi.fn()}
        onCancelRequirementOrder={vi.fn()}
        onOrderAll={vi.fn()}
      />
    );

    expect(screen.getByText('Actual Used LF')).not.toBeNull();
    expect(screen.getByText('20')).not.toBeNull();
    expect(screen.queryByLabelText('On target')).toBeNull();
    expect(screen.queryByLabelText('Overused')).toBeNull();
  });

  it('marks completed requirements green when actual use is on target', () => {
    render(
      <FilmRequirementsSection
        requirements={[buildRequirement({ status: 'COMPLETE', isComplete: true, actualUsedFeet: 100 })]}
        filmOrders={[]}
        isPhoneLayout={false}
        isReadOnlyJob={false}
        isAuthenticated
        clientIdConfigured
        isCreateFilmOrderPending={false}
        isRequirementStatePending={false}
        isResumeAutoPlanningPending={false}
        pendingDeleteFilmOrderIds={new Set()}
        onOrderRequirement={vi.fn()}
        onSetRequirementState={vi.fn()}
        onResumeAutoPlanning={vi.fn()}
        onCancelRequirementOrder={vi.fn()}
        onOrderAll={vi.fn()}
      />
    );

    expect(screen.getByLabelText('On target')).not.toBeNull();
  });

  it('marks completed requirements red when actual use is over planned LF', () => {
    render(
      <FilmRequirementsSection
        requirements={[buildRequirement({ status: 'COMPLETE', isComplete: true, actualUsedFeet: 101 })]}
        filmOrders={[]}
        isPhoneLayout={false}
        isReadOnlyJob={false}
        isAuthenticated
        clientIdConfigured
        isCreateFilmOrderPending={false}
        isRequirementStatePending={false}
        isResumeAutoPlanningPending={false}
        pendingDeleteFilmOrderIds={new Set()}
        onOrderRequirement={vi.fn()}
        onSetRequirementState={vi.fn()}
        onResumeAutoPlanning={vi.fn()}
        onCancelRequirementOrder={vi.fn()}
        onOrderAll={vi.fn()}
      />
    );

    expect(screen.getByLabelText('Overused')).not.toBeNull();
  });

  it('toggles requirement state without changing actual used LF', () => {
    const setRequirementState = vi.fn();
    const requirement = buildRequirement({ actualUsedFeet: 28 });

    render(
      <FilmRequirementsSection
        requirements={[requirement]}
        filmOrders={[]}
        isPhoneLayout={false}
        isReadOnlyJob={false}
        isAuthenticated
        clientIdConfigured
        isCreateFilmOrderPending={false}
        isRequirementStatePending={false}
        isResumeAutoPlanningPending={false}
        pendingDeleteFilmOrderIds={new Set()}
        onOrderRequirement={vi.fn()}
        onSetRequirementState={setRequirementState}
        onResumeAutoPlanning={vi.fn()}
        onCancelRequirementOrder={vi.fn()}
        onOrderAll={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Active' }));

    expect(setRequirementState).toHaveBeenCalledWith(requirement, 'COMPLETE');
    expect(screen.getByText('28')).not.toBeNull();
  });
});
