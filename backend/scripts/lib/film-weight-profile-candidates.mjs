const CORE_REFERENCE_WIDTH_IN = 72;

const CORE_WEIGHT_AT_REFERENCE_WIDTH_LBS = Object.freeze({
  'White plastic': 2,
  'Red plastic': 1.85,
  'Cardboard 1/8"': 2.05,
  'Cardboard 3/8"': 6.15,
  'SECURITY 1/4" Cardboard': 11.6,
  'SECURITY White plastic 3/8"': 14.4,
});

const SOURCE_CATEGORY_LABELS = Object.freeze([
  'catalog_profile',
  'order_linked_received_box',
  'received_box_unlinked',
  'roll_history_delta',
  'manual_or_imported_box',
  'needs_weighing',
]);

const SOURCE_PRIORITY = Object.freeze({
  order_linked_received_box: 1,
  catalog_profile: 2,
  roll_history_delta: 3,
  received_box_unlinked: 4,
  manual_or_imported_box: 5,
  needs_weighing: 99,
});

const HARD_REJECT_NORMALIZED_MIN = 0.00005;
const HARD_REJECT_NORMALIZED_MAX = 0.1;
const HARD_REJECT_MEASURED_WEIGHT_MAX_LBS = 500;
const OUTLIER_RATIO_TOLERANCE = 0.35;
const SOURCE_DISAGREEMENT_TOLERANCE = 0.25;
const HIGH_VARIANCE_RATIO = 0.2;

function asText(value) {
  return String(value ?? '').trim();
}

function asNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundTo(value, decimals = 6) {
  if (!Number.isFinite(Number(value))) {
    return null;
  }
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor) / factor;
}

