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
    averageLbsPerSqFt: 0.0123456789,
    averageNormalizedLbsPerInchFoot: 0.001028806575,
    acceptedSampleCount: 2,
    pendingReviewCount: 1,
    confidence: 'needs_review',
    status: 'needs_review',
    observedWidths: [36, 72],
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

  it('renders the Weight Chart title, helper text, profile columns, and friendly labels', () => {
    render(<WeightChartPage />);

    expect(screen.getByRole('heading', { name: 'Weight Chart' })).toBeTruthy();
    expect(
      screen.getByText(
        'Track film weight profiles built from received/weighed ordered film and review samples that need attention.'
      )
    ).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Profiles' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent?.trim())).toEqual([
      'Manufacturer',
      'Film Name',
      'Core Type',
      'Observed Widths',
      'Accepted Samples',
      'Pending Reviews',
      'Confidence',
      'Avg lbs / sq ft',
      'Avg normalized lbs / inch-ft',
      'Last Sample Date',
      'Status'
    ]);
    expect(screen.getByText('Night Vision 35')).toBeTruthy();
    expect(screen.getByText('36", 72"')).toBeTruthy();
    expect(screen.getAllByText('Needs Review').length).toBeGreaterThan(0);
  });

  it('filters profiles by manufacturer, film name, core type, confidence, and status', () => {
    useFilmWeightProfilesMock.mockReturnValue(
      buildQueryState([
        buildProfile(),
        buildProfile({
          profileId: 'profile-2',
          manufacturer: 'Madico',
          filmName: 'SafetyShield 800',
          coreType: '6IN',
          acceptedSampleCount: 4,
          pendingReviewCount: 0,
          confidence: 'solid',
          status: 'active'
        })
      ])
    );

    render(<WeightChartPage />);

    fireEvent.change(screen.getByLabelText('Manufacturer'), {
      target: { value: 'madico' }
    });
    expect(screen.queryByText('Night Vision 35')).toBeNull();
    expect(screen.getByText('SafetyShield 800')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Film Name'), {
      target: { value: 'safety' }
    });
    fireEvent.change(screen.getByLabelText('Core Type'), {
      target: { value: '6IN' }
    });
    fireEvent.change(screen.getByLabelText('Confidence'), {
      target: { value: 'solid' }
    });
    fireEvent.change(screen.getByLabelText('Status'), {
      target: { value: 'active' }
    });

    expect(screen.getByText('SafetyShield 800')).toBeTruthy();
    expect(screen.queryByText('Night Vision 35')).toBeNull();
  });

  it('renders pending reviews with friendly reasons and suggested actions', () => {
    render(<WeightChartPage />);

    fireEvent.click(screen.getByRole('tab', { name: 'Pending Review' }));

    expect(screen.getAllByRole('columnheader').map((header) => header.textContent?.trim())).toEqual([
      'Box',
      'Manufacturer',
      'Film Name',
      'Width',
      'Recorded LF',
      'Measured Weight',
      'Core Type',
      'Estimated LF',
      'LF Error',
      'Profile / Confidence',
      'Reason',
      'Suggested Action',
      'Created'
    ]);
    expect(screen.getByText('IL1-FWC-434829793120')).toBeTruthy();
    expect(screen.getByText('Outside 10 LF tolerance')).toBeTruthy();
    expect(screen.getByText('Approve or reject later')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Search Pending Reviews'), {
      target: { value: 'no match' }
    });
    expect(screen.getByText('No film weight samples need review.')).toBeTruthy();
  });

  it('shows empty states for profiles and pending reviews', () => {
    useFilmWeightProfilesMock.mockReturnValue(buildQueryState([]));
    useFilmWeightPendingReviewsMock.mockReturnValue(buildQueryState([]));

    render(<WeightChartPage />);

    expect(
      screen.getByText(
        'No film weight profiles have been created yet. Profiles are created when ordered film is received with usable weight, LF, width, and core data.'
      )
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Pending Review' }));

    expect(screen.getByText('No film weight samples need review.')).toBeTruthy();
  });

  it('shows loading and error states without leaving blank UI', async () => {
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

    expect(await screen.findByText('Loading film weight profiles...')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Pending Review' }));

    expect(screen.getByText('Pending review read failed')).toBeTruthy();
  });

  it('does not render approve, reject, or edit review actions in the read-only phase', () => {
    render(<WeightChartPage />);

    fireEvent.click(screen.getByRole('tab', { name: 'Pending Review' }));

    const panel = screen.getByRole('tabpanel', { name: 'Pending Review' });
    expect(within(panel).queryByRole('button', { name: /approve/i })).toBeNull();
    expect(within(panel).queryByRole('button', { name: /reject/i })).toBeNull();
    expect(within(panel).queryByRole('button', { name: /edit/i })).toBeNull();
  });
});
