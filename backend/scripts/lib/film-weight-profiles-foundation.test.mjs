import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  calculateFilmWeightMetrics,
  compareLfTolerance,
  confidenceForProfile,
  estimateRemainingLfFromProfile,
  evaluateSampleAgainstProfile,
  validateSampleInput,
} from '../../src/app/services/filmWeightProfiles.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0156_film_weight_profiles_foundation.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260603100000_film_weight_profiles_foundation.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

test('film weight profiles migration stays mirrored and schema-guarded', async () => {
  const [backendMigration, supabaseMigration, schemaCheck] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
    readFile(schemaCheckPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);

  assert.match(schemaCheck, /0168_film_weight_pending_review_resolution\.sql/);

  assert.match(schemaCheck, /signature: 'app\.film_weight_profiles'/);
  assert.match(schemaCheck, /signature: 'app\.film_weight_samples'/);
  assert.match(schemaCheck, /signature: 'app\.film_weight_pending_reviews'/);
  assert.match(schemaCheck, /signature: 'app_api\.record_film_weight_sample_from_box/);
  assert.match(schemaCheck, /signature: 'app_api\.resolve_film_weight_pending_review/);
});

test('calculates film-only weight and normalized profile weights', () => {
  const metrics = calculateFilmWeightMetrics({
    measuredRollWeightLbs: 14.5,
    coreWeightLbs: 2,
    widthIn: 60,
    recordedLf: 100,
  });

  assert.deepEqual(metrics, {
    filmOnlyWeightLbs: 12.5,
    normalizedLbsPerInchFoot: 0.002083333333,
    lbsPerSqFt: 0.025,
  });
});

test('estimates remaining LF from profile average across widths', () => {
  const estimatedLf = estimateRemainingLfFromProfile({
    measuredRollWeightLbs: 7,
    coreWeightLbs: 1,
    widthIn: 36,
    averageNormalizedLbsPerInchFoot: 0.002,
  });

  assert.equal(estimatedLf, 83.333333);
});

test('compares estimated LF to the 10 LF tolerance', () => {
  assert.deepEqual(compareLfTolerance({ estimatedLf: 91, recordedLf: 100 }), {
    withinTolerance: true,
    lfError: 9,
  });
  assert.deepEqual(compareLfTolerance({ estimatedLf: 89.9, recordedLf: 100 }), {
    withinTolerance: false,
    lfError: 10.1,
  });
});

test('complete first ordered-received sample creates starter profile decision', () => {
  const sample = {
    manufacturer: '3M Solar',
    filmName: 'Prestige 70 Exterior',
    filmKey: '3m solar|prestige 70 exterior',
    widthIn: 60,
    recordedLf: 100,
    measuredRollWeightLbs: 14.5,
    coreType: 'White plastic',
    coreWeightLbs: 2,
  };

  assert.deepEqual(validateSampleInput(sample).reasons, []);
  const decision = evaluateSampleAgainstProfile(sample, null);
  assert.equal(decision.decision, 'accepted_starter_profile');
  assert.equal(decision.lfError, 0);
});

test('missing core type, core weight, measured weight, or LF becomes pending review', () => {
  const base = {
    manufacturer: '3M Solar',
    filmName: 'Prestige 70 Exterior',
    filmKey: '3m solar|prestige 70 exterior',
    widthIn: 60,
    recordedLf: 100,
    measuredRollWeightLbs: 14.5,
    coreType: 'White plastic',
    coreWeightLbs: 2,
  };

  assert.deepEqual(validateSampleInput({ ...base, coreType: '' }).reasons, ['missing_core_type']);
  assert.deepEqual(validateSampleInput({ ...base, coreWeightLbs: null }).reasons, ['missing_core_weight']);
  assert.deepEqual(validateSampleInput({ ...base, measuredRollWeightLbs: null }).reasons, [
    'missing_measured_roll_weight',
  ]);
  assert.deepEqual(validateSampleInput({ ...base, recordedLf: 0 }).reasons, ['missing_lf']);
});

test('invalid film-only weight becomes pending review', () => {
  const decision = evaluateSampleAgainstProfile(
    {
      manufacturer: '3M Solar',
      filmName: 'Prestige 70 Exterior',
      filmKey: '3m solar|prestige 70 exterior',
      widthIn: 60,
      recordedLf: 100,
      measuredRollWeightLbs: 1,
      coreType: 'White plastic',
      coreWeightLbs: 2,
    },
    null
  );

  assert.equal(decision.decision, 'pending_review');
  assert.deepEqual(decision.reasons, ['film_only_weight_not_positive', 'normalized_weight_invalid']);
});

test('accepted follow-up sample within tolerance updates average inputs', () => {
  const sample = {
    manufacturer: '3M Solar',
    filmName: 'Prestige 70 Exterior',
    filmKey: '3m solar|prestige 70 exterior',
    widthIn: 36,
    recordedLf: 83,
    measuredRollWeightLbs: 6.976,
    coreType: 'White plastic',
    coreWeightLbs: 1,
  };
  const decision = evaluateSampleAgainstProfile(sample, {
    averageNormalizedLbsPerInchFoot: 0.002,
  });

  assert.equal(decision.decision, 'accepted_within_tolerance');
  assert.equal(decision.estimatedLf, 83);
  assert.equal(decision.lfError, 0);
});

test('outside tolerance sample goes pending and does not update trusted average', () => {
  const decision = evaluateSampleAgainstProfile(
    {
      manufacturer: '3M Solar',
      filmName: 'Prestige 70 Exterior',
      filmKey: '3m solar|prestige 70 exterior',
      widthIn: 60,
      recordedLf: 100,
      measuredRollWeightLbs: 8,
      coreType: 'White plastic',
      coreWeightLbs: 2,
    },
    {
      averageNormalizedLbsPerInchFoot: 0.002,
    }
  );

  assert.equal(decision.decision, 'pending_review');
  assert.deepEqual(decision.reasons, ['outside_10_lf_tolerance']);
  assert.equal(decision.estimatedLf, 50);
  assert.equal(decision.lfError, 50);
});

test('confidence follows starter/building/solid/needs-review policy', () => {
  assert.equal(confidenceForProfile({ acceptedSampleCount: 1 }), 'starter');
  assert.equal(confidenceForProfile({ acceptedSampleCount: 3 }), 'building');
  assert.equal(confidenceForProfile({ acceptedSampleCount: 4 }), 'solid');
  assert.equal(confidenceForProfile({ acceptedSampleCount: 4, openPendingReviewCount: 1 }), 'needs_review');
});
