import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { OptimisticQueueProvider } from './components/OptimisticQueue';
import { ToastProvider } from './components/Toast';
import { AuthProvider } from './features/auth/AuthContext';
import { PwaInstallProvider } from './features/pwa/PwaInstallContext';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false
    }
  }
});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <OptimisticQueueProvider>
          <PwaInstallProvider>
            <AuthProvider>
              <App />
            </AuthProvider>
          </PwaInstallProvider>
        </OptimisticQueueProvider>
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
