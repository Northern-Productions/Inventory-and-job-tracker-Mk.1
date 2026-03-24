import { useEffect, useState } from 'react';
import { LoadingState } from './LoadingState';

interface DeferredLoadingStateProps {
  when: boolean;
  label?: string;
  delayMs?: number;
}

export function DeferredLoadingState({
  when,
  label,
  delayMs = 250
}: DeferredLoadingStateProps) {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (!when) {
      setIsVisible(false);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setIsVisible(true);
    }, delayMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [delayMs, when]);

  if (!isVisible) {
    return null;
  }

  return <LoadingState label={label} />;
}
