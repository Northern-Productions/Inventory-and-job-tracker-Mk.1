// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DialogSurface } from './DialogSurface';

function TestDialog({
  open,
  onClose
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <>
      <button type="button" data-testid="dialog-launcher">
        Open dialog
      </button>
      <DialogSurface open={open} onClose={onClose} titleId="test-dialog-title">
        <h2 id="test-dialog-title">Test Dialog</h2>
        <input aria-label="First field" />
        <div style={{ height: '900px' }} />
        <input aria-label="Deep field" />
      </DialogSurface>
    </>
  );
}

afterEach(() => {
  cleanup();
});

describe('DialogSurface', () => {
  it('does not restore outside focus or refocus the first field while an open dialog rerenders', () => {
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    const view = render(<TestDialog open={false} onClose={firstClose} />);
    const launcher = screen.getByTestId('dialog-launcher') as HTMLButtonElement;
    launcher.focus();

    view.rerender(<TestDialog open onClose={firstClose} />);

    const dialog = screen.getByRole('dialog', { name: 'Test Dialog' }) as HTMLElement;
    const deepField = screen.getByRole('textbox', { name: 'Deep field' }) as HTMLInputElement;
    const launcherFocus = vi.spyOn(launcher, 'focus');
    dialog.scrollTop = 420;
    deepField.focus();

    view.rerender(<TestDialog open onClose={secondClose} />);

    expect(launcherFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(deepField);
    expect(dialog.scrollTop).toBe(420);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(firstClose).not.toHaveBeenCalled();
    expect(secondClose).toHaveBeenCalledTimes(1);
  });
});
