// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from './Toast';

function ToastHarness() {
  const toast = useToast();

  return (
    <div>
      <button
        type="button"
        onClick={() =>
          toast.push({
            title: 'Saved',
            description: 'The job was saved.',
            variant: 'success',
            durationMs: 30_000
          })
        }
      >
        Show success
      </button>
      <button
        type="button"
        onClick={() =>
          toast.push({
            title: 'Unable to save',
            description: 'Please check the required fields.',
            variant: 'error',
            durationMs: 30_000
          })
        }
      >
        Show error
      </button>
      <button
        type="button"
        onClick={() =>
          toast.push({
            title: 'Check details',
            description: 'One optional field was skipped.',
            variant: 'warning',
            durationMs: 30_000
          })
        }
      >
        Show warning
      </button>
      <button
        type="button"
        onClick={() =>
          toast.push({
            title: 'Default success',
            durationMs: 30_000
          })
        }
      >
        Show default
      </button>
    </div>
  );
}

function renderToastHarness() {
  return render(
    <ToastProvider>
      <ToastHarness />
    </ToastProvider>
  );
}

function getToastForText(text: string) {
  const toast = screen.getByText(text).closest('.toast');
  expect(toast).not.toBeNull();
  return toast as HTMLElement;
}

describe('ToastProvider', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders success toasts with the success variant class and status role', () => {
    renderToastHarness();

    fireEvent.click(screen.getByRole('button', { name: 'Show success' }));

    const toast = getToastForText('Saved');
    expect(toast.classList.contains('toast-success')).toBe(true);
    expect(toast.getAttribute('role')).toBe('status');
    expect(toast.textContent).toContain('OK');
  });

  it('renders error toasts with the error variant class and alert role', () => {
    renderToastHarness();

    fireEvent.click(screen.getByRole('button', { name: 'Show error' }));

    const toast = getToastForText('Unable to save');
    expect(toast.classList.contains('toast-error')).toBe(true);
    expect(toast.classList.contains('toast-success')).toBe(false);
    expect(toast.getAttribute('role')).toBe('alert');
    expect(toast.textContent).toContain('X');
  });

  it('keeps warning/default variants out of the error styling', () => {
    renderToastHarness();

    fireEvent.click(screen.getByRole('button', { name: 'Show warning' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show default' }));

    const warning = getToastForText('Check details');
    const defaultToast = getToastForText('Default success');
    expect(warning.classList.contains('toast-warning')).toBe(true);
    expect(warning.classList.contains('toast-error')).toBe(false);
    expect(defaultToast.classList.contains('toast-success')).toBe(true);
  });

  it('keeps the toast in place briefly with an exit class before removing it', () => {
    vi.useFakeTimers();
    renderToastHarness();

    fireEvent.click(screen.getByRole('button', { name: 'Show success' }));
    const toast = getToastForText('Saved');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(toast.classList.contains('toast-exit')).toBe(true);

    act(() => {
      vi.advanceTimersByTime(230);
    });

    expect(screen.queryByText('Saved')).toBeNull();
  });
});
