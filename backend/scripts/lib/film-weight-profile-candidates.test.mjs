import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeFilmWeightProfileCandidates,
  buildBoxSample,
  calculateFilmWeightFromDelta,
  calculateFilmWeightFromMeasuredRoll,
  deriveCoreWeightLbs,
  estimateRemainingLf,
  estimateRollWeight,
  evaluateSample,
  inferLikelyFullRollLf,
} from './film-weight-profile-candidates.mjs';

function measuredRollWeight({ normalized, width, lf, coreType = 'White plastic' }) {
  const coreWeight = deriveCoreWeightLbs(coreType, width);
  return Number((coreWeight + normalized * width * lf).toFixed(2));
}

function boxRow(overrides = {}) {
  const width = overrides.width_in ?? 60;
  const initialFeet = overrides.initial_feet ?? 100;
  const coreType = overrides.core_type ?? 'White plastic';
  const normalized = overrides.normalized ?? 0.0025;
  return {
    box_id: overrides.box_id ?? `BOX-${width}-${initialFeet}`,
    manufacturer: overrides.manufacturer ?? 'Llumar',
    film_name: overrides.film_name ?? 'Frost NRMPS2',
    film_key: overrides.film_key ?? 'llumar|frost-nrmps2',
    width_in: width,
    initial_feet: initialFeet,
    initial_weight_lbs:
      overrides.initial_weight_lbs ??
      measuredRollWeight({ normalized, width, lf: initialFeet, coreType }),
    received_date: overrides.received_date ?? '2026-05-01',
    core_type: coreType,
    core_weight_lbs: deriveCoreWeightLbs(coreType, width),
    order_linked: overrides.order_linked ?? true,
  };
}

test('calculates film-only weight, normalized inch-foot weight, and square-foot conversion', () => {
  const result = calculateFilmWeightFromMeasuredRoll({
    measuredRollWeightLbs: 14.83,
    coreWeightLbs: 1.3333,
    widthIn: 48,
    lf: 100,
  });

  assert.equal(Number(result.filmOnlyWeightLbs.toFixed(4)), 13.4967);
  assert.equal(Number(result.lbsPerLf.toFixed(6)), 0.134967);
  assert.equal(Number(result.normalizedLbsPerInchFoot.toFixed(8)), 0.00281181);
  assert.equal(Number(result.lbsPerSqFt.toFixed(8)), 0.03374175);
});

test('delta samples use weight difference over LF and width with core canceling out', () => {
  const result = calculateFilmWeightFromDelta({
    weightDeltaLbs: 9.54,
    widthIn: 48,
    lf: 67.67,
  });

  assert.equal(Number(result.lbsPerLf.toFixed(6)), 0.140978);
  assert.equal(Number(result.normalizedLbsPerInchFoot.toFixed(8)), 0.00293705);
});

test('derives full-roll weight and remaining LF from normalized profile math', () => {
  const normalized = 0.0025;
  const coreWeight = deriveCoreWeightLbs('White plastic', 60);

  assert.equal(coreWeight, 1.6667);
  assert.equal(
    estimateRollWeight({ normalizedLbsPerInchFoot: normalized, widthIn: 60, lf: 100, coreWeightLbs: coreWeight }),
    16.67
  );
  assert.equal(
    estimateRemainingLf({
      measuredRollWeightLbs: 9.17,
      coreWeightLbs: coreWeight,
      normalizedLbsPerInchFoot: normalized,
      widthIn: 60,
    }),
    50.02
  );
});

test('rejects impossible or corrupt measured samples with explicit reasons', () => {
  const sample = evaluateSample(
    buildBoxSample(
      boxRow({
        box_id: 'BAD-AG4',
        manufacturer: 'Security',
        film_name: '3M AG-4',
        width_in: 72,
        initial_feet: 100,
        initial_weight_lbs: 27023,
        core_type: 'Red plastic',
        order_linked: false,
      })
    )
  );

  assert.equal(sample.hardRejected, true);
  assert.ok(sample.rejectionReasons.includes('measured_weight_extremely_high'));
  assert.ok(sample.rejectionReasons.includes('normalized_weight_extremely_high'));
});

