import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  AccessStatus,
  AuthSession,
  EffectiveAccessContext,
  FeatureAccessMode,
  FeatureArea
} from '../../domain';
import {
  getAuthContext,
  selectOrganization,
  setClientAccessContext
} from '../../api/features/authClient';
import { clearTenantPersistentBrowserCaches } from '../../lib/browserTenantCaches';
import { clearNavigationSessionRecords } from '../navigation/navigationSession';
import { getStoredAuthSession, setStoredAuthSession } from '../../lib/storage';
import { getSupabaseClient, isSupabaseAuthConfigured } from '../../lib/supabase';
import { isPasswordRecoveryUrl } from './authRecovery';
import { clearRecoveryUrlState, normalizeAccessContext } from './authAccessHelpers';
import { mapAccessContextErrorMessage, isSessionExpiredOrMissingError } from './authErrors';
import { buildAuthProviderActions } from './authProviderActions';
import {
  useAuthAccessRefreshEffects,
  useSupabaseAuthSessionLifecycle
} from './authProviderEffects';
import { buildAuthScopeSignature } from './authSession';

interface AuthContextValue {
  accessContext: EffectiveAccessContext | null;
  accessRefreshError: string;
  accessStatus: AccessStatus | '';
  canAccessAdminConsole: boolean;
  clientIdConfigured: boolean;
  errorMessage: string;
  hasFeatureAccess: (feature: FeatureArea, mode?: FeatureAccessMode) => boolean;
  isAuthenticated: boolean;
  isPasswordRecovery: boolean;
  isOwner: boolean;
  isAdmin: boolean;
  isMember: boolean;
  isApproved: boolean;
  isAccessReady: boolean;
  isBusy: boolean;
  isReady: boolean;
  passwordResetMessage: string;
  completePasswordReset: (password: string) => Promise<void>;
  exitPasswordRecovery: () => void;
  refreshAccessContext: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  requestUsernameChange: (
    username: string
  ) => Promise<{ status: 'approved' | 'pending'; requiresApproval: boolean; username: string }>;
  updateDefaultWarehouse: (defaultWarehouse: string) => Promise<{ defaultWarehouse: string }>;
  session: AuthSession | null;
  signInWithPassword: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  signUpWithPassword: (
    username: string,
    email: string,
    password: string
  ) => Promise<{ sessionCreated: boolean }>;
  switchOrganization: (orgId: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const ACCESS_REFRESH_THROTTLE_MS = 15_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const supabase = useMemo(() => getSupabaseClient(), []);
  const authConfigured = isSupabaseAuthConfigured();
  const [errorMessage, setErrorMessage] = useState('');
  const [passwordResetMessage, setPasswordResetMessage] = useState('');
  const [session, setSession] = useState<AuthSession | null>(() => getStoredAuthSession());
  const [accessContext, setAccessContext] = useState<EffectiveAccessContext | null>(null);
  const [accessRefreshError, setAccessRefreshError] = useState('');
  const [isAccessReady, setIsAccessReady] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [isPasswordRecovery, setIsPasswordRecovery] = useState(() =>
    typeof window !== 'undefined' ? isPasswordRecoveryUrl(window.location) : false
  );
  const accessContextRef = useRef<EffectiveAccessContext | null>(null);
  const accessRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const accessRefreshTokenRef = useRef('');
  const sessionTokenRef = useRef(session?.token || '');
  const sessionUserIdRef = useRef(session?.user?.sub || '');
  const resolvedAuthScopeSignatureRef = useRef('');
  const isAuthenticated = Boolean(session?.token && session.user?.email && session.user?.name);

  const resetAppQueryCache = useCallback(() => {
    void queryClient.cancelQueries();
    queryClient.clear();
    void clearTenantPersistentBrowserCaches();
    clearNavigationSessionRecords();
  }, [queryClient]);

  const resetAppQueryCacheAndWait = useCallback(async () => {
    await queryClient.cancelQueries();
    queryClient.clear();
    await clearTenantPersistentBrowserCaches();
    clearNavigationSessionRecords();
  }, [queryClient]);

  const applyAccessContext = useCallback((nextContext: EffectiveAccessContext | null) => {
    accessContextRef.current = nextContext;
    setAccessContext(nextContext);
    setClientAccessContext(nextContext);
  }, []);

  const finalizeSignedOutState = useCallback(
    ({
      nextErrorMessage = '',
      nextPasswordResetMessage = ''
    }: {
      nextErrorMessage?: string;
      nextPasswordResetMessage?: string;
    } = {}) => {
      resetAppQueryCache();
      setErrorMessage(nextErrorMessage);
      setPasswordResetMessage(nextPasswordResetMessage);
      sessionTokenRef.current = '';
      sessionUserIdRef.current = '';
      resolvedAuthScopeSignatureRef.current = '';
      setStoredAuthSession(null);
      setSession(null);
      applyAccessContext(null);
      accessRefreshPromiseRef.current = null;
      accessRefreshTokenRef.current = '';
      setAccessRefreshError('');
      setIsAccessReady(true);
      setIsPasswordRecovery(false);
      clearRecoveryUrlState();
    },
    [applyAccessContext, clearRecoveryUrlState, resetAppQueryCache]
  );

  const performSignOut = useCallback(
    async (options?: { nextErrorMessage?: string; nextPasswordResetMessage?: string }) => {
      if (supabase) {
        try {
          await supabase.auth.signOut();
        } catch (_error) {
          // Ignore sign-out transport errors and clear local session anyway.
        }
      }

      finalizeSignedOutState(options);
    },
    [finalizeSignedOutState, supabase]
  );

  const refreshAccessContext = useCallback(async () => {
    const activeToken = session?.token || '';
    if (!authConfigured || !activeToken || isPasswordRecovery) {
      applyAccessContext(null);
      setAccessRefreshError('');
      setIsAccessReady(true);
      accessRefreshPromiseRef.current = null;
      accessRefreshTokenRef.current = '';
      return;
    }

    if (accessRefreshPromiseRef.current && accessRefreshTokenRef.current === activeToken) {
      return accessRefreshPromiseRef.current;
    }

    setIsAccessReady(false);
    setAccessRefreshError('');

    const requestToken = activeToken;
    accessRefreshTokenRef.current = requestToken;
    const refreshPromise = (async () => {
      try {
        const nextContext = await getAuthContext();
        if (sessionTokenRef.current !== requestToken) {
          return;
        }
        const normalizedContext = normalizeAccessContext(nextContext);
        const nextScopeSignature = buildAuthScopeSignature(session, normalizedContext);
        const currentScopeSignature = resolvedAuthScopeSignatureRef.current;
        if (
          currentScopeSignature &&
          nextScopeSignature &&
          currentScopeSignature !== nextScopeSignature
        ) {
          resetAppQueryCache();
        }
        resolvedAuthScopeSignatureRef.current = nextScopeSignature;
        applyAccessContext(normalizedContext);
        setErrorMessage('');
      } catch (error) {
        if (sessionTokenRef.current !== requestToken) {
          return;
        }
        if (isSessionExpiredOrMissingError(error)) {
          // Local site data can be cleared while this tab is still open. In that case
          // we may still have an in-memory auth state, but no valid token to call APIs.
          // Reset session state so the app returns to the sign-in gate cleanly.
          finalizeSignedOutState({
            nextErrorMessage: 'Your session expired. Please sign in again.'
          });
          return;
        }
        const message = mapAccessContextErrorMessage(error);
        if (!accessContextRef.current) {
          applyAccessContext(null);
          setErrorMessage(message);
        } else {
          setErrorMessage('');
          setAccessRefreshError(message);
        }
      } finally {
        if (accessRefreshTokenRef.current === requestToken) {
          accessRefreshPromiseRef.current = null;
          accessRefreshTokenRef.current = '';
        }
        if (sessionTokenRef.current === requestToken) {
          setIsAccessReady(true);
        }
      }
    })();

    accessRefreshPromiseRef.current = refreshPromise;
    return refreshPromise;
  }, [
    applyAccessContext,
    authConfigured,
    finalizeSignedOutState,
    isPasswordRecovery,
    resetAppQueryCache,
    session,
    session?.token,
    session?.user?.sub
  ]);

  const switchOrganization = useCallback(async (orgId: string) => {
    const normalizedOrgId = String(orgId || '').trim();
    if (!normalizedOrgId || normalizedOrgId === accessContextRef.current?.orgId) {
      return;
    }

    setIsAccessReady(false);
    setAccessRefreshError('');
    applyAccessContext(null);
    try {
      await resetAppQueryCacheAndWait();
      await selectOrganization(normalizedOrgId);
      if (typeof window !== 'undefined') {
        window.location.assign('/');
      }
    } catch (error) {
      setAccessRefreshError(mapAccessContextErrorMessage(error));
      await refreshAccessContext();
      throw error;
    }
  }, [applyAccessContext, refreshAccessContext, resetAppQueryCacheAndWait]);

  useEffect(() => {
    sessionTokenRef.current = session?.token || '';
    sessionUserIdRef.current = session?.user?.sub || '';
  }, [session?.token, session?.user?.sub]);
  useSupabaseAuthSessionLifecycle({
    accessContextRef,
    applyAccessContext,
    authConfigured,
    clearRecoveryUrlState,
    finalizeSignedOutState,
    resolvedAuthScopeSignatureRef,
    sessionUserIdRef,
    setAccessRefreshError,
    setErrorMessage,
    setIsAccessReady,
    setIsPasswordRecovery,
    setIsReady,
    setPasswordResetMessage,
    setSession,
    supabase
  });

  useAuthAccessRefreshEffects({
    authConfigured,
    refreshAccessContext,
    sessionToken: session?.token || '',
    throttleMs: ACCESS_REFRESH_THROTTLE_MS
  });
  const {
    completePasswordReset,
    exitPasswordRecovery,
    requestPasswordReset,
    requestUsernameChange,
    updateDefaultWarehouse,
    signInWithPassword,
    signOut,
    signUpWithPassword
  } = buildAuthProviderActions({
    applyAccessContext,
    authConfigured,
    isPasswordRecovery,
    performSignOut,
    refreshAccessContext,
    session,
    setAccessRefreshError,
    setErrorMessage,
    setIsAccessReady,
    setIsBusy,
    setPasswordResetMessage,
    setSession,
    supabase
  });

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
        accessRefreshError,
        accessStatus,
        canAccessAdminConsole,
        clientIdConfigured: authConfigured,
        errorMessage,
        passwordResetMessage,
        hasFeatureAccess,
        isAuthenticated,
        isPasswordRecovery,
        isOwner,
        isAdmin,
        isMember,
        isApproved,
        isAccessReady,
        isBusy,
        isReady,
        completePasswordReset,
        exitPasswordRecovery,
        refreshAccessContext,
        requestPasswordReset,
        requestUsernameChange,
        updateDefaultWarehouse,
        session,
        signInWithPassword,
        signOut,
        signUpWithPassword,
        switchOrganization
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
