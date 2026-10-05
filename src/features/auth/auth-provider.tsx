import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  authService,
  type AuthSession,
  type AuthState,
} from '@/services/auth';
import { SupabaseConfigurationError } from '@/services/auth/supabase-client';

import { useAuthAutoRefresh } from './use-auth-auto-refresh';

type AuthContextValue = AuthState & {
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);
const INITIAL_STATE: AuthState = { status: 'loading', user: null };

function stateFromSession(session: AuthSession | null): AuthState {
  return session
    ? { status: 'authenticated', user: session.user }
    : { status: 'unauthenticated', user: null };
}

function stateFromError(error: unknown): AuthState {
  return error instanceof SupabaseConfigurationError
    ? {
        errorMessage: 'Authentication has not been configured for this build.',
        status: 'configuration_error',
        user: null,
      }
    : {
        errorMessage: 'Authentication could not be loaded. Please try again.',
        status: 'unauthenticated',
        user: null,
      };
}

export function AuthProvider({ children }: PropsWithChildren) {
  const [state, setState] = useState<AuthState>(INITIAL_STATE);

  useAuthAutoRefresh(authService);

  useEffect(() => {
    let active = true;
    let unsubscribe: () => void = () => undefined;

    try {
      unsubscribe = authService.onAuthStateChange((session) => {
        if (active) {
          setState(stateFromSession(session));
        }
      });

      authService.getSession().then(
        (session) => active && setState(stateFromSession(session)),
        (error) => active && setState(stateFromError(error)),
      );
    } catch (error) {
      Promise.resolve().then(() => {
        if (active) {
          setState(stateFromError(error));
        }
      });
    }

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const session = await authService.signInWithPassword(email, password);
    setState(stateFromSession(session));
  }, []);

  const signOut = useCallback(async () => {
    await authService.signOut();
    setState(stateFromSession(null));
  }, []);

  const value = useMemo(
    () => ({ ...state, signIn, signOut }),
    [signIn, signOut, state],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('useAuth must be used inside AuthProvider.');
  }

  return context;
}
