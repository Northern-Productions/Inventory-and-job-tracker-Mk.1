import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  listFilmWeightProfiles,
  listOpenFilmWeightPendingReviews,
} from '../../src/app/services/filmWeightProfiles.mjs';

test('film weight profile read model maps profile rows for the Weight Chart', async () => {
  const calls = [];
  const fakeClient = {
    async query(sql, params) {
      calls.push({ sql, params });
      assert.match(sql, /film_weight_profiles/);
      return {
        rows: [
          {
            profile_id: 'profile-1',
            manufacturer: '3M Solar',
            film_name: 'Night Vision 35',
            film_key: '3m-solar|night-vision-35',
            core_type: '3IN',
            core_weight_lbs: '3.2',
            average_normalized_lbs_per_inch_foot: '0.001028806575',
            average_lbs_per_sq_ft: '0.0123456789',
            accepted_sample_count: '2',
            pending_review_count: '1',
            confidence: 'needs_review',
            status: 'needs_review',
            observed_widths: [72, '36'],
            width_summaries: [
              {
                widthIn: '72',
                maxRecordedLf: '100',
                acceptedSampleCount: '1',
                lastSampleAt: '2026-06-03T12:00:00Z',
              },
              {
                widthIn: '36',
                maxRecordedLf: '105',
                acceptedSampleCount: '1',
                lastSampleAt: '2026-06-02T12:00:00Z',
              },
            ],
            last_sample_at: '2026-06-03T12:00:00Z',
          },
        ],
      };
    },
  };

  const entries = await listFilmWeightProfiles(fakeClient, 'org-1');

  assert.deepEqual(calls.map((call) => call.params), [['org-1']]);
  assert.match(calls[0].sql, /acceptance_status = 'accepted'/);
  assert.match(calls[0].sql, /max\(s\.recorded_lf\)/);
  assert.deepEqual(entries[0], {
    profileId: 'profile-1',
    manufacturer: '3M Solar',
    filmName: 'Night Vision 35',
    filmKey: '3m-solar|night-vision-35',
    coreType: '3IN',
    coreWeightLbs: 3.2,
    averageNormalizedLbsPerInchFoot: 0.001028806575,
    averageLbsPerSqFt: 0.0123456789,
    acceptedSampleCount: 2,
    pendingReviewCount: 1,
    confidence: 'needs_review',
    status: 'needs_review',
    observedWidths: [36, 72],
    widthSummaries: [
      {
        widthIn: 36,
        maxRecordedLf: 105,
        acceptedSampleCount: 1,
        lastSampleAt: '2026-06-02T12:00:00Z',
      },
      {
        widthIn: 72,
        maxRecordedLf: 100,
        acceptedSampleCount: 1,
        lastSampleAt: '2026-06-03T12:00:00Z',
      },
    ],
    firstSampleAt: '',
    lastSampleAt: '2026-06-03T12:00:00Z',
    lastReviewAt: '',
    manuallyOverridden: false,
    notes: '',
    updatedAt: '',
  });
});

test('film weight pending review read model maps sample and profile context', async () => {
  const fakeClient = {
    async query(sql, params) {
      assert.match(sql, /film_weight_pending_reviews/);
      assert.deepEqual(params, ['org-1']);
      return {
        rows: [
          {
            review_id: 'review-1',
            profile_id: 'profile-1',
            sample_id: 'sample-1',
            source_box_id: 'IL1-FWC-434829793120',
            manufacturer: '3M Solar',
            film_name: 'Night Vision 35',
            film_key: '3m-solar|night-vision-35',
            width_inches: '72',
            recorded_lf: '100',
            measured_roll_weight_lbs: '18.4',
            core_type: '3IN',
            core_weight_lbs: '3.2',
            estimated_lf_against_profile: '84',
            lf_error_against_profile: '16',
            reason: 'outside_10_lf_tolerance',
            reasons: ['outside_10_lf_tolerance'],
            user_action_hint: 'approve_sample',
            status: 'open',
            profile_confidence: 'needs_review',
            profile_status: 'needs_review',
            created_at: '2026-06-03T12:00:00Z',
          },
        ],
      };
    },
  };

  const entries = await listOpenFilmWeightPendingReviews(fakeClient, 'org-1');

  assert.deepEqual(entries[0], {
    reviewId: 'review-1',
    profileId: 'profile-1',
    sampleId: 'sample-1',
    boxId: 'IL1-FWC-434829793120',
    manufacturer: '3M Solar',
    filmName: 'Night Vision 35',
    filmKey: '3m-solar|night-vision-35',
    widthIn: 72,
    recordedLf: 100,
    measuredRollWeightLbs: 18.4,
    coreType: '3IN',
    coreWeightLbs: 3.2,
    estimatedLf: 84,
    lfError: 16,
    reason: 'outside_10_lf_tolerance',
    reasons: ['outside_10_lf_tolerance'],
    suggestedAction: 'approve_sample',
    status: 'open',
    profileConfidence: 'needs_review',
    profileStatus: 'needs_review',
    createdAt: '2026-06-03T12:00:00Z',
    notes: '',
  });
});
