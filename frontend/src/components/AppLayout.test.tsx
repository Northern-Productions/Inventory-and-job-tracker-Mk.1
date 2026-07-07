// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLayout } from './AppLayout';
import { ToastProvider } from './Toast';
import { AppThemeProvider } from '../features/theme/AppThemeProvider';
import { APP_THEME_STORAGE_KEY } from '../features/theme/themeStorage';

const useAuthMock = vi.fn();
const useIsPhoneLayoutMock = vi.fn();
const useAppAttentionSummaryMock = vi.fn();
const usePwaInstallMock = vi.fn();
const useWarehouseRegistryMock = vi.fn();
const reloadPageMock = vi.fn();

vi.mock('../features/auth/AuthContext', () => ({
  useAuth: () => useAuthMock()
}));

vi.mock('../hooks/useIsPhoneLayout', () => ({
  useIsPhoneLayout: () => useIsPhoneLayoutMock()
}));

vi.mock('../features/inventory/hooks/useInventoryQueries', () => ({
  useAppAttentionSummary: (...args: unknown[]) => useAppAttentionSummaryMock(...args)
}));

vi.mock('../features/inventory/hooks/useWarehouseRegistry', () => ({
  useWarehouseRegistry: () => useWarehouseRegistryMock()
}));

vi.mock('../features/pwa/PwaInstallContext', () => ({
  usePwaInstall: () => usePwaInstallMock()
}));

vi.mock('../lib/pageReload', () => ({
  reloadPage: () => reloadPageMock()
}));

function buildAuth(overrides: Record<string, unknown> = {}) {
  const permissions: Record<string, { read: boolean; write: boolean }> = {
    inventory: { read: true, write: true },
    allocations: { read: true, write: true },
    film_orders: { read: true, write: true },
    reports: { read: true, write: true },
    activity_history: { read: true, write: true },
    access_management: { read: true, write: true }
  };

  return {
    accessContext: {
      defaultWarehouse: '',
      pendingCount: 0,
      role: 'Owner'
    },
    canAccessAdminConsole: true,
    hasFeatureAccess: (feature: string, mode: 'read' | 'write' = 'read') =>
      permissions[feature]?.[mode] ?? false,
    isAuthenticated: true,
    isOwner: true,
    requestUsernameChange: vi.fn(),
    session: {
      user: {
        email: 'rob@example.com',
        name: 'Rob'
      }
    },
    signOut: vi.fn(),
    updateDefaultWarehouse: vi.fn(),
    ...overrides
  };
}

function buildQueryState<T>(data: T) {
  return {
    data,
    isLoading: false,
    isError: false,
    error: null
  };
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });
}

