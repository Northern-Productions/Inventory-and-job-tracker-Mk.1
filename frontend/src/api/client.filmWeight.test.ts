import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./http', () => ({
  request: vi.fn()
}));

import {
  getFilmWeightPendingReviews,
  getFilmWeightProfiles,
  resolveFilmWeightPendingReview
} from './client';
import { request } from './http';

const requestMock = vi.mocked(request);

describe('film weight API client', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it('loads film weight profiles through GET /film-weight/profiles', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        entries: [
          {
            profileId: 'profile-1',
            manufacturer: '3M Solar',
            filmName: 'Night Vision 35',
            coreType: '3IN',
            acceptedSampleCount: 2,
            pendingReviewCount: 1,
            confidence: 'needs_review',
            status: 'needs_review',
            averageLbsPerSqFt: '0.012',
            averageNormalizedLbsPerInchFoot: '0.001',
            observedWidths: ['36', 72],
            widthSummaries: [
              {
                widthIn: '72',
                maxRecordedLf: '100',
                acceptedSampleCount: '1',
                lastSampleAt: '2026-06-03T12:00:00Z'
              },
              {
                widthIn: '36',
                maxRecordedLf: '105',
                acceptedSampleCount: '1',
                lastSampleAt: '2026-06-02T12:00:00Z'
              }
            ]
          }
        ]
      },
      warnings: []
    });

    const profiles = await getFilmWeightProfiles();

    expect(profiles[0]).toEqual(
      expect.objectContaining({
        profileId: 'profile-1',
        manufacturer: '3M Solar',
        filmName: 'Night Vision 35',
        coreType: '3IN',
        acceptedSampleCount: 2,
        pendingReviewCount: 1,
        confidence: 'needs_review',
        status: 'needs_review',
        averageLbsPerSqFt: 0.012,
        averageNormalizedLbsPerInchFoot: 0.001,
        observedWidths: [36, 72],
        widthSummaries: [
          {
            widthIn: 36,
            maxRecordedLf: 105,
            acceptedSampleCount: 1,
            lastSampleAt: '2026-06-02T12:00:00Z'
          },
          {
            widthIn: 72,
            maxRecordedLf: 100,
            acceptedSampleCount: 1,
            lastSampleAt: '2026-06-03T12:00:00Z'
          }
        ]
      })
    );
    expect(requestMock).toHaveBeenCalledWith('GET', '/film-weight/profiles', {
      query: {}
    });
  });

  it('loads open pending film weight reviews through GET /film-weight/pending-reviews', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        entries: [
          {
            reviewId: 'review-1',
            boxId: 'IL1-100',
            manufacturer: '3M Solar',
            filmName: 'Night Vision 35',
            widthIn: '72',
            recordedLf: '100',
            measuredRollWeightLbs: '14.5',
            coreType: '3IN',
            reason: 'outside_10_lf_tolerance',
            reasons: ['outside_10_lf_tolerance'],
            suggestedAction: 'approve_sample',
            createdAt: '2026-06-03T12:00:00Z'
          }
        ]
      },
      warnings: []
    });

    const reviews = await getFilmWeightPendingReviews();

    expect(reviews[0]).toEqual(
      expect.objectContaining({
        reviewId: 'review-1',
        boxId: 'IL1-100',
        widthIn: 72,
        recordedLf: 100,
        measuredRollWeightLbs: 14.5,
        reasons: ['outside_10_lf_tolerance'],
        suggestedAction: 'approve_sample'
      })
    );
    expect(requestMock).toHaveBeenCalledWith('GET', '/film-weight/pending-reviews', {
      query: {}
    });
  });

  it('resolves a pending film weight review through POST /film-weight/pending-reviews/resolve', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        reviewId: 'review-1',
        sampleId: 'sample-1',
        profileId: 'profile-1',
        boxId: 'IL1-100',
        decision: 'reject',
        status: 'rejected',
        acceptanceStatus: 'rejected',
        pendingReviewCount: '0'
      },
      warnings: []
    });

    const result = await resolveFilmWeightPendingReview({
      reviewId: 'review-1',
      decision: 'reject'
    });

    expect(result).toEqual({
      reviewId: 'review-1',
      sampleId: 'sample-1',
      profileId: 'profile-1',
      boxId: 'IL1-100',
      decision: 'reject',
      status: 'rejected',
      acceptanceStatus: 'rejected',
      pendingReviewCount: 0
    });
    expect(requestMock).toHaveBeenCalledWith('POST', '/film-weight/pending-reviews/resolve', {
      body: {
        reviewId: 'review-1',
        decision: 'reject'
      }
    });
  });
});
