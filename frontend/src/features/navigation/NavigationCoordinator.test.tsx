// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react';
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate
} from 'react-router-dom';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireManualScrollRestoration,
  getManualScrollRestorationOwnerCount,
  ManagedDetailLink,
  NavigationCoordinatorProvider,
  useManagedListScroll,
  useNavigationCoordinator,
  useSafeListBack
} from './NavigationCoordinator';
import {
  clearNavigationSessionRecords,
  createAnchorToken,
  createDetailNavigationState,
  getNavigationScope,
  getPendingListPosition,
  LIST_ROUTE_KINDS,
  markListReturnPending,
  saveListPosition
} from './navigationSession';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    session: { user: { sub: 'test-user' } },
    accessContext: { orgId: 'test-org' }
  })
}));

let latestLocation = {
  pathname: '',
  search: '',
  key: ''
};

function LocationCapture() {
  const location = useLocation();
  latestLocation = {
    pathname: location.pathname,
    search: location.search,
    key: location.key
  };
  return null;
}

function InventoryListLink({ target }: { target?: string }) {
  return (
    <>
      <LocationCapture />
      <ManagedDetailLink
        to="/inventory/box-one"
        target={target}
        originKind={LIST_ROUTE_KINDS.INVENTORY}
        anchorIdentity="box-one"
      >
        Open box
      </ManagedDetailLink>
    </>
  );
}

function InventoryDetailBack() {
  const goBack = useSafeListBack(LIST_ROUTE_KINDS.INVENTORY, '/');
  return (
    <>
      <LocationCapture />
      <button type="button" onClick={goBack}>
        Back
      </button>
    </>
  );
}

type RouterEntry =
  | string
  | {
      pathname: string;
      search?: string;
      key?: string;
      state?: unknown;
    };

function renderNavigation(entries: RouterEntry[], initialIndex = entries.length - 1) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={initialIndex}>
      <NavigationCoordinatorProvider>
        <Routes>
          <Route path="/" element={<InventoryListLink />} />
          <Route path="/inventory/:boxId" element={<InventoryDetailBack />} />
        </Routes>
      </NavigationCoordinatorProvider>
    </MemoryRouter>
  );
}

