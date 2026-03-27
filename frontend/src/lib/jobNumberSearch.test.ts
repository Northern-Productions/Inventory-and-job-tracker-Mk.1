import { describe, expect, it } from 'vitest';
import type { JobListEntry } from '../domain';
import { rankActiveJobsByNumericCloseness } from './jobNumberSearch';

function buildJob(overrides: Partial<JobListEntry> = {}): JobListEntry {
  const { jobNumber: overrideJobNumber, ...rest } = overrides;

  return {
    jobNumber: overrideJobNumber || '000001',
    warehouse: rest.warehouse || 'IL1',
    sections: rest.sections ?? null,
    dueDate: rest.dueDate || '',
    crewLeader: rest.crewLeader || '',
    status: rest.status || 'ALLOCATE',
    lifecycleStatus: rest.lifecycleStatus || 'ACTIVE',
    isLaborOnly: rest.isLaborOnly ?? false,
    isStagedForPickup: rest.isStagedForPickup ?? false,
    requiredFeet: rest.requiredFeet || 0,
    allocatedFeet: rest.allocatedFeet || 0,
    remainingFeet: rest.remainingFeet || 0,
    requiredTubes: rest.requiredTubes || 0,
    allocatedTubes: rest.allocatedTubes || 0,
    remainingTubes: rest.remainingTubes || 0,
    requirementCount: rest.requirementCount || 0,
    allocationCount: rest.allocationCount || 0,
    filmOrderCount: rest.filmOrderCount || 0,
    createdAt: rest.createdAt || '',
    updatedAt: rest.updatedAt || '',
    notes: rest.notes || ''
  };
}

describe('rankActiveJobsByNumericCloseness', () => {
  it('puts prefix matches ahead of non-prefix numeric neighbors', () => {
    const entries = [
      buildJob({ jobNumber: '4217', dueDate: '2026-03-16' }),
      buildJob({ jobNumber: '18542', dueDate: '2026-03-18' }),
      buildJob({ jobNumber: '17045', dueDate: '2026-03-13' })
    ];

    const result = rankActiveJobsByNumericCloseness(entries, '1854', 25);
    expect(result.map((entry) => entry.jobNumber)).toEqual(['18542', '4217', '17045']);
  });

  it('prioritizes exact numeric match first', () => {
    const entries = [
      buildJob({ jobNumber: '000120' }),
      buildJob({ jobNumber: '000123' }),
      buildJob({ jobNumber: '000130' })
    ];

    const result = rankActiveJobsByNumericCloseness(entries, '123', 25);
    expect(result.map((entry) => entry.jobNumber)).toEqual(['000123', '000120', '000130']);
  });

  it('treats leading zeros as equivalent for matching', () => {
    const entries = [
      buildJob({ jobNumber: '123' }),
      buildJob({ jobNumber: '000123' }),
      buildJob({ jobNumber: '000001' })
    ];

    const result = rankActiveJobsByNumericCloseness(entries, '000123', 25);
    expect(result.slice(0, 2).map((entry) => entry.jobNumber)).toEqual(['123', '000123']);
  });

  it('prioritizes exact match before longer prefix matches', () => {
    const entries = [
      buildJob({ jobNumber: '001854' }),
      buildJob({ jobNumber: '18542' }),
      buildJob({ jobNumber: '185499' })
    ];

    const result = rankActiveJobsByNumericCloseness(entries, '1854', 25);
    expect(result.map((entry) => entry.jobNumber)).toEqual(['001854', '18542', '185499']);
  });

  it('filters to active jobs only', () => {
    const entries = [
      buildJob({ jobNumber: '123', lifecycleStatus: 'COMPLETED' }),
      buildJob({ jobNumber: '124', lifecycleStatus: 'CANCELLED' }),
      buildJob({ jobNumber: '125', lifecycleStatus: 'ACTIVE' })
    ];

    const result = rankActiveJobsByNumericCloseness(entries, '123', 25);
    expect(result.map((entry) => entry.jobNumber)).toEqual(['125']);
  });

  it('uses due date recency as a deterministic tie-breaker', () => {
    const entries = [
      buildJob({ jobNumber: '121', dueDate: '2026-04-10' }),
      buildJob({ jobNumber: '125', dueDate: '2026-04-12' })
    ];

    const result = rankActiveJobsByNumericCloseness(entries, '123', 25);
    expect(result.map((entry) => entry.jobNumber)).toEqual(['125', '121']);
  });
});
