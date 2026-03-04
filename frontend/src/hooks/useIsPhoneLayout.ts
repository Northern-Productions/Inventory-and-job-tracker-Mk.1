import { useEffect, useState } from 'react';

const PHONE_LAYOUT_QUERY = '(max-width: 720px)';

function getInitialMatch() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }

  return window.matchMedia(PHONE_LAYOUT_QUERY).matches;
}

export function useIsPhoneLayout() {
  const [isPhoneLayout, setIsPhoneLayout] = useState(getInitialMatch);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const mediaQuery = window.matchMedia(PHONE_LAYOUT_QUERY);
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
  }, []);

  return isPhoneLayout;
}
