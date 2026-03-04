import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AuthSession } from '../../domain';
import { getStoredAuthSession, setStoredAuthSession } from '../../lib/storage';
import {
  createSessionFromCredential,
  ensureGoogleIdentityLoaded,
  getGoogleClientId
} from './googleIdentity';

interface AuthContextValue {
  clientIdConfigured: boolean;
  errorMessage: string;
  isAuthenticated: boolean;
  isReady: boolean;
  session: AuthSession | null;
  mountGoogleButton: (element: HTMLDivElement | null) => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const clientId = getGoogleClientId();
  const [errorMessage, setErrorMessage] = useState('');
  const [session, setSession] = useState<AuthSession | null>(() => getStoredAuthSession());
  const [isReady, setIsReady] = useState(false);
  const initializedRef = useRef(false);
  const isAuthenticated = Boolean(
    session?.token && session.user?.email && session.user?.name && session.user?.hasProfileName
  );

  useEffect(() => {
    let isCancelled = false;

    async function setupGoogleIdentity() {
      if (!clientId) {
        if (!isCancelled) {
          setErrorMessage('');
          setIsReady(true);
        }
        return;
      }

      try {
        await ensureGoogleIdentityLoaded();

        if (isCancelled || initializedRef.current || !window.google?.accounts?.id) {
          return;
        }

        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (response) => {
            if (!response.credential) {
              return;
            }

            try {
              const nextSession = createSessionFromCredential(response.credential);
              setStoredAuthSession(nextSession);
              setErrorMessage('');
              setSession(nextSession);
            } catch (error) {
              setStoredAuthSession(null);
              setErrorMessage(
                error instanceof Error && error.message
                  ? error.message
                  : 'Google sign-in could not be completed.'
              );
              setSession(null);
            }
          }
        });

        initializedRef.current = true;
        if (!isCancelled) {
          setErrorMessage('');
        }
      } catch (error) {
        if (!isCancelled) {
          setErrorMessage(
            error instanceof Error && error.message
              ? error.message
              : 'Google sign-in could not be loaded.'
          );
        }
      } finally {
        if (!isCancelled) {
          setIsReady(true);
        }
      }
    }

    setupGoogleIdentity();

    return () => {
      isCancelled = true;
    };
  }, [clientId]);

  function mountGoogleButton(element: HTMLDivElement | null) {
    if (!element) {
      return;
    }

    element.innerHTML = '';

    if (!clientId || !isReady || isAuthenticated || !window.google?.accounts?.id) {
      return;
    }

    window.google.accounts.id.renderButton(element, {
      theme: 'outline',
      size: 'large',
      shape: 'pill',
      text: 'signin_with',
      logo_alignment: 'left'
    });
  }

  function signOut() {
    window.google?.accounts?.id.disableAutoSelect();
    setErrorMessage('');
    setStoredAuthSession(null);
    setSession(null);
  }

  return (
    <AuthContext.Provider
      value={{
        clientIdConfigured: Boolean(clientId),
        errorMessage,
        isAuthenticated,
        isReady,
        session,
        mountGoogleButton,
        signOut
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
