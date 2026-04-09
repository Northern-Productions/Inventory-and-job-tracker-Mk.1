import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { useToast } from '../../../../components/Toast';
import { copyTextToClipboard, createBlobFromDataUrl } from './helpers';

type PushToast = ReturnType<typeof useToast>['push'];

interface UseBoxQrCodeArgs {
  boxId?: string;
  showQrFromSearchParam: boolean;
  pushToast: PushToast;
}

export function useBoxQrCode({ boxId, showQrFromSearchParam, pushToast }: UseBoxQrCodeArgs) {
  const [isQrSectionOpen, setIsQrSectionOpen] = useState(showQrFromSearchParam);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState('');
  const [qrCodeError, setQrCodeError] = useState('');

  useEffect(() => {
    if (!boxId) {
      return;
    }

    if (showQrFromSearchParam) {
      setIsQrSectionOpen(true);
    }
  }, [boxId, showQrFromSearchParam]);

  useEffect(() => {
    let isActive = true;

    if (!boxId) {
      setQrCodeDataUrl('');
      setQrCodeError('');
      return () => {
        isActive = false;
      };
    }

    setQrCodeDataUrl('');
    setQrCodeError('');

    void QRCode.toDataURL(boxId, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 220,
      color: {
        dark: '#12343b',
        light: '#ffffffff'
      }
    })
      .then((nextDataUrl: string) => {
        if (!isActive) {
          return;
        }

        setQrCodeDataUrl(nextDataUrl);
      })
      .catch(() => {
        if (!isActive) {
          return;
        }

        setQrCodeError('The QR image could not be generated. You can still copy the BoxID text.');
      });

    return () => {
      isActive = false;
    };
  }, [boxId]);

  async function handleCopyQrCode() {
    if (!boxId) {
      return;
    }

    try {
      await copyTextToClipboard(boxId);
      pushToast({
        title: 'QR code copied',
        description: `${boxId} is ready to paste into your label software.`,
        variant: 'success'
      });
    } catch (_error) {
      pushToast({
        title: 'Copy failed',
        description: 'Clipboard access is unavailable. Copy the BoxID manually from the QR code section.',
        variant: 'error'
      });
    }
  }

  async function handleCopyQrImage() {
    if (!boxId || !qrCodeDataUrl) {
      return;
    }

    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
      pushToast({
        title: 'Image copy is not supported',
        description: 'Use Download QR PNG or Copy QR Code on this device/browser.',
        variant: 'error'
      });
      return;
    }

    try {
      const imageBlob = await createBlobFromDataUrl(qrCodeDataUrl);
      await navigator.clipboard.write([
        new ClipboardItem({
          [imageBlob.type]: imageBlob
        })
      ]);

      pushToast({
        title: 'QR image copied',
        description: `${boxId} is ready to paste into your label software.`,
        variant: 'success'
      });
    } catch (_error) {
      pushToast({
        title: 'Image copy failed',
        description: 'Use Download QR PNG or Copy QR Code instead.',
        variant: 'error'
      });
    }
  }

  function handleDownloadQrImage() {
    if (!boxId || !qrCodeDataUrl) {
      return;
    }

    const link = document.createElement('a');
    link.href = qrCodeDataUrl;
    link.download = `${boxId}-qr.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  return {
    isQrSectionOpen,
    setIsQrSectionOpen,
    qrCodeDataUrl,
    qrCodeError,
    handleCopyQrCode,
    handleCopyQrImage,
    handleDownloadQrImage
  };
}
