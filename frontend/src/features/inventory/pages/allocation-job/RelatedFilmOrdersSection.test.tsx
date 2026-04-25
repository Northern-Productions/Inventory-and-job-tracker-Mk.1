// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FilmOrderEntry } from '../../../../domain';
import { RelatedFilmOrdersSection } from './RelatedFilmOrdersSection';

function buildFilmOrderEntry(overrides: Partial<FilmOrderEntry> = {}): FilmOrderEntry {
  return {
    filmOrderId: 'FO-1',
    jobNumber: '4447',
    warehouse: 'IL1',
    manufacturer: 'Security',
    filmName: '3M Ultra S800',
    widthIn: 60,
    requestedFeet: 41,
    coveredFeet: 0,
    orderedFeet: 0,
    remainingToOrderFeet: 41,
    installDate: '2026-04-24',
    crewLeader: 'Napo',
    status: 'FILM_ORDER',
    sourceBoxId: '',
    createdAt: '2026-04-16T18:18:00.000Z',
    createdBy: 'tester',
    resolvedAt: '',
    resolvedBy: '',
    notes: '',
    linkedBoxes: [],
    ...overrides
  };
}

afterEach(() => {
  cleanup();
});

describe('RelatedFilmOrdersSection', () => {
  it('shows linked ordered box ids as box-detail links while keeping shortage source boxes separate', () => {
    render(
      <MemoryRouter>
        <RelatedFilmOrdersSection
          orders={[
            buildFilmOrderEntry({
              filmOrderId: 'FO-AUTO',
              filmName: 'Auto Roll',
              sourceBoxId: 'IL1-6923',
              linkedBoxes: [
                { boxId: 'MS1-0042', orderedFeet: 30, autoAllocatedFeet: 0, isReceived: false },
                { boxId: 'IL1-0005', orderedFeet: 30, autoAllocatedFeet: 0, isReceived: true }
              ]
            }),
            buildFilmOrderEntry({
              filmOrderId: 'FO-MANUAL',
              filmName: 'Manual Roll',
              sourceBoxId: '',
              linkedBoxes: []
            })
          ]}
          isPhoneLayout={false}
          isReadOnlyJob={false}
          pendingDeleteFilmOrderIds={new Set()}
          onOrderFilm={vi.fn()}
          onDeleteOrder={vi.fn()}
        />
      </MemoryRouter>
    );

    expect(
      screen.getByText(
        'Manual orders are created only from explicit order actions. Cancel an unresolved order before creating another for the same film requirement.'
      )
    ).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Ordered Box IDs' })).toBeTruthy();
    expect(screen.getByText('Auto shortage')).toBeTruthy();
    expect(screen.getByText('Source box: IL1-6923')).toBeTruthy();
    expect(screen.getByText('Manual')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'IL1-0005' }).getAttribute('href')).toBe(
      '/inventory/IL1-0005'
    );
    expect(screen.getByLabelText('Received IL1-0005')).toBeTruthy();
    expect(screen.queryByLabelText('Received MS1-0042')).toBeNull();
    expect(screen.getByRole('link', { name: 'MS1-0042' }).getAttribute('href')).toBe(
      '/inventory/MS1-0042'
    );
    const manualRow = screen.getByText(/Manual Roll/, { selector: 'td' }).closest('tr');
    expect(manualRow).toBeTruthy();
    expect(within(manualRow as HTMLTableRowElement).getByText('--')).toBeTruthy();
  });

  it('renders the ordered box ids field on mobile cards', () => {
    render(
      <MemoryRouter>
        <RelatedFilmOrdersSection
          orders={[
            buildFilmOrderEntry({
              linkedBoxes: [{ boxId: 'IL1-0042', orderedFeet: 42, autoAllocatedFeet: 0, isReceived: true }]
            })
          ]}
          isPhoneLayout
          isReadOnlyJob={false}
          pendingDeleteFilmOrderIds={new Set()}
          onOrderFilm={vi.fn()}
          onDeleteOrder={vi.fn()}
        />
      </MemoryRouter>
    );

    expect(screen.getByText('Ordered Box IDs')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'IL1-0042' }).getAttribute('href')).toBe(
      '/inventory/IL1-0042'
    );
    expect(screen.getByLabelText('Received IL1-0042')).toBeTruthy();
  });
});
