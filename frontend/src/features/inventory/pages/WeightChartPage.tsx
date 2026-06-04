import { useMemo, useState } from 'react';
import { DeferredLoadingState } from '../../../components/DeferredLoadingState';
import { Select } from '../../../components/Select';
import type { FilmWeightPendingReviewEntry, FilmWeightProfileEntry } from '../../../domain';
import { formatDate } from '../../../lib/date';
import {
  useFilmWeightPendingReviews,
  useFilmWeightProfiles
} from '../hooks/useInventoryQueries';

type WeightChartView = 'profiles' | 'pending';

const CONFIDENCE_FILTER_OPTIONS = [
  { label: 'All confidence', value: 'all' },
  { label: 'Starter', value: 'starter' },
  { label: 'Building', value: 'building' },
  { label: 'Solid', value: 'solid' },
  { label: 'Needs Review', value: 'needs_review' }
] as const;

const STATUS_FILTER_OPTIONS = [
  { label: 'All statuses', value: 'all' },
  { label: 'Active', value: 'active' },
  { label: 'Needs Review', value: 'needs_review' },
  { label: 'Disabled', value: 'disabled' }
] as const;

const CONFIDENCE_LABELS: Record<string, string> = {
  starter: 'Starter',
  building: 'Building',
  solid: 'Solid',
  needs_review: 'Needs Review'
};

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  needs_review: 'Needs Review',
  disabled: 'Disabled'
};

const REASON_LABELS: Record<string, string> = {
  missing_core_type: 'Missing core type',
  missing_core_weight: 'Missing core weight',
  missing_measured_roll_weight: 'Missing measured weight',
  missing_lf: 'Missing LF',
  missing_width: 'Missing width',
  outside_10_lf_tolerance: 'Outside 10 LF tolerance',
  film_only_weight_not_positive: 'Invalid film-only weight',
  normalized_weight_invalid: 'Invalid film-only weight',
  missing_canonical_film_identity: 'Missing film identity',
  missing_trusted_sample_date: 'Missing sample date',
  profile_manually_overridden: 'Profile manually overridden'
};

function normalizeToken(value: string) {
  return String(value || '').trim().toLowerCase();
}

function displayLabel(value: string, labels: Record<string, string>) {
  const normalized = normalizeToken(value);
  return labels[normalized] || value || '--';
}

function formatNumber(value: number | null, digits = 4) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '--';
  }

  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: digits
  }).format(value);
}

function formatLongDecimal(value: number | null) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '--';
  }

  return value.toFixed(12).replace(/0+$/u, '').replace(/\.$/u, '');
}

function formatObservedWidths(widths: number[]) {
  if (!widths.length) {
    return '--';
  }

  return widths.map((width) => `${formatNumber(width, 2)}"`).join(', ');
}

function getReviewReasonLabels(entry: FilmWeightPendingReviewEntry) {
  const reasonTokens = entry.reasons.length
    ? entry.reasons
    : String(entry.reason || '')
        .split(',')
        .map((reason) => reason.trim())
        .filter(Boolean);
  return reasonTokens.map((reason) => displayLabel(reason, REASON_LABELS));
}

function getSuggestedActionLabel(entry: FilmWeightPendingReviewEntry) {
  const action = normalizeToken(entry.suggestedAction);
  const reasons = new Set(entry.reasons.map(normalizeToken));
  if (action === 'add_core_type') {
    return reasons.has('missing_core_weight') && !reasons.has('missing_core_type')
      ? 'Add core weight'
      : 'Add core type';
  }
  if (action === 're_weigh') {
    return 'Re-weigh';
  }
  if (action === 'correct_lf') {
    return 'Correct LF';
  }
  if (action === 'approve_sample') {
    return 'Approve or reject later';
  }
  if (action === 'split_film_identity') {
    return 'Review film identity';
  }
  return 'Review sample';
}

function profileMatchesFilters(
  profile: FilmWeightProfileEntry,
  filters: {
    manufacturer: string;
    filmName: string;
    coreType: string;
    confidence: string;
    status: string;
  }
) {
  const manufacturer = normalizeToken(profile.manufacturer);
  const filmName = normalizeToken(profile.filmName);
  const coreType = normalizeToken(profile.coreType);
  const confidence = normalizeToken(profile.confidence);
  const status = normalizeToken(profile.status);

  return (
    (!filters.manufacturer || manufacturer.includes(normalizeToken(filters.manufacturer))) &&
    (!filters.filmName || filmName.includes(normalizeToken(filters.filmName))) &&
    (filters.coreType === 'all' || coreType === normalizeToken(filters.coreType)) &&
    (filters.confidence === 'all' || confidence === filters.confidence) &&
    (filters.status === 'all' || status === filters.status)
  );
}

