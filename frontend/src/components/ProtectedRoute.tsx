import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { FeedLiveProvider } from '../context/FeedLiveContext';

export default function ProtectedRoute() {
  const { isAuthenticated, loading } = useAuth();

  if (loading) return null;
  if (!isAuthenticated) return <Navigate to="/login" replace />;

  return (
    <FeedLiveProvider>
      <Outlet />
    </FeedLiveProvider>
  );
}
