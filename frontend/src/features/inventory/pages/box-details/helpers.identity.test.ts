import { describe, expect, it } from 'vitest';
import type { AllocationEntry } from '../../../../domain';
import { buildCheckoutJobOptions } from './helpers';

function allocation(overrides: Partial<AllocationEntry> = {}): AllocationEntry {
  return {
    allocationId: 'alloc-1',
    boxId: 'IL1-100',
    warehouse: 'IL1',
    jobId: '11111111-1111-4111-8111-111111111111',
    jobNumber: '9327001',
    workScope: 'Sections 1',
    sections: 'Sections 1',
    installDate: '2026-05-20',
    crewLeader: 'Crew',
    allocatedFeet: 12,
    coveredFeet: 12,
    reservationState: 'WITH_INSTALL_DATE',
    requirementId: 'req-1',
    allocationKind: 'REQUIREMENT',
    allocationSource: 'MANUAL',
    status: 'ACTIVE',
    createdAt: '2026-05-20T10:00:00Z',
    createdBy: 'tester',
    resolvedAt: '',
    resolvedBy: '',
    filmOrderId: '',
    notes: '',
    ...overrides
  };
}

describe('box detail checkout job options', () => {
  it('preserves same-number allocations as distinct jobId options', () => {
    const options = buildCheckoutJobOptions([
      allocation({
        allocationId: 'alloc-s1',
        jobId: '11111111-1111-4111-8111-111111111111',
        jobNumber: '9327001',
        workScope: 'Sections 1',
        sections: 'Sections 1',
        createdAt: '2026-05-20T10:00:00Z'
      }),
      allocation({
        allocationId: 'alloc-s2',
        jobId: '22222222-2222-4222-8222-222222222222',
        jobNumber: '9327001',
        workScope: 'Sections 2',
        sections: 'Sections 2',
        createdAt: '2026-05-20T10:01:00Z'
      })
    ]);

    expect(options).toEqual([
      {
        label: 'IL1-9327001 · Sections 1',
        value: 'job:11111111-1111-4111-8111-111111111111',
        jobId: '11111111-1111-4111-8111-111111111111',
        jobNumber: '9327001'
      },
      {
        label: 'IL1-9327001 · Sections 2',
        value: 'job:22222222-2222-4222-8222-222222222222',
        jobId: '22222222-2222-4222-8222-222222222222',
        jobNumber: '9327001'
      }
    ]);
  });

  it('keeps legacy jobNumber fallback deduped when no jobId is available', () => {
    const options = buildCheckoutJobOptions([
      allocation({ allocationId: 'legacy-1', jobId: '', jobNumber: '7777' }),
      allocation({ allocationId: 'legacy-2', jobId: '', jobNumber: '7777', createdAt: '2026-05-20T10:01:00Z' })
    ]);

    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      value: '7777',
      jobNumber: '7777'
    });
  });
});
