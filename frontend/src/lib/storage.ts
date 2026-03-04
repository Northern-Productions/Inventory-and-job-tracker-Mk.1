import type { AuthSession } from '../domain';

const AUTH_SESSION_KEY = 'inventory-google-auth';

export function getStoredAuthSession(): AuthSession | null {
  try {
    const raw = window.localStorage.getItem(AUTH_SESSION_KEY);
    if (!raw) {
      return null;
    }

    const session = JSON.parse(raw) as AuthSession;
    if (
      !session ||
      !session.token ||
      !session.user?.email ||
      !session.user?.name ||
      session.user.hasProfileName !== true
    ) {
      window.localStorage.removeItem(AUTH_SESSION_KEY);
      return null;
    }

    if (Number.isFinite(session.expiresAt) && session.expiresAt <= Date.now()) {
      window.localStorage.removeItem(AUTH_SESSION_KEY);
      return null;
    }

    return session;
  } catch (_error) {
    window.localStorage.removeItem(AUTH_SESSION_KEY);
    return null;
  }
}

export function setStoredAuthSession(session: AuthSession | null): void {
  if (!session) {
    window.localStorage.removeItem(AUTH_SESSION_KEY);
    return;
  }

  window.localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
}

export function getStoredAuthToken(): string {
  return getStoredAuthSession()?.token ?? '';
}
