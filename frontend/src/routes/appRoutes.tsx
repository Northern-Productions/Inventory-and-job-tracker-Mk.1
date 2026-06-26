import { Suspense, lazy, type ReactNode } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';
import { AppLayout } from '../components/AppLayout';
import { DeferredLoadingState } from '../components/DeferredLoadingState';
import { AccessRoute } from '../features/auth/AccessRoute';
import { loadAllocationJobPage } from '../features/inventory/pages/allocationJobPageLoader';
import type { FeatureAccessMode, FeatureArea } from '../domain';

const InventoryHomePage = lazy(() => import('../features/inventory/pages/InventoryHomePage'));
const AllocationsPage = lazy(() => import('../features/inventory/pages/AllocationsPage'));
const AllocationJobPage = lazy(loadAllocationJobPage);
const AddBoxPage = lazy(() => import('../features/inventory/pages/AddBoxPage'));
const BoxDetailsPage = lazy(() => import('../features/inventory/pages/BoxDetailsPage'));
const QrScanPage = lazy(() => import('../features/inventory/pages/QrScanPage'));
const ActivityPage = lazy(() => import('../features/inventory/pages/ActivityPage'));
const FilmOrdersPage = lazy(() => import('../features/inventory/pages/FilmOrdersPage'));
const FilmOrderDetailsPage = lazy(() => import('../features/inventory/pages/FilmOrderDetailsPage'));
const WeightChartPage = lazy(() => import('../features/inventory/pages/WeightChartPage'));
const ReportsPage = lazy(() => import('../features/inventory/pages/ReportsPage'));
const CheckoutHistoryPage = lazy(
  () => import('../features/inventory/pages/CheckoutHistoryPage')
);
const LabelMakerPage = lazy(() => import('../features/inventory/pages/LabelMakerPage'));
const CaulkStockDetailsPage = lazy(() => import('../features/caulk/pages/CaulkStockDetailsPage'));
const AdminAccessPage = lazy(() => import('../features/access/pages/AdminAccessPage'));
const OwnerNotificationPreferencesPage = lazy(
  () => import('../features/access/pages/OwnerNotificationPreferencesPage')
);
const OwnerCompaniesPage = lazy(() => import('../features/ownership/pages/OwnerCompaniesPage'));
const BulkOwnershipTransferPage = lazy(() => import('../features/ownership/pages/BulkOwnershipTransferPage'));

function withSuspense(element: ReactNode) {
  return <Suspense fallback={<DeferredLoadingState when />}>{element}</Suspense>;
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

export const appRoutes: RouteObject[] = [
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
        path: '/allocations/jobs/:jobId',
        element: withFeatureRoute(<AllocationJobPage />, 'allocations', 'read')
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
        path: '/film-orders/:filmOrderId',
        element: withFeatureRoute(<FilmOrderDetailsPage />, 'film_orders', 'read')
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
        path: '/labels',
        element: withFeatureRoute(<LabelMakerPage />, 'inventory', 'read')
      },
      {
        path: '/weight-chart',
        element: withFeatureRoute(<WeightChartPage />, 'inventory', 'read')
      },
      {
        path: '/caulk',
        element: withFeatureRoute(<Navigate to="/?inventoryView=caulk" replace />, 'inventory', 'read')
      },
      {
        path: '/caulk/stock/:stockId',
        element: withFeatureRoute(<CaulkStockDetailsPage />, 'inventory', 'read')
      },
      {
        path: '/caulk/:warehouse/:productId',
        element: withFeatureRoute(<CaulkStockDetailsPage />, 'inventory', 'read')
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
        element: <Navigate to="/admin/access" replace />
      },
      {
        path: '/owner/companies',
        element: withSuspense(
          <AccessRoute requireOwner>
            <OwnerCompaniesPage />
          </AccessRoute>
        )
      },
      {
        path: '/owner/bulk-ownership-transfer',
        element: withSuspense(
          <AccessRoute requireOwner>
            <BulkOwnershipTransferPage />
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
];
