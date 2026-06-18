import { useMemo, useState } from 'react';
import { DeferredLoadingState } from '../../../components/DeferredLoadingState';
import { DialogSurface } from '../../../components/DialogSurface';
import { Select } from '../../../components/Select';
import type {
  FilmWeightPendingReviewDecision,
  FilmWeightPendingReviewEntry,
  FilmWeightProfileEntry,
  FilmWeightProfileWidthSummary
} from '../../../domain';
import { formatDate } from '../../../lib/date';
import { useResolveFilmWeightPendingReview } from '../hooks/useInventoryMutationHooks';
import {
  useFilmWeightPendingReviews,
  useFilmWeightProfiles
} from '../hooks/useInventoryQueries';

const CONFIDENCE_LABELS: Record<string, string> = {
  starter: 'Starter',
  building: 'Building',
  solid: 'Solid',
  needs_review: 'Needs Review'
};

function normalizeToken(value: string) {
  return String(value || '').trim().toLowerCase();
}

function displayLabel(value: string, labels: Record<string, string>) {
  const normalized = normalizeToken(value);
  return labels[normalized] || value || '--';
}

function formatNumber(value: number | null, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '--';
  }

  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: digits
  }).format(value);
}

function formatWeight(value: number | null) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '--';
  }

  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

function pluralizeSampleCount(count: number) {
  return count === 1 ? '1 sample needs review' : `${count} samples need review`;
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

function formatWidth(value: number | null) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '--';
  }
  return `${formatNumber(value, 2)}"`;
}

function hasChartData(profile: FilmWeightProfileEntry) {
  return (
    profile.widthSummaries.length > 0 &&
    profile.coreWeightLbs !== null &&
    profile.averageNormalizedLbsPerInchFoot !== null &&
    profile.coreWeightLbs > 0 &&
    profile.averageNormalizedLbsPerInchFoot > 0
  );
}

function profileMatchesFilters(
  profile: FilmWeightProfileEntry,
  filters: {
    manufacturer: string;
    filmName: string;
  }
) {
  const manufacturer = normalizeToken(profile.manufacturer);
  const filmName = normalizeToken(profile.filmName);

  return (
    (filters.manufacturer === 'all' || manufacturer === normalizeToken(filters.manufacturer)) &&
    (!filters.filmName || filmName.includes(normalizeToken(filters.filmName)))
  );
}

function roundUpToEven(value: number) {
  return Math.ceil(value / 2) * 2;
}

function buildLfRows(summary: FilmWeightProfileWidthSummary) {
  const startLf = roundUpToEven(summary.maxRecordedLf);
  const rows: number[] = [];
  for (let lf = startLf; lf >= 0; lf -= 2) {
    rows.push(lf);
  }
  return rows;
}

function estimateRollWeight(profile: FilmWeightProfileEntry, widthIn: number, lf: number) {
  if (profile.coreWeightLbs === null || profile.averageNormalizedLbsPerInchFoot === null) {
    return null;
  }
  return profile.coreWeightLbs + profile.averageNormalizedLbsPerInchFoot * widthIn * lf;
}

function getProfileLastDate(profile: FilmWeightProfileEntry) {
  return profile.lastSampleAt || profile.updatedAt;
}

function formatReviewReasons(review: FilmWeightPendingReviewEntry) {
  const values = review.reasons.length ? review.reasons : review.reason ? [review.reason] : [];
  if (!values.length) {
    return '--';
  }
  return values.map((entry) => entry.replace(/_/g, ' ')).join(', ');
}

interface WeightChartDialogProps {
  profile: FilmWeightProfileEntry | null;
  onClose: () => void;
}

