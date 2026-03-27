import { useEffect, useState } from 'react';

function buildPhoneLayoutQuery(maxWidth: number) {
  return `(max-width: ${maxWidth}px)`;
}

function getInitialMatch(query: string) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }

  return window.matchMedia(query).matches;
}

export function useIsPhoneLayout(maxWidth = 720) {
  const phoneLayoutQuery = buildPhoneLayoutQuery(maxWidth);
  const [isPhoneLayout, setIsPhoneLayout] = useState(() => getInitialMatch(phoneLayoutQuery));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const mediaQuery = window.matchMedia(phoneLayoutQuery);
    const handleChange = (event: MediaQueryListEvent) => {
      setIsPhoneLayout(event.matches);
    };

    setIsPhoneLayout(mediaQuery.matches);

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, [phoneLayoutQuery]);

  return isPhoneLayout;
}
