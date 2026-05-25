import type { AppTheme } from './themeStorage';
import { useAppTheme } from './AppThemeProvider';

const THEME_OPTIONS: Array<{ label: string; value: AppTheme }> = [
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' }
];

export function ThemeToggle() {
  const { theme, setTheme } = useAppTheme();

  return (
    <div className="inventory-view-toggle theme-toggle" role="group" aria-label="Theme">
      {THEME_OPTIONS.map((option) => {
        const isSelected = theme === option.value;
        return (
          <button
            type="button"
            className={`inventory-view-toggle-button theme-toggle-button ${
              isSelected ? 'inventory-view-toggle-button-active' : ''
            }`.trim()}
            aria-pressed={isSelected}
            key={option.value}
            onClick={() => setTheme(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
