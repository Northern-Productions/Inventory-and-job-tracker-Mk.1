import { queryRow } from '../../db/client.mjs';
import { asTrimmedString } from '../core/helpers.mjs';

const FILM_WEIGHT_LF_TOLERANCE = 10;

function numericOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundTo(value, decimals = 10) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const factor = 10 ** decimals;
  return Math.round(numeric * factor) / factor;
}

function calculateFilmWeightMetrics({ measuredRollWeightLbs, coreWeightLbs, widthIn, recordedLf }) {
  const measured = numericOrNull(measuredRollWeightLbs);
  const core = numericOrNull(coreWeightLbs);
  const width = numericOrNull(widthIn);
  const lf = numericOrNull(recordedLf);
  if (measured === null || core === null || width === null || lf === null || width <= 0 || lf <= 0) {
    return null;
  }

  const filmOnlyWeightLbs = measured - core;
  const normalizedLbsPerInchFoot = filmOnlyWeightLbs / (width * lf);
  return {
    filmOnlyWeightLbs: roundTo(filmOnlyWeightLbs, 6),
    normalizedLbsPerInchFoot: roundTo(normalizedLbsPerInchFoot, 12),
    lbsPerSqFt: roundTo(normalizedLbsPerInchFoot * 12, 12),
  };
}

function estimateRemainingLfFromProfile({ measuredRollWeightLbs, coreWeightLbs, widthIn, averageNormalizedLbsPerInchFoot }) {
  const measured = numericOrNull(measuredRollWeightLbs);
  const core = numericOrNull(coreWeightLbs);
  const width = numericOrNull(widthIn);
  const averageNormalized = numericOrNull(averageNormalizedLbsPerInchFoot);
  if (
    measured === null ||
    core === null ||
    width === null ||
    averageNormalized === null ||
    width <= 0 ||
    averageNormalized <= 0
  ) {
    return null;
  }

  return roundTo((measured - core) / (averageNormalized * width), 6);
}

function compareLfTolerance({ estimatedLf, recordedLf, toleranceLf = FILM_WEIGHT_LF_TOLERANCE }) {
  const estimated = numericOrNull(estimatedLf);
  const recorded = numericOrNull(recordedLf);
  if (estimated === null || recorded === null) {
    return {
      withinTolerance: false,
      lfError: null,
    };
  }

  const lfError = Math.abs(estimated - recorded);
  return {
    withinTolerance: lfError <= toleranceLf,
    lfError: roundTo(lfError, 6),
  };
}

function confidenceForProfile({ acceptedSampleCount, openPendingReviewCount = 0 }) {
  const accepted = Math.max(0, Math.trunc(Number(acceptedSampleCount) || 0));
  const pending = Math.max(0, Math.trunc(Number(openPendingReviewCount) || 0));
  if (pending > 0) {
    return 'needs_review';
  }
  if (accepted <= 1) {
    return 'starter';
  }
  if (accepted <= 3) {
    return 'building';
  }
  return 'solid';
}

function numberOrNull(value) {
  const numeric = numericOrNull(value);
  return numeric === null ? null : numeric;
}

function normalizeReasons(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => asTrimmedString(entry)).filter(Boolean);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => asTrimmedString(entry)).filter(Boolean);
      }
    } catch (_error) {
      return trimmed.split(',').map((entry) => asTrimmedString(entry)).filter(Boolean);
    }
  }

  return [];
}

