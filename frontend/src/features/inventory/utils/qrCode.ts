import QRCode from 'qrcode';

export const BOX_QR_CODE_OPTIONS = {
  errorCorrectionLevel: 'M',
  margin: 1,
  width: 220,
  color: {
    dark: '#12343b',
    light: '#ffffffff'
  }
} as const;

/**
 * PURPOSE:
 * Centralizes the box QR payload so Box Details and printed labels cannot drift.
 *
 * AFFECTS:
 * Box Details QR card, Labels workspace QR images, and scanner compatibility.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * QrScanPage lookup behavior, Box Details copy/download actions, and label QR tests.
 *
 * COMMON FAILURE MODES:
 * Labels encoding a URL while Box Details encodes a BoxID, stale scanner assumptions, or blank QR payloads.
 */
export function buildBoxQrPayload(boxId: string): string {
  return String(boxId || '').trim();
}

export async function createBoxQrCodeDataUrl(boxId: string): Promise<string> {
  const payload = buildBoxQrPayload(boxId);
  if (!payload) {
    throw new Error('Box ID is required to generate a QR code.');
  }

  return QRCode.toDataURL(payload, BOX_QR_CODE_OPTIONS);
}
