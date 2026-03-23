import { describe, expect, it } from 'vitest';
import { detectInstallPlatform, isStandaloneDisplayMode, resolveManualInstallMode } from './installUtils';

describe('detectInstallPlatform', () => {
  it('detects iPhone Safari correctly', () => {
    expect(
      detectInstallPlatform(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
      )
    ).toEqual({
      isAndroid: false,
      isIos: true,
      isSafari: true
    });
  });

  it('detects iPad desktop-mode Safari from touch support', () => {
    expect(
      detectInstallPlatform(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
        5
      )
    ).toEqual({
      isAndroid: false,
      isIos: true,
      isSafari: true
    });
  });

  it('detects Android Chrome without mislabeling it as Safari', () => {
    expect(
      detectInstallPlatform(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36'
      )
    ).toEqual({
      isAndroid: true,
      isIos: false,
      isSafari: false
    });
  });
});

describe('isStandaloneDisplayMode', () => {
  it('treats either standalone signal as installed', () => {
    expect(isStandaloneDisplayMode(true, false)).toBe(true);
    expect(isStandaloneDisplayMode(false, true)).toBe(true);
  });

  it('stays false when neither standalone signal is present', () => {
    expect(isStandaloneDisplayMode(false, false)).toBe(false);
    expect(isStandaloneDisplayMode(false, undefined)).toBe(false);
  });
});

describe('resolveManualInstallMode', () => {
  it('prefers ios instructions for Apple mobile devices', () => {
    expect(
      resolveManualInstallMode({
        isAndroid: false,
        isIos: true,
        isSafari: true
      })
    ).toBe('ios');
  });

  it('returns desktop instructions by default', () => {
    expect(
      resolveManualInstallMode({
        isAndroid: false,
        isIos: false,
        isSafari: false
      })
    ).toBe('desktop');
  });
});
