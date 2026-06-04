import { useMemo } from 'react';
import { useAuth } from '../../features/auth/AuthContext';
import { useAppAttentionSummary } from '../../features/inventory/hooks/useInventoryQueries';
import type { MobileNavItem } from '../MobileBottomNav';
import {
  type AppShellTheme,
  type ComputedNavItem,
  isNavItemActive,
  navItems,
  resolveAppShellTheme
} from './config';

function mapToComputedNavItems(
  items: typeof navItems,
  pathname: string,
  options: {
    allocationsAttention: boolean;
    filmOrdersAttention: boolean;
    weightChartAttention: boolean;
    accessAttention: boolean;
  }
) {
  return items.map<ComputedNavItem>((item) => ({
    ...item,
    active: isNavItemActive(pathname, item.to),
    showAttentionDot:
      item.to === '/allocations'
        ? options.allocationsAttention
        : item.to === '/film-orders'
          ? options.filmOrdersAttention
          : item.to === '/weight-chart'
            ? options.weightChartAttention
            : options.accessAttention && item.to === '/admin/access',
    attentionAriaLabel:
      item.to === '/allocations' && options.allocationsAttention
        ? `${item.desktopLabel} (jobs need allocations)`
        : item.to === '/film-orders' && options.filmOrdersAttention
          ? `${item.desktopLabel} (needs ordering)`
          : item.to === '/weight-chart' && options.weightChartAttention
            ? `${item.desktopLabel} (pending reviews)`
            : options.accessAttention && item.to === '/admin/access'
              ? `${item.desktopLabel} (pending approvals)`
              : undefined
  }));
}

function toMobileNavItems(items: ComputedNavItem[]) {
  return items.map<MobileNavItem>((item) => ({
    label: item.mobileLabel,
    to: item.to,
    active: item.active,
    showAttentionDot: item.showAttentionDot,
    attentionAriaLabel:
      item.to === '/allocations' && item.showAttentionDot
        ? `${item.mobileLabel} (jobs need allocations)`
        : item.to === '/film-orders' && item.showAttentionDot
          ? `${item.mobileLabel} (needs ordering)`
          : item.to === '/weight-chart' && item.showAttentionDot
            ? `${item.mobileLabel} (pending reviews)`
            : item.to === '/admin/access' && item.showAttentionDot
              ? `${item.mobileLabel} (pending approvals)`
              : item.attentionAriaLabel
  }));
}

