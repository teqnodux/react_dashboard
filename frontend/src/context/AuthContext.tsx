import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import api, { setLogoutCallback } from '../services/api';

export interface User {
  email: string;
  role: string;         // 'super_admin' | 'admin' | 'user'
  id: string;
  org_id: string | null;
  is_individual: boolean;
  access_mode: 'full' | 'deal_access_only';
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  loading: boolean;
  /** Returns true if the backend signals the user must change their password */
  login: (email: string, password: string) => Promise<boolean>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

function readStoredAuth(): { user: User | null; token: string | null } {
  try {
    const storedToken = localStorage.getItem('token');
    const storedUser = localStorage.getItem('user');
    if (!storedToken || !storedUser) return { user: null, token: null };
    return { token: storedToken, user: JSON.parse(storedUser) as User };
  } catch {
    try {
      localStorage.removeItem('token');
      localStorage.removeItem('refreshToken');
      localStorage.removeItem('user');
    } catch {
      /* storage may be blocked in some in-app browsers */
    }
    return { user: null, token: null };
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const initial = readStoredAuth();
  const [user, setUser] = useState<User | null>(initial.user);
  const [token, setToken] = useState<string | null>(initial.token);
  const [loading] = useState(false);

  useEffect(() => {
    function onPageShow(event: PageTransitionEvent) {
      if (!event.persisted) return;
      const stored = readStoredAuth();
      setToken(stored.token);
      setUser(stored.user);
    }
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  const logout = useCallback(() => {
    try {
      localStorage.removeItem('token');
      localStorage.removeItem('refreshToken');
      localStorage.removeItem('user');
    } catch {
      /* ignore */
    }
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    setLogoutCallback(logout);
  }, [logout]);

  const login = async (email: string, password: string): Promise<boolean> => {
    const { data } = await api.post('/api/auth/login', { email, password });
    const { access, refresh, user_email, role, user_id, org_id, is_individual, must_reset, access_mode } = data;

    const userData: User = {
      email: user_email,
      role,
      id: user_id,
      org_id: org_id ?? null,
      is_individual: is_individual ?? false,
      access_mode: access_mode ?? 'full',
    };

    try {
      localStorage.setItem('token', access);
      localStorage.setItem('refreshToken', refresh);
      localStorage.setItem('user', JSON.stringify(userData));
    } catch {
      /* keep in-memory session even if storage is blocked */
    }

    setToken(access);
    setUser(userData);

    return !!must_reset;
  };

  return (
    <AuthContext.Provider value={{ user, token, isAuthenticated: !!token, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
