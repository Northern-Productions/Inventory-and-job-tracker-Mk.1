import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren
} from 'react';

interface OptimisticOperationEntry {
  id: number;
  label: string;
}

export interface OptimisticOperationController {
  waitForApply: () => Promise<void>;
  cancel: () => void;
  finish: () => void;
}

interface OptimisticQueueContextValue {
  begin: (label: string, apply: () => void) => OptimisticOperationController;
}

const OPTIMISTIC_DELAY_MS = 2000;
const OptimisticQueueContext = createContext<OptimisticQueueContextValue | null>(null);

export function OptimisticQueueProvider({ children }: PropsWithChildren) {
  const [operations, setOperations] = useState<OptimisticOperationEntry[]>([]);
  const nextIdRef = useRef(1);

  const remove = useCallback((id: number) => {
    setOperations((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const begin = useCallback(
    (label: string, apply: () => void): OptimisticOperationController => {
      const id = nextIdRef.current;
      nextIdRef.current += 1;

      setOperations((current) => [...current, { id, label }]);

      let applied = false;
      let settled = false;
      let resolveApply: (() => void) | null = null;
      const applyPromise = new Promise<void>((resolve) => {
        resolveApply = resolve;
      });

      const timeoutId = window.setTimeout(() => {
        if (settled) {
          resolveApply?.();
          return;
        }

        applied = true;
        apply();
        resolveApply?.();
      }, OPTIMISTIC_DELAY_MS);

      return {
        waitForApply: () => applyPromise,
        cancel: () => {
          if (settled) {
            return;
          }

          settled = true;
          window.clearTimeout(timeoutId);
          if (!applied) {
            resolveApply?.();
          }
          remove(id);
        },
        finish: () => {
          if (settled) {
            return;
          }

          settled = true;
          window.clearTimeout(timeoutId);
          if (!applied) {
            resolveApply?.();
          }
          remove(id);
        }
      };
    },
    [remove]
  );

  const value = useMemo(() => ({ begin }), [begin]);

  return (
    <OptimisticQueueContext.Provider value={value}>
      {children}
      {operations.length ? (
        <div className="optimistic-stack" aria-live="polite" aria-label="Pending updates">
          {operations.map((entry) => (
            <div key={entry.id} className="optimistic-card">
              <span className="optimistic-label">{entry.label}</span>
              <span className="optimistic-dots" aria-hidden="true">
                <span className="optimistic-dot" />
                <span className="optimistic-dot" />
                <span className="optimistic-dot" />
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </OptimisticQueueContext.Provider>
  );
}

export function useOptimisticQueue() {
  const context = useContext(OptimisticQueueContext);
  if (!context) {
    throw new Error('useOptimisticQueue must be used inside OptimisticQueueProvider.');
  }

  return context;
}
