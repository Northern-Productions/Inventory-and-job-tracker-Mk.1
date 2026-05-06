import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getCaulkAllocationCoverageTubes,
  projectCaulkFallbackCoverage,
} from '../audit-caulk-fallback-coverage-dev.mjs';

const reqA = {
  requirementId: 'req-a',
  jobNumber: 'J100',
  productId: 'prod-black',
  manufacturer: '3M',
  productName: 'IPA Black',
  productCode: 'BLACK',
  requiredTubes: 20,
};

describe('caulk fallback audit helpers', () => {
  it('uses reserved, outstanding checkout, and used tubes as committed coverage', () => {
    assert.equal(
      getCaulkAllocationCoverageTubes({
        allocatedTubes: 20,
        reservedTubesRemaining: 8,
        checkedOutTubesTotal: 7,
        returnedUnusedTubesTotal: 2,
        usedTubesTotal: 3,
        status: 'ACTIVE',
      }),
      13
    );
  });

  it('does not count returned inactive coverage or cancelled allocations', () => {
    assert.equal(
      getCaulkAllocationCoverageTubes({
        allocatedTubes: 20,
        reservedTubesRemaining: 0,
        checkedOutTubesTotal: 20,
        returnedUnusedTubesTotal: 20,
        usedTubesTotal: 0,
        status: 'ACTIVE',
      }),
      0
    );
    assert.equal(
      getCaulkAllocationCoverageTubes({
        allocatedTubes: 20,
        reservedTubesRemaining: 20,
        status: 'CANCELLED',
      }),
      0
    );
  });

  it('applies active unbound matching product allocations to unmet requirements', () => {
    const projection = projectCaulkFallbackCoverage(
      [reqA],
      [
        {
          caulkAllocationId: 'alloc-1',
          jobNumber: 'J100',
          productId: 'prod-black',
          allocatedTubes: 20,
          reservedTubesRemaining: 20,
          status: 'ACTIVE',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      { jobNumber: 'J100' }
    );

    assert.equal(projection.currentRequirementRows[0].allocatedTubes, 0);
    assert.equal(projection.projectedRequirementRows[0].allocatedTubes, 20);
    assert.equal(projection.projectedRequirementRows[0].remainingTubes, 0);
    assert.deepEqual(
      projection.allocationImpacts['alloc-1'].map((entry) => ({
        requirementId: entry.requirementId,
        appliedTubes: entry.appliedTubes,
      })),
      [{ requirementId: 'req-a', appliedTubes: 20 }]
    );
  });

  it('does not double count fallback coverage against already covered requirements', () => {
    const projection = projectCaulkFallbackCoverage(
      [reqA],
      [
        {
          caulkAllocationId: 'bound-1',
          requirementId: 'req-a',
          jobNumber: 'J100',
          productId: 'prod-black',
          allocatedTubes: 12,
          reservedTubesRemaining: 12,
          status: 'ACTIVE',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          caulkAllocationId: 'fallback-1',
          jobNumber: 'J100',
          productId: 'prod-black',
          allocatedTubes: 20,
          reservedTubesRemaining: 20,
          status: 'ACTIVE',
          createdAt: '2026-01-02T00:00:00.000Z',
        },
      ],
      { jobNumber: 'J100' }
    );

    assert.equal(projection.currentRequirementRows[0].allocatedTubes, 12);
    assert.equal(projection.projectedRequirementRows[0].allocatedTubes, 20);
    assert.equal(projection.allocationImpacts['fallback-1'][0].appliedTubes, 8);
  });

  it('fills multiple same-product requirements deterministically in input order', () => {
    const projection = projectCaulkFallbackCoverage(
      [
        { ...reqA, requirementId: 'req-first', requiredTubes: 10 },
        { ...reqA, requirementId: 'req-second', requiredTubes: 10 },
      ],
      [
        {
          caulkAllocationId: 'fallback-1',
          jobNumber: 'J100',
          productId: 'prod-black',
          allocatedTubes: 15,
          reservedTubesRemaining: 15,
          status: 'ACTIVE',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      { jobNumber: 'J100' }
    );

    assert.deepEqual(
      projection.allocationImpacts['fallback-1'].map((entry) => ({
        requirementId: entry.requirementId,
        appliedTubes: entry.appliedTubes,
      })),
      [
        { requirementId: 'req-first', appliedTubes: 10 },
        { requirementId: 'req-second', appliedTubes: 5 },
      ]
    );
    assert.equal(projection.projectedRequirementRows[0].remainingTubes, 0);
    assert.equal(projection.projectedRequirementRows[1].remainingTubes, 5);
  });
});
