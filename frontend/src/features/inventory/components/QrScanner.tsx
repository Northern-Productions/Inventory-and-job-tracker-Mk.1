import { useEffect, useId, useState } from 'react';
import type { Html5Qrcode } from 'html5-qrcode';
import { useIsPhoneLayout } from '../../../hooks/useIsPhoneLayout';

interface QrScannerProps {
  onResolved: (boxId: string) => boolean | Promise<boolean>;
}

export function QrScanner({ onResolved }: QrScannerProps) {
  const isPhoneLayout = useIsPhoneLayout();
  const [error, setError] = useState('');
  const rawId = useId();
  const elementId = rawId.replace(/:/g, '_');

  useEffect(() => {
    let active = true;
    let scanner: Html5Qrcode | null = null;

    async function startScanner() {
      try {
        const { Html5Qrcode: Html5QrcodeScanner } = await import('html5-qrcode');
        if (!active) {
          return;
        }

        const nextScanner = new Html5QrcodeScanner(elementId);
        scanner = nextScanner;

        await nextScanner.start(
          { facingMode: 'environment' },
          {
            fps: 10,
            qrbox: isPhoneLayout ? { width: 200, height: 200 } : { width: 220, height: 220 }
          },
          async (decodedText) => {
            const boxId = decodedText.trim();
            navigator.vibrate?.(40);
            const didResolve = await onResolved(boxId);
            if (didResolve && scanner) {
              await scanner.stop().catch(() => undefined);
            }
          },
          () => undefined
        );
      } catch (_error) {
        setError('Camera access failed. Use the manual fallback below.');
      }
    }

    void startScanner();

    return () => {
      active = false;
      if (scanner) {
        const currentScanner = scanner;
        void scanner
          .stop()
          .catch(() => undefined)
          .then(() => {
            currentScanner.clear();
          });
      }
    };
  }, [elementId, isPhoneLayout, onResolved]);

  return (
    <div className="panel">
      <h2>Scan QR</h2>
      <div id={elementId} className="scanner-frame" />
      {error ? <p className="error-text">{error}</p> : null}
      <p className="muted-text">The QR code should contain only the BoxID text.</p>
    </div>
  );
}
