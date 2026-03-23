import { describe, expect, it } from 'vitest';
import type { JobListEntry } from '../../../domain';
import { sortJobs } from './jobSorts';

function buildJob(overrides: Partial<JobListEntry> = {}): JobListEntry {
  return {
    jobNumber: '1000',
    warehouse: 'IL1',
    sections: null,
    dueDate: '2026-03-20',
    crewLeader: '',
    status: 'ALLOCATE',
    lifecycleStatus: 'ACTIVE',
    requiredFeet: 0,
    allocatedFeet: 0,
    remainingFeet: 0,
    requiredTubes: 0,
    allocatedTubes: 0,
    remainingTubes: 0,
    requirementCount: 0,
    allocationCount: 0,
    filmOrderCount: 0,
    createdAt: '2026-03-20T00:00:00Z',
    updatedAt: '2026-03-20T00:00:00Z',
    notes: '',
    ...overrides
  };
}

describe('sortJobs', () => {
  it('sorts by install date by default', () => {
    const result = sortJobs(
      [
        buildJob({ jobNumber: '1001', dueDate: '2026-03-22' }),
        buildJob({ jobNumber: '1002', dueDate: '2026-03-25' }),
        buildJob({ jobNumber: '1003', dueDate: '2026-03-21' })
      ],
      'install_date'
    );

    expect(result.map((entry) => entry.jobNumber)).toEqual(['1002', '1001', '1003']);
  });

  it('sorts by numeric job number ascending and descending', () => {
    const entries = [
      buildJob({ jobNumber: '200' }),
      buildJob({ jobNumber: '15' }),
      buildJob({ jobNumber: '1000' })
    ];

    expect(sortJobs(entries, 'job_number_asc').map((entry) => entry.jobNumber)).toEqual([
      '15',
      '200',
      '1000'
    ]);
    expect(sortJobs(entries, 'job_number_desc').map((entry) => entry.jobNumber)).toEqual([
      '1000',
      '200',
      '15'
    ]);
  });

  it('sorts by date added newest first and oldest first', () => {
    const entries = [
      buildJob({ jobNumber: '1', createdAt: '2026-03-20T00:00:00Z' }),
      buildJob({ jobNumber: '2', createdAt: '2026-03-24T00:00:00Z' }),
      buildJob({ jobNumber: '3', createdAt: '2026-03-22T00:00:00Z' })
    ];

    expect(sortJobs(entries, 'date_added_newest').map((entry) => entry.jobNumber)).toEqual([
      '2',
      '3',
      '1'
    ]);
    expect(sortJobs(entries, 'date_added_oldest').map((entry) => entry.jobNumber)).toEqual([
      '1',
      '3',
      '2'
    ]);
  });

  it('can prioritize allocate and film-order workflows', () => {
    const entries = [
      buildJob({ jobNumber: '1', dueDate: '2026-03-21', status: 'READY' }),
      buildJob({ jobNumber: '2', dueDate: '2026-03-22', status: 'ALLOCATE' }),
      buildJob({ jobNumber: '3', dueDate: '2026-03-23', status: 'ALLOCATE', filmOrderCount: 2 })
    ];

    expect(sortJobs(entries, 'allocate').map((entry) => entry.jobNumber)).toEqual(['2', '3', '1']);
    expect(sortJobs(entries, 'film_order').map((entry) => entry.jobNumber)).toEqual(['3', '2', '1']);
  });
});
