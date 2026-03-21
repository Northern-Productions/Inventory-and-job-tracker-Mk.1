import { Suspense, lazy, type ReactNode } from 'react';
import { Navigate, createHashRouter } from 'react-router-dom';
import { AppLayout } from '../components/AppLayout';
import { LoadingState } from '../components/LoadingState';
import { AccessRoute } from '../features/auth/AccessRoute';
import type { FeatureAccessMode, FeatureArea } from '../domain';

const InventoryHomePage = lazy(() => import('../features/inventory/pages/InventoryHomePage'));
const AllocationsPage = lazy(() => import('../features/inventory/pages/AllocationsPage'));
const AllocationJobPage = lazy(() => import('../features/inventory/pages/AllocationJobPage'));
const AddBoxPage = lazy(() => import('../features/inventory/pages/AddBoxPage'));
const BoxDetailsPage = lazy(() => import('../features/inventory/pages/BoxDetailsPage'));
const QrScanPage = lazy(() => import('../features/inventory/pages/QrScanPage'));
const ActivityPage = lazy(() => import('../features/inventory/pages/ActivityPage'));
const FilmOrdersPage = lazy(() => import('../features/inventory/pages/FilmOrdersPage'));
const ReportsPage = lazy(() => import('../features/inventory/pages/ReportsPage'));
const CheckoutHistoryPage = lazy(
  () => import('../features/inventory/pages/CheckoutHistoryPage')
);
const AdminAccessPage = lazy(() => import('../features/access/pages/AdminAccessPage'));
const OwnerAdminPermissionsPage = lazy(
  () => import('../features/access/pages/OwnerAdminPermissionsPage')
);
const OwnerNotificationPreferencesPage = lazy(
  () => import('../features/access/pages/OwnerNotificationPreferencesPage')
);

function withSuspense(element: ReactNode) {
  return <Suspense fallback={<LoadingState />}>{element}</Suspense>;
}

function withFeatureRoute(
  element: ReactNode,
  feature: FeatureArea,
  mode: FeatureAccessMode = 'read'
) {
  return withSuspense(
    <AccessRoute feature={feature} mode={mode}>
      {element}
    </AccessRoute>
  );
}

export const router = createHashRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      {
        index: true,
        element: withFeatureRoute(<InventoryHomePage />, 'inventory', 'read')
      },
      {
        path: '/allocations',
        element: withFeatureRoute(<AllocationsPage />, 'allocations', 'read')
      },
      {
        path: '/allocations/:jobNumber',
        element: withFeatureRoute(<AllocationJobPage />, 'allocations', 'read')
      },
      {
        path: '/inventory/add',
        element: withFeatureRoute(<AddBoxPage />, 'inventory', 'write')
      },
      {
        path: '/inventory/:boxId',
        element: withFeatureRoute(<BoxDetailsPage />, 'inventory', 'read')
      },
      {
        path: '/inventory/scan',
        element: withFeatureRoute(<QrScanPage />, 'inventory', 'write')
      },
      {
        path: '/film-orders',
        element: withFeatureRoute(<FilmOrdersPage />, 'film_orders', 'read')
      },
      {
        path: '/activity',
        element: withFeatureRoute(<ActivityPage />, 'activity_history', 'read')
      },
      {
        path: '/reports',
        element: withFeatureRoute(<ReportsPage />, 'reports', 'read')
      },
      {
        path: '/checkout-history',
        element: withFeatureRoute(<CheckoutHistoryPage />, 'activity_history', 'read')
      },
      {
        path: '/caulk',
        element: withFeatureRoute(<Navigate to="/?inventoryView=caulk" replace />, 'inventory', 'read')
      },
      {
        path: '/admin/access',
        element: withSuspense(
          <AccessRoute feature="access_management" mode="read" requireAdminConsole>
            <AdminAccessPage />
          </AccessRoute>
        )
      },
      {
        path: '/owner/admin-permissions',
        element: withSuspense(
          <AccessRoute requireOwner>
            <OwnerAdminPermissionsPage />
          </AccessRoute>
        )
      },
      {
        path: '/owner/notification-preferences',
        element: withSuspense(
          <AccessRoute requireOwner>
            <OwnerNotificationPreferencesPage />
          </AccessRoute>
        )
      }
    ]
  }
]);
