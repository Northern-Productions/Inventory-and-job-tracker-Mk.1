import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren
} from 'react';
import { Button } from './Button';

type ToastVariant = 'success' | 'error' | 'warning';
const TOAST_EXIT_ANIMATION_MS = 220;

interface ToastItem {
  id: number;
  title: string;
  description?: string;
  variant: ToastVariant;
  durationMs: number;
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
  isClosing: boolean;
}

interface ToastInput {
  title: string;
  description?: string;
  variant?: ToastVariant;
  durationMs?: number;
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
}

interface ToastContextValue {
  push: (toast: ToastInput) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

function getToastSymbol(variant: ToastVariant) {
  if (variant === 'success') {
    return 'OK';
  }

  if (variant === 'warning') {
    return '!';
  }

  return 'X';
}

export function ToastProvider({ children }: PropsWithChildren) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const closingToastIdsRef = useRef<Set<number>>(new Set());

  const dismiss = useCallback((id: number) => {
    if (closingToastIdsRef.current.has(id)) {
      return;
    }

    closingToastIdsRef.current.add(id);
    setToasts((current) =>
      current.map((toast) => (toast.id === id ? { ...toast, isClosing: true } : toast))
    );
    window.setTimeout(() => {
      closingToastIdsRef.current.delete(id);
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, TOAST_EXIT_ANIMATION_MS);
  }, []);

  const push = useCallback(
    (toast: ToastInput) => {
      const id = Date.now() + Math.floor(Math.random() * 1000);
      const nextToast: ToastItem = {
        id,
        title: toast.title,
        description: toast.description,
        variant: toast.variant ?? 'success',
        durationMs: toast.durationMs ?? 6000,
        actionLabel: toast.actionLabel,
        onAction: toast.onAction,
        isClosing: false
      };

      setToasts((current) => [...current, nextToast]);
      window.setTimeout(() => dismiss(id), nextToast.durationMs);
    },
    [dismiss]
  );

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast toast-${toast.variant}${toast.isClosing ? ' toast-exit' : ''}`}
            role={toast.variant === 'error' ? 'alert' : 'status'}
          >
            <div className="toast-body">
              <span className="toast-symbol" aria-hidden="true">
                {getToastSymbol(toast.variant)}
              </span>
              <div>
                <strong>{toast.title}</strong>
                {toast.description ? <p>{toast.description}</p> : null}
              </div>
            </div>
            <div className="toast-actions">
              {toast.actionLabel && toast.onAction ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    await toast.onAction?.();
                    dismiss(toast.id);
                  }}
                >
                  {toast.actionLabel}
                </Button>
              ) : null}
              <button
                className="toast-close"
                type="button"
                aria-label="Dismiss notification"
                onClick={() => dismiss(toast.id)}
              >
                x
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used inside ToastProvider.');
  }

  return context;
}