test('groups by manufacturer, film key, and core type while preserving source priority', () => {
  const report = analyzeFilmWeightProfileCandidates({
    boxRows: [
      boxRow({ width_in: 48, normalized: 0.0028, order_linked: true }),
      boxRow({ width_in: 60, normalized: 0.00281, order_linked: false }),
    ],
    catalogRows: [
      {
        manufacturer: 'Llumar',
        film_name: 'Frost NRMPS2',
        film_key: 'llumar|frost-nrmps2',
        sq_ft_weight_lbs_per_sq_ft: 0.03372,
        default_core_type: 'White plastic',
        source_width_in: 72,
        source_initial_feet: 100,
        source_initial_weight_lbs: measuredRollWeight({
          normalized: 0.00281,
          width: 72,
          lf: 100,
        }),
      },
    ],
  });

  const profile = report.profiles.find((entry) => entry.filmName === 'Frost NRMPS2');
  assert.equal(profile.acceptedSampleCount, 3);
  assert.equal(profile.confidence, 'High');
  assert.equal(profile.recommendedSourceType, 'order_linked_received_box');
  assert.deepEqual(profile.observedWidths, [48, 60, 72]);
});

test('flags within-profile outliers and downgrades the profile to Needs Review', () => {
  const report = analyzeFilmWeightProfileCandidates({
    boxRows: [
      boxRow({ width_in: 48, normalized: 0.0028, box_id: 'OK-48' }),
      boxRow({ width_in: 60, normalized: 0.00282, box_id: 'OK-60' }),
      boxRow({ width_in: 72, normalized: 0.00278, box_id: 'OK-72' }),
      boxRow({ width_in: 72, normalized: 0.006, box_id: 'OUTLIER-72' }),
    ],
  });

  const profile = report.profiles.find((entry) => entry.filmName === 'Frost NRMPS2');
  assert.equal(profile.confidence, 'Needs Review');
  assert.equal(profile.outlierSampleCount, 1);
  assert.ok(report.outliers.some((entry) => entry.sourceBoxId === 'OUTLIER-72'));
});

test('creates Needs Weighing candidates for groups with no usable evidence', () => {
  const report = analyzeFilmWeightProfileCandidates({
    boxRows: [
      {
        box_id: 'UNWEIGHED-1',
        manufacturer: 'SOLYX',
        film_name: 'Unknown Decorative',
        film_key: 'solyx|unknown-decorative',
        width_in: 60,
        initial_feet: 100,
        initial_weight_lbs: null,
        core_type: '',
        core_weight_lbs: null,
        received_date: '2026-05-02',
        order_linked: false,
      },
    ],
  });

  const profile = report.needsWeighing.find((entry) => entry.filmName === 'Unknown Decorative');
  assert.equal(profile.confidence, 'Needs Weighing');
  assert.equal(profile.acceptedSampleCount, 0);
  assert.equal(report.summary.rejectedReasonCounts.missing_or_invalid_measured_weight, 1);
});

test('builds width-specific summaries and infers likely full-roll LF without assuming 100', () => {
  assert.equal(inferLikelyFullRollLf([30, 100, 100, 75]), 100);
  assert.equal(inferLikelyFullRollLf([196, 196, 60]), 196);

  const report = analyzeFilmWeightProfileCandidates({
    boxRows: [
      boxRow({ manufacturer: '3M Fasara', film_name: 'Milano Milky White SH2MAML', film_key: '3m|milano', width_in: 50, initial_feet: 196, normalized: 0.00236 }),
      boxRow({ manufacturer: '3M Fasara', film_name: 'Milano Milky White SH2MAML', film_key: '3m|milano', width_in: 60, initial_feet: 60, normalized: 0.00234 }),
    ],
  });

  const milanoRows = report.widthRows.filter((row) => row.filmName === 'Milano Milky White SH2MAML');
  assert.equal(milanoRows.length, 2);
  assert.ok(milanoRows.some((row) => row.widthIn === 50 && row.likelyFullRollLf === 196));
  assert.ok(milanoRows.every((row) => row.recommendedFullRollWeightLbs > 0));
});
