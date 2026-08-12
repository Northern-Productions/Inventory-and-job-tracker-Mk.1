import type { FeatureAccessMode, FeatureArea } from '../../domain';

export type NavPlacement = 'primary' | 'more';
export type AppShellTheme = 'inventory' | 'jobs' | 'add-box' | 'scan' | 'film-orders' | 'more';

export interface NavItem {
  to: string;
  desktopLabel: string;
  mobileLabel: string;
  desktopPlacement: NavPlacement;
  mobilePlacement: NavPlacement;
  feature?: FeatureArea;
  mode?: FeatureAccessMode;
  adminConsoleOnly?: boolean;
  ownerOnly?: boolean;
}

export interface ComputedNavItem extends NavItem {
  active: boolean;
  showAttentionDot: boolean;
  attentionAriaLabel?: string;
}

export const navItems: NavItem[] = [
  {
    to: '/',
    desktopLabel: 'Inventory',
    mobileLabel: 'Stock',
    desktopPlacement: 'primary',
    mobilePlacement: 'primary',
    feature: 'inventory',
    mode: 'read'
  },
  {
    to: '/allocations',
    desktopLabel: 'Jobs',
    mobileLabel: 'Jobs',
    desktopPlacement: 'primary',
    mobilePlacement: 'primary',
    feature: 'allocations',
    mode: 'read'
  },
  {
    to: '/inventory/add',
    desktopLabel: 'Add Box',
    mobileLabel: 'Add',
    desktopPlacement: 'primary',
    mobilePlacement: 'primary',
    feature: 'inventory',
    mode: 'write'
  },
  {
    to: '/inventory/scan',
    desktopLabel: 'Scan',
    mobileLabel: 'Scan',
    desktopPlacement: 'primary',
    mobilePlacement: 'primary',
    feature: 'inventory',
    mode: 'write'
  },
  {
    to: '/film-orders',
    desktopLabel: 'Film Orders',
    mobileLabel: 'Film Orders',
    desktopPlacement: 'primary',
    mobilePlacement: 'more',
    feature: 'film_orders',
    mode: 'read'
  },
  {
    to: '/reports',
    desktopLabel: 'Reports',
    mobileLabel: 'Reports',
    desktopPlacement: 'more',
    mobilePlacement: 'more',
    feature: 'reports',
    mode: 'read'
  },
  {
    to: '/checkout-history',
    desktopLabel: 'Checkout History',
    mobileLabel: 'Checkout History',
    desktopPlacement: 'more',
    mobilePlacement: 'more',
    feature: 'activity_history',
    mode: 'read'
  },
  {
    to: '/labels',
    desktopLabel: 'Labels',
    mobileLabel: 'Labels',
    desktopPlacement: 'more',
    mobilePlacement: 'more',
    feature: 'inventory',
    mode: 'read'
  },
  {
    to: '/weight-chart',
    desktopLabel: 'Weight Chart',
    mobileLabel: 'Weight Chart',
    desktopPlacement: 'more',
    mobilePlacement: 'more',
    feature: 'inventory',
    mode: 'read'
  },
  {
    to: '/activity',
    desktopLabel: 'Activity',
    mobileLabel: 'Activity',
    desktopPlacement: 'more',
    mobilePlacement: 'more',
    feature: 'activity_history',
    mode: 'read'
  },
  {
    to: '/admin/access',
    desktopLabel: 'Access',
    mobileLabel: 'Access',
    desktopPlacement: 'more',
    mobilePlacement: 'more',
    feature: 'access_management',
    mode: 'read',
    adminConsoleOnly: true
  },
  {
    to: '/owner/team',
    desktopLabel: 'Team / Users',
    mobileLabel: 'Team / Users',
    desktopPlacement: 'more',
    mobilePlacement: 'more',
    feature: 'team_management',
    mode: 'read'
  },
  {
    to: '/owner/companies',
    desktopLabel: 'Owner Companies',
    mobileLabel: 'Owner Companies',
    desktopPlacement: 'more',
    mobilePlacement: 'more',
    ownerOnly: true
  },
  {
    to: '/owner/bulk-ownership-transfer',
    desktopLabel: 'Ownership Transfer',
    mobileLabel: 'Ownership Transfer',
    desktopPlacement: 'more',
    mobilePlacement: 'more',
    ownerOnly: true
  },
  {
    to: '/owner/notification-preferences',
    desktopLabel: 'Owner Alerts',
    mobileLabel: 'Owner Alerts',
    desktopPlacement: 'more',
    mobilePlacement: 'more',
    ownerOnly: true
  }
];

export function isNavItemActive(pathname: string, to: string) {
  if (to === '/') {
    if (pathname === '/') {
      return true;
    }

    if (!pathname.startsWith('/inventory/')) {
      return false;
    }

    return pathname !== '/inventory/add' && pathname !== '/inventory/scan';
  }

  if (to === '/allocations') {
    return pathname === '/allocations' || pathname.startsWith('/allocations/');
  }

  return pathname === to;
}

export function resolveAppShellTheme(pathname: string): AppShellTheme {
  const normalizedPath = pathname || '/';

  if (normalizedPath === '/inventory/add') {
    return 'add-box';
  }

  if (normalizedPath === '/inventory/scan') {
    return 'scan';
  }

  if (normalizedPath === '/film-orders') {
    return 'film-orders';
  }

  if (normalizedPath === '/caulk') {
    return 'inventory';
  }

  if (normalizedPath === '/' || normalizedPath.startsWith('/inventory/')) {
    return 'inventory';
  }

  if (normalizedPath === '/allocations' || normalizedPath.startsWith('/allocations/')) {
    return 'jobs';
  }

  if (
    normalizedPath.startsWith('/reports') ||
    normalizedPath.startsWith('/activity') ||
    normalizedPath.startsWith('/checkout-history') ||
    normalizedPath.startsWith('/labels') ||
    normalizedPath.startsWith('/weight-chart') ||
    normalizedPath.startsWith('/admin/') ||
    normalizedPath.startsWith('/owner/')
  ) {
    return 'more';
  }

  return 'more';
}
