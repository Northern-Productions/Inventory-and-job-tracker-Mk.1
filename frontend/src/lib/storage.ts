import type { AuthSession } from '../domain';

const AUTH_SESSION_KEY = 'inventory-auth-session';

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

    if (!isLikelySupabaseAccessToken_(session.token)) {
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

function isLikelySupabaseAccessToken_(token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) {
    return false;
  }

  const parts = trimmed.split('.');
  if (parts.length < 2) {
    return false;
  }

  const payload = decodeJwtPayload_(parts[1]);
  if (!payload) {
    return false;
  }

  const issuer = typeof payload.iss === 'string' ? payload.iss : '';
  const role = typeof payload.role === 'string' ? payload.role : '';

  return Boolean(issuer && issuer.indexOf('/auth/v1') !== -1 && role);
}

function decodeJwtPayload_(encodedPayload: string): Record<string, unknown> | null {
  try {
    const normalized = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const decoder =
      typeof globalThis.atob === 'function'
        ? globalThis.atob.bind(globalThis)
        : null;
    if (!decoder) {
      return null;
    }

    const decoded = decoder(padded);
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch (_error) {
    return null;
  }
}
