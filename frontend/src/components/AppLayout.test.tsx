// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLayout } from './AppLayout';

const useAuthMock = vi.fn();
const useIsPhoneLayoutMock = vi.fn();
const useJobsListMock = vi.fn();
const useFilmOrdersMock = vi.fn();

vi.mock('../features/auth/AuthContext', () => ({
  useAuth: () => useAuthMock()
}));

vi.mock('../hooks/useIsPhoneLayout', () => ({
  useIsPhoneLayout: () => useIsPhoneLayoutMock()
}));

vi.mock('../features/inventory/hooks/useInventoryReadQueries', () => ({
  useJobsList: (...args: unknown[]) => useJobsListMock(...args),
  useFilmOrders: (...args: unknown[]) => useFilmOrdersMock(...args)
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

describe('AppLayout', () => {
  beforeEach(() => {
    useAuthMock.mockReturnValue(buildAuth());
    useIsPhoneLayoutMock.mockReturnValue(false);
    useJobsListMock.mockReturnValue(buildQueryState([]));
    useFilmOrdersMock.mockReturnValue(buildQueryState([]));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the Film Orders attention dot on desktop when an unresolved film order has an install date', () => {
    useFilmOrdersMock.mockReturnValue(
      buildQueryState([
        {
          status: 'FILM_ORDER',
          jobDate: '2026-04-13'
        }
      ])
    );

    renderLayout('/');

    expect(screen.getByRole('link', { name: 'Film Orders (install-dated film orders)' })).toBeTruthy();
  });

  it('shows the install-dated film-orders dot on mobile More and inside the sheet', () => {
    useIsPhoneLayoutMock.mockReturnValue(true);
    useFilmOrdersMock.mockReturnValue(
      buildQueryState([
        {
          status: 'FILM_ON_THE_WAY',
          jobDate: '2026-04-13'
        }
      ])
    );

    renderLayout('/');

    fireEvent.click(screen.getByRole('button', { name: 'More (install-dated film orders)' }));

    const dialog = screen.getByRole('dialog', { name: 'More' });
    expect(
      within(dialog).getByRole('button', { name: 'Film Orders (install-dated film orders)' })
    ).toBeTruthy();
  });

  it('does not show the film-orders attention dot for unresolved orders without an install date', () => {
    useFilmOrdersMock.mockReturnValue(
      buildQueryState([
        {
          status: 'FILM_ORDER',
          jobDate: ''
        }
      ])
    );

    renderLayout('/');

    expect(screen.queryByRole('link', { name: 'Film Orders (install-dated film orders)' })).toBeNull();
  });

  it('clears the desktop film-orders attention dot as soon as the last install date disappears', () => {
    let filmOrders = [{ status: 'FILM_ORDER', jobDate: '2026-04-13' }];
    useFilmOrdersMock.mockImplementation(() => buildQueryState(filmOrders));

    const view = renderLayout('/');

    expect(screen.getByRole('link', { name: 'Film Orders (install-dated film orders)' })).toBeTruthy();

    filmOrders = [{ status: 'FILM_ORDER', jobDate: '' }];
    view.rerender(buildLayoutTree('/'));

    expect(screen.queryByRole('link', { name: 'Film Orders (install-dated film orders)' })).toBeNull();
  });

  it('shows the desktop film-orders attention dot as soon as an unresolved order gains an install date', () => {
    let filmOrders = [{ status: 'FILM_ORDER', jobDate: '' }];
    useFilmOrdersMock.mockImplementation(() => buildQueryState(filmOrders));

    const view = renderLayout('/');

    expect(screen.queryByRole('link', { name: 'Film Orders (install-dated film orders)' })).toBeNull();

    filmOrders = [{ status: 'FILM_ORDER', jobDate: '2026-04-13' }];
    view.rerender(buildLayoutTree('/'));

    expect(screen.getByRole('link', { name: 'Film Orders (install-dated film orders)' })).toBeTruthy();
  });
});
