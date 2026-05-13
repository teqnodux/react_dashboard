import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import api, { setLogoutCallback } from '../services/api';

export interface User {
  email: string;
  role: string;         // 'super_admin' | 'admin' | 'user'
  id: string;
  org_id: string | null;
  is_individual: boolean;
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const storedToken = localStorage.getItem('token');
    const storedUser = localStorage.getItem('user');
    if (storedToken && storedUser) {
      try {
        setToken(storedToken);
        setUser(JSON.parse(storedUser));
      } catch {
        localStorage.removeItem('token');
        localStorage.removeItem('refreshToken');
        localStorage.removeItem('user');
      }
    }
    setLoading(false);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('token');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('user');
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    setLogoutCallback(logout);
  }, [logout]);

  const login = async (email: string, password: string): Promise<boolean> => {
    const { data } = await api.post('/api/auth/login', { email, password });
    const { access, refresh, user_email, role, user_id, org_id, is_individual, must_reset } = data;

    const userData: User = {
      email: user_email,
      role,
      id: user_id,
      org_id: org_id ?? null,
      is_individual: is_individual ?? false,
    };

    localStorage.setItem('token', access);
    localStorage.setItem('refreshToken', refresh);
    localStorage.setItem('user', JSON.stringify(userData));

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
