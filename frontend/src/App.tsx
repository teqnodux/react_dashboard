import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthProvider } from './context/AuthContext';
import { DashboardCacheProvider } from './context/DashboardCacheContext';
import ProtectedRoute from './components/ProtectedRoute';
import Login from './pages/Login';
import PipelineTable from './components/PipelineTable';
import DealDetail from './pages/DealDetail';
import PipelineTearsheet from './pages/PipelineTearsheet';
import AllDockets from './pages/AllDockets';
import AllRegulatory from './pages/AllRegulatory';
import AllActivity from './pages/AllActivity';
import RedditAnalysis from './pages/RedditAnalysis';
import SECFilings from './pages/SECFilings';
import UpcomingEvents from './pages/UpcomingEvents';
import Feed from './pages/Feed';
import ForgotPassword from './pages/auth/ForgotPassword';
import ResetPassword from './pages/auth/ResetPassword';
import AcceptInvite from './pages/auth/AcceptInvite';
import ChangePassword from './pages/auth/ChangePassword';
import AdminPanel from './pages/admin/AdminPanel';
import SuperAdminPanel from './pages/admin/SuperAdminPanel';
import UserDashboard from './pages/UserDashboard';
import { usePermissions } from './hooks/usePermissions';
import { useAuth } from './context/AuthContext';
import { ToastProvider } from './components/ToastNotification';
import ROLE_CONFIG from './config/roleConfig';
import './styles/GlobalVars.css';

/** Redirects to the first allowed nav tab for the current role */
function DefaultRedirect() {
  const { canSeeNavTab, isDealAccessOnly } = usePermissions();
  if (isDealAccessOnly) return <Navigate to="/user" replace />;
  const fallback = '/tearsheet';
  const allTabs = ['/tearsheet', '/pipeline', '/activity', '/all-dockets', '/all-regulatory', '/sec-filings', '/upcoming', '/feed'];
  const first = allTabs.find(t => canSeeNavTab(t)) ?? fallback;
  return <Navigate to={first} replace />;
}

/** Redirects to the role's default if the current role cannot access this nav path */
function NavGuard({ path, children }: { path: string; children: ReactNode }) {
  const { loading } = useAuth();
  const { canSeeNavTab, isDealAccessOnly, role } = usePermissions();
  if (loading) return null;
  // deal_access_only users can only visit /user
  if (isDealAccessOnly) return <Navigate to="/user" replace />;
  if (!canSeeNavTab(path)) {
    const navTabs = ROLE_CONFIG[role as keyof typeof ROLE_CONFIG]?.navTabs;
    const fallback = Array.isArray(navTabs) ? (navTabs[0] ?? '/tearsheet') : '/tearsheet';
    return <Navigate to={fallback} replace />;
  }
  return <>{children}</>;
}

/** Redirects away if current user doesn't have one of the required roles */
function RoleGuard({ roles, children }: { roles: string[]; children: ReactNode }) {
  const { user } = useAuth();
  if (!user || !roles.includes(user.role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** Redirects deal_access_only users away from any dashboard route */
function DashboardGuard({ children }: { children: ReactNode }) {
  const { isDealAccessOnly } = usePermissions();
  const { loading } = useAuth();
  if (loading) return null;
  if (isDealAccessOnly) return <Navigate to="/user" replace />;
  return <>{children}</>;
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
        <DashboardCacheProvider>
        <Routes>
          {/* Public routes — no auth required */}
          <Route path="/login"           element={<Login />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password"  element={<ResetPassword />} />
          <Route path="/accept-invite"   element={<AcceptInvite />} />

          {/* Protected routes — must be logged in */}
          <Route element={<ProtectedRoute />}>
            <Route path="/" element={<DefaultRedirect />} />
            <Route path="/change-password" element={<ChangePassword />} />

            {/* Admin panel — admin + super_admin */}
            <Route path="/admin" element={
              <RoleGuard roles={['admin', 'super_admin']}>
                <AdminPanel />
              </RoleGuard>
            } />

            {/* Super admin panel — super_admin only */}
            <Route path="/super-admin" element={
              <RoleGuard roles={['super_admin']}>
                <SuperAdminPanel />
              </RoleGuard>
            } />

            {/* User deal access dashboard — all authenticated users */}
            <Route path="/user" element={<UserDashboard />} />

            {/* Dashboard routes */}
            <Route path="/tearsheet" element={<NavGuard path="/tearsheet"><PipelineTearsheet /></NavGuard>} />
            <Route path="/pipeline"  element={<DashboardGuard><PipelineTable /></DashboardGuard>} />
            <Route path="/deal/:dealId" element={<DashboardGuard><DealDetail /></DashboardGuard>} />
            <Route path="/all-dockets"    element={<NavGuard path="/all-dockets"><AllDockets /></NavGuard>} />
            <Route path="/all-regulatory" element={<NavGuard path="/all-regulatory"><AllRegulatory /></NavGuard>} />
            <Route path="/activity"       element={<NavGuard path="/activity"><AllActivity /></NavGuard>} />
            <Route path="/reddit"         element={<NavGuard path="/reddit"><RedditAnalysis /></NavGuard>} />
            <Route path="/sec-filings"    element={<NavGuard path="/sec-filings"><SECFilings /></NavGuard>} />
            <Route path="/upcoming"       element={<NavGuard path="/upcoming"><UpcomingEvents /></NavGuard>} />
            <Route path="/feed"      element={<NavGuard path="/feed"><Feed /></NavGuard>} />
            <Route path="/news-feed" element={<Navigate to="/feed" replace />} />
            <Route path="/sec-feed"  element={<Navigate to="/feed" replace />} />
          </Route>
        </Routes>
        </DashboardCacheProvider>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;