function reviewMatchesSearch(review: FilmWeightPendingReviewEntry, search: string) {
  const needle = normalizeToken(search);
  if (!needle) {
    return true;
  }

  const haystack = [
    review.boxId,
    review.manufacturer,
    review.filmName,
    review.coreType,
    ...getReviewReasonLabels(review),
    getSuggestedActionLabel(review),
    displayLabel(review.profileConfidence, CONFIDENCE_LABELS)
  ].join(' ');
  return normalizeToken(haystack).includes(needle);
}

export default function WeightChartPage() {
  const [activeView, setActiveView] = useState<WeightChartView>('profiles');
  const [manufacturerFilter, setManufacturerFilter] = useState('');
  const [filmNameFilter, setFilmNameFilter] = useState('');
  const [coreTypeFilter, setCoreTypeFilter] = useState('all');
  const [confidenceFilter, setConfidenceFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [pendingSearch, setPendingSearch] = useState('');
  const profilesQuery = useFilmWeightProfiles();
  const pendingReviewsQuery = useFilmWeightPendingReviews();
  const profiles = profilesQuery.data || [];
  const pendingReviews = pendingReviewsQuery.data || [];
  const coreTypeOptions = useMemo(() => {
    const values = Array.from(
      new Set(
        profiles
          .map((profile) => profile.coreType.trim())
          .filter(Boolean)
          .sort((left, right) => left.localeCompare(right))
      )
    );
    return [
      { label: 'All core types', value: 'all' },
      ...values.map((value) => ({ label: value, value }))
    ];
  }, [profiles]);
  const filteredProfiles = useMemo(
    () =>
      profiles.filter((profile) =>
        profileMatchesFilters(profile, {
          manufacturer: manufacturerFilter,
          filmName: filmNameFilter,
          coreType: coreTypeFilter,
          confidence: confidenceFilter,
          status: statusFilter
        })
      ),
    [confidenceFilter, coreTypeFilter, filmNameFilter, manufacturerFilter, profiles, statusFilter]
  );
  const filteredPendingReviews = useMemo(
    () => pendingReviews.filter((review) => reviewMatchesSearch(review, pendingSearch)),
    [pendingReviews, pendingSearch]
  );
  const showProfilesLoading = profilesQuery.isLoading && !profiles.length;
  const showPendingLoading = pendingReviewsQuery.isLoading && !pendingReviews.length;
  const activeQuery = activeView === 'profiles' ? profilesQuery : pendingReviewsQuery;

  return (
    <section className="panel weight-chart-page">
      <div className="panel-title-row weight-chart-header">
        <div>
          <h2>Weight Chart</h2>
          <p className="muted-text">
            Track film weight profiles built from received/weighed ordered film and review samples
            that need attention.
          </p>
        </div>
        <div className="weight-chart-counts" aria-label="Weight chart summary">
          <span>{profiles.length} profiles</span>
          <span>{pendingReviews.length} pending reviews</span>
        </div>
      </div>

      <div className="inventory-view-toggle weight-chart-tabs" role="tablist" aria-label="Weight Chart views">
        <button
          type="button"
          role="tab"
          aria-selected={activeView === 'profiles'}
          className={`inventory-view-toggle-button ${activeView === 'profiles' ? 'active' : ''}`.trim()}
          onClick={() => setActiveView('profiles')}
        >
          Profiles
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeView === 'pending'}
          className={`inventory-view-toggle-button ${activeView === 'pending' ? 'active' : ''}`.trim()}
          onClick={() => setActiveView('pending')}
        >
          Pending Review
        </button>
      </div>

      {activeQuery.isError ? (
        <p className="error-text">{activeQuery.error.message}</p>
      ) : null}

      {activeView === 'profiles' ? (
        <div role="tabpanel" aria-label="Profiles">
          <div className="toolbar-grid reports-filters weight-chart-filters">
            <label className="field">
              <span className="field-label">Manufacturer</span>
              <input
                className="field-input"
                value={manufacturerFilter}
                onChange={(event) => setManufacturerFilter(event.target.value)}
                placeholder="Search manufacturer"
              />
            </label>
            <label className="field">
              <span className="field-label">Film Name</span>
              <input
                className="field-input"
                value={filmNameFilter}
                onChange={(event) => setFilmNameFilter(event.target.value)}
                placeholder="Search film"
              />
            </label>
            <Select
              label="Core Type"
              value={coreTypeFilter}
              onChange={(event) => setCoreTypeFilter(event.target.value)}
              options={coreTypeOptions}
            />
            <Select
              label="Confidence"
              value={confidenceFilter}
              onChange={(event) => setConfidenceFilter(event.target.value)}
              options={CONFIDENCE_FILTER_OPTIONS}
            />
            <Select
              label="Status"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              options={STATUS_FILTER_OPTIONS}
            />
          </div>

          <DeferredLoadingState when={showProfilesLoading} label="Loading film weight profiles..." />
          {!showProfilesLoading && !profilesQuery.isError && !filteredProfiles.length ? (
            <div className="empty-state">
              No film weight profiles have been created yet. Profiles are created when ordered film
              is received with usable weight, LF, width, and core data.
            </div>
          ) : null}
          {filteredProfiles.length ? (
            <div className="table-wrap weight-chart-table-wrap">
              <table className="weight-chart-table">
                <thead>
                  <tr>
                    <th>Manufacturer</th>
                    <th>Film Name</th>
                    <th>Core Type</th>
                    <th>Observed Widths</th>
                    <th>Accepted Samples</th>
                    <th>Pending Reviews</th>
                    <th>Confidence</th>
                    <th>Avg lbs / sq ft</th>
                    <th>Avg normalized lbs / inch-ft</th>
                    <th>Last Sample Date</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProfiles.map((profile) => (
                    <tr key={profile.profileId}>
                      <td>{profile.manufacturer || '--'}</td>
                      <td>{profile.filmName || '--'}</td>
                      <td>{profile.coreType || '--'}</td>
                      <td>{formatObservedWidths(profile.observedWidths)}</td>
                      <td>{profile.acceptedSampleCount}</td>
                      <td>{profile.pendingReviewCount}</td>
                      <td>
                        <span className={`weight-chart-pill weight-chart-pill-${normalizeToken(profile.confidence)}`}>
                          {displayLabel(profile.confidence, CONFIDENCE_LABELS)}
                        </span>
                      </td>
                      <td>{formatLongDecimal(profile.averageLbsPerSqFt)}</td>
                      <td>{formatLongDecimal(profile.averageNormalizedLbsPerInchFoot)}</td>
                      <td>{formatDate(profile.lastSampleAt)}</td>
                      <td>{displayLabel(profile.status, STATUS_LABELS)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : (
        <div role="tabpanel" aria-label="Pending Review">
          <div className="toolbar-grid reports-filters weight-chart-filters weight-chart-pending-filters">
            <label className="field">
              <span className="field-label">Search Pending Reviews</span>
              <input
                className="field-input"
                value={pendingSearch}
                onChange={(event) => setPendingSearch(event.target.value)}
                placeholder="Search box, film, reason, or action"
              />
            </label>
          </div>

          <DeferredLoadingState when={showPendingLoading} label="Loading pending reviews..." />
          {!showPendingLoading && !pendingReviewsQuery.isError && !filteredPendingReviews.length ? (
            <div className="empty-state">No film weight samples need review.</div>
          ) : null}
          {filteredPendingReviews.length ? (
            <div className="table-wrap weight-chart-table-wrap">
              <table className="weight-chart-table">
                <thead>
                  <tr>
                    <th>Box</th>
                    <th>Manufacturer</th>
                    <th>Film Name</th>
                    <th>Width</th>
                    <th>Recorded LF</th>
                    <th>Measured Weight</th>
                    <th>Core Type</th>
                    <th>Estimated LF</th>
                    <th>LF Error</th>
                    <th>Profile / Confidence</th>
                    <th>Reason</th>
                    <th>Suggested Action</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPendingReviews.map((review) => {
                    const reasonLabels = getReviewReasonLabels(review);
                    return (
                      <tr key={review.reviewId}>
                        <td>{review.boxId || '--'}</td>
                        <td>{review.manufacturer || '--'}</td>
                        <td>{review.filmName || '--'}</td>
                        <td>{review.widthIn === null ? '--' : `${formatNumber(review.widthIn, 2)}"`}</td>
                        <td>{formatNumber(review.recordedLf, 2)}</td>
                        <td>{formatNumber(review.measuredRollWeightLbs, 4)}</td>
                        <td>{review.coreType || '--'}</td>
                        <td>{formatNumber(review.estimatedLf, 2)}</td>
                        <td>{formatNumber(review.lfError, 2)}</td>
                        <td>{displayLabel(review.profileConfidence, CONFIDENCE_LABELS)}</td>
                        <td>{reasonLabels.length ? reasonLabels.join(', ') : '--'}</td>
                        <td>{getSuggestedActionLabel(review)}</td>
                        <td>{formatDate(review.createdAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
