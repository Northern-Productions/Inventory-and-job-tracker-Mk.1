// @vitest-environment jsdom

import type { PropsWithChildren, Ref } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Box } from '../../../domain';
import InventoryHomePage from './InventoryHomePage';

const mocks = vi.hoisted(() => ({
  isPhoneLayout: true,
  mobileCardRenders: 0,
  snapshotBoxes: [] as Box[],
  useOfflineInventorySearch: vi.fn()
}));

vi.mock('../../../hooks/useIsPhoneLayout', () => ({
  useIsPhoneLayout: () => mocks.isPhoneLayout
}));

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    isOwner: false
  })
}));

vi.mock('../../../components/MobileRecordCard', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../components/MobileRecordCard')>();

  return {
    ...actual,
    MobileRecordCard: ({
      children,
      recordRef
    }: PropsWithChildren<{ recordRef?: Ref<HTMLElement> }>) => {
      mocks.mobileCardRenders += 1;
      return (
        <article ref={recordRef} className="mobile-record-card">
          {children}
        </article>
      );
    }
  };
});

vi.mock('../hooks/useDefaultWarehouse', () => ({
  useDefaultWarehouse: () => 'IL1'
}));

vi.mock('../hooks/useWarehouseRegistry', () => ({
  useWarehouseRegistry: () => ({
    entries: [{ code: 'IL1', name: 'Wauconda IL1', boxIdPrefix: 'IL1' }],
    isSuccess: true,
    scopeReady: true
  })
}));

vi.mock('../hooks/useOfflineInventorySearch', () => ({
  useOfflineInventorySearch: (...args: unknown[]) =>
    mocks.useOfflineInventorySearch(...args)
}));

vi.mock('../hooks/useInventoryQueries', () => ({
  useFilmCatalog: () => ({ data: [] })
}));

vi.mock('../../caulk/components/CaulkInventoryContent', () => ({
  CaulkInventoryContent: () => <div>Caulk inventory</div>
}));

vi.mock('../../navigation/NavigationCoordinator', () => ({
  ManagedDetailLink: ({
    children,
    to,
    className
  }: PropsWithChildren<{ to: string; className?: string }>) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useManagedListScroll: () => ({
    getAnchorRef: undefined,
    isRestoring: false
  })
}));

function buildBox(index: number, overrides: Partial<Box> = {}): Box {
  return {
    boxId: `IL1-${String(1000 + index)}`,
    warehouse: 'IL1',
    dealer: 'Dealer',
    manufacturer: index % 2 === 0 ? '3M Solar' : 'SOLYX',
    filmName: index % 2 === 0 ? 'Prestige 60' : 'Frosted Film',
    widthIn: index % 2 === 0 ? 60 : 48,
    initialFeet: 100,
    feetAvailable: 75,
    allocationPlanningFeet: 75,
    lotRun: '',
    status: index % 2 === 0 ? 'IN_STOCK' : 'CHECKED_OUT',
    orderDate: '2026-04-01',
    receivedDate: '2026-04-02',
    initialWeightLbs: null,
    lastRollWeightLbs: null,
    lastWeighedDate: '2026-04-03',
    filmKey: '',
    coreType: '',
    coreWeightLbs: null,
    lfWeightLbsPerFt: null,
    pricePerLf: null,
    purchaseCost: null,
    notes: '',
    hasEverBeenCheckedOut: false,
    lastCheckoutJob: '',
    lastCheckoutDate: '',
    zeroedDate: '',
    zeroedReason: '',
    zeroedBy: '',
    ...overrides
  };
}

function renderPage(initialEntry = '/') {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false }
    }
  });
  const router = createMemoryRouter(
    [{ path: '/', element: <InventoryHomePage /> }],
    { initialEntries: [initialEntry] }
  );
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );

  return { ...rendered, queryClient, router };
}

async function expectMobileCardCount(count: number) {
  await waitFor(() => {
    expect(document.querySelectorAll('.mobile-record-card')).toHaveLength(count);
  });
}

