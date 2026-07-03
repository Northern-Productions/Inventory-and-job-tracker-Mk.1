import {
  calculateFilmWeightFromMeasuredRoll,
  normalizeCoreType,
} from './film-weight-profile-candidates.mjs';
import {
  normalizeCanonicalManufacturerAndFilm,
  normalizeCatalogLookupKey,
  normalizeCatalogManufacturerLookupKey,
  normalizeFilmKeyInput,
} from '../../src/app/core/catalog.mjs';

const DEFAULT_CUTOFF_DATE = '2026-04-05';
const DEFAULT_LF_TOLERANCE = 10;
const MAX_MEASURED_WEIGHT_LBS = 500;
const NORMALIZED_WEIGHT_MIN = 0.00005;
const NORMALIZED_WEIGHT_MAX = 0.1;

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

function dateOnly(value) {
  if (!value) {
    return '';
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const text = asText(value);
  if (!text) {
    return '';
  }
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) {
    return match[1];
  }
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime())) {
    return '';
  }
  return parsed.toISOString().slice(0, 10);
}

function selectTrustedSampleDate(row) {
  const lastWeighedDate = dateOnly(row.lastWeighedDate ?? row.last_weighed_date);
  if (lastWeighedDate) {
    return { sampleDate: lastWeighedDate, dateBasis: 'last_weighed_date' };
  }
  const receivedDate = dateOnly(row.receivedDate ?? row.received_date);
  if (receivedDate) {
    return { sampleDate: receivedDate, dateBasis: 'received_date' };
  }
  const createdDate = dateOnly(row.createdAt ?? row.created_at);
  if (createdDate) {
    return { sampleDate: createdDate, dateBasis: 'created_at' };
  }
  return { sampleDate: '', dateBasis: 'missing_date' };
}

function makeAliasMap(aliasRows = []) {
  const map = new Map();
  for (const row of aliasRows) {
    const orgId = asText(row.orgId ?? row.org_id);
    const manufacturerLookupKey = asText(row.manufacturerLookupKey ?? row.manufacturer_lookup_key);
    const oldFilmNameLookupKey = asText(row.oldFilmNameLookupKey ?? row.old_film_name_lookup_key);
    const canonicalFilmName = asText(row.canonicalFilmName ?? row.canonical_film_name);
    if (!orgId || !manufacturerLookupKey || !oldFilmNameLookupKey || !canonicalFilmName) {
      continue;
    }
    map.set(`${orgId}\0${manufacturerLookupKey}\0${oldFilmNameLookupKey}`, canonicalFilmName);
  }
  return map;
}

function resolveCanonicalFilmIdentity(row, aliasMap = new Map()) {
  const orgId = asText(row.orgId ?? row.org_id);
  const sourceManufacturer = asText(row.manufacturer);
  const sourceFilmName = asText(row.filmName ?? row.film_name);
  if (!sourceManufacturer || !sourceFilmName) {
    return {
      canonicalManufacturer: '',
      canonicalFilmName: '',
      canonicalFilmKey: '',
      aliasApplied: false,
    };
  }

  const normalized = normalizeCanonicalManufacturerAndFilm(sourceManufacturer, sourceFilmName);
  const aliasKey = [
    orgId,
    normalizeCatalogManufacturerLookupKey(normalized.manufacturer),
    normalizeCatalogLookupKey(normalized.filmName),
  ].join('\0');
  const aliasFilmName = aliasMap.get(aliasKey);
  const aliasResolved = aliasFilmName
    ? normalizeCanonicalManufacturerAndFilm(normalized.manufacturer, aliasFilmName)
    : normalized;
  return {
    canonicalManufacturer: aliasResolved.manufacturer,
    canonicalFilmName: aliasResolved.filmName,
    canonicalFilmKey: normalizeFilmKeyInput(
      aliasResolved.manufacturer,
      aliasResolved.filmName,
      row.filmKey ?? row.film_key
    ),
    aliasApplied: Boolean(aliasFilmName),
  };
}