describe('NavigationCoordinator', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    clearNavigationSessionRecords();
    latestLocation = { pathname: '', search: '', key: '' };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reference-counts manual browser scroll restoration ownership', () => {
    Object.defineProperty(window.history, 'scrollRestoration', {
      configurable: true,
      writable: true,
      value: 'auto'
    });

    const releaseFirst = acquireManualScrollRestoration();
    const releaseSecond = acquireManualScrollRestoration();

    expect(getManualScrollRestorationOwnerCount()).toBe(2);
    expect(window.history.scrollRestoration).toBe('manual');

    releaseFirst();
    expect(getManualScrollRestorationOwnerCount()).toBe(1);
    expect(window.history.scrollRestoration).toBe('manual');

    releaseSecond();
    expect(getManualScrollRestorationOwnerCount()).toBe(0);
    expect(window.history.scrollRestoration).toBe('auto');
  });

  it('restores the pre-adoption mode after a participating-page reload', async () => {
    Object.defineProperty(window.history, 'scrollRestoration', {
      configurable: true,
      writable: true,
      value: 'auto'
    });

    const releasePreviousRealm = acquireManualScrollRestoration();
    expect(window.history.scrollRestoration).toBe('manual');

    vi.resetModules();
    const reloadedCoordinator = await import('./NavigationCoordinator');
    const releaseReloadedRealm = reloadedCoordinator.acquireManualScrollRestoration();

    expect(window.history.scrollRestoration).toBe('manual');
    releaseReloadedRealm();
    expect(window.history.scrollRestoration).toBe('auto');

    releasePreviousRealm();
  });

  it('keeps one manual-restoration owner across participating route transitions', async () => {
    Object.defineProperty(window.history, 'scrollRestoration', {
      configurable: true,
      writable: true,
      value: 'auto'
    });

    const view = renderNavigation(['/']);
    expect(getManualScrollRestorationOwnerCount()).toBe(1);
    expect(window.history.scrollRestoration).toBe('manual');

    fireEvent.click(screen.getByRole('link', { name: 'Open box' }));
    await waitFor(() => expect(latestLocation.pathname).toBe('/inventory/box-one'));
    expect(getManualScrollRestorationOwnerCount()).toBe(1);
    expect(window.history.scrollRestoration).toBe('manual');

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(latestLocation.pathname).toBe('/'));
    expect(getManualScrollRestorationOwnerCount()).toBe(1);

    view.unmount();
    expect(getManualScrollRestorationOwnerCount()).toBe(0);
    expect(window.history.scrollRestoration).toBe('auto');
  });

  it('uses validated history provenance for Back and preserves the list query', async () => {
    renderNavigation(['/?warehouse=MS1&q=active']);

    fireEvent.click(screen.getByRole('link', { name: 'Open box' }));
    await waitFor(() => expect(latestLocation.pathname).toBe('/inventory/box-one'));

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => {
      expect(latestLocation.pathname).toBe('/');
      expect(latestLocation.search).toBe('?warehouse=MS1&q=active');
    });
  });

  it('falls back by replacement when detail provenance is unavailable', async () => {
    renderNavigation(['/inventory/box-one']);

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(latestLocation.pathname).toBe('/'));
  });

  it('accepts valid provenance after a detail refresh when the origin history entry remains', async () => {
    const scope = getNavigationScope('test-user', 'test-org');
    saveListPosition(scope, LIST_ROUTE_KINDS.INVENTORY, 'origin-key', {
      scrollY: 0,
      anchorToken: '',
      anchorOffset: 0
    });
    markListReturnPending(scope, LIST_ROUTE_KINDS.INVENTORY, 'origin-key');
    const detailState = createDetailNavigationState(
      scope,
      LIST_ROUTE_KINDS.INVENTORY,
      'origin-key'
    );

    renderNavigation([
      { pathname: '/', search: '?q=preserved', key: 'origin-key' },
      {
        pathname: '/inventory/box-one',
        key: 'detail-key',
        state: detailState
      }
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => {
      expect(latestLocation.pathname).toBe('/');
      expect(latestLocation.search).toBe('?q=preserved');
    });
  });

  it('does not adopt modified, middle, or new-tab clicks as same-tab restoration intent', () => {
    const preventDocumentNavigation = (event: MouseEvent) => event.preventDefault();
    document.addEventListener('click', preventDocumentNavigation);
    const { unmount } = renderNavigation([
      { pathname: '/', key: 'modified-origin' }
    ]);
    const scope = getNavigationScope('test-user', 'test-org');
    const link = screen.getByRole('link', { name: 'Open box' });

    fireEvent.click(link, {
      button: 0,
      ctrlKey: true
    });
    fireEvent.click(link, {
      button: 0,
      metaKey: true
    });
    fireEvent.click(link, {
      button: 0,
      shiftKey: true
    });
    fireEvent.click(link, {
      button: 1
    });
    expect(
      getPendingListPosition(
        scope,
        LIST_ROUTE_KINDS.INVENTORY,
        'modified-origin'
      )
    ).toBeNull();
    unmount();

    render(
      <MemoryRouter initialEntries={[{ pathname: '/', key: 'new-tab-origin' }]}>
        <NavigationCoordinatorProvider>
          <InventoryListLink target="_blank" />
        </NavigationCoordinatorProvider>
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('link', { name: 'Open box' }), {
      button: 0
    });
    expect(
      getPendingListPosition(
        scope,
        LIST_ROUTE_KINDS.INVENTORY,
        'new-tab-origin'
      )
    ).toBeNull();
    document.removeEventListener('click', preventDocumentNavigation);
  });

  it('clears active and inactive Jobs restoration state for MAIN_DEFAULT', () => {
    const scope = getNavigationScope('test-user', 'test-org');
    saveListPosition(scope, LIST_ROUTE_KINDS.JOBS_LIST, 'jobs-list-key', {
      scrollY: 120,
      anchorToken: '',
      anchorOffset: 0
    });
    saveListPosition(scope, LIST_ROUTE_KINDS.JOBS_CALENDAR, 'jobs-calendar-key', {
      scrollY: 640,
      anchorToken: '',
      anchorOffset: 0
    });
    markListReturnPending(scope, LIST_ROUTE_KINDS.JOBS_LIST, 'jobs-list-key');
    markListReturnPending(scope, LIST_ROUTE_KINDS.JOBS_CALENDAR, 'jobs-calendar-key');
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);

    function MainDefaultReset() {
      const coordinator = useNavigationCoordinator();
      return (
        <button
          type="button"
          onClick={() =>
            coordinator?.requestMainDefaultReset(LIST_ROUTE_KINDS.JOBS_LIST)
          }
        >
          Reset Jobs
        </button>
      );
    }

    render(
      <MemoryRouter>
        <NavigationCoordinatorProvider>
          <MainDefaultReset />
        </NavigationCoordinatorProvider>
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reset Jobs' }));

    expect(
      getPendingListPosition(scope, LIST_ROUTE_KINDS.JOBS_LIST, 'jobs-list-key')
    ).toBeNull();
    expect(
      getPendingListPosition(
        scope,
        LIST_ROUTE_KINDS.JOBS_CALENDAR,
        'jobs-calendar-key'
      )
    ).toBeNull();
  });

  it('waits for explicit readiness beyond twelve frames before restoring and makes no request', async () => {
    const scope = getNavigationScope('test-user', 'test-org');
    const anchorToken = createAnchorToken(scope, 'box-one');
    saveListPosition(scope, LIST_ROUTE_KINDS.INVENTORY, 'delayed-origin', {
      scrollY: 300,
      anchorToken,
      anchorOffset: 20
    });
    markListReturnPending(scope, LIST_ROUTE_KINDS.INVENTORY, 'delayed-origin');

    const queuedFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      queuedFrames.push(callback);
      return queuedFrames.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const requestSpy = vi.fn();
    vi.stubGlobal('fetch', requestSpy);
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      configurable: true,
      value: 2_000
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 500
    });
    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      value: 0
    });

    function DelayedList() {
      const [ready, setReady] = useState(false);
      const scroll = useManagedListScroll({
        kind: LIST_ROUTE_KINDS.INVENTORY,
        routeParsed: true,
        authorizationResolved: true,
        dataReady: ready,
        layoutReady: ready,
        expectedAnchorCount: 1
      });

      return (
        <>
          <button type="button" onClick={() => setReady(true)}>
            Mark ready
          </button>
          <div
            ref={scroll.getAnchorRef('box-one')}
            style={{ height: 20 }}
          >
            Box row
          </div>
        </>
      );
    }

    function Detail() {
      const navigate = useNavigate();
      return (
        <button type="button" onClick={() => navigate(-1)}>
          Browser back
        </button>
      );
    }

    render(
      <MemoryRouter
        initialEntries={[
          { pathname: '/', key: 'delayed-origin' },
          { pathname: '/inventory/box-one', key: 'delayed-detail' }
        ]}
        initialIndex={1}
      >
        <NavigationCoordinatorProvider>
          <Routes>
            <Route path="/" element={<DelayedList />} />
            <Route path="/inventory/:boxId" element={<Detail />} />
          </Routes>
        </NavigationCoordinatorProvider>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Browser back' }));
    await screen.findByRole('button', { name: 'Mark ready' });

    for (let index = 0; index < 20; index += 1) {
      const callback = queuedFrames.shift();
      if (callback) {
        act(() => callback(index));
      }
    }
    expect(scrollToSpy).not.toHaveBeenCalled();

    const row = screen.getByText('Box row');
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 100,
      top: 100,
      right: 100,
      bottom: 120,
      left: 0,
      width: 100,
      height: 20,
      toJSON: () => ({})
    });
    fireEvent.click(screen.getByRole('button', { name: 'Mark ready' }));

    await act(async () => {
      while (queuedFrames.length) {
        queuedFrames.shift()?.(21);
      }
    });

    expect(scrollToSpy).toHaveBeenCalledWith({
      top: 80,
      left: 0,
      behavior: 'auto'
    });
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('does not overwrite a pending return record when the list unmounts', () => {
    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      value: 0
    });

    function CapturedList() {
      const scroll = useManagedListScroll({
        kind: LIST_ROUTE_KINDS.INVENTORY,
        routeParsed: true,
        authorizationResolved: true,
        dataReady: true,
        layoutReady: true,
        expectedAnchorCount: 1
      });

      return (
        <>
          <LocationCapture />
          <div ref={scroll.getAnchorRef('box-one')}>Box row</div>
        </>
      );
    }

    const view = render(
      <MemoryRouter initialEntries={[{ pathname: '/', key: 'pending-origin' }]}>
        <NavigationCoordinatorProvider>
          <CapturedList />
        </NavigationCoordinatorProvider>
      </MemoryRouter>
    );
    const scope = getNavigationScope('test-user', 'test-org');
    const anchorToken = createAnchorToken(scope, 'box-one');
    saveListPosition(scope, LIST_ROUTE_KINDS.INVENTORY, latestLocation.key, {
      scrollY: 420,
      anchorToken,
      anchorOffset: 18
    });
    markListReturnPending(scope, LIST_ROUTE_KINDS.INVENTORY, latestLocation.key);

    view.unmount();

    expect(
      getPendingListPosition(
        scope,
        LIST_ROUTE_KINDS.INVENTORY,
        latestLocation.key
      )
    ).toMatchObject({
      scrollY: 420,
      anchorToken,
      anchorOffset: 18,
      returnPending: true
    });
  });

  it('ignores duplicate registration of the same anchor node through a composed ref', async () => {
    function ComposedAnchorList() {
      const scroll = useManagedListScroll({
        kind: LIST_ROUTE_KINDS.INVENTORY,
        routeParsed: true,
        authorizationResolved: true,
        dataReady: true,
        layoutReady: true,
        expectedAnchorCount: 1
      });
      const navigationRef = scroll.getAnchorRef('box-one');

      return (
        <div ref={(node) => navigationRef(node)}>
          Stable box row
        </div>
      );
    }

    render(
      <MemoryRouter>
        <NavigationCoordinatorProvider>
          <ComposedAnchorList />
        </NavigationCoordinatorProvider>
      </MemoryRouter>
    );

    expect(await screen.findByText('Stable box row')).toBeTruthy();
  });
});
