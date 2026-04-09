import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthSession, EffectiveAccessContext } from '../../domain';
import { setStoredAuthSession } from '../../lib/storage';
import { PASSWORD_RESET_INVALID_LINK_MESSAGE, isPasswordRecoveryUrl } from './authRecovery';
import { mapSupabaseSession } from './authSession';

interface FinalizeSignedOutStateOptions {
  nextErrorMessage?: string;
  nextPasswordResetMessage?: string;
}

interface UseSupabaseAuthSessionLifecycleOptions {
  applyAccessContext: (nextContext: EffectiveAccessContext | null) => void;
  authConfigured: boolean;
  clearRecoveryUrlState: () => void;
  finalizeSignedOutState: (options?: FinalizeSignedOutStateOptions) => void;
  resolvedAuthScopeSignatureRef: MutableRefObject<string>;
  setAccessRefreshError: Dispatch<SetStateAction<string>>;
  setErrorMessage: Dispatch<SetStateAction<string>>;
  setIsAccessReady: Dispatch<SetStateAction<boolean>>;
  setIsPasswordRecovery: Dispatch<SetStateAction<boolean>>;
  setIsReady: Dispatch<SetStateAction<boolean>>;
  setPasswordResetMessage: Dispatch<SetStateAction<string>>;
  setSession: Dispatch<SetStateAction<AuthSession | null>>;
  supabase: SupabaseClient | null;
}

interface UseAuthAccessRefreshEffectsOptions {
  authConfigured: boolean;
  refreshAccessContext: () => Promise<void>;
  sessionToken: string;
  throttleMs: number;
}

export function useSupabaseAuthSessionLifecycle({
  applyAccessContext,
  authConfigured,
  clearRecoveryUrlState,
  finalizeSignedOutState,
  resolvedAuthScopeSignatureRef,
  setAccessRefreshError,
  setErrorMessage,
  setIsAccessReady,
  setIsPasswordRecovery,
  setIsReady,
  setPasswordResetMessage,
  setSession,
  supabase
}: UseSupabaseAuthSessionLifecycleOptions) {
  useEffect(() => {
    let isCancelled = false;

    if (!authConfigured || !supabase) {
      setStoredAuthSession(null);
      setSession(null);
      applyAccessContext(null);
      setErrorMessage('');
      setPasswordResetMessage('');
      setAccessRefreshError('');
      setIsReady(true);
      setIsAccessReady(true);
      setIsPasswordRecovery(false);
      return () => {
        isCancelled = true;
      };
    }

    const supabaseClient = supabase;

    async function hydrateAuthSession() {
      const hasRecoveryParams = isPasswordRecoveryUrl(window.location);

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
          resolvedAuthScopeSignatureRef.current = '';
          applyAccessContext(null);
          setAccessRefreshError('');
          setIsAccessReady(true);
          setIsPasswordRecovery(false);
          if (hasRecoveryParams) {
            clearRecoveryUrlState();
            setErrorMessage(PASSWORD_RESET_INVALID_LINK_MESSAGE);
          } else {
            setErrorMessage('');
          }
        } else {
          if (hasRecoveryParams) {
            applyAccessContext(null);
            setAccessRefreshError('');
            setIsAccessReady(true);
            setIsPasswordRecovery(true);
            setPasswordResetMessage('');
            clearRecoveryUrlState();
          } else {
            applyAccessContext(null);
            setAccessRefreshError('');
            setIsAccessReady(false);
          }
          setErrorMessage('');
        }
      } catch (error) {
        if (!isCancelled) {
          setStoredAuthSession(null);
          setSession(null);
          applyAccessContext(null);
          setAccessRefreshError('');
          setPasswordResetMessage('');
          setIsAccessReady(true);
          setIsPasswordRecovery(false);
          setErrorMessage(
            error instanceof Error && error.message
              ? error.message
              : 'Sign-in could not be initialized.'
          );
        }
      } finally {
        if (!isCancelled) {
          setIsReady(true);
        }
      }
    }

    void hydrateAuthSession();

    const {
      data: { subscription }
    } = supabaseClient.auth.onAuthStateChange((event, nextSession) => {
      if (isCancelled) {
        return;
      }

      const mapped = mapSupabaseSession(nextSession);
      setStoredAuthSession(mapped);
      setSession(mapped);
      if (!mapped) {
        finalizeSignedOutState();
      } else {
        const shouldEnterPasswordRecovery =
          event === 'PASSWORD_RECOVERY' || isPasswordRecoveryUrl(window.location);
        if (shouldEnterPasswordRecovery) {
          resolvedAuthScopeSignatureRef.current = '';
          applyAccessContext(null);
          setAccessRefreshError('');
          setIsAccessReady(true);
          setIsPasswordRecovery(true);
          setPasswordResetMessage('');
          setErrorMessage('');
          clearRecoveryUrlState();
        } else {
          applyAccessContext(null);
          setAccessRefreshError('');
          setIsAccessReady(false);
        }
      }
    });

    return () => {
      isCancelled = true;
      subscription.unsubscribe();
    };
  }, [
    applyAccessContext,
    authConfigured,
    clearRecoveryUrlState,
    finalizeSignedOutState,
    resolvedAuthScopeSignatureRef,
    setAccessRefreshError,
    setErrorMessage,
    setIsAccessReady,
    setIsPasswordRecovery,
    setIsReady,
    setPasswordResetMessage,
    setSession,
    supabase
  ]);
}

export function useAuthAccessRefreshEffects({
  authConfigured,
  refreshAccessContext,
  sessionToken,
  throttleMs
}: UseAuthAccessRefreshEffectsOptions) {
  const lastAutoRefreshAtRef = useRef(0);

  useEffect(() => {
    void refreshAccessContext();
  }, [refreshAccessContext]);

  useEffect(() => {
    if (!authConfigured || !sessionToken) {
      lastAutoRefreshAtRef.current = 0;
      return;
    }

    const maybeAutoRefresh = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }

      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return;
      }

      const now = Date.now();
      if (now - lastAutoRefreshAtRef.current < throttleMs) {
        return;
      }

      lastAutoRefreshAtRef.current = now;
      void refreshAccessContext();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        maybeAutoRefresh();
      }
    };

    window.addEventListener('focus', maybeAutoRefresh);
    window.addEventListener('online', maybeAutoRefresh);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('focus', maybeAutoRefresh);
      window.removeEventListener('online', maybeAutoRefresh);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [authConfigured, refreshAccessContext, sessionToken, throttleMs]);
}
