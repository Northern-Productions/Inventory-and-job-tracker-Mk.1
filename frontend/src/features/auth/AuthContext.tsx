import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import type {
  AuthSession,
  AuthUser,
  EffectiveAccessContext,
  FeatureAccessMode,
  FeatureArea
} from '../../domain';
import { createDefaultFeatureAccessMap } from '../../domain';
import { getAuthContext, requestUsernameChange as requestUsernameChangeApi, setClientAccessContext } from '../../api/client';
import { getStoredAuthSession, setStoredAuthSession } from '../../lib/storage';
import { getSupabaseClient, isSupabaseAuthConfigured } from '../../lib/supabase';

interface AuthContextValue {
  accessContext: EffectiveAccessContext | null;
  accessStatus: 'approved' | 'pending' | 'denied' | '';
  canAccessAdminConsole: boolean;
  clientIdConfigured: boolean;
  errorMessage: string;
  hasFeatureAccess: (feature: FeatureArea, mode?: FeatureAccessMode) => boolean;
  isAuthenticated: boolean;
  isOwner: boolean;
  isAdmin: boolean;
  isMember: boolean;
  isApproved: boolean;
  isAccessReady: boolean;
  isBusy: boolean;
  isReady: boolean;
  refreshAccessContext: () => Promise<void>;
  requestUsernameChange: (
    username: string
  ) => Promise<{ status: 'approved' | 'pending'; requiresApproval: boolean; username: string }>;
  session: AuthSession | null;
  signInWithPassword: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  signUpWithPassword: (
    username: string,
    email: string,
    password: string
  ) => Promise<{ sessionCreated: boolean }>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const supabase = useMemo(() => getSupabaseClient(), []);
  const authConfigured = isSupabaseAuthConfigured();
  const [errorMessage, setErrorMessage] = useState('');
  const [session, setSession] = useState<AuthSession | null>(() => getStoredAuthSession());
  const [accessContext, setAccessContext] = useState<EffectiveAccessContext | null>(null);
  const [isAccessReady, setIsAccessReady] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const isAuthenticated = Boolean(session?.token && session.user?.email && session.user?.name);

  useEffect(() => {
    let isCancelled = false;

    if (!authConfigured || !supabase) {
      setStoredAuthSession(null);
      setSession(null);
      setAccessContext(null);
      setClientAccessContext(null);
      setErrorMessage('');
      setIsReady(true);
      setIsAccessReady(true);
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
        if (!nextSession) {
          setAccessContext(null);
          setClientAccessContext(null);
          setIsAccessReady(true);
        } else {
          setIsAccessReady(false);
        }
        setErrorMessage('');
      } catch (error) {
        if (!isCancelled) {
          setStoredAuthSession(null);
          setSession(null);
          setAccessContext(null);
          setClientAccessContext(null);
          setIsAccessReady(true);
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
      if (!mapped) {
        setAccessContext(null);
        setClientAccessContext(null);
        setIsAccessReady(true);
      } else {
        setIsAccessReady(false);
      }
    });

    return () => {
      isCancelled = true;
      subscription.unsubscribe();
    };
  }, [authConfigured, supabase]);

  useEffect(() => {
    let isCancelled = false;

    async function hydrateAccessContext() {
      if (!authConfigured || !session?.token) {
        setAccessContext(null);
        setClientAccessContext(null);
        setIsAccessReady(true);
        return;
      }

      setIsAccessReady(false);
      setAccessContext(null);
      setClientAccessContext(null);

      try {
        const nextContext = await getAuthContext();
        if (isCancelled) {
          return;
        }

        const normalizedContext: EffectiveAccessContext = {
          ...nextContext,
          permissions: {
            ...createDefaultFeatureAccessMap(),
            ...nextContext.permissions
          }
        };

        setAccessContext(normalizedContext);
        setClientAccessContext(normalizedContext);
        setErrorMessage('');
      } catch (error) {
        if (isCancelled) {
          return;
        }

        setAccessContext(null);
        setClientAccessContext(null);
        setErrorMessage(mapAccessContextErrorMessage(error));
      } finally {
        if (!isCancelled) {
          setIsAccessReady(true);
        }
      }
    }

    void hydrateAccessContext();

    return () => {
      isCancelled = true;
    };
  }, [authConfigured, session?.token]);

