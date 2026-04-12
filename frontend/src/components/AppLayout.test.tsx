// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLayout } from './AppLayout';

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
    <MemoryRouter initialEntries={[pathname]}>
      <Routes>
        <Route path="/" element={<AppLayout />}>
          <Route index element={<div>Inventory page</div>} />
          <Route path="*" element={<div>Nested page</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

function renderLayout(pathname = '/') {
  return render(buildLayoutTree(pathname));
}

function mockDesktopToplineHeight(container: HTMLElement, height: number) {
  const topline = container.querySelector('.app-header-topline');
  if (!(topline instanceof HTMLElement)) {
    throw new Error('Expected desktop topline to be rendered.');
  }

  Object.defineProperty(topline, 'scrollHeight', {
    configurable: true,
    value: height
  });

  return vi.spyOn(topline, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: height,
    width: 0,
    height,
    toJSON: () => ({})
  });
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

  it('enters compact sticky mode after scrolling past the desktop topline', () => {
    const view = renderLayout('/');
    const header = view.container.querySelector('.app-header');
    if (!(header instanceof HTMLElement)) {
      throw new Error('Expected header to render.');
    }

    mockDesktopToplineHeight(view.container, 72);

    fireEvent(window, new Event('resize'));
    expect(header.classList.contains('app-header-compact')).toBe(false);

    window.scrollY = 80;
    fireEvent.scroll(window);

    expect(header.classList.contains('app-header-compact')).toBe(true);
  });

  it('expands the desktop header again when scrolled back to the top', () => {
    const view = renderLayout('/');
    const header = view.container.querySelector('.app-header');
    if (!(header instanceof HTMLElement)) {
      throw new Error('Expected header to render.');
    }

    mockDesktopToplineHeight(view.container, 72);

    fireEvent(window, new Event('resize'));
    window.scrollY = 84;
    fireEvent.scroll(window);
    expect(header.classList.contains('app-header-compact')).toBe(true);

    window.scrollY = 0;
    fireEvent.scroll(window);

    expect(header.classList.contains('app-header-compact')).toBe(false);
  });

  it('does not enable the desktop sticky compact state on phone layout', () => {
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
  });
});
