import { useCallback, useEffect, useState } from 'react';
import LoginForm from './components/LoginForm.jsx';
import Workspace from './components/Workspace.jsx';
import { login, fetchMe } from './api/index.js';
import { setAuthToken, getStoredToken } from './api/client.js';

export default function App() {
  const [token, setToken] = useState(() => getStoredToken());
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleLogout = useCallback(() => {
    setAuthToken(null);
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    const stored = getStoredToken();
    if (stored) {
      setAuthToken(stored);
      setToken(stored);
      fetchMe()
        .then((data) => setUser(data))
        .catch((err) => {
          if (err?.response?.status === 401) {
            handleLogout();
            return;
          }
          console.error('Failed to fetch current user.', err);
          setUser(null);
        });
    }
  }, [handleLogout]);

  const handleLogin = async ({ email, password }) => {
    setLoading(true);
    setError(null);
    try {
      const { access_token } = await login(email, password);
      setAuthToken(access_token);
      setToken(access_token);
      const profile = await fetchMe();
      setUser(profile);
    } catch (err) {
      console.error(err);
      if (err?.response?.status === 401 && err?.config?.url?.includes('/auth/me')) {
        handleLogout();
      }
      setError('Invalid email or password');
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return <LoginForm onSubmit={handleLogin} loading={loading} error={error} />;
  }

  return <Workspace user={user} onLogout={handleLogout} />;
}
