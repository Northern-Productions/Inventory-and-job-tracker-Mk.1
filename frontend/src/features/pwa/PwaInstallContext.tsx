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
  resolveManualInstallMode,
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
  canInstall: boolean;
  install: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
  isAndroid: boolean;
  isInstallSupported: boolean;
  isInstalled: boolean;
  isIos: boolean;
  isSafari: boolean;
  manualInstallMode: ManualInstallMode;
  needsManualInstall: boolean;
}

const PwaInstallContext = createContext<PwaInstallContextValue | null>(null);

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

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
      refreshStandaloneState();
    };

    const handleAppInstalled = () => {
      setDeferredPrompt(null);
      setIsInstalled(true);
    };

    refreshStandaloneState();

    const mediaQuery =
      typeof window.matchMedia === 'function' ? window.matchMedia('(display-mode: standalone)') : null;
    const handleDisplayModeChange = () => {
      refreshStandaloneState();
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
    const canInstall = Boolean(deferredPrompt) && !isInstalled;
    return {
      canInstall,
      install,
      isAndroid: platform.isAndroid,
      isInstallSupported: !isInstalled,
      isInstalled,
      isIos: platform.isIos,
      isSafari: platform.isSafari,
      manualInstallMode: resolveManualInstallMode(platform),
      needsManualInstall: !isInstalled && !canInstall
    };
  }, [deferredPrompt, install, isInstalled, platform]);

  return <PwaInstallContext.Provider value={value}>{children}</PwaInstallContext.Provider>;
}

export function usePwaInstall() {
  const context = useContext(PwaInstallContext);
  if (!context) {
    throw new Error('usePwaInstall must be used within PwaInstallProvider.');
  }

  return context;
}