function normalizeLookup(value) {
  return asText(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCoreType(value) {
  const trimmed = asText(value);
  if (!trimmed) {
    return '';
  }
  const normalized = trimmed.toLowerCase().replace(/\s+/g, ' ');
  const aliases = new Map([
    ['white plastic', 'White plastic'],
    ['red plastic', 'Red plastic'],
    ['cardboard 1/8"', 'Cardboard 1/8"'],
    ['cardboard 1/8', 'Cardboard 1/8"'],
    ['cardboard 3/8"', 'Cardboard 3/8"'],
    ['cardboard 3/8', 'Cardboard 3/8"'],
    ['security 1/4" cardboard', 'SECURITY 1/4" Cardboard'],
    ['security 1/4 cardboard', 'SECURITY 1/4" Cardboard'],
    ['security white plastic 3/8"', 'SECURITY White plastic 3/8"'],
    ['security white plastic 3/8', 'SECURITY White plastic 3/8"'],
  ]);
  return aliases.get(normalized) || trimmed;
}

function median(values) {
  const sorted = values
    .map(Number)
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (sorted.length === 0) {
    return null;
  }
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function average(values) {
  const clean = values.map(Number).filter((value) => Number.isFinite(value));
  if (clean.length === 0) {
    return null;
  }
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function standardDeviation(values) {
  const clean = values.map(Number).filter((value) => Number.isFinite(value));
  if (clean.length < 2) {
    return null;
  }
  const avg = average(clean);
  const variance =
    clean.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (clean.length - 1);
  return Math.sqrt(variance);
}

function uniqueSorted(values, numeric = false) {
  const clean = values.filter((value) => value !== null && value !== undefined && value !== '');
  const unique = Array.from(new Set(clean.map((value) => (numeric ? Number(value) : asText(value)))));
  return unique.sort((left, right) =>
    numeric ? Number(left) - Number(right) : asText(left).localeCompare(asText(right))
  );
}

function countBy(values) {
  const counts = {};
  for (const value of values) {
    const key = asText(value) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function sourceCategoryRank(sourceCategory) {
  return SOURCE_PRIORITY[sourceCategory] || 50;
}

function deriveCoreWeightLbs(coreType, widthIn) {
  const normalizedCoreType = normalizeCoreType(coreType);
  const width = asNumber(widthIn);
  if (!normalizedCoreType || !Number.isFinite(width) || width <= 0) {
    return null;
  }
  const referenceWeight = CORE_WEIGHT_AT_REFERENCE_WIDTH_LBS[normalizedCoreType];
  if (!Number.isFinite(referenceWeight)) {
    return null;
  }
  return roundTo((referenceWeight / CORE_REFERENCE_WIDTH_IN) * width, 4);
}

function calculateFilmWeightFromMeasuredRoll({
  measuredRollWeightLbs,
  coreWeightLbs,
  widthIn,
  lf,
}) {
  const measured = asNumber(measuredRollWeightLbs);
  const coreWeight = asNumber(coreWeightLbs);
  const width = asNumber(widthIn);
  const linearFeet = asNumber(lf);
  if (
    measured === null ||
    coreWeight === null ||
    width === null ||
    linearFeet === null ||
    width <= 0 ||
    linearFeet <= 0
  ) {
    return null;
  }
  const filmOnlyWeightLbs = measured - coreWeight;
  if (filmOnlyWeightLbs <= 0) {
    return {
      filmOnlyWeightLbs,
      lbsPerLf: null,
      normalizedLbsPerInchFoot: null,
      lbsPerSqFt: null,
    };
  }
  const lbsPerLf = filmOnlyWeightLbs / linearFeet;
  const normalizedLbsPerInchFoot = filmOnlyWeightLbs / (width * linearFeet);
  return {
    filmOnlyWeightLbs,
    lbsPerLf,
    normalizedLbsPerInchFoot,
    lbsPerSqFt: normalizedLbsPerInchFoot * 12,
  };
}

function calculateFilmWeightFromDelta({ weightDeltaLbs, widthIn, lf }) {
  const delta = asNumber(weightDeltaLbs);
  const width = asNumber(widthIn);
  const linearFeet = asNumber(lf);
  if (delta === null || width === null || linearFeet === null || width <= 0 || linearFeet <= 0) {
    return null;
  }
  const normalizedLbsPerInchFoot = delta / (width * linearFeet);
  return {
    filmOnlyWeightLbs: delta,
    lbsPerLf: delta / linearFeet,
    normalizedLbsPerInchFoot,
    lbsPerSqFt: normalizedLbsPerInchFoot * 12,
  };
}

function estimateRollWeight({ normalizedLbsPerInchFoot, widthIn, lf, coreWeightLbs }) {
  const normalized = asNumber(normalizedLbsPerInchFoot);
  const width = asNumber(widthIn);
  const linearFeet = asNumber(lf);
  const coreWeight = asNumber(coreWeightLbs);
  if (
    normalized === null ||
    width === null ||
    linearFeet === null ||
    coreWeight === null ||
    normalized <= 0 ||
    width <= 0 ||
    linearFeet <= 0
  ) {
    return null;
  }
  return roundTo(coreWeight + normalized * width * linearFeet, 2);
}

function estimateRemainingLf({ measuredRollWeightLbs, coreWeightLbs, normalizedLbsPerInchFoot, widthIn }) {
  const measured = asNumber(measuredRollWeightLbs);
  const coreWeight = asNumber(coreWeightLbs);
  const normalized = asNumber(normalizedLbsPerInchFoot);
  const width = asNumber(widthIn);
  if (
    measured === null ||
    coreWeight === null ||
    normalized === null ||
    width === null ||
    normalized <= 0 ||
    width <= 0
  ) {
    return null;
  }
  return roundTo((measured - coreWeight) / (normalized * width), 2);
}

function profileKeyFor(entry) {
  const manufacturerKey = normalizeLookup(entry.manufacturer);
  const filmKey = normalizeLookup(entry.filmKey) || normalizeLookup(entry.filmName);
  const coreType = normalizeCoreType(entry.coreType) || 'UNKNOWN';
  return `${manufacturerKey}|${filmKey}|${normalizeLookup(coreType)}`;
}

function publicProfileIdentity(entry) {
  return {
    manufacturer: asText(entry.manufacturer),
    filmName: asText(entry.filmName),
    filmKey: asText(entry.filmKey),
    coreType: normalizeCoreType(entry.coreType) || 'UNKNOWN',
  };
}

function buildCatalogSample(row) {
  const widthIn = asNumber(row.sourceWidthIn ?? row.source_width_in);
  const lf = asNumber(row.sourceInitialFeet ?? row.source_initial_feet);
  const measuredRollWeightLbs = asNumber(
    row.sourceInitialWeightLbs ?? row.source_initial_weight_lbs
  );
  const sqFtWeight = asNumber(row.sqFtWeightLbsPerSqFt ?? row.sq_ft_weight_lbs_per_sq_ft);
  const coreType = normalizeCoreType(row.defaultCoreType ?? row.default_core_type);
  const coreWeightLbs = deriveCoreWeightLbs(coreType, widthIn);
  const derived =
    measuredRollWeightLbs !== null && coreWeightLbs !== null && widthIn !== null && lf !== null
      ? calculateFilmWeightFromMeasuredRoll({
          measuredRollWeightLbs,
          coreWeightLbs,
          widthIn,
          lf,
        })
      : null;
  const normalizedFromCatalog = sqFtWeight === null ? null : sqFtWeight / 12;
  const normalizedLbsPerInchFoot =
    normalizedFromCatalog ?? derived?.normalizedLbsPerInchFoot ?? null;
  const lbsPerSqFt = sqFtWeight ?? derived?.lbsPerSqFt ?? null;
  const lbsPerLf =
    normalizedLbsPerInchFoot !== null && widthIn !== null
      ? normalizedLbsPerInchFoot * widthIn
      : derived?.lbsPerLf ?? null;

  return {
    sourceCategory: 'catalog_profile',
    sourceId: asText(row.sourceBoxId ?? row.source_box_id) || asText(row.filmKey ?? row.film_key),
    sourceBoxId: asText(row.sourceBoxId ?? row.source_box_id),
    sourceDate: asText(row.updatedAt ?? row.updated_at),
    manufacturer: asText(row.manufacturer),
    filmName: asText(row.filmName ?? row.film_name),
    filmKey: asText(row.filmKey ?? row.film_key),
    widthIn,
    coreType,
    coreWeightLbs,
    measuredRollWeightLbs,
    lf,
    filmOnlyWeightLbs: derived?.filmOnlyWeightLbs ?? null,
    lbsPerLf,
    normalizedLbsPerInchFoot,
    lbsPerSqFt,
    orderLinked: false,
    received: false,
    qualityFlags: [
      ...(normalizedFromCatalog !== null && derived?.normalizedLbsPerInchFoot !== undefined
        ? ['catalog_weight_is_primary']
        : []),
      ...(measuredRollWeightLbs === null || lf === null || widthIn === null
        ? ['catalog_profile_lacks_complete_source_measurement']
        : []),
    ],
  };
}

function buildBoxSample(row) {
  const linked = Boolean(row.orderLinked ?? row.order_linked);
  const received = Boolean(row.receivedDate ?? row.received_date);
  const sourceCategory = linked
    ? 'order_linked_received_box'
    : received
      ? 'received_box_unlinked'
      : 'manual_or_imported_box';
  const widthIn = asNumber(row.widthIn ?? row.width_in);
  const lf = asNumber(row.initialFeet ?? row.initial_feet);
  const measuredRollWeightLbs = asNumber(row.initialWeightLbs ?? row.initial_weight_lbs);
  const coreType = normalizeCoreType(row.coreType ?? row.core_type);
  const coreWeightLbs =
    asNumber(row.coreWeightLbs ?? row.core_weight_lbs) ?? deriveCoreWeightLbs(coreType, widthIn);
  const derived = calculateFilmWeightFromMeasuredRoll({
    measuredRollWeightLbs,
    coreWeightLbs,
    widthIn,
    lf,
  });

  return {
    sourceCategory,
    sourceId: asText(row.boxId ?? row.box_id),
    sourceBoxId: asText(row.boxId ?? row.box_id),
    sourceDate: asText(row.receivedDate ?? row.received_date ?? row.updatedAt ?? row.updated_at),
    manufacturer: asText(row.manufacturer),
    filmName: asText(row.filmName ?? row.film_name),
    filmKey: asText(row.filmKey ?? row.film_key),
    widthIn,
    coreType,
    coreWeightLbs,
    measuredRollWeightLbs,
    lf,
    filmOnlyWeightLbs: derived?.filmOnlyWeightLbs ?? null,
    lbsPerLf: derived?.lbsPerLf ?? null,
    normalizedLbsPerInchFoot: derived?.normalizedLbsPerInchFoot ?? null,
    lbsPerSqFt: derived?.lbsPerSqFt ?? null,
    orderLinked: linked,
    received,
    qualityFlags: [],
  };
}

function buildRollHistorySample(row) {
  const widthIn = asNumber(row.widthIn ?? row.width_in);
  const feetBefore = asNumber(row.feetBefore ?? row.feet_before);
  const feetAfter = asNumber(row.feetAfter ?? row.feet_after);
  const lf = feetBefore !== null && feetAfter !== null ? feetBefore - feetAfter : null;
  const checkedOutWeight = asNumber(row.checkedOutWeightLbs ?? row.checked_out_weight_lbs);
  const checkedInWeight = asNumber(row.checkedInWeightLbs ?? row.checked_in_weight_lbs);
  const weightDelta =
    asNumber(row.weightDeltaLbs ?? row.weight_delta_lbs) ??
    (checkedOutWeight !== null && checkedInWeight !== null ? checkedOutWeight - checkedInWeight : null);
  const derived = calculateFilmWeightFromDelta({ weightDeltaLbs: weightDelta, widthIn, lf });

  return {
    sourceCategory: 'roll_history_delta',
    sourceId: asText(row.logId ?? row.log_id),
    sourceBoxId: asText(row.boxId ?? row.box_id),
    sourceDate: asText(row.checkedInAt ?? row.checked_in_at ?? row.createdAt ?? row.created_at),
    manufacturer: asText(row.manufacturer),
    filmName: asText(row.filmName ?? row.film_name),
    filmKey: asText(row.filmKey ?? row.film_key),
    widthIn,
    coreType: normalizeCoreType(row.coreType ?? row.core_type),
    coreWeightLbs: asNumber(row.coreWeightLbs ?? row.core_weight_lbs),
    measuredRollWeightLbs: checkedOutWeight,
    lf,
    filmOnlyWeightLbs: derived?.filmOnlyWeightLbs ?? null,
    lbsPerLf: derived?.lbsPerLf ?? null,
    normalizedLbsPerInchFoot: derived?.normalizedLbsPerInchFoot ?? null,
    lbsPerSqFt: derived?.lbsPerSqFt ?? null,
    orderLinked: false,
    received: true,
    qualityFlags: ['core_cancels_out_in_weight_delta'],
  };
}

function evaluateSample(sample) {
  const rejectionReasons = [];
  const qualityFlags = [...(sample.qualityFlags || [])];
  const manufacturer = asText(sample.manufacturer);
  const filmName = asText(sample.filmName);
  const widthIn = asNumber(sample.widthIn);
  const lf = asNumber(sample.lf);
  const measuredRollWeightLbs = asNumber(sample.measuredRollWeightLbs);
  const coreWeightLbs = asNumber(sample.coreWeightLbs);
  const normalized = asNumber(sample.normalizedLbsPerInchFoot);
  const lbsPerSqFt = asNumber(sample.lbsPerSqFt);
  const sourceCategory = asText(sample.sourceCategory) || 'unknown';

  if (!manufacturer) {
    rejectionReasons.push('missing_manufacturer');
  }
  if (!filmName) {
    rejectionReasons.push('missing_film_name');
  }
  if (widthIn === null || widthIn <= 0) {
    rejectionReasons.push('missing_or_invalid_width');
  }
  if (lf === null || lf <= 0) {
    if (sourceCategory === 'catalog_profile' && normalized !== null && normalized > 0) {
      qualityFlags.push('catalog_profile_missing_source_lf');
    } else {
      rejectionReasons.push('missing_or_invalid_lf');
    }
  }
  if (sourceCategory !== 'catalog_profile' && (measuredRollWeightLbs === null || measuredRollWeightLbs <= 0)) {
    rejectionReasons.push('missing_or_invalid_measured_weight');
  }
  if (sourceCategory !== 'roll_history_delta' && (coreWeightLbs === null || coreWeightLbs < 0)) {
    rejectionReasons.push('missing_or_invalid_core_weight');
  }
  if (sourceCategory !== 'catalog_profile' && sample.filmOnlyWeightLbs !== null && sample.filmOnlyWeightLbs <= 0) {
    rejectionReasons.push('film_only_weight_not_positive');
  }
  if (measuredRollWeightLbs !== null && measuredRollWeightLbs > HARD_REJECT_MEASURED_WEIGHT_MAX_LBS) {
    rejectionReasons.push('measured_weight_extremely_high');
  }
  if (normalized === null || !Number.isFinite(normalized)) {
    rejectionReasons.push('missing_normalized_weight');
  } else if (normalized <= 0) {
    rejectionReasons.push('normalized_weight_not_positive');
  } else if (normalized < HARD_REJECT_NORMALIZED_MIN) {
    rejectionReasons.push('normalized_weight_extremely_low');
  } else if (normalized > HARD_REJECT_NORMALIZED_MAX) {
    rejectionReasons.push('normalized_weight_extremely_high');
  }

  return {
    ...sample,
    manufacturer,
    filmName,
    filmKey: asText(sample.filmKey),
    coreType: normalizeCoreType(sample.coreType) || 'UNKNOWN',
    widthIn,
    lf,
    measuredRollWeightLbs,
    coreWeightLbs,
    normalizedLbsPerInchFoot: normalized,
    lbsPerSqFt,
    lbsPerLf: asNumber(sample.lbsPerLf),
    filmOnlyWeightLbs: asNumber(sample.filmOnlyWeightLbs),
    sourceCategory,
    sourceBoxId: asText(sample.sourceBoxId),
    sourceDate: asText(sample.sourceDate),
    orderLinked: Boolean(sample.orderLinked),
    received: Boolean(sample.received),
    qualityFlags: uniqueSorted(qualityFlags),
    rejectionReasons: uniqueSorted(rejectionReasons),
    hardRejected: rejectionReasons.length > 0,
    outlier: false,
    outlierReasons: [],
  };
}

function inferLikelyFullRollLf(lfValues) {
  const counts = countBy(
    lfValues
      .map(asNumber)
      .filter((value) => value !== null && value > 0)
      .map((value) => Math.round(value))
  );
  const entries = Object.entries(counts).map(([value, count]) => ({
    lf: Number(value),
    count,
  }));
  if (entries.length === 0) {
    return null;
  }
  const likely = entries
    .filter((entry) => entry.lf >= 50)
    .sort((left, right) => right.count - left.count || right.lf - left.lf)[0];
  if (likely) {
    return likely.lf;
  }
  return entries.sort((left, right) => right.count - left.count || right.lf - left.lf)[0].lf;
}

function summarizeSourceMix(samples) {
  const all = countBy(samples.map((sample) => sample.sourceCategory));
  const accepted = countBy(
    samples
      .filter((sample) => !sample.hardRejected && !sample.outlier)
      .map((sample) => sample.sourceCategory)
  );
  return { all, accepted };
}

function resolveRecommendedSourceType(samples) {
  const accepted = samples.filter((sample) => !sample.hardRejected && !sample.outlier);
  if (accepted.length === 0) {
    return 'needs_weighing';
  }
  return [...accepted].sort(
    (left, right) =>
      sourceCategoryRank(left.sourceCategory) - sourceCategoryRank(right.sourceCategory)
  )[0].sourceCategory;
}

function calculateSourceDisagreements(samples, groupMedian) {
  if (!groupMedian || groupMedian <= 0) {
    return [];
  }
  const bySource = new Map();
  for (const sample of samples) {
    if (sample.hardRejected || sample.outlier) {
      continue;
    }
    const values = bySource.get(sample.sourceCategory) || [];
    values.push(sample.normalizedLbsPerInchFoot);
    bySource.set(sample.sourceCategory, values);
  }
  const disagreements = [];
  for (const [sourceCategory, values] of bySource.entries()) {
    const sourceMedian = median(values);
    if (!sourceMedian || values.length === 0) {
      continue;
    }
    const ratio = sourceMedian / groupMedian;
    if (ratio > 1 + SOURCE_DISAGREEMENT_TOLERANCE || ratio < 1 - SOURCE_DISAGREEMENT_TOLERANCE) {
      disagreements.push({
        sourceCategory,
        medianNormalizedLbsPerInchFoot: roundTo(sourceMedian, 8),
        ratioToGroupMedian: roundTo(ratio, 3),
      });
    }
  }
  return disagreements;
}

function confidenceForProfile({
  acceptedSamples,
  outlierCount,
  hardRejectedCount,
  variationRatio,
  sourceDisagreements,
  sourceMix,
  widthCount,
}) {
  if (acceptedSamples.length === 0) {
    return 'Needs Weighing';
  }
  if (
    outlierCount > 0 ||
    hardRejectedCount > 0 ||
    sourceDisagreements.length > 0 ||
    (variationRatio !== null && variationRatio > 0.35)
  ) {
    return 'Needs Review';
  }

  const acceptedSourceCounts = sourceMix.accepted || {};
  const orderLinkedSamples = acceptedSourceCounts.order_linked_received_box || 0;
  const trustedSamples =
    orderLinkedSamples +
    (acceptedSourceCounts.catalog_profile || 0) +
    (acceptedSourceCounts.roll_history_delta || 0);

  if (
    acceptedSamples.length >= 3 &&
    orderLinkedSamples >= 1 &&
    widthCount >= 2 &&
    (variationRatio === null || variationRatio <= 0.15)
  ) {
    return 'High';
  }
  if (
    (acceptedSamples.length >= 2 && trustedSamples >= 1 && (variationRatio === null || variationRatio <= 0.25)) ||
    (acceptedSourceCounts.order_linked_received_box >= 1 &&
      (acceptedSourceCounts.catalog_profile >= 1 || acceptedSourceCounts.roll_history_delta >= 1))
  ) {
    return 'Medium';
  }
  return 'Low';
}

function summarizeWidthRows(profile, universeWidths = []) {
  const accepted = profile.samples.filter((sample) => !sample.hardRejected && !sample.outlier);
  const widths = uniqueSorted(
    [...accepted.map((sample) => sample.widthIn), ...universeWidths].filter(Boolean),
    true
  );
  return widths.map((widthIn) => {
    const widthSamples = accepted.filter((sample) => sample.widthIn === widthIn);
    const lfValues = widthSamples.map((sample) => sample.lf).filter((value) => value !== null);
    const likelyFullRollLf = inferLikelyFullRollLf(lfValues);
    const coreWeightValues = widthSamples
      .map((sample) => sample.coreWeightLbs)
      .filter((value) => value !== null);
    const coreWeightLbs =
      median(coreWeightValues) ?? deriveCoreWeightLbs(profile.coreType, widthIn);
    const recommendedLbsPerLf =
      profile.recommendedNormalizedLbsPerInchFoot === null
        ? null
        : profile.recommendedNormalizedLbsPerInchFoot * widthIn;
    return {
      manufacturer: profile.manufacturer,
      filmName: profile.filmName,
      filmKey: profile.filmKey,
      coreType: profile.coreType,
      widthIn,
      likelyFullRollLf,
      recommendedFullRollWeightLbs:
        likelyFullRollLf === null
          ? null
          : estimateRollWeight({
              normalizedLbsPerInchFoot: profile.recommendedNormalizedLbsPerInchFoot,
              widthIn,
              lf: likelyFullRollLf,
              coreWeightLbs,
            }),
      recommendedLbsPerLf:
        recommendedLbsPerLf === null ? null : roundTo(recommendedLbsPerLf, 6),
      sampleCount: widthSamples.length,
      confidence: profile.confidence,
      basis: widthSamples.length > 0 ? 'measured' : 'derived_from_profile',
      notes: widthSamples.length > 0 ? [] : ['no_width_specific_sample'],
    };
  });
}

function shouldShowAsOutlierExample(sample) {
  if (sample.outlier) {
    return true;
  }
  const severeReasons = new Set([
    'measured_weight_extremely_high',
    'normalized_weight_extremely_high',
    'normalized_weight_extremely_low',
    'normalized_weight_not_positive',
    'film_only_weight_not_positive',
  ]);
  return sample.rejectionReasons.some((reason) => severeReasons.has(reason));
}

function outlierExampleKey(sample) {
  return [
    sample.sourceCategory,
    sample.sourceId || sample.sourceBoxId,
    sample.manufacturer,
    sample.filmName,
    sample.widthIn,
    sample.lf,
    sample.measuredRollWeightLbs,
    sample.normalizedLbsPerInchFoot,
    sample.rejectionReasons.join(','),
    sample.outlierReasons.join(','),
  ].join('|');
}

function buildUniverseEntries({ boxRows = [], catalogRows = [] } = {}) {
  const entries = [];
  for (const row of catalogRows) {
    entries.push({
      ...publicProfileIdentity({
        manufacturer: row.manufacturer,
        filmName: row.filmName ?? row.film_name,
        filmKey: row.filmKey ?? row.film_key,
        coreType: row.defaultCoreType ?? row.default_core_type,
      }),
      widthIn: asNumber(row.sourceWidthIn ?? row.source_width_in),
      lf: asNumber(row.sourceInitialFeet ?? row.source_initial_feet),
    });
  }
  for (const row of boxRows) {
    entries.push({
      ...publicProfileIdentity({
        manufacturer: row.manufacturer,
        filmName: row.filmName ?? row.film_name,
        filmKey: row.filmKey ?? row.film_key,
        coreType: row.coreType ?? row.core_type,
      }),
      widthIn: asNumber(row.widthIn ?? row.width_in),
      lf: asNumber(row.initialFeet ?? row.initial_feet),
    });
  }
  return entries.filter((entry) => entry.manufacturer && entry.filmName);
}

function buildRawSamples({ catalogRows = [], boxRows = [], rollHistoryRows = [] } = {}) {
  return [
    ...catalogRows.map(buildCatalogSample),
    ...boxRows.map(buildBoxSample),
    ...rollHistoryRows.map(buildRollHistorySample),
  ];
}

function analyzeFilmWeightProfileCandidates({
  catalogRows = [],
  boxRows = [],
  rollHistoryRows = [],
  stats = {},
  limit = 25,
} = {}) {
  const rawSamples = buildRawSamples({ catalogRows, boxRows, rollHistoryRows });
  const evaluatedSamples = rawSamples.map(evaluateSample);
  const universeEntries = buildUniverseEntries({ catalogRows, boxRows });
  const groups = new Map();

  for (const entry of universeEntries) {
    const key = profileKeyFor(entry);
    const existing =
      groups.get(key) || {
        key,
        ...publicProfileIdentity(entry),
        universeWidths: [],
        universeRollLengths: [],
        samples: [],
      };
    if (entry.widthIn !== null && entry.widthIn > 0) {
      existing.universeWidths.push(entry.widthIn);
    }
    if (entry.lf !== null && entry.lf > 0) {
      existing.universeRollLengths.push(entry.lf);
    }
    groups.set(key, existing);
  }

  for (const sample of evaluatedSamples) {
    const key = profileKeyFor(sample);
    const existing =
      groups.get(key) || {
        key,
        ...publicProfileIdentity(sample),
        universeWidths: [],
        universeRollLengths: [],
        samples: [],
      };
    existing.samples.push(sample);
    if (sample.widthIn !== null && sample.widthIn > 0) {
      existing.universeWidths.push(sample.widthIn);
    }
    if (sample.lf !== null && sample.lf > 0) {
      existing.universeRollLengths.push(sample.lf);
    }
    groups.set(key, existing);
  }

  const profiles = [];
  const allRejectedReasons = [];
  const outlierExamples = [];

  for (const group of groups.values()) {
    const usableBeforeOutlier = group.samples.filter((sample) => !sample.hardRejected);
    const medianBeforeOutlier = median(
      usableBeforeOutlier.map((sample) => sample.normalizedLbsPerInchFoot)
    );

    const samples = group.samples.map((sample) => {
      if (
        !sample.hardRejected &&
        usableBeforeOutlier.length >= 3 &&
        medianBeforeOutlier &&
        medianBeforeOutlier > 0
      ) {
        const ratio = sample.normalizedLbsPerInchFoot / medianBeforeOutlier;
        if (ratio > 1 + OUTLIER_RATIO_TOLERANCE || ratio < 1 - OUTLIER_RATIO_TOLERANCE) {
          return {
            ...sample,
            outlier: true,
            outlierReasons: [
              `normalized_weight_${roundTo(ratio, 3)}x_group_median`,
            ],
          };
        }
      }
      return sample;
    });

    for (const sample of samples) {
      for (const reason of sample.rejectionReasons) {
        allRejectedReasons.push(reason);
      }
      if (shouldShowAsOutlierExample(sample)) {
        outlierExamples.push(sample);
      }
    }

    const acceptedSamples = samples.filter((sample) => !sample.hardRejected && !sample.outlier);
    const acceptedValues = acceptedSamples.map((sample) => sample.normalizedLbsPerInchFoot);
    const recommendedNormalized = median(acceptedValues);
    const avgNormalized = average(acceptedValues);
    const minNormalized = acceptedValues.length ? Math.min(...acceptedValues) : null;
    const maxNormalized = acceptedValues.length ? Math.max(...acceptedValues) : null;
    const variationRatio =
      recommendedNormalized && minNormalized !== null && maxNormalized !== null
        ? (maxNormalized - minNormalized) / recommendedNormalized
        : null;
    const sourceMix = summarizeSourceMix(samples);
    const sourceDisagreements = calculateSourceDisagreements(samples, recommendedNormalized);
    const observedWidths = uniqueSorted(
      [...group.universeWidths, ...acceptedSamples.map((sample) => sample.widthIn)].filter(Boolean),
      true
    );
    const observedRollLengths = uniqueSorted(
      [...group.universeRollLengths, ...acceptedSamples.map((sample) => sample.lf)].filter(Boolean),
      true
    );
    const confidence = confidenceForProfile({
      acceptedSamples,
      outlierCount: samples.filter((sample) => sample.outlier).length,
      hardRejectedCount: samples.filter((sample) => sample.hardRejected).length,
      variationRatio,
      sourceDisagreements,
      sourceMix,
      widthCount: uniqueSorted(acceptedSamples.map((sample) => sample.widthIn), true).length,
    });
    const notes = [];
    if (sourceDisagreements.length > 0) {
      notes.push('source_disagreement');
    }
    if (variationRatio !== null && variationRatio > HIGH_VARIANCE_RATIO) {
      notes.push('high_sample_variance');
    }
    if (acceptedSamples.length === 1) {
      notes.push('single_usable_sample');
    }
    if (acceptedSamples.length === 0) {
      notes.push('no_usable_weight_samples');
    }

    const profile = {
      key: group.key,
      manufacturer: group.manufacturer,
      filmName: group.filmName,
      filmKey: group.filmKey,
      coreType: group.coreType,
      confidence,
      sampleCountTotal: samples.length,
      acceptedSampleCount: acceptedSamples.length,
      hardRejectedSampleCount: samples.filter((sample) => sample.hardRejected).length,
      outlierSampleCount: samples.filter((sample) => sample.outlier).length,
      sourceMix,
      observedWidths,
      observedRollLengths,
      likelyFullRollLf: inferLikelyFullRollLf(observedRollLengths),
      averageNormalizedLbsPerInchFoot:
        avgNormalized === null ? null : roundTo(avgNormalized, 8),
      medianNormalizedLbsPerInchFoot:
        recommendedNormalized === null ? null : roundTo(recommendedNormalized, 8),
      averageLbsPerSqFt: avgNormalized === null ? null : roundTo(avgNormalized * 12, 8),
      medianLbsPerSqFt: recommendedNormalized === null ? null : roundTo(recommendedNormalized * 12, 8),
      minNormalizedLbsPerInchFoot:
        minNormalized === null ? null : roundTo(minNormalized, 8),
      maxNormalizedLbsPerInchFoot:
        maxNormalized === null ? null : roundTo(maxNormalized, 8),
      stddevNormalizedLbsPerInchFoot: roundTo(standardDeviation(acceptedValues), 8),
      variationRatio: roundTo(variationRatio, 4),
      recommendedNormalizedLbsPerInchFoot:
        recommendedNormalized === null ? null : roundTo(recommendedNormalized, 8),
      recommendedLbsPerSqFt:
        recommendedNormalized === null ? null : roundTo(recommendedNormalized * 12, 8),
      recommendedSourceType: resolveRecommendedSourceType(samples),
      sourceDisagreements,
      notes: uniqueSorted(notes),
      samples,
    };
    profile.widthRows = summarizeWidthRows(profile, group.universeWidths);
    profiles.push(profile);
  }

  profiles.sort((left, right) => {
    const confidenceOrder = {
      High: 1,
      Medium: 2,
      Low: 3,
      'Needs Review': 4,
      'Needs Weighing': 5,
    };
    return (
      confidenceOrder[left.confidence] - confidenceOrder[right.confidence] ||
      right.acceptedSampleCount - left.acceptedSampleCount ||
      left.manufacturer.localeCompare(right.manufacturer) ||
      left.filmName.localeCompare(right.filmName)
    );
  });

  const confidenceCounts = countBy(profiles.map((profile) => profile.confidence));
  const sourceCategoryCounts = countBy(evaluatedSamples.map((sample) => sample.sourceCategory));
  const acceptedSourceCategoryCounts = countBy(
    profiles.flatMap((profile) =>
      profile.samples
        .filter((sample) => !sample.hardRejected && !sample.outlier)
        .map((sample) => sample.sourceCategory)
    )
  );
  const rejectedReasonCounts = countBy(allRejectedReasons);
  const widthRows = profiles.flatMap((profile) => profile.widthRows);
  const needsWeighing = profiles.filter((profile) => profile.confidence === 'Needs Weighing');
  const needsReview = profiles.filter((profile) => profile.confidence === 'Needs Review');
  const acceptedSampleCount = profiles.reduce(
    (total, profile) => total + profile.acceptedSampleCount,
    0
  );
  const rejectedSampleCount = evaluatedSamples.filter((sample) => sample.hardRejected).length;
  const outlierSampleCount = profiles.reduce(
    (total, profile) => total + profile.outlierSampleCount,
    0
  );

  const dedupedOutlierExamples = [];
  const seenOutlierExamples = new Set();
  for (const sample of outlierExamples) {
    const key = outlierExampleKey(sample);
    if (seenOutlierExamples.has(key)) {
      continue;
    }
    seenOutlierExamples.add(key);
    dedupedOutlierExamples.push(sample);
  }

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      ...stats,
      rawSampleCount: rawSamples.length,
      usableSamples: acceptedSampleCount,
      rejectedSamples: rejectedSampleCount,
      outlierSamples: outlierSampleCount,
      candidateProfilesGenerated: profiles.length,
      confidenceCounts,
      sourceCategoryCounts,
      acceptedSourceCategoryCounts,
      rejectedReasonCounts,
    },
    profiles,
    widthRows,
    outliers: dedupedOutlierExamples
      .sort((left, right) => {
        if (left.outlier !== right.outlier) {
          return left.outlier ? -1 : 1;
        }
        return left.manufacturer.localeCompare(right.manufacturer);
      })
      .slice(0, Math.max(limit * 2, 20)),
    needsReview,
    needsWeighing,
    internetResearchPrep: buildInternetResearchPrep(profiles, limit),
  };
}

function formatSourceMix(sourceMix) {
  const counts = sourceMix?.accepted || sourceMix?.all || {};
  return Object.entries(counts)
    .sort(([left], [right]) => sourceCategoryRank(left) - sourceCategoryRank(right))
    .map(([source, count]) => `${source}:${count}`)
    .join(', ');
}

function compactList(values, max = 8) {
  const clean = Array.isArray(values) ? values : [];
  if (clean.length <= max) {
    return clean.join(', ');
  }
  return `${clean.slice(0, max).join(', ')} (+${clean.length - max} more)`;
}

function buildInternetResearchPrep(profiles, limit = 25) {
  return profiles
    .filter((profile) =>
      ['Needs Weighing', 'Needs Review', 'Low'].includes(profile.confidence)
    )
    .slice(0, limit)
    .map((profile) => ({
      manufacturer: profile.manufacturer,
      filmName: profile.filmName,
      widthsPresent: profile.observedWidths,
      internalDataConfidence: profile.confidence,
      suspectedFullRollLf: profile.likelyFullRollLf,
      suggestedSearches: [
        `${profile.manufacturer} ${profile.filmName} roll weight`,
        `${profile.manufacturer} ${profile.filmName} roll length width`,
        `${profile.manufacturer} ${profile.filmName} specifications PDF`,
      ],
    }));
}

function sanitizeSampleForReport(sample) {
  return {
    sourceCategory: sample.sourceCategory,
    sourceBoxId: sample.sourceBoxId || '',
    manufacturer: sample.manufacturer,
    filmName: sample.filmName,
    widthIn: sample.widthIn,
    lf: sample.lf,
    measuredRollWeightLbs: sample.measuredRollWeightLbs,
    coreWeightLbs: sample.coreWeightLbs,
    normalizedLbsPerInchFoot: roundTo(sample.normalizedLbsPerInchFoot, 8),
    lbsPerSqFt: roundTo(sample.lbsPerSqFt, 8),
    hardRejected: sample.hardRejected,
    rejectionReasons: sample.rejectionReasons,
    outlier: sample.outlier,
    outlierReasons: sample.outlierReasons,
  };
}

function profileForReport(profile, includeSamples = false) {
  const base = {
    manufacturer: profile.manufacturer,
    filmName: profile.filmName,
    filmKey: profile.filmKey,
    coreType: profile.coreType,
    confidence: profile.confidence,
    recommendedLbsPerSqFt: profile.recommendedLbsPerSqFt,
    recommendedNormalizedLbsPerInchFoot: profile.recommendedNormalizedLbsPerInchFoot,
    acceptedSampleCount: profile.acceptedSampleCount,
    rejectedSampleCount: profile.hardRejectedSampleCount,
    outlierSampleCount: profile.outlierSampleCount,
    recommendedSourceType: profile.recommendedSourceType,
    sourceMix: profile.sourceMix,
    observedWidths: profile.observedWidths,
    observedRollLengths: profile.observedRollLengths,
    likelyFullRollLf: profile.likelyFullRollLf,
    notes: profile.notes,
  };
  if (includeSamples) {
    base.samples = profile.samples.map(sanitizeSampleForReport);
  }
  return base;
}

function buildJsonReport(report, { limit = 25, includeSamples = false } = {}) {
  return {
    generatedAt: report.generatedAt,
    summary: report.summary,
    profiles: report.profiles.slice(0, limit).map((profile) => profileForReport(profile, includeSamples)),
    widthRows: report.widthRows.slice(0, limit).map((row) => ({
      ...row,
      recommendedNormalizedLbsPerInchFoot: undefined,
    })),
    needsReview: report.needsReview.slice(0, limit).map((profile) => profileForReport(profile, includeSamples)),
    needsWeighing: report.needsWeighing.slice(0, limit).map((profile) => profileForReport(profile, includeSamples)),
    outliers: report.outliers.slice(0, limit).map(sanitizeSampleForReport),
    internetResearchPrep: report.internetResearchPrep.slice(0, limit),
  };
}

function formatProfileLine(profile) {
  return [
    profile.confidence.padEnd(13),
    profile.manufacturer,
    profile.filmName,
    profile.coreType,
    `sqft=${profile.recommendedLbsPerSqFt ?? 'n/a'}`,
    `norm=${profile.recommendedNormalizedLbsPerInchFoot ?? 'n/a'}`,
    `samples=${profile.acceptedSampleCount}`,
    `sources=${formatSourceMix(profile.sourceMix) || 'none'}`,
    `widths=${compactList(profile.observedWidths, 5) || 'n/a'}`,
    `lf=${compactList(profile.observedRollLengths, 5) || 'n/a'}`,
    profile.notes.length ? `notes=${profile.notes.join(',')}` : '',
  ]
    .filter(Boolean)
    .join(' | ');
}

function formatTextReport(report, { limit = 25 } = {}) {
  const lines = [];
  lines.push('Film Weight Profile Candidate Dry Run');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push('Summary');
  for (const [key, value] of Object.entries(report.summary)) {
    lines.push(`- ${key}: ${JSON.stringify(value)}`);
  }

  lines.push('');
  lines.push(`Top Candidate Profiles (limit ${limit})`);
  for (const profile of report.profiles.slice(0, limit)) {
    lines.push(`- ${formatProfileLine(profile)}`);
  }

  lines.push('');
  lines.push(`Width-Specific Rows (limit ${limit})`);
  for (const row of report.widthRows.slice(0, limit)) {
    lines.push(
      `- ${row.manufacturer} | ${row.filmName} | ${row.coreType} | width=${row.widthIn} | lf=${row.likelyFullRollLf ?? 'n/a'} | fullWeight=${row.recommendedFullRollWeightLbs ?? 'n/a'} | lbsPerLf=${row.recommendedLbsPerLf ?? 'n/a'} | samples=${row.sampleCount} | ${row.confidence} | ${row.basis}`
    );
  }

  lines.push('');
  lines.push(`Needs Review (limit ${limit})`);
  for (const profile of report.needsReview.slice(0, limit)) {
    lines.push(`- ${formatProfileLine(profile)}`);
  }

  lines.push('');
  lines.push(`Needs Weighing (limit ${limit})`);
  for (const profile of report.needsWeighing.slice(0, limit)) {
    lines.push(
      `- ${profile.manufacturer} | ${profile.filmName} | ${profile.coreType} | widths=${compactList(profile.observedWidths, 5) || 'n/a'} | lf=${compactList(profile.observedRollLengths, 5) || 'n/a'}`
    );
  }

  lines.push('');
  lines.push(`Outliers / Rejections (limit ${limit})`);
  for (const sample of report.outliers.slice(0, limit)) {
    lines.push(
      `- ${sample.sourceCategory} | ${sample.sourceBoxId || sample.sourceId || 'n/a'} | ${sample.manufacturer} | ${sample.filmName} | width=${sample.widthIn ?? 'n/a'} | lf=${sample.lf ?? 'n/a'} | weight=${sample.measuredRollWeightLbs ?? 'n/a'} | norm=${roundTo(sample.normalizedLbsPerInchFoot, 8) ?? 'n/a'} | reasons=${[...sample.rejectionReasons, ...sample.outlierReasons].join(',')}`
    );
  }

  lines.push('');
  lines.push(`Internet Research Prep (limit ${limit})`);
  for (const item of report.internetResearchPrep.slice(0, limit)) {
    lines.push(
      `- ${item.manufacturer} | ${item.filmName} | confidence=${item.internalDataConfidence} | widths=${compactList(item.widthsPresent, 5) || 'n/a'} | suspected LF=${item.suspectedFullRollLf ?? 'n/a'} | searches=${item.suggestedSearches.join(' ; ')}`
    );
  }
  return lines.join('\n');
}

export {
  CORE_WEIGHT_AT_REFERENCE_WIDTH_LBS,
  SOURCE_CATEGORY_LABELS,
  analyzeFilmWeightProfileCandidates,
  buildBoxSample,
  buildCatalogSample,
  buildInternetResearchPrep,
  buildJsonReport,
  buildRawSamples,
  buildRollHistorySample,
  calculateFilmWeightFromDelta,
  calculateFilmWeightFromMeasuredRoll,
  deriveCoreWeightLbs,
  estimateRemainingLf,
  estimateRollWeight,
  evaluateSample,
  formatTextReport,
  inferLikelyFullRollLf,
  median,
  normalizeCoreType,
  profileKeyFor,
};
