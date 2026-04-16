import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthProvider } from './context/AuthContext';
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
import { usePermissions } from './hooks/usePermissions';
import ROLE_CONFIG from './config/roleConfig';
import './styles/GlobalVars.css';

/** Redirects to the first allowed nav tab for the current role */
function DefaultRedirect() {
  const { canSeeNavTab } = usePermissions();
  const fallback = '/tearsheet';
  const allTabs = ['/tearsheet', '/pipeline', '/activity', '/all-dockets', '/all-regulatory', '/sec-filings', '/upcoming'];
  const first = allTabs.find(t => canSeeNavTab(t)) ?? fallback;
  return <Navigate to={first} replace />;
}

/** Redirects to the role's default if the current role cannot access this nav path */
function NavGuard({ path, children }: { path: string; children: ReactNode }) {
  const { canSeeNavTab, role } = usePermissions();
  if (!canSeeNavTab(path)) {
    const navTabs = ROLE_CONFIG[role as keyof typeof ROLE_CONFIG]?.navTabs;
    const fallback = Array.isArray(navTabs) ? (navTabs[0] ?? '/tearsheet') : '/tearsheet';
    return <Navigate to={fallback} replace />;
  }
  return <>{children}</>;
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/" element={<DefaultRedirect />} />
            <Route path="/tearsheet" element={<NavGuard path="/tearsheet"><PipelineTearsheet /></NavGuard>} />
            <Route path="/pipeline" element={<PipelineTable />} />
            <Route path="/deal/:dealId" element={<DealDetail />} />
            <Route path="/all-dockets"    element={<NavGuard path="/all-dockets"><AllDockets /></NavGuard>} />
            <Route path="/all-regulatory" element={<NavGuard path="/all-regulatory"><AllRegulatory /></NavGuard>} />
            <Route path="/activity"       element={<NavGuard path="/activity"><AllActivity /></NavGuard>} />
            <Route path="/reddit"         element={<NavGuard path="/reddit"><RedditAnalysis /></NavGuard>} />
            <Route path="/sec-filings"    element={<NavGuard path="/sec-filings"><SECFilings /></NavGuard>} />
            <Route path="/upcoming"       element={<NavGuard path="/upcoming"><UpcomingEvents /></NavGuard>} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;