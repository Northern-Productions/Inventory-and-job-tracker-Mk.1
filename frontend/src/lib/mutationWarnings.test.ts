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
    expect(isPlannerDiagnosticWarning('This box still has active allocations for job 1234.')).toBe(false);
  });

  it('splits planner diagnostics from user-facing warnings', () => {
    const result = splitMutationWarnings([
      'This box still has active allocations for job 1234.',
      'Skipped AUTO planning for box IL1-6788 because existing hard/frozen allocations exceed physical capacity.'
    ]);

    expect(result.userWarnings).toEqual(['This box still has active allocations for job 1234.']);
    expect(result.plannerWarnings).toEqual([
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
    ).toBe(PLANNER_WARNING_SUMMARY);

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
    ).toBe(`This box still has active allocations for job 1234. ${PLANNER_WARNING_SUMMARY}`);

    warnSpy.mockRestore();
  });
});
