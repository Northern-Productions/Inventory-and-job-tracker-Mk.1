import { Suspense, lazy, type ReactNode } from 'react';
import { createHashRouter } from 'react-router-dom';
import { AppLayout } from '../components/AppLayout';
import { LoadingState } from '../components/LoadingState';

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

function withSuspense(element: ReactNode) {
  return <Suspense fallback={<LoadingState />}>{element}</Suspense>;
}

export const router = createHashRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      {
        index: true,
        element: withSuspense(<InventoryHomePage />)
      },
      {
        path: '/allocations',
        element: withSuspense(<AllocationsPage />)
      },
      {
        path: '/allocations/:jobNumber',
        element: withSuspense(<AllocationJobPage />)
      },
      {
        path: '/inventory/add',
        element: withSuspense(<AddBoxPage />)
      },
      {
        path: '/inventory/:boxId',
        element: withSuspense(<BoxDetailsPage />)
      },
      {
        path: '/inventory/scan',
        element: withSuspense(<QrScanPage />)
      },
      {
        path: '/film-orders',
        element: withSuspense(<FilmOrdersPage />)
      },
      {
        path: '/activity',
        element: withSuspense(<ActivityPage />)
      },
      {
        path: '/reports',
        element: withSuspense(<ReportsPage />)
      },
      {
        path: '/checkout-history',
        element: withSuspense(<CheckoutHistoryPage />)
      }
    ]
  }
]);