  async function refreshAccessContext() {
    if (!authConfigured || !session?.token) {
      setAccessContext(null);
      setClientAccessContext(null);
      setIsAccessReady(true);
      return;
    }

    setIsAccessReady(false);
    try {
      const nextContext = await getAuthContext();
      const normalizedContext: EffectiveAccessContext = {
        ...nextContext,
        permissions: {
          ...createDefaultFeatureAccessMap(),
          ...nextContext.permissions
        }
      };
      setAccessContext(normalizedContext);
      setClientAccessContext(normalizedContext);
      setErrorMessage('');
    } catch (error) {
      setAccessContext(null);
      setClientAccessContext(null);
      setErrorMessage(mapAccessContextErrorMessage(error));
    } finally {
      setIsAccessReady(true);
    }
  }

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
      setIsAccessReady(false);
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : 'Sign-in failed.';
      setErrorMessage(message);
      throw new Error(message);
    } finally {
      setIsBusy(false);
    }
  }

  async function signUpWithPassword(username: string, email: string, password: string) {
    if (!authConfigured || !supabase) {
      throw new Error('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable sign-in.');
    }

    const trimmedEmail = email.trim();
    const trimmedUsername = username.trim();
    const fallbackName = trimmedUsername || deriveNameFromEmail(trimmedEmail);

    setIsBusy(true);
    setErrorMessage('');

    try {
      const { data, error } = await supabase.auth.signUp({
        email: trimmedEmail,
        password,
        options: {
          data: {
            name: fallbackName,
            full_name: fallbackName
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
        setIsAccessReady(false);
        return { sessionCreated: true };
      }

      setAccessContext(null);
      setClientAccessContext(null);
      setIsAccessReady(true);
      setErrorMessage('');
      return { sessionCreated: false };
    } catch (error) {
      const message =
        error instanceof Error && error.message ? error.message : 'Account creation failed.';
      setErrorMessage(message);
      throw new Error(message);
    } finally {
      setIsBusy(false);
    }
  }

  async function requestUsernameChange(username: string) {
    const trimmed = username.trim();
    if (!trimmed) {
      throw new Error('Username is required.');
    }

    if (!authConfigured || !supabase) {
      throw new Error('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable username updates.');
    }

    setIsBusy(true);
    setErrorMessage('');
    try {
      const result = await requestUsernameChangeApi({ username: trimmed });

      if (result.status === 'approved') {
        const { data, error } = await supabase.auth.refreshSession();
        if (error) {
          throw error;
        }

        const mapped = mapSupabaseSession(data.session);
        if (mapped) {
          setStoredAuthSession(mapped);
          setSession(mapped);
        }

        await refreshAccessContext();
      }

      return result;
    } catch (error) {
      const message =
        error instanceof Error && error.message ? error.message : 'Username update failed.';
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
    setAccessContext(null);
    setClientAccessContext(null);
    setIsAccessReady(true);
  }

  const accessStatus = accessContext?.accessStatus || '';
  const isApproved = accessStatus === 'approved';
  const isOwner = accessContext?.role === 'owner';
  const isAdmin = accessContext?.role === 'admin';
  const isMember = accessContext?.role === 'member';
  const canAccessAdminConsole = Boolean(
    accessContext?.isAdminConsoleAllowed || isOwner || accessContext?.permissions.access_management?.read
  );

  function hasFeatureAccess(feature: FeatureArea, mode: FeatureAccessMode = 'read') {
    if (!isApproved) {
      return false;
    }

    if (isOwner) {
      return true;
    }

    return Boolean(accessContext?.permissions?.[feature]?.[mode]);
  }

  return (
    <AuthContext.Provider
      value={{
        accessContext,
        accessStatus,
        canAccessAdminConsole,
        clientIdConfigured: authConfigured,
        errorMessage,
        hasFeatureAccess,
        isAuthenticated,
        isOwner,
        isAdmin,
        isMember,
        isApproved,
        isAccessReady,
        isBusy,
        isReady,
        refreshAccessContext,
        requestUsernameChange,
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

function mapAccessContextErrorMessage(error: unknown): string {
  const message = error instanceof Error && error.message ? error.message : '';
  const normalized = message.toLowerCase();
  if (
    normalized.includes('relation "app.general_feature_permissions" does not exist') ||
    normalized.includes('relation "app.admin_feature_permissions" does not exist') ||
    normalized.includes('relation "app.access_requests" does not exist') ||
    normalized.includes('relation "app.username_change_requests" does not exist') ||
    normalized.includes('column "requested_by_name" does not exist') ||
    (normalized.includes('function public.api_get_auth_context') && normalized.includes('does not exist'))
  ) {
    return 'Database migrations 0006_access_control_and_approvals.sql, 0007_access_request_display_name.sql, 0008_username_change_requests.sql, and 0009_user_feature_overrides.sql are required. Run all four in Supabase, then refresh.';
  }

  return message || 'Your access details could not be loaded.';
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
