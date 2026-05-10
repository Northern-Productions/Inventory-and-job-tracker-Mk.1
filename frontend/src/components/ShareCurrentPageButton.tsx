import { Button } from './Button';
import { useToast } from './Toast';
import { copyTextToClipboard } from '../lib/clipboard';

type ShareCurrentPageResult = 'shared' | 'copied' | 'cancelled';

interface ShareCurrentPageOptions {
  title?: string;
  url?: string;
}

export function getCurrentShareUrl() {
  return window.location.href;
}

function isShareCancellation(error: unknown) {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

function canUseNativeShare(shareData: ShareData) {
  if (typeof navigator.share !== 'function') {
    return false;
  }

  if (typeof navigator.canShare !== 'function') {
    return true;
  }

  try {
    return navigator.canShare(shareData);
  } catch (_error) {
    return false;
  }
}

export async function shareOrCopyCurrentPageLink({
  title = document.title || 'Window Film Inventory',
  url = getCurrentShareUrl()
}: ShareCurrentPageOptions = {}): Promise<ShareCurrentPageResult> {
  const shareData: ShareData = { title, url };

  if (canUseNativeShare(shareData)) {
    try {
      await navigator.share(shareData);
      return 'shared';
    } catch (error) {
      if (isShareCancellation(error)) {
        return 'cancelled';
      }
    }
  }

  await copyTextToClipboard(url);
  return 'copied';
}

export function ShareCurrentPageButton() {
  const toast = useToast();

  async function handleShare() {
    try {
      const result = await shareOrCopyCurrentPageLink();

      if (result === 'shared') {
        toast.push({
          title: 'Page shared',
          description: 'The current page link is ready to send.',
          variant: 'success'
        });
        return;
      }

      if (result === 'copied') {
        toast.push({
          title: 'Link copied',
          description: 'The current page link is ready to paste.',
          variant: 'success'
        });
      }
    } catch (_error) {
      toast.push({
        title: 'Unable to copy link',
        description: 'Copy the link from your browser address bar instead.',
        variant: 'error'
      });
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="share-current-page-button"
      onClick={() => void handleShare()}
    >
      Share
    </Button>
  );
}