function WeightChartDialog({ profile, onClose }: WeightChartDialogProps) {
  const sortedSummaries = useMemo(
    () => [...(profile?.widthSummaries || [])].sort((left, right) => left.widthIn - right.widthIn),
    [profile]
  );

  if (!profile) {
    return null;
  }

  return (
    <DialogSurface
      open={Boolean(profile)}
      onClose={onClose}
      titleId="weight-chart-dialog-title"
      descriptionId="weight-chart-dialog-description"
      className="weight-chart-dialog"
    >
      <div className="dialog-header weight-chart-dialog-header">
        <div>
          <p className="weight-chart-dialog-eyebrow">Film Weight Chart</p>
          <h2 id="weight-chart-dialog-title">{profile.filmName || 'Film chart'}</h2>
          <p id="weight-chart-dialog-description" className="muted-text">
            {profile.manufacturer || '--'} / {profile.coreType || '--'} core /{' '}
            {displayLabel(profile.confidence, CONFIDENCE_LABELS)} confidence /{' '}
            {profile.acceptedSampleCount} accepted samples
          </p>
        </div>
        <button type="button" className="dialog-close" aria-label="Close weight chart" onClick={onClose}>
          x
        </button>
      </div>

      <div className="weight-chart-modal-summary" aria-label="Chart calculation source">
        <span>Core weight: {formatWeight(profile.coreWeightLbs)} lbs</span>
        <span>Profile average: {formatLongDecimal(profile.averageNormalizedLbsPerInchFoot)} lbs / inch-ft</span>
        <span>Last sample: {formatDate(profile.lastSampleAt)}</span>
      </div>

      <div className="weight-chart-modal-scroll">
        <div className="weight-chart-columns" aria-label={`${profile.filmName} weight chart by width`}>
          {sortedSummaries.map((summary) => (
            <section className="weight-chart-width-column" key={summary.widthIn}>
              <div className="weight-chart-width-header">
                <h3>{formatNumber(summary.widthIn, 2)}"</h3>
                <p>
                  Starts at {formatNumber(roundUpToEven(summary.maxRecordedLf), 0)} LF /{' '}
                  {summary.acceptedSampleCount} samples
                </p>
              </div>
              <div className="weight-chart-row-list">
                {buildLfRows(summary).map((lf) => (
                  <div className="weight-chart-row" key={lf}>
                    <span>{formatNumber(lf, 0)} LF</span>
                    <strong>{formatWeight(estimateRollWeight(profile, summary.widthIn, lf))} lbs</strong>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </DialogSurface>
  );
}

export default function WeightChartPage() {
  const [manufacturerFilter, setManufacturerFilter] = useState('all');
  const [filmNameFilter, setFilmNameFilter] = useState('');
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [showReviewPanel, setShowReviewPanel] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const [pendingReviewAction, setPendingReviewAction] = useState<{
    reviewId: string;
    decision: FilmWeightPendingReviewDecision;
  } | null>(null);
  const profilesQuery = useFilmWeightProfiles();
  const pendingReviewsQuery = useFilmWeightPendingReviews();
  const resolveReviewMutation = useResolveFilmWeightPendingReview();
  const profiles = profilesQuery.data || [];
  const pendingReviews = pendingReviewsQuery.data || [];
  const chartProfiles = useMemo(() => profiles.filter(hasChartData), [profiles]);
  const manufacturerOptions = useMemo(() => {
    const valuesByKey = new Map<string, string>();
    for (const profile of chartProfiles) {
      const value = profile.manufacturer.trim();
      const key = normalizeToken(value);
      if (value && !valuesByKey.has(key)) {
        valuesByKey.set(key, value);
      }
    }
    const values = Array.from(valuesByKey.values()).sort((left, right) =>
      left.localeCompare(right, undefined, { sensitivity: 'base' })
    );
    return [
      { label: 'All manufacturers', value: 'all' },
      ...values.map((value) => ({ label: value, value }))
    ];
  }, [chartProfiles]);
  const filteredProfiles = useMemo(
    () =>
      chartProfiles.filter((profile) =>
        profileMatchesFilters(profile, {
          manufacturer: manufacturerFilter,
          filmName: filmNameFilter
        })
      ),
    [chartProfiles, filmNameFilter, manufacturerFilter]
  );
  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.profileId === selectedProfileId) || null,
    [profiles, selectedProfileId]
  );
  const showProfilesLoading = profilesQuery.isLoading && !profiles.length;

  async function resolveReview(
    review: FilmWeightPendingReviewEntry,
    decision: FilmWeightPendingReviewDecision
  ) {
    setReviewError('');
    setPendingReviewAction({ reviewId: review.reviewId, decision });
    try {
      await resolveReviewMutation.mutateAsync({
        reviewId: review.reviewId,
        decision
      });
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : 'The review could not be resolved.');
    } finally {
      setPendingReviewAction(null);
    }
  }

  return (
    <section className="panel weight-chart-page">
      <div className="panel-title-row weight-chart-header">
        <div>
          <h2>Weight Chart</h2>
          <p className="muted-text">
            Charts are built from trusted received and weighed ordered film, using accepted sample
            LF, width, roll weight, and core data.
          </p>
        </div>
        <div className="weight-chart-counts" aria-label="Weight chart summary">
          <span>{chartProfiles.length} charts</span>
          {pendingReviews.length ? (
            <button
              type="button"
              className="weight-chart-count-button"
              onClick={() => setShowReviewPanel((current) => !current)}
              aria-expanded={showReviewPanel}
            >
              {pluralizeSampleCount(pendingReviews.length)}
            </button>
          ) : (
            <span>{pluralizeSampleCount(0)}</span>
          )}
        </div>
      </div>

      {profilesQuery.isError ? (
        <p className="error-text">{profilesQuery.error.message}</p>
      ) : null}
      {pendingReviewsQuery.isError ? (
        <p className="error-text">{pendingReviewsQuery.error.message}</p>
      ) : null}

      <div className="toolbar-grid reports-filters weight-chart-filters">
        <Select
          label="Manufacturer"
          value={manufacturerFilter}
          onChange={(event) => setManufacturerFilter(event.target.value)}
          options={manufacturerOptions}
        />
        <label className="field">
          <span className="field-label">Film Name</span>
          <input
            className="field-input"
            value={filmNameFilter}
            onChange={(event) => setFilmNameFilter(event.target.value)}
            placeholder="Search film"
          />
        </label>
      </div>

      {pendingReviews.length && showReviewPanel ? (
        <section className="weight-chart-review-panel" aria-label="Film weight samples needing review">
          <div className="panel-title-row weight-chart-review-title">
            <div>
              <h3>Samples Needing Review</h3>
              <p className="muted-text">
                Review weight samples from received boxes before they affect chart averages.
              </p>
            </div>
            <button
              type="button"
              className="button button-ghost"
              onClick={() => setShowReviewPanel(false)}
            >
              Hide
            </button>
          </div>
          {reviewError ? <p className="error-text">{reviewError}</p> : null}
          <div className="table-wrap weight-chart-table-wrap">
            <table className="weight-chart-table weight-chart-review-table">
              <thead>
                <tr>
                  <th>Box</th>
                  <th>Film</th>
                  <th>Width</th>
                  <th>Recorded LF</th>
                  <th>Measured Weight</th>
                  <th>Estimated LF</th>
                  <th>Reason</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {pendingReviews.map((review) => {
                  const accepting =
                    pendingReviewAction?.reviewId === review.reviewId &&
                    pendingReviewAction.decision === 'accept';
                  const rejecting =
                    pendingReviewAction?.reviewId === review.reviewId &&
                    pendingReviewAction.decision === 'reject';
                  const actionPending = accepting || rejecting;
                  return (
                    <tr key={review.reviewId}>
                      <td>
                        <a href={`#/inventory/${encodeURIComponent(review.boxId)}`}>{review.boxId}</a>
                      </td>
                      <td>
                        <strong>{review.manufacturer || '--'}</strong>
                        <br />
                        <span className="muted-text">{review.filmName || '--'}</span>
                      </td>
                      <td>{formatWidth(review.widthIn)}</td>
                      <td>{formatNumber(review.recordedLf, 0)}</td>
                      <td>{formatWeight(review.measuredRollWeightLbs)} lbs</td>
                      <td>
                        {formatNumber(review.estimatedLf, 2)}
                        {review.lfError !== null ? (
                          <span className="muted-text"> / {formatNumber(review.lfError, 2)} LF off</span>
                        ) : null}
                      </td>
                      <td>{formatReviewReasons(review)}</td>
                      <td>
                        <div className="weight-chart-review-actions">
                          <button
                            type="button"
                            className="button button-secondary"
                            onClick={() => void resolveReview(review, 'accept')}
                            disabled={resolveReviewMutation.isPending}
                          >
                            {accepting ? 'Accepting...' : 'Accept Sample'}
                          </button>
                          <button
                            type="button"
                            className="button button-danger"
                            onClick={() => void resolveReview(review, 'reject')}
                            disabled={resolveReviewMutation.isPending}
                          >
                            {rejecting ? 'Rejecting...' : 'Reject Sample'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <DeferredLoadingState when={showProfilesLoading} label="Loading film weight charts..." />
      {!showProfilesLoading && !profilesQuery.isError && !filteredProfiles.length ? (
        <div className="empty-state">
          No film weight charts match these filters yet. Charts appear after trusted ordered film is
          received with usable weight, LF, width, and core data.
        </div>
      ) : null}
      {filteredProfiles.length ? (
        <div className="table-wrap weight-chart-table-wrap">
          <table className="weight-chart-table weight-chart-profile-table">
            <thead>
              <tr>
                <th>Manufacturer</th>
                <th>Film Name</th>
                <th>Widths Available</th>
                <th>Accepted Samples</th>
                <th>Last Sample / Updated</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredProfiles.map((profile) => (
                <tr key={profile.profileId}>
                  <td>{profile.manufacturer || '--'}</td>
                  <td>{profile.filmName || '--'}</td>
                  <td>{formatObservedWidths(profile.observedWidths)}</td>
                  <td>{profile.acceptedSampleCount}</td>
                  <td>{formatDate(getProfileLastDate(profile))}</td>
                  <td>
                    <button
                      type="button"
                      className="button button-secondary weight-chart-open-button"
                      onClick={() => setSelectedProfileId(profile.profileId)}
                    >
                      Open Chart
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <WeightChartDialog profile={selectedProfile} onClose={() => setSelectedProfileId(null)} />
    </section>
  );
}
