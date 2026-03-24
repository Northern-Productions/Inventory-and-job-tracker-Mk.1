import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react';
import {
  detectInstallPlatform,
  isStandaloneDisplayMode,
  resolveInstallAvailability,
  resolveManualInstallMode,
  type InstallAvailability,
  type ManualInstallMode
} from './installUtils';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
}

interface PwaInstallContextValue {
  install: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
  installAvailability: InstallAvailability;
  isAndroid: boolean;
  isInstalled: boolean;
  isIos: boolean;
  isSafari: boolean;
  isInstallStatusReady: boolean;
  manualInstallMode: ManualInstallMode;
}

const PwaInstallContext = createContext<PwaInstallContextValue | null>(null);
const INITIAL_INSTALL_STATUS_SETTLE_MS = 900;

function readStandaloneState() {
  if (typeof window === 'undefined') {
    return false;
  }

  const navigatorWithStandalone = window.navigator as Navigator & { standalone?: boolean };
  const displayModeStandalone =
    typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches;

  return isStandaloneDisplayMode(displayModeStandalone, navigatorWithStandalone.standalone);
}

export function PwaInstallProvider({ children }: { children: ReactNode }) {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(() => readStandaloneState());
  const [isInstallStatusReady, setIsInstallStatusReady] = useState(() => readStandaloneState());
  const platform = useMemo(() => {
    if (typeof navigator === 'undefined') {
      return {
        isAndroid: false,
        isIos: false,
        isSafari: false
      };
    }

    return detectInstallPlatform(navigator.userAgent, navigator.maxTouchPoints || 0);
  }, []);

  const refreshStandaloneState = useCallback(() => {
    setIsInstalled(readStandaloneState());
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    let settleTimer: number | null = null;
    const clearSettleTimer = () => {
      if (settleTimer !== null) {
        window.clearTimeout(settleTimer);
        settleTimer = null;
      }
    };

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      clearSettleTimer();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
      setIsInstallStatusReady(true);
      refreshStandaloneState();
    };

    const handleAppInstalled = () => {
      clearSettleTimer();
      setDeferredPrompt(null);
      setIsInstalled(true);
      setIsInstallStatusReady(true);
    };

    const syncInstallState = () => {
      const nextIsInstalled = readStandaloneState();
      setIsInstalled(nextIsInstalled);
      if (nextIsInstalled) {
        clearSettleTimer();
        setIsInstallStatusReady(true);
        return;
      }

      settleTimer = window.setTimeout(() => {
        refreshStandaloneState();
        setIsInstallStatusReady(true);
      }, INITIAL_INSTALL_STATUS_SETTLE_MS);
    };

    syncInstallState();

    const mediaQuery =
      typeof window.matchMedia === 'function' ? window.matchMedia('(display-mode: standalone)') : null;
    const handleDisplayModeChange = () => {
      refreshStandaloneState();
      if (readStandaloneState()) {
        clearSettleTimer();
        setIsInstallStatusReady(true);
      }
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt as EventListener);
    window.addEventListener('appinstalled', handleAppInstalled);
    if (mediaQuery) {
      if (typeof mediaQuery.addEventListener === 'function') {
        mediaQuery.addEventListener('change', handleDisplayModeChange);
      } else {
        mediaQuery.addListener(handleDisplayModeChange);
      }
    }

    return () => {
      clearSettleTimer();
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt as EventListener);
      window.removeEventListener('appinstalled', handleAppInstalled);
      if (mediaQuery) {
        if (typeof mediaQuery.removeEventListener === 'function') {
          mediaQuery.removeEventListener('change', handleDisplayModeChange);
        } else {
          mediaQuery.removeListener(handleDisplayModeChange);
        }
      }
    };
  }, [refreshStandaloneState]);

  const install = useCallback(async () => {
    if (!deferredPrompt || isInstalled) {
      return 'unavailable';
    }

    const activePrompt = deferredPrompt;
    setDeferredPrompt(null);

    try {
      await activePrompt.prompt();
      const choice = await activePrompt.userChoice;
      refreshStandaloneState();
      return choice.outcome;
    } catch (_error) {
      refreshStandaloneState();
      return 'dismissed';
    }
  }, [deferredPrompt, isInstalled, refreshStandaloneState]);

  const value = useMemo<PwaInstallContextValue>(() => {
    const installAvailability = resolveInstallAvailability({
      hasDeferredPrompt: Boolean(deferredPrompt),
      isInstalled
    });

    return {
      install,
      installAvailability,
      isAndroid: platform.isAndroid,
      isInstalled,
      isIos: platform.isIos,
      isSafari: platform.isSafari,
      isInstallStatusReady,
      manualInstallMode: resolveManualInstallMode(platform)
    };
  }, [deferredPrompt, install, isInstalled, isInstallStatusReady, platform]);

  return <PwaInstallContext.Provider value={value}>{children}</PwaInstallContext.Provider>;
}

export function usePwaInstall() {
  const context = useContext(PwaInstallContext);
  if (!context) {
    throw new Error('usePwaInstall must be used within PwaInstallProvider.');
  }

  return context;
}
