import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ReactNode, useRef, useState, useEffect } from 'react';
import { usePermissions } from '../hooks/usePermissions';
import { useAuth } from '../context/AuthContext';
import '../styles/AdminNav.css';

const NAV_TABS = [
  { path: '/tearsheet',      label: '📊 Tearsheet' },
  { path: '/pipeline',       label: '📋 List View' },
  { path: '/activity',       label: '📡 Activity Feed' },
  { path: '/all-dockets',    label: '📄 Dockets' },
  { path: '/all-regulatory', label: '🏛️ Regulatory' },
  { path: '/sec-filings',    label: '📑 SEC Filings' },
  { path: '/upcoming',       label: '📅 Upcoming' },
  { path: '/news-feed',      label: '📰 News Feed' },
  { path: '/sec-feed',       label: '🗂️ SEC Feed' },
];

function ProfileMenu() {
  const { user, logout } = useAuth();
  const { isAdmin, isSuperAdmin } = usePermissions();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

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

          {isSuperAdmin && (
            <button
              className="profile-panel-btn super-admin-btn"
              onClick={() => { setOpen(false); navigate('/super-admin'); }}
            >
              ⚙️ Super Admin Panel
            </button>
          )}
          {isAdmin && !isSuperAdmin && (
            <button
              className="profile-panel-btn admin-btn"
              onClick={() => { setOpen(false); navigate('/admin'); }}
            >
              🛠️ Admin Panel
            </button>
          )}

          <div className="profile-dropdown-divider" />
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
