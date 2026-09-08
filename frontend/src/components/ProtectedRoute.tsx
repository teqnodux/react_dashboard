import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { FeedLiveProvider } from '../context/FeedLiveContext';

export default function ProtectedRoute() {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();

  if (loading) return null;
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