function normalizeWidthSummaries(value) {
  let rawEntries = [];
  if (Array.isArray(value)) {
    rawEntries = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed);
        rawEntries = Array.isArray(parsed) ? parsed : [];
      } catch (_error) {
        rawEntries = [];
      }
    }
  }

  return rawEntries
    .map((entry) => {
      const row = entry && typeof entry === 'object' ? entry : {};
      const widthIn = numberOrNull(row.widthIn ?? row.width_inches);
      const maxRecordedLf = numberOrNull(row.maxRecordedLf ?? row.max_recorded_lf);
      if (widthIn === null || maxRecordedLf === null || widthIn <= 0 || maxRecordedLf <= 0) {
        return null;
      }
      return {
        widthIn,
        maxRecordedLf,
        acceptedSampleCount: Math.max(
          0,
          Math.trunc(Number(row.acceptedSampleCount ?? row.accepted_sample_count ?? 0) || 0)
        ),
        lastSampleAt: asTrimmedString(row.lastSampleAt ?? row.last_sample_at),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.widthIn - right.widthIn);
}

function toFilmWeightProfileEntry(row = {}) {
  const widthSummaries = normalizeWidthSummaries(row.width_summaries);
  const observedWidths = widthSummaries.length
    ? widthSummaries.map((entry) => entry.widthIn)
    : normalizeReasons(row.observed_widths)
        .map((entry) => Number(entry))
        .filter((entry) => Number.isFinite(entry) && entry > 0);

  return {
    profileId: asTrimmedString(row.profile_id ?? row.id),
    manufacturer: asTrimmedString(row.manufacturer),
    filmName: asTrimmedString(row.film_name),
    filmKey: asTrimmedString(row.film_key),
    coreType: asTrimmedString(row.core_type),
    coreWeightLbs: numberOrNull(row.core_weight_lbs),
    averageNormalizedLbsPerInchFoot: numberOrNull(row.average_normalized_lbs_per_inch_foot),
    averageLbsPerSqFt: numberOrNull(row.average_lbs_per_sq_ft),
    acceptedSampleCount: Math.max(0, Math.trunc(Number(row.accepted_sample_count || 0))),
    pendingReviewCount: Math.max(0, Math.trunc(Number(row.pending_review_count || 0))),
    confidence: asTrimmedString(row.confidence) || 'starter',
    status: asTrimmedString(row.status) || 'active',
    observedWidths,
    widthSummaries,
    firstSampleAt: asTrimmedString(row.first_sample_at),
    lastSampleAt: asTrimmedString(row.last_sample_at),
    lastReviewAt: asTrimmedString(row.last_review_at),
    manuallyOverridden: row.manually_overridden === true,
    notes: asTrimmedString(row.notes),
    updatedAt: asTrimmedString(row.updated_at),
  };
}

function toFilmWeightPendingReviewEntry(row = {}) {
  return {
    reviewId: asTrimmedString(row.review_id ?? row.id),
    profileId: asTrimmedString(row.profile_id),
    sampleId: asTrimmedString(row.sample_id),
    boxId: asTrimmedString(row.source_box_id),
    manufacturer: asTrimmedString(row.manufacturer),
    filmName: asTrimmedString(row.film_name),
    filmKey: asTrimmedString(row.film_key),
    widthIn: numberOrNull(row.width_inches),
    recordedLf: numberOrNull(row.recorded_lf),
    measuredRollWeightLbs: numberOrNull(row.measured_roll_weight_lbs),
    coreType: asTrimmedString(row.core_type),
    coreWeightLbs: numberOrNull(row.core_weight_lbs),
    estimatedLf: numberOrNull(row.estimated_lf_against_profile),
    lfError: numberOrNull(row.lf_error_against_profile),
    reason: asTrimmedString(row.reason),
    reasons: normalizeReasons(row.reasons),
    suggestedAction: asTrimmedString(row.user_action_hint) || 'review_sample',
    status: asTrimmedString(row.status) || 'open',
    profileConfidence: asTrimmedString(row.profile_confidence),
    profileStatus: asTrimmedString(row.profile_status),
    createdAt: asTrimmedString(row.created_at),
    notes: asTrimmedString(row.notes),
  };
}

function validateSampleInput(sample = {}) {
  const reasons = [];
  const manufacturer = asTrimmedString(sample.manufacturer);
  const filmName = asTrimmedString(sample.filmName);
  const filmKey = asTrimmedString(sample.filmKey);
  const coreType = asTrimmedString(sample.coreType);
  const widthIn = numericOrNull(sample.widthIn);
  const recordedLf = numericOrNull(sample.recordedLf);
  const measuredRollWeightLbs = numericOrNull(sample.measuredRollWeightLbs);
  const coreWeightLbs = numericOrNull(sample.coreWeightLbs);

  if (!manufacturer || !filmName || !filmKey) {
    reasons.push('missing_canonical_film_identity');
  }
  if (widthIn === null || widthIn <= 0) {
    reasons.push('missing_width');
  }
  if (recordedLf === null || recordedLf <= 0) {
    reasons.push('missing_lf');
  }
  if (measuredRollWeightLbs === null || measuredRollWeightLbs <= 0) {
    reasons.push('missing_measured_roll_weight');
  }
  if (!coreType) {
    reasons.push('missing_core_type');
  }
  if (coreWeightLbs === null || coreWeightLbs <= 0) {
    reasons.push('missing_core_weight');
  }

  const metrics = reasons.length === 0
    ? calculateFilmWeightMetrics({ measuredRollWeightLbs, coreWeightLbs, widthIn, recordedLf })
    : null;
  if (metrics) {
    if (metrics.filmOnlyWeightLbs <= 0) {
      reasons.push('film_only_weight_not_positive');
    }
    if (metrics.normalizedLbsPerInchFoot === null || metrics.normalizedLbsPerInchFoot <= 0) {
      reasons.push('normalized_weight_invalid');
    }
  }

  return {
    complete: reasons.length === 0,
    reasons,
    metrics,
  };
}

function evaluateSampleAgainstProfile(sample = {}, profile = null, options = {}) {
  const validation = validateSampleInput(sample);
  if (!validation.complete) {
    return {
      decision: 'pending_review',
      reasons: validation.reasons,
      metrics: validation.metrics,
      estimatedLf: null,
      lfError: null,
    };
  }

  if (!profile) {
    return {
      decision: 'accepted_starter_profile',
      reasons: [],
      metrics: validation.metrics,
      estimatedLf: sample.recordedLf,
      lfError: 0,
    };
  }

  if (profile.manuallyOverridden === true) {
    return {
      decision: 'pending_review',
      reasons: ['profile_manually_overridden'],
      metrics: validation.metrics,
      estimatedLf: null,
      lfError: null,
    };
  }

  const estimatedLf = estimateRemainingLfFromProfile({
    measuredRollWeightLbs: sample.measuredRollWeightLbs,
    coreWeightLbs: sample.coreWeightLbs,
    widthIn: sample.widthIn,
    averageNormalizedLbsPerInchFoot: profile.averageNormalizedLbsPerInchFoot,
  });
  const tolerance = compareLfTolerance({
    estimatedLf,
    recordedLf: sample.recordedLf,
    toleranceLf: options.toleranceLf ?? FILM_WEIGHT_LF_TOLERANCE,
  });
  if (!tolerance.withinTolerance) {
    return {
      decision: 'pending_review',
      reasons: ['outside_10_lf_tolerance'],
      metrics: validation.metrics,
      estimatedLf,
      lfError: tolerance.lfError,
    };
  }

  return {
    decision: 'accepted_within_tolerance',
    reasons: [],
    metrics: validation.metrics,
    estimatedLf,
    lfError: tolerance.lfError,
  };
}

async function recordFilmWeightSampleFromBox(client, orgId, boxId, actor, options = {}) {
  const savepointName = options.savepointName || 'film_weight_profile_sample';
  await client.query(`SAVEPOINT ${savepointName}`);
  try {
    const row = await queryRow(
      client,
      `
        select app_api.record_film_weight_sample_from_box($1::uuid, $2::text, $3::text) as result
      `,
      [orgId, boxId, actor || '']
    );
    await client.query(`RELEASE SAVEPOINT ${savepointName}`);
    return row?.result || { decision: 'skipped' };
  } catch (_error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
    await client.query(`RELEASE SAVEPOINT ${savepointName}`);
    return {
      decision: 'logging_failed',
      warning: 'Film weight profile logging could not be completed; receive/update succeeded and the sample can be reviewed later.',
    };
  }
}

async function countOpenFilmWeightPendingReviews(client, orgId) {
  const row = await queryRow(
    client,
    `
      select public.api_acl_get_film_weight_pending_review_count($1::uuid)::integer as pending_count
    `,
    [orgId]
  );
  return Math.max(0, Number(row?.pending_count || 0) || 0);
}

async function listFilmWeightProfiles(client, orgId) {
  const result = await client.query(
    `
      select
        p.id as profile_id,
        p.manufacturer,
        p.film_name,
        p.film_key,
        p.core_type,
        p.core_weight_lbs,
        p.average_normalized_lbs_per_inch_foot,
        p.average_lbs_per_sq_ft,
        p.accepted_sample_count,
        p.pending_review_count,
        p.confidence,
        p.status,
        p.first_sample_at,
        p.last_sample_at,
        p.last_review_at,
        p.manually_overridden,
        p.notes,
        p.updated_at,
        coalesce(
          (
            select jsonb_agg(width_rows.width_inches order by width_rows.width_inches)
            from (
              select distinct s.width_inches
              from app.film_weight_samples s
              where s.org_id = p.org_id
                and s.profile_id = p.id
                and s.acceptance_status = 'accepted'
                and s.width_inches is not null
                and s.recorded_lf is not null
                and s.recorded_lf > 0
            ) width_rows
          ),
          '[]'::jsonb
        ) as observed_widths,
        coalesce(
          (
            select jsonb_agg(
              jsonb_build_object(
                'widthIn', summary_rows.width_inches,
                'maxRecordedLf', summary_rows.max_recorded_lf,
                'acceptedSampleCount', summary_rows.accepted_sample_count,
                'lastSampleAt', summary_rows.last_sample_at
              )
              order by summary_rows.width_inches
            )
            from (
              select
                s.width_inches,
                max(s.recorded_lf) as max_recorded_lf,
                count(*)::integer as accepted_sample_count,
                max(s.sample_date) as last_sample_at
              from app.film_weight_samples s
              where s.org_id = p.org_id
                and s.profile_id = p.id
                and s.acceptance_status = 'accepted'
                and s.width_inches is not null
                and s.recorded_lf is not null
                and s.recorded_lf > 0
              group by s.width_inches
            ) summary_rows
          ),
          '[]'::jsonb
        ) as width_summaries
      from app.film_weight_profiles p
      where p.org_id = $1
      order by p.updated_at desc, p.manufacturer asc, p.film_name asc, p.core_type asc
    `,
    [orgId]
  );
  return (result.rows || []).map(toFilmWeightProfileEntry);
}

async function listOpenFilmWeightPendingReviews(client, orgId) {
  const result = await client.query(
    `
      select
        r.id as review_id,
        r.profile_id,
        r.sample_id,
        r.source_box_id,
        r.manufacturer,
        r.film_name,
        r.film_key,
        r.reason,
        r.reasons,
        r.user_action_hint,
        r.status,
        r.created_at,
        r.notes,
        s.width_inches,
        s.recorded_lf,
        s.measured_roll_weight_lbs,
        s.core_type,
        s.core_weight_lbs,
        s.estimated_lf_against_profile,
        s.lf_error_against_profile,
        p.confidence as profile_confidence,
        p.status as profile_status
      from app.film_weight_pending_reviews r
      left join app.film_weight_samples s
        on s.org_id = r.org_id
       and s.id = r.sample_id
      left join app.film_weight_profiles p
        on p.org_id = r.org_id
       and p.id = r.profile_id
      where r.org_id = $1
        and r.status = 'open'
      order by r.created_at desc, r.source_box_id asc
    `,
    [orgId]
  );
  return (result.rows || []).map(toFilmWeightPendingReviewEntry);
}

async function resolveFilmWeightPendingReview(client, orgId, actor, payload = {}) {
  const row = await queryRow(
    client,
    `
      select public.api_acl_resolve_film_weight_pending_review(
        $1::uuid,
        $2::text,
        $3::jsonb
      ) as result
    `,
    [orgId, asTrimmedString(actor), payload]
  );

  return row?.result || {};
}

export {
  FILM_WEIGHT_LF_TOLERANCE,
  calculateFilmWeightMetrics,
  compareLfTolerance,
  confidenceForProfile,
  countOpenFilmWeightPendingReviews,
  estimateRemainingLfFromProfile,
  evaluateSampleAgainstProfile,
  listFilmWeightProfiles,
  listOpenFilmWeightPendingReviews,
  recordFilmWeightSampleFromBox,
  resolveFilmWeightPendingReview,
  validateSampleInput,
};
