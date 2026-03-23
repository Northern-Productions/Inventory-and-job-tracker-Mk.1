import { describe, expect, it } from 'vitest';
import type { JobListEntry } from '../domain';
import { rankActiveJobsByNumericCloseness } from './jobNumberSearch';

function buildJob(overrides: Partial<JobListEntry> = {}): JobListEntry {
  return {
    jobNumber: overrides.jobNumber || '000001',
    warehouse: overrides.warehouse || 'IL1',
    sections: overrides.sections ?? null,
    dueDate: overrides.dueDate || '',
    crewLeader: overrides.crewLeader || '',
    status: overrides.status || 'ALLOCATE',
    lifecycleStatus: overrides.lifecycleStatus || 'ACTIVE',
    requiredFeet: overrides.requiredFeet || 0,
    allocatedFeet: overrides.allocatedFeet || 0,
    remainingFeet: overrides.remainingFeet || 0,
    requiredTubes: overrides.requiredTubes || 0,
    allocatedTubes: overrides.allocatedTubes || 0,
    remainingTubes: overrides.remainingTubes || 0,
    requirementCount: overrides.requirementCount || 0,
    allocationCount: overrides.allocationCount || 0,
    filmOrderCount: overrides.filmOrderCount || 0,
    createdAt: overrides.createdAt || '',
    updatedAt: overrides.updatedAt || '',
    notes: overrides.notes || ''
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
