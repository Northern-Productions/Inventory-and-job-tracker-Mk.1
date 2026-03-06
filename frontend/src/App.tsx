import { useRegisterSW } from 'virtual:pwa-register/react';
import { RouterProvider } from 'react-router-dom';
import { Button } from './components/Button';
import { useAuth } from './features/auth/AuthContext';
import { AuthGate } from './features/auth/AuthGate';
import { router } from './routes';

function PwaUpdateBanner() {
  const { needRefresh, updateServiceWorker } = useRegisterSW();

  if (!needRefresh[0]) {
    return null;
  }

  return (
    <div className="update-banner">
      <span>A new version is ready.</span>
      <Button type="button" variant="secondary" onClick={() => updateServiceWorker(true)}>
        Refresh
      </Button>
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

  return (
    <>
      <PwaUpdateBanner />
      <RouterProvider router={router} />
    </>
  );
}
