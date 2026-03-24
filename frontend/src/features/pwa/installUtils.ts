export interface InstallPlatformInfo {
  isAndroid: boolean;
  isIos: boolean;
  isSafari: boolean;
}

export type InstallAvailability = 'native_prompt_available' | 'manual_only' | 'already_installed';
export type ManualInstallMode = 'android' | 'desktop' | 'ios';

export function detectInstallPlatform(userAgent: string, maxTouchPoints = 0): InstallPlatformInfo {
  const normalizedUserAgent = userAgent.toLowerCase();
  const isAndroid = normalizedUserAgent.includes('android');
  const isIpadDesktopMode = normalizedUserAgent.includes('macintosh') && maxTouchPoints > 1;
  const isIos =
    normalizedUserAgent.includes('iphone') ||
    normalizedUserAgent.includes('ipad') ||
    normalizedUserAgent.includes('ipod') ||
    isIpadDesktopMode;
  const isSafari =
    normalizedUserAgent.includes('safari') &&
    !normalizedUserAgent.includes('crios') &&
    !normalizedUserAgent.includes('chrome') &&
    !normalizedUserAgent.includes('android') &&
    !normalizedUserAgent.includes('fxios') &&
    !normalizedUserAgent.includes('edgios') &&
    !normalizedUserAgent.includes('opr/');

  return {
    isAndroid,
    isIos,
    isSafari
  };
}

export function isStandaloneDisplayMode(
  displayModeStandalone: boolean,
  navigatorStandalone: boolean | undefined
) {
  return displayModeStandalone || navigatorStandalone === true;
}

export function resolveInstallAvailability({
  hasDeferredPrompt,
  isInstalled
}: {
  hasDeferredPrompt: boolean;
  isInstalled: boolean;
}): InstallAvailability {
  if (isInstalled) {
    return 'already_installed';
  }

  if (hasDeferredPrompt) {
    return 'native_prompt_available';
  }

  return 'manual_only';
}

export function resolveManualInstallMode(platform: InstallPlatformInfo): ManualInstallMode {
  if (platform.isIos) {
    return 'ios';
  }

  if (platform.isAndroid) {
    return 'android';
  }

  return 'desktop';
}
