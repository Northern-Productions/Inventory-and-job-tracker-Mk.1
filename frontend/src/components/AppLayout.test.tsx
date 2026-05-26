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

function mockDesktopNavRect(container: HTMLElement, initialTop: number, height = 48) {
  const navWrap = container.querySelector('.app-header-nav-wrap');
  if (!(navWrap instanceof HTMLElement)) {
    throw new Error('Expected desktop nav wrapper to be rendered.');
  }

  let currentTop = initialTop;

  vi.spyOn(navWrap, 'getBoundingClientRect').mockImplementation(() => ({
    x: 0,
    y: currentTop,
    top: currentTop,
    left: 0,
    right: 320,
    bottom: currentTop + height,
    width: 320,
    height,
    toJSON: () => ({})
  }));

  return {
    setTop(nextTop: number) {
      currentTop = nextTop;
    }
  };
}

function mockHeaderRect(container: HTMLElement, height = 144) {
  const header = container.querySelector('.app-header');
  if (!(header instanceof HTMLElement)) {
    throw new Error('Expected header to render.');
  }

  vi.spyOn(header, 'getBoundingClientRect').mockImplementation(() => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 640,
    bottom: height,
    width: 640,
    height,
    toJSON: () => ({})
  }));
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

    expect(within(headerCorner).getByText('Warehouse: Ridgeland MS1')).toBeTruthy();
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
        pendingAccessRequests: false
      })
    );

    const view = renderLayout('/');

    expect(screen.queryByRole('link', { name: 'Film Orders (needs ordering)' })).toBeNull();

    hasFilmOrdersNeedingAttention = true;
    view.rerender(buildLayoutTree('/'));

    expect(screen.getByRole('link', { name: 'Film Orders (needs ordering)' })).toBeTruthy();
  });

  it('renders the desktop header expanded by default with the title row and nav', () => {
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
    expect(within(topline).getByRole('heading', { name: 'Window Film Inventory' })).toBeTruthy();
    expect(within(topline).getByRole('button', { name: 'Share' })).toBeTruthy();
    expect(within(navWrap).getByRole('navigation', { name: 'Primary' })).toBeTruthy();
  });

  it('enters compact mode when the desktop nav reaches the sticky offset near the top of the viewport', () => {
    const view = renderLayout('/');
    const header = view.container.querySelector('.app-header');
    if (!(header instanceof HTMLElement)) {
      throw new Error('Expected header to render.');
    }

    const navRect = mockDesktopNavRect(view.container, 72);
    mockHeaderRect(view.container);
    fireEvent(window, new Event('resize'));
    expect(header.classList.contains('app-header-compact')).toBe(false);

    navRect.setTop(12);
    window.scrollY = 128;
    fireEvent.scroll(window);

    expect(header.classList.contains('app-header-pinned')).toBe(true);
    expect(header.classList.contains('app-header-compact')).toBe(true);
  });

  it('pins the desktop header when the nav reaches the sticky offset before compacting', () => {
    const view = renderLayout('/');
    const header = view.container.querySelector('.app-header');
    if (!(header instanceof HTMLElement)) {
      throw new Error('Expected header to render.');
    }

    const navRect = mockDesktopNavRect(view.container, 12);
    mockHeaderRect(view.container);
    fireEvent(window, new Event('resize'));

    navRect.setTop(12);
    window.scrollY = 96;
    fireEvent.scroll(window);

    expect(header.classList.contains('app-header-pinned')).toBe(true);
    expect(header.classList.contains('app-header-compact')).toBe(false);

    window.scrollY = 128;
    fireEvent.scroll(window);

    expect(header.classList.contains('app-header-pinned')).toBe(true);
    expect(header.classList.contains('app-header-compact')).toBe(true);
  });

  it('keeps the desktop header compact until the page scrolls all the way back to the top', () => {
    const view = renderLayout('/');
    const header = view.container.querySelector('.app-header');
    if (!(header instanceof HTMLElement)) {
      throw new Error('Expected header to render.');
    }

    const navRect = mockDesktopNavRect(view.container, 72);
    mockHeaderRect(view.container);
    fireEvent(window, new Event('resize'));

    navRect.setTop(0);
    window.scrollY = 128;
    fireEvent.scroll(window);
    expect(header.classList.contains('app-header-pinned')).toBe(true);
    expect(header.classList.contains('app-header-compact')).toBe(true);

    navRect.setTop(28);
    window.scrollY = 32;
    fireEvent.scroll(window);
    expect(header.classList.contains('app-header-pinned')).toBe(true);
    expect(header.classList.contains('app-header-compact')).toBe(true);

    navRect.setTop(72);
    window.scrollY = 0;
    fireEvent.scroll(window);
    expect(header.classList.contains('app-header-pinned')).toBe(false);
    expect(header.classList.contains('app-header-compact')).toBe(false);
  });

  it('stays compact when the layout shift leaves the page just above the top threshold', () => {
    const view = renderLayout('/');
    const header = view.container.querySelector('.app-header');
    if (!(header instanceof HTMLElement)) {
      throw new Error('Expected header to render.');
    }

    const navRect = mockDesktopNavRect(view.container, 0);
    mockHeaderRect(view.container);
    fireEvent(window, new Event('resize'));

    window.scrollY = 128;
    fireEvent.scroll(window);
    expect(header.classList.contains('app-header-pinned')).toBe(true);
    expect(header.classList.contains('app-header-compact')).toBe(true);

    navRect.setTop(36);
    window.scrollY = 2;
    fireEvent.scroll(window);

    expect(header.classList.contains('app-header-pinned')).toBe(true);
    expect(header.classList.contains('app-header-compact')).toBe(true);
  });

  it('does not immediately re-enter compact mode after a layout shift returns the page to the top', () => {
    const view = renderLayout('/');
    const header = view.container.querySelector('.app-header');
    if (!(header instanceof HTMLElement)) {
      throw new Error('Expected header to render.');
    }

    const navRect = mockDesktopNavRect(view.container, 0);
    mockHeaderRect(view.container);
    fireEvent(window, new Event('resize'));

    window.scrollY = 128;
    fireEvent.scroll(window);
    expect(header.classList.contains('app-header-pinned')).toBe(true);
    expect(header.classList.contains('app-header-compact')).toBe(true);

    window.scrollY = 1;
    fireEvent.scroll(window);
    expect(header.classList.contains('app-header-pinned')).toBe(false);
    expect(header.classList.contains('app-header-compact')).toBe(false);

    navRect.setTop(12);
    fireEvent.scroll(window);

    expect(header.classList.contains('app-header-pinned')).toBe(false);
    expect(header.classList.contains('app-header-compact')).toBe(false);
  });

  it('does not enable the desktop compact state on phone layout', () => {
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
