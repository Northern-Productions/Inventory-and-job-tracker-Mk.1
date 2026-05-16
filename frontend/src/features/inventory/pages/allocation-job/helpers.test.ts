import { describe, expect, it } from 'vitest';
import type { FilmOrderEntry } from '../../../../domain';
import { buildAddBoxTarget } from './helpers';

function buildFilmOrderEntry(overrides: Partial<FilmOrderEntry> = {}): FilmOrderEntry {
  return {
    filmOrderId: 'FO-1',
    requirementId: 'req-1',
    jobNumber: '2941',
    warehouse: 'IL1',
    manufacturer: '3M Solar',
    filmName: 'Prestige 60',
    widthIn: 72,
    requestedFeet: 123,
    coveredFeet: 0,
    orderedFeet: 0,
    remainingToOrderFeet: 123,
    installDate: '2026-04-13',
    crewLeader: 'Crew',
    status: 'FILM_ORDER',
    sourceBoxId: '',
    createdAt: '2026-04-06T00:00:00Z',
    createdBy: 'tester',
    resolvedAt: '',
    resolvedBy: '',
    notes: '',
    linkedBoxes: [],
    ...overrides
  };
}

describe('allocation job helpers', () => {
  it('includes additive jobId in add-box film-order prefill links when available', () => {
    const target = buildAddBoxTarget(
      buildFilmOrderEntry({
        jobId: '11111111-1111-4111-8111-111111111111'
      })
    );
    const params = new URLSearchParams(target.split('?')[1]);

    expect(target.startsWith('/inventory/add?')).toBe(true);
    expect(params.get('jobId')).toBe('11111111-1111-4111-8111-111111111111');
    expect(params.get('jobNumber')).toBe('2941');
  });

  it('keeps legacy add-box prefill links when jobId is unavailable', () => {
    const target = buildAddBoxTarget(buildFilmOrderEntry());
    const params = new URLSearchParams(target.split('?')[1]);

    expect(params.has('jobId')).toBe(false);
    expect(params.get('jobNumber')).toBe('2941');
  });
});