describe('InventoryHomePage search performance behavior', () => {
  beforeEach(() => {
    mocks.isPhoneLayout = true;
    mocks.mobileCardRenders = 0;
    mocks.snapshotBoxes = Array.from({ length: 100 }, (_, index) => buildBox(index));
    mocks.useOfflineInventorySearch.mockReset();
    mocks.useOfflineInventorySearch.mockImplementation(() => ({
      snapshotBoxes: mocks.snapshotBoxes,
      isError: false,
      error: null,
      isLoading: false,
      isOffline: false,
      isSyncing: false,
      syncError: null,
      hasSnapshot: true,
      lastSyncedAt: '2026-07-28T12:00:00.000Z',
      refetch: vi.fn()
    }));
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps rapid URL-backed typing responsive without rebuilding retained mobile cards', async () => {
    const { router } = renderPage();
    await expectMobileCardCount(100);
    const input = screen.getByLabelText('Search') as HTMLInputElement;
    const originalInput = input;
    mocks.mobileCardRenders = 0;

    fireEvent.change(input, { target: { value: 'I' } });
    fireEvent.change(input, { target: { value: 'IL' } });
    fireEvent.change(input, { target: { value: 'IL1' } });
    fireEvent.change(input, { target: { value: 'IL1-1099' } });

    expect(input.value).toBe('IL1-1099');
    expect(document.querySelectorAll('.mobile-record-card')).toHaveLength(100);
    await expectMobileCardCount(1);
    expect(new URLSearchParams(router.state.location.search).get('q')).toBe('IL1-1099');
    expect(router.state.historyAction).toBe('REPLACE');
    expect(screen.getByLabelText('Search')).toBe(originalInput);
    expect(mocks.mobileCardRenders).toBe(0);
    expect(mocks.useOfflineInventorySearch).toHaveBeenLastCalledWith('IL1', {
      enabled: true
    });
  });

  it('supports paste, clear, cached return, and active filters without changing search data loading', async () => {
    const { router } = renderPage();
    await expectMobileCardCount(100);
    const input = screen.getByLabelText('Search') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'IL1-1098' } });
    expect(document.querySelectorAll('.mobile-record-card')).toHaveLength(100);
    await expectMobileCardCount(1);
    expect(screen.getByRole('link', { name: 'IL1-1098' })).toBeTruthy();

    fireEvent.change(input, { target: { value: '' } });
    await expectMobileCardCount(100);

    fireEvent.change(screen.getByLabelText('Status'), {
      target: { value: 'IN_STOCK' }
    });
    await expectMobileCardCount(50);

    mocks.mobileCardRenders = 0;
    fireEvent.change(input, { target: { value: 'IL1-1098' } });
    await expectMobileCardCount(1);
    expect(mocks.mobileCardRenders).toBe(0);
    expect(new URLSearchParams(router.state.location.search).get('status')).toBe(
      'IN_STOCK'
    );
    expect(
      mocks.useOfflineInventorySearch.mock.calls.every(
        ([warehouse, options]) =>
          warehouse === 'IL1' &&
          (options as { enabled?: boolean } | undefined)?.enabled === true
      )
    ).toBe(true);
  });

  it('restores a persisted search after refresh and keeps the desktop table contract', async () => {
    mocks.isPhoneLayout = false;
    const { router, unmount } = renderPage('/?q=IL1-1098');

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'IL1-1098' })).toBeTruthy();
    });
    expect(screen.getAllByRole('columnheader')).toHaveLength(9);
    expect((screen.getByLabelText('Search') as HTMLInputElement).value).toBe(
      'IL1-1098'
    );

    const persistedLocation = `${router.state.location.pathname}${router.state.location.search}`;
    unmount();
    renderPage(persistedLocation);

    await waitFor(() => {
      expect((screen.getByLabelText('Search') as HTMLInputElement).value).toBe(
        'IL1-1098'
      );
    });
    expect(screen.getByRole('link', { name: 'IL1-1098' })).toBeTruthy();
    expect(document.querySelector('.mobile-record-card')).toBeNull();
  });
});
