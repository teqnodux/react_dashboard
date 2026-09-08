import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { FeedLiveProvider } from '../context/FeedLiveContext';

export default function ProtectedRoute() {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-secondary)',
          fontFamily: 'var(--font-sans)',
          fontSize: 13,
        }}
      >
        Loading…
      </div>
    );
  }

  if (!isAuthenticated) {
    const to = location.pathname === '/unsubscribe'
      ? `/login?redirect=${encodeURIComponent(location.pathname + location.search)}`
      : '/login';
    return <Navigate to={to} replace />;
  }

  return (
    <FeedLiveProvider>
      <Outlet />
    </FeedLiveProvider>
  );
}
