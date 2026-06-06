// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilmWeightPendingReviewEntry, FilmWeightProfileEntry } from '../../../domain';
import WeightChartPage from './WeightChartPage';

const useFilmWeightProfilesMock = vi.fn();
const useFilmWeightPendingReviewsMock = vi.fn();

vi.mock('../hooks/useInventoryQueries', () => ({
  useFilmWeightProfiles: () => useFilmWeightProfilesMock(),
  useFilmWeightPendingReviews: () => useFilmWeightPendingReviewsMock()
}));

function buildQueryState<T>(data: T, overrides: Record<string, unknown> = {}) {
  return {
    data,
    isLoading: false,
    isError: false,
    error: null,
    ...overrides
  };
}

function buildProfile(overrides: Partial<FilmWeightProfileEntry> = {}): FilmWeightProfileEntry {
  return {
    profileId: 'profile-1',
    manufacturer: '3M Solar',
    filmName: 'Night Vision 35',
    filmKey: '3m-solar|night-vision-35',
    coreType: '3IN',
    coreWeightLbs: 3.2,
    averageLbsPerSqFt: 0.012,
    averageNormalizedLbsPerInchFoot: 0.001,
    acceptedSampleCount: 2,
    pendingReviewCount: 1,
    confidence: 'needs_review',
    status: 'needs_review',
    observedWidths: [36, 72],
    widthSummaries: [
      {
        widthIn: 36,
        maxRecordedLf: 105,
        acceptedSampleCount: 1,
        lastSampleAt: '2026-06-02T12:00:00Z'
      },
      {
        widthIn: 72,
        maxRecordedLf: 100,
        acceptedSampleCount: 1,
        lastSampleAt: '2026-06-03T12:00:00Z'
      }
    ],
    firstSampleAt: '2026-06-01T12:00:00Z',
    lastSampleAt: '2026-06-03T12:00:00Z',
    lastReviewAt: '',
    manuallyOverridden: false,
    notes: '',
    updatedAt: '2026-06-03T12:00:00Z',
    ...overrides
  };
}

function buildPendingReview(overrides: Partial<FilmWeightPendingReviewEntry> = {}): FilmWeightPendingReviewEntry {
  return {
    reviewId: 'review-1',
    profileId: 'profile-1',
    sampleId: 'sample-1',
    boxId: 'IL1-FWC-434829793120',
    manufacturer: '3M Solar',
    filmName: 'Night Vision 35',
    filmKey: '3m-solar|night-vision-35',
    widthIn: 72,
    recordedLf: 100,
    measuredRollWeightLbs: 18.4,
    coreType: '3IN',
    coreWeightLbs: 3.2,
    estimatedLf: 84,
    lfError: 16,
    reason: 'outside_10_lf_tolerance',
    reasons: ['outside_10_lf_tolerance'],
    suggestedAction: 'approve_sample',
    status: 'open',
    profileConfidence: 'needs_review',
    profileStatus: 'needs_review',
    createdAt: '2026-06-03T12:00:00Z',
    notes: '',
    ...overrides
  };
}

