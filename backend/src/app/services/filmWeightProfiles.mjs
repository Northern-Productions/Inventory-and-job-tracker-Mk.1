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

export {
  FILM_WEIGHT_LF_TOLERANCE,
  calculateFilmWeightMetrics,
  compareLfTolerance,
  confidenceForProfile,
  countOpenFilmWeightPendingReviews,
  estimateRemainingLfFromProfile,
  evaluateSampleAgainstProfile,
  recordFilmWeightSampleFromBox,
  validateSampleInput,
};
