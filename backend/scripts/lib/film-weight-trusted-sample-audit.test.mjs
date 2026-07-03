import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTrustedSampleAudit,
  buildTrustedSampleCandidate,
  estimateLfFromAverage,
  selectTrustedSampleDate,
} from './film-weight-trusted-sample-audit.mjs';

function row(overrides = {}) {
  return {
    org_id: 'org-1',
    box_id: 'IL1-TRUSTED-1',
    status: 'IN_STOCK',
    manufacturer: 'Llumar',
    film_name: 'Llumar Frost NRMPS2',
    film_key: 'LLUMAR|FROST NRMPS2',
    width_in: 60,
    initial_feet: 100,
    received_date: '2026-04-05',
    last_weighed_date: '2026-04-06',
    created_at: '2026-04-01T12:00:00Z',
    initial_weight_lbs: 14.5,
    last_roll_weight_lbs: 14.5,
    core_type: 'White plastic',
    core_weight_lbs: 1.6667,
    link_ids: 'LINK-1',
    film_order_ids: 'FO-1',
    film_order_statuses: 'FULFILLED',
    ...overrides,
  };
}

test('selectTrustedSampleDate uses last weighed, then received, then created date', () => {
  assert.deepEqual(selectTrustedSampleDate(row()), {
    sampleDate: '2026-04-06',
    dateBasis: 'last_weighed_date',
  });
  assert.deepEqual(selectTrustedSampleDate(row({ last_weighed_date: null })), {
    sampleDate: '2026-04-05',
    dateBasis: 'received_date',
  });
  assert.deepEqual(selectTrustedSampleDate(row({ last_weighed_date: null, received_date: null })), {
    sampleDate: '2026-04-01',
    dateBasis: 'created_at',
  });
});

test('trusted sample filter accepts complete ordered received samples after cutoff', () => {
  const audit = buildTrustedSampleAudit({ rows: [row()], cutoffDate: '2026-04-05' });

  assert.equal(audit.summary.orderedReceivedRowsAfterCutoff, 1);
  assert.equal(audit.summary.trustedUsableSamples, 1);
  assert.equal(audit.summary.pendingReviewItems, 0);
  assert.equal(audit.trustedSamples[0].filmOnlyWeightLbs, 12.8333);
  assert.equal(audit.trustedSamples[0].normalizedLbsPerInchFoot, 0.0021388833);
  assert.equal(audit.trustedSamples[0].lbsPerSqFt, 0.0256666);
});

test('trusted sample candidates use initial weight and ignore lower last roll weight', () => {
  const candidate = buildTrustedSampleCandidate(
    row({
      box_id: 'INITIAL-ONLY',
      initial_feet: 100,
      initial_weight_lbs: 50,
      last_roll_weight_lbs: 20,
      core_weight_lbs: 2,
    })
  );

  assert.equal(candidate.trustedUsable, true);
  assert.equal(candidate.measuredRollWeightLbs, 50);
  assert.equal(candidate.lf, 100);
  assert.equal(candidate.filmOnlyWeightLbs, 48);
  assert.equal(candidate.normalizedLbsPerInchFoot, 0.008);
  assert.equal(candidate.lbsPerSqFt, 0.096);
});

test('missing core type or core weight makes a sample pending review', () => {
  const audit = buildTrustedSampleAudit({
    rows: [
      row({ box_id: 'MISSING-CORE-TYPE', core_type: '', core_weight_lbs: 1.6667 }),
      row({ box_id: 'MISSING-CORE-WEIGHT', core_type: 'White plastic', core_weight_lbs: null }),
    ],
  });

  assert.equal(audit.summary.trustedUsableSamples, 0);
  assert.equal(audit.summary.pendingReviewItems, 2);
  assert.equal(audit.summary.pendingByReason.missing_core_type, 1);
  assert.equal(audit.summary.pendingByReason.missing_core_weight, 1);
  assert.deepEqual(audit.pendingItems[0].userActions, ['add core type/core weight']);
});

