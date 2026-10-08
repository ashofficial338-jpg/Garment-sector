import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setAccessToken, refreshSession, onAuthChange } from '../api.js';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    refreshSession().then((d) => setUser(d.user)).catch(() => setUser(null)).finally(() => setReady(true));
    return onAuthChange((evt) => {
      if (evt.type === 'logout') { setAccessToken(null); setUser(null); }
      if (evt.type === 'refreshed') setUser(evt.user);
      if (evt.type === 'password') setUser((u) => (u ? { ...u, mustChangePassword: true } : u));
      if (evt.type === 'unit') setUser((u) => (u ? { ...u, unit: null } : u));
    });
  }, []);

  const login = useCallback(async (email, password) => {
    const { data } = await api.post('/auth/login', { email, password });
    setAccessToken(data.accessToken);
    setUser(data.user);
    return data.user;
  }, []);

  /** Step 2 of login and "Switch Unit": bind this session to a unit. */
  const selectUnit = useCallback(async (unit) => {
    const switching = !!user?.unit;
    const { data } = await api.post('/auth/select-unit', { unit });
    setAccessToken(data.accessToken);
    // a switch reloads the app so no screen keeps the previous unit's data
    if (switching) { window.location.assign('/'); return; }
    setUser(data.user);
  }, [user]);

  const changePassword = useCallback(async (currentPassword, newPassword) => {
    const { data } = await api.post('/auth/change-password', { currentPassword, newPassword });
    setAccessToken(data.accessToken);
    setUser(data.user);
  }, []);

  const logout = useCallback(async () => {
    await api.post('/auth/logout').catch(() => {});
    setAccessToken(null);
    setUser(null);
  }, []);

  /** Frontend permission check (UX only – the API enforces permissions independently). */
  const can = useCallback((module, action = 'view') => !!user && (user.isAdmin || (user.permissions?.[module] || []).includes(action)), [user]);

  const value = useMemo(() => ({ user, ready, login, logout, changePassword, selectUnit, can }), [user, ready, login, logout, changePassword, selectUnit, can]);
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);
