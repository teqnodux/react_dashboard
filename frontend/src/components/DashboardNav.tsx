import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ReactNode, useRef, useState, useEffect } from 'react';
import { usePermissions } from '../hooks/usePermissions';
import { useAuth } from '../context/AuthContext';
import { orgAdminApi } from '../services/adminApi';
import '../styles/AdminNav.css';

const NAV_TABS = [
  { path: '/tearsheet',      label: '📊 Tearsheet' },
  { path: '/pipeline',       label: '📋 List View' },
  { path: '/activity',       label: '📡 Activity Feed' },
  { path: '/all-dockets',    label: '📄 Dockets' },
  { path: '/all-regulatory', label: '🏛️ Regulatory' },
  { path: '/sec-filings',    label: '📑 SEC Filings' },
  { path: '/upcoming',       label: '📅 Upcoming' },
  { path: '/feed',           label: '📰 Feed' },
];

const DASHBOARD_HOME_TABS = [
  '/tearsheet',
  '/pipeline',
  '/activity',
  '/all-dockets',
  '/all-regulatory',
  '/sec-filings',
  '/upcoming',
  '/feed'
];

function ProfileMenu() {
  const { user, logout } = useAuth();
  const { isAdmin, isSuperAdmin, canSeeNavTab } = usePermissions();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [adminPanelVisible, setAdminPanelVisible] = useState(true);
  const onSuperAdminRoute = location.pathname.startsWith('/super-admin');
  const onAdminRoute = location.pathname.startsWith('/admin');
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Check org-level dashboard visibility for non-super-admin admins
  useEffect(() => {
    if (!isAdmin || isSuperAdmin) return;
    orgAdminApi.getOrgSettings()
      .then(({ data }) => setAdminPanelVisible(data.is_admin_dashboard_visible))
      .catch(() => setAdminPanelVisible(true)); // fail open
  }, [isAdmin, isSuperAdmin]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const initials = user?.email ? user.email[0].toUpperCase() : '?';

  function handleLogout() {
    logout();
    navigate('/login', { replace: true });
  }

  function goDashboard() {
    setOpen(false);
    const first =
      DASHBOARD_HOME_TABS.find((path) => canSeeNavTab(path)) ?? '/pipeline';
    navigate(first);
  }

  function roleBadgeClass() {
    if (isSuperAdmin) return 'super-admin';
    if (isAdmin) return 'admin';
    return 'user';
  }

  function roleLabel() {
    if (isSuperAdmin) return 'Super Admin';
    if (isAdmin) return 'Admin';
    return user?.role ?? 'user';
  }

  return (
    <div className="profile-menu" ref={wrapperRef}>
      <button
        className="profile-avatar"
        onClick={() => setOpen(o => !o)}
        aria-label="Profile menu"
      >
        {initials}
      </button>

      {open && (
        <div className="profile-dropdown">
          <div className="profile-dropdown-info">
            <span className="profile-email">{user?.email ?? '—'}</span>
            <span className={`profile-role-badge ${roleBadgeClass()}`}>
              {roleLabel()}
            </span>
          </div>
          <div className="profile-dropdown-divider" />

          {(onSuperAdminRoute || onAdminRoute) ? (
            <button
              className="profile-panel-btn admin-btn"
              onClick={goDashboard}
            >
              📊 Dashboard
            </button>
          ) : (
            <>
              {isSuperAdmin && (
                <button
                  className="profile-panel-btn super-admin-btn"
                  onClick={() => {
                    setOpen(false);
                    navigate('/super-admin');
                  }}
                >
                  ⚙️ Super Admin Panel
                </button>
              )}
              {isAdmin && !isSuperAdmin && adminPanelVisible && (
                <button
                  className="profile-panel-btn admin-btn"
                  onClick={() => {
                    setOpen(false);
                    navigate('/admin');
                  }}
                >
                  🛠️ Admin Panel
                </button>
              )}
            </>
          )}

          {!isSuperAdmin && !isAdmin && (
            <>
              <button
                className="profile-panel-btn"
                onClick={() => { setOpen(false); navigate('/user'); }}
              >
                🔑 Deal Access
              </button>
              <div className="profile-dropdown-divider" />
            </>
          )}
          {(isSuperAdmin || isAdmin) && <div className="profile-dropdown-divider" />}
          <button className="profile-logout-btn" onClick={handleLogout}>
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

export default function DashboardNav({ children }: { children?: ReactNode }) {
  const location = useLocation();
  const { canSeeNavTab } = usePermissions();
  const visibleTabs = NAV_TABS.filter(tab => canSeeNavTab(tab.path));
  return (
    <nav className="top-nav">
      {visibleTabs.map(tab => (
        <Link
          key={tab.path}
          to={tab.path}
          className={`nav-tab ${location.pathname === tab.path ? 'active' : ''}`}
        >
          {tab.label}
        </Link>
      ))}
      <div style={{ flex: 1 }} />
      {children}
      <ProfileMenu />
    </nav>
  );
}