test('first trusted sample creates a starter profile and later in-tolerance sample updates average', () => {
  const first = row({
    box_id: 'STARTER',
    last_weighed_date: '2026-04-06',
    initial_weight_lbs: 14.5,
    last_roll_weight_lbs: 8,
  });
  const second = row({
    box_id: 'FOLLOW-UP',
    last_weighed_date: '2026-04-07',
    initial_feet: 100,
    initial_weight_lbs: 14.9,
    last_roll_weight_lbs: 7,
  });
  const audit = buildTrustedSampleAudit({ rows: [second, first], toleranceLf: 10 });
  const profile = audit.simulatedProfiles[0];

  assert.equal(profile.acceptedSampleCount, 2);
  assert.equal(profile.pendingReviewSampleCount, 0);
  assert.equal(profile.suggestedConfidence, 'Building');
  assert.equal(profile.acceptedSamples[0].profileDecision, 'accepted_starter_profile');
  assert.equal(profile.acceptedSamples[1].profileDecision, 'accepted_within_tolerance');
  const acceptedAverage =
    (profile.acceptedSamples[0].normalizedLbsPerInchFoot +
      profile.acceptedSamples[1].normalizedLbsPerInchFoot) /
    2;
  assert.equal(profile.averageNormalizedLbsPerInchFoot, Number(acceptedAverage.toFixed(10)));
});

test('later sample outside 10 LF tolerance goes pending and does not update average', () => {
  const first = row({
    box_id: 'STARTER',
    last_weighed_date: '2026-04-06',
    initial_feet: 100,
    initial_weight_lbs: 14.5,
    last_roll_weight_lbs: 8,
  });
  const bad = row({
    box_id: 'BAD-LF',
    last_weighed_date: '2026-04-07',
    initial_feet: 100,
    initial_weight_lbs: 25,
    last_roll_weight_lbs: 8,
  });
  const audit = buildTrustedSampleAudit({ rows: [first, bad], toleranceLf: 10 });
  const profile = audit.simulatedProfiles[0];

  assert.equal(profile.acceptedSampleCount, 1);
  assert.equal(profile.pendingReviewSampleCount, 1);
  assert.equal(profile.suggestedConfidence, 'Needs Review');
  assert.equal(profile.pendingSamples[0].pendingReasons[0], 'outside_10_lf_tolerance');
  assert.equal(audit.summary.pendingByReason.outside_10_lf_tolerance, 1);
});

test('estimated LF is derived from film-only weight, average normalized value, and width', () => {
  const estimated = estimateLfFromAverage(
    {
      filmOnlyWeightLbs: 12,
      widthIn: 60,
    },
    0.002
  );

  assert.equal(estimated, 100);
});

test('canonical film grouping reuses aliases before profile simulation', () => {
  const aliasRows = [
    {
      org_id: 'org-1',
      manufacturer_lookup_key: 'llumar',
      old_film_name_lookup_key: 'frost nrmps2',
      canonical_film_name: 'Frost (NRM PS2)',
    },
  ];
  const audit = buildTrustedSampleAudit({
    aliasRows,
    rows: [
      row({ box_id: 'ALIAS-1', film_name: 'Llumar Frost NRMPS2', last_weighed_date: '2026-04-06' }),
      row({ box_id: 'ALIAS-2', film_name: 'Frost (NRM PS2)', last_weighed_date: '2026-04-07' }),
    ],
  });

  assert.equal(audit.simulatedProfiles.length, 1);
  assert.equal(audit.simulatedProfiles[0].canonicalFilmKey, 'LLUMAR|FROST (NRM PS2)');
  assert.equal(audit.simulatedProfiles[0].acceptedSampleCount, 2);
});

test('pending review includes missing LF, measured weight, and film identity reasons', () => {
  const audit = buildTrustedSampleAudit({
    rows: [
      row({ box_id: 'NO-LF', initial_feet: 0 }),
      row({ box_id: 'NO-WEIGHT', initial_weight_lbs: null, last_roll_weight_lbs: 14.5 }),
      row({ box_id: 'NO-FILM', film_name: '' }),
    ],
  });

  assert.equal(audit.summary.pendingByReason.missing_lf, 1);
  assert.equal(audit.summary.pendingByReason.missing_measured_weight, 1);
  assert.equal(audit.summary.pendingByReason.missing_canonical_film_identity, 1);

  const noFilm = audit.pendingItems.find((item) => item.sourceBoxId === 'NO-FILM');
  assert.ok(noFilm.userActions.includes('split/correct film name'));
});

test('buildTrustedSampleCandidate marks pre-cutoff rows for audit exclusion by caller', () => {
  const candidate = buildTrustedSampleCandidate(row({ last_weighed_date: '2026-04-04' }));

  assert.equal(candidate.trustedUsable, true);
  assert.equal(candidate.sampleDate, '2026-04-04');
});
