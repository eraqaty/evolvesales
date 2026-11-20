import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  http,
  refreshSession,
  type Session,
  type SessionUser,
  setAccessToken,
  setSessionLostHandler,
} from '../lib/api';

type AuthState =
  | { status: 'loading'; user: null }
  | { status: 'anonymous'; user: null }
  | { status: 'authenticated'; user: SessionUser };

interface AuthContextValue {
  state: AuthState;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading', user: null });
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    setSessionLostHandler(() => setState({ status: 'anonymous', user: null }));
    void refreshSession().then((session) => {
      if (cancelled) return;
      setState(
        session
          ? { status: 'authenticated', user: session.user }
          : { status: 'anonymous', user: null },
      );
    });
    return () => {
      cancelled = true;
      setSessionLostHandler(null);
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const session = await http.post<Session>('/auth/login', { email, password });
    setAccessToken(session.accessToken);
    setState({ status: 'authenticated', user: session.user });
  }, []);

  const logout = useCallback(async () => {
    try {
      await http.post<void>('/auth/logout');
    } finally {
      setAccessToken(null);
      queryClient.clear();
      setState({ status: 'anonymous', user: null });
    }
  }, [queryClient]);

  const value = useMemo(() => ({ state, login, logout }), [state, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** UI-only permission hints. The API enforces every rule independently. */
export function usePermissions() {
  const { state } = useAuth();
  const roles = state.user?.roles ?? [];
  const has = (role: string) => roles.includes(role) || roles.includes('ADMIN');
  const isSales = has('SALES_USER') || has('SALES_MANAGER');
  return {
    userId: state.user?.id ?? null,
    canCreateInvoice: isSales,
    isSales,
    isSalesManager: has('SALES_MANAGER'),
    isApprover: has('CHANGE_APPROVER'),
    isAdmin: roles.includes('ADMIN'),
    /** Approvers, release managers and admins see every change request. */
    seesAllRequests: has('CHANGE_APPROVER') || has('RELEASE_MANAGER'),
  };
}
