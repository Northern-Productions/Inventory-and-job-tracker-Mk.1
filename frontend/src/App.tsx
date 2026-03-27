import { useEffect } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { RouterProvider } from 'react-router-dom';
import { DeferredLoadingState } from './components/DeferredLoadingState';
import { useAuth } from './features/auth/AuthContext';
import { AccessSplash } from './features/auth/AccessSplash';
import { AuthGate } from './features/auth/AuthGate';
import { router } from './routes';

function PwaUpdateBanner() {
  const { needRefresh, updateServiceWorker } = useRegisterSW({
    immediate: true
  });

  useEffect(() => {
    if (!needRefresh[0]) {
      return;
    }

    void updateServiceWorker(true);
  }, [needRefresh, updateServiceWorker]);

  if (!needRefresh[0]) {
    return null;
  }

  return (
    <div className="update-banner">
      <span>Updating to the latest version...</span>
    </div>
  );
}

export default function App() {
  const auth = useAuth();

  if (!auth.isReady || !auth.isAuthenticated) {
    return (
      <>
        <PwaUpdateBanner />
        <AuthGate />
      </>
    );
  }

  if (!auth.isAccessReady && !auth.accessContext) {
    return (
      <>
        <PwaUpdateBanner />
        <div className="auth-gate">
          <section className="auth-gate-card" aria-label="Loading access context">
            <DeferredLoadingState
              when
              label="Loading your access permissions..."
            />
          </section>
        </div>
      </>
    );
  }

  if (auth.accessStatus === 'pending') {
    return (
      <>
        <PwaUpdateBanner />
        <AccessSplash mode="pending" />
      </>
    );
  }

  if (auth.accessStatus === 'denied') {
    return (
      <>
        <PwaUpdateBanner />
        <AccessSplash mode="denied" />
      </>
    );
  }

  if (!auth.isApproved) {
    return (
      <>
        <PwaUpdateBanner />
        <AuthGate />
      </>
    );
  }

  return (
    <>
      <PwaUpdateBanner />
      <RouterProvider router={router} />
    </>
  );
}

