export type AppTheme = 'light' | 'dark';

export const APP_THEME_STORAGE_KEY = 'window-film-inventory-theme';
export const DEFAULT_APP_THEME: AppTheme = 'light';

export function normalizeAppTheme(value: unknown): AppTheme {
  return value === 'dark' || value === 'light' ? value : DEFAULT_APP_THEME;
}

export function getStoredAppTheme(): AppTheme {
  try {
    const storedTheme = window.localStorage.getItem(APP_THEME_STORAGE_KEY);
    if (!storedTheme) {
      return DEFAULT_APP_THEME;
    }

    if (storedTheme !== 'light' && storedTheme !== 'dark') {
      window.localStorage.removeItem(APP_THEME_STORAGE_KEY);
      return DEFAULT_APP_THEME;
    }

    return storedTheme;
  } catch (_error) {
    return DEFAULT_APP_THEME;
  }
}

export function setStoredAppTheme(theme: AppTheme): void {
  try {
    window.localStorage.setItem(APP_THEME_STORAGE_KEY, theme);
  } catch (_error) {
    // Storage can be unavailable in private browsing or hardened contexts.
  }
}

export function applyAppTheme(theme: AppTheme): void {
  if (typeof document === 'undefined') {
    return;
  }

  document.documentElement.setAttribute('data-theme', theme);
}

export function initializeAppTheme(): AppTheme {
  const theme = getStoredAppTheme();
  applyAppTheme(theme);
  return theme;
}