function uniqueSorted(values, numeric = false) {
  const clean = values.filter((value) => value !== null && value !== undefined && value !== '');
  const unique = Array.from(new Set(clean.map((value) => (numeric ? Number(value) : asText(value)))));
  return unique.sort((left, right) =>
    numeric ? Number(left) - Number(right) : asText(left).localeCompare(asText(right))
  );
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = asText(keyFn(item)) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([leftKey, leftCount], [rightKey, rightCount]) => {
      if (rightCount !== leftCount) {
        return rightCount - leftCount;
      }
      return leftKey.localeCompare(rightKey);
    })
  );
}

function addPendingReason(reasons, condition, reason) {
  if (condition) {
    reasons.push(reason);
  }
}

function userActionsForReasons(reasons = []) {
  const actions = new Set();
  for (const reason of reasons) {
    if (reason.includes('core_type') || reason.includes('core_weight')) {
      actions.add('add core type/core weight');
    } else if (reason.includes('lf')) {
      actions.add('correct LF');
    } else if (reason.includes('measured_weight') || reason.includes('film_only') || reason.includes('normalized')) {
      actions.add('re-weigh');
    } else if (reason.includes('film_identity') || reason.includes('manufacturer')) {
      actions.add('split/correct film name');
    } else if (reason.includes('outside_10_lf_tolerance')) {
      actions.add('approve as valid or reject sample');
    } else {
      actions.add('review sample');
    }
  }
  return Array.from(actions).sort();
}

function buildTrustedSampleCandidate(row, aliasMap = new Map()) {
  const sourceBoxId = asText(row.boxId ?? row.box_id);
  const sourceFilmOrderIds = asText(row.filmOrderIds ?? row.film_order_ids ?? row.filmOrderId ?? row.film_order_id);
  const sourceLinkIds = asText(row.linkIds ?? row.link_ids ?? row.linkId ?? row.link_id);
  const sourceStatus = asText(row.status);
  const sourceFilmOrderStatuses = asText(row.filmOrderStatuses ?? row.film_order_statuses ?? row.filmOrderStatus ?? row.film_order_status);
  const sourceIsOrdered = Boolean(sourceFilmOrderIds || sourceLinkIds || sourceStatus.toUpperCase() === 'ORDERED');
  const dateSelection = selectTrustedSampleDate(row);
  const widthIn = asNumber(row.widthIn ?? row.width_in);
  const lf = asNumber(row.initialFeet ?? row.initial_feet ?? row.orderedFeet ?? row.ordered_feet);
  const measuredRollWeightLbs = asNumber(row.initialWeightLbs ?? row.initial_weight_lbs);
  const coreType = normalizeCoreType(row.coreType ?? row.core_type);
  const coreWeightLbs = asNumber(row.coreWeightLbs ?? row.core_weight_lbs);
  const canonical = resolveCanonicalFilmIdentity(row, aliasMap);
  const reasons = [];

  addPendingReason(reasons, !sourceIsOrdered, 'not_ordered_or_film_order_linked');
  addPendingReason(reasons, !dateSelection.sampleDate, 'missing_trusted_sample_date');
  addPendingReason(reasons, !asText(row.manufacturer), 'missing_manufacturer');
  addPendingReason(reasons, !canonical.canonicalFilmName || !canonical.canonicalFilmKey, 'missing_canonical_film_identity');
  addPendingReason(reasons, widthIn === null || widthIn <= 0, 'missing_width');
  addPendingReason(reasons, lf === null || lf <= 0, 'missing_lf');
  addPendingReason(reasons, measuredRollWeightLbs === null || measuredRollWeightLbs <= 0, 'missing_measured_weight');
  addPendingReason(reasons, measuredRollWeightLbs !== null && measuredRollWeightLbs > MAX_MEASURED_WEIGHT_LBS, 'measured_weight_extremely_high');
  addPendingReason(reasons, !coreType, 'missing_core_type');
  addPendingReason(reasons, coreWeightLbs === null || coreWeightLbs <= 0, 'missing_core_weight');

  const calculated =
    reasons.length === 0
      ? calculateFilmWeightFromMeasuredRoll({
          measuredRollWeightLbs,
          coreWeightLbs,
          widthIn,
          lf,
        })
      : null;

  if (calculated) {
    addPendingReason(reasons, calculated.filmOnlyWeightLbs <= 0, 'film_only_weight_not_positive');
    addPendingReason(
      reasons,
      calculated.normalizedLbsPerInchFoot === null || calculated.normalizedLbsPerInchFoot <= 0,
      'normalized_weight_not_positive'
    );
    addPendingReason(
      reasons,
      calculated.normalizedLbsPerInchFoot !== null &&
        (calculated.normalizedLbsPerInchFoot < NORMALIZED_WEIGHT_MIN ||
          calculated.normalizedLbsPerInchFoot > NORMALIZED_WEIGHT_MAX),
      'suspicious_normalized_weight'
    );
  }

  return {
    sourceBoxId,
    sourceFilmOrderIds,
    sourceLinkIds,
    sourceStatus,
    sourceFilmOrderStatuses,
    sourceNote: sourceFilmOrderIds
      ? 'film_order_linked_received_box'
      : sourceStatus.toUpperCase() === 'ORDERED'
        ? 'ordered_status_box'
        : 'unknown_order_source',
    manufacturer: asText(row.manufacturer),
    filmName: asText(row.filmName ?? row.film_name),
    sourceFilmKey: asText(row.filmKey ?? row.film_key),
    ...canonical,
    widthIn,
    lf,
    measuredRollWeightLbs,
    coreType,
    coreWeightLbs,
    sampleDate: dateSelection.sampleDate,
    dateBasis: dateSelection.dateBasis,
    createdAt: dateOnly(row.createdAt ?? row.created_at),
    receivedDate: dateOnly(row.receivedDate ?? row.received_date),
    lastWeighedDate: dateOnly(row.lastWeighedDate ?? row.last_weighed_date),
    trustedUsable: reasons.length === 0,
    pendingReasons: reasons,
    userActions: userActionsForReasons(reasons),
    filmOnlyWeightLbs: calculated ? roundTo(calculated.filmOnlyWeightLbs, 6) : null,
    normalizedLbsPerInchFoot: calculated ? roundTo(calculated.normalizedLbsPerInchFoot, 10) : null,
    lbsPerSqFt: calculated ? roundTo(calculated.lbsPerSqFt, 10) : null,
    lbsPerLf: calculated ? roundTo(calculated.lbsPerLf, 10) : null,
  };
}

