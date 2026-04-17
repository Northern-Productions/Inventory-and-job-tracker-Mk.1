// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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

describe('RelatedFilmOrdersSection', () => {
  it('labels manual and auto-shortage orders and shows the shortage source box', () => {
    render(
      <RelatedFilmOrdersSection
        orders={[
          buildFilmOrderEntry({ filmOrderId: 'FO-AUTO', sourceBoxId: 'IL1-6923' }),
          buildFilmOrderEntry({
            filmOrderId: 'FO-MANUAL',
            filmName: 'Manual Roll',
            sourceBoxId: ''
          })
        ]}
        isPhoneLayout={false}
        isReadOnlyJob={false}
        pendingDeleteFilmOrderIds={new Set()}
        onOrderFilm={vi.fn()}
        onDeleteOrder={vi.fn()}
      />
    );

    expect(
      screen.getByText(
        'Manual orders are created from Film Orders. Auto shortage orders appear after return/weigh or schedule rebalance.'
      )
    ).toBeTruthy();
    expect(screen.getByText('Auto shortage')).toBeTruthy();
    expect(screen.getByText('Source box: IL1-6923')).toBeTruthy();
    expect(screen.getByText('Manual')).toBeTruthy();
  });
});
