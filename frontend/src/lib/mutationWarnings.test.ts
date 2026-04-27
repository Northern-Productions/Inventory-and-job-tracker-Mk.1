import { describe, expect, it, vi } from 'vitest';

import {
  PLANNER_WARNING_SUMMARY,
  formatMutationWarningDescription,
  isPlannerDiagnosticWarning,
  splitMutationWarnings
} from './mutationWarnings';

describe('mutation warning formatting', () => {
  it('classifies allocation planner diagnostics without treating normal warnings as planner warnings', () => {
    expect(
      isPlannerDiagnosticWarning(
        'Skipped AUTO planning for box IL1-6788 because existing hard/frozen allocations exceed physical capacity.'
      )
    ).toBe(true);
    expect(
      isPlannerDiagnosticWarning(
        'Skipped AUTO caulk planning for product DOW-795-BLK in IL1 because existing active allocations exceed physical stock.'
      )
    ).toBe(true);
    expect(isPlannerDiagnosticWarning('This box still has active allocations for job 1234.')).toBe(false);
  });

  it('splits and deduplicates planner diagnostics from user-facing warnings', () => {
    const result = splitMutationWarnings([
      'This box still has active allocations for job 1234.',
      'This box still has active allocations for job 1234.',
      'Skipped AUTO caulk planning for product DOW-795-BLK in IL1 because existing active allocations exceed physical stock.',
      'Skipped AUTO planning for box IL1-6788 because existing hard/frozen allocations exceed physical capacity.'
    ]);

    expect(result.userWarnings).toEqual(['This box still has active allocations for job 1234.']);
    expect(result.plannerWarnings).toEqual([
      'Skipped AUTO caulk planning for product DOW-795-BLK in IL1 because existing active allocations exceed physical stock.',
      'Skipped AUTO planning for box IL1-6788 because existing hard/frozen allocations exceed physical capacity.'
    ]);
  });

  it('summarizes planner-only warnings for toasts while logging full details', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(
      formatMutationWarningDescription(
        [
          'Skipped AUTO planning for box IL1-6788 because existing hard/frozen allocations exceed physical capacity.',
          'Skipped AUTO planning for box IL1-4075 because existing active allocations exceed physical capacity.'
        ],
        'Saved successfully.',
        'test-mutation'
      )
    ).toBe(`${PLANNER_WARNING_SUMMARY} 2 planner warnings hidden.`);

    expect(warnSpy).toHaveBeenCalledWith(
      '[test-mutation] Allocation planner warnings',
      [
        'Skipped AUTO planning for box IL1-6788 because existing hard/frozen allocations exceed physical capacity.',
        'Skipped AUTO planning for box IL1-4075 because existing active allocations exceed physical capacity.'
      ]
    );

    warnSpy.mockRestore();
  });

  it('keeps normal warnings visible and appends a short planner summary for mixed warnings', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(
      formatMutationWarningDescription(
        [
          'This box still has active allocations for job 1234.',
          'Skipped AUTO planning for box IL1-6788 because planner capacity would become negative.'
        ],
        'Saved successfully.'
      )
    ).toBe(
      `This box still has active allocations for job 1234. ${PLANNER_WARNING_SUMMARY} 1 planner warning hidden.`
    );

    warnSpy.mockRestore();
  });

  it('truncates large warning arrays while preserving a hidden count', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(
      formatMutationWarningDescription(
        [
          'Warning one.',
          'Warning two.',
          'Warning three.',
          'Warning four.',
          'Warning five.'
        ],
        'Saved successfully.'
      )
    ).toBe('Warning one. Warning two. Warning three. 2 more warnings hidden.');

    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('supports receive-specific planner summaries without dumping raw diagnostic text', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const description = formatMutationWarningDescription(
      [
        'Skipped AUTO caulk planning for product DOW-795-BLK in IL1 because existing active allocations exceed physical stock.',
        'Skipped AUTO caulk planning for product DOW-795-BLK in IL1 because existing active allocations exceed physical stock.',
        'Skipped AUTO caulk planning for product DOW-795-WHT in IL1 because existing active allocations exceed physical stock.'
      ],
      'Box received.',
      'ordered-receive',
      {
        plannerSummary: 'Box received with planner warnings. Some legacy reservations may need review.'
      }
    );

    expect(description).toBe(
      'Box received with planner warnings. Some legacy reservations may need review. 2 planner warnings hidden.'
    );
    expect(description).not.toContain('DOW-795-BLK');
    expect(warnSpy).toHaveBeenCalledWith('[ordered-receive] Allocation planner warnings', [
      'Skipped AUTO caulk planning for product DOW-795-BLK in IL1 because existing active allocations exceed physical stock.',
      'Skipped AUTO caulk planning for product DOW-795-WHT in IL1 because existing active allocations exceed physical stock.'
    ]);

    warnSpy.mockRestore();
  });
});
