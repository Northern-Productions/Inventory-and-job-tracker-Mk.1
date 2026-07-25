import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PropsWithChildren,
  type ReactNode,
  type RefCallback
} from 'react';
import {
  Link,
  useLocation,
  useNavigate,
  useNavigationType,
  type LinkProps
} from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import {
  clearNavigationSessionRecords,
  completeListReturn,
  createAnchorToken,
  createDetailNavigationState,
  getNavigationScope,
  getPendingListPosition,
  hasValidDetailNavigationState,
  LIST_ROUTE_KINDS,
  markListReturnPending,
  saveListPosition,
  type ListPositionRecord,
  type ListRouteKind,
  type NavigationScope
} from './navigationSession';

interface ListController {
  capture: () => void;
}

interface NavigationCoordinatorValue {
  scope: NavigationScope | null;
  previousPathname: string;
  resetEpoch: number;
  getDetailState: (kind: ListRouteKind, locationKey: string) => unknown;
  prepareDetailNavigation: (kind: ListRouteKind, locationKey: string) => void;
  registerListController: (
    kind: ListRouteKind,
    locationKey: string,
    controller: ListController
  ) => () => void;
  requestMainDefaultReset: (kind: ListRouteKind) => void;
}

const NavigationCoordinatorContext = createContext<NavigationCoordinatorValue | null>(null);

const SCROLL_RESTORATION_OWNERSHIP_KEY = 'window-film:scroll-restoration-ownership:v1';
let manualScrollRestorationOwners = 0;
let priorScrollRestoration: ScrollRestoration = 'auto';

function readRetainedScrollRestoration(): ScrollRestoration | null {
  try {
    const retained = window.sessionStorage.getItem(SCROLL_RESTORATION_OWNERSHIP_KEY);
    return retained === 'auto' || retained === 'manual' ? retained : null;
  } catch {
    return null;
  }
}

function retainScrollRestoration(value: ScrollRestoration) {
  try {
    window.sessionStorage.setItem(SCROLL_RESTORATION_OWNERSHIP_KEY, value);
  } catch {
    // The in-memory owner still restores the prior mode when storage is unavailable.
  }
}

function clearRetainedScrollRestoration() {
  try {
    window.sessionStorage.removeItem(SCROLL_RESTORATION_OWNERSHIP_KEY);
  } catch {
    // Nothing else is required when storage is unavailable.
  }
}

export function acquireManualScrollRestoration() {
  if (typeof window === 'undefined' || !window.history) {
    return () => undefined;
  }

  if (manualScrollRestorationOwners === 0) {
    priorScrollRestoration =
      readRetainedScrollRestoration() || window.history.scrollRestoration;
    retainScrollRestoration(priorScrollRestoration);
    window.history.scrollRestoration = 'manual';
  }
  manualScrollRestorationOwners += 1;
  let released = false;

  return () => {
    if (released) {
      return;
    }
    released = true;
    manualScrollRestorationOwners = Math.max(0, manualScrollRestorationOwners - 1);
    if (manualScrollRestorationOwners === 0) {
      window.history.scrollRestoration = priorScrollRestoration;
      clearRetainedScrollRestoration();
    }
  };
}

export function getManualScrollRestorationOwnerCount() {
  return manualScrollRestorationOwners;
}

function isParticipatingPath(pathname: string) {
  return (
    pathname === '/' ||
    pathname === '/allocations' ||
    pathname.startsWith('/inventory/') ||
    pathname.startsWith('/allocations/')
  );
}

function isDetailPathForKind(pathname: string, kind: ListRouteKind) {
  if (kind === LIST_ROUTE_KINDS.INVENTORY) {
    return pathname.startsWith('/inventory/') && pathname !== '/inventory/add' && pathname !== '/inventory/scan';
  }

  return pathname.startsWith('/allocations/');
}

