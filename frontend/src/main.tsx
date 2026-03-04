import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { OptimisticQueueProvider } from './components/OptimisticQueue';
import { ToastProvider } from './components/Toast';
import { AuthProvider } from './features/auth/AuthContext';
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
          <AuthProvider>
            <App />
          </AuthProvider>
        </OptimisticQueueProvider>
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
