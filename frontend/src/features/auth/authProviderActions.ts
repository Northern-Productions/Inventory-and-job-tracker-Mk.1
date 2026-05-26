import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthSession, EffectiveAccessContext } from '../../domain';
import {
  requestUsernameChange as requestUsernameChangeApi,
  updateDefaultWarehouse as updateDefaultWarehouseApi
} from '../../api/features/authClient';
import { setStoredAuthSession } from '../../lib/storage';
import {
  PASSWORD_RESET_REQUEST_MESSAGE,
  PASSWORD_RESET_SUCCESS_MESSAGE,
  buildPasswordResetRedirectUrl
} from './authRecovery';
import { deriveNameFromEmail, mapSupabaseSession } from './authSession';

interface BuildAuthProviderActionsOptions {
  applyAccessContext: (nextContext: EffectiveAccessContext | null) => void;
  authConfigured: boolean;
  isPasswordRecovery: boolean;
  performSignOut: (options?: {
    nextErrorMessage?: string;
    nextPasswordResetMessage?: string;
  }) => Promise<void>;
  refreshAccessContext: () => Promise<void>;
  session: AuthSession | null;
  setAccessRefreshError: (value: string) => void;
  setErrorMessage: (value: string) => void;
  setIsAccessReady: (value: boolean) => void;
  setIsBusy: (value: boolean) => void;
  setPasswordResetMessage: (value: string) => void;
  setSession: (value: AuthSession | null) => void;
  supabase: SupabaseClient | null;
}

function prepareAuthAction({
  setAccessRefreshError,
  setErrorMessage,
  setIsBusy,
  setPasswordResetMessage
}: Pick<
  BuildAuthProviderActionsOptions,
  'setAccessRefreshError' | 'setErrorMessage' | 'setIsBusy' | 'setPasswordResetMessage'
>) {
  setIsBusy(true);
  setErrorMessage('');
  setPasswordResetMessage('');
  setAccessRefreshError('');
}

function resolveAuthErrorMessage(error: unknown, fallbackMessage: string) {
  return error instanceof Error && error.message ? error.message : fallbackMessage;
}

export function buildAuthProviderActions({
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
}: BuildAuthProviderActionsOptions) {
  async function signInWithPassword(email: string, password: string) {
    if (!authConfigured || !supabase) {
      throw new Error('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable sign-in.');
    }

    prepareAuthAction({
      setAccessRefreshError,
      setErrorMessage,
      setIsBusy,
      setPasswordResetMessage
    });

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
      const message = resolveAuthErrorMessage(error, 'Sign-in failed.');
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

    prepareAuthAction({
      setAccessRefreshError,
      setErrorMessage,
      setIsBusy,
      setPasswordResetMessage
    });

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

      applyAccessContext(null);
      setAccessRefreshError('');
      setIsAccessReady(true);
      setErrorMessage('');
      return { sessionCreated: false };
    } catch (error) {
      const message = resolveAuthErrorMessage(error, 'Account creation failed.');
      setErrorMessage(message);
      throw new Error(message);
    } finally {
      setIsBusy(false);
    }
  }

  async function requestPasswordReset(email: string) {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      throw new Error('Email is required.');
    }

    if (!authConfigured || !supabase) {
      throw new Error('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable password reset.');
    }

    prepareAuthAction({
      setAccessRefreshError,
      setErrorMessage,
      setIsBusy,
      setPasswordResetMessage
    });

    try {
      const { error } = await supabase.auth.resetPasswordForEmail(trimmedEmail, {
        redirectTo: buildPasswordResetRedirectUrl(window.location)
      });

      if (error) {
        throw error;
      }

      setPasswordResetMessage(PASSWORD_RESET_REQUEST_MESSAGE);
    } catch (error) {
      const message = resolveAuthErrorMessage(error, 'Password reset could not be requested.');
      setErrorMessage(message);
      throw new Error(message);
    } finally {
      setIsBusy(false);
    }
  }

  async function completePasswordReset(password: string) {
    if (!authConfigured || !supabase) {
      throw new Error('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable password reset.');
    }

    if (!isPasswordRecovery || !session?.token) {
      throw new Error('Open the password reset link from your email before setting a new password.');
    }

    prepareAuthAction({
      setAccessRefreshError,
      setErrorMessage,
      setIsBusy,
      setPasswordResetMessage
    });

    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) {
        throw error;
      }

      await performSignOut({
        nextPasswordResetMessage: PASSWORD_RESET_SUCCESS_MESSAGE
      });
    } catch (error) {
      const message = resolveAuthErrorMessage(error, 'Password reset failed.');
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

    prepareAuthAction({
      setAccessRefreshError,
      setErrorMessage,
      setIsBusy,
      setPasswordResetMessage
    });

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
      const message = resolveAuthErrorMessage(error, 'Username update failed.');
      setErrorMessage(message);
      throw new Error(message);
    } finally {
      setIsBusy(false);
    }
  }

  async function updateDefaultWarehouse(defaultWarehouse: string) {
    if (!authConfigured || !supabase) {
      throw new Error('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable profile updates.');
    }

    prepareAuthAction({
      setAccessRefreshError,
      setErrorMessage,
      setIsBusy,
      setPasswordResetMessage
    });

    try {
      return await updateDefaultWarehouseApi({ defaultWarehouse });
    } catch (error) {
      const message = resolveAuthErrorMessage(error, 'Warehouse update failed.');
      setErrorMessage(message);
      throw new Error(message);
    } finally {
      setIsBusy(false);
    }
  }

  async function signOut() {
    await performSignOut();
  }

  function exitPasswordRecovery() {
    setErrorMessage('');
    setPasswordResetMessage('');
    void performSignOut();
  }

  return {
    completePasswordReset,
    exitPasswordRecovery,
    requestPasswordReset,
    updateDefaultWarehouse,
    requestUsernameChange,
    signInWithPassword,
    signOut,
    signUpWithPassword
  };
}
