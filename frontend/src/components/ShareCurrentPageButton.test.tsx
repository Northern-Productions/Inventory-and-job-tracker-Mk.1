// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShareCurrentPageButton } from './ShareCurrentPageButton';
import { ToastProvider } from './Toast';

const originalShare = navigator.share;
const originalCanShare = navigator.canShare;
const originalClipboard = navigator.clipboard;

function setNavigatorValue(property: 'share' | 'canShare' | 'clipboard', value: unknown) {
  Object.defineProperty(navigator, property, {
    configurable: true,
    value
  });
}

function renderShareButton() {
  return render(
    <ToastProvider>
      <ShareCurrentPageButton />
    </ToastProvider>
  );
}

describe('ShareCurrentPageButton', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    setNavigatorValue('share', originalShare);
    setNavigatorValue('canShare', originalCanShare);
    setNavigatorValue('clipboard', originalClipboard);
    window.history.replaceState({}, '', '/');
    document.title = '';
  });

  it('uses native share when available', async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    const canShareMock = vi.fn().mockReturnValue(true);
    const clipboardMock = { writeText: vi.fn().mockResolvedValue(undefined) };
    document.title = 'Job 4953';
    window.history.pushState({}, '', '/#/allocations/4953');
    setNavigatorValue('share', shareMock);
    setNavigatorValue('canShare', canShareMock);
    setNavigatorValue('clipboard', clipboardMock);

    renderShareButton();

    fireEvent.click(screen.getByRole('button', { name: 'Share' }));

    await waitFor(() => {
      expect(shareMock).toHaveBeenCalledWith({
        title: 'Job 4953',
        url: window.location.href
      });
    });
    expect(canShareMock).toHaveBeenCalledWith({
      title: 'Job 4953',
      url: window.location.href
    });
    expect(clipboardMock.writeText).not.toHaveBeenCalled();
    expect(await screen.findByText('Page shared')).toBeTruthy();
  });

  it('copies the exact hash-route URL when native share is unavailable', async () => {
    const clipboardMock = { writeText: vi.fn().mockResolvedValue(undefined) };
    window.history.pushState({}, '', '/#/allocations/4953?panel=film');
    setNavigatorValue('share', undefined);
    setNavigatorValue('canShare', undefined);
    setNavigatorValue('clipboard', clipboardMock);

    renderShareButton();

    fireEvent.click(screen.getByRole('button', { name: 'Share' }));

    await waitFor(() => {
      expect(clipboardMock.writeText).toHaveBeenCalledWith(window.location.href);
    });
    expect(clipboardMock.writeText.mock.calls[0][0]).toContain('/#/allocations/4953?panel=film');
    expect(await screen.findByText('Link copied')).toBeTruthy();
  });

  it('shows an error toast when the link cannot be copied', async () => {
    const clipboardMock = { writeText: vi.fn().mockRejectedValue(new Error('blocked')) };
    setNavigatorValue('share', undefined);
    setNavigatorValue('canShare', undefined);
    setNavigatorValue('clipboard', clipboardMock);

    renderShareButton();

    fireEvent.click(screen.getByRole('button', { name: 'Share' }));

    expect(await screen.findByText('Unable to copy link')).toBeTruthy();
  });

  it('does not show an error when native share is cancelled', async () => {
    const shareError = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const shareMock = vi.fn().mockRejectedValue(shareError);
    const clipboardMock = { writeText: vi.fn().mockResolvedValue(undefined) };
    setNavigatorValue('share', shareMock);
    setNavigatorValue('canShare', vi.fn().mockReturnValue(true));
    setNavigatorValue('clipboard', clipboardMock);

    renderShareButton();

    fireEvent.click(screen.getByRole('button', { name: 'Share' }));

    await waitFor(() => {
      expect(shareMock).toHaveBeenCalled();
    });
    expect(clipboardMock.writeText).not.toHaveBeenCalled();
    expect(screen.queryByText('Unable to copy link')).toBeNull();
    expect(screen.queryByText('Link copied')).toBeNull();
    expect(screen.queryByText('Page shared')).toBeNull();
  });
});
