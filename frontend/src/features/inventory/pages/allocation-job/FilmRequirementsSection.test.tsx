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
    const autoAllocateRequirement = vi.fn();
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
        pendingRequirementStateIds={new Set()}
        isResumeAutoPlanningPending={false}
        pendingDeleteFilmOrderIds={new Set()}
        onOrderRequirement={orderRequirement}
        onAutoAllocateRequirement={autoAllocateRequirement}
        onSetRequirementState={vi.fn()}
        onResumeAutoPlanning={resumeAutoPlanning}
        onCancelRequirementOrder={vi.fn()}
        onOrderAll={vi.fn()}
      />
    );

    expect(screen.getByText('Auto planning paused')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Order' }));
    fireEvent.click(screen.getByRole('button', { name: 'Auto Allocate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resume auto-plan' }));

    expect(orderRequirement).toHaveBeenCalledWith(requirement);
    expect(autoAllocateRequirement).toHaveBeenCalledWith(requirement);
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
        pendingRequirementStateIds={new Set()}
        isResumeAutoPlanningPending={false}
        pendingDeleteFilmOrderIds={new Set()}
        onOrderRequirement={vi.fn()}
        onAutoAllocateRequirement={vi.fn()}
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
        pendingRequirementStateIds={new Set()}
        isResumeAutoPlanningPending={false}
        pendingDeleteFilmOrderIds={new Set()}
        onOrderRequirement={vi.fn()}
        onAutoAllocateRequirement={vi.fn()}
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

  it('shows required LF before allocated, actual used, and remaining LF in the desktop table', () => {
    const { container } = render(
      <FilmRequirementsSection
        requirements={[
          buildRequirement({
            requiredFeet: 29,
            allocatedFeet: 0,
            actualUsedFeet: 29,
            remainingFeet: 0
          })
        ]}
        filmOrders={[]}
        isPhoneLayout={false}
        isReadOnlyJob={false}
        isAuthenticated
        clientIdConfigured
        isCreateFilmOrderPending={false}
        pendingRequirementStateIds={new Set()}
        isResumeAutoPlanningPending={false}
        pendingDeleteFilmOrderIds={new Set()}
        onOrderRequirement={vi.fn()}
        onAutoAllocateRequirement={vi.fn()}
        onSetRequirementState={vi.fn()}
        onResumeAutoPlanning={vi.fn()}
        onCancelRequirementOrder={vi.fn()}
        onOrderAll={vi.fn()}
      />
    );

    const headers = Array.from(container.querySelectorAll('thead th')).map((element) =>
      element.textContent?.trim()
    );
    expect(headers.slice(3, 7)).toEqual([
      'Required LF',
      'Allocated LF',
      'Actual Used LF',
      'Remaining LF'
    ]);

    const cells = Array.from(container.querySelectorAll('tbody tr:first-child td')).map((element) =>
      element.textContent?.trim()
    );
    expect(cells.slice(3, 7)).toEqual(['29', '0', '29', '0']);
  });

  it('shows required LF before allocated, actual used, and remaining LF in the mobile card', () => {
    const { container } = render(
      <FilmRequirementsSection
        requirements={[
          buildRequirement({
            requiredFeet: 29,
            allocatedFeet: 0,
            actualUsedFeet: 29,
            remainingFeet: 0
          })
        ]}
        filmOrders={[]}
        isPhoneLayout
        isReadOnlyJob={false}
        isAuthenticated
        clientIdConfigured
        isCreateFilmOrderPending={false}
        pendingRequirementStateIds={new Set()}
        isResumeAutoPlanningPending={false}
        pendingDeleteFilmOrderIds={new Set()}
        onOrderRequirement={vi.fn()}
        onAutoAllocateRequirement={vi.fn()}
        onSetRequirementState={vi.fn()}
        onResumeAutoPlanning={vi.fn()}
        onCancelRequirementOrder={vi.fn()}
        onOrderAll={vi.fn()}
      />
    );

    const labels = Array.from(container.querySelectorAll('.mobile-field-label')).map((element) =>
      element.textContent?.trim()
    );
    const values = Array.from(container.querySelectorAll('.mobile-field-value')).map((element) =>
      element.textContent?.trim()
    );

    expect(labels.slice(0, 4)).toEqual([
      'Required LF',
      'Allocated LF',
      'Actual Used LF',
      'Remaining LF'
    ]);
    expect(values.slice(0, 4)).toEqual(['29', '0', '29', '0']);
  });

  it('hides planning-only LF columns from the visible table', () => {
    render(
      <FilmRequirementsSection
        requirements={[
          buildRequirement({
            requiredFeet: 100,
            allocatedFeet: 60,
            remainingFeet: 40
          })
        ]}
        filmOrders={[]}
        isPhoneLayout={false}
        isReadOnlyJob={false}
        isAuthenticated
        clientIdConfigured
        isCreateFilmOrderPending={false}
        pendingRequirementStateIds={new Set()}
        isResumeAutoPlanningPending={false}
        pendingDeleteFilmOrderIds={new Set()}
        onOrderRequirement={vi.fn()}
        onAutoAllocateRequirement={vi.fn()}
        onSetRequirementState={vi.fn()}
        onResumeAutoPlanning={vi.fn()}
        onCancelRequirementOrder={vi.fn()}
        onOrderAll={vi.fn()}
      />
    );

    expect(screen.queryByText('Planned LF')).toBeNull();
    expect(screen.queryByText('Locked LF')).toBeNull();
    expect(screen.queryByText('Placeholder LF')).toBeNull();
    expect(screen.getByText('Required LF')).not.toBeNull();
    expect(screen.getByText('Allocated LF')).not.toBeNull();
    expect(screen.getByText('Actual Used LF')).not.toBeNull();
    expect(screen.getByText('Remaining LF')).not.toBeNull();
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
        pendingRequirementStateIds={new Set()}
        isResumeAutoPlanningPending={false}
        pendingDeleteFilmOrderIds={new Set()}
        onOrderRequirement={vi.fn()}
        onAutoAllocateRequirement={vi.fn()}
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
        pendingRequirementStateIds={new Set()}
        isResumeAutoPlanningPending={false}
        pendingDeleteFilmOrderIds={new Set()}
        onOrderRequirement={vi.fn()}
        onAutoAllocateRequirement={vi.fn()}
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
        pendingRequirementStateIds={new Set()}
        isResumeAutoPlanningPending={false}
        pendingDeleteFilmOrderIds={new Set()}
        onOrderRequirement={vi.fn()}
        onAutoAllocateRequirement={vi.fn()}
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

  it('only disables the requirement row currently saving', () => {
    const setRequirementState = vi.fn();
    const firstRequirement = buildRequirement({
      requirementId: 'req-pending',
      filmName: 'Night Vision 15'
    });
    const secondRequirement = buildRequirement({
      requirementId: 'req-ready',
      filmName: 'Prestige 40'
    });

    render(
      <FilmRequirementsSection
        requirements={[firstRequirement, secondRequirement]}
        filmOrders={[]}
        isPhoneLayout={false}
        isReadOnlyJob={false}
        isAuthenticated
        clientIdConfigured
        isCreateFilmOrderPending={false}
        pendingRequirementStateIds={new Set(['req-pending'])}
        isResumeAutoPlanningPending={false}
        pendingDeleteFilmOrderIds={new Set()}
        onOrderRequirement={vi.fn()}
        onAutoAllocateRequirement={vi.fn()}
        onSetRequirementState={setRequirementState}
        onResumeAutoPlanning={vi.fn()}
        onCancelRequirementOrder={vi.fn()}
        onOrderAll={vi.fn()}
      />
    );

    const toggles = screen.getAllByRole('checkbox', { name: 'Active' }) as HTMLInputElement[];
    expect(toggles[0].disabled).toBe(true);
    expect(toggles[1].disabled).toBe(false);
    expect(screen.getByText('Saving...')).not.toBeNull();

    fireEvent.click(toggles[1]);

    expect(setRequirementState).toHaveBeenCalledWith(secondRequirement, 'COMPLETE');
  });

  it('keeps Order and Auto Allocate visible but disabled for completed requirements', () => {
    const orderRequirement = vi.fn();
    const autoAllocateRequirement = vi.fn();
    render(
      <FilmRequirementsSection
        requirements={[
          buildRequirement({
            status: 'COMPLETE',
            isComplete: true,
            remainingFeet: 40
          })
        ]}
        filmOrders={[]}
        isPhoneLayout={false}
        isReadOnlyJob={false}
        isAuthenticated
        clientIdConfigured
        isCreateFilmOrderPending={false}
        pendingRequirementStateIds={new Set()}
        isResumeAutoPlanningPending={false}
        pendingDeleteFilmOrderIds={new Set()}
        onOrderRequirement={orderRequirement}
        onAutoAllocateRequirement={autoAllocateRequirement}
        onSetRequirementState={vi.fn()}
        onResumeAutoPlanning={vi.fn()}
        onCancelRequirementOrder={vi.fn()}
        onOrderAll={vi.fn()}
      />
    );

    const orderButton = screen.getByRole('button', { name: 'Order' });
    const autoAllocateButton = screen.getByRole('button', { name: 'Auto Allocate' });
    expect((orderButton as HTMLButtonElement).disabled).toBe(true);
    expect((autoAllocateButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(orderButton);
    fireEvent.click(autoAllocateButton);
    expect(orderRequirement).not.toHaveBeenCalled();
    expect(autoAllocateRequirement).not.toHaveBeenCalled();
  });
});