function isOnOrAfter(dateValue, cutoffDate) {
  return Boolean(dateValue && dateValue >= cutoffDate);
}

function profileKey(sample) {
  return `${sample.canonicalFilmKey}\0${sample.coreType}`;
}

function average(values) {
  const clean = values.map(Number).filter((value) => Number.isFinite(value));
  if (!clean.length) {
    return null;
  }
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function estimateLfFromAverage(sample, averageNormalized) {
  if (
    !Number.isFinite(Number(sample.filmOnlyWeightLbs)) ||
    !Number.isFinite(Number(sample.widthIn)) ||
    !Number.isFinite(Number(averageNormalized)) ||
    Number(sample.widthIn) <= 0 ||
    Number(averageNormalized) <= 0
  ) {
    return null;
  }
  return sample.filmOnlyWeightLbs / (averageNormalized * sample.widthIn);
}

function confidenceForProfile({ acceptedSamples, pendingSamples }) {
  if (pendingSamples.length > 0) {
    return 'Needs Review';
  }
  const normalizedValues = acceptedSamples.map((sample) => sample.normalizedLbsPerInchFoot);
  const avg = average(normalizedValues);
  const min = Math.min(...normalizedValues);
  const max = Math.max(...normalizedValues);
  const varianceRatio = avg && avg > 0 ? (max - min) / avg : 0;
  if (varianceRatio > 0.2) {
    return 'Needs Review';
  }
  if (acceptedSamples.length === 1) {
    return 'Starter';
  }
  if (acceptedSamples.length <= 3) {
    return 'Building';
  }
  return 'Solid';
}

function simulateTrustedProfiles(trustedSamples = [], { toleranceLf = DEFAULT_LF_TOLERANCE } = {}) {
  const grouped = new Map();
  for (const sample of trustedSamples) {
    const key = profileKey(sample);
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(sample);
  }

  const simulatedProfiles = [];
  const tolerancePendingItems = [];
  for (const [key, samples] of grouped) {
    const sorted = [...samples].sort((left, right) => {
      const dateCompare = left.sampleDate.localeCompare(right.sampleDate);
      if (dateCompare !== 0) {
        return dateCompare;
      }
      return left.sourceBoxId.localeCompare(right.sourceBoxId);
    });
    const acceptedSamples = [];
    const pendingSamples = [];

    for (const sample of sorted) {
      if (acceptedSamples.length === 0) {
        acceptedSamples.push({
          ...sample,
          profileDecision: 'accepted_starter_profile',
          estimatedLf: sample.lf,
          estimatedLfError: 0,
        });
        continue;
      }

      const currentAverage = average(acceptedSamples.map((entry) => entry.normalizedLbsPerInchFoot));
      const estimatedLf = estimateLfFromAverage(sample, currentAverage);
      const estimatedLfError = estimatedLf === null ? null : Math.abs(estimatedLf - sample.lf);
      if (estimatedLf === null || !Number.isFinite(estimatedLf)) {
        const pending = {
          ...sample,
          profileDecision: 'pending_review',
          estimatedLf: null,
          estimatedLfError: null,
          pendingReasons: ['suspicious_impossible_calculation'],
          userActions: ['re-weigh'],
        };
        pendingSamples.push(pending);
        tolerancePendingItems.push(pending);
        continue;
      }
      if (estimatedLfError <= toleranceLf) {
        acceptedSamples.push({
          ...sample,
          profileDecision: 'accepted_within_tolerance',
          estimatedLf: roundTo(estimatedLf, 4),
          estimatedLfError: roundTo(estimatedLfError, 4),
        });
        continue;
      }
      const pending = {
        ...sample,
        profileDecision: 'pending_review',
        estimatedLf: roundTo(estimatedLf, 4),
        estimatedLfError: roundTo(estimatedLfError, 4),
        pendingReasons: ['outside_10_lf_tolerance'],
        userActions: ['approve as valid or reject sample', 'correct LF', 're-weigh'],
      };
      pendingSamples.push(pending);
      tolerancePendingItems.push(pending);
    }

    const acceptedNormalizedValues = acceptedSamples.map((sample) => sample.normalizedLbsPerInchFoot);
    const avgNormalized = average(acceptedNormalizedValues);
    const acceptedErrors = acceptedSamples.map((sample) => sample.estimatedLfError).filter((value) => value !== null);
    simulatedProfiles.push({
      profileKey: key,
      manufacturer: acceptedSamples[0]?.canonicalManufacturer || sorted[0]?.canonicalManufacturer || '',
      filmName: acceptedSamples[0]?.canonicalFilmName || sorted[0]?.canonicalFilmName || '',
      canonicalFilmKey: acceptedSamples[0]?.canonicalFilmKey || sorted[0]?.canonicalFilmKey || '',
      coreType: acceptedSamples[0]?.coreType || sorted[0]?.coreType || '',
      acceptedSampleCount: acceptedSamples.length,
      pendingReviewSampleCount: pendingSamples.length,
      widthsRepresented: uniqueSorted(acceptedSamples.map((sample) => sample.widthIn), true),
      averageNormalizedLbsPerInchFoot: roundTo(avgNormalized, 10),
      averageLbsPerSqFt: roundTo(avgNormalized === null ? null : avgNormalized * 12, 10),
      minAcceptedNormalizedLbsPerInchFoot: roundTo(Math.min(...acceptedNormalizedValues), 10),
      maxAcceptedNormalizedLbsPerInchFoot: roundTo(Math.max(...acceptedNormalizedValues), 10),
      averageEstimatedLfError: roundTo(average(acceptedErrors), 4),
      pendingReviewReasons: uniqueSorted(pendingSamples.flatMap((sample) => sample.pendingReasons)),
      suggestedConfidence: confidenceForProfile({ acceptedSamples, pendingSamples }),
      acceptedSamples: acceptedSamples.map((sample) => ({
        sourceBoxId: sample.sourceBoxId,
        sampleDate: sample.sampleDate,
        dateBasis: sample.dateBasis,
        widthIn: sample.widthIn,
        lf: sample.lf,
        measuredRollWeightLbs: sample.measuredRollWeightLbs,
        normalizedLbsPerInchFoot: sample.normalizedLbsPerInchFoot,
        profileDecision: sample.profileDecision,
        estimatedLf: sample.estimatedLf,
        estimatedLfError: sample.estimatedLfError,
      })),
      pendingSamples: pendingSamples.map((sample) => ({
        sourceBoxId: sample.sourceBoxId,
        sampleDate: sample.sampleDate,
        widthIn: sample.widthIn,
        lf: sample.lf,
        measuredRollWeightLbs: sample.measuredRollWeightLbs,
        estimatedLf: sample.estimatedLf,
        estimatedLfError: sample.estimatedLfError,
        pendingReasons: sample.pendingReasons,
        userActions: sample.userActions,
      })),
    });
  }

  simulatedProfiles.sort((left, right) => {
    if (right.acceptedSampleCount !== left.acceptedSampleCount) {
      return right.acceptedSampleCount - left.acceptedSampleCount;
    }
    if (right.pendingReviewSampleCount !== left.pendingReviewSampleCount) {
      return right.pendingReviewSampleCount - left.pendingReviewSampleCount;
    }
    return left.canonicalFilmKey.localeCompare(right.canonicalFilmKey);
  });

  return { simulatedProfiles, tolerancePendingItems };
}

function buildInternetResearchPrep({ simulatedProfiles = [], pendingItems = [] } = {}) {
  const profileTargets = simulatedProfiles
    .filter(
      (profile) =>
        profile.acceptedSampleCount <= 3 ||
        profile.pendingReviewSampleCount > 0 ||
        profile.suggestedConfidence === 'Needs Review'
    )
    .map((profile) => ({
      manufacturer: profile.manufacturer,
      filmName: profile.filmName,
      canonicalFilmKey: profile.canonicalFilmKey,
      widthsPresent: profile.widthsRepresented,
      coreType: profile.coreType,
      trustedSampleCount: profile.acceptedSampleCount,
      pendingReviewCount: profile.pendingReviewSampleCount,
      wouldHelp: ['roll weight', 'roll length', 'product thickness', 'manufacturer spec sheet'],
      suggestedSearches: [
        `${profile.manufacturer} ${profile.filmName} roll weight`,
        `${profile.manufacturer} ${profile.filmName} roll length width`,
        `${profile.manufacturer} ${profile.filmName} specifications PDF`,
      ],
    }));

  const seen = new Set(profileTargets.map((target) => `${target.canonicalFilmKey}\0${target.coreType}`));
  for (const item of pendingItems) {
    const key = `${item.canonicalFilmKey}\0${item.coreType || 'UNKNOWN'}`;
    if (!item.canonicalFilmKey || seen.has(key)) {
      continue;
    }
    seen.add(key);
    profileTargets.push({
      manufacturer: item.canonicalManufacturer,
      filmName: item.canonicalFilmName,
      canonicalFilmKey: item.canonicalFilmKey,
      widthsPresent: item.widthIn ? [item.widthIn] : [],
      coreType: item.coreType || 'UNKNOWN',
      trustedSampleCount: 0,
      pendingReviewCount: 1,
      wouldHelp: item.pendingReasons.includes('missing_core_type') || item.pendingReasons.includes('missing_core_weight')
        ? ['core type', 'core weight', 'manufacturer spec sheet']
        : ['roll weight', 'roll length', 'product thickness', 'manufacturer spec sheet'],
      suggestedSearches: [
        `${item.canonicalManufacturer} ${item.canonicalFilmName} roll weight`,
        `${item.canonicalManufacturer} ${item.canonicalFilmName} roll length width`,
        `${item.canonicalManufacturer} ${item.canonicalFilmName} specifications PDF`,
      ],
    });
  }

  return profileTargets.sort((left, right) => {
    if (right.pendingReviewCount !== left.pendingReviewCount) {
      return right.pendingReviewCount - left.pendingReviewCount;
    }
    if (left.trustedSampleCount !== right.trustedSampleCount) {
      return left.trustedSampleCount - right.trustedSampleCount;
    }
    return left.canonicalFilmKey.localeCompare(right.canonicalFilmKey);
  });
}

function summarize({ allCandidates, afterCutoffCandidates, trustedSamples, pendingItems, simulatedProfiles, cutoffDate }) {
  return {
    cutoffDate,
    orderedReceivedRowsInspected: allCandidates.length,
    orderedReceivedRowsAfterCutoff: afterCutoffCandidates.length,
    trustedUsableSamples: trustedSamples.length,
    pendingReviewItems: pendingItems.length,
    simulatedProfiles: simulatedProfiles.length,
    profilesWithAcceptedFollowUpSamples: simulatedProfiles.filter((profile) => profile.acceptedSampleCount > 1).length,
    profilesWithPendingToleranceSamples: simulatedProfiles.filter((profile) => profile.pendingReviewSampleCount > 0).length,
    trustedByManufacturer: countBy(trustedSamples, (sample) => sample.canonicalManufacturer),
    trustedByCanonicalFilm: countBy(trustedSamples, (sample) => sample.canonicalFilmKey),
    trustedByWidth: countBy(trustedSamples, (sample) => sample.widthIn),
    trustedByCoreType: countBy(trustedSamples, (sample) => sample.coreType),
    trustedByDateBasis: countBy(trustedSamples, (sample) => sample.dateBasis),
    pendingByReason: countBy(pendingItems.flatMap((item) => item.pendingReasons), (reason) => reason),
    pendingByManufacturerFilm: countBy(pendingItems, (item) => item.canonicalFilmKey || `${item.manufacturer}|${item.filmName}`),
    profileConfidenceCounts: countBy(simulatedProfiles, (profile) => profile.suggestedConfidence),
  };
}

function buildTrustedSampleAudit({
  rows = [],
  aliasRows = [],
  cutoffDate = DEFAULT_CUTOFF_DATE,
  toleranceLf = DEFAULT_LF_TOLERANCE,
} = {}) {
  const aliasMap = makeAliasMap(aliasRows);
  const allCandidates = rows.map((row) => buildTrustedSampleCandidate(row, aliasMap));
  const afterCutoffCandidates = allCandidates.filter((sample) => isOnOrAfter(sample.sampleDate, cutoffDate));
  const trustedSamples = afterCutoffCandidates.filter((sample) => sample.trustedUsable);
  const incompletePendingItems = afterCutoffCandidates
    .filter((sample) => !sample.trustedUsable)
    .map((sample) => ({
      ...sample,
      pendingStage: 'trusted_sample_filter',
    }));
  const { simulatedProfiles, tolerancePendingItems } = simulateTrustedProfiles(trustedSamples, { toleranceLf });
  const tolerancePendingReviewItems = tolerancePendingItems.map((sample) => ({
    ...sample,
    pendingStage: 'profile_tolerance_simulation',
  }));
  const pendingItems = [...incompletePendingItems, ...tolerancePendingReviewItems];
  const internetResearchPrep = buildInternetResearchPrep({ simulatedProfiles, pendingItems });

  return {
    generatedAt: new Date().toISOString(),
    cutoffDate,
    toleranceLf,
    summary: summarize({
      allCandidates,
      afterCutoffCandidates,
      trustedSamples,
      pendingItems,
      simulatedProfiles,
      cutoffDate,
    }),
    trustedSamples,
    pendingItems,
    simulatedProfiles,
    internetResearchPrep,
    existingSystems: {
      filmIdentity:
        'Reuse backend catalog canonicalization: normalizeCanonicalManufacturerAndFilm, film_name_aliases, and canonical film_key.',
      coreWeights:
        'Reuse existing core type labels and app_api/backend core-weight derivation; missing stored core type or core weight stays pending.',
      orderedReceive:
        'Use app.film_order_box_links joined to app.boxes; sample LF is app.boxes.initial_feet recorded at receive/weighing.',
      notifications:
        'Future Weight Chart pending count can reuse useAppAttentionSummary plus nav showAttentionDot / nav-attention-dot.',
    },
  };
}

function compactList(values, max = 8) {
  const clean = Array.isArray(values) ? values : [];
  if (clean.length <= max) {
    return clean.join(', ');
  }
  return `${clean.slice(0, max).join(', ')} (+${clean.length - max} more)`;
}

function table(headers, rows) {
  const escape = (value) => String(value ?? '--').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [
    `| ${headers.map(escape).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escape).join(' | ')} |`),
  ].join('\n');
}