export function useAppLayoutNavigation(pathname: string): {
  appShellTheme: AppShellTheme;
  primaryNavItems: ComputedNavItem[];
  moreDesktopNavItems: ComputedNavItem[];
  primaryMobileItems: MobileNavItem[];
  moreMobileItems: MobileNavItem[];
  isDesktopMoreActive: boolean;
  isMobileMoreActive: boolean;
  desktopMoreHasAttention: boolean;
  mobileMoreHasAttention: boolean;
  mobileMoreAttentionAriaLabel?: string;
} {
  const auth = useAuth();
  const canReadJobs = auth.hasFeatureAccess('allocations', 'read');
  const canReadFilmOrders = auth.hasFeatureAccess('film_orders', 'read');
  const canReadInventory = auth.hasFeatureAccess('inventory', 'read');
  const attentionSummaryQuery = useAppAttentionSummary({
    enabled: canReadJobs || canReadFilmOrders || canReadInventory || auth.isOwner,
    refetchOnWindowFocus: true
  });
  const appShellTheme = useMemo(
    () => resolveAppShellTheme(pathname),
    [pathname]
  );
  const visibleNavItems = useMemo(
    () =>
      navItems.filter((item) => {
        if (item.ownerOnly && !auth.isOwner) {
          return false;
        }

        if (item.adminConsoleOnly && !auth.canAccessAdminConsole) {
          return false;
        }

        if (item.feature && !auth.hasFeatureAccess(item.feature, item.mode || 'read')) {
          return false;
        }

        return true;
      }),
    [auth]
  );
  const hasPendingAccessApprovals =
    auth.isOwner &&
    (Boolean(attentionSummaryQuery.data?.pendingAccessRequests) ||
      Number(auth.accessContext?.pendingCount || 0) > 0);
  const showAccessPendingAttention =
    hasPendingAccessApprovals && visibleNavItems.some((item) => item.to === '/admin/access');
  const showJobsNeedingAllocationAttention =
    canReadJobs && Boolean(attentionSummaryQuery.data?.hasJobsNeedingAllocation);
  const showFilmOrdersAttention =
    canReadFilmOrders &&
    Boolean(attentionSummaryQuery.data?.hasFilmOrdersNeedingAttention) &&
    visibleNavItems.some((item) => item.to === '/film-orders');
  const showWeightChartAttention =
    canReadInventory &&
    Boolean(attentionSummaryQuery.data?.hasFilmWeightPendingReviews) &&
    visibleNavItems.some((item) => item.to === '/weight-chart');
  const desktopNavItems = useMemo(
    () =>
      mapToComputedNavItems(visibleNavItems, pathname, {
        allocationsAttention: showJobsNeedingAllocationAttention,
        filmOrdersAttention: showFilmOrdersAttention,
        weightChartAttention: showWeightChartAttention,
        accessAttention: showAccessPendingAttention
      }),
    [
      pathname,
      showAccessPendingAttention,
      showFilmOrdersAttention,
      showJobsNeedingAllocationAttention,
      showWeightChartAttention,
      visibleNavItems
    ]
  );
  const mobileNavItems = useMemo(
    () =>
      mapToComputedNavItems(visibleNavItems, pathname, {
        allocationsAttention: showJobsNeedingAllocationAttention,
        filmOrdersAttention: showFilmOrdersAttention,
        weightChartAttention: showWeightChartAttention,
        accessAttention: showAccessPendingAttention
      }),
    [
      pathname,
      showAccessPendingAttention,
      showFilmOrdersAttention,
      showJobsNeedingAllocationAttention,
      showWeightChartAttention,
      visibleNavItems
    ]
  );
  const primaryNavItems = useMemo(
    () => desktopNavItems.filter((item) => item.desktopPlacement === 'primary'),
    [desktopNavItems]
  );
  const moreDesktopNavItems = useMemo(
    () => desktopNavItems.filter((item) => item.desktopPlacement === 'more'),
    [desktopNavItems]
  );
  const primaryMobileItems = useMemo(
    () => toMobileNavItems(mobileNavItems.filter((item) => item.mobilePlacement === 'primary')),
    [mobileNavItems]
  );
  const moreMobileItems = useMemo(
    () => toMobileNavItems(mobileNavItems.filter((item) => item.mobilePlacement === 'more')),
    [mobileNavItems]
  );
  const mobileMoreAttentionAriaLabel = useMemo(() => {
    const messages = [
      showAccessPendingAttention ? 'pending approvals' : '',
      showFilmOrdersAttention ? 'film orders need ordering' : '',
      showWeightChartAttention ? 'weight samples need review' : ''
    ].filter(Boolean);

    if (messages.length) {
      return `More (${messages.join(' and ')})`;
    }

    return undefined;
  }, [showAccessPendingAttention, showFilmOrdersAttention, showWeightChartAttention]);

  return {
    appShellTheme,
    primaryNavItems,
    moreDesktopNavItems,
    primaryMobileItems,
    moreMobileItems,
    isDesktopMoreActive: moreDesktopNavItems.some((item) => item.active),
    isMobileMoreActive: moreMobileItems.some((item) => item.active),
    desktopMoreHasAttention: moreDesktopNavItems.some((item) => item.showAttentionDot),
    mobileMoreHasAttention: moreMobileItems.some((item) => item.showAttentionDot),
    mobileMoreAttentionAriaLabel
  };
}
