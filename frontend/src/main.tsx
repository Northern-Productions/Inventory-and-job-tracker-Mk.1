import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { OptimisticQueueProvider } from './components/OptimisticQueue';
import { ToastProvider } from './components/Toast';
import { AuthProvider } from './features/auth/AuthContext';
import { PwaInstallProvider } from './features/pwa/PwaInstallContext';
import { AppThemeProvider } from './features/theme/AppThemeProvider';
import { initializeAppTheme } from './features/theme/themeStorage';
import './styles.css';

initializeAppTheme();

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
            <AppThemeProvider>
              <AuthProvider>
                <App />
              </AuthProvider>
            </AppThemeProvider>
          </PwaInstallProvider>
        </OptimisticQueueProvider>
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
