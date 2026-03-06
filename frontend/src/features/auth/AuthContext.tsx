import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import type { AuthSession, AuthUser } from '../../domain';
import { getStoredAuthSession, setStoredAuthSession } from '../../lib/storage';
import { getSupabaseClient, isSupabaseAuthConfigured } from '../../lib/supabase';

interface AuthContextValue {
  clientIdConfigured: boolean;
  errorMessage: string;
  isAuthenticated: boolean;
  isBusy: boolean;
  isReady: boolean;
  session: AuthSession | null;
  signInWithPassword: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  signUpWithPassword: (email: string, password: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const supabase = useMemo(() => getSupabaseClient(), []);
  const authConfigured = isSupabaseAuthConfigured();
  const [errorMessage, setErrorMessage] = useState('');
  const [session, setSession] = useState<AuthSession | null>(() => getStoredAuthSession());
  const [isBusy, setIsBusy] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const isAuthenticated = Boolean(session?.token && session.user?.email && session.user?.name);

  useEffect(() => {
    let isCancelled = false;

    if (!authConfigured || !supabase) {
      setStoredAuthSession(null);
      setSession(null);
      setErrorMessage('');
      setIsReady(true);
      return () => {
        isCancelled = true;
      };
    }

    const supabaseClient = supabase;

    async function hydrateAuthSession() {
      try {
        const { data, error } = await supabaseClient.auth.getSession();
        if (isCancelled) {
          return;
        }

        if (error) {
          throw error;
        }

        const nextSession = mapSupabaseSession(data.session);
        setStoredAuthSession(nextSession);
        setSession(nextSession);
        setErrorMessage('');
      } catch (error) {
        if (!isCancelled) {
          setStoredAuthSession(null);
          setSession(null);
          setErrorMessage(
            error instanceof Error && error.message ? error.message : 'Sign-in could not be initialized.'
          );
        }
      } finally {
        if (!isCancelled) {
          setIsReady(true);
        }
      }
    }

    hydrateAuthSession();

    const {
      data: { subscription }
    } = supabaseClient.auth.onAuthStateChange((_event, nextSession) => {
      if (isCancelled) {
        return;
      }

      const mapped = mapSupabaseSession(nextSession);
      setStoredAuthSession(mapped);
      setSession(mapped);
    });

    return () => {
      isCancelled = true;
      subscription.unsubscribe();
    };
  }, [authConfigured, supabase]);

  async function signInWithPassword(email: string, password: string) {
    if (!authConfigured || !supabase) {
      throw new Error('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable sign-in.');
    }

    setIsBusy(true);
    setErrorMessage('');

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password
      });

      if (error) {
        throw error;
      }

      const mapped = mapSupabaseSession(data.session);
      if (!mapped) {
        throw new Error('Sign-in succeeded but no active session was returned.');
      }

      setStoredAuthSession(mapped);
      setSession(mapped);
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : 'Sign-in failed.';
      setErrorMessage(message);
      throw new Error(message);
    } finally {
      setIsBusy(false);
    }
  }

  async function signUpWithPassword(email: string, password: string) {
    if (!authConfigured || !supabase) {
      throw new Error('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable sign-in.');
    }

    const trimmedEmail = email.trim();
    const fallbackName = deriveNameFromEmail(trimmedEmail);

    setIsBusy(true);
    setErrorMessage('');

    try {
      const { data, error } = await supabase.auth.signUp({
        email: trimmedEmail,
        password,
        options: {
          data: {
            name: fallbackName
          }
        }
      });

      if (error) {
        throw error;
      }

      const mapped = mapSupabaseSession(data.session);
      if (mapped) {
        setStoredAuthSession(mapped);
        setSession(mapped);
        return;
      }

      setErrorMessage('Account created. Confirm your email, then sign in.');
    } catch (error) {
      const message =
        error instanceof Error && error.message ? error.message : 'Account creation failed.';
      setErrorMessage(message);
      throw new Error(message);
    } finally {
      setIsBusy(false);
    }
  }

  async function signOut() {
    if (supabase) {
      try {
        await supabase.auth.signOut();
      } catch (_error) {
        // Ignore sign-out transport errors and clear local session anyway.
      }
    }

    setErrorMessage('');
    setStoredAuthSession(null);
    setSession(null);
  }

  return (
    <AuthContext.Provider
      value={{
        clientIdConfigured: authConfigured,
        errorMessage,
        isAuthenticated,
        isBusy,
        isReady,
        session,
        signInWithPassword,
        signOut,
        signUpWithPassword
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider.');
  }

  return context;
}

function deriveNameFromEmail(email: string): string {
  const localPart = email.split('@')[0] || '';
  const sanitized = localPart.replace(/[._-]+/g, ' ').trim();
  return sanitized || 'Inventory User';
}

function readUserMetadataField(user: User, key: string): string {
  const value = user.user_metadata && typeof user.user_metadata === 'object' ? user.user_metadata[key] : '';
  return typeof value === 'string' ? value.trim() : '';
}

function mapSupabaseSession(session: Session | null): AuthSession | null {
  if (!session || !session.access_token || !session.user || !session.user.email) {
    return null;
  }

  const email = session.user.email.trim();
  if (!email) {
    return null;
  }

  const profileName =
    readUserMetadataField(session.user, 'full_name') ||
    readUserMetadataField(session.user, 'name') ||
    deriveNameFromEmail(email);
  const avatarUrl = readUserMetadataField(session.user, 'avatar_url');

  const authUser: AuthUser = {
    email,
    hasProfileName: true,
    name: profileName,
    picture: avatarUrl,
    sub: session.user.id
  };

  const issuedAt = Date.now();
  const expiresAt =
    Number.isFinite(session.expires_at) && session.expires_at
      ? session.expires_at * 1000
      : issuedAt + 60 * 60 * 1000;

  return {
    token: session.access_token,
    user: authUser,
    issuedAt,
    expiresAt
  };
}