function topEntries(counts, limit = 20) {
  return Object.entries(counts || {}).slice(0, limit);
}

function formatTrustedSampleAuditMarkdown(report, { limit = 50 } = {}) {
  const lines = [];
  lines.push('# Film Weight Trusted Sample Audit - Phase 3A');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push('## Purpose');
  lines.push('');
  lines.push('Read-only audit of ordered/received film boxes weighed on or after April 5, 2026. This report uses actual recorded receive/weigh LF and does not assume full-roll lengths.');
  lines.push('');
  lines.push('## Trusted Sample Rules Applied');
  lines.push('');
  lines.push('- Source: film-order linked / ordered-status received boxes.');
  lines.push('- Cutoff: 2026-04-05.');
  lines.push('- Date basis priority: last weighed date, then received date, then created date.');
  lines.push('- Required fields: manufacturer, canonical film identity, width, LF, measured roll weight, core type, and core weight.');
  lines.push('- Formula: film-only weight = measured roll weight - core weight.');
  lines.push('- Normalized average: film-only weight / (width inches * LF).');
  lines.push('- Display mapping: lbs per sq ft = normalized lbs per inch-foot * 12.');
  lines.push('- Tolerance simulation: later samples estimate LF from current profile average and go pending if error is greater than 10 LF.');
  lines.push('');
  lines.push('## Existing Systems To Reuse');
  lines.push('');
  lines.push(`- Film identity: ${report.existingSystems.filmIdentity}`);
  lines.push(`- Core weights: ${report.existingSystems.coreWeights}`);
  lines.push(`- Ordered receive: ${report.existingSystems.orderedReceive}`);
  lines.push(`- Red dot notification: ${report.existingSystems.notifications}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(table(['Metric', 'Count'], [
    ['Ordered/received rows inspected', report.summary.orderedReceivedRowsInspected],
    ['Rows after cutoff', report.summary.orderedReceivedRowsAfterCutoff],
    ['Trusted usable samples', report.summary.trustedUsableSamples],
    ['Pending review items', report.summary.pendingReviewItems],
    ['Simulated profiles', report.summary.simulatedProfiles],
    ['Profiles with accepted follow-up samples', report.summary.profilesWithAcceptedFollowUpSamples],
    ['Profiles with pending tolerance samples', report.summary.profilesWithPendingToleranceSamples],
  ]));
  lines.push('');
  lines.push('## Trusted Sample Counts');
  lines.push('');
  lines.push('By manufacturer:');
  lines.push('');
  lines.push(table(['Manufacturer', 'Trusted samples'], topEntries(report.summary.trustedByManufacturer, limit)));
  lines.push('');
  lines.push('By width:');
  lines.push('');
  lines.push(table(['Width', 'Trusted samples'], topEntries(report.summary.trustedByWidth, limit)));
  lines.push('');
  lines.push('By core type:');
  lines.push('');
  lines.push(table(['Core type', 'Trusted samples'], topEntries(report.summary.trustedByCoreType, limit)));
  lines.push('');
  lines.push('By date basis:');
  lines.push('');
  lines.push(table(['Date basis', 'Trusted samples'], topEntries(report.summary.trustedByDateBasis, limit)));
  lines.push('');
  lines.push('## Pending Review Simulation');
  lines.push('');
  lines.push(table(['Reason', 'Count'], topEntries(report.summary.pendingByReason, limit)));
  lines.push('');
  lines.push('Pending examples:');
  lines.push('');
  lines.push(table(['#', 'Stage', 'Box', 'Film', 'Width', 'LF', 'Weight', 'Reasons', 'User action'], report.pendingItems.slice(0, limit).map((item, index) => [
    index + 1,
    item.pendingStage,
    item.sourceBoxId,
    `${item.canonicalManufacturer || item.manufacturer} ${item.canonicalFilmName || item.filmName}`,
    item.widthIn ?? '--',
    item.lf ?? '--',
    item.measuredRollWeightLbs ?? '--',
    compactList(item.pendingReasons, 6),
    compactList(item.userActions, 4),
  ])));
  lines.push('');
  lines.push('## Simulated Trusted Profiles');
  lines.push('');
  lines.push(table(['#', 'Profile', 'Core', 'Accepted', 'Pending', 'Widths', 'Avg norm lb/in-ft', 'Avg lb/sq ft', 'Avg LF error', 'Confidence'], report.simulatedProfiles.slice(0, limit).map((profile, index) => [
    index + 1,
    `${profile.manufacturer} ${profile.filmName}`,
    profile.coreType,
    profile.acceptedSampleCount,
    profile.pendingReviewSampleCount,
    compactList(profile.widthsRepresented, 6),
    profile.averageNormalizedLbsPerInchFoot,
    profile.averageLbsPerSqFt,
    profile.averageEstimatedLfError ?? '--',
    profile.suggestedConfidence,
  ])));
  lines.push('');
  lines.push('Profiles that would get accepted follow-up samples:');
  lines.push('');
  lines.push(table(['Profile', 'Accepted samples', 'Confidence'], report.simulatedProfiles.filter((profile) => profile.acceptedSampleCount > 1).slice(0, limit).map((profile) => [
    `${profile.manufacturer} ${profile.filmName} (${profile.coreType})`,
    profile.acceptedSampleCount,
    profile.suggestedConfidence,
  ])));
  lines.push('');
  lines.push('Samples that would go pending under the 10 LF rule:');
  lines.push('');
  const tolerancePending = report.pendingItems.filter((item) => item.pendingStage === 'profile_tolerance_simulation');
  lines.push(table(['Box', 'Profile', 'Recorded LF', 'Estimated LF', 'Error LF', 'Action'], tolerancePending.slice(0, limit).map((item) => [
    item.sourceBoxId,
    `${item.canonicalManufacturer} ${item.canonicalFilmName} (${item.coreType})`,
    item.lf,
    item.estimatedLf,
    item.estimatedLfError,
    compactList(item.userActions, 4),
  ])));
  lines.push('');
  lines.push('## Internet Research Prep');
  lines.push('');
  lines.push(table(['#', 'Film', 'Core', 'Widths', 'Trusted', 'Pending', 'External data needed', 'Suggested searches'], report.internetResearchPrep.slice(0, limit).map((item, index) => [
    index + 1,
    `${item.manufacturer} ${item.filmName}`,
    item.coreType,
    compactList(item.widthsPresent, 6),
    item.trustedSampleCount,
    item.pendingReviewCount,
    compactList(item.wouldHelp, 5),
    compactList(item.suggestedSearches, 3),
  ])));
  lines.push('');
  lines.push('## Phase 4 Recommendation');
  lines.push('');
  lines.push('1. Build source-of-truth schema for film_weight_profiles, film_weight_samples, pending review items, and audit fields.');
  lines.push('2. Build receive-flow logging/comparison so ordered film receive records a sample, creates starter profiles, applies the 10 LF tolerance, and queues pending items.');
  lines.push('3. Build an admin/review page or lightweight Weight Chart review page before the full chart UI if pending volume is high.');
  lines.push('4. Build the full Weight Chart tab under More after the schema and receive-flow logging prove stable.');
  lines.push('');
  lines.push('## Safety');
  lines.push('');
  lines.push('- Read-only audit tooling/report.');
  lines.push('- No data mutation.');
  lines.push('- No migrations or schema changes.');
  lines.push('- No UI changes.');
  lines.push('- No deploy or push.');
  lines.push('- No secrets printed.');
  return lines.join('\n');
}

function buildJsonReport(report, { limit = 100 } = {}) {
  return {
    generatedAt: report.generatedAt,
    cutoffDate: report.cutoffDate,
    toleranceLf: report.toleranceLf,
    summary: report.summary,
    existingSystems: report.existingSystems,
    trustedSamples: report.trustedSamples.slice(0, limit),
    pendingItems: report.pendingItems.slice(0, limit),
    simulatedProfiles: report.simulatedProfiles.slice(0, limit),
    internetResearchPrep: report.internetResearchPrep.slice(0, limit),
  };
}

export {
  DEFAULT_CUTOFF_DATE,
  DEFAULT_LF_TOLERANCE,
  buildInternetResearchPrep,
  buildJsonReport,
  buildTrustedSampleAudit,
  buildTrustedSampleCandidate,
  dateOnly,
  estimateLfFromAverage,
  formatTrustedSampleAuditMarkdown,
  resolveCanonicalFilmIdentity,
  selectTrustedSampleDate,
  simulateTrustedProfiles,
};