export function isUnmodifiedPrimaryClick(
  event: Pick<
    ReactMouseEvent<HTMLElement>,
    | 'button'
    | 'ctrlKey'
    | 'metaKey'
    | 'shiftKey'
    | 'altKey'
    | 'defaultPrevented'
    | 'currentTarget'
  >
) {
  const target = event.currentTarget.getAttribute('target');
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.altKey &&
    (!target || target === '_self')
  );
}

export function NavigationCoordinatorProvider({ children }: PropsWithChildren) {
  const auth = useAuth();
  const location = useLocation();
  const previousPathnameRef = useRef('');
  const controllersRef = useRef(new Map<string, ListController>());
  const [resetEpoch, setResetEpoch] = useState(0);
  const scope = useMemo(
    () =>
      getNavigationScope(
        auth.session?.user?.sub,
        auth.accessContext?.orgId
      ),
    [auth.accessContext?.orgId, auth.session?.user?.sub]
  );
  const previousPathname = previousPathnameRef.current;

  useEffect(() => {
    if (!isParticipatingPath(location.pathname)) {
      return undefined;
    }
    return acquireManualScrollRestoration();
  }, [isParticipatingPath(location.pathname)]);

  useLayoutEffect(() => {
    previousPathnameRef.current = location.pathname;
  }, [location.pathname]);

  const registerListController = useCallback(
    (
      kind: ListRouteKind,
      locationKey: string,
      controller: ListController
    ) => {
      const key = `${kind}:${locationKey}`;
      controllersRef.current.set(key, controller);
      return () => {
        if (controllersRef.current.get(key) === controller) {
          controllersRef.current.delete(key);
        }
      };
    },
    []
  );

  const prepareDetailNavigation = useCallback(
    (kind: ListRouteKind, locationKey: string) => {
      controllersRef.current.get(`${kind}:${locationKey}`)?.capture();
      markListReturnPending(scope, kind, locationKey);
    },
    [scope]
  );

  const getDetailState = useCallback(
    (kind: ListRouteKind, locationKey: string) =>
      createDetailNavigationState(scope, kind, locationKey),
    [scope]
  );

  const requestMainDefaultReset = useCallback((kind: ListRouteKind) => {
    if (kind === LIST_ROUTE_KINDS.JOBS_LIST || kind === LIST_ROUTE_KINDS.JOBS_CALENDAR) {
      clearNavigationSessionRecords(LIST_ROUTE_KINDS.JOBS_LIST);
      clearNavigationSessionRecords(LIST_ROUTE_KINDS.JOBS_CALENDAR);
    } else {
      clearNavigationSessionRecords(kind);
    }
    setResetEpoch((current) => current + 1);
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, []);

  const value = useMemo<NavigationCoordinatorValue>(
    () => ({
      scope,
      previousPathname,
      resetEpoch,
      getDetailState,
      prepareDetailNavigation,
      registerListController,
      requestMainDefaultReset
    }),
    [
      getDetailState,
      prepareDetailNavigation,
      previousPathname,
      registerListController,
      requestMainDefaultReset,
      resetEpoch,
      scope
    ]
  );

  return (
    <NavigationCoordinatorContext.Provider value={value}>
      {children}
    </NavigationCoordinatorContext.Provider>
  );
}

export function useNavigationCoordinator() {
  return useContext(NavigationCoordinatorContext);
}

interface ManagedDetailLinkProps extends Omit<LinkProps, 'state'> {
  originKind: ListRouteKind;
  anchorIdentity: string;
  children: ReactNode;
}

export const ManagedDetailLink = forwardRef<HTMLAnchorElement, ManagedDetailLinkProps>(
function ManagedDetailLink({
  originKind,
  anchorIdentity: _anchorIdentity,
  onClick,
  children,
  ...props
}, ref) {
  const coordinator = useNavigationCoordinator();
  const location = useLocation();
  const detailState = coordinator?.getDetailState(originKind, location.key);

  return (
    <Link
      {...props}
      ref={ref}
      state={detailState}
      onClick={(event) => {
        onClick?.(event);
        if (isUnmodifiedPrimaryClick(event)) {
          coordinator?.prepareDetailNavigation(originKind, location.key);
        }
      }}
    >
      {children}
    </Link>
  );
});

export function useSafeListBack(
  expectedKind: ListRouteKind | readonly ListRouteKind[],
  fallbackPath: string
) {
  const coordinator = useNavigationCoordinator();
  const location = useLocation();
  const navigate = useNavigate();
  const expectedKinds = Array.isArray(expectedKind) ? expectedKind : [expectedKind];
  const expectedKindsKey = expectedKinds.join('|');

  return useCallback(() => {
    const validKind = coordinator
      ? expectedKinds.find((kind) =>
          hasValidDetailNavigationState(location.state, coordinator.scope, kind)
        )
      : undefined;
    if (validKind) {
      navigate(-1);
      return;
    }

    expectedKinds.forEach((kind) => clearNavigationSessionRecords(kind));
    navigate(fallbackPath, { replace: true });
  }, [
    coordinator,
    expectedKindsKey,
    fallbackPath,
    location.state,
    navigate
  ]);
}

interface ManagedListScrollOptions {
  kind: ListRouteKind;
  routeParsed: boolean;
  authorizationResolved: boolean;
  dataReady: boolean;
  layoutReady: boolean;
  expectedAnchorCount: number;
}

function getDocumentScrollHeight() {
  if (typeof document === 'undefined') {
    return 0;
  }
  return Math.max(
    document.documentElement?.scrollHeight || 0,
    document.body?.scrollHeight || 0
  );
}

export function useManagedListScroll({
  kind,
  routeParsed,
  authorizationResolved,
  dataReady,
  layoutReady,
  expectedAnchorCount
}: ManagedListScrollOptions) {
  const coordinator = useNavigationCoordinator();
  const location = useLocation();
  const navigationType = useNavigationType();
  const anchorsRef = useRef(new Map<string, Set<HTMLElement>>());
  const callbacksRef = useRef(new Map<string, RefCallback<HTMLElement>>());
  const [anchorVersion, setAnchorVersion] = useState(0);
  const [restoreTarget, setRestoreTarget] = useState<ListPositionRecord | null>(null);
  const restoreCheckedRef = useRef(false);
  const restoringRef = useRef(false);

  useEffect(() => {
    if (!coordinator) {
      return;
    }
    anchorsRef.current.clear();
    callbacksRef.current.clear();
    restoreCheckedRef.current = false;
    setRestoreTarget(null);
  }, [coordinator, coordinator?.scope?.fingerprint, kind, location.key]);

  const getAnchorRef = useCallback(
    (identity: string): RefCallback<HTMLElement> => {
      const token = createAnchorToken(coordinator?.scope || null, identity);
      const existing = callbacksRef.current.get(token);
      if (existing) {
        return existing;
      }

      const callback: RefCallback<HTMLElement> = (node) => {
        if (node && token) {
          const nodes = anchorsRef.current.get(token) || new Set<HTMLElement>();
          const previousSize = nodes.size;
          nodes.add(node);
          anchorsRef.current.set(token, nodes);
          if (nodes.size !== previousSize) {
            setAnchorVersion((current) => current + 1);
          }
        }
      };
      callbacksRef.current.set(token, callback);
      return callback;
    },
    [coordinator?.scope]
  );

  const capture = useCallback(() => {
    if (!coordinator?.scope || restoringRef.current) {
      return;
    }
    if (getPendingListPosition(coordinator.scope, kind, location.key)) {
      return;
    }

    let nearestToken = '';
    let nearestOffset = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const [token, nodes] of anchorsRef.current) {
      for (const node of nodes) {
        if (!node.isConnected) {
          continue;
        }
        const rect = node.getBoundingClientRect();
        const distance = rect.bottom < 0 ? Math.abs(rect.bottom) + 1_000_000 : Math.abs(rect.top);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestToken = token;
          nearestOffset = rect.top;
        }
      }
    }

    saveListPosition(coordinator.scope, kind, location.key, {
      scrollY: window.scrollY,
      anchorToken: nearestToken,
      anchorOffset: nearestOffset
    });
  }, [coordinator?.scope, kind, location.key]);

  useEffect(() => {
    if (!coordinator) {
      return undefined;
    }
    return coordinator.registerListController(kind, location.key, { capture });
  }, [capture, coordinator, kind, location.key]);

  useEffect(() => {
    if (!coordinator) {
      return undefined;
    }
    let frame = 0;
    const handleScroll = () => {
      if (frame) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        capture();
      });
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', handleScroll);
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      capture();
    };
  }, [capture, coordinator]);

  useEffect(() => {
    if (
      restoreCheckedRef.current ||
      !coordinator?.scope ||
      navigationType !== 'POP' ||
      !isDetailPathForKind(coordinator.previousPathname, kind)
    ) {
      return;
    }

    restoreCheckedRef.current = true;
    const pending = getPendingListPosition(coordinator.scope, kind, location.key);
    if (pending) {
      restoringRef.current = true;
      setRestoreTarget(pending);
    }
  }, [
    coordinator,
    kind,
    location.key,
    navigationType
  ]);

  const registeredAnchorCount = anchorsRef.current.size;
  const anchorsRegistered =
    expectedAnchorCount === 0 || registeredAnchorCount >= expectedAnchorCount;
  const ready =
    routeParsed &&
    authorizationResolved &&
    dataReady &&
    layoutReady &&
    anchorsRegistered;

  useEffect(() => {
    if (!restoreTarget || !ready || !coordinator?.scope) {
      return undefined;
    }

    let cancelled = false;
    let frame = 0;
    let attempts = 0;
    const maxAttempts = 48;

    const finish = () => {
      completeListReturn(coordinator.scope, kind, location.key);
      restoringRef.current = false;
      setRestoreTarget(null);
    };

    const attemptRestore = () => {
      if (cancelled) {
        return;
      }

      attempts += 1;
      const scrollHeight = getDocumentScrollHeight();
      const viewportHeight = Math.max(window.innerHeight || 0, 1);
      const hasUsableHeight =
        restoreTarget.scrollY <= 0 || scrollHeight > viewportHeight;
      if (!hasUsableHeight && attempts < maxAttempts) {
        frame = window.requestAnimationFrame(attemptRestore);
        return;
      }

      const anchorNodes = restoreTarget.anchorToken
        ? anchorsRef.current.get(restoreTarget.anchorToken)
        : null;
      const anchorNode = anchorNodes
        ? Array.from(anchorNodes).find((node) => node.isConnected)
        : null;

      if (anchorNode) {
        const targetTop =
          window.scrollY +
          anchorNode.getBoundingClientRect().top -
          restoreTarget.anchorOffset;
        window.scrollTo({ top: Math.max(0, targetTop), left: 0, behavior: 'auto' });
        finish();
        return;
      }

      if (hasUsableHeight || attempts >= maxAttempts) {
        const maxScroll = Math.max(0, scrollHeight - viewportHeight);
        window.scrollTo({
          top: Math.min(Math.max(0, restoreTarget.scrollY), maxScroll),
          left: 0,
          behavior: 'auto'
        });
        finish();
        return;
      }

      frame = window.requestAnimationFrame(attemptRestore);
    };

    frame = window.requestAnimationFrame(attemptRestore);
    return () => {
      cancelled = true;
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [
    anchorVersion,
    coordinator?.scope,
    kind,
    location.key,
    ready,
    restoreTarget
  ]);

  return {
    getAnchorRef,
    isRestoring: Boolean(restoreTarget)
  };
}
