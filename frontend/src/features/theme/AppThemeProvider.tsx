import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from 'react';
import {
  type AppTheme,
  applyAppTheme,
  getStoredAppTheme,
  normalizeAppTheme,
  setStoredAppTheme
} from './themeStorage';

interface AppThemeContextValue {
  theme: AppTheme;
  setTheme: (theme: AppTheme) => void;
}

const AppThemeContext = createContext<AppThemeContextValue | null>(null);

export function AppThemeProvider({ children }: PropsWithChildren) {
  const [theme, setThemeState] = useState<AppTheme>(() => getStoredAppTheme());

  useEffect(() => {
    applyAppTheme(theme);
  }, [theme]);

  const setTheme = useCallback((nextTheme: AppTheme) => {
    const normalizedTheme = normalizeAppTheme(nextTheme);
    applyAppTheme(normalizedTheme);
    setStoredAppTheme(normalizedTheme);
    setThemeState(normalizedTheme);
  }, []);

  const value = useMemo(
    () => ({
      theme,
      setTheme
    }),
    [setTheme, theme]
  );

  return <AppThemeContext.Provider value={value}>{children}</AppThemeContext.Provider>;
}

export function useAppTheme() {
  const context = useContext(AppThemeContext);
  if (!context) {
    throw new Error('useAppTheme must be used within AppThemeProvider');
  }
  return context;
}
