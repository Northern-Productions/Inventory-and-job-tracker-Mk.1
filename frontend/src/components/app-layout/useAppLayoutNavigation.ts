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
          : options.accessAttention && item.to === '/admin/access',
    attentionAriaLabel:
      item.to === '/allocations' && options.allocationsAttention
        ? `${item.desktopLabel} (jobs need allocations)`
        : item.to === '/film-orders' && options.filmOrdersAttention
          ? `${item.desktopLabel} (install-dated film orders)`
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
          ? `${item.mobileLabel} (install-dated film orders)`
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
  const attentionSummaryQuery = useAppAttentionSummary({
    enabled: canReadJobs || canReadFilmOrders || auth.isOwner,
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
  const desktopNavItems = useMemo(
    () =>
      mapToComputedNavItems(visibleNavItems, pathname, {
        allocationsAttention: showJobsNeedingAllocationAttention,
        filmOrdersAttention: showFilmOrdersAttention,
        accessAttention: showAccessPendingAttention
      }),
    [
      pathname,
      showAccessPendingAttention,
      showFilmOrdersAttention,
      showJobsNeedingAllocationAttention,
      visibleNavItems
    ]
  );
  const mobileNavItems = useMemo(
    () =>
      mapToComputedNavItems(visibleNavItems, pathname, {
        allocationsAttention: showJobsNeedingAllocationAttention,
        filmOrdersAttention: showFilmOrdersAttention,
        accessAttention: showAccessPendingAttention
      }),
    [
      pathname,
      showAccessPendingAttention,
      showFilmOrdersAttention,
      showJobsNeedingAllocationAttention,
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
    if (showAccessPendingAttention && showFilmOrdersAttention) {
      return 'More (pending approvals and install-dated film orders)';
    }

    if (showFilmOrdersAttention) {
      return 'More (install-dated film orders)';
    }

    if (showAccessPendingAttention) {
      return 'More (pending approvals)';
    }

    return undefined;
  }, [showAccessPendingAttention, showFilmOrdersAttention]);

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