describe('WeightChartPage', () => {
  beforeEach(() => {
    useFilmWeightProfilesMock.mockReturnValue(buildQueryState([buildProfile()]));
    useFilmWeightPendingReviewsMock.mockReturnValue(buildQueryState([buildPendingReview()]));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders a chart-focused Weight Chart page with filters and chart rows', () => {
    render(<WeightChartPage />);

    expect(screen.getByRole('heading', { name: 'Weight Chart' })).toBeTruthy();
    expect(
      screen.getByText(
        'Charts are built from trusted received and weighed ordered film, using accepted sample LF, width, roll weight, and core data.'
      )
    ).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Profiles' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Pending Review' })).toBeNull();
    expect(screen.getByText('1 charts')).toBeTruthy();
    expect(screen.getByText('1 samples need review')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Manufacturer' })).toBeTruthy();
    expect(screen.getByLabelText('Film Name')).toBeTruthy();
    expect(screen.queryByLabelText('Width')).toBeNull();
    expect(screen.queryByLabelText('Core Type')).toBeNull();
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent?.trim())).toEqual([
      'Manufacturer',
      'Film Name',
      'Widths Available',
      'Accepted Samples',
      'Last Sample / Updated',
      'Action'
    ]);
    expect(screen.queryByRole('columnheader', { name: 'Core Type' })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Confidence' })).toBeNull();
    expect(screen.getByText('Night Vision 35')).toBeTruthy();
    expect(screen.getByText('36", 72"')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Chart' })).toBeTruthy();
  });

  it('renders unique sorted manufacturer dropdown options with All manufacturers selected by default', () => {
    useFilmWeightProfilesMock.mockReturnValue(
      buildQueryState([
        buildProfile({ manufacturer: 'Madico', profileId: 'profile-madico' }),
        buildProfile({ manufacturer: '3M Solar', profileId: 'profile-3m' }),
        buildProfile({ manufacturer: 'madico', profileId: 'profile-madico-duplicate' }),
        buildProfile({ manufacturer: 'Llumar', profileId: 'profile-llumar' })
      ])
    );

    render(<WeightChartPage />);

    const manufacturerSelect = screen.getByRole('combobox', {
      name: 'Manufacturer'
    }) as HTMLSelectElement;
    expect(manufacturerSelect.value).toBe('all');
    expect(
      within(manufacturerSelect)
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['All manufacturers', '3M Solar', 'Llumar', 'Madico']);
  });

  it('filters chart profiles by manufacturer and film name while preserving width table data', () => {
    useFilmWeightProfilesMock.mockReturnValue(
      buildQueryState([
        buildProfile(),
        buildProfile({
          profileId: 'profile-2',
          manufacturer: 'Madico',
          filmName: 'SafetyShield 800',
          coreType: '6IN',
          confidence: 'solid',
          status: 'active',
          observedWidths: [60],
          widthSummaries: [
            {
              widthIn: 60,
              maxRecordedLf: 98,
              acceptedSampleCount: 4,
              lastSampleAt: '2026-06-04T12:00:00Z'
            }
          ],
          acceptedSampleCount: 4,
          pendingReviewCount: 0
        })
      ])
    );

    render(<WeightChartPage />);

    fireEvent.change(screen.getByRole('combobox', { name: 'Manufacturer' }), {
      target: { value: 'Madico' }
    });
    expect(screen.queryByText('Night Vision 35')).toBeNull();
    expect(screen.getByText('SafetyShield 800')).toBeTruthy();
    expect(screen.getByText('60"')).toBeTruthy();
    expect(screen.queryByText('6IN')).toBeNull();
    expect(screen.queryByText('Solid')).toBeNull();

    fireEvent.change(screen.getByLabelText('Film Name'), {
      target: { value: 'safety' }
    });

    expect(screen.getByText('SafetyShield 800')).toBeTruthy();
    expect(screen.queryByText('Night Vision 35')).toBeNull();

    fireEvent.change(screen.getByRole('combobox', { name: 'Manufacturer' }), {
      target: { value: 'all' }
    });
    fireEvent.change(screen.getByLabelText('Film Name'), {
      target: { value: '' }
    });

    expect(screen.getByText('Night Vision 35')).toBeTruthy();
    expect(screen.getByText('SafetyShield 800')).toBeTruthy();
  });

  it('shows the empty state when manufacturer and film name filters have no matching chart', () => {
    useFilmWeightProfilesMock.mockReturnValue(
      buildQueryState([
        buildProfile(),
        buildProfile({
          profileId: 'profile-2',
          manufacturer: 'Madico',
          filmName: 'SafetyShield 800'
        })
      ])
    );

    render(<WeightChartPage />);

    fireEvent.change(screen.getByRole('combobox', { name: 'Manufacturer' }), {
      target: { value: 'Madico' }
    });
    fireEvent.change(screen.getByLabelText('Film Name'), {
      target: { value: 'night' }
    });

    expect(screen.queryByText('Night Vision 35')).toBeNull();
    expect(screen.queryByText('SafetyShield 800')).toBeNull();
    expect(screen.getByText(/No film weight charts match these filters yet/u)).toBeTruthy();
  });

  it('opens a chart modal with observed width columns, even LF rows, and calculated weights', () => {
    render(<WeightChartPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Open Chart' }));

    const dialog = screen.getByRole('dialog', { name: 'Night Vision 35' });
    expect(within(dialog).getByText(/3M Solar \/ 3IN core \/ Needs Review confidence \/ 2 accepted samples/u)).toBeTruthy();
    expect(within(dialog).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
      '36"',
      '72"'
    ]);
    expect(within(dialog).getByText('Starts at 106 LF / 1 samples')).toBeTruthy();
    expect(within(dialog).getByText('Starts at 100 LF / 1 samples')).toBeTruthy();
    expect(within(dialog).getByText('106 LF')).toBeTruthy();
    expect(within(dialog).getByText('104 LF')).toBeTruthy();
    expect(within(dialog).getByText('7.02 lbs')).toBeTruthy();
    expect(within(dialog).getByText('10.40 lbs')).toBeTruthy();
    expect(within(dialog).getAllByText('0 LF').length).toBeGreaterThan(0);
  });

  it('closes the chart modal without losing the chart list', () => {
    render(<WeightChartPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Open Chart' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close weight chart' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Night Vision 35')).toBeTruthy();
  });

  it('shows empty, loading, and error states without internal review actions', async () => {
    useFilmWeightProfilesMock.mockReturnValue(
      buildQueryState([], {
        isLoading: true
      })
    );
    useFilmWeightPendingReviewsMock.mockReturnValue(
      buildQueryState([], {
        isError: true,
        error: new Error('Pending review read failed')
      })
    );

    render(<WeightChartPage />);

    expect(await screen.findByText('Loading film weight charts...')).toBeTruthy();
    expect(screen.getByText('Pending review read failed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /reject/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
  });
});
