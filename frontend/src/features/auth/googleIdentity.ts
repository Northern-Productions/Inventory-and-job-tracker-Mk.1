import type { AuthSession, AuthUser } from '../../domain';

const GOOGLE_IDENTITY_SCRIPT = 'https://accounts.google.com/gsi/client';

let googleScriptPromise: Promise<void> | null = null;

export function getGoogleClientId(): string {
  return import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() ?? '';
}

export async function ensureGoogleIdentityLoaded(): Promise<void> {
  if (window.google?.accounts?.id) {
    return;
  }

  if (!googleScriptPromise) {
    googleScriptPromise = new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(
        `script[src="${GOOGLE_IDENTITY_SCRIPT}"]`
      );

      if (existing) {
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener(
          'error',
          () => reject(new Error('Google sign-in could not be loaded.')),
          { once: true }
        );
        return;
      }

      const script = document.createElement('script');
      script.src = GOOGLE_IDENTITY_SCRIPT;
      script.async = true;
      script.defer = true;
      script.addEventListener('load', () => resolve(), { once: true });
      script.addEventListener(
        'error',
        () => reject(new Error('Google sign-in could not be loaded.')),
        { once: true }
      );
      document.head.appendChild(script);
    });
  }

  await googleScriptPromise;
}

export function createSessionFromCredential(credential: string): AuthSession {
  const payload = parseJwtPayload(credential);
  const email = requireStringClaim(payload, 'email');
  const name = requireStringClaim(payload, 'name');
  const picture = readStringClaim(payload, 'picture');
  const sub = requireStringClaim(payload, 'sub');
  const exp = requireNumberClaim(payload, 'exp');

  const user: AuthUser = {
    email,
    hasProfileName: true,
    name,
    picture,
    sub
  };

  return {
    token: credential,
    user,
    issuedAt: Date.now(),
    expiresAt: exp * 1000
  };
}

function parseJwtPayload(credential: string): Record<string, unknown> {
  const parts = credential.split('.');
  if (parts.length < 2) {
    throw new Error('Google sign-in returned an invalid token.');
  }

  const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = window.atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json) as Record<string, unknown>;
}

function readStringClaim(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value.trim() : '';
}

function requireStringClaim(payload: Record<string, unknown>, key: string): string {
  const value = readStringClaim(payload, key);
  if (!value) {
    throw new Error(`Google sign-in token is missing ${key}.`);
  }

  return value;
}

function requireNumberClaim(payload: Record<string, unknown>, key: string): number {
  const value = Number(payload[key]);
  if (!Number.isFinite(value)) {
    throw new Error(`Google sign-in token is missing ${key}.`);
  }

  return value;
}

declare global {
  interface Window {
    google?: GoogleIdentityNamespace;
  }
}

interface GoogleIdentityNamespace {
  accounts: {
    id: {
      initialize(config: GoogleIdentityInitConfig): void;
      renderButton(element: HTMLElement, options: GoogleButtonOptions): void;
      disableAutoSelect(): void;
    };
  };
}

interface GoogleIdentityInitConfig {
  client_id: string;
  callback: (response: GoogleCredentialResponse) => void;
}

interface GoogleButtonOptions {
  theme?: 'outline' | 'filled_blue' | 'filled_black';
  size?: 'large' | 'medium' | 'small';
  text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
  shape?: 'rectangular' | 'pill' | 'circle' | 'square';
  logo_alignment?: 'left' | 'center';
  width?: number;
}

interface GoogleCredentialResponse {
  credential?: string;
}
