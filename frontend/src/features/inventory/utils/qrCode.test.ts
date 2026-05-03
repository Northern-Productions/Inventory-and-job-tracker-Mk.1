import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBoxQrPayload, createBoxQrCodeDataUrl, BOX_QR_CODE_OPTIONS } from './qrCode';

const { toDataUrlMock } = vi.hoisted(() => ({
  toDataUrlMock: vi.fn()
}));

vi.mock('qrcode', () => ({
  default: {
    toDataURL: (...args: unknown[]) => toDataUrlMock(...args)
  }
}));

describe('box QR helpers', () => {
  beforeEach(() => {
    toDataUrlMock.mockReset();
  });

  it('matches the current Box Details behavior by encoding the canonical Box ID', () => {
    expect(buildBoxQrPayload(' MO1-0028 ')).toBe('MO1-0028');
  });

  it('generates QR data URLs with the shared Box Details options', async () => {
    toDataUrlMock.mockResolvedValueOnce('data:image/png;base64,abc');

    await expect(createBoxQrCodeDataUrl('MO1-0028')).resolves.toBe('data:image/png;base64,abc');
    expect(toDataUrlMock).toHaveBeenCalledWith('MO1-0028', BOX_QR_CODE_OPTIONS);
  });

  it('rejects blank QR payloads before calling qrcode', async () => {
    await expect(createBoxQrCodeDataUrl('')).rejects.toThrow('Box ID is required');
  });
});
