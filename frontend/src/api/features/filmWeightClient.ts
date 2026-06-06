// Purpose: Read-only Film Weight Chart API surface.
import type {
  FilmWeightPendingReviewEntry,
  FilmWeightPendingReviewListResponse,
  FilmWeightProfileEntry,
  FilmWeightProfileListResponse,
  FilmWeightProfileWidthSummary
} from '../../domain';
import { assertFeatureAccess, requestReadWithFallback } from './sharedClient';

function normalizeNumberList(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry) && entry > 0);
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => String(entry || '').trim()).filter(Boolean);
}

function normalizeNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeWidthSummaries(value: unknown): FilmWeightProfileWidthSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      const record = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
      const widthIn = normalizeNullableNumber(record.widthIn ?? record.width_inches);
      const maxRecordedLf = normalizeNullableNumber(record.maxRecordedLf ?? record.max_recorded_lf);
      if (widthIn === null || maxRecordedLf === null || widthIn <= 0 || maxRecordedLf <= 0) {
        return null;
      }
      return {
        widthIn,
        maxRecordedLf,
        acceptedSampleCount: Math.max(
          0,
          Math.trunc(Number(record.acceptedSampleCount ?? record.accepted_sample_count ?? 0) || 0)
        ),
        lastSampleAt: String(record.lastSampleAt ?? record.last_sample_at ?? '').trim()
      };
    })
    .filter((entry): entry is FilmWeightProfileWidthSummary => entry !== null)
    .sort((left, right) => left.widthIn - right.widthIn);
}

function normalizeProfile(entry: Partial<FilmWeightProfileEntry> = {}): FilmWeightProfileEntry {
  const widthSummaries = normalizeWidthSummaries(entry.widthSummaries);
  const observedWidths = widthSummaries.length
    ? widthSummaries.map((summary) => summary.widthIn)
    : normalizeNumberList(entry.observedWidths);

  return {
    profileId: String(entry.profileId || '').trim(),
    manufacturer: String(entry.manufacturer || '').trim(),
    filmName: String(entry.filmName || '').trim(),
    filmKey: String(entry.filmKey || '').trim(),
    coreType: String(entry.coreType || '').trim(),
    coreWeightLbs: normalizeNullableNumber(entry.coreWeightLbs),
    averageLbsPerSqFt: normalizeNullableNumber(entry.averageLbsPerSqFt),
    averageNormalizedLbsPerInchFoot: normalizeNullableNumber(entry.averageNormalizedLbsPerInchFoot),
    acceptedSampleCount: Math.max(0, Math.trunc(Number(entry.acceptedSampleCount || 0) || 0)),
    pendingReviewCount: Math.max(0, Math.trunc(Number(entry.pendingReviewCount || 0) || 0)),
    confidence: String(entry.confidence || 'starter').trim(),
    status: String(entry.status || 'active').trim(),
    observedWidths,
    widthSummaries,
    firstSampleAt: String(entry.firstSampleAt || '').trim(),
    lastSampleAt: String(entry.lastSampleAt || '').trim(),
    lastReviewAt: String(entry.lastReviewAt || '').trim(),
    manuallyOverridden: entry.manuallyOverridden === true,
    notes: String(entry.notes || '').trim(),
    updatedAt: String(entry.updatedAt || '').trim()
  };
}

function normalizePendingReview(
  entry: Partial<FilmWeightPendingReviewEntry> = {}
): FilmWeightPendingReviewEntry {
  return {
    reviewId: String(entry.reviewId || '').trim(),
    profileId: String(entry.profileId || '').trim(),
    sampleId: String(entry.sampleId || '').trim(),
    boxId: String(entry.boxId || '').trim(),
    manufacturer: String(entry.manufacturer || '').trim(),
    filmName: String(entry.filmName || '').trim(),
    filmKey: String(entry.filmKey || '').trim(),
    widthIn: normalizeNullableNumber(entry.widthIn),
    recordedLf: normalizeNullableNumber(entry.recordedLf),
    measuredRollWeightLbs: normalizeNullableNumber(entry.measuredRollWeightLbs),
    coreType: String(entry.coreType || '').trim(),
    coreWeightLbs: normalizeNullableNumber(entry.coreWeightLbs),
    estimatedLf: normalizeNullableNumber(entry.estimatedLf),
    lfError: normalizeNullableNumber(entry.lfError),
    reason: String(entry.reason || '').trim(),
    reasons: normalizeStringList(entry.reasons),
    suggestedAction: String(entry.suggestedAction || 'review_sample').trim(),
    status: String(entry.status || 'open').trim(),
    profileConfidence: String(entry.profileConfidence || '').trim(),
    profileStatus: String(entry.profileStatus || '').trim(),
    createdAt: String(entry.createdAt || '').trim(),
    notes: String(entry.notes || '').trim()
  };
}

export async function getFilmWeightProfiles(): Promise<FilmWeightProfileEntry[]> {
  assertFeatureAccess('inventory', 'read');
  const data = await requestReadWithFallback<FilmWeightProfileListResponse>(
    '/film-weight/profiles',
    {},
    {}
  );
  return (data.entries || []).map(normalizeProfile);
}

export async function getFilmWeightPendingReviews(): Promise<FilmWeightPendingReviewEntry[]> {
  assertFeatureAccess('inventory', 'read');
  const data = await requestReadWithFallback<FilmWeightPendingReviewListResponse>(
    '/film-weight/pending-reviews',
    {},
    {}
  );
  return (data.entries || []).map(normalizePendingReview);
}