function buildLayoutTree(pathname: string) {
  return (
    <QueryClientProvider client={createQueryClient()}>
      <ToastProvider>
        <AppThemeProvider>
          <MemoryRouter initialEntries={[pathname]}>
            <Routes>
              <Route path="/" element={<AppLayout />}>
                <Route index element={<div>Inventory page</div>} />
                <Route path="*" element={<div>Nested page</div>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </AppThemeProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

function renderLayout(pathname = '/') {
  return render(buildLayoutTree(pathname));
}

function openAccountMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Account actions' }));
  return screen.getByRole('menu', { name: 'Account actions' });
}

describe('AppLayout', () => {
  beforeEach(() => {
    useAuthMock.mockReturnValue(buildAuth());
    useIsPhoneLayoutMock.mockReturnValue(false);
    useWarehouseRegistryMock.mockReturnValue({
      entries: [
        { code: 'IL1', name: 'Wauconda IL1', boxIdPrefix: 'IL1' },
        { code: 'MS1', name: 'Ridgeland MS1', boxIdPrefix: 'MS1' }
      ]
    });
    reloadPageMock.mockReset();
    useAppAttentionSummaryMock.mockReturnValue(
      buildQueryState({
        hasJobsNeedingAllocation: false,
        hasFilmOrdersNeedingAttention: false,
        hasFilmWeightPendingReviews: false,
        filmWeightPendingReviewCount: 0,
        pendingAccessRequests: false
      })
    );
    usePwaInstallMock.mockReturnValue({
      install: vi.fn(),
      installAvailability: 'manual_only',
      isAndroid: false,
      isInstalled: false,
      isIos: false,
      isSafari: false,
      isInstallStatusReady: false,
      manualInstallMode: 'desktop'
    });
    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      writable: true,
      value: 0
    });
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('renders the theme control in the account menu and defaults to light when no preference is saved', () => {
    const view = renderLayout('/');

    const headerCorner = view.container.querySelector('.app-header-corner');
    if (!(headerCorner instanceof HTMLElement)) {
      throw new Error('Expected app header corner to render.');
    }

    expect(within(headerCorner).getByRole('button', { name: 'Share' })).toBeTruthy();
    expect(within(headerCorner).getByText('Warehouse: All Warehouses')).toBeTruthy();
    expect(within(headerCorner).getByRole('button', { name: 'Account actions' })).toBeTruthy();
    expect(within(headerCorner).queryByRole('group', { name: 'Theme' })).toBeNull();

    const menu = openAccountMenu();
    const themeControl = within(menu).getByRole('group', { name: 'Theme' });
    expect(within(themeControl).getByRole('button', { name: 'Light' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
    expect(within(themeControl).getByRole('button', { name: 'Dark' }).getAttribute('aria-pressed')).toBe(
      'false'
    );
    expect(within(menu).getByRole('menuitem', { name: 'Sign Out' })).toBeTruthy();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('displays the saved default warehouse name in the header', () => {
    useAuthMock.mockReturnValue(
      buildAuth({
        accessContext: {
          defaultWarehouse: 'MS1',
          pendingCount: 0,
          role: 'Owner'
        }
      })
    );

    const view = renderLayout('/');
    const headerCorner = view.container.querySelector('.app-header-corner');
    if (!(headerCorner instanceof HTMLElement)) {
      throw new Error('Expected app header corner to render.');
    }

    expect(within(headerCorner).getByText('Warehouse: Ridgeland MS1 (MS1)')).toBeTruthy();
  });

  it('keeps the default warehouse picker scoped to the current org warehouse registry', () => {
    useAuthMock.mockReturnValue(
      buildAuth({
        accessContext: {
          defaultWarehouse: 'MI1',
          pendingCount: 0,
          role: 'Owner'
        }
      })
    );
    useWarehouseRegistryMock.mockReturnValue({
      entries: [{ code: 'MI1', name: 'Auburn Hills', boxIdPrefix: 'MI1' }]
    });

    const view = renderLayout('/');
    const headerCorner = view.container.querySelector('.app-header-corner');
    if (!(headerCorner instanceof HTMLElement)) {
      throw new Error('Expected app header corner to render.');
    }

    expect(within(headerCorner).getByText('Warehouse: Auburn Hills (MI1)')).toBeTruthy();

    fireEvent.click(within(headerCorner).getByRole('button', { name: 'Account actions' }));
    const menu = screen.getByRole('menu', { name: 'Account actions' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Change warehouse' }));

    const dialog = screen.getByRole('dialog', { name: 'Change warehouse' });
    const options = within(within(dialog).getByRole('combobox', { name: 'Warehouse' })).getAllByRole(
      'option'
    );

    expect(options.map((option) => option.textContent)).toEqual(['All Warehouses', 'Auburn Hills (MI1)']);
    expect(within(dialog).queryByText('Wauconda IL1')).toBeNull();
    expect(within(dialog).queryByText('Ridgeland MS1')).toBeNull();
  });

  it('applies a saved dark theme from localStorage', () => {
    window.localStorage.setItem(APP_THEME_STORAGE_KEY, 'dark');

    renderLayout('/');

    const themeControl = within(openAccountMenu()).getByRole('group', { name: 'Theme' });
    expect(within(themeControl).getByRole('button', { name: 'Dark' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('updates the root theme and persists the selected theme when clicked from the account menu', () => {
    renderLayout('/');

    const themeControl = within(openAccountMenu()).getByRole('group', { name: 'Theme' });
    fireEvent.click(within(themeControl).getByRole('button', { name: 'Dark' }));

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem(APP_THEME_STORAGE_KEY)).toBe('dark');
    expect(within(themeControl).getByRole('button', { name: 'Dark' }).getAttribute('aria-pressed')).toBe(
      'true'
    );

    fireEvent.click(within(themeControl).getByRole('button', { name: 'Light' }));

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(window.localStorage.getItem(APP_THEME_STORAGE_KEY)).toBe('light');
    expect(within(themeControl).getByRole('button', { name: 'Light' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
  });

  it('falls back to light and clears invalid stored theme values', () => {
    window.localStorage.setItem(APP_THEME_STORAGE_KEY, 'system');

    renderLayout('/');

    const themeControl = within(openAccountMenu()).getByRole('group', { name: 'Theme' });
    expect(within(themeControl).getByRole('button', { name: 'Light' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(window.localStorage.getItem(APP_THEME_STORAGE_KEY)).toBeNull();
  });

  it('places the theme control directly above Sign Out in the account menu', () => {
    renderLayout('/');

    const menu = openAccountMenu();
    const menuChildren = Array.from(menu.children);
    const themeIndex = menuChildren.findIndex((child) => child.classList.contains('account-menu-theme'));
    const signOutIndex = menuChildren.findIndex((child) => child.textContent === 'Sign Out');

    expect(themeIndex).toBeGreaterThan(-1);
    expect(signOutIndex).toBeGreaterThan(-1);
    expect(themeIndex).toBeLessThan(signOutIndex);
  });

  it('places Change warehouse directly under Change Username and opens the warehouse modal', () => {
    renderLayout('/');

    const menu = openAccountMenu();
    const menuChildren = Array.from(menu.children);
    const usernameIndex = menuChildren.findIndex((child) => child.textContent === 'Change Username');
    const warehouseIndex = menuChildren.findIndex((child) => child.textContent === 'Change warehouse');

    expect(usernameIndex).toBeGreaterThan(-1);
    expect(warehouseIndex).toBe(usernameIndex + 1);

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Change warehouse' }));

    const dialog = screen.getByRole('dialog', { name: 'Change warehouse' });
    expect(
      within(dialog).getByText(
        'Select the warehouse you usually work from. This will be used as your default filter across the app.'
      )
    ).toBeTruthy();
    expect(within(dialog).getByRole('combobox', { name: 'Warehouse' })).toBeTruthy();
  });

  it('saves the selected default warehouse and reloads only after the save succeeds', async () => {
    const updateDefaultWarehouse = vi.fn().mockResolvedValue({ defaultWarehouse: 'MS1' });
    useAuthMock.mockReturnValue(buildAuth({ updateDefaultWarehouse }));
    renderLayout('/');

    fireEvent.click(screen.getByRole('button', { name: 'Account actions' }));
    const menu = screen.getByRole('menu', { name: 'Account actions' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Change warehouse' }));

    const dialog = screen.getByRole('dialog', { name: 'Change warehouse' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Warehouse' }), {
      target: { value: 'MS1' }
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateDefaultWarehouse).toHaveBeenCalledWith('MS1');
    });
    await waitFor(() => {
      expect(reloadPageMock).toHaveBeenCalledTimes(1);
    });
  });

  it('does not reload and shows an error when default warehouse save fails', async () => {
    const updateDefaultWarehouse = vi.fn().mockRejectedValue(new Error('Save failed'));
    useAuthMock.mockReturnValue(buildAuth({ updateDefaultWarehouse }));
    renderLayout('/');

    fireEvent.click(screen.getByRole('button', { name: 'Account actions' }));
    const menu = screen.getByRole('menu', { name: 'Account actions' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Change warehouse' }));
    const dialog = screen.getByRole('dialog', { name: 'Change warehouse' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateDefaultWarehouse).toHaveBeenCalledWith('');
    });
    expect(reloadPageMock).not.toHaveBeenCalled();
    expect(await screen.findByText('Unable to update warehouse')).toBeTruthy();
    expect(screen.getAllByText('Save failed').length).toBeGreaterThan(0);
  });

  it('shows the Film Orders attention dot on desktop when film still needs ordering', () => {
    useAppAttentionSummaryMock.mockReturnValue(
      buildQueryState({
        hasJobsNeedingAllocation: false,
        hasFilmOrdersNeedingAttention: true,
        hasFilmWeightPendingReviews: false,
        filmWeightPendingReviewCount: 0,
        pendingAccessRequests: false
      })
    );

    renderLayout('/');

    expect(screen.getByRole('link', { name: 'Film Orders (needs ordering)' })).toBeTruthy();
  });

  it('shows the needs-ordering film-orders dot on mobile More and inside the sheet', () => {
    useIsPhoneLayoutMock.mockReturnValue(true);
    useAppAttentionSummaryMock.mockReturnValue(
      buildQueryState({
        hasJobsNeedingAllocation: false,
        hasFilmOrdersNeedingAttention: true,
        hasFilmWeightPendingReviews: false,
        filmWeightPendingReviewCount: 0,
        pendingAccessRequests: false
      })
    );

    renderLayout('/');

    fireEvent.click(screen.getByRole('button', { name: 'More (film orders need ordering)' }));

    const dialog = screen.getByRole('dialog', { name: 'More' });
    expect(within(dialog).getByRole('button', { name: 'Film Orders (needs ordering)' })).toBeTruthy();
  });

  it('does not show the film-orders attention dot when no film orders need ordering', () => {
    renderLayout('/');

    expect(screen.queryByRole('link', { name: 'Film Orders (needs ordering)' })).toBeNull();
  });

  it('shows Weight Chart under desktop More and marks it when film weight reviews are pending', () => {
    useAppAttentionSummaryMock.mockReturnValue(
      buildQueryState({
        hasJobsNeedingAllocation: false,
        hasFilmOrdersNeedingAttention: false,
        hasFilmWeightPendingReviews: true,
        filmWeightPendingReviewCount: 2,
        pendingAccessRequests: false
      })
    );

    renderLayout('/');

    fireEvent.click(screen.getByRole('button', { name: 'More (weight samples need review)' }));

    expect(screen.getByRole('menuitem', { name: 'Weight Chart (pending reviews)' })).toBeTruthy();
  });

  it('does not show the Weight Chart attention dot when no film weight reviews are pending', () => {
    renderLayout('/');

    fireEvent.click(screen.getByRole('button', { name: 'More' }));

    expect(screen.getByRole('menuitem', { name: 'Weight Chart' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Weight Chart (pending reviews)' })).toBeNull();
  });

  it('shows the Weight Chart pending review dot on mobile More and inside the sheet', () => {
    useIsPhoneLayoutMock.mockReturnValue(true);
    useAppAttentionSummaryMock.mockReturnValue(
      buildQueryState({
        hasJobsNeedingAllocation: false,
        hasFilmOrdersNeedingAttention: false,
        hasFilmWeightPendingReviews: true,
        filmWeightPendingReviewCount: 2,
        pendingAccessRequests: false
      })
    );

    renderLayout('/');

    fireEvent.click(screen.getByRole('button', { name: 'More (weight samples need review)' }));

    const dialog = screen.getByRole('dialog', { name: 'More' });
    expect(within(dialog).getByRole('button', { name: 'Weight Chart (pending reviews)' })).toBeTruthy();
  });

  it('shows Labels under desktop More and marks More active on the Labels route', () => {
    renderLayout('/labels');

    fireEvent.click(screen.getByRole('button', { name: 'More' }));

    expect(screen.getByRole('menuitem', { name: 'Labels' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'More' }).className).toContain('nav-link-active');
  });

  it('shows Labels under the mobile More sheet', () => {
    useIsPhoneLayoutMock.mockReturnValue(true);

    renderLayout('/labels');

    fireEvent.click(screen.getByRole('button', { name: 'More' }));

    const dialog = screen.getByRole('dialog', { name: 'More' });
    expect(within(dialog).getByRole('button', { name: 'Labels' })).toBeTruthy();
  });

  it('keeps navigation usable when app attention summary fails', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    useAppAttentionSummaryMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('Attention summary failed')
    });

    renderLayout('/allocations');

    expect(screen.getByRole('link', { name: 'Jobs' })).toBeTruthy();
    expect(screen.getByText('Nested page')).toBeTruthy();
    expect(
      consoleErrorSpy.mock.calls.some((call) =>
        call.some((entry) => String(entry).includes('Maximum update depth exceeded'))
      )
    ).toBe(false);
    consoleErrorSpy.mockRestore();
  });

  it('clears the desktop film-orders attention dot as soon as the last actionable order is gone', () => {
    let hasFilmOrdersNeedingAttention = true;
    useAppAttentionSummaryMock.mockImplementation(() =>
      buildQueryState({
        hasJobsNeedingAllocation: false,
        hasFilmOrdersNeedingAttention,
        hasFilmWeightPendingReviews: false,
        filmWeightPendingReviewCount: 0,
        pendingAccessRequests: false
      })
    );

    const view = renderLayout('/');

    expect(screen.getByRole('link', { name: 'Film Orders (needs ordering)' })).toBeTruthy();

    hasFilmOrdersNeedingAttention = false;
    view.rerender(buildLayoutTree('/'));

    expect(screen.queryByRole('link', { name: 'Film Orders (needs ordering)' })).toBeNull();
  });

  it('shows the desktop film-orders attention dot as soon as a film order needs ordering', () => {
    let hasFilmOrdersNeedingAttention = false;
    useAppAttentionSummaryMock.mockImplementation(() =>
      buildQueryState({
        hasJobsNeedingAllocation: false,
        hasFilmOrdersNeedingAttention,
        hasFilmWeightPendingReviews: false,
        filmWeightPendingReviewCount: 0,
        pendingAccessRequests: false
      })
    );

    const view = renderLayout('/');

    expect(screen.queryByRole('link', { name: 'Film Orders (needs ordering)' })).toBeNull();

    hasFilmOrdersNeedingAttention = true;
    view.rerender(buildLayoutTree('/'));

    expect(screen.getByRole('link', { name: 'Film Orders (needs ordering)' })).toBeTruthy();
  });

  it('renders the desktop title header separately from the sticky nav', () => {
    const view = renderLayout('/');
    const header = view.container.querySelector('.app-header');
    const topline = view.container.querySelector('.app-header-topline');
    const navWrap = view.container.querySelector('.app-header-nav-wrap');
    if (!(header instanceof HTMLElement)) {
      throw new Error('Expected header to render.');
    }
    if (!(topline instanceof HTMLElement)) {
      throw new Error('Expected desktop topline to render.');
    }
    if (!(navWrap instanceof HTMLElement)) {
      throw new Error('Expected desktop nav wrapper to render.');
    }

    expect(header.classList.contains('app-header-desktop')).toBe(true);
    expect(header.classList.contains('app-header-pinned')).toBe(false);
    expect(header.classList.contains('app-header-compact')).toBe(false);
    expect(header.querySelector('.app-header-nav-wrap')).toBeNull();
    expect(within(topline).getByRole('heading', { name: 'Window Film Inventory' })).toBeTruthy();
    expect(within(topline).getByRole('button', { name: 'Share' })).toBeTruthy();
    expect(within(navWrap).getByRole('navigation', { name: 'Primary' })).toBeTruthy();
  });

  it('does not compact or pin the desktop header when the page scrolls', () => {
    const view = renderLayout('/');
    const header = view.container.querySelector('.app-header');
    if (!(header instanceof HTMLElement)) {
      throw new Error('Expected header to render.');
    }

    window.scrollY = 128;
    fireEvent.scroll(window);
    fireEvent(window, new Event('resize'));

    expect(header.classList.contains('app-header-compact')).toBe(false);
    expect(header.classList.contains('app-header-pinned')).toBe(false);
  });

  it('does not render the desktop sticky nav on phone layout', () => {
    useIsPhoneLayoutMock.mockReturnValue(true);

    const view = renderLayout('/');
    const header = view.container.querySelector('.app-header');
    if (!(header instanceof HTMLElement)) {
      throw new Error('Expected header to render.');
    }

    window.scrollY = 120;
    fireEvent.scroll(window);

    expect(header.classList.contains('app-header-desktop')).toBe(false);
    expect(header.classList.contains('app-header-pinned')).toBe(false);
    expect(header.classList.contains('app-header-compact')).toBe(false);
    expect(view.container.querySelector('.app-header-nav-wrap')).toBeNull();
  });
});
