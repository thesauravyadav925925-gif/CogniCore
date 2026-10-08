import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, setAuthToken, setUnauthorizedHandler } from '../services/api';

const AuthContext = createContext(null);
const TOKEN_KEY = 'cognicore_token';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const logout = useCallback(() => {
    // revoke the server-side session too (best effort - ignore errors such as an already-expired token)
    if (localStorage.getItem(TOKEN_KEY)) api.logout().catch(() => {});
    localStorage.removeItem(TOKEN_KEY);
    setAuthToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    const stored = localStorage.getItem(TOKEN_KEY);
    if (!stored) { setLoading(false); return; }
    setAuthToken(stored);
    api.me()
      .then(setUser)
      .catch(() => logout())
      .finally(() => setLoading(false));
  }, [logout]);

  async function login(email, password) {
    setError(null);
    try {
      const { user, token } = await api.login({ email, password });
      localStorage.setItem(TOKEN_KEY, token);
      setAuthToken(token);
      setUser(user);
      return true;
    } catch (err) {
      setError(err.response?.data?.message || err.message);
      return false;
    }
  }

  async function register(email, password, name) {
    setError(null);
    try {
      const { user, token } = await api.register({ email, password, name });
      localStorage.setItem(TOKEN_KEY, token);
      setAuthToken(token);
      setUser(user);
      return true;
    } catch (err) {
      setError(err.response?.data?.message || err.message);
      return false;
    }
  }

  return (
    <AuthContext.Provider value={{ user, loading, error, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
