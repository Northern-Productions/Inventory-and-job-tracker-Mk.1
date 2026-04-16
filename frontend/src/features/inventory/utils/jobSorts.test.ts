import { describe, expect, it } from 'vitest';
import type { JobListEntry } from '../../../domain';
import { sortJobs, sortSearchedJobs } from './jobSorts';

function buildJob(overrides: Partial<JobListEntry> = {}): JobListEntry {
  const { jobNumber: overrideJobNumber, ...rest } = overrides;

  return {
    jobNumber: '1000',
    warehouse: 'IL1',
    sections: null,
    installDate: '2026-03-20',
    crewLeader: '',
    status: 'ALLOCATE',
    lifecycleStatus: 'ACTIVE',
    isLaborOnly: false,
    isStagedForPickup: false,
    requiredFeet: 0,
    allocatedFeet: 0,
    remainingFeet: 0,
    requiredTubes: 0,
    allocatedTubes: 0,
    remainingTubes: 0,
    requirementCount: 0,
    allocationCount: 0,
    filmOrderCount: 0,
    hasOrderedAllocations: false,
    createdAt: '2026-03-20T00:00:00Z',
    updatedAt: '2026-03-20T00:00:00Z',
    notes: '',
    ...rest,
    ...(overrideJobNumber ? { jobNumber: overrideJobNumber } : {})
  };
}

describe('sortJobs', () => {
  it('sorts by install date ascending', () => {
    const result = sortJobs(
      [
        buildJob({ jobNumber: '1001', installDate: '2026-03-22' }),
        buildJob({ jobNumber: '1002', installDate: '2026-03-25' }),
        buildJob({ jobNumber: '1003', installDate: '2026-03-21' })
      ],
      'install_date_asc'
    );

    expect(result.map((entry) => entry.jobNumber)).toEqual(['1003', '1001', '1002']);
  });

  it('sorts by install date descending', () => {
    const result = sortJobs(
      [
        buildJob({ jobNumber: '1001', installDate: '2026-03-22' }),
        buildJob({ jobNumber: '1002', installDate: '2026-03-25' }),
        buildJob({ jobNumber: '1003', installDate: '2026-03-21' })
      ],
      'install_date_desc'
    );

    expect(result.map((entry) => entry.jobNumber)).toEqual(['1002', '1001', '1003']);
  });

  it('can prioritize allocate and film-order workflows', () => {
    const entries = [
      buildJob({ jobNumber: '1', installDate: '2026-03-21', status: 'READY' }),
      buildJob({ jobNumber: '2', installDate: '2026-03-22', status: 'ALLOCATE' }),
      buildJob({ jobNumber: '3', installDate: '2026-03-23', status: 'ALLOCATE', filmOrderCount: 2 })
    ];

    expect(sortJobs(entries, 'allocate').map((entry) => entry.jobNumber)).toEqual(['2', '1', '3']);
    expect(sortJobs(entries, 'film_order').map((entry) => entry.jobNumber)).toEqual(['3', '1', '2']);
  });

  it('keeps exact search matches ahead of prefix and contains matches', () => {
    const entries = [
      buildJob({ jobNumber: '2171705', installDate: '2026-04-20' }),
      buildJob({ jobNumber: '171700', installDate: '2026-04-22' }),
      buildJob({ jobNumber: '17170', installDate: '2026-04-01' })
    ];

    expect(
      sortSearchedJobs(entries, '17170', 'install_date_asc').map(
        (entry: JobListEntry) => entry.jobNumber
      )
    ).toEqual(['17170', '171700', '2171705']);
  });

  it('uses the selected sort inside the same search match tier', () => {
    const entries = [
      buildJob({ jobNumber: '171701', installDate: '2026-04-09' }),
      buildJob({ jobNumber: '171700', installDate: '2026-04-12' }),
      buildJob({ jobNumber: '17170', installDate: '2026-04-01' })
    ];

    expect(
      sortSearchedJobs(entries, '17170', 'install_date_asc').map(
        (entry: JobListEntry) => entry.jobNumber
      )
    ).toEqual(['17170', '171701', '171700']);
  });
});
