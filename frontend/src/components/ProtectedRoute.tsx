import { useEffect } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { socketService } from '../services/socketService';

export default function ProtectedRoute() {
  const { isAuthenticated, loading } = useAuth();

  useEffect(() => {
    if (isAuthenticated) {
      socketService.connect();
    }
    return () => {
      socketService.disconnect();
    };
  }, [isAuthenticated]);

  if (loading) return null;
  if (!isAuthenticated) return <Navigate to="/login" replace />;

  return <Outlet />;
}
