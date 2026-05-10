// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLayout } from './AppLayout';
import { ToastProvider } from './Toast';

const useAuthMock = vi.fn();
const useIsPhoneLayoutMock = vi.fn();
const useAppAttentionSummaryMock = vi.fn();

vi.mock('../features/auth/AuthContext', () => ({
  useAuth: () => useAuthMock()
}));

vi.mock('../hooks/useIsPhoneLayout', () => ({
  useIsPhoneLayout: () => useIsPhoneLayoutMock()
}));

vi.mock('../features/inventory/hooks/useInventoryQueries', () => ({
  useAppAttentionSummary: (...args: unknown[]) => useAppAttentionSummaryMock(...args)
}));

vi.mock('../features/auth/AccountControl', () => ({
  AccountMenuTrigger: () => <button type="button">Account</button>
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
      pendingCount: 0
    },
    canAccessAdminConsole: true,
    hasFeatureAccess: (feature: string, mode: 'read' | 'write' = 'read') =>
      permissions[feature]?.[mode] ?? false,
    isOwner: true,
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

function buildLayoutTree(pathname: string) {
  return (
    <ToastProvider>
      <MemoryRouter initialEntries={[pathname]}>
        <Routes>
          <Route path="/" element={<AppLayout />}>
            <Route index element={<div>Inventory page</div>} />
            <Route path="*" element={<div>Nested page</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

function renderLayout(pathname = '/') {
  return render(buildLayoutTree(pathname));
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

describe('AppLayout', () => {
  beforeEach(() => {
    useAuthMock.mockReturnValue(buildAuth());
    useIsPhoneLayoutMock.mockReturnValue(false);
    useAppAttentionSummaryMock.mockReturnValue(
      buildQueryState({
        hasJobsNeedingAllocation: false,
        hasFilmOrdersNeedingAttention: false,
        pendingAccessRequests: false
      })
    );
    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      writable: true,
      value: 0
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
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
    fireEvent(window, new Event('resize'));
    expect(header.classList.contains('app-header-compact')).toBe(false);

    navRect.setTop(12);
    window.scrollY = 96;
    fireEvent.scroll(window);

    expect(header.classList.contains('app-header-compact')).toBe(true);
  });

  it('keeps the desktop header compact until the page scrolls all the way back to the top', () => {
    const view = renderLayout('/');
    const header = view.container.querySelector('.app-header');
    if (!(header instanceof HTMLElement)) {
      throw new Error('Expected header to render.');
    }

    const navRect = mockDesktopNavRect(view.container, 72);
    fireEvent(window, new Event('resize'));

    navRect.setTop(0);
    window.scrollY = 96;
    fireEvent.scroll(window);
    expect(header.classList.contains('app-header-compact')).toBe(true);

    navRect.setTop(28);
    window.scrollY = 32;
    fireEvent.scroll(window);
    expect(header.classList.contains('app-header-compact')).toBe(true);

    navRect.setTop(72);
    window.scrollY = 0;
    fireEvent.scroll(window);
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
    expect(header.classList.contains('app-header-compact')).toBe(false);
    expect(view.container.querySelector('.app-header-nav-wrap')).toBeNull();
  });
});
